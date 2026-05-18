/**
 * WaveSpeed minimax/music-2.6 track generator.
 *
 * Reads a music-video manifest (script/music-videos/<project>.yaml), submits
 * the `music` prompt + lyrics to WaveSpeed, polls until the song is ready,
 * downloads it, then trims to the manifest's `target_duration` with a fade-out.
 *
 *   tsx pipeline/generate-music-wavespeed.ts [--manifest script/music-videos/america-basics.yaml]
 *
 * minimax/music-2.6 has no duration knob — the raw song is usually longer than
 * we want, so the final `track.mp3` is always ffmpeg-trimmed. WaveSpeed output
 * URLs expire after 24h, so we download immediately after the poll completes.
 *
 * Env (from .env via dotenv): WAVESPEED_API_KEY.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ENDPOINT = "https://api.wavespeed.ai/api/v3/minimax/music-2.6";

interface MusicManifest {
  project: string;
  music: {
    is_instrumental?: boolean;
    target_duration?: number;
    prompt: string;
    lyrics?: string;
  };
}

function cacheKey(prompt: string, lyrics: string, instrumental: boolean): string {
  const h = createHash("sha256");
  h.update(prompt);
  h.update("|");
  h.update(lyrics);
  h.update("|");
  h.update(String(instrumental));
  return h.digest("hex").slice(0, 12);
}

async function submit(prompt: string, lyrics: string, instrumental: boolean): Promise<string> {
  const apiKey = process.env.WAVESPEED_API_KEY;
  if (!apiKey) throw new Error("WAVESPEED_API_KEY not set");
  // minimax/music-2.6 requires non-empty lyrics; supply a hum cue for instrumentals.
  const body = {
    prompt,
    lyrics: instrumental ? "[Instrumental]" : lyrics,
    is_instrumental: instrumental,
    bitrate: 256000,
    sample_rate: 44100,
  };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`music submit failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { urls: { get: string } } };
  return json.data.urls.get;
}

async function poll(resultUrl: string, onTick: (s: string) => void): Promise<string> {
  const apiKey = process.env.WAVESPEED_API_KEY!;
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(resultUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`music poll failed: ${res.status}`);
    const json = (await res.json()) as {
      data: { status: string; outputs: string[]; error?: string };
    };
    onTick(json.data.status);
    if (json.data.status === "completed" && json.data.outputs[0]) return json.data.outputs[0];
    if (json.data.status === "failed") throw new Error(`music generation failed: ${json.data.error}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("music generation poll timeout");
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function ffprobeDuration(file: string): number {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  return parseFloat(r.stdout.trim());
}

/** Trim `src` to `target` seconds with a `fade`-second fade-out → `dest`. */
function trim(src: string, dest: string, target: number, fade = 1.5): number {
  const raw = ffprobeDuration(src);
  const finalDur = Math.min(target, raw);
  const fadeStart = Math.max(0, finalDur - fade);
  const r = spawnSync(
    "ffmpeg",
    [
      "-y", "-i", src,
      "-t", String(finalDur),
      "-af", `afade=t=out:st=${fadeStart.toFixed(2)}:d=${fade}`,
      "-c:a", "libmp3lame", "-b:a", "256k",
      dest,
    ],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`ffmpeg trim failed: ${r.stderr}`);
  return finalDur;
}

export async function generateMusic(manifestPath: string): Promise<string> {
  const manifest = yaml.load(readFileSync(manifestPath, "utf-8")) as MusicManifest;
  const { project } = manifest;
  const { prompt, lyrics = "", is_instrumental = false, target_duration = 30 } = manifest.music;

  const musicDir = join(ROOT, "assets", "music", project);
  mkdirSync(musicDir, { recursive: true });
  const key = cacheKey(prompt, lyrics, is_instrumental);
  const raw = join(musicDir, `track.${key}.raw.mp3`);
  const active = join(musicDir, "track.mp3");

  if (existsSync(raw)) {
    console.log(`[music] ${project}: cache hit (${key})`);
  } else {
    console.log(`[music] ${project}: submitting (instrumental=${is_instrumental})`);
    const resultUrl = await submit(prompt, lyrics, is_instrumental);
    const audioUrl = await poll(resultUrl, (s) =>
      process.stdout.write(`\r[music] ${project}: ${s}           `),
    );
    process.stdout.write("\n");
    console.log(`[music] ${project}: downloading`);
    await download(audioUrl, raw);
  }

  const finalDur = trim(raw, active, target_duration);
  console.log(`[music] ${project}: trimmed to ${finalDur.toFixed(2)}s → ${active}`);
  return active;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--manifest");
  const manifestPath = resolve(
    i !== -1 ? process.argv[i + 1]! : "script/music-videos/america-basics.yaml",
  );
  generateMusic(manifestPath).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
