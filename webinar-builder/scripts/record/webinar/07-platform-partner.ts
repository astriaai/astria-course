/**
 * Compiled for scripts/intent/07-platform-partner.yaml.
 *
 * Hybrid capture: start on a local title-card slide, switch to the Astria
 * Zara lookbook at paragraph 3, showcase Brief at paragraph 4, pivot to
 * the Zara workspace at paragraph 5.
 *
 * Narration anchors (Gemini/Aoede, ≈82 s):
 *   0.0  s   intro                 slide card (assets/captures/07-slide/index.html)
 *  19.6 s   "models keep changing"  still on slide
 *  31.0 s   "The brand receives"    → navigate /p/zara-yellow-dress?ws=6
 *  34.2 s   "upload a simple"        click dress ref → swap
 *  48.1 s   "sometimes the brand"    → open Options → Brief
 *  51.5 s   "Brief"                   type a sample brief
 *  65.5 s   "important to explain"   → navigate /w/zara (public — no auth redirect)
 *  69.5 s   "jackets"                 scroll the template set
 *  81.6 s   end
 *
 * Run headed: `HEADED=1 npx tsx pipeline/record-screencast.ts 07-platform-partner`
 * Requires: storageState.json (run `npm run login` once) for the ?ws=6 page.
 *
 * Timing notes:
 *   - Every selector uses a SHORT (1-1.5 s) timeout and a .catch(() => {})
 *     fallback so a missed probe doesn't stack 3 s each into a runaway
 *     capture. Original draft of this script overran by ~60 s because of
 *     that; this pass targets ~82 s wall-clock to match the audio.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RecordScript } from "../../../pipeline/record-screencast.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const BASE_URL = process.env.ASTRIA_BASE_URL ?? "https://www.astria.ai";

async function glide(page: import("playwright").Page, x: number, y: number, steps = 22) {
  await page.mouse.move(x, y, { steps });
}

async function clickIfVisible(
  page: import("playwright").Page,
  selector: string,
  { timeout = 1200, hoverMs = 250 }: { timeout?: number; hoverMs?: number } = {}
): Promise<boolean> {
  const el = page.locator(selector).first();
  if (!(await el.isVisible().catch(() => false))) return false;
  const box = await el.boundingBox().catch(() => null);
  if (!box) return false;
  await glide(page, box.x + box.width / 2, box.y + box.height / 2, 18);
  if (hoverMs) await page.waitForTimeout(hoverMs);
  await el.click({ timeout }).catch(() => {});
  return true;
}

async function smoothScrollTo(
  page: import("playwright").Page,
  targetY: number,
  durationMs: number
) {
  await page.evaluate(
    async ({ targetY, durationMs }) => {
      const start = window.scrollY;
      const delta = targetY - start;
      const steps = Math.max(40, Math.floor(durationMs / 40));
      for (let i = 1; i <= steps; i++) {
        window.scrollTo({ top: start + (delta * i) / steps });
        await new Promise((r) => setTimeout(r, durationMs / steps));
      }
    },
    { targetY, durationMs }
  );
}

const script: RecordScript = async ({ page, sleep }) => {
  // ── Slide card: t=0 → ~28 s ────────────────────────────────────────
  const slideUrl = `file://${resolve(ROOT, "assets", "captures", "07-slide", "index.html")}`;
  await page.goto(slideUrl, { waitUntil: "domcontentloaded" });
  await sleep(27_500);

  // ── Zara lookbook: t≈28 → ~47 s ────────────────────────────────────
  // "The brand receives" @31, "upload a simple" @34, "single click" @37.7.
  await page.goto(`${BASE_URL}/p/zara-yellow-dress?ws=6`, { waitUntil: "domcontentloaded" });
  await sleep(1800);                                   // ≈ t=31

  // Click the dress cube, swap to a different dress thumbnail.
  await clickIfVisible(page, '.cube-cell[data-lookbook-names-param="dress"]', { hoverMs: 300 });
  await sleep(800);
  const swap = page
    .locator('.cube-cell[data-lookbook-names-param="dress"] img')
    .nth(2);
  if (await swap.isVisible().catch(() => false)) {
    const b = await swap.boundingBox().catch(() => null);
    if (b) {
      await glide(page, b.x + b.width / 2, b.y + b.height / 2, 18);
      await sleep(300);
      await swap.click({ timeout: 1000 }).catch(() => {});
    }
  }
  await sleep(3000);                                   // ≈ t=36 — let "single click" land
  // Hover the generate button so the closing of paragraph 3 has a focal point.
  const generate = page.getByRole("button", { name: /generate/i }).first();
  if (await generate.isVisible().catch(() => false)) {
    const b = await generate.boundingBox().catch(() => null);
    if (b) await glide(page, b.x + b.width / 2, b.y + b.height / 2, 20);
  }
  await sleep(8000);                                   // ≈ t=47 — coast through paragraph 3

  // ── Options → Brief: t≈47 → ~64 s ──────────────────────────────────
  // "sometimes the brand" @48, "Brief" @51.5, "armchair" @56.
  await clickIfVisible(page, 'button:has-text("Options")', { hoverMs: 350 });
  await sleep(600);
  await clickIfVisible(page, 'button:has-text("Brief"), [role="menuitem"]:has-text("Brief")', {
    hoverMs: 350,
  });
  await sleep(700);
  const briefInput = page
    .locator(
      'textarea[name*="brief" i], textarea[placeholder*="brief" i], input[name*="brief" i], [data-brief-input]'
    )
    .first();
  if (await briefInput.isVisible().catch(() => false)) {
    await briefInput.click({ timeout: 800 }).catch(() => {});
    await briefInput.fill("").catch(() => {});
    await briefInput.type("this time she's sitting on an armchair", { delay: 45 }).catch(() => {});
  }
  await sleep(8000);                                   // ≈ t=64 — hold through "coherent story"

  // ── Zara workspace (public): t≈64 → ~82 s ──────────────────────────
  // "important to explain" @65.5, "jackets" @69.5, end @81.6. Switched
  // from /packs?ws=6 (auth wall) to /w/zara which is public and renders
  // the full template set (dresses / shoes / jackets etc.).
  await page.goto(`${BASE_URL}/w/zara`, { waitUntil: "domcontentloaded" });
  await sleep(1500);                                   // ≈ t=66
  const main = page.locator("main, [role=main], body").first();
  const mb = await main.boundingBox().catch(() => null);
  if (mb) await glide(page, mb.x + mb.width / 2, mb.y + 320, 30);
  await smoothScrollTo(page, 2400, 12_000);            // ≈ t=78
  await sleep(3500);                                   // ≈ t=81.5 — closing hold
};

export default script;
