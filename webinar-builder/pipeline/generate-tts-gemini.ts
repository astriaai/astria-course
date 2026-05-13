/**
 * Gemini 3.1 Flash TTS (via Google AI Studio / Gemini API, `?key=...` auth).
 *
 * Takes narration text + voice + model → mp3 at assets/audio/<segment-id>.mp3.
 * Deterministic cache: key = hash(text + voice + model).
 *
 *   tsx pipeline/generate-tts-gemini.ts <segment-id>
 *
 * Notes:
 *   - The API returns base64 PCM (signed-16 LE, 24 kHz, mono) with no WAV
 *     header. We pipe it through ffmpeg to produce mp3.
 *   - There is no hosted URL for the generated audio, so `url` is always null.
 *     OmniHuman/InfiniteTalk avatar lipsync requires a public URL, so the
 *     Gemini TTS path is voice-only (placeholder avatar or NO_AVATAR=1).
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const DEFAULT_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_VOICE = "Kore";

interface SegmentYaml {
  id: string;
  narration: string;
  avatar?: { voice_id?: string; speaking_rate?: number };
  tts?: { voice?: string; model?: string; style_prompt?: string };
}
interface WebinarYaml {
  defaults: {
    tts?: {
      provider?: "inworld" | "gemini";
      voice?: string;        // Gemini voice name (e.g. "Kore", "Puck")
      voice_id?: string;     // Inworld voice id (legacy field)
      speaking_rate?: number;
      model?: string;
      style_prompt?: string; // Prepended to narration as a delivery hint
    };
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

function cacheKey(text: string, voice: string, model: string) {
  const h = createHash("sha256");
  h.update(text.trim());
  h.update("|");
  h.update(voice);
  h.update("|");
  h.update(model);
  return h.digest("hex").slice(0, 12);
}

async function callGeminiTts(
  text: string,
  voice: string,
  model: string
): Promise<Buffer> {
  const apiKey = process.env.VERTEX_API_KEY;
  if (!apiKey) throw new Error("VERTEX_API_KEY not set");

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice },
        },
      },
    },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Gemini TTS failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
    }>;
  };
  const b64 = json.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) {
    throw new Error(`Gemini TTS: no inlineData in response: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return Buffer.from(b64, "base64");
}

/** Convert raw signed-16 LE PCM @ 24 kHz mono → MP3 via ffmpeg. */
function pcmToMp3(pcm: Buffer, outMp3: string) {
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f", "s16le",
      "-ar", "24000",
      "-ac", "1",
      "-i", "pipe:0",
      "-c:a", "libmp3lame",
      "-q:a", "2",
      outMp3,
    ],
    { input: pcm, stdio: ["pipe", "ignore", "pipe"] }
  );
  if (r.status !== 0) {
    throw new Error(`ffmpeg PCM→MP3 failed: ${r.stderr?.toString().slice(0, 400)}`);
  }
}

export interface GeminiTtsResult {
  localPath: string;
  url: null; // No hosted URL; avatar-lipsync path is not available with Gemini TTS.
}

export async function generateGeminiAudio(project: string, segmentId: string): Promise<GeminiTtsResult> {
  const projectCfg = loadProject(project);
  const segment = loadSegment(project, segmentId);

  const voice = segment.tts?.voice ?? projectCfg.defaults.tts?.voice ?? DEFAULT_VOICE;
  const model = segment.tts?.model ?? projectCfg.defaults.tts?.model ?? DEFAULT_MODEL;
  const stylePrompt = segment.tts?.style_prompt ?? projectCfg.defaults.tts?.style_prompt;
  const text = stylePrompt ? `${stylePrompt}\n\n${segment.narration}` : segment.narration;

  const audioDir = join(ROOT, "assets", "audio", project);
  mkdirSync(audioDir, { recursive: true });
  const key = cacheKey(text, voice, model);
  const cached = join(audioDir, `${segmentId}.${key}.mp3`);
  const active = join(audioDir, `${segmentId}.mp3`);

  if (existsSync(cached)) {
    writeFileSync(active, readFileSync(cached));
    console.log(`[tts-gemini] ${segmentId}: cache hit (${key})`);
    return { localPath: active, url: null };
  }

  console.log(`[tts-gemini] ${segmentId}: ${model} voice=${voice}`);
  const pcm = await callGeminiTts(text, voice, model);
  pcmToMp3(pcm, cached);
  writeFileSync(active, readFileSync(cached));
  console.log(`[tts-gemini] ${segmentId}: saved ${cached}`);
  return { localPath: active, url: null };
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
    console.error("Usage: tsx pipeline/generate-tts-gemini.ts [--project <name>] <segment-id>");
    process.exit(1);
  }
  generateGeminiAudio(project, id)
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
