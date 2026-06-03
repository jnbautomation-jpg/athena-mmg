// Posting schedule trigger.
//
// Protected by CRON_SECRET (same pattern as the scrape route). For each active
// vehicle that hasn't been posted to a platform in the last 7 days, generates
// EN/ES copy and creates a Post:
//   - FACEBOOK_MARKETPLACE → PUBLISHED with publishedAt = null (no approval
//     gate; the publisher claims it and sets publishedAt when actually posted)
//   - INSTAGRAM            → PENDING   (awaits SMS approval; carries a token)
//
// Cadence cap: POSTING_CADENCE_MAX_PER_DAY bounds how many posts go out per
// calendar day (UTC), split evenly across the two platforms. The cap counts
// posts already created today, so it holds across multiple runs per day — and
// also stops a single cold-start run from overrunning maxDuration.
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { Platform, PostStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { generatePostCopy } from "@/lib/content/generator";
import { requestApprovalForPendingPosts } from "@/lib/approval/sms";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PER_DAY = 10;

interface PostError {
  vehicleId: string;
  platform: Platform;
  error: string;
}

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  const authHeader = request.headers.get("authorization");
  const querySecret = new URL(request.url).searchParams.get("secret");
  const provided = authHeader?.replace(/^Bearer\s+/i, "") ?? querySecret;
  return provided === secret;
}

/** Daily max from env (positive int), or the default. */
function dailyMax(): number {
  const parsed = Number.parseInt(process.env.POSTING_CADENCE_MAX_PER_DAY ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PER_DAY;
}

/** Start of the current UTC day. */
function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Per-platform daily budget: split the daily max evenly across both platforms.
  const perPlatformCap = Math.floor(dailyMax() / 2);
  const dayStart = startOfUtcDay();

  // How many have already gone out today, per platform → remaining budget.
  const todayByPlatform = await prisma.post.groupBy({
    by: ["platform"],
    where: { createdAt: { gte: dayStart } },
    _count: { _all: true },
  });
  const postedToday = (platform: Platform): number =>
    todayByPlatform.find((row) => row.platform === platform)?._count._all ?? 0;

  const remaining: Record<Platform, number> = {
    [Platform.FACEBOOK_MARKETPLACE]: Math.max(
      0,
      perPlatformCap - postedToday(Platform.FACEBOOK_MARKETPLACE),
    ),
    [Platform.INSTAGRAM]: Math.max(
      0,
      perPlatformCap - postedToday(Platform.INSTAGRAM),
    ),
  };

  const since = new Date(Date.now() - SEVEN_DAYS_MS);

  // Active vehicles + any posts they've had in the last 7 days, so we can skip
  // a platform that was already posted recently (avoids re-publishing FB and
  // re-queuing duplicate PENDING Instagram posts every run).
  const vehicles = await prisma.vehicle.findMany({
    where: { isActive: true },
    include: {
      posts: {
        where: { createdAt: { gte: since } },
        select: { platform: true },
      },
    },
  });

  let generated = 0;
  const errors: PostError[] = [];

  for (const vehicle of vehicles) {
    // Stop early once both platform budgets are exhausted.
    if (
      remaining[Platform.FACEBOOK_MARKETPLACE] <= 0 &&
      remaining[Platform.INSTAGRAM] <= 0
    ) {
      break;
    }

    const recentPlatforms = new Set(vehicle.posts.map((p) => p.platform));

    // --- Facebook Marketplace: auto-publish ---
    if (
      remaining[Platform.FACEBOOK_MARKETPLACE] > 0 &&
      !recentPlatforms.has(Platform.FACEBOOK_MARKETPLACE)
    ) {
      try {
        const copy = await generatePostCopy(vehicle, "FACEBOOK_MARKETPLACE");
        await prisma.post.create({
          data: {
            vehicleId: vehicle.id,
            platform: Platform.FACEBOOK_MARKETPLACE,
            contentEn: copy.contentEn,
            contentEs: copy.contentEs,
            status: PostStatus.PUBLISHED,
            metadata: { variationSeed: copy.variationSeed },
          },
        });
        remaining[Platform.FACEBOOK_MARKETPLACE]--;
        generated++;
      } catch (err) {
        errors.push({
          vehicleId: vehicle.id,
          platform: Platform.FACEBOOK_MARKETPLACE,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // --- Instagram: queue for SMS approval ---
    if (
      remaining[Platform.INSTAGRAM] > 0 &&
      !recentPlatforms.has(Platform.INSTAGRAM)
    ) {
      try {
        const copy = await generatePostCopy(vehicle, "INSTAGRAM");
        await prisma.post.create({
          data: {
            vehicleId: vehicle.id,
            platform: Platform.INSTAGRAM,
            contentEn: copy.contentEn,
            contentEs: copy.contentEs,
            status: PostStatus.PENDING,
            approvalToken: randomUUID(),
            metadata: { variationSeed: copy.variationSeed },
          },
        });
        remaining[Platform.INSTAGRAM]--;
        generated++;
      } catch (err) {
        errors.push({
          vehicleId: vehicle.id,
          platform: Platform.INSTAGRAM,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Send SMS approval requests for any pending posts (this run's + any older
  // ones not yet asked about). SMS failures don't fail the route.
  let approvalRequests: { sent: number; errors: { postId: string; error: string }[] } = {
    sent: 0,
    errors: [],
  };
  try {
    approvalRequests = await requestApprovalForPendingPosts();
  } catch (err) {
    approvalRequests.errors.push({
      postId: "-",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({
    ok: true,
    generated,
    errors,
    approvalRequests,
    cap: {
      maxPerDay: dailyMax(),
      perPlatform: perPlatformCap,
      remainingAfterRun: {
        FACEBOOK_MARKETPLACE: remaining[Platform.FACEBOOK_MARKETPLACE],
        INSTAGRAM: remaining[Platform.INSTAGRAM],
      },
    },
    timestamp: new Date().toISOString(),
  });
}
