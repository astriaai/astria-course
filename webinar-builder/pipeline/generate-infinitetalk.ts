/**
 * WaveSpeed InfiniteTalk avatar (regular + fast variants).
 *
 * Takes an audio URL + image URL → lipsync MP4. The regular variant supports
 * a `resolution` knob (480p, 720p); the `fast` variant runs at a fixed
 * resolution and omits the param. Cached by hash(audio+image+resolution+variant).
 *
 *   tsx pipeline/generate-infinitetalk.ts <segment-id> <audio_url> <image_url> [resolution]            # regular
 *   tsx pipeline/generate-infinitetalk.ts --fast <segment-id> <audio_url> <image_url>                  # fast
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export type InfiniteTalkVariant = "regular" | "fast";

const ENDPOINTS: Record<InfiniteTalkVariant, string> = {
  regular: "https://api.wavespeed.ai/api/v3/wavespeed-ai/infinitetalk",
  fast: "https://api.wavespeed.ai/api/v3/wavespeed-ai/infinitetalk-fast",
};

function cacheKey(audioUrl: string, imageUrl: string, resolution: string, variant: InfiniteTalkVariant, prompt: string) {
  const h = createHash("sha256");
  h.update(audioUrl);
  h.update("|");
  h.update(imageUrl);
  h.update("|");
  h.update(resolution);
  h.update("|");
  h.update(variant);
  h.update("|");
  h.update(prompt);
  return h.digest("hex").slice(0, 12);
}

async function submit(
  audioUrl: string,
  imageUrl: string,
  resolution: string,
  variant: InfiniteTalkVariant,
  prompt: string,
): Promise<string> {
  const apiKey = process.env.WAVESPEED_API_KEY;
  if (!apiKey) throw new Error("WAVESPEED_API_KEY not set");
  // Both variants accept { audio, image, mask_image, prompt, seed } per the
  // WaveSpeed playground schema. The regular variant adds `resolution`; the
  // fast endpoint silently ignores it (verified live — output is locked 480p).
  const body: Record<string, unknown> = { audio: audioUrl, image: imageUrl, seed: -1 };
  if (prompt) body.prompt = prompt;
  if (variant === "regular") body.resolution = resolution;
  const res = await fetch(ENDPOINTS[variant], {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`InfiniteTalk(${variant}) submit failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { urls: { get: string } } };
  return json.data.urls.get;
}

async function poll(resultUrl: string, onTick: (s: string) => void): Promise<string> {
  const apiKey = process.env.WAVESPEED_API_KEY!;
  const deadline = Date.now() + 20 * 60 * 1000;  // longer timeout — InfiniteTalk is slower
  while (Date.now() < deadline) {
    const res = await fetch(resultUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`InfiniteTalk poll failed: ${res.status}`);
    const json = (await res.json()) as {
      data: { status: string; outputs: string[]; error?: string };
    };
    onTick(json.data.status);
    if (json.data.status === "completed" && json.data.outputs[0]) return json.data.outputs[0];
    if (json.data.status === "failed") throw new Error(`InfiniteTalk failed: ${json.data.error}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("InfiniteTalk poll timeout");
}

async function download(url: string, dest: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export async function generateInfiniteTalk(
  project: string,
  segmentId: string,
  audioUrl: string,
  imageUrl: string,
  resolution: "480p" | "720p" = "720p",
  variant: InfiniteTalkVariant = "regular",
  prompt: string = "",
): Promise<string> {
  const avatarDir = join(ROOT, "assets", "avatars", project);
  mkdirSync(avatarDir, { recursive: true });
  const tag = variant === "fast" ? "infinitetalk-fast" : "infinitetalk";
  const key = cacheKey(audioUrl, imageUrl, resolution, variant, prompt);
  const cached = join(avatarDir, `${segmentId}.${key}.mp4`);
  const active = join(avatarDir, `${segmentId}.mp4`);

  if (existsSync(cached)) {
    writeFileSync(active, readFileSync(cached));
    console.log(`[${tag}] ${segmentId}: cache hit (${key})`);
    return active;
  }

  const promptSummary = prompt
    ? ` prompt="${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}"`
    : "";
  console.log(
    `[${tag}] ${segmentId}: submitting${variant === "regular" ? ` (resolution=${resolution})` : ""}${promptSummary}`,
  );
  const resultUrl = await submit(audioUrl, imageUrl, resolution, variant, prompt);
  const videoUrl = await poll(resultUrl, (s) =>
    process.stdout.write(`\r[${tag}] ${segmentId}: ${s}           `)
  );
  process.stdout.write("\n");
  console.log(`[${tag}] ${segmentId}: downloading`);
  await download(videoUrl, cached);
  writeFileSync(active, readFileSync(cached));
  console.log(`[${tag}] ${segmentId}: cached at ${cached}`);
  return active;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const projectIdx = process.argv.indexOf("--project");
  const project = projectIdx !== -1 ? process.argv[projectIdx + 1] : "webinar";
  const promptIdx = process.argv.indexOf("--prompt");
  const prompt = promptIdx !== -1 ? process.argv[promptIdx + 1] : "";
  const variant: InfiniteTalkVariant = process.argv.includes("--fast") ? "fast" : "regular";
  const positional = process.argv.slice(2).filter((a, i, arr) => {
    if (a === "--project" || a === "--fast" || a === "--prompt") return false;
    if (i > 0 && (arr[i - 1] === "--project" || arr[i - 1] === "--prompt")) return false;
    return true;
  });
  const [id, audio, image, resolution = "720p"] = positional;
  if (!id || !audio || !image) {
    console.error(
      "Usage: tsx pipeline/generate-infinitetalk.ts [--project <name>] [--fast] [--prompt <text>] <segment-id> <audio_url> <image_url> [480p|720p]",
    );
    process.exit(1);
  }
  generateInfiniteTalk(project, id, audio, image, resolution as "480p" | "720p", variant, prompt).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
