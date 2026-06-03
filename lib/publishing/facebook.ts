// Playwright Facebook Marketplace publisher.
//
// Drives a headless Chromium browser using the saved FB session
// (FB_SESSION_COOKIES_PATH, produced by `npm run save-fb-session`) to create a
// Marketplace *vehicle* listing as Miami Motor Group. Posts are generated and
// approved upstream; the cadence governor in ./queue.ts decides *when* to post,
// and this module just publishes whatever it's handed.
//
// We post the English copy (post.contentEn) to Facebook.
//
// NOTE ON SELECTORS: Facebook's Marketplace composer is an obfuscated SPA whose
// class names are randomized per build, so we drive it by *accessible name*
// (getByLabel / getByRole / getByPlaceholder) with multiple label candidates
// and fallbacks — the same defensive style the CarGurus scraper uses. These are
// best-effort against the live DOM and may need adjusting when FB ships UI
// changes; failures screenshot the page (see screenshotError) for debugging.

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import { Platform } from "@prisma/client";
import type { Post, Vehicle } from "@prisma/client";
import {
  claimNextPublishablePost,
  markFailed,
  markPublished,
  releaseClaim,
} from "./queue";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MARKETPLACE_CREATE_URL =
  "https://www.facebook.com/marketplace/create/vehicle";
const DEFAULT_SESSION_PATH = "./fb-session.json";

const NAV_TIMEOUT_MS = 60_000;
const ELEMENT_TIMEOUT_MS = 15_000;
// The photo file input can be slow to render (and is sometimes deferred until
// the upload area is clicked) in headless/CI, so it gets a longer timeout.
const FILE_INPUT_TIMEOUT_MS = 30_000;
// FB's photo input is matched by type or by its image/video accept filter —
// the type attribute alone isn't always present on the build CI sees.
const PHOTO_INPUT_SELECTOR =
  'input[type="file"], input[accept*="image"], input[accept*="video"]';
const MIN_DELAY_MS = 700;
const MAX_DELAY_MS = 2000;
const MAX_PHOTOS = 20;

// Keep this in sync with scripts/save-fb-session.ts — Facebook ties a session
// to the user-agent it was created with, so a mismatch can invalidate it.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Portable equivalent of "/tmp"; on Windows this resolves to %TEMP%.
const TMP_DIR = tmpdir();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PostWithVehicle = Post & { vehicle: Vehicle };

export type PublishResult =
  | { success: true; listingUrl: string }
  | { success: false; error: string };

/**
 * Thrown when the saved session is no longer valid (Facebook redirected us to a
 * login / checkpoint page). Surfaced distinctly so callers know to re-run
 * `npm run save-fb-session` rather than treating it as a per-post failure.
 */
export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random human-like pause between actions to look less like a bot. */
function humanDelay(): Promise<void> {
  const ms =
    Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
  return sleep(ms);
}

function sessionPath(): string {
  return process.env.FB_SESSION_COOKIES_PATH ?? DEFAULT_SESSION_PATH;
}

/** "{year} {make} {model} {trim}", skipping any missing parts. */
function buildTitle(vehicle: Vehicle): string {
  return [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
    .filter((part): part is string | number => Boolean(part))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// FB's vehicle composer requires Body style and Exterior color (constrained
// dropdowns) before the listing can advance. We don't store these directly, so
// we infer them from the trim/model string and the free-text color, mapping to
// FB's option vocabulary. Returns null when nothing matches (left unset).
const FB_BODY_STYLES = [
  "Coupe",
  "Convertible",
  "Hatchback",
  "Minivan",
  "Sedan",
  "Wagon",
  "SUV",
  "Truck",
];

const FB_EXTERIOR_COLORS = [
  "Black",
  "Blue",
  "Brown",
  "Gold",
  "Gray",
  "Green",
  "Orange",
  "Pink",
  "Purple",
  "Red",
  "Silver",
  "Tan",
  "Teal",
  "White",
  "Yellow",
  "Charcoal",
  "Beige",
  "Burgundy",
];

/** Infer an FB body style from the trim/model text (e.g. "…Sedan" → "Sedan"). */
function deriveBodyStyle(vehicle: Vehicle): string | null {
  const hay = `${vehicle.trim ?? ""} ${vehicle.model}`.toLowerCase();
  return FB_BODY_STYLES.find((style) => hay.includes(style.toLowerCase())) ?? null;
}

/** Map a free-text color to FB's base color option (e.g. "Lunar Blue" → "Blue"). */
function normalizeExteriorColor(color: string | null): string | null {
  if (!color) return null;
  const c = color.toLowerCase();
  return FB_EXTERIOR_COLORS.find((o) => c.includes(o.toLowerCase())) ?? null;
}

/** Derive a file extension from an image URL, defaulting to .jpg. */
function photoExtension(url: string): string {
  const ext = extname(url.split("?")[0]).toLowerCase();
  return /^\.(jpe?g|png|webp|gif)$/.test(ext) ? ext : ".jpg";
}

/**
 * Download each photo URL to a temp file and return the local paths. FB's
 * uploader takes files from disk, so we stage them first. Individual failures
 * are logged and skipped rather than aborting the whole listing.
 */
async function downloadPhotos(
  urls: string[],
  destDir: string,
): Promise<string[]> {
  const paths: string[] = [];
  const wanted = urls.slice(0, MAX_PHOTOS);

  for (let i = 0; i < wanted.length; i++) {
    const url = wanted[i];
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const dest = join(destDir, `photo-${i}${photoExtension(url)}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      paths.push(dest);
    } catch (err) {
      console.warn(
        `[publish-fb] skipping photo ${url}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return paths;
}

/** Save a full-page screenshot to the temp dir and return its path. */
async function screenshotError(page: Page): Promise<string> {
  const file = join(TMP_DIR, `fb-error-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.error(`[publish-fb] saved error screenshot: ${file}`);
  return file;
}

/**
 * Throw a SessionExpiredError if Facebook bounced us to a login / checkpoint
 * page or is rendering the logged-out email/password form.
 */
async function assertLoggedIn(page: Page): Promise<void> {
  const url = page.url();
  if (/\/login|login\.php|\/checkpoint/i.test(url)) {
    throw new SessionExpiredError(
      `FB session expired — redirected to ${url}. Re-run: npm run save-fb-session`,
    );
  }
  const loginField = page.locator('input[name="email"]');
  if (await loginField.isVisible().catch(() => false)) {
    throw new SessionExpiredError(
      "FB session expired — login form is showing. Re-run: npm run save-fb-session",
    );
  }
}

/** Click a field and fill it, then pause. */
async function typeInto(field: Locator, value: string): Promise<void> {
  await field.click();
  await field.fill(value);
  await humanDelay();
}

/**
 * Fill the first matching text field for any of the candidate accessible names
 * (tried as both label and placeholder). Throws if none are found so a UI
 * change surfaces loudly instead of silently producing an empty listing.
 */
async function fillTextField(
  page: Page,
  labels: string[],
  value: string,
  scope: Page | Locator = page,
): Promise<void> {
  for (const label of labels) {
    const byLabel = scope.getByLabel(label, { exact: false }).first();
    if ((await byLabel.count()) > 0) {
      await typeInto(byLabel, value);
      return;
    }
    const byPlaceholder = scope
      .getByPlaceholder(label, { exact: false })
      .first();
    if ((await byPlaceholder.count()) > 0) {
      await typeInto(byPlaceholder, value);
      return;
    }
  }
  throw new Error(
    `Could not find a text field for any of: ${labels.join(", ")}`,
  );
}

/**
 * The composer's editable fields live inside a <form>; the right-hand "Preview"
 * panel mirrors them as read-only text (with the same labels: Title, Price,
 * Description…). Scope field lookups to the form so we never match the preview.
 *
 * We pick the form that contains the photo file input — FB's top nav also has a
 * (search) <form>, so `.first()` would grab the wrong one. Falls back to the
 * whole page if the composer isn't a real <form> (a UI change).
 */
async function formScope(page: Page): Promise<Page | Locator> {
  const form = page
    .locator("form")
    .filter({ has: page.locator(PHOTO_INPUT_SELECTOR) })
    .first();
  return (await form.count()) > 0 ? form : page;
}

/**
 * Open the first matching combobox for any candidate label and pick the option
 * whose accessible name contains `option`. FB renders options in a popup
 * listbox once the combobox is clicked.
 */
async function selectDropdown(
  page: Page,
  labels: string[],
  option: string,
  scope: Page | Locator = page,
  exactOption = false,
): Promise<void> {
  for (const label of labels) {
    const combo = scope.getByLabel(label, { exact: false }).first();
    if ((await combo.count()) === 0) continue;

    await combo.click();
    await humanDelay();

    // Options render in a popup listbox portalled to the page root, so they're
    // looked up against `page`, not the field's scope. `exactOption` avoids a
    // substring match picking the wrong option (e.g. "Good" → "Very Good").
    const choice = page
      .getByRole("option", { name: option, exact: exactOption })
      .first();
    await choice.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
    await choice.click();
    await humanDelay();
    return;
  }
  throw new Error(
    `Could not find a dropdown for any of: ${labels.join(", ")}`,
  );
}

/**
 * Year/Make/Model vary across FB builds — sometimes a combobox, sometimes a
 * free-text field. Click it, type the value (filters a combobox, fills a text
 * input), and if an options popup appears pick the matching one. Best-effort:
 * leaves the typed value if no option surfaces.
 */
async function selectOrType(
  page: Page,
  labels: string[],
  value: string,
  scope: Page | Locator = page,
): Promise<void> {
  for (const label of labels) {
    const field = scope.getByLabel(label, { exact: false }).first();
    if ((await field.count()) === 0) continue;

    await field.click();
    await humanDelay();
    // fill() works for text inputs and editable comboboxes; ignore if the field
    // is a non-editable combobox button (the click already opened its popup).
    await field.fill(value).catch(() => {});
    await humanDelay();

    const choice = page
      .getByRole("option", { name: value, exact: false })
      .first();
    const hasOption = await choice
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (hasOption) {
      await choice.click();
      await humanDelay();
    }
    return;
  }
  throw new Error(`Could not find a field for any of: ${labels.join(", ")}`);
}

/** Push the staged photo files into FB's (hidden) file input. */
async function uploadPhotos(page: Page, files: string[]): Promise<void> {
  // FB sometimes defers rendering the file <input> until the upload area is
  // interacted with — this seems to bite headless/CI in particular. Best-effort:
  // click an "Add photos" trigger first to force the input into the DOM. Ignore
  // failures; on builds where the input is already present this is a harmless
  // no-op (and we match it below regardless).
  const trigger = page
    .getByRole("button", { name: /add photos?|add up to/i })
    .first();
  if (await trigger.count().catch(() => 0)) {
    await trigger.click().catch(() => {});
    await humanDelay();
  }

  // Match the input by type OR image/video accept filter, and set files
  // directly on it without requiring visibility (it's typically hidden). Use a
  // dedicated longer timeout since the composer can be slow to render in CI.
  const input = page.locator(PHOTO_INPUT_SELECTOR).first();
  await input.waitFor({ state: "attached", timeout: FILE_INPUT_TIMEOUT_MS });
  await input.setInputFiles(files);
  await humanDelay();
}

/**
 * The vehicle composer is a multi-step flow (details → review). Click "Next"
 * until a "Publish" button appears, then publish. Capped so a stuck flow can't
 * loop forever.
 */
async function clickThroughToPublish(page: Page): Promise<void> {
  const MAX_STEPS = 5;
  for (let step = 0; step < MAX_STEPS; step++) {
    const publish = page.getByRole("button", { name: /^publish$/i }).first();
    if (
      (await publish.count()) > 0 &&
      (await publish.isVisible().catch(() => false))
    ) {
      await publish.scrollIntoViewIfNeeded().catch(() => {});
      await publish.click();
      return;
    }

    const next = page.getByRole("button", { name: /^next$/i }).first();
    if (
      (await next.count()) > 0 &&
      (await next.isVisible().catch(() => false)) &&
      (await next.isEnabled().catch(() => false))
    ) {
      await next.click();
      await humanDelay();
      continue;
    }

    break;
  }

  // Diagnostics: when we can't advance, the usual cause is a disabled Next
  // (a required field is still empty). Log the Next button's state and every
  // visible button so the blocking step is obvious from the run output.
  const next = page.getByRole("button", { name: /^next$/i }).first();
  const nextState = {
    count: await next.count(),
    visible: await next.isVisible().catch(() => false),
    enabled: await next.isEnabled().catch(() => false),
  };
  const buttonNames = await page
    .getByRole("button")
    .evaluateAll((els) =>
      els
        .map((el) => (el.textContent ?? "").trim())
        .filter((t) => t.length > 0 && t.length < 40),
    )
    .catch(() => [] as string[]);

  // Dump every labeled form control with its value + required/invalid flags so
  // the empty required field disabling Next is identifiable from the logs.
  const controls = await page
    .locator(
      'input, textarea, select, [role="combobox"], [role="textbox"], [role="spinbutton"]',
    )
    .evaluateAll((els) =>
      els
        .map((el) => {
          const input = el as HTMLInputElement;
          const labelled = input.labels?.[0]?.textContent?.trim();
          return {
            label:
              labelled ||
              el.getAttribute("aria-label") ||
              el.getAttribute("placeholder") ||
              "",
            value:
              input.value ||
              el.getAttribute("aria-checked") ||
              el.textContent?.trim() ||
              "",
            required:
              el.getAttribute("aria-required") === "true" || input.required,
            invalid: el.getAttribute("aria-invalid") === "true",
          };
        })
        .filter(
          (c) =>
            c.label.length > 0 &&
            c.label.length < 60 &&
            c.label !== "Search Facebook",
        ),
    )
    .catch(() => [] as Array<Record<string, unknown>>);
  console.error(
    `[publish-fb] no Publish button. Next=${JSON.stringify(nextState)} ` +
      `buttons=${JSON.stringify(buttonNames)} controls=${JSON.stringify(controls)}`,
  );

  throw new Error("Could not find a Publish button to submit the listing.");
}

/**
 * After publishing, FB navigates to the new item page
 * (/marketplace/item/{id}). Wait for that and return the clean URL; fall back
 * to scraping the first item link on the page.
 */
async function extractListingUrl(page: Page): Promise<string> {
  try {
    await page.waitForURL(/\/marketplace\/item\/\d+/, { timeout: 30_000 });
    return page.url().split("?")[0];
  } catch {
    const href = await page
      .locator('a[href*="/marketplace/item/"]')
      .first()
      .getAttribute("href")
      .catch(() => null);
    if (href) {
      return new URL(href, "https://www.facebook.com").toString().split("?")[0];
    }
    throw new Error(
      "Listing appears published but the listing URL could not be determined.",
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Publish a single approved post to Facebook Marketplace as a vehicle listing.
 *
 * Returns { success: true, listingUrl } on success or { success: false, error }
 * for an ordinary failure. Throws SessionExpiredError if the saved session is
 * no longer valid (so the batch can stop and the operator re-authenticates).
 * The browser is always closed and temp files cleaned up.
 */
export async function publishToFacebook(
  post: PostWithVehicle,
): Promise<PublishResult> {
  const path = sessionPath();
  if (!existsSync(path)) {
    throw new SessionExpiredError(
      `No FB session file at ${path}. Run: npm run save-fb-session`,
    );
  }

  const { vehicle } = post;
  const title = buildTitle(vehicle);
  const tmpDir = join(TMP_DIR, `fb-upload-${Date.now()}`);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    await mkdir(tmpDir, { recursive: true });
    const photoFiles = await downloadPhotos(vehicle.photoUrls, tmpDir);
    if (photoFiles.length === 0) {
      return {
        success: false,
        error: "No photos could be downloaded; FB Marketplace requires at least one.",
      };
    }

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      storageState: path,
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    console.log(`[publish-fb] opening composer for post ${post.id} (${title})`);
    await page.goto(MARKETPLACE_CREATE_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    await assertLoggedIn(page);
    await humanDelay();

    // Photos first — the composer leads with the photo picker.
    await uploadPhotos(page, photoFiles);

    // All editable fields live in the composer <form>; scope lookups to it so
    // the identically-labelled read-only Preview panel is never matched. The
    // file input is present from page load, so the scope is valid here.
    const form = await formScope(page);

    // FB hides the Year/Make/Model/Price/… fields until a vehicle type is set,
    // so this must come before any field fill.
    await selectDropdown(page, ["Vehicle type", "Vehicle Type"], "Car/Truck", form);

    // The vehicle composer has no free-text title — FB derives it from
    // Year/Make/Model. These render after the vehicle-type choice, so wait for
    // Year before filling to avoid racing the form re-render.
    await form
      .getByLabel("Year", { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS })
      .catch(() => {});

    await selectDropdown(page, ["Year"], String(vehicle.year), form);
    await selectOrType(page, ["Make"], vehicle.make, form);
    await selectOrType(page, ["Model"], vehicle.model, form);
    await fillTextField(
      page,
      ["Mileage", "Number of miles", "Miles"],
      String(vehicle.mileage),
      form,
    );
    await fillTextField(page, ["Price"], String(vehicle.price), form);

    // Body style and Exterior color are required to advance, but we only have
    // them implicitly. Best-effort: infer and set them, but don't fail the whole
    // listing if the data doesn't map to an FB option — the Next/Publish step
    // will surface a genuinely-blocking gap.
    const bodyStyle = deriveBodyStyle(vehicle);
    if (bodyStyle) {
      await selectDropdown(page, ["Body style"], bodyStyle, form, true).catch(
        (err) =>
          console.warn(`[publish-fb] could not set body style: ${err.message}`),
      );
    }
    const exteriorColor = normalizeExteriorColor(vehicle.color);
    if (exteriorColor) {
      await selectDropdown(
        page,
        ["Exterior color", "Exterior colour"],
        exteriorColor,
        form,
        true,
      ).catch((err) =>
        console.warn(`[publish-fb] could not set exterior color: ${err.message}`),
      );
    }

    // Vehicle condition options are Excellent/Very Good/Good/Fair/Poor (not the
    // generic New/Used). "Good" is a safe, non-overstating default — adjust if
    // the dealer wants a different baseline. Exact match so "Good" doesn't
    // resolve to "Very Good".
    await selectDropdown(
      page,
      ["Vehicle condition", "Condition"],
      "Good",
      form,
      true,
    );

    // Fuel type is required to advance but we don't store it; default to
    // Gasoline (correct for the vast majority of inventory). Best-effort.
    await selectDropdown(page, ["Fuel type"], "Gasoline", form, true).catch(
      (err) =>
        console.warn(`[publish-fb] could not set fuel type: ${err.message}`),
    );

    // Transmission + Interior color round out the required set. Transmission
    // defaults to Automatic (true for this car and most modern inventory);
    // Interior color uses the scraped value, falling back to Black when the
    // listing didn't expose one. Best-effort.
    await selectDropdown(page, ["Transmission"], "Automatic", form, false).catch(
      (err) =>
        console.warn(`[publish-fb] could not set transmission: ${err.message}`),
    );
    await selectDropdown(
      page,
      ["Interior color", "Interior colour"],
      vehicle.interiorColor ?? "Black",
      form,
      true,
    ).catch((err) =>
      console.warn(`[publish-fb] could not set interior color: ${err.message}`),
    );

    await fillTextField(page, ["Description"], post.contentEn, form);

    await clickThroughToPublish(page);
    const listingUrl = await extractListingUrl(page);

    console.log(`[publish-fb] published post ${post.id} → ${listingUrl}`);
    return { success: true, listingUrl };
  } catch (err) {
    if (page) {
      await screenshotError(page).catch(() => {});
    }
    if (err instanceof SessionExpiredError) {
      throw err;
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (browser) await browser.close();
  }
}

/**
 * Drain the publish queue for Facebook Marketplace, one post at a time, while
 * the cadence governor permits. For each claimed post:
 *   - success  → markPublished() with the listing URL in metadata,
 *   - failure  → markFailed() with the error.
 *
 * A SessionExpiredError aborts the whole batch: the current post is released
 * back to APPROVED (it's the session's fault, not the post's) and the error is
 * rethrown so the operator re-runs save-fb-session.
 *
 * The shared cadence claim grabs the oldest APPROVED post regardless of
 * platform. Today FB is the only platform that enqueues posts; if a non-FB post
 * is ever claimed we release it and stop (an Instagram publisher would own it).
 */
export async function publishPendingFacebookPosts(): Promise<{
  published: number;
  failed: number;
}> {
  let published = 0;
  let failed = 0;

  for (;;) {
    const claim = await claimNextPublishablePost();
    if (!claim.claimed) {
      console.log(`[publish-fb] stopping: ${claim.reason}`);
      break;
    }

    const post = claim.post;
    if (post.platform !== Platform.FACEBOOK_MARKETPLACE) {
      await releaseClaim(post.id);
      console.warn(
        `[publish-fb] next post ${post.id} is ${post.platform}, not FB — released and stopping.`,
      );
      break;
    }

    try {
      const result = await publishToFacebook(post);
      if (result.success) {
        await markPublished(post.id, {
          platform: Platform.FACEBOOK_MARKETPLACE,
          listingUrl: result.listingUrl,
          publishedVia: "playwright",
        });
        published++;
      } else {
        await markFailed(post.id, result.error);
        failed++;
        console.error(`[publish-fb] post ${post.id} failed: ${result.error}`);
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        await releaseClaim(post.id);
        console.error(`[publish-fb] aborting batch: ${err.message}`);
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      await markFailed(post.id, reason);
      failed++;
      console.error(`[publish-fb] post ${post.id} errored: ${reason}`);
    }

    await humanDelay();
  }

  return { published, failed };
}
