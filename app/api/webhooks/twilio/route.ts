// SMS approval webhook (Twilio).
//
// Twilio POSTs inbound SMS replies here (application/x-www-form-urlencoded).
// We verify the X-Twilio-Signature, apply the approval decision, and reply with
// TwiML so Twilio texts a confirmation back to the sender.
//
// Signature note: Twilio signs the exact public URL it called. Behind a proxy
// (Vercel), request.url may not match — set TWILIO_WEBHOOK_URL to the public
// webhook URL if validation fails. For local testing without a real signature,
// set TWILIO_VALIDATE_WEBHOOK=false (do NOT do this in production).
import { NextResponse } from "next/server";
import twilio from "twilio";
import { applyApprovalReply } from "@/lib/approval/sms";

export const dynamic = "force-dynamic";

function twimlMessage(message: string): string {
  const response = new twilio.twiml.MessagingResponse();
  response.message(message);
  return response.toString();
}

function twimlResponse(message: string): NextResponse {
  return new NextResponse(twimlMessage(message), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return NextResponse.json({ error: "Twilio not configured" }, { status: 500 });
  }

  // Parse the form-encoded Twilio payload into a plain params object.
  const form = await request.formData();
  const params: Record<string, string> = {};
  form.forEach((value, key) => {
    params[key] = typeof value === "string" ? value : "";
  });

  // Verify the request actually came from Twilio (unless explicitly disabled).
  const validate = process.env.TWILIO_VALIDATE_WEBHOOK !== "false";
  if (validate) {
    const signature = request.headers.get("x-twilio-signature");
    const url = process.env.TWILIO_WEBHOOK_URL ?? request.url;
    if (!signature || !twilio.validateRequest(authToken, signature, url, params)) {
      return new NextResponse("Invalid Twilio signature", { status: 403 });
    }
  }

  const body = params.Body ?? "";

  try {
    const result = await applyApprovalReply(body);
    return twimlResponse(result.message);
  } catch (err) {
    console.error("[webhooks/twilio] failed:", err);
    return twimlResponse(
      "Athena hit an error processing that. Please try again in a moment.",
    );
  }
}
