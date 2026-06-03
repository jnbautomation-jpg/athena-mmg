// Standalone Facebook Marketplace publish run — `npm run publish-fb` (tsx).
//
// Drains the approved-post queue to Facebook, respecting the cadence governor.
// Intended for a normal Node host (cron / GitHub Actions) rather than Vercel's
// serverless runtime, since it drives a Playwright browser. Locally, env comes
// from .env.local; in CI it comes from the workflow env (dotenv does not
// override already-set vars, so CI values take precedence).
import { config } from "dotenv";
import { publishPendingFacebookPosts } from "@/lib/publishing/facebook";

config({ path: ".env.local" });

async function main(): Promise<void> {
  const result = await publishPendingFacebookPosts();
  console.log("[run-publish-fb] complete:", JSON.stringify(result));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[run-publish-fb] failed:", err);
    process.exit(1);
  });
