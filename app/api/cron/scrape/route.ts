// Nightly inventory scrape trigger.
//
// Protected by CRON_SECRET. Vercel Cron sends the secret as
// `Authorization: Bearer <CRON_SECRET>`; a `?secret=` query param is also
// accepted for manual/local triggering.
import { NextResponse } from "next/server";
import { syncInventory } from "@/lib/inventory/scraper";

// Scraping + detail-page crawling is slow; run dynamically and allow a long
// execution window (Vercel caps this per plan).
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const querySecret = new URL(request.url).searchParams.get("secret");
  const provided = authHeader?.replace(/^Bearer\s+/i, "") ?? querySecret;

  // Fail closed: if no secret is configured, or it doesn't match, reject.
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncInventory();
    return NextResponse.json({
      ok: true,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[cron/scrape] failed:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Unknown error",
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
