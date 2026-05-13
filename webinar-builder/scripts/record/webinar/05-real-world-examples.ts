/**
 * Compiled from scripts/intent/05-real-world-examples.yaml.
 *
 * Three panels, aligned to the Gemini/Aoede narration (≈57 s):
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ Narration                         Time   Shown                   │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ "Saks rebuilt their entire…"        4.5 – 30.9 s   sacksfashion.com │
 *   │ "Ronnie Kobo is another example…"  30.9 – 39.4 s   ronnykobo.com    │
 *   │ "Mango, H&M, Zara…"                39.4 – ~57 s    local gallery    │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Run headed: `HEADED=1 npx tsx pipeline/record-screencast.ts 05-real-world-examples`
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RecordScript } from "../../../pipeline/record-screencast.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

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

async function dismissPopups(page: import("playwright").Page) {
  // Cookie / region / newsletter overlays. Sites in other languages use
  // different button labels, so we hit a broad set of selectors, press
  // Escape, and then DOM-remove anything that still looks like an overlay.
  for (const sel of [
    'button:has-text("Accept")',
    'button:has-text("Accept All")',
    'button:has-text("Agree")',
    'button:has-text("Got it")',
    'button:has-text("Close")',
    'button:has-text("OK")',
    'button:has-text("אישור")',
    'button:has-text("אני מסכים")',
    'button:has-text("סגור")',
    '[aria-label="Close"]',
    '[aria-label="close"]',
    '[aria-label*="סגור"]',
    '[class*="consent"] button',
    '[class*="cookie"] button',
    '[id*="consent"] button',
    '[id*="cookie"] button',
  ]) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 500 }).catch(() => {});
      await page.waitForTimeout(150);
    }
  }
  await page.keyboard.press("Escape").catch(() => {});

  // DOM scrub — remove anything that looks like a consent/announcement
  // overlay. We target two signals:
  //   1. Fixed/sticky elements whose class/id mentions consent/cookie/popup.
  //   2. Any fixed/sticky element anchored to the top or bottom edge of the
  //      viewport — that's almost always a banner or bar.
  // Shopify native buyer-consent + common third-party widgets are covered.
  await page.evaluate(() => {
    const vh = document.documentElement.clientHeight;
    const vw = document.documentElement.clientWidth;
    const NAMEY = /(consent|cookie|gdpr|popup|modal|overlay|announce|newsletter|buyer-consent)/i;
    const candidates = document.querySelectorAll<HTMLElement>(
      "div, section, aside, header, footer"
    );
    for (const el of Array.from(candidates)) {
      const style = getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "sticky") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const nameish = `${el.id} ${el.className}`;
      const anchoredTop = r.top <= 8;
      const anchoredBottom = r.bottom >= vh - 8;
      const coversMuch = r.width * r.height > vw * vh * 0.15;
      if (NAMEY.test(nameish) || ((anchoredTop || anchoredBottom) && coversMuch)) {
        el.style.setProperty("display", "none", "important");
      }
    }
    // Shopify native buyer-consent shim.
    document.getElementById("shopify-buyer-consent")?.classList.add("hidden");
  }).catch(() => {});
}

async function centerCursor(page: import("playwright").Page, yOffset = 320) {
  const main = page.locator("main, [role=main], body").first();
  const box = await main.boundingBox().catch(() => null);
  if (box) await glide(page, box.x + box.width / 2, box.y + yOffset, 40);
}

const script: RecordScript = async ({ page, sleep }) => {
  // ── SACKS ────────────────────────────────────────────────────────
  // Narration anchor: "Saks" @ 4.48 s → transition to Ronny Kobo @ 30.9 s.
  // ~26 s on SACKS; we arrive ~t=2 s and leave ~t=28 s so the nav lands
  // before the presenter says "Ronnie Kobo".
  await page.goto("https://sacksfashion.com/", {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  }).catch(() => {});
  // Consentik cookie banner appears on a small delay — dismiss twice.
  await sleep(1200);
  await dismissPopups(page);
  await sleep(1200);
  await dismissPopups(page);
  await centerCursor(page, 300);
  await sleep(500);
  await smoothScrollTo(page, 4200, 22_000);
  // One more scrub in case the banner re-appears after scroll events.
  await dismissPopups(page);
  await sleep(500);

  // ── Ronny Kobo ──────────────────────────────────────────────────
  // Narration anchor: "Ronnie Kobo" @ 30.9 s → "Finally, the big players" @ 39.4 s.
  // ~8 s window. Navigate, let the hero paint, scroll.
  await page.goto("https://ronnykobo.com/collections/new-arrivals", {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await sleep(1500);
  await dismissPopups(page);
  await centerCursor(page, 320);
  await smoothScrollTo(page, 1600, 6_500);

  // ── Mango · H&M · Zara gallery ──────────────────────────────────
  // Narration anchor: "Mango" @ 41.5 s → end @ ~57 s. ~17 s on the gallery.
  const galleryUrl = `file://${resolve(ROOT, "assets", "captures", "big-players", "index.html")}`;
  await page.goto(galleryUrl, { waitUntil: "domcontentloaded" });
  // Small cursor wander so the closing frame has a focal point.
  const mid = page.locator(".card").nth(1);
  const midBox = await mid.boundingBox().catch(() => null);
  if (midBox) await glide(page, midBox.x + midBox.width / 2, midBox.y + 260, 30);
  await sleep(17_000);
};

export default script;
