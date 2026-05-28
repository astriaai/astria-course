/**
 * Playwright-driven screencast recorder.
 *
 * Runs a per-segment recording script (scripts/record/<project>/<id>.ts) inside
 * a headed-size Chromium, records the browser viewport to webm, and transcodes
 * to mp4. Re-running the same script with the same inputs produces a fresh
 * capture — the idea is that when Astria's UI changes you just re-run.
 *
 *   tsx pipeline/record-screencast.ts <segment-id>                       (default project: webinar)
 *   tsx pipeline/record-screencast.ts --project video-style-transfer 02-workflow
 *
 * Looks up the segment's recording script from:
 *   scripts/record/<project>/<segment-id>.ts
 *
 * Outputs:
 *   assets/captures/<project>/<segment-id>.mp4
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { chromium, type BrowserContext, type Page } from "playwright";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const DEFAULT_VIEWPORT = { width: 1600, height: 900 };

export interface RecordApi {
  page: Page;
  /** `sleep(1000)` — insert pauses for narration beats. */
  sleep: (ms: number) => Promise<void>;
  /** Move a synthetic cursor + click, with a short settle pause afterwards. */
  clickWithPause: (selector: string, afterMs?: number) => Promise<void>;
}

export type RecordScript = (api: RecordApi) => Promise<void>;

/**
 * A record module may export an optional `viewport` to override the default
 * 16:9 capture size. Useful when the target layout slot is more portrait —
 * `object-fit: contain` would otherwise letterbox the result.
 */
export interface Viewport { width: number; height: number }

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}`);
}

async function runRecording(project: string, segmentId: string, script: RecordScript, viewport: Viewport = DEFAULT_VIEWPORT) {
  const capturesDir = join(ROOT, "assets", "captures", project);
  mkdirSync(capturesDir, { recursive: true });
  const workDir = join(capturesDir, `${segmentId}.work`);
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  // HEADED=1 → visible browser (watch the interaction in real time).
  // SLOWMO=<ms> → slow each Playwright action by N ms. Default 0 because
  // slowMo gets multiplied across each mouse step and blows up the recording
  // duration (e.g. 120 × 30 steps × 9 cubes ≈ 30 seconds just for one tour).
  // Set SLOWMO=200 explicitly if you want a slow-motion live watch.
  const headed = process.env.HEADED === "1" || process.argv.includes("--headed");
  const slowMo = Number(process.env.SLOWMO ?? 0);
  if (headed) {
    console.log(`[record] ${segmentId}: HEADED mode (slowMo=${slowMo}ms) — Chromium window will open`);
  }

  // Windows headless Chromium + a hybrid Intel/NVIDIA GPU can record an
  // all-black webm because the GPU compositor writes to a surface the
  // recorder can't read. Forcing software rendering (no real GPU path)
  // fixes the black-frame issue without affecting Mac/Linux runs.
  // Gated on platform so we don't slow down macOS/Linux unnecessarily.
  const launchArgs: string[] = process.platform === "win32"
    ? ["--disable-gpu", "--use-gl=swiftshader"]
    : [];
  const browser = await chromium.launch({ headless: !headed, slowMo, args: launchArgs });
  const storageStatePath = join(ROOT, "storageState.json");
  const useStorageState = existsSync(storageStatePath);
  if (useStorageState) {
    console.log(`[record] ${segmentId}: using saved Astria session (storageState.json)`);
  }
  console.log(`[record] ${segmentId}: viewport=${viewport.width}x${viewport.height}`);
  const context: BrowserContext = await browser.newContext({
    viewport,
    recordVideo: { dir: workDir, size: viewport },
    deviceScaleFactor: 2,                     // retina-sharp text
    colorScheme: "dark",
    ...(useStorageState ? { storageState: storageStatePath } : {}),
  });

  // Inject a synthetic cursor that follows the Playwright mouse. Chromium
  // video recordings don't include the OS cursor (there isn't one in
  // headless), so hovers look invisible without this overlay.
  //
  // Passed as a raw STRING, not a function — esbuild (via tsx) adds a
  // `__name` runtime helper to named functions which isn't defined in the
  // browser, and a passed-function's .toString() carries that helper call
  // into the serialized script. A string payload bypasses compilation.
  await context.addInitScript({
    content: `(() => {
      function attach() {
        if (!document.body || document.getElementById("__hfCursor")) return;
        var cursor = document.createElement("div");
        cursor.id = "__hfCursor";
        cursor.style.cssText = [
          "position:fixed",
          "top:0",
          "left:0",
          "width:24px",
          "height:24px",
          "pointer-events:none",
          "z-index:2147483647",
          "background:#E06A4E",
          "border:3px solid #F4F1EC",
          "border-radius:50%",
          "box-shadow:0 2px 8px rgba(0,0,0,0.6)",
          "transform:translate(-9999px,-9999px)",
          "transition:none"
        ].join(";");
        document.body.appendChild(cursor);
        window.addEventListener("mousemove", function (e) {
          cursor.style.transform = "translate(" + (e.clientX - 12) + "px," + (e.clientY - 12) + "px)";
        }, { passive: true });
      }
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", attach);
      } else {
        attach();
      }
      document.addEventListener("turbo:load", attach);
      document.addEventListener("turbo:render", attach);
      window.addEventListener("pageshow", attach);
      new MutationObserver(attach).observe(document.documentElement, {
        childList: true, subtree: false
      });
      setInterval(attach, 1000);
    })();`,
  });

  const page = await context.newPage();

  if (process.env.DEBUG_CURSOR) {
    page.on("console", (m) => {
      const t = m.text();
      console.log(`[browser] ${t}`);
    });
    page.on("framenavigated", async (f) => {
      if (f !== page.mainFrame()) return;
      try {
        const hasCursor = await f.evaluate(() => !!document.getElementById("__hfCursor"));
        console.log(`[nav] ${f.url()}  cursor=${hasCursor}`);
      } catch {}
    });
  }

  const api: RecordApi = {
    page,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async clickWithPause(selector, afterMs = 1200) {
      const handle = await page.waitForSelector(selector, { state: "visible" });
      const box = await handle.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
      }
      await handle.click();
      await new Promise((r) => setTimeout(r, afterMs));
    },
  };

  try {
    console.log(`[record] ${segmentId}: running recording script…`);
    await script(api);
  } finally {
    await context.close();         // flushes video to disk
    await browser.close();
  }

  // The webm lives in workDir under a generated name — grab the newest one.
  const webms = readdirSync(workDir)
    .filter((f) => f.endsWith(".webm"))
    .map((f) => ({ f, mtime: statSync(join(workDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (webms.length === 0) throw new Error("Playwright produced no webm");
  const webmPath = join(workDir, webms[0].f);

  // Transcode to mp4 with dense keyframes (fixes HyperFrames' sparse-keyframe warning)
  const mp4Path = join(capturesDir, `${segmentId}.mp4`);
  console.log(`[record] ${segmentId}: transcoding webm → mp4 with GOP=30`);
  run("ffmpeg", [
    "-y",
    "-i", webmPath,
    "-c:v", "libx264",
    "-r", "30",
    "-g", "30",
    "-keyint_min", "30",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-an",                          // strip audio — narration comes from <audio> track
    mp4Path,
  ]);

  rmSync(workDir, { recursive: true, force: true });
  console.log(`[record] ${segmentId}: wrote ${mp4Path}`);
  return mp4Path;
}

export async function recordScreencast(project: string, segmentId: string): Promise<string> {
  const scriptPath = join(ROOT, "scripts", "record", project, `${segmentId}.ts`);
  if (!existsSync(scriptPath)) throw new Error(`Recording script not found: ${scriptPath}`);

  // Dynamic import — tsx resolves the TS module
  const mod = await import(scriptPath);
  const script: RecordScript = mod.default ?? mod.script;
  if (typeof script !== "function") {
    throw new Error(`${scriptPath} must export a default async function (api) => ...`);
  }
  const viewport: Viewport | undefined = mod.viewport;
  return runRecording(project, segmentId, script, viewport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const projectIdx = process.argv.indexOf("--project");
  const project = projectIdx !== -1 ? process.argv[projectIdx + 1] : "webinar";
  const positional = process.argv.slice(2).filter((a, i, arr) => {
    if (a === "--project") return false;
    if (i > 0 && arr[i - 1] === "--project") return false;
    return true;
  });
  const id = positional[0];
  if (!id) {
    console.error("Usage: tsx pipeline/record-screencast.ts [--project <name>] <segment-id>");
    process.exit(1);
  }
  recordScreencast(project, id).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
