/**
 * Concat all per-segment MP4s in the order declared in
 * script/projects/<project>.yaml into a single reviewable draft:
 *   out/<project>/_full-draft.mp4
 *
 *   tsx pipeline/stitch.ts                            (default project: webinar)
 *   tsx pipeline/stitch.ts --project video-style-transfer
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

function main() {
  const project = parseProject();
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
  const listPath = join(outDir, "_concat.txt");
  writeFileSync(listPath, clips.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));

  const outPath = join(outDir, "_full-draft.mp4");

  // Two-pass: re-encode for safety (segments may have different keyframe spacings).
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c:v", "libx264",
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

  console.log(`\n[stitch] project=${project}: ${clips.length} clips → ${outPath}`);
}

main();
