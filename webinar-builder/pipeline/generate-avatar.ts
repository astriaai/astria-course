/**
 * HeyGen Avatar IV client with Inworld-audio lipsync support.
 *
 *   tsx pipeline/generate-avatar.ts <segment-id>         — avatar via HeyGen voice
 *   tsx pipeline/generate-avatar.ts <segment-id> --audio assets/audio/xxx.mp3
 *                                                        — avatar lipsynced to pre-generated audio
 *
 * Cache key: hash(narration + avatar_id + voice_id|audioHash + emotion).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const HEYGEN_V2 = "https://api.heygen.com/v2";
const HEYGEN_V1 = "https://api.heygen.com/v1";
const HEYGEN_UPLOAD = "https://upload.heygen.com/v1/asset";

interface SegmentYaml {
  id: string;
  narration: string;
  avatar?: { avatar_id?: string; voice_id?: string; emotion?: string; image_url?: string };
}
interface WebinarYaml {
  defaults: {
    avatar: { avatar_id: string; voice_id: string; emotion: string };
  };
}

const loadProject = (project: string) =>
  yaml.load(
    readFileSync(join(ROOT, "script", "projects", `${project}.yaml`), "utf-8"),
  ) as WebinarYaml;
const loadSegment = (project: string, id: string) =>
  yaml.load(
    readFileSync(join(ROOT, "script", "segments", project, `${id}.yaml`), "utf-8"),
  ) as SegmentYaml;

function resolveConfig(segment: SegmentYaml, webinar: WebinarYaml) {
  return {
    avatar_id: segment.avatar?.avatar_id ?? webinar.defaults.avatar.avatar_id,
    voice_id: segment.avatar?.voice_id ?? webinar.defaults.avatar.voice_id,
    emotion: segment.avatar?.emotion ?? webinar.defaults.avatar.emotion,
    image_url: segment.avatar?.image_url,
  };
}

async function createTalkingPhoto(apiKey: string, imageUrl: string): Promise<string> {
  // Download the image → upload to HeyGen's talking-photo endpoint.
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`fetch image failed: ${imgRes.status}`);
  const imgBytes = Buffer.from(await imgRes.arrayBuffer());
  const contentType = imgRes.headers.get("content-type") || "image/jpeg";

  const res = await fetch("https://upload.heygen.com/v1/talking_photo", {
    method: "POST",
    headers: { "X-Api-Key": apiKey, "Content-Type": contentType },
    body: imgBytes,
  });
  if (!res.ok) throw new Error(`HeyGen talking_photo failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { talking_photo_id?: string; id?: string } };
  const id = json.data.talking_photo_id ?? json.data.id;
  if (!id) throw new Error(`HeyGen talking_photo returned no id: ${JSON.stringify(json)}`);
  return id;
}

function hashFile(path: string) {
  const h = createHash("sha256");
  h.update(readFileSync(path));
  return h.digest("hex").slice(0, 12);
}

function cacheKey(
  narration: string,
  cfg: { avatar_id: string; voice_id: string; emotion: string; image_url?: string },
  audioPath?: string
) {
  const h = createHash("sha256");
  h.update(narration.trim());
  h.update("|");
  h.update(cfg.image_url ? `img:${cfg.image_url}` : cfg.avatar_id);
  h.update("|");
  h.update(audioPath ? `audio:${hashFile(audioPath)}` : cfg.voice_id);
  h.update("|");
  h.update(cfg.emotion);
  return h.digest("hex").slice(0, 12);
}

async function uploadAudio(apiKey: string, audioPath: string): Promise<string> {
  const bytes = readFileSync(audioPath);
  const contentType = audioPath.endsWith(".wav") ? "audio/wav" : "audio/mpeg";
  const res = await fetch(HEYGEN_UPLOAD, {
    method: "POST",
    headers: { "X-Api-Key": apiKey, "Content-Type": contentType },
    body: bytes,
  });
  if (!res.ok) throw new Error(`HeyGen upload failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { id: string } };
  return json.data.id;
}

interface GenerateArgs {
  apiKey: string;
  character:
    | { type: "avatar"; avatar_id: string }
    | { type: "talking_photo"; talking_photo_id: string };
  voice: { type: "text"; input_text: string; voice_id: string } | { type: "audio"; audio_asset_id: string };
}

async function createVideo(args: GenerateArgs): Promise<string> {
  const voice =
    args.voice.type === "text"
      ? { type: "text", input_text: args.voice.input_text, voice_id: args.voice.voice_id, speed: 1.0 }
      : { type: "audio", audio_asset_id: args.voice.audio_asset_id };

  const character =
    args.character.type === "avatar"
      ? { type: "avatar", avatar_id: args.character.avatar_id, avatar_style: "normal" }
      : { type: "talking_photo", talking_photo_id: args.character.talking_photo_id };

  const res = await fetch(`${HEYGEN_V2}/video/generate`, {
    method: "POST",
    headers: { "X-Api-Key": args.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      video_inputs: [
        {
          character,
          voice,
          background: { type: "color", value: "#1E1D1C" },
        },
      ],
      dimension: { width: 1080, height: 1920 },
      aspect_ratio: "9:16",
    }),
  });
  if (!res.ok) throw new Error(`HeyGen create failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { video_id: string } };
  return json.data.video_id;
}

async function poll(apiKey: string, videoId: string) {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(`${HEYGEN_V1}/video_status.get?video_id=${videoId}`, {
      headers: { "X-Api-Key": apiKey },
    });
    if (!res.ok) throw new Error(`HeyGen poll failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as {
      data: { status: string; video_url?: string; error?: unknown };
    };
    process.stdout.write(`\r[avatar] status=${json.data.status}           `);
    if (json.data.status === "completed" && json.data.video_url) {
      process.stdout.write("\n");
      return json.data.video_url;
    }
    if (json.data.status === "failed") throw new Error(`HeyGen failed: ${JSON.stringify(json.data.error)}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("HeyGen poll timeout");
}

async function download(url: string, dest: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export async function generateAvatar(project: string, segmentId: string, audioPath?: string): Promise<string> {
  const projectCfg = loadProject(project);
  const segment = loadSegment(project, segmentId);
  const cfg = resolveConfig(segment, projectCfg);

  const cacheDir = join(ROOT, "assets", "avatars", project);
  mkdirSync(cacheDir, { recursive: true });
  const key = cacheKey(segment.narration, cfg, audioPath);
  const cached = join(cacheDir, `${segmentId}.${key}.mp4`);
  const active = join(cacheDir, `${segmentId}.mp4`);

  if (existsSync(cached)) {
    writeFileSync(active, readFileSync(cached));
    console.log(`[avatar] ${segmentId}: cache hit (${key})`);
    return active;
  }

  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) throw new Error("HEYGEN_API_KEY not set");

  let voice: GenerateArgs["voice"];
  if (audioPath) {
    console.log(`[avatar] ${segmentId}: uploading audio to HeyGen (${(statSync(audioPath).size / 1024).toFixed(1)} KB)`);
    const audio_asset_id = await uploadAudio(apiKey, audioPath);
    voice = { type: "audio", audio_asset_id };
  } else {
    voice = { type: "text", input_text: segment.narration, voice_id: cfg.voice_id };
  }

  let character: GenerateArgs["character"];
  if (cfg.image_url) {
    console.log(`[avatar] ${segmentId}: creating talking_photo from ${cfg.image_url}`);
    const talking_photo_id = await createTalkingPhoto(apiKey, cfg.image_url);
    console.log(`[avatar] ${segmentId}: talking_photo_id=${talking_photo_id}`);
    character = { type: "talking_photo", talking_photo_id };
  } else {
    character = { type: "avatar", avatar_id: cfg.avatar_id };
  }

  console.log(`[avatar] ${segmentId}: requesting HeyGen (character=${character.type}, voice=${voice.type})`);
  const videoId = await createVideo({ apiKey, character, voice });
  const url = await poll(apiKey, videoId);
  console.log(`[avatar] ${segmentId}: downloading`);
  await download(url, cached);
  writeFileSync(active, readFileSync(cached));
  console.log(`[avatar] ${segmentId}: cached at ${cached}`);
  return active;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const projectIdx = process.argv.indexOf("--project");
  const project = projectIdx !== -1 ? process.argv[projectIdx + 1] : "webinar";
  const audioIdx = process.argv.indexOf("--audio");
  const audioPath = audioIdx !== -1 ? process.argv[audioIdx + 1] : undefined;
  const positional = process.argv.slice(2).filter((a, i, arr) => {
    if (a === "--project" || a === "--audio") return false;
    if (i > 0 && (arr[i - 1] === "--project" || arr[i - 1] === "--audio")) return false;
    return true;
  });
  const id = positional[0];
  if (!id) {
    console.error("Usage: tsx pipeline/generate-avatar.ts [--project <name>] <segment-id> [--audio path/to.mp3]");
    process.exit(1);
  }
  generateAvatar(project, id, audioPath).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
