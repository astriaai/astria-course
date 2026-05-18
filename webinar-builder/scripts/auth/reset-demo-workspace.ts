// Reset demo workspace 159 to baseline for re-recording.
import { chromium } from "playwright";

const ROOT = "/Users/burg/git/astria-course/webinar-builder";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    storageState: `${ROOT}/storageState.json`,
  });
  const page = await ctx.newPage();
  await page.goto("https://www.astria.ai/workspaces/159/edit?ws=159", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.fill("#workspace_brief", "Maison Lume — a quiet-luxury atelier.");
  await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>("#workspace_public");
    if (el && el.checked) { el.checked = false; el.dispatchEvent(new Event("change", { bubbles: true })); }
  });
  await page.click('input[type="submit"][value="Save"]');
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1200);
  await browser.close();
  console.log("reset done");
}

main().catch((e) => { console.error(e); process.exit(1); });
