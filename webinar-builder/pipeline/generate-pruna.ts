/**
 * Pruna AI p-video-avatar lipsync via Replicate.
 *
 * https://replicate.com/prunaai/p-video-avatar
 *
 * Takes a local audio file path + image URL → lipsync MP4. The audio is uploaded
 * to Replicate's files API so this works with any TTS provider (Gemini included),
 * not just ones that produce a hosted URL. Cached by hash(audio bytes + image + res).
 *
 *   tsx pipeline/generate-pruna.ts <segment-id> <audio_path> <image_url> [resolution]
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

import { replicateApiKey, uploadFileToReplicate } from "./replicate-files.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PREDICT_ENDPOINT =
  "https://api.replicate.com/v1/models/prunaai/p-video-avatar/predictions";

export type PrunaResolution = "720p" | "1080p";

function audioCacheKey(
  audioPath: string,
  imageUrl: string,
  resolution: string,
  videoPrompt: string | undefined
) {
  const bytes = readFileSync(audioPath);
  const h = createHash("sha256");
  h.update(bytes);
  h.update("|");
  h.update(imageUrl);
  h.update("|");
  h.update(resolution);
  h.update("|");
  h.update(videoPrompt ?? "");
  return h.digest("hex").slice(0, 12);
}

interface ReplicatePrediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | null;
  error?: string | null;
  urls: { get: string; cancel: string };
}

async function submit(
  audioUrl: string,
  imageUrl: string,
  resolution: PrunaResolution,
  videoPrompt: string | undefined,
  apiKey: string
): Promise<ReplicatePrediction> {
  // Only include video_prompt when set — letting Replicate fall back to its
  // own default ("The person is talking.") when the caller doesn't specify.
  const input: Record<string, unknown> = { image: imageUrl, audio: audioUrl, resolution };
  if (videoPrompt) input.video_prompt = videoPrompt;

  const res = await fetch(PREDICT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw new Error(`Pruna submit failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ReplicatePrediction;
}

async function poll(getUrl: string, onTick: (s: string) => void): Promise<string> {
  const apiKey = replicateApiKey();
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(getUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`Pruna poll failed: ${res.status}`);
    const json = (await res.json()) as ReplicatePrediction;
    onTick(json.status);
    if (json.status === "succeeded" && typeof json.output === "string") return json.output;
    if (json.status === "failed" || json.status === "canceled") {
      throw new Error(`Pruna ${json.status}: ${json.error ?? "unknown error"}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Pruna poll timeout");
}

async function download(url: string, dest: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export async function generatePruna(
  project: string,
  segmentId: string,
  audioPath: string,
  imageUrl: string,
  resolution: PrunaResolution = "720p",
  videoPrompt?: string
): Promise<string> {
  const apiKey = replicateApiKey();
  if (!existsSync(audioPath)) throw new Error(`audio file not found: ${audioPath}`);

  const avatarDir = join(ROOT, "assets", "avatars", project);
  mkdirSync(avatarDir, { recursive: true });
  const key = audioCacheKey(audioPath, imageUrl, resolution, videoPrompt);
  const cached = join(avatarDir, `${segmentId}.${key}.mp4`);
  const active = join(avatarDir, `${segmentId}.mp4`);

  if (existsSync(cached)) {
    writeFileSync(active, readFileSync(cached));
    console.log(`[pruna] ${segmentId}: cache hit (${key})`);
    return active;
  }

  const sizeKb = Math.round(statSync(audioPath).size / 1024);
  console.log(`[pruna] ${segmentId}: uploading audio (${sizeKb} KB) to Replicate`);
  const audioUrl = await uploadFileToReplicate(audioPath);
  console.log(
    `[pruna] ${segmentId}: submitting (resolution=${resolution}${
      videoPrompt ? `, prompt="${videoPrompt.slice(0, 80)}${videoPrompt.length > 80 ? "…" : ""}"` : ""
    })`
  );
  const submitted = await submit(audioUrl, imageUrl, resolution, videoPrompt, apiKey);
  const videoUrl = await poll(submitted.urls.get, (s) =>
    process.stdout.write(`\r[pruna] ${segmentId}: ${s}           `)
  );
  process.stdout.write("\n");
  console.log(`[pruna] ${segmentId}: downloading`);
  await download(videoUrl, cached);
  writeFileSync(active, readFileSync(cached));
  console.log(`[pruna] ${segmentId}: cached at ${cached}`);
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
  const [id, audio, image, resolution = "720p"] = positional;
  if (!id || !audio || !image) {
    console.error("Usage: tsx pipeline/generate-pruna.ts [--project <name>] <segment-id> <audio_path> <image_url> [720p|1080p]");
    process.exit(1);
  }
  generatePruna(project, id, audio, image, resolution as PrunaResolution).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
