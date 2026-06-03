// Standalone Facebook Marketplace publish run — `npm run publish-fb` (tsx).
//
// Drains the approved-post queue to Facebook, respecting the cadence governor.
// Intended for a normal Node host (cron / GitHub Actions) rather than Vercel's
// serverless runtime, since it drives a Playwright browser. Locally, env comes
// from .env.local; in CI it comes from the workflow env (dotenv does not
// override already-set vars, so CI values take precedence).
//
// --force (TESTING ONLY): skip the queue + cadence governor entirely and run
// publishToFacebook() directly against the first FACEBOOK_MARKETPLACE post that
// is PUBLISHED (regardless of publishedAt). APPROVED posts may be Instagram —
// awaiting their own publisher — so we target the FB post that needs to go to
// Marketplace. Lets you smoke-test the Playwright publisher without waiting on
// the cadence window or mutating queue state. It does NOT update the post's
// status/publishedAt afterwards.
import { config } from "dotenv";
import { publishPendingFacebookPosts, publishToFacebook } from "@/lib/publishing/facebook";
import { prisma } from "@/lib/db/client";
import { Platform, PostStatus } from "@prisma/client";

config({ path: ".env.local" });

async function runForce(): Promise<void> {
  const post = await prisma.post.findFirst({
    where: {
      platform: Platform.FACEBOOK_MARKETPLACE,
      status: PostStatus.PUBLISHED,
    },
    orderBy: { createdAt: "asc" },
    include: { vehicle: true },
  });

  if (!post) {
    console.log("[run-publish-fb] --force: no PUBLISHED FACEBOOK_MARKETPLACE post found.");
    return;
  }

  console.log(`[run-publish-fb] --force: publishing post ${post.id} (cadence governor bypassed)`);
  const result = await publishToFacebook(post);
  console.log("[run-publish-fb] --force complete:", JSON.stringify(result));
}

async function main(): Promise<void> {
  if (process.argv.includes("--force")) {
    await runForce();
    return;
  }

  const result = await publishPendingFacebookPosts();
  console.log("[run-publish-fb] complete:", JSON.stringify(result));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[run-publish-fb] failed:", err);
    process.exit(1);
  });
