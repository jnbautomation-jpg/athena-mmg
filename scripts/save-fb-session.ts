// One-time script to capture a Facebook login session for Playwright.
//
// Run headed:  npm run save-fb-session   (or: npx tsx scripts/save-fb-session.ts)
// Log in manually in the browser window when prompted, press Enter, and the
// browser storage state (cookies + localStorage) is written to
// FB_SESSION_COOKIES_PATH so the publisher can reuse the session headlessly.
import { config } from "dotenv";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

config({ path: ".env.local" });

const SESSION_PATH = process.env.FB_SESSION_COOKIES_PATH ?? "./fb-session.json";
const FACEBOOK_URL = "https://www.facebook.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Resolve once the user presses Enter in the terminal. */
function waitForEnter(promptText: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Logged-out Facebook shows the email/password login form. If that form isn't
 * present we treat the session as logged in.
 */
async function isLoggedIn(page: Page): Promise<boolean> {
  const loginField = page.locator('input[name="email"]');
  try {
    await loginField.waitFor({ state: "visible", timeout: 8000 });
    return false; // login form visible → not logged in
  } catch {
    return true; // no login form → logged in
  }
}

async function main(): Promise<void> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: null, // use the real window size in headed mode
      locale: "en-US",
    });
    const page = await context.newPage();

    console.log(`Opening ${FACEBOOK_URL} ...`);
    await page.goto(FACEBOOK_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    if (await isLoggedIn(page)) {
      console.log("Already logged in — saving session...");
    } else {
      console.log("\n──────────────────────────────────────────────");
      console.log("  Not logged in.");
      console.log("  1. Log into Facebook in the browser window that just opened.");
      console.log("  2. Complete any 2FA / checkpoints until you see your home feed.");
      console.log("  3. Come back here and press Enter to save the session.");
      console.log("──────────────────────────────────────────────\n");
      await waitForEnter("Press Enter once you're logged in and see your feed... ");

      if (!(await isLoggedIn(page))) {
        console.warn(
          "Warning: still detecting a login form — saving anyway, but the session may be incomplete.",
        );
      }
    }

    // Make sure the target directory exists, then persist cookies + localStorage.
    mkdirSync(dirname(SESSION_PATH), { recursive: true });
    await context.storageState({ path: SESSION_PATH });

    console.log(`Session saved to ${SESSION_PATH}`);
  } finally {
    if (browser) await browser.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("save-fb-session failed:", err);
    process.exit(1);
  });
