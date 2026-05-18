/**
 * America Basics music video — 2 acts. seedance2_fast animates each 4x4
 * artboard into a dynamic 15s video (video prompt = the act's prompt), then
 * the two acts are concatenated and muxed with the music track.
 *
 *   tsx pipeline/build-music-video.ts [--manifest <path>] [--skip-generate]
 *
 * Stages: 1. generate (astria video, artboard as first frame) → clip-actN.mp4
 *         2. normalise each act to 720x1280 / 30fps
 *         3. concat + mux with track.mp3, fade in/out → out/<project>/final.mp4
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import yaml from "js-yaml";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const OUT_W = 1280;
const OUT_H = 720;
const FPS = 30;

interface Act {
  id: number;
  name: string;
  duration: number;
  trim_start?: number;
  prompt: string;
}
interface Manifest {
  project: string;
  video: { seedance_model: string; aspect_ratio: string; acts: Act[] };
}

function astriaCli(): string {
  if (spawnSync("astria", ["--version"]).status === 0) return "astria";
  throw new Error("astria CLI not found on PATH");
}

function ff(args: string[]): void {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

/** Animate one act's artboard into a 15s video via the Astria CLI. */
async function generateAct(
  cli: string,
  model: string,
  aspect: string,
  act: Act,
  artboard: string,
  outMp4: string,
): Promise<void> {
  if (existsSync(outMp4)) {
    console.log(`[mv] act ${act.id}: cache hit`);
    return;
  }
  if (!existsSync(artboard)) throw new Error(`missing artboard ${artboard} — run generate-artboard.ts`);
  console.log(`[mv] act ${act.id} "${act.name}": Seedance ${model} ${act.duration}s`);
  const { stdout } = await execFileAsync(
    cli,
    [
      "video",
      "--workspace", "personal", // keep generations off the client workspace
      "--video-model", model,
      "--video-prompt", act.prompt.trim().replace(/\s+/g, " "),
      "--text", "america basics",
      "--first-frame", artboard,
      "--aspect-ratio", aspect,
      "--duration", String(act.duration),
      "--wait",
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const prompt = JSON.parse(stdout) as { images?: string[]; content_types?: string[]; user_error?: string };
  if (prompt.user_error) throw new Error(`act ${act.id}: ${prompt.user_error}`);
  const idx = (prompt.content_types ?? []).findIndex((t) => t?.startsWith("video/"));
  const url = idx !== -1 ? prompt.images?.[idx] : undefined;
  if (!url) throw new Error(`act ${act.id}: no video in response`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`act ${act.id}: download ${res.status}`);
  writeFileSync(outMp4, Buffer.from(await res.arrayBuffer()));
  console.log(`[mv] act ${act.id}: done → ${outMp4}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mi = argv.indexOf("--manifest");
  const manifestPath = resolve(mi !== -1 ? argv[mi + 1]! : "script/music-videos/america-basics.yaml");
  const skipGenerate = argv.includes("--skip-generate") || argv.includes("--render-only");

  const m = yaml.load(readFileSync(manifestPath, "utf-8")) as Manifest;
  const { project } = m;
  const acts = m.video.acts;
  const artDir = join(ROOT, "assets", "artboard", project);
  const clipsDir = join(ROOT, "assets", "results", project);
  const workDir = join(ROOT, ".cache", "mv", project);
  const outDir = join(ROOT, "out", project);
  for (const d of [clipsDir, workDir, outDir]) mkdirSync(d, { recursive: true });

  const clipPath = (a: Act) => join(clipsDir, `clip-act${a.id}.mp4`);

  // 1. generate one 15s Seedance video per act (acts run in parallel)
  if (!skipGenerate) {
    const cli = astriaCli();
    await Promise.all(
      acts.map((a) =>
        generateAct(cli, m.video.seedance_model, m.video.aspect_ratio, a, join(artDir, `artboard-act${a.id}.jpg`), clipPath(a)),
      ),
    );
  }
  for (const a of acts) {
    if (!existsSync(clipPath(a))) throw new Error(`missing ${clipPath(a)} — run without --skip-generate`);
  }

  // 2. normalise each act to a common size / fps, dropping any grid lead-in
  const segs: string[] = [];
  for (const a of acts) {
    const seg = join(workDir, `seg-act${a.id}.mp4`);
    const trimStart = a.trim_start ?? 0;
    ff([
      ...(trimStart > 0 ? ["-ss", String(trimStart)] : []),
      "-i", clipPath(a),
      "-vf",
      `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},fps=${FPS},setsar=1`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-an",
      seg,
    ]);
    segs.push(seg);
    console.log(`[mv] act ${a.id}: normalised (trim ${trimStart}s → ${(a.duration - trimStart).toFixed(1)}s)`);
  }

  // 3. concat + mux with the track, fade in/out
  const listFile = join(workDir, "concat.txt");
  writeFileSync(listFile, segs.map((s) => `file '${s}'`).join("\n") + "\n");
  const silent = join(workDir, "silent.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", silent]);

  const total = acts.reduce((s, a) => s + (a.duration - (a.trim_start ?? 0)), 0);
  const track = join(ROOT, "assets", "music", project, "track.mp3");
  if (!existsSync(track)) throw new Error(`missing music track: ${track}`);
  const finalMp4 = join(outDir, "final.mp4");
  ff([
    "-i", silent,
    "-i", track,
    "-filter:v", `fade=t=in:st=0:d=0.5,fade=t=out:st=${(total - 0.8).toFixed(2)}:d=0.8`,
    "-filter:a", `afade=t=out:st=${(total - 1.0).toFixed(2)}:d=1.0`,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "256k", "-shortest",
    finalMp4,
  ]);
  console.log(`[mv] ${project}: ${acts.length} acts · ${total}s → ${finalMp4}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
