/**
 * Orchestrator — ensures assets are fresh for requested segments, then renders.
 *
 *   tsx pipeline/build.ts --segment 03-traditional-photoshoot          (default project: webinar)
 *   tsx pipeline/build.ts --project video-style-transfer --all
 *   tsx pipeline/build.ts --project video-style-transfer --segment 02-workflow
 *
 * Projects are addressed by name. The project manifest lives at
 * `script/projects/<name>.yaml`; per-project assets and outputs are namespaced
 * under `<dir>/<project>/` (segments, audio, avatars, captures, out).
 *
 * Tier precedence (picked from env vars + segment config):
 *
 *   WAVESPEED + avatar.image_url   Inworld TTS → OmniHuman lipsync to that image   (BEST)
 *   WAVESPEED only                 Inworld TTS + placeholder avatar frame          (voice-only)
 *   HEYGEN only                    HeyGen Avatar IV (stock avatar + voice)         (fallback)
 *   neither                        macOS `say` + placeholder                       (minimum)
 *
 * Avatar engines (set per-segment via avatar.engine):
 *   omnihuman      ByteDance OmniHuman via WaveSpeed (default)
 *   infinitetalk   WaveSpeed InfiniteTalk
 *   pruna          Pruna AI p-video-avatar via Replicate (needs REPLICATE_API_TOKEN)
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
  copyFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import "dotenv/config";

import { generateInworldAudio } from "./generate-tts.js";
import { generateGeminiAudio } from "./generate-tts-gemini.js";
import { generateOmniHuman } from "./generate-omnihuman.js";
import { generateOmniHumanByteplus } from "./generate-omnihuman-byteplus.js";
import { generateInfiniteTalk } from "./generate-infinitetalk.js";
import { generatePruna } from "./generate-pruna.js";
import { generateAvatar } from "./generate-avatar.js";
import { recordScreencast } from "./record-screencast.js";
import {
  buildCaptionBeats,
  DRAFT_CAPTIONS_CSS,
  draftDurationSec,
  ensureSilentNarration,
  renderCaptionsHtml,
} from "./draft-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// hyperframes is run via npx and pinned — see runRenderWithEarlyKill. The
// version is part of the render-cache key (an engine bump invalidates it).
const HYPERFRAMES_VERSION = "0.4.9";

interface SegmentYaml {
  id: string;
  title: string;
  narration: string;
  visual:
    | "presenter-slide"
    | "screencast-pip"
    | "avatar-hero"
    | "video-showcase"
    | "tv-intro"
    | "artboard-video-review"
    | "artboard-tile-review";
  /** Override the audio-derived duration. Used for visual-only segments like the TV intro. */
  duration?: number;
  /** TV-intro layout config — full-bleed image or video with serif title lockup. */
  intro?: {
    /** Static still image used as the background. */
    background_image?: string;
    /** Looping/playing video used as the background. Takes priority over background_image. */
    background_video?: string;
    title_html: string;
    subtitle_html?: string;
  };
  showcase?: {
    // Side-by-side or stacked result videos. Used by the video-showcase
    // visual for one-off tutorial intros that lead with finished examples.
    // Each entry may be a plain path or {src, label} — label renders above
    // the pane (e.g. "DRIVING VIDEO" / "GENERATED RESULT").
    videos: Array<string | { src: string; label?: string }>;
    autoplay?: boolean;
  };
  review?: {
    videos: Array<{ src: string; label?: string; start: number; duration: number }>;
    artboards: Array<{ src: string; label?: string; start: number; duration: number }>;
    tile_beats: Array<{
      start: number;
      duration: number;
      artboard: number;
      tile: number;
      label: string;
      note?: string;
    }>;
  };
  slide?: {
    eyebrow?: string;
    title_html?: string;
    bullets?: string[];
    bullet_starts?: number[];   // seconds; index-aligned with bullets for paced reveals
    columns?: Array<{
      heading: string;
      bullets: string[];
      bullet_starts?: number[];
    }>;
  };
  screencast?: {
    mode?: "video" | "image";
    src?: string;                // image path (for mode=image, single page)
    url?: string;                // browser URL bar text
    record_script?: string;      // path to scripts/record/<project>/<id>.ts (for mode=video; metadata only)
    fallback_image?: string;     // used if the recording fails
    // Pan tween (mode=image, single page only). When set, the layout uses
    // these values instead of computing pan from image height.
    pan_seconds?: number;        // pan duration in seconds (default: duration-3)
    pan_distance?: number;       // pixels to translate up (default: max(2400, renderedHeight - viewportHeight))
    // Multi-page mode: stack several images with timed visibility, each
    // with its own partial pan. Use `pages` instead of `src` when the
    // narration walks through several screens. Pages are rendered as
    // sibling .clip elements; only the active one is visible at any time.
    pages?: Array<{
      src: string;               // image path (e.g. assets/captures/foo.png)
      start: number;             // seconds from segment start
      duration: number;          // seconds the page stays visible
      pan_seconds?: number;      // pan duration within the page window
      pan_distance?: number;     // pixels to translate up within the page window
      url?: string;              // browser URL bar text while this page is visible
    }>;
  };
  caption?: {
    eyebrow?: string;
    html?: string;
    hide_at?: number;   // seconds; fades caption out at this time (optional)
  };
  avatar?: {
    image_url?: string;
    engine?:
      | "omnihuman"
      | "omnihuman-1.5"
      | "omnihuman-1.5-byteplus"
      | "infinitetalk"
      | "infinitetalk-fast"
      | "pruna";
    resolution?: "480p" | "720p" | "1080p";
    // Pruna only — directs micro-motions, expressions, gestures.
    // Ignored by OmniHuman/InfiniteTalk (they take no prompt).
    video_prompt?: string;
  };
  // Optional SFX tracks layered onto the composition timeline. Each entry
  // becomes an <audio class="clip"> element at the given start time.
  sfx?: Array<{ src: string; start: number; duration?: number; volume?: number }>;
  // Optional override of the project-level music bed for this segment.
  music?: { src: string; volume?: number } | null;
  // Optional gain for the primary narration track; useful when SFX share a beat.
  narration_volume?: number;
  // Optional pool of background videos to loop behind the foreground content.
  // Used by video-showcase / presenter-slide via their .bg-layer container.
  // Falls back to project defaults.background_videos.
  background_videos?: string[];
  // Marker highlights overlayed on the screencast viewport. Coordinates are
  // in source-video space (1600×900 for our Playwright captures); the SVG
  // overlay uses object-fit:contain so coordinates map 1:1 to recording px.
  markers?: Array<{
    start: number;
    duration: number;
    shape: "circle" | "underline" | "arrow";
    cx: number;
    cy: number;
    r?: number;
    w?: number;
    h?: number;
    style?: "luxe-gold" | "luxe-cream";
  }>;
}
interface ProjectYaml {
  segments: string[];
  defaults?: {
    tts?: { provider?: "inworld" | "gemini" };
    avatar?: {
      image_url?: string;
      engine?: NonNullable<SegmentYaml["avatar"]>["engine"];
      resolution?: NonNullable<SegmentYaml["avatar"]>["resolution"];
      video_prompt?: string;
    };
    music?: { src: string; volume?: number };
    background_videos?: string[];
  };
}

function parseProject(): string {
  const idx = process.argv.indexOf("--project");
  return idx !== -1 ? process.argv[idx + 1] : "webinar";
}

const loadProject = (project: string) =>
  yaml.load(
    readFileSync(join(ROOT, "script", "projects", `${project}.yaml`), "utf-8"),
  ) as ProjectYaml;
const loadSegment = (project: string, id: string) =>
  yaml.load(
    readFileSync(join(ROOT, "script", "segments", project, `${id}.yaml`), "utf-8"),
  ) as SegmentYaml;

function run(cmd: string, args: string[], cwd = ROOT) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}`);
}

/**
 * Create a per-segment render directory at `.work/<segmentId>/` that mirrors
 * the project root via symlinks. Each segment gets its own `index.html` so
 * parallel builds can't race on a shared file. Read-only inputs (assets/,
 * hyperframes.json, meta.json) are symlinked; the composition HTML is
 * written per-segment.
 */
function ensureWorkDir(segmentId: string): string {
  const dir = join(ROOT, ".work", segmentId);
  mkdirSync(dir, { recursive: true });

  // Targets that need to resolve from the rendered HTML. Symlinks instead
  // of copies — assets are large and these are read-only.
  const links = ["assets", "hyperframes.json", "meta.json", "compositions"];
  // Windows: file symlinks require admin / Developer Mode. Use junctions for
  // directories (absolute path, no privilege) and plain copies for small JSON
  // files. POSIX keeps the original relative symlink.
  const isWindows = process.platform === "win32";
  for (const name of links) {
    const src = join(ROOT, name);
    if (!existsSync(src)) continue;
    const dest = join(dir, name);
    try {
      // Refresh stale links/copies (handles the case where target moved).
      if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false } as any)) {
        unlinkSync(dest);
      }
    } catch {}
    if (isWindows) {
      if (statSync(src).isDirectory()) {
        symlinkSync(resolve(src), dest, "junction");
      } else {
        copyFileSync(src, dest);
      }
    } else {
      const rel = name.includes("/") ? resolve(src) : join("..", "..", name);
      symlinkSync(rel, dest);
    }
  }
  return dir;
}

/**
 * Run `hyperframes render` but terminate the child as soon as it prints
 * "Render complete". The Node process hangs after the mp4 is fully written
 * (likely a Chromium worker cleanup bug in hyperframes 0.4.6); waiting for
 * a natural exit adds 30–90 s per build. By the time we see the completion
 * line the mp4 is flushed — a 1 s grace then SIGTERM is safe.
 */
function runRenderWithEarlyKill(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // shell: true so Windows resolves the npx.cmd shim. POSIX is unaffected.
    const child = spawn("npx", args, { cwd: ROOT, shell: true });
    let completed = false;
    let killTimer: NodeJS.Timeout | null = null;
    const onData = (buf: Buffer) => {
      const s = buf.toString();
      process.stdout.write(s);
      if (!completed && s.includes("Render complete")) {
        completed = true;
        killTimer = setTimeout(() => {
          try { process.kill(child.pid!, "SIGTERM"); } catch {}
          setTimeout(() => { try { process.kill(child.pid!, "SIGKILL"); } catch {} }, 4000).unref();
        }, 1000);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (b) => process.stderr.write(b));
    child.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (completed || code === 0) return resolve();
      reject(new Error(`hyperframes render exited with code=${code} signal=${signal}`));
    });
    child.on("error", reject);
  });
}

function ffprobeDuration(file: string): number {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf-8" }
  );
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}`);
  return parseFloat(r.stdout.trim());
}

function mp3FileToDataUri(path: string): string {
  const b64 = readFileSync(path).toString("base64");
  return `data:audio/mp3;base64,${b64}`;
}

/**
 * Resolve an avatar `image_url` to something the lipsync APIs accept. An
 * http(s) URL passes through; a repo-relative path is inlined as a base64
 * data URI so the presenter source can live in-repo with no dependency on an
 * external image host. OmniHuman / InfiniteTalk both accept a data URI.
 */
function resolveAvatarImage(imageRef: string): string {
  if (/^(https?:|data:)/.test(imageRef)) return imageRef;
  const abs = resolve(ROOT, imageRef);
  if (!existsSync(abs)) throw new Error(`avatar image_url not found: ${imageRef}`);
  const ext = abs.toLowerCase().endsWith(".png") ? "png" : "jpeg";
  return `data:image/${ext};base64,${readFileSync(abs).toString("base64")}`;
}

function sanitizeForSay(text: string) {
  return text.replace(/[—–]/g, " - ").replace(/["']/g, "").replace(/\s+/g, " ").trim();
}

function ensureSayNarration(project: string, segmentId: string, narration: string) {
  const audioDir = join(ROOT, "assets", "audio", project);
  mkdirSync(audioDir, { recursive: true });
  const aiff = join(audioDir, `${segmentId}.aiff`);
  const mp3 = join(audioDir, `${segmentId}.mp3`);
  const segFile = join(ROOT, "script", "segments", project, `${segmentId}.yaml`);
  const stale = !existsSync(mp3) || statSync(segFile).mtimeMs > statSync(mp3).mtimeMs;
  if (!stale) {
    console.log(`[say] ${segmentId}: narration cached`);
    return mp3;
  }
  // macOS `say` is the local-dev fallback and has no Linux equivalent. CI must
  // either run DRAFT (silent placeholder audio) or supply a TTS API key —
  // fail loudly here instead of with an opaque `spawn say ENOENT`.
  if (process.platform !== "darwin") {
    throw new Error(
      `[say] ${segmentId}: macOS \`say\` is unavailable on ${process.platform}. ` +
        `Run with DRAFT=1, or set a TTS API key (VERTEX_API_KEY / WAVESPEED_API_KEY / HEYGEN_API_KEY).`,
    );
  }
  console.log(`[say] ${segmentId}: running macOS say`);
  run("say", ["-v", "Daniel", "-r", "175", "-o", aiff, sanitizeForSay(narration)]);
  run("ffmpeg", ["-y", "-i", aiff, "-c:a", "libmp3lame", "-q:a", "2", mp3]);
  return mp3;
}

function pickScreencastMedia(project: string, segment: SegmentYaml): string | undefined {
  const s = segment.screencast;
  if (!s) return undefined;
  const recordedMp4 = join("assets", "captures", project, `${segment.id}.mp4`);
  const absMp4 = join(ROOT, recordedMp4);
  if (s.mode === "video" && existsSync(absMp4)) return recordedMp4;
  return s.src ?? s.fallback_image;
}

function avatarMediaHtml(project: string, segmentId: string, hasAvatar: boolean) {
  if (hasAvatar) {
    return `<video muted playsinline src="assets/avatars/${project}/${segmentId}.mp4" style="width:100%;height:100%;object-fit:cover;display:block;"></video>`;
  }
  return `<style>#seg-avatar{display:none!important}</style>`;
}

function renderLayout(project: string, projectCfg: ProjectYaml, segment: SegmentYaml, hasAvatar: boolean, audioSrc: string, durationSec: number): string {
  const layoutPath = join(ROOT, "layouts", `${segment.visual}.html`);
  let html = readFileSync(layoutPath, "utf-8");

  const draftMode = process.env.DRAFT === "1";
  // In draft mode, inject burn-in captions so the segment is watchable without narration.
  let captionsCss = "";
  let captionsHtml = "";
  let captionsGsap = "";
  if (draftMode && segment.narration) {
    const beats = buildCaptionBeats(segment.narration, durationSec);
    const rendered = renderCaptionsHtml(beats);
    captionsCss = DRAFT_CAPTIONS_CSS;
    captionsHtml = rendered.html;
    captionsGsap = rendered.gsap;
  }

  // SFX layer — additional <audio class="clip"> tracks at staggered start times.
  // Each entry from segment.sfx[] becomes one element; data-volume defaults to 0.6,
  // data-duration defaults to 2s (long enough for ~0.6s whoosh plus headroom).
  const sfxList = segment.sfx ?? [];
  const sfxAudiosHtml = sfxList
    .map((s, i) => {
      const start = s.start.toFixed(2);
      const dur = (s.duration ?? 2).toFixed(2);
      const vol = (s.volume ?? 0.6).toFixed(2);
      return `<audio id="sfx-${segment.id}-${i}" class="clip" data-start="${start}" data-duration="${dur}" data-track-index="${20 + i}" data-volume="${vol}" src="${s.src}"></audio>`;
    })
    .join("\n      ");

  // Music bed — single track looped under everything. Segment override wins;
  // null explicitly disables. Project default fills in otherwise.
  let musicAudioHtml = "";
  if (segment.music !== null) {
    const music = segment.music ?? projectCfg.defaults?.music;
    if (music?.src) {
      const vol = (music.volume ?? 0.12).toFixed(2);
      musicAudioHtml = `<audio id="seg-music-${segment.id}" class="clip" data-start="0" data-duration="${durationSec.toFixed(2)}" data-track-index="9" data-volume="${vol}" src="${music.src}" loop></audio>`;
    }
  }

  // Background b-roll videos (used by video-showcase / presenter-slide).
  const bgVideos = segment.background_videos ?? projectCfg.defaults?.background_videos ?? [];
  const bgLayerHtml = bgVideos.length
    ? `<div class="bg-layer" aria-hidden="true">\n        ` +
      bgVideos
        .map(
          (src, i) =>
            `<video id="bg-video-${segment.id}-${i}" class="bg-tile clip" data-start="0" data-duration="${durationSec.toFixed(
              2,
            )}" data-track-index="${30 + i}" data-volume="0" muted playsinline autoplay loop src="${src}"></video>`,
        )
        .join("\n        ") +
      `\n      </div>`
    : "";

  const vars: Record<string, string> = {
    DURATION: durationSec.toFixed(2),
    AUDIO_SRC: audioSrc,
    NARRATION_VOLUME: (segment.narration_volume ?? 1).toFixed(2),
    AVATAR_MEDIA: avatarMediaHtml(project, segment.id, hasAvatar),
    CAPTIONS_CSS: captionsCss,
    CAPTIONS_HTML: captionsHtml,
    CAPTIONS_GSAP: captionsGsap,
    SFX_AUDIOS_HTML: sfxAudiosHtml,
    MUSIC_AUDIO_HTML: musicAudioHtml,
    BG_LAYER_HTML: bgLayerHtml,
    ROOT_CLASS: bgLayerHtml ? "has-bg-layer" : "",
  };

  if (segment.visual === "presenter-slide" || segment.visual === "avatar-hero") {
    let slideBulletIndex = 0;
    const renderList = (items: string[], starts?: number[]) =>
      items
        .map((b, i) => {
          const t = starts?.[i];
          const id = `${segment.id}-slide-bullet-${slideBulletIndex++}`;
          const attr =
            typeof t === "number"
              ? ` id="${id}" class="clip" data-start="${t.toFixed(2)}" data-duration="${(durationSec - t).toFixed(2)}" data-track-index="${60 + slideBulletIndex}"`
              : "";
          return `<li${attr}>${b}</li>`;
        })
        .join("\n              ");

    const columns = segment.slide?.columns;
    let body: string;
    let totalBullets: number;
    if (columns && columns.length > 0) {
      body =
        `<div class="slide-columns">\n` +
        columns
          .map(
            (col) =>
              `          <div class="slide-column">\n` +
              `            <h2 class="column-heading">${col.heading}</h2>\n` +
              `            <ul class="slide-bullets">\n              ${renderList(col.bullets, col.bullet_starts)}\n            </ul>\n` +
              `          </div>`
          )
          .join("\n") +
        `\n        </div>`;
      totalBullets = columns.reduce((n, c) => n + c.bullets.length, 0);
    } else {
      const bulletList = segment.slide?.bullets ?? [];
      body = `<ul class="slide-bullets" id="slide-bullets">\n              ${renderList(bulletList, segment.slide?.bullet_starts)}\n            </ul>`;
      totalBullets = bulletList.length;
    }

    vars.SLIDE_EYEBROW = segment.slide?.eyebrow ?? "";
    vars.SLIDE_TITLE_HTML = segment.slide?.title_html ?? segment.title;
    vars.SLIDE_BODY_HTML = body;
    // Automatic density: 6+ bullets (total across columns) trigger compact typography.
    vars.SLIDE_FRAME_CLASS = totalBullets >= 6 ? "dense" : "";
  } else if (segment.visual === "video-showcase") {
    const videos = segment.showcase?.videos ?? [];
    if (videos.length === 0) {
      throw new Error(`segment ${segment.id}: video-showcase requires showcase.videos[]`);
    }
    vars.SHOWCASE_VIDEOS_HTML = videos
      .map((entry, i) => {
        const src = typeof entry === "string" ? entry : entry.src;
        const label = typeof entry === "string" ? undefined : entry.label;
        const labelHtml = label
          ? `<div class="showcase-label">${label}</div>`
          : "";
        // Stills (jpg/png/webp/avif) render as <img>; videos as autoplay <video>.
        // Same .showcase-video class so the layout sizing/styling is identical.
        const isStill = /\.(jpe?g|png|webp|avif|gif)$/i.test(src);
        const mediaHtml = isStill
          ? `<img class="showcase-video" id="showcase-media-${i}" src="${src}" alt="" />`
          : `<video class="showcase-video" id="showcase-media-${i}" data-volume="0" muted playsinline autoplay loop src="${src}"></video>`;
        return (
          `<div class="showcase-pane clip" data-start="0" data-duration="${durationSec.toFixed(
            2,
          )}" data-track-index="${1 + i}">\n` +
          `          ${labelHtml}\n` +
          `          ${mediaHtml}\n` +
          `        </div>`
        );
      })
      .join("\n        ");
    vars.CAPTION_EYEBROW = segment.caption?.eyebrow ?? "";
    vars.CAPTION_HTML = segment.caption?.html ?? "";
    // No avatar / no PIP variant for this layout.
    vars.AVATAR_MEDIA = "";
  } else if (segment.visual === "tv-intro") {
    const intro = segment.intro;
    const bgSrc = intro?.background_video ?? intro?.background_image;
    if (!bgSrc || !intro?.title_html) {
      throw new Error(`segment ${segment.id}: tv-intro requires intro.background_image or intro.background_video, plus intro.title_html`);
    }
    vars.INTRO_BG_MEDIA = intro?.background_video
      ? `<video id="intro-bg-media" muted playsinline autoplay loop data-volume="0" src="${intro.background_video}"></video>`
      : `<img id="intro-bg-media" src="${intro!.background_image}" alt="" />`;
    vars.INTRO_TITLE_HTML = intro.title_html;
    vars.INTRO_SUBTITLE_HTML = intro.subtitle_html ?? "";
    vars.AVATAR_MEDIA = "";
  } else if (segment.visual === "artboard-video-review") {
    const review = segment.review;
    if (!review?.videos?.length || !review.artboards?.length || !review.tile_beats?.length) {
      throw new Error(`segment ${segment.id}: artboard-video-review requires review.videos, review.artboards, and review.tile_beats`);
    }
    vars.REVIEW_VIDEO_HTML = review.videos
      .map((v, i) => {
        const label = v.label ? `<div class="review-label">${v.label}</div>` : "";
        return (
          `<div class="review-video-shell clip" data-start="${v.start.toFixed(2)}" data-duration="${v.duration.toFixed(
            2,
          )}" data-track-index="${2 + i}">\n` +
          `          ${label}\n` +
          `          <video class="review-video" muted playsinline autoplay loop data-volume="0" src="${v.src}"></video>\n` +
          `        </div>`
        );
      })
      .join("\n        ");
    vars.REVIEW_ARTBOARDS_HTML = review.artboards
      .map((a, i) => {
        const label = a.label ? `<div class="board-label">${a.label}</div>` : "";
        return (
          `<div class="board-layer clip" data-board-index="${i}" data-start="${a.start.toFixed(2)}" data-duration="${a.duration.toFixed(
            2,
          )}" data-track-index="${80 + i}">\n` +
          `          ${label}\n` +
          `          <img class="board-image" src="${a.src}" alt="" />\n` +
          `        </div>`
        );
      })
      .join("\n        ");
    vars.REVIEW_BEATS_JSON = JSON.stringify(review.tile_beats);
    vars.CAPTION_EYEBROW = segment.caption?.eyebrow ?? "";
    vars.CAPTION_HTML = segment.caption?.html ?? "";
    vars.AVATAR_MEDIA = "";
  } else if (segment.visual === "artboard-tile-review") {
    const review = segment.review;
    if (!review?.artboards?.length || !review.tile_beats?.length) {
      throw new Error(`segment ${segment.id}: artboard-tile-review requires review.artboards and review.tile_beats`);
    }
    vars.REVIEW_ARTBOARDS_HTML = review.artboards
      .map((a, i) => {
        const label = a.label ? `<div class="board-label">${a.label}</div>` : "";
        return (
          `<div class="board-layer clip" data-board-index="${i}" data-start="${a.start.toFixed(2)}" data-duration="${a.duration.toFixed(
            2,
          )}" data-track-index="${80 + i}">\n` +
          `          ${label}\n` +
          `          <img class="board-image" src="${a.src}" alt="" />\n` +
          `        </div>`
        );
      })
      .join("\n        ");
    vars.REVIEW_BEATS_JSON = JSON.stringify(review.tile_beats);
    vars.CAPTION_EYEBROW = segment.caption?.eyebrow ?? "";
    vars.CAPTION_HTML = segment.caption?.html ?? "";
    vars.AVATAR_MEDIA = "";
  } else if (segment.visual === "screencast-pip") {
    const screencastMediaPath = pickScreencastMedia(project, segment);
    if (screencastMediaPath?.endsWith(".mp4")) {
      vars.SCREENCAST_MEDIA = `<video id="seg-screencast" muted playsinline autoplay src="${screencastMediaPath}"></video>`;
    } else if (segment.screencast?.pages && segment.screencast.pages.length > 0) {
      // Multi-page: each page is a .clip <img> with timed visibility, plus
      // optional per-page pan attributes the layout reads on activation.
      vars.SCREENCAST_MEDIA = segment.screencast.pages
        .map((p, i) => {
          const panAttrs =
            (p.pan_seconds !== undefined ? ` data-pan-seconds="${p.pan_seconds}"` : "") +
            (p.pan_distance !== undefined ? ` data-pan-distance="${p.pan_distance}"` : "");
          const urlAttr = p.url ? ` data-url="${p.url.replace(/"/g, "&quot;")}"` : "";
          // Page opts into scroll mode (overflow + GSAP pan) when pan_distance
          // is set and > 0. Default is object-fit:contain — for individual
          // product photos that should fit the viewport without cropping.
          const scrollAttr = (p.pan_distance ?? 0) > 0 ? ` data-scroll="1"` : "";
          return `<img class="clip seg-screenshot-page" id="seg-screenshot-${i}" src="${p.src}" alt="" data-start="${p.start}" data-duration="${p.duration}" data-track-index="${10 + i}"${panAttrs}${urlAttr}${scrollAttr} />`;
        })
        .join("\n          ");
    } else {
      const panSec = segment.screencast?.pan_seconds;
      const panDist = segment.screencast?.pan_distance;
      const panAttrs =
        (panSec !== undefined ? ` data-pan-seconds="${panSec}"` : "") +
        (panDist !== undefined ? ` data-pan-distance="${panDist}"` : "");
      vars.SCREENCAST_MEDIA = `<img id="seg-screenshot" src="${screencastMediaPath ?? ""}" alt=""${panAttrs} />`;
    }
    vars.BROWSER_URL = segment.screencast?.url ?? "astria.ai";
    vars.CAPTION_EYEBROW = segment.caption?.eyebrow ?? "";
    vars.CAPTION_HTML = segment.caption?.html ?? "";
    // Optional: fade the caption out at a specific time (e.g. when the
    // content on screen has moved past the caption's framing topic).
    vars.CAPTION_HIDE_AT =
      typeof segment.caption?.hide_at === "number"
        ? segment.caption.hide_at.toFixed(2)
        : "";

    // Optional: bullets in the right column (re-uses slide.bullets /
    // slide.bullet_starts schema so authors don't learn a new shape).
    const pipBullets = segment.slide?.bullets ?? [];
    const pipStarts = segment.slide?.bullet_starts;
    if (pipBullets.length) {
      const items = pipBullets
        .map((b, i) => {
          const t = pipStarts?.[i];
          const attr =
            typeof t === "number"
              ? ` id="${segment.id}-pip-bullet-${i}" class="clip" data-start="${t.toFixed(2)}" data-duration="${(durationSec - t).toFixed(2)}" data-track-index="${60 + i}"`
              : "";
          return `<li${attr}>${b}</li>`;
        })
        .join("\n          ");
      vars.PIP_BULLETS_HTML = `<ul class="pip-bullets">\n          ${items}\n        </ul>`;
      vars.PIP_VARIANT_CLASS = "with-bullets";
    } else {
      vars.PIP_BULLETS_HTML = "";
      vars.PIP_VARIANT_CLASS = "";
    }

    // Marker highlights — SVG overlay above the viewport. Each marker is a
    // pathLength=1 stroke (circle / underline / arrow) that GSAP animates
    // via stroke-dashoffset from 1 → 0 over ~0.8s, holds, then fades.
    // Coordinates are in source-video space (1600×900) matching our
    // Playwright captures; the SVG uses preserveAspectRatio="xMidYMid meet"
    // so it object-fit:contains alongside the <video>.
    const markers = segment.markers ?? [];
    if (markers.length) {
      const styleClassFor = (s: string | undefined) => s === "luxe-cream" ? "marker-cream" : "marker-gold";
      const markerEls = markers
        .map((m, i) => {
          const klass = `clip marker ${styleClassFor(m.style)}`;
          const dataAttrs = `data-start="${m.start.toFixed(2)}" data-duration="${m.duration.toFixed(2)}" data-track-index="${40 + i}"`;
          if (m.shape === "circle") {
            const r = m.r ?? 80;
            return `<ellipse id="marker-${i}" class="${klass}" ${dataAttrs} cx="${m.cx}" cy="${m.cy}" rx="${r}" ry="${(r * 0.85).toFixed(0)}" pathLength="1" fill="none" />`;
          }
          if (m.shape === "underline") {
            const w = m.w ?? 200;
            const x1 = m.cx - w / 2;
            const x2 = m.cx + w / 2;
            // Slight curve so it doesn't look like a CSS border.
            const midY = m.cy + 6;
            return `<path id="marker-${i}" class="${klass}" ${dataAttrs} d="M ${x1} ${m.cy} Q ${m.cx} ${midY} ${x2} ${m.cy}" pathLength="1" fill="none" />`;
          }
          // arrow
          const w = m.w ?? 140;
          const h = m.h ?? 30;
          const x1 = m.cx - w / 2;
          const x2 = m.cx + w / 2;
          return `<path id="marker-${i}" class="${klass}" ${dataAttrs} d="M ${x1} ${m.cy} L ${x2} ${m.cy} M ${x2 - h} ${m.cy - h * 0.6} L ${x2} ${m.cy} L ${x2 - h} ${m.cy + h * 0.6}" pathLength="1" fill="none" />`;
        })
        .join("\n          ");
      vars.MARKERS_SVG_HTML =
        `<svg id="markers-svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet" aria-hidden="true">\n          ${markerEls}\n        </svg>`;
    } else {
      vars.MARKERS_SVG_HTML = "";
    }
  }

  for (const [k, v] of Object.entries(vars)) {
    html = html.replaceAll(`{{${k}}}`, v);
  }

  const workDir = ensureWorkDir(segment.id);
  writeFileSync(join(workDir, "index.html"), html);
  // Also write to the project-root index.html so single-segment edits can be
  // previewed directly at the repo root. Safe for serial builds; parallel
  // builds use the per-segment work dir for the actual render.
  writeFileSync(join(ROOT, "index.html"), html);
  return workDir;
}

/**
 * Content hash of everything that determines a segment's rendered mp4: the
 * composition HTML and every local file it references (audio, video, images).
 * Lets the build skip the slow hyperframes render when an identical mp4
 * already exists — see the render-cache check in buildOne(). Disable with
 * NO_RENDER_CACHE=1.
 */
function computeRenderKey(workDir: string): string {
  const html = readFileSync(join(workDir, "index.html"), "utf-8");
  const refs = new Set<string>();
  const collect = (re: RegExp) => {
    for (const m of html.matchAll(re)) {
      const p = m[1];
      if (p && !/^(https?:|data:|#|\/\/)/.test(p)) refs.add(p);
    }
  };
  collect(/(?:src|data-composition-src)\s*=\s*"([^"]+)"/g);
  collect(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g);

  const h = createHash("sha256");
  h.update(`engine:hyperframes@${HYPERFRAMES_VERSION}\n`);
  h.update(`html:${createHash("sha256").update(html).digest("hex")}\n`);
  for (const ref of [...refs].sort()) {
    let fileHash = "absent";
    try {
      const abs = join(workDir, ref);
      if (statSync(abs).isFile()) {
        fileHash = createHash("sha256").update(readFileSync(abs)).digest("hex");
      }
    } catch {}
    h.update(`ref:${ref}:${fileHash}\n`);
  }
  return h.digest("hex");
}

let anySegmentHasAvatarMp4 = false;

async function buildOne(project: string, segmentId: string) {
  const segment = loadSegment(project, segmentId);
  const draftMode = process.env.DRAFT === "1";
  const hasWave = !draftMode && Boolean(process.env.WAVESPEED_API_KEY);
  const hasHeygen = !draftMode && Boolean(process.env.HEYGEN_API_KEY);
  const hasGemini = !draftMode && Boolean(process.env.VERTEX_API_KEY);
  const noAvatar = process.env.NO_AVATAR === "1";

  // Provider selection: TTS_PROVIDER env > project.yaml defaults.tts.provider > auto.
  // Gemini TTS has no hosted URL, so it skips OmniHuman/InfiniteTalk entirely.
  const projectCfg = loadProject(project);
  const providerPref = (process.env.TTS_PROVIDER ?? projectCfg.defaults?.tts?.provider) as
    | "inworld"
    | "gemini"
    | undefined;
  const useGemini = providerPref === "gemini" && hasGemini;

  // Avatar config — segment overrides project defaults. Allow inheriting
  // image_url + engine from defaults.avatar so a single line in the project
  // manifest enables the avatar across every segment that has a visual slot.
  // Visuals without an avatar PiP slot (video-showcase, tv-intro) skip the
  // avatar render entirely even if the project default supplies a URL.
  const visualSupportsAvatar =
    segment.visual === "presenter-slide" ||
    segment.visual === "screencast-pip" ||
    segment.visual === "avatar-hero";
  type AvatarDefaults = NonNullable<SegmentYaml["avatar"]>;
  const projectAvatar = (projectCfg.defaults?.avatar ?? undefined) as Partial<AvatarDefaults> | undefined;
  const imageRef = noAvatar || !visualSupportsAvatar
    ? undefined
    : (segment.avatar?.image_url ?? projectAvatar?.image_url);
  const imageUrl = imageRef ? resolveAvatarImage(imageRef) : undefined;

  const engine = segment.avatar?.engine ?? projectAvatar?.engine ?? "omnihuman";
  // Default resolution depends on engine: Pruna only supports 720p/1080p,
  // OmniHuman/InfiniteTalk start at 480p.
  // Engine-specific resolution defaults:
  //   pruna             — only supports 720p / 1080p
  //   infinitetalk      — 720p (regular variant honors the resolution param)
  //   infinitetalk-fast — locked at 480p server-side (param ignored)
  //   omnihuman*        — 480p (cheaper; 1.5-byteplus upscales to 1440 internally)
  const resolution =
    segment.avatar?.resolution ??
    projectAvatar?.resolution ??
    (engine === "pruna" || engine === "infinitetalk" ? "720p" : "480p");
  const hasReplicate =
    !draftMode &&
    Boolean(process.env.REPLICATE_API_KEY ?? process.env.REPLICATE_API_TOKEN);
  const hasByteplus =
    !draftMode &&
    Boolean(process.env.BYTEPLUS_ACCESS_KEY_ID && process.env.BYTEPLUS_SECRET_ACCESS_KEY);

  // Engines that take the local audio file directly (no WaveSpeed-hosted URL):
  //   - pruna     uploads to Replicate
  //   - byteplus  inlines as base64 in the BytePlus signed call
  // Everything else goes through WaveSpeed and needs a fetchable audio URL
  // (or a base64 data URI built locally).
  const usePruna = engine === "pruna" && hasReplicate && Boolean(imageUrl);
  const useByteplus =
    engine === "omnihuman-1.5-byteplus" && hasByteplus && Boolean(imageUrl);
  const useWaveAvatar =
    !usePruna && !useByteplus && hasWave && Boolean(imageUrl);

  const ttsTier = useGemini ? "gemini" : hasWave ? "inworld" : hasHeygen ? "heygen" : "say";

  const tier = draftMode
    ? "draft"
    : usePruna
    ? `${ttsTier}+pruna`
    : useByteplus
    ? `${ttsTier}+omnihuman-1.5-byteplus`
    : useWaveAvatar
    ? `${ttsTier}+${engine}`
    : useGemini
    ? "gemini"
    : hasWave
    ? "inworld"
    : hasHeygen && !noAvatar
    ? "heygen"
    : "say";

  console.log(`\n=== ${segmentId} — tier: ${tier} ===`);

  let audioMp3: string;
  let audioUrl: string | null = null;
  let avatarMp4: string | null = null;

  // Visual-only segments (e.g. tv-intro) can declare no narration. In that
  // case we still need an audio file of the right length so the composition
  // timeline has something to ride. Generate a silent placeholder.
  const isSilentSegment = !segment.narration || segment.narration.trim() === "";

  if (draftMode || isSilentSegment) {
    const duration = isSilentSegment
      ? (segment.duration ?? 3.0)
      : draftDurationSec(segment.narration);
    const draftAudioDir = join(ROOT, "assets", "audio", project);
    mkdirSync(draftAudioDir, { recursive: true });
    audioMp3 = ensureSilentNarration(ROOT, join(project, segmentId), duration);
    console.log(`[${draftMode ? "draft" : "silent"}] ${segmentId}: silent audio ${duration.toFixed(1)}s`);
  } else if (useGemini) {
    const g = await generateGeminiAudio(project, segmentId);
    audioMp3 = g.localPath;
    // Gemini TTS does not produce a hosted URL — avatar lipsync path is skipped.
  } else if (hasWave) {
    const inw = await generateInworldAudio(project, segmentId);
    audioMp3 = inw.localPath;
    audioUrl = inw.url;
  } else if (hasHeygen) {
    audioMp3 = join(ROOT, "assets", "audio", project, `${segmentId}.mp3`);
  } else {
    audioMp3 = ensureSayNarration(project, segmentId, segment.narration);
  }

  if (usePruna && imageUrl) {
    // Pruna takes the local audio file directly — no hosted URL required.
    // video_prompt: segment-level overrides project-level default.
    const videoPrompt =
      segment.avatar?.video_prompt ?? projectCfg.defaults?.avatar?.video_prompt;
    avatarMp4 = await generatePruna(
      project,
      segmentId,
      audioMp3,
      imageUrl,
      resolution as "720p" | "1080p",
      videoPrompt
    );
  } else if (useByteplus && imageUrl) {
    // BytePlus OmniHuman 1.5 — direct call, audio inlined as base64.
    avatarMp4 = await generateOmniHumanByteplus(project, segmentId, audioMp3, imageUrl);
  } else if (useWaveAvatar && imageUrl) {
    // OmniHuman/InfiniteTalk accept either a URL or a base64 data URI.
    // When TTS gave us a hosted URL (Inworld path) prefer that; otherwise
    // inline the local mp3 so the Gemini-default flow still works.
    const audioInput = audioUrl ?? mp3FileToDataUri(audioMp3);
    if (engine === "infinitetalk" || engine === "infinitetalk-fast") {
      // Reuse the same avatar.video_prompt knob Pruna already uses so authors
      // have a single place to steer micro-motion regardless of engine.
      const motionPrompt =
        segment.avatar?.video_prompt ?? projectCfg.defaults?.avatar?.video_prompt ?? "";
      avatarMp4 = await generateInfiniteTalk(
        project,
        segmentId,
        audioInput,
        imageUrl,
        resolution as "480p" | "720p",
        engine === "infinitetalk-fast" ? "fast" : "regular",
        motionPrompt,
      );
    } else if (engine === "omnihuman-1.5") {
      avatarMp4 = await generateOmniHuman(project, segmentId, audioInput, imageUrl, "v1.5");
    } else {
      avatarMp4 = await generateOmniHuman(project, segmentId, audioInput, imageUrl, "v1");
    }
  } else if (tier === "heygen") {
    avatarMp4 = await generateAvatar(project, segmentId);
    run("ffmpeg", ["-y", "-i", avatarMp4, "-vn", "-acodec", "libmp3lame", "-q:a", "2", audioMp3]);
  }

  const sourceForDuration = avatarMp4 ?? audioMp3;
  const audioDuration = Math.ceil(ffprobeDuration(sourceForDuration) * 10) / 10 + 0.2;
  // Visual-only segments (e.g. tv-intro) can override duration explicitly.
  const safeDuration = segment.duration ?? audioDuration;

  // Screencast recording: only for screencast-pip segments with mode=video.
  // Skipped when the mp4 already exists (cheap iteration) unless --rerecord is passed.
  if (segment.visual === "screencast-pip" && segment.screencast?.mode === "video") {
    const mp4 = join(ROOT, "assets", "captures", project, `${segmentId}.mp4`);
    const rerecord = process.argv.includes("--rerecord");
    // Screencast recording drives a logged-in Astria browser session
    // (storageState.json) and cannot run unattended in CI. NO_SCREENCAST=1
    // (set automatically whenever CI is set) skips recording; pickScreencastMedia()
    // then falls back to screencast.fallback_image / screencast.src.
    const noScreencast = process.env.NO_SCREENCAST === "1" || Boolean(process.env.CI);
    if (noScreencast && !existsSync(mp4) && !rerecord) {
      console.log(`[record] ${segmentId}: NO_SCREENCAST — skipping recording, using fallback image`);
    } else if (!existsSync(mp4) || rerecord) {
      await recordScreencast(project, segmentId);
    } else {
      console.log(`[record] ${segmentId}: using cached ${mp4} (pass --rerecord to refresh)`);
    }
  }

  const audioSrc = `assets/audio/${project}/${segmentId}.mp3`;
  const workDir = renderLayout(project, projectCfg, segment, Boolean(avatarMp4), audioSrc, safeDuration);
  if (avatarMp4) anySegmentHasAvatarMp4 = true;
  console.log(`[build] ${segmentId}: visual=${segment.visual} duration=${safeDuration.toFixed(2)}s`);

  // Render this segment's composition from its own work dir so parallel
  // builds don't race on index.html.
  const outputDir = join(ROOT, "out", project);
  mkdirSync(outputDir, { recursive: true });
  const output = join("out", project, `${segmentId}.mp4`);
  const outAbs = join(ROOT, output);
  const keyPath = `${outAbs}.key`;

  // Render cache — the hyperframes render is the slowest step. Skip it when
  // this exact composition + assets already produced an mp4 (key restored
  // from gh-pages by `ci:restore`). This is what makes a re-run cheap.
  const renderKey = computeRenderKey(workDir);
  if (
    process.env.NO_RENDER_CACHE !== "1" &&
    existsSync(outAbs) &&
    existsSync(keyPath) &&
    readFileSync(keyPath, "utf-8").trim() === renderKey
  ) {
    console.log(`[build] ${segmentId}: render cached (${renderKey.slice(0, 12)}) — skipped`);
    return;
  }

  const workers = process.env.HF_WORKERS ?? (avatarMp4 ? "2" : "4");
  console.log(`[build] ${segmentId}: rendering → ${output} (workers=${workers})`);
  // Pin to 0.4.9 — newer hyperframes (0.4.45+) bumped sharp to 0.34.5, which
  // fails to install on this Mac (sharp falls through to node-gyp build and
  // errors on missing node-addon-api). Bump again once the dep tree settles.
  await runRenderWithEarlyKill([
    `hyperframes@${HYPERFRAMES_VERSION}`, "render",
    workDir,
    "--output", output,
    "--quality", "draft",
    "--workers", workers,
  ]);
  writeFileSync(keyPath, `${renderKey}\n`);
  console.log(`[build] ${segmentId}: done → ${join(ROOT, output)}`);
}

async function main() {
  const project = parseProject();
  const idx = process.argv.indexOf("--segment");
  const all = process.argv.includes("--all");
  if (idx === -1 && !all) {
    console.error(
      "Usage: tsx pipeline/build.ts [--project <name>] --segment <id> | --all [--parallel N]",
    );
    process.exit(1);
  }

  const targets = all ? loadProject(project).segments : [process.argv[idx + 1]];
  const parallelIdx = process.argv.indexOf("--parallel");
  const parallel = parallelIdx !== -1 ? Math.max(1, parseInt(process.argv[parallelIdx + 1] ?? "1", 10)) : 1;

  console.log(`[build] project=${project} targets=${targets.length} parallel=${parallel}`);

  if (parallel === 1) {
    for (const id of targets) await buildOne(project, id);
  } else {
    // Simple fixed-width worker pool. Each buildOne renders from its own
    // .work/<id>/ dir so concurrent builds don't race on index.html.
    const queue = [...targets];
    const errors: { id: string; err: unknown }[] = [];
    const runners = Array.from({ length: Math.min(parallel, queue.length) }, async () => {
      while (queue.length) {
        const id = queue.shift()!;
        try {
          await buildOne(project, id);
        } catch (err) {
          errors.push({ id, err });
        }
      }
    });
    await Promise.all(runners);
    if (errors.length) {
      console.error(`\n${errors.length} segment(s) failed:`);
      for (const { id, err } of errors) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ ${id}: ${msg}`);
      }
      process.exit(1);
    }
  }

  console.log(`\n[build] all done → ${targets.length} mp4(s) in out/${project}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
