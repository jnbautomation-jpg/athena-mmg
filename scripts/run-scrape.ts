// Standalone nightly inventory scrape — run via `npm run scrape` (tsx).
//
// Used by the GitHub Actions workflow (.github/workflows/scrape.yml) so the
// Playwright scrape runs on a normal Node host instead of Vercel's serverless
// runtime. In CI, DATABASE_URL / DIRECT_URL / CARGURUS_DEALER_URL come from the
// workflow env; locally they're loaded from .env.local below.
import { config } from "dotenv";
import { syncInventory } from "@/lib/inventory/scraper";

// Load .env.local for local runs. dotenv does not override variables already
// present in the environment, so CI-provided env vars take precedence. This
// runs before main(), and the Prisma client reads DATABASE_URL lazily at query
// time, so env is in place before any DB access.
config({ path: ".env.local" });

async function main(): Promise<void> {
  const result = await syncInventory();
  console.log("[run-scrape] complete:", JSON.stringify(result));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[run-scrape] failed:", err);
    process.exit(1);
  });
