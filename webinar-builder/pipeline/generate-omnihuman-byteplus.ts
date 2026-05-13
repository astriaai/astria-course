/**
 * BytePlus OmniHuman 1.5 — direct call (not via WaveSpeed).
 *
 * Uses the V4-signed cv.byteplusapi.com endpoint with req_key
 * `realman_avatar_picture_omni15_cv`. Audio is sent inline as base64 so the
 * pipeline works with any TTS provider (Gemini-default included). Image is
 * passed by URL — BytePlus fetches it server-side.
 *
 * Cached by hash(audio bytes + image url) so re-runs are free.
 *
 *   tsx pipeline/generate-omnihuman-byteplus.ts <segment-id> <audio_path> <image_url>
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

import { basename } from "node:path";

import { byteplusVisualCall } from "./byteplus-signer.js";

const PUBLIC_STASH_ENDPOINT = "https://tmpfiles.org/api/v1/upload";

async function uploadToPublicStash(audioPath: string): Promise<string> {
  // tmpfiles.org: anonymous public file host. Returns JSON
  //   { status: "success", data: { url: "https://tmpfiles.org/<id>/<file>" } }
  // The page URL embeds the file in HTML — for a direct download URL we
  // splice "/dl/" after the host so BytePlus actually fetches the bytes.
  // Files live ~1h, indexed only via the random URL.
  const buf = readFileSync(audioPath);
  const form = new FormData();
  form.append("file", new Blob([buf]), basename(audioPath));
  const res = await fetch(PUBLIC_STASH_ENDPOINT, {
    method: "POST",
    headers: { "User-Agent": "webinar-builder/1.0 (alon@astria.ai)" },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`tmpfiles.org upload failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { status: string; data?: { url?: string } };
  const pageUrl = json.data?.url;
  if (json.status !== "success" || !pageUrl) {
    throw new Error(`tmpfiles.org upload returned unexpected body: ${JSON.stringify(json)}`);
  }
  return pageUrl.replace("tmpfiles.org/", "tmpfiles.org/dl/");
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const REQ_KEY = "realman_avatar_picture_omni15_cv";

function cacheKey(audioPath: string, imageUrl: string) {
  const audioHash = createHash("sha256").update(readFileSync(audioPath)).digest("hex");
  const h = createHash("sha256");
  h.update(audioHash);
  h.update("|");
  h.update(imageUrl);
  h.update("|");
  h.update(REQ_KEY);
  return h.digest("hex").slice(0, 12);
}

interface SubmitResp {
  task_id: string;
}

interface PollResp {
  status: string;        // "in_queue" | "generating" | "done" | "failed" | …
  resp_data?: string;    // JSON-string when status === "done"
  err_msg?: string;
}

interface OutputData {
  // BytePlus serialises the actual output as a JSON string under resp_data.
  // The video field name has been observed as either video_url or simply a
  // urls array — try both rather than relying on a single shape.
  video_url?: string;
  urls?: string[];
}

async function download(url: string, dest: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export async function generateOmniHumanByteplus(
  project: string,
  segmentId: string,
  audioPath: string,
  imageUrl: string
): Promise<string> {
  if (!existsSync(audioPath)) throw new Error(`audio file not found: ${audioPath}`);

  const avatarDir = join(ROOT, "assets", "avatars", project);
  mkdirSync(avatarDir, { recursive: true });
  const key = cacheKey(audioPath, imageUrl);
  const cached = join(avatarDir, `${segmentId}.${key}.mp4`);
  const active = join(avatarDir, `${segmentId}.mp4`);

  if (existsSync(cached)) {
    writeFileSync(active, readFileSync(cached));
    console.log(`[omnihuman-byteplus] ${segmentId}: cache hit (${key})`);
    return active;
  }

  // Persist the in-flight task_id so a client-side timeout doesn't force us
  // to re-submit (which would re-pay for inference). On reentry, if the
  // cache key still matches and the task is non-terminal, resume polling.
  const taskFile = join(avatarDir, `${segmentId}.${key}.task.json`);
  let taskId: string;
  if (existsSync(taskFile)) {
    const saved = JSON.parse(readFileSync(taskFile, "utf-8")) as { task_id: string };
    taskId = saved.task_id;
    console.log(`[omnihuman-byteplus] ${segmentId}: resuming task_id=${taskId}`);
  } else {
    const sizeKb = Math.round(statSync(audioPath).size / 1024);
    console.log(`[omnihuman-byteplus] ${segmentId}: uploading audio (${sizeKb} KB) to public stash`);
    const audioUrl = await uploadToPublicStash(audioPath);
    console.log(`[omnihuman-byteplus] ${segmentId}: submitting (audio=${audioUrl}, image=${imageUrl})`);

    const submit = await byteplusVisualCall<SubmitResp>({
      action: "CVSubmitTask",
      body: {
        req_key: REQ_KEY,
        image_url: imageUrl,
        audio_url: audioUrl,
      },
    });
    if (submit.code !== 10000 || !submit.data?.task_id) {
      throw new Error(`BytePlus OmniHuman submit failed: ${JSON.stringify(submit)}`);
    }
    taskId = submit.data.task_id;
    writeFileSync(taskFile, JSON.stringify({ task_id: taskId, submitted_at: Date.now() }));
    console.log(`[omnihuman-byteplus] ${segmentId}: task_id=${taskId}`);
  }

  // BytePlus omni15 is slow — 26s of audio has been observed taking >15 min.
  // 45 min covers headroom; rerun resumes via taskFile if it times out again.
  const deadline = Date.now() + 45 * 60 * 1000;
  let videoUrl: string | undefined;
  while (Date.now() < deadline) {
    const poll = await byteplusVisualCall<PollResp>({
      action: "CVGetResult",
      body: { req_key: REQ_KEY, task_id: taskId },
    });
    if (poll.code !== 10000) {
      throw new Error(`BytePlus OmniHuman poll failed: ${JSON.stringify(poll)}`);
    }
    const status = poll.data!.status;
    process.stdout.write(`\r[omnihuman-byteplus] ${segmentId}: ${status}           `);
    if (status === "done") {
      const parsed = JSON.parse(poll.data!.resp_data ?? "{}") as OutputData;
      videoUrl = parsed.video_url ?? parsed.urls?.[0];
      if (!videoUrl) {
        throw new Error(
          `BytePlus OmniHuman returned no video URL: ${poll.data!.resp_data}`
        );
      }
      break;
    }
    if (status !== "in_queue" && status !== "generating") {
      // Terminal failure — drop the saved task pointer so a re-run starts fresh.
      try { unlinkSync(taskFile); } catch {}
      throw new Error(
        `BytePlus OmniHuman terminal status: ${status} ${poll.data!.err_msg ?? ""}`
      );
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  process.stdout.write("\n");
  if (!videoUrl) throw new Error("BytePlus OmniHuman poll timeout");

  console.log(`[omnihuman-byteplus] ${segmentId}: downloading`);
  await download(videoUrl, cached);
  writeFileSync(active, readFileSync(cached));
  // Job complete — drop the resume pointer so future cache-miss runs start fresh.
  try { unlinkSync(taskFile); } catch {}
  console.log(`[omnihuman-byteplus] ${segmentId}: cached at ${cached}`);
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
  const [id, audio, image] = positional;
  if (!id || !audio || !image) {
    console.error(
      "Usage: tsx pipeline/generate-omnihuman-byteplus.ts [--project <name>] <segment-id> <audio_path> <image_url>"
    );
    process.exit(1);
  }
  generateOmniHumanByteplus(project, id, audio, image).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
