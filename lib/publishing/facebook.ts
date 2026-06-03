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
): Promise<void> {
  for (const label of labels) {
    const byLabel = page.getByLabel(label, { exact: false }).first();
    if ((await byLabel.count()) > 0) {
      await typeInto(byLabel, value);
      return;
    }
    const byPlaceholder = page.getByPlaceholder(label, { exact: false }).first();
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
 * Open the first matching combobox for any candidate label and pick the option
 * whose accessible name contains `option`. FB renders options in a popup
 * listbox once the combobox is clicked.
 */
async function selectDropdown(
  page: Page,
  labels: string[],
  option: string,
): Promise<void> {
  for (const label of labels) {
    const combo = page.getByLabel(label, { exact: false }).first();
    if ((await combo.count()) === 0) continue;

    await combo.click();
    await humanDelay();

    const choice = page
      .getByRole("option", { name: option, exact: false })
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

/** Push the staged photo files into FB's (hidden) file input. */
async function uploadPhotos(page: Page, files: string[]): Promise<void> {
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: ELEMENT_TIMEOUT_MS });
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

    // Core vehicle fields. Several labels are tried per field to survive small
    // wording changes between FB builds.
    await fillTextField(page, ["Title", "What are you selling?"], title);
    await selectDropdown(page, ["Vehicle condition", "Condition"], "Used");
    await selectDropdown(page, ["Availability"], "Available");
    await fillTextField(page, ["Price"], String(vehicle.price));
    await fillTextField(
      page,
      ["Mileage", "Number of miles", "Miles"],
      String(vehicle.mileage),
    );
    await fillTextField(page, ["Description"], post.contentEn);

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
