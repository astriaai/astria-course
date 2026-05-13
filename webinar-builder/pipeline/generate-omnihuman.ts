/**
 * ByteDance OmniHuman avatar via WaveSpeed.
 *
 * Takes an audio URL + image URL → lipsync MP4 where the person in the image
 * appears to speak the audio. Output saved to assets/avatars/<segment-id>.mp4,
 * cached by hash(audio_url + image_url).
 *
 *   tsx pipeline/generate-omnihuman.ts <segment-id> <audio_url> <image_url>
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export type OmniHumanVersion = "v1" | "v1.5";

const OMNI_ENDPOINTS: Record<OmniHumanVersion, string> = {
  "v1": "https://api.wavespeed.ai/api/v3/bytedance/avatar-omni-human",
  "v1.5": "https://api.wavespeed.ai/api/v3/bytedance/avatar-omni-human-1.5",
};

function cacheKey(audioUrl: string, imageUrl: string, version: OmniHumanVersion) {
  const h = createHash("sha256");
  h.update(audioUrl);
  h.update("|");
  h.update(imageUrl);
  h.update("|");
  h.update(version);
  return h.digest("hex").slice(0, 12);
}

async function submit(
  audioUrl: string,
  imageUrl: string,
  version: OmniHumanVersion
): Promise<string> {
  const apiKey = process.env.WAVESPEED_API_KEY;
  if (!apiKey) throw new Error("WAVESPEED_API_KEY not set");

  const res = await fetch(OMNI_ENDPOINTS[version], {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      audio: audioUrl,
      image: imageUrl,
      enable_base64_output: false,
    }),
  });
  if (!res.ok) throw new Error(`OmniHuman submit failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { urls: { get: string } } };
  return json.data.urls.get;
}

async function poll(resultUrl: string, onTick: (s: string) => void): Promise<string> {
  const apiKey = process.env.WAVESPEED_API_KEY!;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(resultUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`OmniHuman poll failed: ${res.status}`);
    const json = (await res.json()) as {
      data: { status: string; outputs: string[]; error?: string; timings?: { inference?: number } };
    };
    onTick(json.data.status);
    if (json.data.status === "completed" && json.data.outputs[0]) return json.data.outputs[0];
    if (json.data.status === "failed") throw new Error(`OmniHuman failed: ${json.data.error}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("OmniHuman poll timeout");
}

async function download(url: string, dest: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export async function generateOmniHuman(
  project: string,
  segmentId: string,
  audioUrl: string,
  imageUrl: string,
  version: OmniHumanVersion = "v1"
): Promise<string> {
  const avatarDir = join(ROOT, "assets", "avatars", project);
  mkdirSync(avatarDir, { recursive: true });
  const key = cacheKey(audioUrl, imageUrl, version);
  const cached = join(avatarDir, `${segmentId}.${key}.mp4`);
  const active = join(avatarDir, `${segmentId}.mp4`);
  const tag = version === "v1" ? "omnihuman" : `omnihuman-${version}`;

  if (existsSync(cached)) {
    writeFileSync(active, readFileSync(cached));
    console.log(`[${tag}] ${segmentId}: cache hit (${key})`);
    return active;
  }

  console.log(`[${tag}] ${segmentId}: submitting (audio=${audioUrl.slice(0, 60)}… image=${imageUrl})`);
  const resultUrl = await submit(audioUrl, imageUrl, version);
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
  const positional = process.argv.slice(2).filter((a, i, arr) => {
    if (a === "--project") return false;
    if (i > 0 && arr[i - 1] === "--project") return false;
    return true;
  });
  const [id, audio, image, version = "v1"] = positional;
  if (!id || !audio || !image) {
    console.error("Usage: tsx pipeline/generate-omnihuman.ts [--project <name>] <segment-id> <audio_url> <image_url> [v1|v1.5]");
    process.exit(1);
  }
  generateOmniHuman(project, id, audio, image, version as OmniHumanVersion).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
