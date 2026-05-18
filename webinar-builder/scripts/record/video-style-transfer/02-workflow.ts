/**
 * Compiled for scripts/intent/video-style-transfer/02-workflow.yaml.
 *
 * Walks the four-step video style transfer flow on https://www.astria.ai/prompts.
 *
 * Astria UI surface (verified live, May 2026):
 *   - Mode switcher:        button.mode-switcher-btn (text "Image" / "Video")
 *   - Image prompt input:   .tribute-prompt-input         (contenteditable)
 *   - Video prompt input:   .video-tribute-prompt-input   (contenteditable)
 *   - Driving video upload: input#prompt_input_video      (hidden file input)
 *   - Video model picker:   select[name='prompt[video_model]']
 *                           (TomSelect-enhanced; sibling .ts-wrapper is visible)
 *   - Target model value:   "seedance2_fast_720p"  ("Seedance2 Fast 720p 🚀")
 *
 * Narration anchors (~70s total):
 *    0.0 s  land on /prompts
 *    3.0 s  "First — write a minimal image prompt"
 *   22.0 s  "Next — pick the driving video"
 *   38.0 s  "Third — write a minimal video prompt"
 *   58.0 s  "Finally — select Seedance 2 fast"
 *   70.0 s  end (do NOT click generate)
 *
 * Run headed:
 *   HEADED=1 npx tsx pipeline/record-screencast.ts --project video-style-transfer 02-workflow
 */
import type { RecordScript } from "../../../pipeline/record-screencast.js";
import { resolve } from "node:path";

// UI hostname — ASTRIA_BASE_URL is the API URL (https://api.astria.ai) and
// returns JSON on /prompts. The recorder always drives the browser UI.
const BASE_URL = process.env.ASTRIA_UI_URL ?? "https://www.astria.ai";

const DRIVING_VIDEO_PATH = resolve(
  process.cwd(),
  "assets/results/video-style-transfer/driving-jc.mp4",
);

const IMAGE_PROMPT =
  "lookbook fashion shot, plain white background, full body, soft daylight";

const VIDEO_PROMPT =
  "she is turning around 360, professional lookbook, plain white background #fff, " +
  "looking at the camera, natural relaxed pose, fumbling her eyes, " +
  "micro-expressions and mimics, shot cut every about 2 seconds";

const TARGET_MODEL_VALUE = "seedance2_fast_720p";
const TARGET_MODEL_LABEL_RE = /Seedance2\s*Fast\s*720p/i;

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

/** Click into a contenteditable so subsequent keyboard.type lands there. */
async function focusEditable(
  page: import("playwright").Page,
  selector: string,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const el = page.locator(selector).first();
  const box = await el.boundingBox({ timeout: 800 }).catch(() => null);
  if (!box) return false;
  // Click toward the end of the box so we land in the editable region
  // (left edge sometimes hosts reference chips).
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

  // The page loads in Image mode by default; confirm we're there.
  // (If we landed in Video mode for any reason, click Image once.)
  const inVideoMode = await page
    .locator("button.mode-switcher-btn.active:has-text('Video')")
    .count()
    .catch(() => 0);
  if (inVideoMode > 0) {
    await clickFirst(
      page,
      [`button.mode-switcher-btn:has-text('Image')`],
      sleep,
    );
    await sleep(600);
  }

  // ── Step 1 — Image prompt ─────────────────────────────────────────
  // "First — write a minimal image prompt in the image tab." @3.0 → 22.0
  await sleep(1500);                              // ≈ t=3

  await focusEditable(page, ".tribute-prompt-input", sleep);
  await sleep(400);
  await page.keyboard.type(IMAGE_PROMPT, { delay: 38 }).catch(() => {});
  await sleep(11000);                             // hold — ≈ t=22

  // ── Step 2 — Switch to Video + upload driving video ──────────────
  // "Next — pick the driving video." @22 → 38
  await clickFirst(
    page,
    [
      `button.mode-switcher-btn:has-text('Video')`,
      `.mode-switcher-btn:has-text('Video')`,
    ],
    sleep,
  );
  await sleep(1500);                              // mode switch settles — ≈ t=23.5

  // Astria's video-mode UI surfaces the driving-video upload via
  // input#prompt_input_video. setInputFiles works on the hidden input
  // regardless of which "trigger" button the user normally clicks.
  await page
    .locator("input#prompt_input_video")
    .setInputFiles(DRIVING_VIDEO_PATH, { timeout: 4000 })
    .catch((e) => {
      console.warn(`[record] setInputFiles failed: ${(e as Error).message}`);
    });
  // Glide the cursor over the (now-populated) upload area so the audience
  // sees the activity. The triggerFile button is the visible affordance.
  const triggerBtn = page.locator(
    `[data-action*='image-input#triggerFile']`,
  ).nth(2); // there are several; the video-mode one tends to be later in DOM order
  const tbox = await triggerBtn.boundingBox({ timeout: 500 }).catch(() => null);
  if (tbox) {
    await glide(page, tbox.x + tbox.width / 2, tbox.y + tbox.height / 2, 14);
  }
  await sleep(13000);                             // preview + linger — ≈ t=38

  // ── Step 3 — Write the video prompt ──────────────────────────────
  // "Third — write a minimal video prompt." @38 → 58
  await focusEditable(page, ".video-tribute-prompt-input", sleep);
  await sleep(300);
  // Clear any default content first so the typed text reads cleanly.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await sleep(180);
  await page.keyboard.type(VIDEO_PROMPT, { delay: 22 }).catch(() => {});
  await sleep(8000);                              // hold — ≈ t=58

  // ── Step 4 — Pick Seedance2 Fast 720p ────────────────────────────
  // "Finally — select Seedance 2 fast at 720p or 480p." @58 → 70
  //
  // The model select is TomSelect-enhanced. Approach:
  //   1. Glide the cursor over its visible wrapper (`.ts-wrapper`
  //      adjacent to the hidden <select name='prompt[video_model]'>).
  //   2. Click to open the dropdown (visual reveal for the audience).
  //   3. Click the "Seedance2 Fast 720p" option from the rendered list.
  //   4. As a safety net, set the underlying <select> value and
  //      dispatch a change event so the form state lands correctly even
  //      if the visual click missed.
  const wrapperBox = await page
    .evaluate(() => {
      const hidden = document.querySelector<HTMLSelectElement>(
        "select[name='prompt[video_model]']",
      );
      if (!hidden) return null;
      // TomSelect places its visible control in a sibling/parent wrapper.
      const wrapper =
        hidden.closest(".ts-wrapper") ??
        hidden.parentElement?.querySelector(".ts-wrapper, .ts-control") ??
        hidden.nextElementSibling;
      const el = (wrapper as HTMLElement) ?? null;
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })
    .catch(() => null);

  if (wrapperBox) {
    await glide(
      page,
      wrapperBox.x + wrapperBox.w / 2,
      wrapperBox.y + wrapperBox.h / 2,
      14,
    );
    await sleep(300);
    await page.mouse.click(
      wrapperBox.x + wrapperBox.w / 2,
      wrapperBox.y + wrapperBox.h / 2,
    ).catch(() => {});
    await sleep(700);                             // dropdown opens — ≈ t=59
  }

  // Try visual click on the option.
  await clickFirst(
    page,
    [
      `.ts-dropdown [role='option']:has-text('Seedance2 Fast 720p')`,
      `.ts-dropdown .option:has-text('Seedance2 Fast 720p')`,
      `.option:has-text('Seedance2 Fast 720p')`,
      `text=/Seedance2\\s*Fast\\s*720p/i`,
    ],
    sleep,
    600,
  );
  await sleep(800);                               // selection — ≈ t=60.5

  // Belt-and-suspenders — set the value programmatically and dispatch
  // change, in case the visual click landed on a label vs. the option.
  await page
    .evaluate(
      ({ value }: { value: string }) => {
        const hidden = document.querySelector<HTMLSelectElement>(
          "select[name='prompt[video_model]']",
        );
        if (!hidden) return;
        hidden.value = value;
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
        // Sync the TomSelect instance if it exists on the element.
        const ts = (hidden as any).tomselect;
        if (ts && typeof ts.setValue === "function") {
          ts.setValue(value, /*silent=*/ false);
        }
      },
      { value: TARGET_MODEL_VALUE },
    )
    .catch(() => {});

  // Settle on the final state so the narration's last beat plays over
  // a calm UI. DO NOT click Generate — recording ends here.
  await sleep(8500);                              // ≈ t=70 — end
};

export default script;

// Keep a runtime reference so the regex isn't flagged as unused by some
// TS configs; the value is also a convenient log marker.
void TARGET_MODEL_LABEL_RE;
