/**
 * Replicate file API — upload a local file to api.replicate.com/v1/files and
 * get back a fetchable URL. Useful when a downstream API needs an http(s)
 * audio URL but our TTS only produced a local file.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import "dotenv/config";

const FILES_ENDPOINT = "https://api.replicate.com/v1/files";

export function replicateApiKey(): string {
  const key = process.env.REPLICATE_API_KEY ?? process.env.REPLICATE_API_TOKEN;
  if (!key) throw new Error("REPLICATE_API_KEY (or REPLICATE_API_TOKEN) not set");
  return key;
}

export async function uploadFileToReplicate(filePath: string): Promise<string> {
  const buf = readFileSync(filePath);
  const form = new FormData();
  form.append("content", new Blob([buf]), basename(filePath));
  const res = await fetch(FILES_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${replicateApiKey()}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Replicate file upload failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { urls: { get: string } };
  return json.urls.get;
}
