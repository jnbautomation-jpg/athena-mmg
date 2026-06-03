// Posting queue + cadence governor.
//
// Governs the rate at which APPROVED posts are published, enforcing two limits
// from the environment:
//   - POSTING_CADENCE_MAX_PER_DAY      — max published posts per UTC day
//   - POSTING_CADENCE_MIN_HOURS_BETWEEN — minimum gap between published posts
//
// The cadence window counts ALL published posts (FB auto-publishes + IG via the
// queue), so it's a single global throttle on the account's posting rate.
//
// Lifecycle a publisher drives:
//   claimNextPublishablePost()  → PUBLISHING (atomic claim, cadence-gated)
//     → do the actual platform publish (lib/publishing/{facebook,instagram}.ts)
//     → markPublished() | markFailed()

import { Prisma, PostStatus } from "@prisma/client";
import type { Post, Vehicle } from "@prisma/client";
import { prisma } from "@/lib/db/client";

const DEFAULT_MAX_PER_DAY = 10;
const DEFAULT_MIN_HOURS_BETWEEN = 2;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface CadenceConfig {
  maxPerDay: number;
  minHoursBetween: number;
}

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getCadenceConfig(): CadenceConfig {
  return {
    maxPerDay: intFromEnv("POSTING_CADENCE_MAX_PER_DAY", DEFAULT_MAX_PER_DAY),
    minHoursBetween: intFromEnv(
      "POSTING_CADENCE_MIN_HOURS_BETWEEN",
      DEFAULT_MIN_HOURS_BETWEEN,
    ),
  };
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---------------------------------------------------------------------------
// Cadence status
// ---------------------------------------------------------------------------

export interface CadenceStatus {
  config: CadenceConfig;
  publishedToday: number;
  remainingToday: number;
  lastPublishedAt: Date | null;
  canPublishNow: boolean;
  /** "ok" when publishing is allowed, otherwise why it's blocked. */
  reason: string;
  /** Earliest time publishing is allowed again (now if already allowed). */
  nextEligibleAt: Date;
}

/** Compute whether the cadence limits currently permit publishing. */
export async function getCadenceStatus(
  now: Date = new Date(),
): Promise<CadenceStatus> {
  const config = getCadenceConfig();
  const dayStart = startOfUtcDay(now);

  const publishedToday = await prisma.post.count({
    where: { status: PostStatus.PUBLISHED, publishedAt: { gte: dayStart } },
  });

  const last = await prisma.post.findFirst({
    where: { status: PostStatus.PUBLISHED, publishedAt: { not: null } },
    orderBy: { publishedAt: "desc" },
    select: { publishedAt: true },
  });
  const lastPublishedAt = last?.publishedAt ?? null;

  const remainingToday = Math.max(0, config.maxPerDay - publishedToday);

  // Daily cap takes precedence over the min-gap check.
  if (remainingToday <= 0) {
    return {
      config,
      publishedToday,
      remainingToday,
      lastPublishedAt,
      canPublishNow: false,
      reason: `Daily cap reached (${publishedToday}/${config.maxPerDay}).`,
      nextEligibleAt: new Date(dayStart.getTime() + DAY_MS), // next UTC midnight
    };
  }

  if (lastPublishedAt) {
    const earliest = new Date(
      lastPublishedAt.getTime() + config.minHoursBetween * HOUR_MS,
    );
    if (now < earliest) {
      return {
        config,
        publishedToday,
        remainingToday,
        lastPublishedAt,
        canPublishNow: false,
        reason: `Minimum ${config.minHoursBetween}h between posts; last published ${lastPublishedAt.toISOString()}.`,
        nextEligibleAt: earliest,
      };
    }
  }

  return {
    config,
    publishedToday,
    remainingToday,
    lastPublishedAt,
    canPublishNow: true,
    reason: "ok",
    nextEligibleAt: now,
  };
}

// ---------------------------------------------------------------------------
// Claiming the next post
// ---------------------------------------------------------------------------

export type ClaimResult =
  | { claimed: true; post: Post & { vehicle: Vehicle } }
  | { claimed: false; reason: string; nextEligibleAt: Date | null };

/**
 * If cadence allows, atomically claim the oldest APPROVED post by moving it to
 * PUBLISHING and return it. The conditional update guards against two workers
 * grabbing the same post. The caller publishes it, then calls markPublished /
 * markFailed.
 */
export async function claimNextPublishablePost(): Promise<ClaimResult> {
  const status = await getCadenceStatus();
  if (!status.canPublishNow) {
    return {
      claimed: false,
      reason: status.reason,
      nextEligibleAt: status.nextEligibleAt,
    };
  }

  const candidate = await prisma.post.findFirst({
    where: { status: PostStatus.APPROVED },
    orderBy: [{ approvedAt: "asc" }, { createdAt: "asc" }],
    include: { vehicle: true },
  });

  if (!candidate) {
    return {
      claimed: false,
      reason: "No approved posts awaiting publication.",
      nextEligibleAt: null,
    };
  }

  // Atomic claim: only succeeds if the post is still APPROVED.
  const claim = await prisma.post.updateMany({
    where: { id: candidate.id, status: PostStatus.APPROVED },
    data: { status: PostStatus.PUBLISHING },
  });

  if (claim.count === 0) {
    return {
      claimed: false,
      reason: "Candidate was claimed concurrently — retry.",
      nextEligibleAt: null,
    };
  }

  return {
    claimed: true,
    post: { ...candidate, status: PostStatus.PUBLISHING },
  };
}

// ---------------------------------------------------------------------------
// Completing a publish
// ---------------------------------------------------------------------------

function mergeMetadata(
  existing: Prisma.JsonValue | null,
  patch: Prisma.InputJsonObject | undefined,
): Prisma.InputJsonObject {
  const base: Prisma.JsonObject =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? existing
      : {};
  return { ...base, ...(patch ?? {}) };
}

/** Mark a claimed post as PUBLISHED, optionally recording platform metadata. */
export async function markPublished(
  postId: string,
  extraMetadata?: Prisma.InputJsonObject,
): Promise<void> {
  const current = await prisma.post.findUnique({
    where: { id: postId },
    select: { metadata: true },
  });
  await prisma.post.update({
    where: { id: postId },
    data: {
      status: PostStatus.PUBLISHED,
      publishedAt: new Date(),
      failureReason: null,
      metadata: mergeMetadata(current?.metadata ?? null, extraMetadata),
    },
  });
}

/** Mark a claimed post as FAILED with a reason. */
export async function markFailed(postId: string, reason: string): Promise<void> {
  await prisma.post.update({
    where: { id: postId },
    data: { status: PostStatus.FAILED, failureReason: reason },
  });
}

/**
 * Return a claimed (PUBLISHING) post to APPROVED so it can be claimed again.
 * Used when a publisher claims a post it can't handle right now (e.g. the FB
 * publisher claims an Instagram post, or the FB session has expired) and wants
 * to hand it back rather than fail it. The conditional guards against clobbering
 * a post that has since moved to PUBLISHED/FAILED.
 */
export async function releaseClaim(postId: string): Promise<void> {
  await prisma.post.updateMany({
    where: { id: postId, status: PostStatus.PUBLISHING },
    data: { status: PostStatus.APPROVED },
  });
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export interface QueueDepth {
  pending: number;
  approved: number;
  publishing: number;
  failed: number;
}

/** Snapshot of how many posts sit in each pre-published state. */
export async function getQueueDepth(): Promise<QueueDepth> {
  const [pending, approved, publishing, failed] = await Promise.all([
    prisma.post.count({ where: { status: PostStatus.PENDING } }),
    prisma.post.count({ where: { status: PostStatus.APPROVED } }),
    prisma.post.count({ where: { status: PostStatus.PUBLISHING } }),
    prisma.post.count({ where: { status: PostStatus.FAILED } }),
  ]);
  return { pending, approved, publishing, failed };
}
