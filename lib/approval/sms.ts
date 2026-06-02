// Twilio SMS approval flow.
//
// Pending posts (Instagram) need a human yes/no before they publish. This module:
//   1. sends an approval-request SMS to DAD_PHONE_NUMBER for each pending post,
//   2. parses the inbound reply ("YES <code>" / "NO <code>"),
//   3. flips the matching Post to APPROVED / REJECTED.
//
// The post's approvalToken is a UUID — too long to type back over SMS — so we
// surface a short 8-char code (the token prefix) and match replies on it.

import twilio, { type Twilio } from "twilio";
import { Prisma, PostStatus } from "@prisma/client";
import type { Post, Vehicle } from "@prisma/client";
import { prisma } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// Twilio client + SMS send
// ---------------------------------------------------------------------------

let cachedClient: Twilio | null = null;

function getClient(): Twilio {
  if (cachedClient) return cachedClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error("Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)");
  }
  cachedClient = twilio(sid, token);
  return cachedClient;
}

/** Normalize a phone number to E.164 (assumes US when no country code given). */
export function toE164(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

async function sendSms(to: string, body: string): Promise<string> {
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!from) throw new Error("TWILIO_PHONE_NUMBER not set");
  const message = await getClient().messages.create({
    to: toE164(to),
    from: toE164(from),
    body,
  });
  return message.sid;
}

// ---------------------------------------------------------------------------
// Approval codes + metadata helpers
// ---------------------------------------------------------------------------

const CODE_LENGTH = 8;

/** Short, SMS-typeable code derived from the post's approval token. */
export function approvalCode(post: Pick<Post, "id" | "approvalToken">): string {
  return (post.approvalToken ?? post.id).slice(0, CODE_LENGTH).toLowerCase();
}

/** Safely read a Post.metadata JSON value as an object. */
function metadataObject(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function vehicleLabel(vehicle: Vehicle): string {
  return [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
    .filter(Boolean)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Sending approval requests
// ---------------------------------------------------------------------------

const CAPTION_PREVIEW_LIMIT = 280;

function approvalRequestBody(post: Post, vehicle: Vehicle): string {
  const code = approvalCode(post);
  const caption =
    post.contentEn.length > CAPTION_PREVIEW_LIMIT
      ? `${post.contentEn.slice(0, CAPTION_PREVIEW_LIMIT - 3)}...`
      : post.contentEn;

  return [
    "Athena — approve this Instagram post?",
    "",
    vehicleLabel(vehicle),
    "",
    `"${caption}"`,
    "",
    `Reply  YES ${code}  to approve  ·  NO ${code}  to reject`,
  ].join("\n");
}

/** Send one approval-request SMS for a post. Returns the Twilio message SID. */
export async function sendApprovalRequest(
  post: Post,
  vehicle: Vehicle,
): Promise<string> {
  const dad = process.env.DAD_PHONE_NUMBER;
  if (!dad) throw new Error("DAD_PHONE_NUMBER not set");
  return sendSms(dad, approvalRequestBody(post, vehicle));
}

export interface RequestApprovalResult {
  sent: number;
  errors: { postId: string; error: string }[];
}

/**
 * Send approval requests for every PENDING post that hasn't been requested yet
 * (tracked via metadata.approvalRequestedAt). Idempotent across runs.
 */
export async function requestApprovalForPendingPosts(): Promise<RequestApprovalResult> {
  const posts = await prisma.post.findMany({
    where: { status: PostStatus.PENDING },
    include: { vehicle: true },
    orderBy: { createdAt: "asc" },
  });

  let sent = 0;
  const errors: { postId: string; error: string }[] = [];

  for (const post of posts) {
    const meta = metadataObject(post.metadata);
    if (meta.approvalRequestedAt) continue; // already asked

    try {
      const sid = await sendApprovalRequest(post, post.vehicle);
      await prisma.post.update({
        where: { id: post.id },
        data: {
          metadata: {
            ...meta,
            approvalRequestedAt: new Date().toISOString(),
            approvalMessageSid: sid,
          },
        },
      });
      sent++;
    } catch (err) {
      errors.push({
        postId: post.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { sent, errors };
}

// ---------------------------------------------------------------------------
// Parsing + applying inbound replies
// ---------------------------------------------------------------------------

export type ApprovalDecision = "approve" | "reject" | "unknown";

const APPROVE_WORDS = new Set([
  "yes", "y", "approve", "approved", "ok", "okay", "si", "accept", "yep", "yeah",
]);
const REJECT_WORDS = new Set([
  "no", "n", "reject", "rejected", "deny", "denied", "decline", "nope",
]);

export interface ParsedReply {
  decision: ApprovalDecision;
  code: string | null;
}

/** Parse an inbound SMS body into a decision + optional approval code. */
export function parseApprovalReply(body: string): ParsedReply {
  const normalized = body
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // strip accents so "sí" → "si"

  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);

  let decision: ApprovalDecision = "unknown";
  for (const token of tokens) {
    if (APPROVE_WORDS.has(token)) {
      decision = "approve";
      break;
    }
    if (REJECT_WORDS.has(token)) {
      decision = "reject";
      break;
    }
  }

  const code = tokens.find((t) => /^[0-9a-f]{6,}$/.test(t)) ?? null;
  return { decision, code };
}

export interface ApprovalResult {
  matched: boolean;
  /** Message to send back to the sender (rendered as TwiML by the webhook). */
  message: string;
  postId?: string;
  status?: PostStatus;
}

/**
 * Apply an inbound SMS reply: find the pending post (by code, or the sole
 * pending post if no code) and flip it to APPROVED / REJECTED.
 */
export async function applyApprovalReply(body: string): Promise<ApprovalResult> {
  const { decision, code } = parseApprovalReply(body);

  if (decision === "unknown") {
    return {
      matched: false,
      message:
        "Athena didn't catch that. Reply YES <code> to approve or NO <code> to reject.",
    };
  }

  // Locate the target pending post.
  let post: (Post & { vehicle: Vehicle }) | null = null;
  if (code) {
    post = await prisma.post.findFirst({
      where: {
        status: PostStatus.PENDING,
        approvalToken: { startsWith: code },
      },
      include: { vehicle: true },
    });
  } else {
    const pending = await prisma.post.findMany({
      where: { status: PostStatus.PENDING },
      include: { vehicle: true },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
    if (pending.length === 1) {
      post = pending[0];
    } else if (pending.length > 1) {
      return {
        matched: false,
        message:
          "Several posts are awaiting approval — reply with the code from the request, e.g. YES 1a2b3c4d.",
      };
    }
  }

  if (!post) {
    return {
      matched: false,
      message: code
        ? `No pending post found for code ${code}.`
        : "No posts are awaiting approval right now.",
    };
  }

  const status =
    decision === "approve" ? PostStatus.APPROVED : PostStatus.REJECTED;

  await prisma.post.update({
    where: { id: post.id },
    data: {
      status,
      approvedAt: decision === "approve" ? new Date() : null,
      failureReason: decision === "reject" ? "Rejected via SMS" : null,
    },
  });

  const label = vehicleLabel(post.vehicle);
  const message =
    decision === "approve"
      ? `Approved — ${label} is cleared to post to Instagram.`
      : `Rejected — ${label} will not be posted.`;

  return { matched: true, message, postId: post.id, status };
}
