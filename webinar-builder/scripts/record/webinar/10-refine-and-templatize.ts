/**
 * Compiled for scripts/intent/10-refine-and-templatize.yaml.
 *
 * Selectors verified live on astria.ai/prompts (2026-04-20) — see the per-beat
 * comments for DOM notes. The original webinar's pose-picker / face-picker
 * modals don't open from a bare cube click in the current UI (`lookbook#selectCube`
 * just toggles selection), so this pass focuses on the interactions that
 * actually land:
 *
 *   - Tour the lookbook cubes (show categories)
 *   - Describe label + Paste-from-clipboard dropdown
 *   - Navigate to Pexels, copy an image to the clipboard
 *   - Back to Astria → click Paste → click Describe
 *   - Scroll to a generated image → open its image-edit dropdown
 *     (Crop / Remove Background / Edit with Nano Banana 2 4K·2K·1K)
 *   - End on "My templates" nav link — the "deliverable" surface
 *
 * Natural cursor motion: `moveAlong` moves through a cubic-bezier path with
 * ease-in-ease-out pacing and small lateral overshoot, instead of straight
 * lines. Looks human, not robotic.
 *
 * Run headed:
 *   HEADED=1 npx tsx pipeline/record-screencast.ts 10-refine-and-templatize
 */
import type { RecordScript } from "../../../pipeline/record-screencast.js";
import type { Page } from "playwright";

const BASE_URL = process.env.ASTRIA_BASE_URL ?? "https://www.astria.ai";

// ─── Cursor motion helpers ──────────────────────────────────────────

interface Pt { x: number; y: number }

/** Cubic-bezier from p0 → p3, with control points that bow out laterally. */
function bezier(p0: Pt, p3: Pt, bow = 0.25): [Pt, Pt, Pt, Pt] {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const dist = Math.hypot(dx, dy);
  // Perpendicular unit vector (for lateral bow)
  const nx = dist === 0 ? 0 : -dy / dist;
  const ny = dist === 0 ? 0 : dx / dist;
  const mag = bow * dist;
  // Asymmetric control points give a more "handwritten" feel.
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

/** ease-in-out cubic — slow start, fast middle, slow arrival. */
function ease(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Move through a bezier arc with eased timing + tiny jitter. */
async function moveAlong(page: Page, to: Pt, opts: { steps?: number; bow?: number; jitter?: number } = {}) {
  const steps = opts.steps ?? 32;
  const bow = opts.bow ?? 0.18;
  const jitter = opts.jitter ?? 0.4;
  // Playwright doesn't expose current mouse position; track it on `page`.
  const cursor = (page as unknown as { __cursor?: Pt }).__cursor ?? { x: to.x, y: to.y };
  const path = bezier(cursor, to, bow);
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    const p = cubic(t, path);
    const jx = (Math.sin(i * 1.73) * jitter);
    const jy = (Math.cos(i * 2.11) * jitter);
    await page.mouse.move(p.x + jx, p.y + jy);
    // Micro-pause per step → ~8-15 ms, bunched in the ease middle.
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
  const res = await moveToSelector(page, selector, { timeout: opts.timeout, holdMs: opts.hoverMs ?? 250, bow: opts.bow });
  if (!res.ok) return false;
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.up();
  return true;
}

async function cubeTour(page: Page, names: string[], perMs: number) {
  for (const name of names) {
    await moveToSelector(
      page,
      `.cube-cell[data-lookbook-names-param="${name}"], .cube-cell[data-lookbook-names-param*="${name}"]`,
      { timeout: 800, holdMs: perMs, bow: 0.22 }
    );
  }
}

// ─── Main script ────────────────────────────────────────────────────

const script: RecordScript = async ({ page, sleep }) => {
  // Clipboard perms: Paste from clipboard reads navigator.clipboard.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  // Seed the virtual cursor somewhere out-of-frame so the first glide has travel.
  (page as unknown as { __cursor?: Pt }).__cursor = { x: 1580, y: 50 };

  // ── Beat 1: land + cube tour + prompt-box hover (0–36 s) ───────────
  await page.goto(`${BASE_URL}/prompts`, { waitUntil: "domcontentloaded" });
  await sleep(2500);                                  // ≈ t=2.5

  // "most bugs you'll hit…" — settle on the grid
  await sleep(5500);                                  // ≈ t=8

  // Cube tour — pose, face, top, bottom, footwear (names from DOM probe).
  await cubeTour(
    page,
    [
      "pose",
      "man,woman,boy,girl,child",    // face
      "shirt,dress,sweater",          // top
      "pants,shorts,stockings",       // bottom
      "shoes,sandals,heels",          // footwear
    ],
    1300
  );
  await sleep(6000);                                  // ≈ t=22

  // Glide down into the prompt input area.
  await moveToSelector(page, ".tribute-prompt-input", { timeout: 2000, holdMs: 1500, bow: 0.25 });
  await sleep(11_000);                                // ≈ t=36

  // ── Beat 2: Describe label + Paste dropdown reveal (36–48 s) ───────
  // `label.upload-images` → Describe. The dropdown sibling reveals "Paste from clipboard".
  await moveToSelector(page, "label.upload-images", { timeout: 2000, holdMs: 2200, bow: 0.18 });
  await sleep(3000);                                  // ≈ t=41

  // Show the paste dropdown by opening it briefly.
  const dropdownOpen = await clickSelector(
    page,
    "label.upload-images + .dropdown > button, .dropdown > button.btn.join-item",
    { timeout: 1500, hoverMs: 300 }
  );
  await sleep(1800);                                  // menu appears
  if (dropdownOpen) {
    // Let viewer see the "Paste from clipboard" item — hover it briefly.
    await moveToSelector(
      page,
      'a[data-action*="pasteFromClipboardForDescribe"]',
      { timeout: 1500, holdMs: 1500, bow: 0.15 }
    );
  }
  // Close the dropdown so the Pexels nav is uncluttered.
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(2500);                                  // ≈ t=48

  // ── Beat 2.5: Unsplash detour (48–92 s) ────────────────────────────
  await page.goto("https://unsplash.com/s/photos/fashion-photography", {
    waitUntil: "domcontentloaded",
  });
  await sleep(5000);                                  // ≈ t=53 — grid paints

  // Dismiss any consent/welcome overlay that Unsplash sometimes shows.
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(500);

  // Cursor-tour a couple of tiles on the search grid so the viewer sees the
  // browse experience. We deliberately DON'T click through to a detail page —
  // same-tab navigation out of Astria's origin has killed the Playwright
  // context in practice. Copying the first grid thumbnail is enough.
  const tiles = page.locator('a[href*="/photos/"]:has(img)');
  const nTiles = await tiles.count().catch(() => 0);
  for (let i = 0; i < Math.min(nTiles, 2); i++) {
    const box = await tiles.nth(i).boundingBox().catch(() => null);
    if (box) {
      await moveAlong(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { bow: 0.3, steps: 26 });
      await sleep(1400);
    }
  }
  await sleep(4000);                                  // ≈ t=63 — dwell on the grid

  // Programmatically copy the largest-resolution image from the grid.
  // Unsplash serves srcset; we pick the highest-resolution URL we can read.
  const copied = await page
    .evaluate(async () => {
      const imgs = Array.from(document.querySelectorAll("img")) as HTMLImageElement[];
      const unsplashImgs = imgs.filter((i) =>
        /images\.unsplash\.com/.test(i.currentSrc || i.src || "")
      );
      // Pick a reasonably large on-screen tile (skip tiny profile/avatar images).
      const picked = unsplashImgs
        .filter((i) => {
          const r = i.getBoundingClientRect();
          return r.width >= 120 && r.height >= 120;
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        })[0];
      const img = picked ?? (document.querySelector("main img, figure img") as HTMLImageElement | null);
      if (!img) return { ok: false, reason: "no-img" } as const;
      const src = img.currentSrc || img.src;
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext("2d")!.drawImage(bmp, 0, 0);
        const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
        if (!png) return { ok: false, reason: "no-png" } as const;
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
        return { ok: true, bytes: png.size } as const;
      } catch (e) {
        return { ok: false, reason: String((e as Error).message ?? e) } as const;
      }
    })
    .catch((e) => ({ ok: false, reason: String(e) } as const));
  console.log(`[record] 05: unsplash → clipboard`, copied);
  await sleep(5000);                                  // ≈ t=72 — pause on the image

  // Back to Astria.
  await page.goto(`${BASE_URL}/prompts`, { waitUntil: "domcontentloaded" });
  await sleep(4000);                                  // ≈ t=76

  // Open Describe dropdown, click Paste from clipboard.
  await clickSelector(
    page,
    "label.upload-images + .dropdown > button, .dropdown > button.btn.join-item",
    { timeout: 1500, hoverMs: 300 }
  );
  await sleep(1200);
  await clickSelector(
    page,
    'a[data-action*="pasteFromClipboardForDescribe"]',
    { timeout: 1500, hoverMs: 350 }
  );
  await sleep(4500);                                  // ≈ t=82 — upload settles

  // Run Describe.
  await clickSelector(page, "label.upload-images", { timeout: 1500, hoverMs: 400 });
  await sleep(10_000);                                // ≈ t=92 — wait for Describe API

  // ── Beat 3: generated image + image-edit dropdown (92–140 s) ──────
  // Scroll the first generation into view.
  await page.evaluate(() => {
    const thumb = document.querySelector(".prompt-image") as HTMLElement | null;
    thumb?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  await sleep(2500);

  // Hover the first generated image for a beat.
  await moveToSelector(page, ".prompt-image", { timeout: 1500, holdMs: 2000, bow: 0.2 });
  await sleep(6000);                                  // ≈ t=102

  // Click the image-edit dropdown trigger (button.btn-over-image[tabindex='0']).
  // Narrow to the dropdown wrapper so we don't hit the Download button.
  const editOpened = await clickSelector(
    page,
    ".dropdown > button.btn.btn-sm.btn-over-image[tabindex='0']",
    { timeout: 2000, hoverMs: 400 }
  );
  await sleep(1500);

  if (editOpened) {
    // Reveal Crop → Remove Background → Edit with Nano Banana options one by one.
    await moveToSelector(page, 'a[data-action*="image-edit#openCropModal"]', {
      timeout: 1500,
      holdMs: 1800,
      bow: 0.15,
    });
    await moveToSelector(page, 'a[data-action*="image-edit#removeBackground"]', {
      timeout: 1500,
      holdMs: 2000,
      bow: 0.15,
    });
    const nanoItems = page.locator('a[data-action*="image-edit#editImage"]');
    const count = await nanoItems.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 3); i++) {
      const box = await nanoItems.nth(i).boundingBox().catch(() => null);
      if (box) {
        await moveAlong(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { bow: 0.1, steps: 18 });
        await sleep(1500);
      }
    }
  }
  await sleep(4000);                                  // ≈ t=128

  // Close the menu.
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(1500);

  // ── Beat 4: "My templates" as the deliverable surface (140–180 s) ─
  // Gently scroll back up so the page chrome reappears, then glide to the
  // "My templates" nav entry (exists at top-level account menu).
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await sleep(2500);                                  // ≈ t=142

  // Scan the top bar — move the cursor to the account/menu area first,
  // then to the "My templates" link (it lives inside a dropdown).
  await moveToSelector(page, "nav, header", { timeout: 1200, holdMs: 800, bow: 0.25 });
  await sleep(1500);

  // Try a direct link first; fall back to hovering the account menu.
  const tplMoved = await moveToSelector(
    page,
    'a:has-text("My templates"), li:has-text("My templates") a',
    { timeout: 1500, holdMs: 3500, bow: 0.25 }
  );
  if (!tplMoved.ok) {
    // Fallback: just dwell near the top nav so the final framing isn't empty.
    await moveToSelector(page, "header a", { timeout: 1000, holdMs: 2500 });
  }
  await sleep(18_000);                                // ≈ t=180 — end
};

export default script;
