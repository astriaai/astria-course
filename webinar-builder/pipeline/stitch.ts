/**
 * Concat all per-segment MP4s in the order declared in
 * script/projects/<project>.yaml into a single reviewable draft:
 *   out/<project>/_full-draft.mp4
 *
 *   tsx pipeline/stitch.ts                                       (default project: webinar)
 *   tsx pipeline/stitch.ts --project video-style-transfer
 *   tsx pipeline/stitch.ts --project video-style-transfer --no-xfade
 *
 * Default behavior is to chain `xfade` (video) + `acrossfade` (audio) between
 * successive segments with a 0.4s dissolve. Pass `--no-xfade` to fall back to
 * raw ffmpeg `-f concat`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function parseProject(): string {
  const idx = process.argv.indexOf("--project");
  return idx !== -1 ? process.argv[idx + 1] : "webinar";
}

function ffprobeDuration(file: string): number {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf-8" }
  );
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}`);
  return parseFloat(r.stdout.trim());
}

function runConcatStitch(clips: string[], outPath: string, listPath: string) {
  writeFileSync(listPath, clips.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-profile:v", "high",
      "-level", "4.0",
      "-crf", "22",
      "-preset", "fast",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outPath,
    ],
    { stdio: "inherit" }
  );
  if (r.status !== 0) throw new Error("ffmpeg concat failed");
}

/**
 * Chained xfade: concatenates N clips with overlapping 0.4s dissolves so
 * each segment fades into the next. Computes per-clip offsets from probed
 * durations and minus-accumulates the fade time so the timeline doesn't
 * keep stretching.
 *
 *   offset_k = sum(d_0..d_k) - (k+1)*fadeDur
 *
 * Audio uses `acrossfade` with the same duration. The total output runs
 * sum(durations) - (N-1)*fadeDur seconds.
 */
function runXfadeStitch(clips: string[], outPath: string, fadeDur: number) {
  const durations = clips.map((c) => ffprobeDuration(c));
  const inputs = clips.flatMap((c) => ["-i", c]);

  // Build [v0][v1]xfade=…:offset=offset1[v01]; [v01][v2]xfade=…[v012]; …
  // and       [a0][a1]acrossfade=…[a01]; [a01][a2]acrossfade=…[a012]; …
  const filters: string[] = [];
  let vLabel = "[0:v]";
  let aLabel = "[0:a]";
  let acc = durations[0]!;
  for (let i = 1; i < clips.length; i++) {
    const offset = acc - fadeDur;
    const nextV = `[v${i.toString().padStart(2, "0")}]`;
    const nextA = `[a${i.toString().padStart(2, "0")}]`;
    filters.push(`${vLabel}[${i}:v]xfade=transition=fade:duration=${fadeDur}:offset=${offset.toFixed(3)}${nextV}`);
    filters.push(`${aLabel}[${i}:a]acrossfade=d=${fadeDur}:c1=tri:c2=tri${nextA}`);
    vLabel = nextV;
    aLabel = nextA;
    acc += durations[i]! - fadeDur;
  }
  const filterComplex = filters.join("; ");

  const args = [
    "-y",
    ...inputs,
    "-filter_complex", filterComplex,
    "-map", vLabel,
    "-map", aLabel,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level", "4.0",
    "-crf", "22",
    "-preset", "fast",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outPath,
  ];
  console.log(`[stitch] xfade chain ${clips.length} clips, fade=${fadeDur}s → ${outPath}`);
  console.log(`[stitch] filter_complex: ${filterComplex.slice(0, 300)}${filterComplex.length > 300 ? "…" : ""}`);
  const r = spawnSync("ffmpeg", args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error("ffmpeg xfade failed");
}

function main() {
  const project = parseProject();
  const noXfade = process.argv.includes("--no-xfade");
  const fadeDurIdx = process.argv.indexOf("--fade");
  const fadeDur = fadeDurIdx !== -1 ? parseFloat(process.argv[fadeDurIdx + 1]!) : 0.4;

  const cfg = yaml.load(
    readFileSync(join(ROOT, "script", "projects", `${project}.yaml`), "utf-8"),
  ) as { segments: string[] };

  const clips: string[] = [];
  const missing: string[] = [];
  for (const id of cfg.segments) {
    const p = join(ROOT, "out", project, `${id}.mp4`);
    if (existsSync(p)) clips.push(p);
    else missing.push(id);
  }
  if (missing.length) {
    console.warn(`[stitch] skipping missing: ${missing.join(", ")}`);
  }
  if (clips.length === 0) throw new Error("nothing to stitch");

  const outDir = join(ROOT, "out", project);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "_full-draft.mp4");
  const listPath = join(outDir, "_concat.txt");

  if (noXfade || clips.length === 1) {
    runConcatStitch(clips, outPath, listPath);
  } else {
    runXfadeStitch(clips, outPath, fadeDur);
  }

  console.log(`\n[stitch] project=${project}: ${clips.length} clips → ${outPath}`);
}

main();
