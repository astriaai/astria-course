/**
 * Compiled from scripts/intent/06-brand-implementations.yaml.
 *
 * Walks three Astria brand workspaces — Zara, Great Sports, America Basics —
 * and times the transitions to the Gemini/Aoede narration (≈67 s).
 *
 *   Narration anchor            Action on screen
 *   ──────────────────────────  ────────────────────────────────────────
 *   0.0  s  intro               /w/zara loads, hero video plays, slow scroll
 *   19.6 s  "workspace for each"  (still on Zara; scroll continues)
 *   31.3 s  "Zara"                mid/bottom of Zara gallery
 *   37.5 s  (transition)          navigate to Great Sports (anchor @ 39.9 s)
 *   39.9 s  "Great Sports"        Great Sports page + short scroll
 *   41.3 s  "Adidas"
 *   46.5 s  (transition)          navigate to America Basics (anchor @ 48.6 s)
 *   48.6 s  "America"             America Basics + long scroll through closing
 *   59.9 s  "deliver a workspace" holding near bottom of America Basics
 *   66.5 s  "single click"        final settle
 *   67.3 s  end
 *
 * Run headed: `HEADED=1 npx tsx pipeline/record-screencast.ts 06-brand-implementations`
 */
import type { RecordScript } from "../../../pipeline/record-screencast.js";

const BASE_URL = process.env.ASTRIA_BASE_URL ?? "https://www.astria.ai";

async function glide(page: import("playwright").Page, x: number, y: number, steps = 25) {
  await page.mouse.move(x, y, { steps });
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

async function centerCursor(page: import("playwright").Page, yOffset = 320) {
  const main = page.locator("main, [role=main], body").first();
  const box = await main.boundingBox().catch(() => null);
  if (box) await glide(page, box.x + box.width / 2, box.y + yOffset, 40);
}

const script: RecordScript = async ({ page, sleep }) => {
  // ── Zara: t=0 → ~39 s ─────────────────────────────────────────────
  // Covers intro (0-19s) + workspace concept (19-30s) + "Zara" anchor @ 31.3s +
  // "templates across casual, formal, nightwear" (36.3s). Transition out just
  // before "Great Sports" anchor @ 39.9s so the new page is settled on cue.
  await page.goto(`${BASE_URL}/w/zara`, { waitUntil: "domcontentloaded" });
  await sleep(2500);                                 // ≈ t=3
  await centerCursor(page, 260);
  await sleep(5500);                                 // ≈ t=9  — let hero video breathe
  await smoothScrollTo(page, 3000, 25_000);          // ≈ t=34 — long slow scroll through gallery
  await sleep(4500);                                 // ≈ t=38.5 — hold through "templates across …"

  // ── Great Sports: t≈39 → ~47 s ────────────────────────────────────
  // Narration anchor "Great Sports" @ 39.9s, "Adidas" @ 41.3s, "athletic" @ 43.8s.
  // ≈ 8.5 s window — goto + short scroll covers the fashion→athletic contrast.
  await page.goto(`${BASE_URL}/w/great-sports`, { waitUntil: "domcontentloaded" });
  await sleep(1000);                                 // ≈ t=40.5
  await centerCursor(page, 300);
  await smoothScrollTo(page, 2000, 5_500);           // ≈ t=46

  // ── America Basics: t≈47 → ~67 s ──────────────────────────────────
  // Narration anchor "America" @ 48.6s → "Uniqlo" @ 50s → closing "single click" @ 66.5s.
  // ≈ 19 s window — longer slow scroll covers the wrap-up sentence.
  await page.goto(`${BASE_URL}/w/america-basics`, { waitUntil: "domcontentloaded" });
  await sleep(1000);                                 // ≈ t=48
  await centerCursor(page, 320);
  await smoothScrollTo(page, 2600, 15_000);          // ≈ t=63

  // ── Settle: hold on a mid-page tile through "single click" (66.5s) ──
  const tile = page.locator("img").nth(6);
  const tileBox = await tile.boundingBox().catch(() => null);
  if (tileBox) await glide(page, tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height / 2, 30);
  await sleep(4500);                                 // ≈ t=67.5
};

export default script;
