/**
 * Astria Edit workflow: clean up an iPhone packshot snapshot.
 *
 * Same surface as 02-strip-shoes — drop input image, type a minimal prompt,
 * click Generate. The teaching beat is that the bag-packshot pack from the
 * 3D Packshots video (Astria pack #4566) can be distilled to one sentence
 * when run through Edit.
 *
 * Narration anchors (~52s total):
 *    0.0 s  land on /prompts
 *    2.0 s  "Same tool, different job — here's a phone snapshot of a bag"
 *    8.0 s  "Now we want a clean studio packshot..."
 *   34.0 s  "Hit generate"
 *   40.0 s  "Production-ready in one shot"
 *   52.0 s  end
 *
 * Run headed:
 *   HEADED=1 npx tsx pipeline/record-screencast.ts --project edit-image 03-packshot-cleanup
 */
import type { RecordScript } from "../../../pipeline/record-screencast.js";
import { resolve } from "node:path";

// UI hostname — ASTRIA_BASE_URL is the API URL (https://api.astria.ai) and
// returns JSON on /prompts. The recorder always drives the browser UI.
const BASE_URL = process.env.ASTRIA_UI_URL ?? "https://www.astria.ai";

const INPUT_IMAGE_PATH = resolve(
  process.cwd(),
  "assets/results/3d-packshots/ref-bag-burgundy-ugly.jpg",
);

// Distilled from Astria pack #4566 prompt id 40149291. Original is ~200
// lines; minimal version below is 94 chars — same intent, one sentence.
const EDIT_PROMPT =
  "clean studio packshot of this handbag, plain #F2F2F2 background, flat lighting, no shadows.";

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
  await sleep(1500);

  const inVideoMode = await page
    .locator("button.mode-switcher-btn.active:has-text('Video')")
    .count()
    .catch(() => 0);
  if (inVideoMode > 0) {
    await clickFirst(page, ["button.mode-switcher-btn:has-text('Image')"], sleep);
    await sleep(600);
  }

  // Wipe any auto-restored draft state from a previous session.
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>(".tribute-prompt-input").forEach((el) => {
      el.innerHTML = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const removeButtons = document.querySelectorAll<HTMLElement>(
      ".reference-chip-remove, [data-action*='remove'], .chip [aria-label*='Remove' i], button[title*='Remove' i]",
    );
    removeButtons.forEach((b) => b.click());
    document.querySelectorAll<HTMLInputElement>("input[type='file']").forEach((el) => {
      el.value = "";
    });
  }).catch(() => {});
  await sleep(400);

  // ── Step 1 — Upload the ugly bag jpg ───────────────────────────────
  await sleep(700);                                // ≈ t=2.2

  await page
    .locator("input#prompt_input_image")
    .setInputFiles(INPUT_IMAGE_PATH, { timeout: 4000 })
    .catch((e) => {
      console.warn(`[record] setInputFiles failed: ${(e as Error).message}`);
    });

  const triggerBtn = page.locator("[data-action*='image-input#triggerFile']").first();
  const tbox = await triggerBtn.boundingBox({ timeout: 500 }).catch(() => null);
  if (tbox) {
    await glide(page, tbox.x + tbox.width / 2, tbox.y + tbox.height / 2, 14);
  }
  await sleep(5500);                               // ≈ t=8.4

  // ── Step 2 — Type the minimal cleanup prompt ───────────────────────
  await focusEditable(page, ".tribute-prompt-input", sleep);
  await sleep(300);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await sleep(200);
  // Slightly slower typing (delay 130ms) so the audience can read each phrase.
  // 94 chars * 130ms ≈ 12.2s; lands ≈ t=22.
  await page.keyboard.type(EDIT_PROMPT, { delay: 130 }).catch(() => {});
  await sleep(11500);                              // hold typed prompt — ≈ t=34

  // ── Step 3 — Click Generate ────────────────────────────────────────
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
    await glide(page, 1336, 257, 14);
    await sleep(180);
    await page.mouse.click(1336, 257).catch(() => {});
  }
  await sleep(6500);                               // ≈ t=40

  // ── Step 4 — Linger ────────────────────────────────────────────────
  const resultArea = page.locator(".prompt-images, .prompt-results, .images-grid").first();
  const rbox = await resultArea.boundingBox({ timeout: 600 }).catch(() => null);
  if (rbox) {
    await glide(page, rbox.x + rbox.width / 2, rbox.y + 80, 14);
  }
  await sleep(12000);                              // ≈ t=52 — end
};

export default script;
