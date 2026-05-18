/**
 * Astria Edit workflow: strip the shoes from an editorial portrait.
 *
 * Walks the surface at https://www.astria.ai/prompts in Image mode:
 *   1. Upload an input image (feet in heels, editorial)
 *   2. Type a minimal prompt — "remove the shoes, keep her barefoot..."
 *   3. Click Generate (we don't wait for the result; the showcase still
 *      pre-delivers the "after" payoff).
 *
 * Astria selectors (verified live May 2026 via VST recorder):
 *   - Image prompt input:   .tribute-prompt-input          (contenteditable)
 *   - Input-image upload:   input#prompt_input_image       (hidden file input)
 *   - Mode switcher:        button.mode-switcher-btn       (Image / Video)
 *   - Generate button:      input[type='submit'][name='commit'] (Rails form submit)
 *
 * Narration anchors (~50s total):
 *    0.0 s  land on /prompts
 *    2.0 s  "Drop an image into Astria"
 *    8.0 s  "Type one sentence"
 *   24.0 s  "Hit generate"
 *   34.0 s  "Same pose, same dress, same chair — shoes gone"
 *   50.0 s  end
 *
 * Run headed (no audio narration overlay):
 *   HEADED=1 npx tsx pipeline/record-screencast.ts --project edit-image 02-strip-shoes
 */
import type { RecordScript } from "../../../pipeline/record-screencast.js";
import { resolve } from "node:path";

// UI hostname — ASTRIA_BASE_URL is the API URL (https://api.astria.ai) and
// returns JSON on /prompts. The recorder always drives the browser UI.
const BASE_URL = process.env.ASTRIA_UI_URL ?? "https://www.astria.ai";

const INPUT_IMAGE_PATH = resolve(
  process.cwd(),
  "assets/inputs/edit-image/feet-heels-source.jpg",
);

const EDIT_PROMPT =
  "remove the shoes, keep her barefoot. preserve everything else exactly.";

async function glide(page: import("playwright").Page, x: number, y: number, steps = 18) {
  await page.mouse.move(x, y, { steps });
}

async function clickFirst(
  page: import("playwright").Page,
  candidates: string[],
  sleep: (ms: number) => Promise<void>,
  perTimeoutMs = 500,
): Promise<boolean> {
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    const box = await el.boundingBox({ timeout: perTimeoutMs }).catch(() => null);
    if (!box) continue;
    await glide(page, box.x + box.width / 2, box.y + box.height / 2, 14);
    await sleep(180);
    await el.click({ timeout: 600 }).catch(() => {});
    return true;
  }
  return false;
}

async function focusEditable(
  page: import("playwright").Page,
  selector: string,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const el = page.locator(selector).first();
  const box = await el.boundingBox({ timeout: 800 }).catch(() => null);
  if (!box) return false;
  const tx = box.x + Math.min(box.width - 24, box.width * 0.6);
  const ty = box.y + box.height / 2;
  await glide(page, tx, ty, 14);
  await sleep(150);
  await el.click({
    timeout: 500,
    position: { x: Math.min(box.width - 24, box.width * 0.6), y: box.height / 2 },
  }).catch(() => {});
  await page.keyboard.press("End").catch(() => {});
  return true;
}

const script: RecordScript = async ({ page, sleep }) => {
  await page.goto(`${BASE_URL}/prompts`, { waitUntil: "domcontentloaded" });
  await sleep(1500);                              // settle — ≈ t=1.5

  // Ensure we're in Image mode (page default, but be defensive).
  const inVideoMode = await page
    .locator("button.mode-switcher-btn.active:has-text('Video')")
    .count()
    .catch(() => 0);
  if (inVideoMode > 0) {
    await clickFirst(page, ["button.mode-switcher-btn:has-text('Image')"], sleep);
    await sleep(600);
  }

  // Astria auto-restores the most recent draft (prompt text + attached
  // reference image). Wipe both before we start recording, otherwise the
  // capture shows leftover state from a previous run.
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>(".tribute-prompt-input").forEach((el) => {
      el.innerHTML = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Reference chips show an inline "x" remove button. Try several
    // common selectors used by Astria for the removal affordance.
    const removeButtons = document.querySelectorAll<HTMLElement>(
      ".reference-chip-remove, [data-action*='remove'], .chip [aria-label*='Remove' i], button[title*='Remove' i]",
    );
    removeButtons.forEach((b) => b.click());
    // Reset any hidden file inputs holding stale uploads.
    document.querySelectorAll<HTMLInputElement>("input[type='file']").forEach((el) => {
      el.value = "";
    });
  }).catch(() => {});
  await sleep(400);

  // ── Step 1 — Upload the input image ────────────────────────────────
  // "Drop an image into Astria — here, a fashion shot, woman on a pink chair, black heels."
  // ≈ t=2 → 8
  await sleep(700);                                // ≈ t=2.2

  await page
    .locator("input#prompt_input_image")
    .setInputFiles(INPUT_IMAGE_PATH, { timeout: 4000 })
    .catch((e) => {
      console.warn(`[record] setInputFiles failed: ${(e as Error).message}`);
    });

  // Hover over the upload affordance so the audience sees activity.
  const triggerBtn = page.locator("[data-action*='image-input#triggerFile']").first();
  const tbox = await triggerBtn.boundingBox({ timeout: 500 }).catch(() => null);
  if (tbox) {
    await glide(page, tbox.x + tbox.width / 2, tbox.y + tbox.height / 2, 14);
  }
  await sleep(5500);                               // preview loads — ≈ t=8.4

  // ── Step 2 — Type the edit prompt ──────────────────────────────────
  // "Type one sentence: remove the shoes, keep her barefoot." ≈ t=8 → 24
  await focusEditable(page, ".tribute-prompt-input", sleep);
  await sleep(300);
  // Clear any default prompt so the typed text reads cleanly.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await sleep(200);
  await page.keyboard.type(EDIT_PROMPT, { delay: 110 }).catch(() => {});
  // EDIT_PROMPT is 70 chars; 70 * 110ms ≈ 7.7s of typing. Plus prior sleeps
  // we land around t=18. Hold the typed prompt visible for narration.
  await sleep(5500);                               // ≈ t=24

  // ── Step 3 — Click Generate ────────────────────────────────────────
  // "Hit generate." ≈ t=24 → 32
  // The Generate button is the round blue button at the bottom-right of the
  // prompt form (sibling of the prompt textarea, around (1336, 257) at our
  // 1600×900 viewport). Try semantic selectors first, then fall back to a
  // coordinate click on the blue submit pill.
  const clicked = await clickFirst(
    page,
    [
      "form button[type='submit']",
      "form input[type='submit']",
      "[data-action*='submit'][type='submit']",
      "button.btn-primary[type='submit']",
      "[aria-label*='Generate' i]",
      "[title*='Generate' i]",
    ],
    sleep,
  );
  if (!clicked) {
    // Coordinate fallback — the blue circle submit is reliably here.
    await glide(page, 1336, 257, 14);
    await sleep(180);
    await page.mouse.click(1336, 257).catch(() => {});
  }
  await sleep(8000);                               // result tile starts loading — ≈ t=32

  // ── Step 4 — Linger on the result area ─────────────────────────────
  // Don't wait for completion (async, multi-minute). Just hover near the
  // result column so the audience sees Astria thinking.
  // ≈ t=32 → 50
  const resultArea = page.locator(".prompt-images, .prompt-results, .images-grid").first();
  const rbox = await resultArea.boundingBox({ timeout: 600 }).catch(() => null);
  if (rbox) {
    await glide(page, rbox.x + rbox.width / 2, rbox.y + 80, 14);
  }
  await sleep(18000);                              // ≈ t=50 — end
};

export default script;
