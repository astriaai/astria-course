/**
 * Generate the course debug dashboard — a static site an editor or
 * non-technical reviewer can browse to check every module and segment.
 *
 *   tsx pipeline/build-dashboard.ts
 *
 * Reads the project manifests + segment YAML, probes the rendered videos in
 * out/<project>/ and the input artifacts in assets/, and writes:
 *
 *   site/manifest.json   the data the GUI renders
 *   site/index.html      the GUI shell (copied from dashboard/)
 *   site/app.js
 *   site/style.css
 *
 * Env (all optional — set by CI):
 *   BUILD_MODE         draft | paid | main         (default: draft)
 *   PR_NUMBER          PR number for preview builds
 *   PR_TITLE           PR title
 *   AFFECTED_PROJECTS  JSON array / list of projects rebuilt in this run
 *   GIT_SHA            commit being built
 *   PAGES_BASE_URL     site root, used to link unchanged modules to main
 *   DASHBOARD_PROJECTS comma/list filter for a focused publish
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SITE = join(ROOT, "site");
const DASHBOARD = join(ROOT, "dashboard");

const env = process.env;
const buildMode = (env.BUILD_MODE || "draft") as "draft" | "paid" | "main";
const prNumber = env.PR_NUMBER ? Number(env.PR_NUMBER) : null;
const pagesBaseUrl = (env.PAGES_BASE_URL || "").replace(/\/+$/, "");
// AFFECTED_PROJECTS is set by the PR workflows (possibly to an empty list).
// When unset (local runs, main publish) every module counts as in-build.
const affectedSet = env.AFFECTED_PROJECTS !== undefined;
const affected = (env.AFFECTED_PROJECTS || "")
  .replace(/[[\]"]/g, " ")
  .split(/[,\s]+/)
  .filter(Boolean);
const dashboardProjectFilter = (env.DASHBOARD_PROJECTS || "")
  .replace(/[[\]"]/g, " ")
  .split(/[,\s]+/)
  .filter(Boolean);

interface ProjectManifest {
  meta?: { title?: string; tags?: string[] };
  segments?: string[];
}
interface SegmentYaml {
  id?: string;
  title?: string;
  narration?: string;
  visual?: string;
  caption?: { html?: string };
  intro?: { title_html?: string; subtitle_html?: string };
}
interface ProjectGitInfo {
  addedAt: string | null;
  addedCommit: string | null;
}

function ffprobe(file: string): number | null {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) return null;
  const d = parseFloat(r.stdout.trim());
  return Number.isFinite(d) ? Math.round(d * 10) / 10 : null;
}

function thumbnailUrl(pid: string, id: string, videoPath: string): string | null {
  if (!existsSync(videoPath)) return null;
  const rel = join("thumbs", pid, `${id}.jpg`);
  const out = join(SITE, rel);
  mkdirSync(dirname(out), { recursive: true });
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-ss", "1",
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", "scale=640:-1",
      "-q:v", "5",
      out,
    ],
    { encoding: "utf-8" },
  );
  return r.status === 0 && existsSync(out) ? rel.replaceAll("\\", "/") : null;
}

/** First existing path under assets/, returned as a site-relative media URL. */
function mediaUrl(...rel: string[]): string | null {
  const abs = join(ROOT, "assets", ...rel);
  return existsSync(abs) ? `media/${rel.join("/")}` : null;
}

/** Plain-text on-screen content for a segment, for the script reviewer. */
function scriptText(seg: SegmentYaml): string {
  if (seg.narration && seg.narration.trim()) return seg.narration.trim();
  const bits = [seg.intro?.title_html, seg.intro?.subtitle_html, seg.caption?.html]
    .filter(Boolean)
    .join(" — ");
  return bits ? `(visual segment) ${bits.replace(/<[^>]+>/g, "").trim()}` : "(visual segment — no narration)";
}

function loadYaml<T>(path: string): T | null {
  try {
    return yaml.load(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function cleanProjectTitle(title: string): string {
  return title.replace(/^Astria\s*[·•\-–—:]\s*/i, "").trim();
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))];
}

function projectGitInfo(pid: string): ProjectGitInfo {
  const rel = join("script", "projects", `${pid}.yaml`);
  const r = spawnSync(
    "git",
    ["log", "--follow", "--diff-filter=A", "--date=iso-strict", "--format=%cI%x09%h", "--", rel],
    { cwd: ROOT, encoding: "utf-8" },
  );
  if (r.status !== 0) return { addedAt: null, addedCommit: null };
  const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean);
  const [addedAt, addedCommit] = (lines[lines.length - 1] || "").split("\t");
  return {
    addedAt: addedAt || null,
    addedCommit: addedCommit || null,
  };
}

function dateTime(value: string | null | undefined): number {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function main() {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });
  for (const f of readdirSync(DASHBOARD)) {
    cpSync(join(DASHBOARD, f), join(SITE, f), { recursive: true });
  }

  const projectIds = readdirSync(join(ROOT, "script", "projects"))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .filter((pid) => dashboardProjectFilter.length === 0 || dashboardProjectFilter.includes(pid))
    .sort();

  const projects = projectIds
    .map((pid) => {
      const manifest = loadYaml<ProjectManifest>(join(ROOT, "script", "projects", `${pid}.yaml`));
      const gitInfo = projectGitInfo(pid);
      const segIds = manifest?.segments ?? [];
      // In a `main` build every module is rendered; in a PR only the affected
      // ones — others are shown as "unchanged" pointing at the live main site.
      const inBuild = buildMode === "main" || !affectedSet || affected.includes(pid);

      const segments = segIds.map((sid) => {
        const seg =
          loadYaml<SegmentYaml>(join(ROOT, "script", "segments", pid, `${sid}.yaml`)) ?? {};
        const outMp4 = join(ROOT, "out", pid, `${sid}.mp4`);
        const built = existsSync(outMp4);
        const status = !inBuild ? "unchanged" : built ? "built" : "failed";
        const localVideo = `videos/${pid}/${sid}.mp4`;
        const videoUrl =
          status === "unchanged" && pagesBaseUrl ? `${pagesBaseUrl}/${localVideo}` : localVideo;
        return {
          id: sid,
          title: seg.title || sid,
          visual: seg.visual || "—",
          script: scriptText(seg),
          status,
          duration: built ? ffprobe(outMp4) : null,
          videoUrl: status === "failed" ? null : videoUrl,
          thumbnailUrl: built ? thumbnailUrl(pid, sid, outMp4) : null,
          inputs: {
            avatar: mediaUrl("avatars", pid, `${sid}.mp4`),
            audio: mediaUrl("audio", pid, `${sid}.mp3`),
            capture: mediaUrl("captures", pid, `${sid}.mp4`),
          },
        };
      });

      // Only link a video GitHub Pages will actually serve (≤ 100 MB push limit).
      const servable = (abs: string) => existsSync(abs) && statSync(abs).size <= 99 * 1024 * 1024;
      const fullDraftAbs = join(ROOT, "out", pid, "_full-draft.mp4");
      const builtCount = segments.filter((s) => s.status === "built").length;
      return {
        id: pid,
        title: cleanProjectTitle(manifest?.meta?.title || pid) || pid,
        tags: normalizeTags(manifest?.meta?.tags),
        addedAt: gitInfo.addedAt,
        addedCommit: gitInfo.addedCommit,
        inBuild,
        segmentCount: segments.length,
        builtCount,
        failedCount: segments.filter((s) => s.status === "failed").length,
        duration: segments.reduce((t, s) => t + (s.duration || 0), 0),
        fullDraftUrl: servable(fullDraftAbs) ? `videos/${pid}/_full-draft.mp4` : null,
        thumbnailUrl: servable(fullDraftAbs) ? thumbnailUrl(pid, "_full-draft", fullDraftAbs) : null,
        segments,
      };
    })
    .sort((a, b) => {
      const byPublishDate = dateTime(b.addedAt) - dateTime(a.addedAt);
      if (byPublishDate !== 0) return byPublishDate;
      return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    });

  const manifest = {
    generatedAt: new Date().toISOString(),
    buildMode,
    commit: (env.GIT_SHA || "").slice(0, 9) || null,
    pr: prNumber ? { number: prNumber, title: env.PR_TITLE || `PR #${prNumber}` } : null,
    pagesBaseUrl: pagesBaseUrl || null,
    projects,
  };

  writeFileSync(join(SITE, "manifest.json"), JSON.stringify(manifest, null, 2));

  const totalSegs = projects.reduce((t, p) => t + p.segmentCount, 0);
  const totalFailed = projects.reduce((t, p) => t + p.failedCount, 0);
  console.log(
    `[dashboard] ${projects.length} modules · ${totalSegs} segments · ` +
      `${totalFailed} failed · mode=${buildMode} → site/`,
  );
}

main();
