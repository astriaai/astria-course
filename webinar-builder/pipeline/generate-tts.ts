/**
 * Inworld-1.5-mini TTS via WaveSpeed.
 *
 * Takes narration text + voice_id → mp3 at assets/audio/<segment-id>.mp3.
 * Deterministic cache: key = hash(text + voice_id + speaking_rate).
 *
 *   tsx pipeline/generate-tts.ts <segment-id>
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const INWORLD_ENDPOINT =
  "https://api.wavespeed.ai/api/v3/inworld/inworld-1.5-mini/text-to-speech";

interface SegmentYaml {
  id: string;
  narration: string;
  avatar?: { voice_id?: string; speaking_rate?: number };
}
interface WebinarYaml {
  defaults: {
    tts?: { provider?: "inworld"; voice_id?: string; speaking_rate?: number };
  };
}

function loadProject(project: string): WebinarYaml {
  return yaml.load(
    readFileSync(join(ROOT, "script", "projects", `${project}.yaml`), "utf-8"),
  ) as WebinarYaml;
}
function loadSegment(project: string, id: string): SegmentYaml {
  return yaml.load(
    readFileSync(join(ROOT, "script", "segments", project, `${id}.yaml`), "utf-8")
  ) as SegmentYaml;
}

function cacheKey(text: string, voice: string, rate: number) {
  const h = createHash("sha256");
  h.update(text.trim());
  h.update("|");
  h.update(voice);
  h.update("|");
  h.update(String(rate));
  return h.digest("hex").slice(0, 12);
}

async function submit(text: string, voice: string, rate: number): Promise<string> {
  const apiKey = process.env.WAVESPEED_API_KEY;
  if (!apiKey) throw new Error("WAVESPEED_API_KEY not set");

  const res = await fetch(INWORLD_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      text,
      voice_id: voice,
      speaking_rate: rate,
      temperature: 1,
    }),
  });
  if (!res.ok) throw new Error(`Inworld submit failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { urls: { get: string } } };
  return json.data.urls.get;
}

async function poll(resultUrl: string): Promise<string> {
  const apiKey = process.env.WAVESPEED_API_KEY!;
  const deadline = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(resultUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Inworld poll failed: ${res.status}`);
    const json = (await res.json()) as {
      data: { status: string; outputs: string[]; error?: string };
    };
    if (json.data.status === "completed" && json.data.outputs[0]) return json.data.outputs[0];
    if (json.data.status === "failed") throw new Error(`Inworld job failed: ${json.data.error}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Inworld poll timeout");
}

async function download(url: string, dest: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export interface InworldResult {
  localPath: string;  // assets/audio/<id>.mp3 (for composition <audio>)
  url: string;        // WaveSpeed cloudfront URL (for OmniHuman input)
}

export async function generateInworldAudio(project: string, segmentId: string): Promise<InworldResult> {
  const projectCfg = loadProject(project);
  const segment = loadSegment(project, segmentId);

  const voice = segment.avatar?.voice_id ?? projectCfg.defaults.tts?.voice_id ?? "Hades";
  const rate = segment.avatar?.speaking_rate ?? projectCfg.defaults.tts?.speaking_rate ?? 1;

  const audioDir = join(ROOT, "assets", "audio", project);
  mkdirSync(audioDir, { recursive: true });
  const key = cacheKey(segment.narration, voice, rate);
  const cached = join(audioDir, `${segmentId}.${key}.mp3`);
  const urlFile = join(audioDir, `${segmentId}.${key}.url.txt`);
  const active = join(audioDir, `${segmentId}.mp3`);

  if (existsSync(cached) && existsSync(urlFile)) {
    writeFileSync(active, readFileSync(cached));
    const url = readFileSync(urlFile, "utf-8").trim();
    console.log(`[tts] ${segmentId}: cache hit (${key})`);
    return { localPath: active, url };
  }

  console.log(`[tts] ${segmentId}: Inworld ${voice} rate=${rate}`);
  const resultUrl = await submit(segment.narration, voice, rate);
  const audioUrl = await poll(resultUrl);
  await download(audioUrl, cached);
  writeFileSync(urlFile, audioUrl);
  writeFileSync(active, readFileSync(cached));
  console.log(`[tts] ${segmentId}: saved ${cached}`);
  return { localPath: active, url: audioUrl };
}

// CLI
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
    console.error("Usage: tsx pipeline/generate-tts.ts [--project <name>] <segment-id>");
    process.exit(1);
  }
  generateInworldAudio(project, id)
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
