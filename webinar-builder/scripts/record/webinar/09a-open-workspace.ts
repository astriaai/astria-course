/**
 * Compiled for scripts/intent/09a-open-workspace.yaml.
 *
 * Trim of the original 09a brand-research segment to JUST the workspace
 * creation step. Brand research (bobochoses tour) is now 09b-brand-research,
 * which uses static screenshots — Cloudflare bot detection makes the live
 * site unreliable in headless Chromium.
 *
 * Narration anchors (≈12 s):
 *    0.00 s  "Let's start by opening a new workspace"
 *    3.0 s   "Click the Workspace selector next to the logo"
 *    5.5 s   "pick New workspace"
 *    8.0 s   "name it after the brand you're working with"
 *   10.0 s   "I'll name mine Bobo Choses"
 *   12.0 s   end
 *
 * The workspace selector / New Workspace flow has no precedent in any
 * existing record script. Selectors are best-effort; if any miss, the
 * script still navigates and lingers on /prompts so the audience hears
 * the narration with the right surface visible.
 *
 * Run headed: `HEADED=1 npx tsx pipeline/record-screencast.ts 09a-open-workspace`
 */
import type { RecordScript } from "../../../pipeline/record-screencast.js";

const BASE_URL = process.env.ASTRIA_BASE_URL ?? "https://www.astria.ai";

async function glide(page: import("playwright").Page, x: number, y: number, steps = 16) {
  await page.mouse.move(x, y, { steps });
}

const script: RecordScript = async ({ page, sleep }) => {
  await page.goto(`${BASE_URL}/prompts`, { waitUntil: "domcontentloaded" });
  await sleep(1000);

  // "Click the Workspace selector next to the logo" @3.0
  const selector = page.locator(
    `[data-controller*='workspace'] button, .workspace-selector, ` +
    `header [data-action*='workspace'], header button:has-text('Workspace'), ` +
    `nav button:has-text('Workspace'), [aria-label*='workspace' i]`
  ).first();
  const sbox = await selector.boundingBox({ timeout: 600 }).catch(() => null);
  if (sbox) {
    await glide(page, sbox.x + sbox.width / 2, sbox.y + sbox.height / 2, 14);
    await sleep(1500);                                // ≈ t=3.5 — open dropdown
    await selector.click({ timeout: 600 }).catch(() => {});
    await sleep(900);                                 // ≈ t=4.5

    // "pick New Workspace" @5.5
    const newBtn = page.locator(
      `text=/New\\s+workspace/i, [data-action*='new'], a:has-text('New')`
    ).first();
    const nbox = await newBtn.boundingBox({ timeout: 500 }).catch(() => null);
    if (nbox) {
      await glide(page, nbox.x + nbox.width / 2, nbox.y + nbox.height / 2, 12);
      await sleep(800);                               // ≈ t=6.5 — hover
      await newBtn.click({ timeout: 600 }).catch(() => {});
      await sleep(800);                               // ≈ t=7.3 — modal opens

      // "name it after the brand … I'll name mine Bobo Choses" @8.0
      const nameInput = page.locator(
        `input[name*='name'], input[type='text'], input[placeholder*='name' i]`
      ).first();
      const ibox = await nameInput.boundingBox({ timeout: 500 }).catch(() => null);
      if (ibox) {
        await glide(page, ibox.x + ibox.width / 2, ibox.y + ibox.height / 2, 12);
        await nameInput.click({ timeout: 400 }).catch(() => {});
        await page.keyboard.type("Bobo Choses", { delay: 80 }).catch(() => {});
      }
    }
  }

  // Hold to end of narration (~t=12).
  await sleep(2500);
};

export default script;
