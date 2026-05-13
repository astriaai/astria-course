/**
 * Compiled for scripts/intent/11-templates-concept.yaml.
 *
 * Demo arc (narration ≈ 60 s):
 *   0.0 s  "once a look is working we lock it in"
 *   4.0 s  "open the hamburger on a generation"
 *  10.0 s  "click Template, save a New Template"
 *  16.0 s  "no matter what garment you drop in"
 *  24.0 s  "the brand opens My Templates"
 *  30.0 s  "picks the one we built for them"
 *  36.0 s  "swaps in a new garment"
 *  48.0 s  "collection of prompts — front, side, back, detail"
 *  56.0 s  "click Generate"
 *  60.0 s  end
 *
 * Selectors verified live on astria.ai (2026-04-20) — see intent yaml for
 * DOM notes. The "Save as Template" affordance has moved since the 2024
 * webinar: the per-image hamburger no longer contains a Template option,
 * so we demo the downstream surface instead — /w/zara, the delivered
 * workspace the brand actually sees.
 *
 * Run headed:
 *   HEADED=1 npx tsx pipeline/record-screencast.ts 11-templates-concept
 */
import type { RecordScript, Viewport } from "../../../pipeline/record-screencast.js";
import type { Page } from "playwright";

const BASE_URL = process.env.ASTRIA_BASE_URL ?? "https://www.astria.ai";

// Portrait-ish capture to match the screencast-pip .with-bullets slot
// (1200×956 after the 44 px chrome, ≈1.255 aspect). 1280×1024 = 5:4 = 1.25,
// a common window size that avoids letterboxing under `object-fit: contain`.
export const viewport: Viewport = { width: 1280, height: 1024 };

// ─── Cursor motion helpers ────────────────────────────────────────────
// Lifted from scripts/record/10-refine-and-templatize.ts. Cubic-bezier
// paths with ease-in-out and per-step jitter give motion that reads as
// human — Playwright's linear `mouse.move(..., {steps})` looks robotic.

interface Pt { x: number; y: number }

function bezier(p0: Pt, p3: Pt, bow = 0.22): [Pt, Pt, Pt, Pt] {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const dist = Math.hypot(dx, dy);
  const nx = dist === 0 ? 0 : -dy / dist;
  const ny = dist === 0 ? 0 : dx / dist;
  const mag = bow * dist;
  const p1: Pt = { x: p0.x + dx * 0.35 + nx * mag * 0.6, y: p0.y + dy * 0.35 + ny * mag * 0.6 };
  const p2: Pt = { x: p0.x + dx * 0.65 - nx * mag * 0.4, y: p0.y + dy * 0.65 - ny * mag * 0.4 };
  return [p0, p1, p2, p3];
}

function cubic(t: number, p: [Pt, Pt, Pt, Pt]): Pt {
  const u = 1 - t;
  return {
    x: u ** 3 * p[0].x + 3 * u ** 2 * t * p[1].x + 3 * u * t ** 2 * p[2].x + t ** 3 * p[3].x,
    y: u ** 3 * p[0].y + 3 * u ** 2 * t * p[1].y + 3 * u * t ** 2 * p[2].y + t ** 3 * p[3].y,
  };
}

function ease(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

async function moveAlong(page: Page, to: Pt, opts: { steps?: number; bow?: number; jitter?: number } = {}) {
  const steps = opts.steps ?? 30;
  const bow = opts.bow ?? 0.2;
  const jitter = opts.jitter ?? 0.4;
  const cursor = (page as unknown as { __cursor?: Pt }).__cursor ?? { x: to.x, y: to.y };
  const path = bezier(cursor, to, bow);
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    const p = cubic(t, path);
    const jx = Math.sin(i * 1.73) * jitter;
    const jy = Math.cos(i * 2.11) * jitter;
    await page.mouse.move(p.x + jx, p.y + jy);
    await page.waitForTimeout(8 + Math.round(6 * (1 - Math.abs(0.5 - t) * 2)));
  }
  (page as unknown as { __cursor?: Pt }).__cursor = to;
}

async function moveToSelector(
  page: Page,
  selector: string,
  opts: { timeout?: number; holdMs?: number; bow?: number } = {}
): Promise<{ ok: boolean; center?: Pt }> {
  const { timeout = 1500, holdMs = 0, bow } = opts;
  const el = await page.waitForSelector(selector, { state: "visible", timeout }).catch(() => null);
  if (!el) return { ok: false };
  const box = await el.boundingBox();
  if (!box) return { ok: false };
  const center: Pt = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await moveAlong(page, center, { bow });
  if (holdMs) await page.waitForTimeout(holdMs);
  return { ok: true, center };
}

async function clickSelector(
  page: Page,
  selector: string,
  opts: { timeout?: number; hoverMs?: number; bow?: number } = {}
): Promise<boolean> {
  const res = await moveToSelector(page, selector, {
    timeout: opts.timeout,
    holdMs: opts.hoverMs ?? 220,
    bow: opts.bow,
  });
  if (!res.ok) return false;
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.up();
  return true;
}

// Smooth-scroll by stepping from the Node side — avoids passing arrow
// functions into `page.evaluate`, which tsx rewrites in a way that
// references the `__name` helper that doesn't exist in the page context.
// Passing strings to `evaluate` keeps the payload pure JS.
async function smoothScrollBy(page: Page, dy: number, durationMs = 900) {
  const startY = Number(await page.evaluate(`window.scrollY`));
  const steps = Math.max(12, Math.round(durationMs / 32));
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    const y = Math.round(startY + dy * e);
    await page.evaluate(`window.scrollTo(0, ${y})`);
    await page.waitForTimeout(Math.round(durationMs / steps));
  }
}

// ─── Main script ──────────────────────────────────────────────────────

const script: RecordScript = async ({ page, sleep }) => {
  // Seed the virtual cursor off-frame so the first glide has travel.
  (page as unknown as { __cursor?: Pt }).__cursor = { x: 1580, y: 40 };

  // ── Act 1: author side — hover + open image-edit dropdown (0–24 s) ─
  await page.goto(`${BASE_URL}/prompts`, { waitUntil: "domcontentloaded" });
  await sleep(2500);                                 // ≈ t=2.5

  // "once a look is working, we lock it in" — settle on the grid
  await sleep(1800);                                 // ≈ t=4.3

  // Hover a generated image so the image-edit controls light up.
  await moveToSelector(page, ".prompt-image", {
    timeout: 2000,
    holdMs: 1400,
    bow: 0.22,
  });
  await sleep(3500);                                 // ≈ t=10

  // Click the image-edit dropdown trigger (narrow to avoid the Download one).
  const opened = await clickSelector(
    page,
    ".dropdown > button.btn.btn-sm.btn-over-image[tabindex='0']",
    { timeout: 2000, hoverMs: 300 }
  );
  await sleep(1800);                                 // menu animates in

  if (opened) {
    // Tour the menu items so the viewer can read them. These are the
    // actions currently available; the original "Pack" option is gone.
    await moveToSelector(page, "a[data-action*='prompt#setInputImage']", {
      timeout: 1500,
      holdMs: 1400,
      bow: 0.14,
    });
    await moveToSelector(page, "a[data-action*='prompt#setInputImageAndDrawMask']", {
      timeout: 1500,
      holdMs: 1400,
      bow: 0.12,
    });
    await moveToSelector(page, "a[data-action*='tune-uploader#processImageUrl']", {
      timeout: 1500,
      holdMs: 1800,
      bow: 0.12,
    });
  }
  // Dismiss the menu before the nav move so it doesn't hover as we leave.
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(1200);                                 // ≈ t=24

  // ── Act 2: glide to "My templates" nav, then to Zara workspace (24–48 s) ─
  // Top-nav "My templates" sits around (863, 8) on 1600x900 — use the href.
  await moveToSelector(page, "a[href*='/packs?ws=']", {
    timeout: 1500,
    holdMs: 1400,
    bow: 0.3,
  });
  await sleep(3500);                                 // ≈ t=30

  // Jump to the delivered brand workspace.
  await page.goto(`${BASE_URL}/w/zara`, { waitUntil: "domcontentloaded" });
  await sleep(2500);                                 // ≈ t=32.5 — grid paints

  // Tour five garment templates — Pants → Shirt → Sneakers → Jacket → Dress.
  // These are the template cards the brand actually clicks.
  const tour = [
    "a[href='/p/zara-pants']",
    "a[href='/p/zara-shirt']",
    "a[href='/p/zara-shoes']",
    "a[href='/p/zara-brown-jacket']",
    "a[href='/p/zara-yellow-dress']",
  ];
  for (let i = 0; i < tour.length; i++) {
    // Scroll the next card into view before gliding to it so the cursor
    // isn't chasing an off-screen target. String-form evaluate avoids tsx's
    // `__name` helper getting injected into the page context.
    const sel = tour[i].replace(/'/g, "\\'");
    await page.evaluate(
      `(document.querySelector('${sel}') || {}).scrollIntoView && document.querySelector('${sel}').scrollIntoView({behavior:'smooth',block:'center'})`
    );
    await sleep(500);
    await moveToSelector(page, tour[i], { timeout: 1500, holdMs: 1400, bow: 0.22 });
  }
  await sleep(1500);                                 // ≈ t=48

  // ── Act 3: open the Shirt template, settle on Generate (48–60 s) ───
  await clickSelector(page, "a[href='/p/zara-shirt']", {
    timeout: 2000,
    hoverMs: 400,
    bow: 0.18,
  });
  await sleep(3500);                                 // ≈ t=51.5 — page loads

  // Smooth-scroll down a touch so the template's prompt grid shows.
  await smoothScrollBy(page, 380, 1100);
  await sleep(1500);                                 // ≈ t=54

  // Settle on Generate — the call-to-action the brand taps.
  const gen =
    (await moveToSelector(page, "a[href*='/prompts']:has-text('Generate')", {
      timeout: 1500,
      holdMs: 3200,
      bow: 0.28,
    })).ok ||
    (await moveToSelector(page, "a:has-text('Generate')", {
      timeout: 1500,
      holdMs: 3200,
      bow: 0.28,
    })).ok;
  if (!gen) {
    // Fallback: dwell on the top nav so the end frame isn't empty.
    await moveToSelector(page, "header, nav", { timeout: 1000, holdMs: 3200 });
  }
  await sleep(1500);                                 // ≈ t=60 — end
};

export default script;
