/**
 * America Basics artboards — GPT Image 2, via the Astria CLI, turns the
 * campaign faceid tunes into a 4x4 (16-tile) cinematic storyboard, one per act.
 *
 *   tsx pipeline/generate-artboard.ts [--manifest <path>] [--act N]
 *
 * Output: assets/artboard/<project>/artboard-act<N>.jpg
 *
 * Each act's `artboard` field in the manifest is a header line + 16 numbered
 * shots (the /artboard skill format); the cast is referenced inline by
 * <faceid:ID:1.0> tune tokens. Generations run on the personal workspace.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface Act {
  id: number;
  name: string;
  /** Header line + 16 numbered shots — the gpt-image-2 storyboard prompt. */
  artboard: string;
}
interface Manifest {
  project: string;
  video: { aspect_ratio: string; artboard_resolution: string; acts: Act[] };
}

function astriaCli(): string {
  try {
    execFileSync("astria", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    return "astria";
  } catch {
    throw new Error("astria CLI not found on PATH");
  }
}

/** The artboard --text: the act's 16-shot storyboard with the quality flag appended. */
function artboardPrompt(act: Act): string {
  // Astria's API truncates prompt text at the first ';' — never let one through.
  const text = act.artboard.trim().replace(/;/g, ",");
  return text.endsWith("--gpt_quality high") ? text : `${text}\n--gpt_quality high`;
}

/** Run `astria generate --wait` and return the finished prompt object. */
function astriaGenerate(cli: string, args: string[]): { images?: string[]; user_error?: string } {
  const out = execFileSync(cli, args, { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`astria generate: non-JSON output: ${out.slice(0, 300)}`);
  }
  const p = (Array.isArray(parsed) ? parsed[0] : parsed) as { images?: string[]; user_error?: string };
  if (p?.user_error) throw new Error(`astria generate: ${p.user_error}`);
  return p;
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export async function generateArtboards(manifestPath: string, onlyAct?: number): Promise<void> {
  const m = yaml.load(readFileSync(manifestPath, "utf-8")) as Manifest;
  const v = m.video;
  const cli = astriaCli();
  const artDir = join(ROOT, "assets", "artboard", m.project);
  const cacheDir = join(ROOT, ".cache", "artboard");
  mkdirSync(artDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  const acts = onlyAct ? v.acts.filter((a) => a.id === onlyAct) : v.acts;

  for (const act of acts) {
    const prompt = artboardPrompt(act);
    const key = createHash("sha256")
      .update([prompt, v.aspect_ratio, v.artboard_resolution].join("|"))
      .digest("hex")
      .slice(0, 16);
    const cached = join(cacheDir, `${key}.jpg`);
    const out = join(artDir, `artboard-act${act.id}.jpg`);

    if (existsSync(cached)) {
      writeFileSync(out, readFileSync(cached));
      console.log(`[artboard] act ${act.id}: cache hit (${key})`);
      continue;
    }
    console.log(`[artboard] act ${act.id} "${act.name}": astria generate gpt-image-2 ${v.aspect_ratio} — waiting…`);
    const result = astriaGenerate(cli, [
      "generate",
      "--workspace", "personal", // keep generations off the client workspace
      "--model", "gpt-image-2",
      "--aspect-ratio", v.aspect_ratio,
      "--resolution", v.artboard_resolution,
      "--num-images", "1",
      "--text", prompt,
      "--wait",
    ]);
    const url = result.images?.[0];
    if (!url) throw new Error(`act ${act.id}: no image in astria response`);
    await download(url, cached);
    writeFileSync(out, readFileSync(cached));
    console.log(`[artboard] act ${act.id}: → ${out}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const mi = argv.indexOf("--manifest");
  const ai = argv.indexOf("--act");
  generateArtboards(
    resolve(mi !== -1 ? argv[mi + 1]! : "script/music-videos/america-basics.yaml"),
    ai !== -1 ? Number(argv[ai + 1]) : undefined,
  ).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
