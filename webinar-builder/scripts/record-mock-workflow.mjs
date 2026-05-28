// Records the face-inpainting HTML mock (assets/mocks/face-inpainting/
// prompt-box.html) into assets/captures/face-inpainting/02-workflow.mp4
// — i.e. the file the screencast-pip layout already loads.
//
// Why this exists: the real Astria UI is gated behind Cloudflare + Google
// SSO that doesn't survive headless automation. The mock is a faithful
// reproduction populated with real API data (prompt text, references,
// model name), so the demo shows the *workflow* without ever leaving the
// box — and without Cloudflare in the loop.
//
// Run: npx tsx scripts/record-mock-workflow.mjs

import { chromium } from "playwright";
import { mkdirSync, readdirSync, rmSync, renameSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(".");
const HTML = "file:///" + resolve("assets/mocks/face-inpainting/prompt-box.html").replace(/\\/g, "/");
const CAPTURE_DIR = resolve("assets/captures/face-inpainting");
const WORK_DIR = join(CAPTURE_DIR, "02-workflow.mock-work");
const OUT_MP4 = join(CAPTURE_DIR, "02-workflow.mp4");

mkdirSync(CAPTURE_DIR, { recursive: true });
if (existsSafe(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true });
mkdirSync(WORK_DIR, { recursive: true });

function existsSafe(p) { try { statSync(p); return true; } catch { return false; } }

const VIEWPORT = { width: 1600, height: 900 };

const browser = await chromium.launch({
  headless: true,
  args: process.platform === "win32" ? ["--disable-gpu", "--use-gl=swiftshader"] : [],
});
const ctx = await browser.newContext({
  viewport: VIEWPORT,
  recordVideo: { dir: WORK_DIR, size: VIEWPORT },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
await page.goto(HTML, { waitUntil: "load" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Helper: move the fake cursor inside the page to (x, y) over `ms`.
async function cursorTo(x, y, ms = 700) {
  await page.evaluate(([x, y, ms]) => {
    return new Promise((resolve) => {
      window.gsap.to("#fake-cursor", {
        left: x, top: y, duration: ms / 1000, ease: "power2.inOut", onComplete: resolve,
      });
    });
  }, [x, y, ms]);
}

// ── Timeline (~50s; matches the 02-workflow narration beats) ────────
console.log("[mock-record] start");

// t≈0–4s: settle. Cursor starts top-right, drifts toward the prompt box.
await cursorTo(1180, 320, 800);
await sleep(2200);

// t≈4–18s: type the prompt. The PROMPT_TEXT is interpolated by the page.
console.log("[mock-record] typing prompt");
await cursorTo(420, 580, 700);
await sleep(400);
await page.evaluate(() => window.__typePrompt());
await sleep(13800); // typing animation ≈ ~13s for full prompt

// t≈18–24s: hover the reference chips.
console.log("[mock-record] hover reference chips");
await cursorTo(220, 510, 600);
await sleep(900);
await cursorTo(420, 510, 500);
await sleep(900);
await cursorTo(640, 510, 500);
await sleep(2100);

// t≈24–28s: hover model selector.
console.log("[mock-record] hover model selector");
await cursorTo(280, 760, 700);
await sleep(2400);

// t≈28–34s: hover then click the Inpaint faces toggle.
console.log("[mock-record] toggle inpaint faces");
await cursorTo(720, 760, 800);
await sleep(1200);
await page.evaluate(() => window.__toggleInpaint());
await sleep(3000);

// t≈34–40s: cursor to send button + click.
console.log("[mock-record] send");
await cursorTo(1280, 760, 800);
await sleep(800);
await page.evaluate(() => window.__sendPrompt());
await sleep(2800);

// t≈40–44s: result fades in.
console.log("[mock-record] reveal result");
await page.evaluate(() => window.__showResult());
await sleep(3500);

// t≈44–50s: toggle 2 then back to 1.
console.log("[mock-record] toggle 1 -> 2 -> 1");
await cursorTo(900, 540, 600);
await sleep(600);
await page.evaluate(() => window.__switchVersion("original"));
await sleep(2400);
await cursorTo(740, 540, 500);
await sleep(400);
await page.evaluate(() => window.__switchVersion("final"));
await sleep(1800);

console.log("[mock-record] closing");
await ctx.close();
await browser.close();

// Find the produced webm and transcode to mp4 with GOP=30 so HyperFrames can extract frames cleanly.
const webm = readdirSync(WORK_DIR).find((f) => f.endsWith(".webm"));
if (!webm) throw new Error("No webm produced");
const webmPath = join(WORK_DIR, webm);
console.log("[mock-record] transcoding webm -> mp4");
const r = spawnSync(
  "ffmpeg",
  [
    "-y", "-i", webmPath,
    "-r", "30", "-g", "30", "-keyint_min", "30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-preset", "fast", "-crf", "22", "-movflags", "+faststart",
    OUT_MP4,
  ],
  { stdio: "inherit", shell: true },
);
if (r.status !== 0) throw new Error(`ffmpeg transcode exited ${r.status}`);

rmSync(WORK_DIR, { recursive: true, force: true });
console.log("[mock-record] done ->", OUT_MP4);
