// Claude API post-copy generator.
//
// Turns a DB Vehicle into FB Marketplace / Instagram post copy in English and
// Miami-Cuban Spanish. Anti-spam is the hard requirement: FB throttles repeated
// copy, so every call must produce meaningfully different phrasing, structure,
// emoji, and hashtags — even for the same car. We get that from (a) a per-day
// deterministic variation seed that selects a style + emoji density + hashtag
// count from the vehicle id, and (b) temperature on the model.

import Anthropic from "@anthropic-ai/sdk";
import type { Vehicle } from "@prisma/client";

export interface PostCopy {
  contentEn: string;
  contentEs: string;
  /** Short human-readable description of the variation used, for audit trail. */
  variationSeed: string;
}

export type ContentPlatform = "FACEBOOK_MARKETPLACE" | "INSTAGRAM";

// Sonnet 4.6 supports `temperature`, which we use here for output variety.
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1500;
const TEMPERATURE = 1;

const anthropic = new Anthropic();

// ---------------------------------------------------------------------------
// Variation system
// ---------------------------------------------------------------------------

interface VariationStyle {
  key: string;
  guidance: string;
}

const VARIATION_STYLES: VariationStyle[] = [
  {
    key: "punchy",
    guidance:
      "Short, hard-hitting lines and quick hits. Lots of line breaks, high energy, no filler.",
  },
  {
    key: "storyteller",
    guidance:
      "Open with a little scene or vignette — who this car is for, a quick moment behind the wheel — then land the details.",
  },
  {
    key: "spec-forward",
    guidance:
      "Lead with the numbers and what they actually mean. Let the value speak through the facts.",
  },
  {
    key: "lifestyle",
    guidance:
      "Paint the lifestyle — where you're headed, how it feels to pull up in this. Sell the feeling.",
  },
  {
    key: "value-hunter",
    guidance:
      "Frame it around the deal and the smart-buyer angle — why this is a real catch at this price and mileage.",
  },
  {
    key: "flex",
    guidance:
      "Confident flex energy — this car makes you look good. Own the street, no apologies.",
  },
];

const EMOJI_DENSITIES: Record<string, string> = {
  minimal: "Use no emoji, or at most one. Let the words carry it.",
  moderate: "Use a few emoji, tastefully, to punctuate key lines.",
  heavy: "Lean into emoji — use them liberally to give the post rhythm and pop.",
};

interface Variation {
  style: VariationStyle;
  emojiDensity: string;
  emojiGuidance: string;
  hashtagCount: number;
  seed: string;
}

/** FNV-1a 32-bit hash → deterministic, well-distributed across small inputs. */
function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** UTC date as YYYY-MM-DD — the variation is stable for a given calendar day. */
function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Deterministically pick a variation for this vehicle+platform+day. The same
 * car gets the same style all day (idempotent re-runs), but a different style
 * the next day it's re-listed.
 */
function pickVariation(vehicle: Vehicle, platform: ContentPlatform): Variation {
  const dateStr = todayString();
  const h = hashString(`${vehicle.externalId}:${platform}:${dateStr}`);

  const style = VARIATION_STYLES[h % VARIATION_STYLES.length];

  const densityKeys = Object.keys(EMOJI_DENSITIES);
  const emojiDensity = densityKeys[(h >>> 3) % densityKeys.length];

  // FB: 3–7 hashtags. Instagram: 8–15.
  const [minTags, maxTags] =
    platform === "INSTAGRAM" ? [8, 15] : [3, 7];
  const hashtagCount = minTags + ((h >>> 6) % (maxTags - minTags + 1));

  return {
    style,
    emojiDensity,
    emojiGuidance: EMOJI_DENSITIES[emojiDensity],
    hashtagCount,
    seed: `${style.key}/${emojiDensity}-emoji/${hashtagCount}-tags/${dateStr}`,
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

// Stable across every call → cached (prefix match). Keep this byte-identical.
const STABLE_SYSTEM = `You write social-media copy for a used-car dealership in Miami — Miami Motor Group.

VOICE: Confident, no-BS, a little funny. You're the buyer's cousin who works in the car business and is hooking them up — direct, warm, street-smart, never corporate. No buzzwords, no canned "Don't miss out!!!", no fake hype. Write like a real Miami person texting a friend about a car.

SPANISH (contentEs): Natural Miami-Cuban Spanish, the way people actually talk in Hialeah and Miami — NOT a translation of the English, and NOT neutral or Spain Spanish. Always "carro," never "coche." Idiomatic phrasing ("te lo dejo en," "móntate en este," "está bárbaro," "qué clase de"). It must read like a Cuban-American salesperson wrote it from scratch, in the same style as the English version.

HONESTY: Use ONLY the vehicle facts provided in the user message. NEVER invent specs, features, history, condition, MPG, engine, packages, warranty, or anything not given. If a fact isn't provided, don't mention it. Only call something a great deal / steal / "won't last" when the price and mileage genuinely support it — otherwise don't.

OUTPUT: Respond with ONLY a single JSON object and nothing else — no markdown code fences, no commentary before or after:
{"contentEn": "<complete english post>", "contentEs": "<complete spanish post>"}
Each field is a finished, ready-to-publish post that already includes its hashtags.`;

function platformRules(platform: ContentPlatform, hashtagCount: number): string {
  if (platform === "INSTAGRAM") {
    return `PLATFORM: Instagram caption.
- 80–150 words per language.
- Sell the feeling and the lifestyle, not just the spec sheet — make them picture owning it.
- Do NOT put the price in the caption (Instagram norm). Point them to DMs instead ("DM for price" / "precio por el DM").
- You may weave in year/make/model/trim, mileage, and color where it serves the vibe.
- End with exactly ${hashtagCount} hashtags: mix broad car tags with niche Miami tags (e.g. #MiamiCars #305 #CarrosEnMiami #Hialeah #MiamiWhips).`;
  }
  return `PLATFORM: Facebook Marketplace listing.
- 150–300 words per language.
- Open with the single strongest hook for THIS specific car (low mileage, rare/desirable trim, strong price, sought-after model) — pick one and lead with it.
- Include all of: year/make/model/trim, the price, the mileage, the color, and a clear call-to-action (DM / message us).
- End with exactly ${hashtagCount} hashtags.`;
}

function dynamicSystem(platform: ContentPlatform, v: Variation): string {
  return `${platformRules(platform, v.hashtagCount)}

STYLE for this post: ${v.style.key} — ${v.style.guidance}
EMOJI: ${v.emojiGuidance}
Vary the sentence structure and rhythm so this never reads like a filled-in template. Write the Spanish as its own native post in this same style — not a translation of the English.`;
}

function buildUserPrompt(vehicle: Vehicle): string {
  const facts = [
    `Year: ${vehicle.year}`,
    `Make: ${vehicle.make}`,
    `Model: ${vehicle.model}`,
    vehicle.trim ? `Trim: ${vehicle.trim}` : null,
    `Price: $${vehicle.price.toLocaleString("en-US")}`,
    `Mileage: ${vehicle.mileage.toLocaleString("en-US")} miles`,
    vehicle.color ? `Color: ${vehicle.color}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return `Verified facts for this vehicle — use only these. Write the posts now.\n\n${facts}`;
}

// ---------------------------------------------------------------------------
// Model call + parsing
// ---------------------------------------------------------------------------

async function requestCopy(
  platform: ContentPlatform,
  variation: Variation,
  userPrompt: string,
): Promise<string> {
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: [
      // Stable prefix — cached across all calls.
      { type: "text", text: STABLE_SYSTEM, cache_control: { type: "ephemeral" } },
      // Volatile — platform + chosen style/emoji/hashtag count.
      { type: "text", text: dynamicSystem(platform, variation) },
    ],
    messages: [{ role: "user", content: userPrompt }],
  });

  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/** Pull a JSON object out of the model's response and validate the two fields. */
function parsePostCopy(raw: string, variationSeed: string): PostCopy {
  let text = raw.trim();

  // Strip a ```json ... ``` fence if the model added one despite instructions.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  // Narrow to the outermost JSON object.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }

  const parsed: unknown = JSON.parse(text);
  if (parsed !== null && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const en = record.contentEn;
    const es = record.contentEs;
    if (
      typeof en === "string" &&
      en.trim().length > 0 &&
      typeof es === "string" &&
      es.trim().length > 0
    ) {
      return { contentEn: en.trim(), contentEs: es.trim(), variationSeed };
    }
  }

  throw new Error("response JSON missing non-empty contentEn/contentEs");
}

/**
 * Generate FB Marketplace / Instagram post copy (EN + ES) for a vehicle.
 * One API call per attempt; on a parse failure it retries once, then throws.
 */
export async function generatePostCopy(
  vehicle: Vehicle,
  platform: ContentPlatform,
): Promise<PostCopy> {
  const variation = pickVariation(vehicle, platform);
  const userPrompt = buildUserPrompt(vehicle);

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await requestCopy(platform, variation, userPrompt);
    try {
      return parsePostCopy(raw, variation.seed);
    } catch (err) {
      lastError = err;
      console.warn(
        `[generator] parse failed for ${vehicle.externalId} (${platform}) attempt ${attempt}/2:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  throw new Error(
    `Failed to generate post copy for ${vehicle.externalId} (${platform}) after retry: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
