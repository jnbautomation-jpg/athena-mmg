// One-off backfill — `npx tsx scripts/backfill-photo-sizes.ts`.
//
// Existing Vehicle rows were scraped before lib/inventory/scraper.ts learned to
// upgrade gallery photos to the largest size CarGurus serves, so most stored
// photoUrls are 296x222 thumbnails. This rewrites each row's photo URLs to the
// largest size already present in that row (matching the scraper's new
// dedupePhotos behaviour), gated on aspect ratio so odd-aspect thumbnails
// (e.g. a 200x200 badge) — which have no matching large version — are left
// untouched. Rows whose stored URLs are all thumbnails simply don't change and
// will be upgraded on their next scrape.
import { config } from "dotenv";
import { prisma } from "@/lib/db/client";

config({ path: ".env.local" });

// Keep in sync with lib/inventory/scraper.ts.
const PHOTO_SIZE_RE = /-(\d+)x(\d+)(\.\w+)$/;

function upgradePhotoSizes(urls: string[]): string[] {
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

  return urls.map((url) => {
    const clean = url.split("?")[0];
    const m = clean.match(PHOTO_SIZE_RE);
    const sameRatio =
      m !== null &&
      largestRatio > 0 &&
      Math.abs(Number(m[1]) / Number(m[2]) - largestRatio) < 0.02;
    return largestSuffix && sameRatio
      ? clean.replace(PHOTO_SIZE_RE, `${largestSuffix}$3`)
      : clean;
  });
}

async function main(): Promise<void> {
  const vehicles = await prisma.vehicle.findMany({
    where: { photoUrls: { isEmpty: false } },
    select: { id: true, photoUrls: true },
  });

  let rowsUpdated = 0;
  let photosUpgraded = 0;

  for (const v of vehicles) {
    const next = upgradePhotoSizes(v.photoUrls);
    const changedCount = next.filter((u, i) => u !== v.photoUrls[i]).length;
    if (changedCount === 0) continue;

    await prisma.vehicle.update({
      where: { id: v.id },
      data: { photoUrls: next },
    });
    rowsUpdated++;
    photosUpgraded += changedCount;
  }

  console.log(
    `[backfill-photo-sizes] scanned ${vehicles.length} vehicles; ` +
      `updated ${rowsUpdated}; upgraded ${photosUpgraded} photo URLs.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-photo-sizes] failed:", err);
    process.exit(1);
  });
