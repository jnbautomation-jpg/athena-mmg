// CarGurus scraper.
//
// Scrapes the Miami Motor Group dealer storefront on CarGurus with Playwright
// and syncs the results into the `Vehicle` table.
//
// Verified against the live DOM (2026-06). Key facts the implementation relies on:
//   - Listing detail links are `/details/{listingId}?...` (the id is the path
//     segment) — NOT the legacy `vehicleDetails.action?id=` form.
//   - Each SRP tile's text carries a labeled spec block:
//       "... Year: 2023 Make: Hyundai Model: Elantra Body type: Sedan ...
//        Exterior color: Blue ... Mileage: 20,530 Stock #: ... VIN: ..."
//     We parse make/model/year/color/mileage from those labels (robust against
//     multi-word makes like "Mercedes-Benz" / "Land Rover").
//   - The selling price sits right before "Includes dealer fees" in the tile.
//   - `networkidle` never fires on CarGurus (persistent connections), so we wait
//     on `domcontentloaded` + a `state: "attached"` selector instead.
//   - Tile anchors are zero-size stretched-link overlays, so we wait for them
//     "attached" rather than "visible".
//   - The storefront is paginated (~23/page); we follow the "Next page" control.
//   - The detail page <h1> ("2023 Hyundai Elantra SEL FWD") yields the trim, and
//     carries the full photo gallery (multiple sizes per photo — deduped by id).

import { chromium, type Browser, type Page } from "playwright";
import { prisma } from "@/lib/db/client";
import type { ScrapedVehicle } from "./types";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MIN_DELAY_MS = 1500;
const MAX_DELAY_MS = 3500;
const MAX_PHOTOS = 10;
const MAX_PAGES = 50; // safety cap on pagination
const NAV_TIMEOUT_MS = 60_000;
const LISTING_SELECTOR = 'a[href*="/details/"]';

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const NEXT_PAGE_SELECTORS = [
  'a[aria-label="Next page"]',
  'button[aria-label="Next page"]',
  'a[aria-label="Next"]',
  'button[aria-label="Next"]',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random human-like pause between navigations to avoid bot detection. */
function humanDelay(): Promise<void> {
  const ms =
    Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
  return sleep(ms);
}

/** Strip everything but digits and parse as an integer (0 if none found). */
function parseIntSafe(text: string | null | undefined): number {
  if (!text) return 0;
  const digits = text.replace(/[^0-9]/g, "");
  return digits ? parseInt(digits, 10) : 0;
}

/** Extract the CarGurus listing id: `/details/{id}` (or legacy `?id=`). */
function extractListingId(url: string): string | null {
  const path = url.match(/\/details\/(\d+)/);
  if (path) return path[1];
  const query = url.match(/[?&#]id=(\d+)/);
  return query ? query[1] : null;
}

/** Grab the first capture group of a regex against text, trimmed. */
function grab(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

/**
 * Parse the labeled spec block embedded in an SRP tile's text content.
 * e.g. "... Year: 2023 Make: Hyundai Model: Elantra Body type: Sedan ...
 *       Exterior color: Blue ... Mileage: 20,530 ..."
 */
function parseTileSpecs(text: string): {
  year: number;
  make: string;
  model: string;
  color: string | null;
  mileage: number;
} {
  return {
    year: parseIntSafe(grab(text, /Year:\s*(\d{4})/)),
    make: grab(text, /Make:\s*(.+?)\s+Model:/) ?? "",
    model:
      grab(text, /Model:\s*(.+?)\s+Body type:/) ??
      grab(text, /Model:\s*(.+?)\s+(?:Doors|Drivetrain|Exterior|Engine)/) ??
      "",
    color: grab(
      text,
      /Exterior color:\s*(.+?)\s+(?:Combined|Interior|Fuel|Transmission|Mileage)/,
    ),
    mileage: parseIntSafe(grab(text, /Mileage:\s*([\d,]+)/)),
  };
}

/**
 * Determine the selling price from an SRP tile's text. Prefers the amount
 * immediately before "Includes dealer fees"; otherwise takes the lowest of the
 * non-payment ("/mo"), non-price-drop ("-$") dollar amounts.
 */
function parsePrice(text: string): number {
  const anchored = text.match(/\$([\d,]+)\s*Includes dealer fees/i);
  if (anchored) return parseIntSafe(anchored[1]);

  const candidates: number[] = [];
  const re = /(-?)\$([\d,]+)(\s*\/\s*mo)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] === "-" || m[3]) continue; // skip price drops and monthly payments
    const value = parseIntSafe(m[2]);
    if (value >= 500) candidates.push(value);
  }
  return candidates.length > 0 ? Math.min(...candidates) : 0;
}

/** Fallback title parse (year make model trim) when labeled specs are absent. */
function parseTitle(title: string): {
  year: number;
  make: string;
  model: string;
} {
  const parts = title.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  const yearIdx = parts.findIndex((p) => /^(19|20)\d{2}$/.test(p));
  const after = yearIdx >= 0 ? parts.slice(yearIdx + 1) : parts;
  return {
    year: yearIdx >= 0 ? parseInt(parts[yearIdx], 10) : 0,
    make: after[0] ?? "",
    model: after[1] ?? "",
  };
}

/** Derive the trim from a detail-page <h1> by removing year/make/model. */
function deriveTrim(
  h1: string | null,
  year: number,
  make: string,
  model: string,
): string | null {
  if (!h1) return null;
  let t = h1;
  if (year) t = t.replace(String(year), " ");
  if (make) t = t.replace(make, " ");
  if (model) t = t.replace(model, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t || null;
}

// Photo URL size suffix, e.g. "-1024x768.jpeg" → [, "1024", "768", ".jpeg"].
const PHOTO_SIZE_RE = /-(\d+)x(\d+)(\.\w+)$/;

/**
 * Dedupe gallery image URLs by photo id and upgrade each to the largest size
 * the gallery serves.
 *
 * CarGurus emits many sizes per photo (e.g. "-1024x768", "-296x222"), but the
 * detail-page DOM usually only carries a small thumbnail for every photo except
 * the lead one — so naively keeping the first-seen URL stored 296x222
 * thumbnails for photos 2..N. The CDN only serves a whitelisted set of sizes
 * (e.g. 800x600 / 1600x1200 are 403), so we can't request an arbitrary larger
 * size; instead we find the largest size actually present anywhere in the
 * gallery (a known-served size) and rewrite every photo's suffix to it.
 */
function dedupePhotos(urls: string[], max: number): string[] {
  // Largest WxH suffix seen across the whole gallery (a CDN-served size), and
  // its aspect ratio — only photos sharing that ratio get upgraded to it.
  let largestSuffix: string | null = null;
  let largestArea = 0;
  let largestRatio = 0;
  for (const url of urls) {
    const m = url.split("?")[0].match(PHOTO_SIZE_RE);
    if (!m) continue;
    const w = Number(m[1]);
    const h = Number(m[2]);
    const area = w * h;
    if (area > largestArea) {
      largestArea = area;
      largestSuffix = `-${w}x${h}`;
      largestRatio = w / h;
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const clean = url.split("?")[0];
    // Collapse the size suffix to identify the photo by its id.
    const base = clean.replace(PHOTO_SIZE_RE, "$3");
    if (seen.has(base)) continue;
    seen.add(base);

    // Upgrade to the largest gallery size, but only for photos that share its
    // aspect ratio. An odd-aspect thumbnail (e.g. a 200x200 badge) has no
    // matching large version and would 403 if rewritten, so it's left as-is.
    const m = clean.match(PHOTO_SIZE_RE);
    const sameRatio =
      m !== null &&
      largestRatio > 0 &&
      Math.abs(Number(m[1]) / Number(m[2]) - largestRatio) < 0.02;
    const upgraded =
      largestSuffix && sameRatio
        ? clean.replace(PHOTO_SIZE_RE, `${largestSuffix}$3`)
        : clean;
    out.push(upgraded);
    if (out.length >= max) break;
  }
  return out;
}

/** Wait for listing tiles to be present in the DOM (not necessarily visible). */
async function waitForListings(page: Page): Promise<boolean> {
  try {
    await page.waitForSelector(LISTING_SELECTOR, {
      state: "attached",
      timeout: NAV_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

// Raw tile data extracted in the browser context; parsed in Node.
interface RawTile {
  href: string;
  ariaLabel: string | null;
  cardText: string;
  imgSrc: string | null;
}

/** Collect every listing tile currently rendered on the page. */
async function collectTiles(page: Page): Promise<RawTile[]> {
  return page.evaluate((selector: string) => {
    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(selector),
    );
    const seen = new Set<string>();
    const tiles: RawTile[] = [];

    for (const anchor of anchors) {
      const href = anchor.href;
      const idMatch = href.match(/\/details\/(\d+)/);
      if (!idMatch) continue;
      const id = idMatch[1];
      if (seen.has(id)) continue;
      seen.add(id);

      // Climb to the tile container — the nearest ancestor holding a price.
      let card: HTMLElement = anchor;
      for (let i = 0; i < 8 && card.parentElement; i++) {
        if (/\$[\d,]{3,}/.test(card.textContent ?? "")) break;
        card = card.parentElement;
      }

      const img = card.querySelector<HTMLImageElement>("img");

      tiles.push({
        href,
        ariaLabel: anchor.getAttribute("aria-label"),
        cardText: (card.textContent ?? "").replace(/\s+/g, " ").trim(),
        imgSrc: img ? img.getAttribute("src") ?? img.getAttribute("data-src") : null,
      });
    }

    return tiles;
    // RawTile shape is enforced by the function's call site.
  }, LISTING_SELECTOR) as Promise<RawTile[]>;
}

/** Click through to the next page if a pagination control is available. */
async function goToNextPage(page: Page): Promise<boolean> {
  const firstHrefBefore = await page
    .locator(LISTING_SELECTOR)
    .first()
    .getAttribute("href")
    .catch(() => null);

  for (const selector of NEXT_PAGE_SELECTORS) {
    const control = page.locator(selector).first();
    if ((await control.count()) === 0) continue;
    const enabled = await control.isEnabled().catch(() => false);
    const ariaDisabled = await control
      .getAttribute("aria-disabled")
      .catch(() => null);
    if (!enabled || ariaDisabled === "true") continue;

    await control.scrollIntoViewIfNeeded().catch(() => {});
    await control.click().catch(() => {});

    // Wait for the listing set to actually change (client-side pagination).
    await page
      .waitForFunction(
        ({ sel, prev }: { sel: string; prev: string | null }) => {
          const a = document.querySelector<HTMLAnchorElement>(sel);
          return a !== null && a.getAttribute("href") !== prev;
        },
        { sel: LISTING_SELECTOR, prev: firstHrefBefore },
        { timeout: 15_000 },
      )
      .catch(() => {});
    return true;
  }
  return false;
}

// Detail-page data extracted in the browser context.
interface RawDetail {
  h1: string | null;
  photoUrls: string[];
  description: string | null;
  color: string | null;
  interiorColor: string | null;
}

/**
 * Open an individual listing page and pull h1, photos, description, exterior
 * color, and interior color.
 */
async function scrapeDetail(page: Page, url: string): Promise<RawDetail> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page
    .waitForSelector("h1", { state: "attached", timeout: NAV_TIMEOUT_MS })
    .catch(() => {});

  return page.evaluate((): RawDetail => {
    const h1 = document.querySelector("h1")?.textContent?.trim() || null;

    const photoUrls = Array.from(document.querySelectorAll<HTMLImageElement>("img"))
      .map((img) => img.getAttribute("src") ?? img.getAttribute("data-src") ?? "")
      .filter(
        (src) =>
          /static\.cargurus|cloudfront/i.test(src) &&
          /\.(jpe?g|png|webp)/i.test(src),
      );

    // Seller free-text notes, if any (this dealer often has none).
    const descEl = document.querySelector(
      [
        "[data-testid='seller-notes']",
        "[data-testid*='sellerNotes']",
        "[data-testid*='notes']",
        "[class*='ellerNotes']",
        "[class*='escription']",
      ].join(", "),
    );
    let description = descEl?.textContent?.replace(/\s+/g, " ").trim() || null;
    // Don't mistake the legal disclaimer for a description.
    if (description && /All advertised vehicle prices|Disclaimer/i.test(description)) {
      description = null;
    }

    const color =
      Array.from(document.querySelectorAll("li, tr, dt, div"))
        .map((el) => el.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .map((t) => t.match(/Exterior color\s*:?\s*([A-Za-z ]+)/i)?.[1]?.trim())
        .find((v): v is string => Boolean(v)) ?? null;

    const interiorColor =
      Array.from(document.querySelectorAll("li, tr, dt, div"))
        .map((el) => el.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .map((t) => t.match(/Interior color\s*:?\s*([A-Za-z ]+)/i)?.[1]?.trim())
        .find((v): v is string => Boolean(v)) ?? null;

    return { h1, photoUrls, description, color, interiorColor };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape the full dealer inventory from CarGurus and return ScrapedVehicle[].
 * Launches headless Chromium, paginates the storefront, then visits each
 * listing's detail page. Closes the browser on any error and rethrows.
 */
export async function scrapeInventory(): Promise<ScrapedVehicle[]> {
  const dealerUrl = process.env.CARGURUS_DEALER_URL;
  if (!dealerUrl) {
    throw new Error("CARGURUS_DEALER_URL is not set");
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    console.log(`[scrape] navigating to dealer page: ${dealerUrl}`);
    await page.goto(dealerUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    if (!(await waitForListings(page))) {
      throw new Error(
        "No listing tiles found — the page layout may have changed or the request was blocked.",
      );
    }

    // --- collect every tile across all pages (deduped by listing id) ---
    const tilesById = new Map<string, RawTile>();
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      await waitForListings(page);
      const tiles = await collectTiles(page);

      let added = 0;
      for (const tile of tiles) {
        const id = extractListingId(tile.href);
        if (id && !tilesById.has(id)) {
          tilesById.set(id, tile);
          added++;
        }
      }
      console.log(
        `[scrape] page ${pageNum}: ${tiles.length} tiles (${added} new) — ${tilesById.size} total`,
      );

      if (added === 0) break;
      const moved = await goToNextPage(page);
      if (!moved) break;
      await humanDelay();
    }

    console.log(
      `[scrape] collected ${tilesById.size} unique listings; fetching detail pages...`,
    );

    // --- visit each detail page ---
    const vehicles: ScrapedVehicle[] = [];
    let index = 0;
    for (const [externalId, tile] of Array.from(tilesById.entries())) {
      index++;
      await humanDelay();

      const specs = parseTileSpecs(tile.cardText);
      // Fall back to the aria-label title if the labeled specs were missing.
      if ((!specs.make || !specs.model || !specs.year) && tile.ariaLabel) {
        const t = parseTitle(tile.ariaLabel);
        specs.year = specs.year || t.year;
        specs.make = specs.make || t.make;
        specs.model = specs.model || t.model;
      }

      let detail: RawDetail = {
        h1: null,
        photoUrls: [],
        description: null,
        color: null,
        interiorColor: null,
      };
      try {
        detail = await scrapeDetail(page, tile.href);
      } catch (err) {
        console.warn(
          `[scrape] detail fetch failed for ${externalId} (${tile.href}):`,
          err instanceof Error ? err.message : err,
        );
      }

      const photos = dedupePhotos(detail.photoUrls, MAX_PHOTOS);
      const photoUrls =
        photos.length > 0
          ? photos
          : tile.imgSrc
            ? [tile.imgSrc.split("?")[0]]
            : [];

      vehicles.push({
        externalId,
        make: specs.make,
        model: specs.model,
        year: specs.year,
        trim: deriveTrim(detail.h1, specs.year, specs.make, specs.model),
        price: parsePrice(tile.cardText),
        mileage: specs.mileage,
        color: specs.color ?? detail.color,
        interiorColor: detail.interiorColor,
        description: detail.description,
        photoUrls,
        cargurusUrl: tile.href,
        isActive: true,
        lastScrapedAt: new Date(),
      });

      console.log(
        `[scrape] (${index}/${tilesById.size}) ${specs.year} ${specs.make} ${specs.model} — $${parsePrice(
          tile.cardText,
        )}, ${specs.mileage} mi, ${photoUrls.length} photos`,
      );
    }

    console.log(`[scrape] done — ${vehicles.length} vehicles scraped`);
    return vehicles;
  } catch (err) {
    console.error("[scrape] error:", err);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Scrape the inventory and reconcile it with the database:
 *  - upsert every scraped vehicle (create new / update price, mileage, photos,
 *    description, lastScrapedAt on existing),
 *  - deactivate any active DB vehicle whose externalId was not seen this run.
 */
export async function syncInventory(): Promise<{
  upserted: number;
  deactivated: number;
}> {
  console.log("[sync] starting inventory sync...");
  const scraped = await scrapeInventory();
  console.log(`[sync] scraped ${scraped.length} vehicles; upserting...`);

  const scrapedIds: string[] = [];
  let upserted = 0;

  for (const vehicle of scraped) {
    scrapedIds.push(vehicle.externalId);
    await prisma.vehicle.upsert({
      where: { externalId: vehicle.externalId },
      create: vehicle,
      update: {
        price: vehicle.price,
        mileage: vehicle.mileage,
        photoUrls: vehicle.photoUrls,
        description: vehicle.description,
        lastScrapedAt: vehicle.lastScrapedAt,
        isActive: true, // a re-seen listing is active again
      },
    });
    upserted++;
    console.log(
      `[sync] upserted ${vehicle.year} ${vehicle.make} ${vehicle.model} (${vehicle.externalId}) [${upserted}/${scraped.length}]`,
    );
  }

  // Deactivate anything no longer on the lot. If nothing was scraped, skip
  // deactivation entirely to avoid wiping inventory on a failed/empty scrape.
  let deactivated = 0;
  if (scrapedIds.length > 0) {
    const result = await prisma.vehicle.updateMany({
      where: { externalId: { notIn: scrapedIds }, isActive: true },
      data: { isActive: false },
    });
    deactivated = result.count;
  } else {
    console.warn("[sync] no vehicles scraped — skipping deactivation");
  }

  console.log(`[sync] done — upserted ${upserted}, deactivated ${deactivated}`);
  return { upserted, deactivated };
}
