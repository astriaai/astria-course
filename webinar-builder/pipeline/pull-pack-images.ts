/**
 * Pull every generated image from the America Basics e-commerce packs into
 *   assets/artboard/<project>/pack-images/<pack-slug>/
 * so the music video is cut from the real campaign, not synthetic prompts.
 *
 *   tsx pipeline/pull-pack-images.ts [--manifest <path>]
 *
 * Pack metadata is read through the Astria CLI (`astria api GET /p/<slug>`),
 * which carries its own auth. Images are cached — reruns skip existing files.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface Manifest {
  project: string;
  packs: string[];
}
interface Pack {
  id: number;
  title: string;
  prompts_per_class: Record<string, { id: number; images: string[] }[]>;
}

/** Resolve the astria CLI from PATH. */
function astriaCli(): string {
  try {
    execFileSync("astria", ["--version"], { stdio: "ignore" });
    return "astria";
  } catch {
    throw new Error("astria CLI not found on PATH");
  }
}

function sniffExt(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return "webp";
  return "jpg";
}

async function download(url: string, destNoExt: string): Promise<void> {
  for (const e of ["jpg", "png", "webp"]) if (existsSync(`${destNoExt}.${e}`)) return;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`\n  ! ${url} → ${res.status}`);
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(`${destNoExt}.${sniffExt(buf)}`, buf);
}

async function mapPool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

async function main(): Promise<void> {
  const mi = process.argv.indexOf("--manifest");
  const manifestPath = resolve(mi !== -1 ? process.argv[mi + 1]! : "script/music-videos/america-basics.yaml");
  const manifest = yaml.load(readFileSync(manifestPath, "utf-8")) as Manifest;
  const cli = astriaCli();
  const baseDir = join(ROOT, "assets", "artboard", manifest.project, "pack-images");

  let grandTotal = 0;
  for (const slug of manifest.packs) {
    const raw = execFileSync(cli, ["api", "GET", `/p/${slug}`], {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const pack = JSON.parse(raw) as Pack;
    const dir = join(baseDir, slug);
    mkdirSync(dir, { recursive: true });

    const jobs: { url: string; dest: string }[] = [];
    for (const prompts of Object.values(pack.prompts_per_class)) {
      for (const p of prompts) {
        p.images.forEach((url, idx) => jobs.push({ url, dest: join(dir, `p${p.id}-${idx + 1}`) }));
      }
    }
    console.log(`[packs] ${slug} (pack ${pack.id} "${pack.title}"): ${jobs.length} images`);

    let done = 0;
    await mapPool(jobs, 8, async (j) => {
      await download(j.url, j.dest);
      process.stdout.write(`\r[packs] ${slug}: ${++done}/${jobs.length}   `);
    });
    process.stdout.write("\n");
    grandTotal += jobs.length;
  }
  console.log(`[packs] done — ${grandTotal} images → ${baseDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
