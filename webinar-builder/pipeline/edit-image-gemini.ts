/**
 * NanoBanana / Gemini image edit helper — via the Astria CLI.
 *
 * Sends a source image + edit prompt through `astria generate --model gemini`
 * (Astria's server-side Nano-Banana Pro) and saves the returned edited image.
 * Used standalone for one-off edits and as a building block for video projects
 * that need identity-preserving image transforms (e.g. headshot → full-body).
 *
 *   tsx pipeline/edit-image-gemini.ts \
 *     --source <local-path-or-https-url> \
 *     --prompt "<edit instruction>" \
 *     --output <path.jpg> \
 *     [--aspect-ratio 3:4] \
 *     [--upload]      # also POST to tmpfiles.org and print the public URL
 *
 * Generations run on the personal workspace. Caches by sha1(source + prompt +
 * aspect) so repeated calls are free.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const TMPFILES_ENDPOINT = "https://tmpfiles.org/api/v1/upload";

type AspectRatio = "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9" | "9:21" | "2:3" | "3:2" | "5:4" | "4:5";

export interface EditImageArgs {
  /** Local filesystem path OR https URL. */
  source: string;
  prompt: string;
  output: string;
  aspectRatio?: AspectRatio;
  /** Accepted for API compatibility; Astria's gemini pipeline ignores it. */
  temperature?: number;
}

function astriaCli(): string {
  try {
    execFileSync("astria", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    return "astria";
  } catch {
    throw new Error("astria CLI not found on PATH");
  }
}

function sha1(...inputs: Array<Buffer | string>): string {
  const h = createHash("sha1");
  for (const i of inputs) h.update(i);
  return h.digest("hex").slice(0, 16);
}

async function uploadToTmpfiles(filePath: string): Promise<string> {
  const buf = readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([buf]), basename(filePath));
  const res = await fetch(TMPFILES_ENDPOINT, {
    method: "POST",
    headers: { "User-Agent": "webinar-builder/1.0 (alon@astria.ai)" },
    body: form,
  });
  if (!res.ok) throw new Error(`tmpfiles upload failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { status: string; data?: { url?: string } };
  const pageUrl = json.data?.url;
  if (json.status !== "success" || !pageUrl) {
    throw new Error(`tmpfiles upload returned unexpected body: ${JSON.stringify(json)}`);
  }
  return pageUrl.replace("tmpfiles.org/", "tmpfiles.org/dl/");
}

export async function editImageGemini(args: EditImageArgs): Promise<{ localPath: string; cached: boolean }> {
  const { source, output, aspectRatio = "3:4" } = args;
  // Astria's API truncates prompt text at the first ';' — replace with commas.
  const prompt = args.prompt.replace(/;/g, ",");

  // Cache key — hash the local bytes when the source is a file, else the URL.
  const isUrl = /^https?:\/\//.test(source);
  const absSource = isUrl ? source : resolve(source);
  const sourceId: Buffer | string = !isUrl && existsSync(absSource) ? readFileSync(absSource) : source;
  const key = sha1(sourceId, prompt, aspectRatio);

  const cacheDir = join(ROOT, ".cache", "gemini-edits");
  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, `${key}.jpg`);
  const absOutput = resolve(output);
  mkdirSync(dirname(absOutput), { recursive: true });

  if (existsSync(cached)) {
    writeFileSync(absOutput, readFileSync(cached));
    console.log(`[edit-image-gemini] cache hit (${key}) → ${absOutput}`);
    return { localPath: absOutput, cached: true };
  }

  if (!isUrl && !existsSync(absSource)) throw new Error(`source file not found: ${absSource}`);

  console.log(`[edit-image-gemini] astria generate --model gemini aspect=${aspectRatio} src=${source.slice(0, 80)}`);
  console.log(`[edit-image-gemini] prompt: "${prompt.slice(0, 120)}${prompt.length > 120 ? "…" : ""}"`);

  const cli = astriaCli();
  const out = execFileSync(
    cli,
    [
      "generate",
      "--workspace", "personal", // keep generations off the client workspace
      "--model", "gemini",
      "--input-image", absSource,
      "--aspect-ratio", aspectRatio,
      "--num-images", "1",
      "--text", prompt,
      "--wait",
    ],
    { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`astria generate: non-JSON output: ${out.slice(0, 300)}`);
  }
  const p = (Array.isArray(parsed) ? parsed[0] : parsed) as { images?: string[]; user_error?: string };
  if (p?.user_error) throw new Error(`astria generate: ${p.user_error}`);
  const url = p.images?.[0];
  if (!url) throw new Error("astria generate: no image in response");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const outBytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(cached, outBytes);
  writeFileSync(absOutput, outBytes);
  console.log(`[edit-image-gemini] saved ${absOutput} (${outBytes.length} bytes, cache key ${key})`);

  return { localPath: absOutput, cached: false };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const flag = (name: string) => args.includes(name);

  const source = arg("--source");
  const prompt = arg("--prompt");
  const output = arg("--output");
  const aspectRatio = (arg("--aspect-ratio") as AspectRatio | undefined) ?? "3:4";
  const upload = flag("--upload");

  if (!source || !prompt || !output) {
    console.error(
      "Usage: tsx pipeline/edit-image-gemini.ts --source <path|url> --prompt <text> --output <path.jpg> [--aspect-ratio 3:4] [--upload]"
    );
    process.exit(1);
  }

  editImageGemini({ source, prompt, output, aspectRatio })
    .then(async ({ localPath, cached }) => {
      console.log(`[edit-image-gemini] done (${cached ? "cached" : "fresh"}) → ${localPath}`);
      if (upload) {
        const url = await uploadToTmpfiles(localPath);
        console.log(`[edit-image-gemini] uploaded: ${url}`);
      }
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
