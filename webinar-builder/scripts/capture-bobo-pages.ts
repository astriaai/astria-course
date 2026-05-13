/**
 * Capture screenshots of bobochoses.com pages.
 *
 * Headless Chromium against the live bobochoses.com site fails to paint
 * (Cloudflare bot detection / lazy-load on intersection observers that
 * don't fire in our recording context). Workaround: capture screenshots
 * once with longer waits + scroll-trigger, store them locally, and use
 * them as the screencast source for 09-brand-research.
 *
 * Two output kinds:
 *   - Full-page PNG of the homepage (used for the scrolling intro pan)
 *   - Viewport screenshots of each product page with the lookbook
 *     thumbnail strip + main image + right-side product detail visible.
 *     One screenshot per active thumbnail (medium / full body).
 *
 * Run:
 *   npx tsx scripts/capture-bobo-pages.ts
 *
 * Output:
 *   assets/captures/bobo-pages/home.png
 *   assets/captures/bobo-pages/kids-medium.png
 *   assets/captures/bobo-pages/kids-fullbody.png
 *   assets/captures/bobo-pages/women-medium.png
 *   assets/captures/bobo-pages/women-fullbody.png
 */
import { chromium, type Page } from "playwright";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, "assets", "captures", "bobo-pages");

// Homepage gets a full-page screenshot for the scrolling intro pan.
const FULLPAGE: Array<{ name: string; url: string }> = [
  { name: "home", url: "https://bobochoses.com" },
];

// Product pages: viewport screenshots after clicking each lookbook
// thumbnail in the left rail. We click by image src pattern (e.g.
// `B126AC009_8`) so the captures stay correct even if the rail's pixel
// coordinates drift between page loads.
const PRODUCT_PAGES: Array<{
  url: string;
  shots: Array<{ name: string; srcMatch: string }>;
}> = [
  {
    url: "https://bobochoses.com/products/b126ac009-van-dog-t-shirt",
    shots: [
      // B126AC009_8 = medium upper-torso
      { name: "kids-medium", srcMatch: "B126AC009_8" },
      // B126AC009_7 = full body
      { name: "kids-fullbody", srcMatch: "B126AC009_7" },
    ],
  },
  {
    url: "https://bobochoses.com/products/b126ad005-tomatoes-print-fitted-t-shirt",
    shots: [
      // B126AD005_6 = medium
      { name: "women-medium", srcMatch: "B126AD005_6" },
      // B126AD005_8 = full body
      // (skip B126AD005_2 — fabric detail close-up; user said not to
      //  show this view in 09b)
      { name: "women-fullbody", srcMatch: "B126AD005_8" },
    ],
  },
];

// 1600×900 matches the screencast aspect; tall PNGs stay 1600 wide and
// scroll vertically. The screencast-pip layout's browser viewport is
// roughly 1200×900 after the 44 px chrome.
const VIEWPORT_WIDTH = 1600;
const VIEWPORT_HEIGHT = 900;

async function dismissPopups(page: Page) {
  const dismiss = async () => {
    await page.getByRole("button", { name: /^enter$/i }).first().click({ timeout: 500 }).catch(() => {});
    await page.getByRole("button", { name: /accept all/i }).first().click({ timeout: 500 }).catch(() => {});
    await page.getByRole("button", { name: /^close|dismiss|no thanks/i }).first().click({ timeout: 500 }).catch(() => {});

    await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        "button, a, [role='button'], svg, [class*='close' i], [aria-label*='close' i]"
      ));
      for (const el of candidates) {
        const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
        const t = (el.textContent ?? "").trim();
        const cls = (el.className && typeof el.className === "string" ? el.className : "").toLowerCase();
        const looksLikeClose = /close|dismiss|no thanks/.test(aria + " " + cls) ||
                               /^(×|x|close)$/i.test(t);
        if (!looksLikeClose) continue;
        let walker: HTMLElement | null = el;
        for (let i = 0; i < 8 && walker; i++) {
          const cs = getComputedStyle(walker);
          if (cs.position === "fixed" || cs.position === "sticky" || walker.getAttribute("role") === "dialog") {
            (el as HTMLElement).click?.();
            break;
          }
          walker = walker.parentElement;
        }
      }
    }).catch(() => {});

    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll<HTMLElement>("body *"));
      for (const el of all) {
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed" && cs.position !== "sticky") continue;
        const text = (el.textContent ?? "").toLowerCase();
        if (/newsletter|subscribe|10% off|first order|join our world/.test(text)) {
          el.style.display = "none";
        }
      }
    }).catch(() => {});
  };
  await dismiss();
  await page.waitForTimeout(800);
  await dismiss();
  await page.waitForTimeout(1500);                   // newsletter popups load lazily
  await dismiss();

  await page.addStyleTag({
    content: `
      #CybotCookiebotDialog, [id*="cookiebot" i], [class*="cookiebot" i],
      [id*="onetrust" i], [class*="onetrust" i],
      [class*="cookie-banner" i], [class*="cookie-modal" i],
      [class*="newsletter" i], [class*="popup" i],
      [class*="modal" i][role="dialog"],
      [id*="newsletter" i],
      [class*="kl-private"], [class*="klaviyo"],
      .needsclick[role="dialog"],
      [data-controller*="chat" i], [class*="chat-widget" i],
      [id*="gorgias-chat" i], [class*="gorgias-chat" i] {
        display: none !important;
        visibility: hidden !important;
      }
      html, body { overflow: auto !important; }
    `,
  }).catch(() => {});
}

async function triggerLazyLoad(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let y = 0;
      const step = 600;
      const interval = setInterval(() => {
        window.scrollTo(0, y);
        y += step;
        if (y > document.body.scrollHeight) {
          clearInterval(interval);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 200);
    });
  });
  await page.waitForTimeout(2500);
}

async function main() {
  const storageStatePath = join(ROOT, "storageState.json");
  const browser = await chromium.launch({
    headless: false,                                // visible window helps debug
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      ...(existsSync(storageStatePath) ? { storageState: storageStatePath } : {}),
    });
    const page = await context.newPage();

    // ── Full-page screenshots (homepage) ─────────────────────────────
    for (const { name, url } of FULLPAGE) {
      console.log(`[capture] ${name}: ${url}`);
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch((e) => {
        console.warn(`  goto error: ${(e as Error).message}`);
      });
      await dismissPopups(page);
      await triggerLazyLoad(page);
      const outPath = join(OUT_DIR, `${name}.png`);
      await page.screenshot({ path: outPath, fullPage: true });
      console.log(`  saved → ${outPath}`);
    }

    // ── Per-thumbnail viewport screenshots (product pages) ───────────
    for (const { url, shots } of PRODUCT_PAGES) {
      console.log(`[capture] ${url}`);
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch((e) => {
        console.warn(`  goto error: ${(e as Error).message}`);
      });
      await dismissPopups(page);
      // Lightweight scroll-up before clicking — the thumb rail is at the
      // top, but lazy-load may have shifted things during dismiss.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);

      for (const { name, srcMatch } of shots) {
        // Click the thumbnail whose <img> src contains the expected
        // filename. This is robust to layout shifts and lazy-load.
        const clicked = await page.evaluate((match: string) => {
          const thumbs = Array.from(document.querySelectorAll<HTMLImageElement>("img"));
          // Filter to small thumbnails (< 80 px wide) in the left column.
          for (const img of thumbs) {
            const r = img.getBoundingClientRect();
            if (r.width > 80 || r.x > 80 || r.y < 50 || r.y > 400) continue;
            const src = img.currentSrc || img.src;
            if (!src.includes(match)) continue;
            // Click the closest button/anchor ancestor — the <img> itself
            // usually isn't directly clickable.
            const target = (img.closest("button, a, [role='button']") ?? img) as HTMLElement;
            target.click();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          }
          return null;
        }, srcMatch);
        if (!clicked) {
          console.warn(`  no thumb found matching ${srcMatch} — skipping ${name}`);
          continue;
        }
        // Let the gallery swap the main image and any lazy-load settle.
        await page.waitForTimeout(1800);

        const outPath = join(OUT_DIR, `${name}.png`);
        // Viewport screenshot (NOT fullPage): captures the page chrome —
        // header, thumb rail, main image, right-side product panel.
        await page.screenshot({ path: outPath, fullPage: false });
        console.log(`  saved → ${outPath} (clicked thumb at ${clicked.x},${clicked.y})`);
      }
    }

    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
