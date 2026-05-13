/**
 * Compiled for scripts/intent/09d-build-look.yaml.
 *
 * Cube-by-cube tour of the Lookbook builder. Paced to the Aoede TTS
 * narration (≈75.5 s) — the longer pacing leaves room for cursorTour
 * sweeps over picker options before each selection so the audience can
 * see the interface.
 *
 * Narration anchors:
 *    0.37 s  "Let's click the Lookbook button"
 *    6.21 s  "Background"
 *   14.81 s  "Pose"
 *   21.30 s  "back view, front pose, full body, 45 angle, back medium"
 *   31.21 s  "Face"
 *   42.04 s  "I'll search for 'boy'"
 *   44.81 s  "Felix"
 *   47.65 s  "Top"     (paste-from-clipboard demo)
 *   62.33 s  "Bottom"
 *   66.37 s  "Footwear"
 *   70.36 s  "I'll search for 'flip'"
 *   75.53 s  end
 *
 * Strategy:
 *   - Click each cube to open its picker modal, then click the closest
 *     match for the narrated reference (white background, 45° pose,
 *     Felix face, flip-flops). Selection auto-closes most modals; we
 *     press Escape to be safe.
 *   - Top / Bottom: click the prompt box and paste from clipboard. The
 *     clipboard contains a brand packshot URL written via the JS API.
 *   - Every selector falls fast (≤500 ms with .catch(() => null)). A
 *     missed picker click still leaves the audience seeing the cube
 *     hover + bullet, which carries the meaning.
 *
 * Run headed: `HEADED=1 npx tsx pipeline/record-screencast.ts 09d-build-look`
 */
import type { RecordScript } from "../../../pipeline/record-screencast.js";

const BASE_URL = process.env.ASTRIA_BASE_URL ?? "https://www.astria.ai";

const TOP_PACKSHOT = "https://bobochoses.com/cdn/shop/files/B126AC009_11.webp";
const BOTTOM_PACKSHOT = "https://bobochoses.com/cdn/shop/files/B126AC058_1.webp";

async function glide(page: import("playwright").Page, x: number, y: number, steps = 20) {
  await page.mouse.move(x, y, { steps });
}

function cubeLocator(
  page: import("playwright").Page,
  name: string,
  label: string
) {
  return page
    .locator(
      `.cube-cell[data-lookbook-names-param="${name}"], ` +
      `[data-lookbook-names-param="${name}"], ` +
      `div[role="button"]:has(> :text-is("${label}")), ` +
      `div:has(> h3:text-is("${label}")), ` +
      `div:has(> * > :text-is("${label}"))`
    )
    .first();
}

/**
 * Glide to the cube and click it. By default clicks the center; pass
 * `{ at: "top" }` to click the upper area instead — needed for the Pose
 * cube whose center holds the "Add front, back, side" link (action:
 * `lookbook#addFrontBackSidePoseReferences`, the quick-add we want to
 * AVOID). Clicking the cube background triggers `lookbook#selectCube`
 * which opens the picker modal.
 */
async function clickCube(
  page: import("playwright").Page,
  name: string,
  label: string,
  sleep: (ms: number) => Promise<void>,
  opts: { at?: "center" | "top" } = {}
) {
  const cube = cubeLocator(page, name, label);
  const box = await cube.boundingBox({ timeout: 600 }).catch(() => null);
  if (!box) return false;
  const yFrac = opts.at === "top" ? 0.15 : 0.5;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height * yFrac;
  await glide(page, cx, cy, 16);
  await sleep(200);
  await cube.click({
    timeout: 800,
    position: { x: box.width / 2, y: box.height * yFrac },
  }).catch(() => {});
  return true;
}

/**
 * Click the first locator in `candidates` that resolves to a visible
 * element. Each candidate gets a short timeout so missed selectors
 * don't blow the narration budget.
 */
async function clickFirst(
  page: import("playwright").Page,
  candidates: string[],
  sleep: (ms: number) => Promise<void>,
  perTimeoutMs = 400
) {
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    const box = await el.boundingBox({ timeout: perTimeoutMs }).catch(() => null);
    if (!box) continue;
    await glide(page, box.x + box.width / 2, box.y + box.height / 2, 14);
    await sleep(150);
    await el.click({ timeout: 500 }).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Glide the cursor over each selector in turn, holding briefly on each.
 * Used to "browse" picker options on camera before selecting one — the
 * audience sees the cursor explore the list, building the mental model
 * that this is a real picker with multiple choices.
 *
 * Selectors that don't resolve are skipped quickly (300 ms timeout each).
 */
async function cursorTour(
  page: import("playwright").Page,
  selectors: string[],
  sleep: (ms: number) => Promise<void>,
  holdMs = 600
) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    const box = await el.boundingBox({ timeout: 300 }).catch(() => null);
    if (!box) continue;
    await glide(page, box.x + box.width / 2, box.y + box.height / 2, 14);
    await sleep(holdMs);
  }
}

/** Press Escape to close any open modal/picker. */
async function closeModal(page: import("playwright").Page, sleep: (ms: number) => Promise<void>) {
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(200);
}

/**
 * Programmatically copy an image URL to the clipboard, focus the prompt
 * box, and dispatch Cmd+V. The Astria prompt input uploads the image
 * automatically when it sees a URL on the clipboard.
 */
/**
 * Count how many reference chips currently sit in the prompt input.
 * Astria renders one chip per uploaded reference; the count is a
 * reliable proxy for "upload finished".
 */
async function chipCount(page: import("playwright").Page): Promise<number> {
  return page.evaluate(() => {
    return document.querySelectorAll(
      ".prompt-chip, [class*='reference-chip'], [class*='ref-chip'], [class*='token'][class*='reference'], .tribute-mention"
    ).length;
  }).catch(() => 0);
}

async function pasteImageToPrompt(
  page: import("playwright").Page,
  imageUrl: string,
  sleep: (ms: number) => Promise<void>,
  options: { waitForChipsAtLeast?: number; uploadTimeoutMs?: number } = {}
) {
  const { waitForChipsAtLeast = 0, uploadTimeoutMs = 4000 } = options;

  const promptBox = page.locator(
    `.tribute-prompt-input, textarea[name*='prompt'], [contenteditable='true']`
  ).first();
  const box = await promptBox.boundingBox({ timeout: 500 }).catch(() => null);
  if (!box) return;

  // Click far-right of the prompt box. The left side fills with reference
  // chips that have × close buttons — clicking center can delete an
  // existing reference. The right edge always lands in the editable area.
  const targetX = box.x + box.width - 30;
  const targetY = box.y + box.height / 2;
  await glide(page, targetX, targetY, 12);
  await promptBox.click({
    timeout: 500,
    position: { x: box.width - 30, y: box.height / 2 },
  }).catch(() => {});
  await page.keyboard.press("End").catch(() => {});
  await sleep(150);

  await page.evaluate(async (url: string) => {
    try { await navigator.clipboard.writeText(url); } catch { /* noop */ }
  }, imageUrl).catch(() => {});

  await sleep(120);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V").catch(() => {});
  await sleep(400);

  // Wait until the upload completes (chip count rises) before returning.
  // This protects the next paste from racing against an in-flight upload —
  // when Cmd+V fires while the previous paste is still uploading, the
  // first one silently drops.
  if (waitForChipsAtLeast > 0) {
    const deadline = Date.now() + uploadTimeoutMs;
    while (Date.now() < deadline) {
      const n = await chipCount(page);
      if (n >= waitForChipsAtLeast) return;
      await sleep(200);
    }
  }
}

const script: RecordScript = async ({ page, sleep }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});

  // ── Land + open the Lookbook helper ─────────────────────────────────
  await page.goto(`${BASE_URL}/prompts`, { waitUntil: "domcontentloaded" });
  await sleep(900);

  // "Let's click the Lookbook button" @0.37
  const toggle = page.locator(
    `.lookbook-toggle, button:has-text("Lookbook"), [role="tab"]:has-text("Lookbook")`
  ).first();
  const tbox = await toggle.boundingBox({ timeout: 500 }).catch(() => null);
  if (tbox) {
    await glide(page, tbox.x + tbox.width / 2, tbox.y + tbox.height / 2, 14);
    await sleep(220);
    await toggle.click({ timeout: 800 }).catch(() => {});
  }
  await sleep(5000);                                  // ≈ t=6.2 — "Background"

  // ── Background → white via color picker ────────────────────────────
  // "Background … color picker built in. I'll pick white." @6.2 → 14.6
  await clickCube(page, "background", "Background", sleep);
  await sleep(900);                                   // picker opens
  const pickedColor = await clickFirst(page, [
    `input[type='color']`,
    `[data-controller*='color'] button`,
    `.color-picker button`,
    `.modal button:has-text('White')`,
    `.modal [aria-label*='white' i]`,
  ], sleep);
  if (pickedColor) {
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("input[type='color']");
      if (input) {
        input.value = "#ffffff";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }).catch(() => {});
  }
  await sleep(900);
  await closeModal(page, sleep);
  await sleep(3500);                                  // ≈ t=14.6 — "Pose"

  // ── Pose → tour the picker, click Front medium ─────────────────────
  // Narration arc:
  //   "Pose."                                @14.81
  //   "Click the Pose cube and the picker opens"  @16.69
  //   "back view, front pose, full body, 45 angle, back medium" @21.30
  //   "I'll go with Front medium"            ~28
  await clickCube(page, "pose", "Pose", sleep, { at: "top" });
  await sleep(2500);                                  // picker opens, audience reads — ≈ t=18

  // Cursor browses the pose options as the narration enumerates them.
  // Spend ~1s on each so the audience can match name to thumbnail.
  await cursorTour(page, [
    `text=/^back view$/i`,
    `text=/^front pose$/i`,
    `text=/full body pose/i`,
    `text=/^45 angle view$/i`,
    `text=/^Back medium$/i`,
  ], sleep, 1000);
  // Now settle on Front medium and click — narration anchor ~28 s.
  await clickFirst(page, [
    `text=/^Front medium$/i`,
    `[role='option']:has-text('Front medium')`,
    `li:has-text('Front medium')`,
    `.modal img[alt*='Front medium' i]`,
  ], sleep);
  await sleep(1500);                                  // selection lingers
  await sleep(1000);                                  // ≈ t=31 — "Face"

  // ── Face → tour the picker, search "boy", browse, click Felix ──────
  // Narration arc:
  //   "Face."                                @31.21
  //   "Click the Face cube"                  @33.17
  //   "public library — every face was generated by Astria, free to use"
  //   "I'll search for 'boy'"                @42.04
  //   "Felix looks right"                    @44.81
  await clickCube(page, "face", "Face", sleep);
  await sleep(2200);                                  // picker opens — ≈ t=33.4

  // Brief glance at the unfiltered list so the audience sees the library
  // before the filter narrows it. Try a few selector shapes — Astria's
  // picker rows aren't always plain <img>; they may be wrapped in <li> or
  // role=option. cursorTour skips selectors that miss in 300ms.
  await cursorTour(page, [
    `.modal [role='option']:nth-of-type(1)`,
    `.modal [role='option']:nth-of-type(2)`,
    `.modal li:nth-of-type(1)`,
    `.modal li:nth-of-type(2)`,
    `.modal img:nth-of-type(1)`,
    `.modal img:nth-of-type(2)`,
  ], sleep, 700);

  const search = page.locator(
    `input[placeholder*='Search' i], input[type='search'], .modal input[type='text']`
  ).first();
  const sbox = await search.boundingBox({ timeout: 500 }).catch(() => null);
  if (sbox) {
    await glide(page, sbox.x + sbox.width / 2, sbox.y + sbox.height / 2, 12);
    await search.click({ timeout: 400 }).catch(() => {});
    await page.keyboard.type("boy", { delay: 100 }).catch(() => {});
    await sleep(1300);                                // wait for filter
  }

  // Browse the filtered face thumbnails before settling on Felix.
  await cursorTour(page, [
    `.modal [role='option']:nth-of-type(1)`,
    `.modal [role='option']:nth-of-type(2)`,
    `.modal li:nth-of-type(1)`,
    `.modal li:nth-of-type(2)`,
    `.modal img:nth-of-type(1)`,
    `.modal img:nth-of-type(2)`,
  ], sleep, 800);

  await clickFirst(page, [
    `text=/^Felix$/i`,
    `[data-name='Felix' i]`,
    `.modal img[alt*='Felix' i]`,
    `.modal [aria-label*='Felix' i]`,
    `.modal img:visible`,
  ], sleep);
  await sleep(1200);
  await closeModal(page, sleep);
  await sleep(800);                                   // ≈ t=47.5 — "Top"

  // ── Top → paste packshot from brand site ───────────────────────────
  // Narration arc (~14 s):
  //   "Top."                                 @47.65
  //   "fastest path is to copy a packshot"   ~50
  //   "right-click copy"                     ~53
  //   "back to Astria, focus the prompt box, Command-V" ~56
  //   "image uploads instantly and lands in the Top cube" ~60
  const baseline = await chipCount(page);
  await sleep(3500);                                  // breathe before paste — ≈ t=51
  await pasteImageToPrompt(page, TOP_PACKSHOT, sleep, {
    waitForChipsAtLeast: baseline + 1,
    uploadTimeoutMs: 5000,
  });
  await sleep(10000);                                 // ≈ t=62 — "Bottom"

  // ── Bottom → paste shorts ──────────────────────────────────────────
  // "Bottom. Same flow with the shorts." @62.33
  await pasteImageToPrompt(page, BOTTOM_PACKSHOT, sleep, {
    waitForChipsAtLeast: baseline + 2,
    uploadTimeoutMs: 4000,
  });
  await sleep(3000);                                  // ≈ t=66.5 — "Footwear"

  // ── Footwear → flip-flops from public library ──────────────────────
  // Narration arc:
  //   "Footwear."                            @66.37
  //   "public library has shoes too"         @67.77
  //   "I'll search for 'flip'"               @70.36
  //   "Click, and it's added"                @73.51
  await clickCube(page, "footwear", "Footwear", sleep);
  await sleep(1500);                                  // picker opens — ≈ t=68

  // Quick browse of unfiltered shoes so the audience sees the library.
  await cursorTour(page, [
    `.modal [role='option']:nth-of-type(1)`,
    `.modal [role='option']:nth-of-type(2)`,
    `.modal li:nth-of-type(1)`,
    `.modal li:nth-of-type(2)`,
  ], sleep, 600);

  const fwSearch = page.locator(
    `input[placeholder*='Search' i], .modal input[type='search'], .modal input[type='text']`
  ).first();
  const fwBox = await fwSearch.boundingBox({ timeout: 400 }).catch(() => null);
  if (fwBox) {
    await glide(page, fwBox.x + fwBox.width / 2, fwBox.y + fwBox.height / 2, 12);
    await fwSearch.click({ timeout: 400 }).catch(() => {});
    await page.keyboard.type("flip", { delay: 100 }).catch(() => {});
    await sleep(900);

    // If "No models found" comes back, clear and fall back.
    const noResults = await page.locator("text=/no models found/i").first()
      .boundingBox({ timeout: 300 }).catch(() => null);
    if (noResults) {
      await fwSearch.click({ clickCount: 3, timeout: 300 }).catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await sleep(400);
    }
  }

  await clickFirst(page, [
    `text=/flip[- ]?flops/i`,
    `text=/black flip[- ]?flops/i`,
    `.modal [aria-label*='flip' i]`,
    `.modal img[alt*='flip' i]`,
    `.modal img:visible`,
    `.modal [role='button']:visible`,
  ], sleep);
  await sleep(2000);                                  // selection lingers
  await closeModal(page, sleep);
  await sleep(500);                                   // end ≈ t=75
};

export default script;
