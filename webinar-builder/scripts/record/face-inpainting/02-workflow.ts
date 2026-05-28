/**
 * Compiled for script/segments/face-inpainting/02-workflow.yaml.
 *
 * Walks the Astria "Inpaint faces" workflow inside the prompts UI for
 * workspace ws=6. The recording shows the toggle being flipped on, the
 * generation being sent, and the result card's "1 / 2" version switch
 * being toggled so the inpainted final and the raw original sit side by
 * side under the same pose.
 *
 * Astria UI surface (educated guesses — verify on first headed run and refine):
 *   - Prompt textarea:      textarea[name='prompt'], [contenteditable='true'][data-role='prompt-input']
 *   - Inpaint-faces toggle: button:has-text('Inpaint faces'), [data-toggle='inpaint-faces']
 *   - Send button:          button[aria-label='Send'], button:has-text('Generate'), button[type='submit']
 *   - Result version 1 btn: button:has-text('1'):near(:text('Final')), [data-version='1']
 *   - Result version 2 btn: button:has-text('2'):near(:text('Original')), [data-version='2']
 *
 * Narration anchors (~55s total):
 *    0.0 s  land on /prompts?ws=6
 *    6.0 s  "Write the prompt the way you normally would"
 *   18.0 s  "Pin your faces and outfit references into the chip row"
 *   22.0 s  "Right by the model selector, the Inpaint faces toggle"
 *   32.0 s  "Hit send"
 *   42.0 s  "Version one is the inpainted final; version two is the raw original"
 *   55.0 s  end
 *
 * Auth: the prompts page is gated behind Astria's login. Set
 *   ASTRIA_STORAGE_STATE=/abs/path/to/storage.json
 * in the .env so Playwright reuses a logged-in cookie jar. If the jar is
 * missing or expired, the recorder will land on the marketing site and the
 * downstream beats will no-op — the draft pipeline runs with NO_SCREENCAST=1
 * anyway, so the visual placeholder is fine until storage is wired up.
 *
 * Run headed for the first capture so you can see what's happening:
 *   HEADED=1 npx tsx pipeline/record-screencast.ts --project face-inpainting 02-workflow
 */
import type { RecordScript } from "../../../pipeline/record-screencast.js";

const BASE_URL = process.env.ASTRIA_UI_URL ?? "https://www.astria.ai";

async function glide(page: import("playwright").Page, x: number, y: number, steps = 18) {
  await page.mouse.move(x, y, { steps });
}

async function hoverFirst(
  page: import("playwright").Page,
  candidates: string[],
  sleep: (ms: number) => Promise<void>,
  perTimeoutMs = 800,
): Promise<boolean> {
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    const box = await el.boundingBox({ timeout: perTimeoutMs }).catch(() => null);
    if (!box) continue;
    await glide(page, box.x + box.width / 2, box.y + box.height / 2, 16);
    await sleep(150);
    return true;
  }
  return false;
}

async function clickFirst(
  page: import("playwright").Page,
  candidates: string[],
  perTimeoutMs = 1500,
): Promise<boolean> {
  for (const sel of candidates) {
    try {
      await page.locator(sel).first().click({ timeout: perTimeoutMs });
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

const script: RecordScript = async ({ page, sleep }) => {
  // ── Beat 1 — Land on the prompts page ────────────────────────────
  // "Open the prompts page for your workspace." @0 → 6
  await page.goto(`${BASE_URL}/prompts?ws=6`, { waitUntil: "domcontentloaded" });
  await sleep(3200);                              // page settles — ≈ t=3
  await glide(page, 960, 540, 12);                // park cursor mid-canvas
  await sleep(2800);                              // ≈ t=6

  // ── Beat 2 — Hover the prompt textarea ──────────────────────────
  // "Write your prompt the way you normally would." @6 → 18
  await hoverFirst(
    page,
    [
      `textarea[name='prompt']`,
      `[contenteditable='true'][data-role='prompt-input']`,
      `[data-component='prompt-input']`,
      `textarea`,
    ],
    sleep,
  );
  await sleep(11500);                             // hold while narration plays — ≈ t=17.5

  // ── Beat 3 — Hover the reference chips row ──────────────────────
  // "Pin your faces and outfit references into the chip row." @18 → 22
  await hoverFirst(
    page,
    [
      `[data-role='reference-chips']`,
      `.chip-row`,
      `[class*='references']`,
      `img[alt*='reference']`,
    ],
    sleep,
  );
  await sleep(3500);                              // ≈ t=21.5

  // ── Beat 4 — Toggle "Inpaint faces" on ──────────────────────────
  // "Right by the model selector, the Inpaint faces toggle." @22 → 32
  const toggleHovered = await hoverFirst(
    page,
    [
      `button:has-text('Inpaint faces')`,
      `[data-toggle='inpaint-faces']`,
      `[aria-label='Inpaint faces']`,
      `label:has-text('Inpaint faces')`,
    ],
    sleep,
    1500,
  );
  await sleep(1200);                              // dwell on the toggle
  if (toggleHovered) {
    await clickFirst(page, [
      `button:has-text('Inpaint faces')`,
      `[data-toggle='inpaint-faces']`,
      `[aria-label='Inpaint faces']`,
    ]).catch(() => {});
  }
  await sleep(8500);                              // ≈ t=32

  // ── Beat 5 — Hit send and wait for the result card ──────────────
  // "Hit send." @32 → 42
  await clickFirst(page, [
    `button[aria-label='Send']`,
    `button:has-text('Send')`,
    `button:has-text('Generate')`,
    `button[type='submit']`,
  ]).catch(() => {});
  await sleep(10000);                             // queue + render placeholder — ≈ t=42

  // ── Beat 6 — Toggle between version 1 (Final) and 2 (Original) ──
  // "Version one is the inpainted final, version two is the raw." @42 → 55
  await hoverFirst(
    page,
    [
      `[data-version='1']`,
      `button:has-text('1')`,
      `button:has-text('Final')`,
    ],
    sleep,
    1200,
  );
  await sleep(3500);                              // dwell on Final
  await hoverFirst(
    page,
    [
      `[data-version='2']`,
      `button:has-text('2')`,
      `button:has-text('Original')`,
    ],
    sleep,
    1200,
  );
  await sleep(3500);                              // dwell on Original
  // One more swap so the delta is unmistakable.
  await clickFirst(page, [
    `[data-version='1']`,
    `button:has-text('1')`,
  ]).catch(() => {});
  await sleep(6000);                              // ≈ t=55 — end
};

export default script;
