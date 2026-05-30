/**
 * gh-pages branch = single artifact store for the course.
 *
 * It holds, in one branch:
 *   index.html, app.js, style.css, manifest.json   the published debug GUI
 *   videos/<project>/*.mp4                          rendered segment + full-draft videos
 *   media/<assetdir>/...                            input artifacts the GUI links to
 *   cache/...                                       the .cache/ build cache
 *   pr-<N>/...                                      per-PR preview sites
 *
 * Two subcommands:
 *
 *   tsx pipeline/ci/gh-pages.ts restore
 *       Pull `cache/` + `media/` off gh-pages into `.cache/` and `assets/`
 *       so an unchanged segment is a cache hit (no paid API call). Partial
 *       fetch — only the cache/media blobs download. No-op on a cold repo.
 *
 *   tsx pipeline/ci/gh-pages.ts publish <root|pr-N> [--update-cache] [--no-cache] [--no-media] [--only-project <id>]
 *       Deploy the freshly built `site/` + `out/` + `assets/` to the branch.
 *       Rebuilds gh-pages as ONE fresh orphan commit (force-push) so history
 *       never bloats; git dedupes unchanged blobs by SHA. Sibling `pr-N`
 *       preview directories are preserved untouched. `--update-cache`
 *       (paid PR build) also refreshes the shared root `cache/` + `media/`.
 *
 * Runs inside the existing Actions checkout — reuses its authenticated
 * `origin` remote. The build working tree and index are never touched
 * (a throwaway index file + staging work-tree are used for the commit).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", ".."); // webinar-builder/
const GIT_DIR = (
  spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: ROOT, encoding: "utf-8" }).stdout || ""
).trim() || resolve(ROOT, "..", ".git");
// Repo work-tree root. webinar-builder/ is a subdirectory, so path-scoped git
// commands (ls-tree, archive) must run from here, not from ROOT.
const GIT_ROOT = (
  spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: ROOT, encoding: "utf-8" }).stdout || ""
).trim() || resolve(ROOT, "..");
const BRANCH = process.env.PAGES_BRANCH || "gh-pages";
const TMP = join(ROOT, ".gh-pages-tmp");
const SITE = join(ROOT, "site");
const CACHE = join(ROOT, ".cache");
const ASSETS = join(ROOT, "assets");
const OUT = join(ROOT, "out");

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  if (!opts.quiet && r.stdout.trim()) console.log(r.stdout.trim());
  return r.stdout;
}

/** Run a command, return true on success, false on failure (no throw). */
function tryRun(cmd: string, args: string[], env?: NodeJS.ProcessEnv): boolean {
  return spawnSync(cmd, args, { cwd: ROOT, env: env ?? process.env, stdio: "ignore" }).status === 0;
}

function git(args: string[], env?: NodeJS.ProcessEnv): string {
  return spawnSync("git", args, { cwd: ROOT, env: env ?? process.env, encoding: "utf-8" }).stdout;
}

/** The projects that have rendered output worth publishing. */
function projectsWithOutput(onlyProject?: string): string[] {
  const manifests = [
    ...readdirSync(join(ROOT, "script", "projects")),
    ...(existsSync(join(ROOT, "script", "music-videos"))
      ? readdirSync(join(ROOT, "script", "music-videos"))
      : []),
  ]
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""));
  return [...new Set(manifests)].filter(
    (p) => existsSync(join(OUT, p)) && readdirSync(join(OUT, p)).some((f) => f.endsWith(".mp4")),
  ).filter((p) => !onlyProject || p === onlyProject);
}

// ─── restore ────────────────────────────────────────────────────────────────

function restore(overlay?: string) {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  // Partial fetch — trees + commit only, blobs stay lazy on the server.
  if (!tryRun("git", ["fetch", "--filter=blob:none", "--depth", "1", "--no-tags", "origin", BRANCH])) {
    console.log(`[ci] no '${BRANCH}' branch yet — cold cache, nothing to restore`);
    return;
  }

  const top = git(["ls-tree", "--name-only", "--full-tree", "FETCH_HEAD"])
    .split("\n")
    .filter(Boolean);
  // Root cache/media/videos, plus optionally a preview's own videos overlaid
  // on top — lets a PR reuse the render-cache keys from its own last build.
  const paths = ["cache", "media", "videos"].filter((d) => top.includes(d));
  const hasOverlay =
    !!overlay &&
    spawnSync("git", ["cat-file", "-e", `FETCH_HEAD:${overlay}/videos`], { cwd: GIT_ROOT })
      .status === 0;
  if (hasOverlay) paths.push(`${overlay}/videos`);
  if (paths.length === 0) {
    console.log(`[ci] '${BRANCH}' has no artifacts yet — cold cache`);
    return;
  }

  // `git archive` of just these pathspecs lazily fetches only their blobs.
  // Pathspecs resolve from cwd, so run it at the repo root.
  const tar = join(TMP, "artifacts.tar");
  sh("git", ["archive", "-o", tar, "FETCH_HEAD", ...paths], { cwd: GIT_ROOT, quiet: true });
  sh("tar", ["-xf", tar, "-C", TMP], { quiet: true });
  rmSync(tar, { force: true });

  if (existsSync(join(TMP, "cache"))) {
    mkdirSync(CACHE, { recursive: true });
    cpSync(join(TMP, "cache"), CACHE, { recursive: true });
    console.log("[ci] restored .cache/");
  }
  if (existsSync(join(TMP, "media"))) {
    mkdirSync(ASSETS, { recursive: true });
    const dirs = readdirSync(join(TMP, "media"));
    cpSync(join(TMP, "media"), ASSETS, { recursive: true });
    console.log(`[ci] restored assets/{${dirs.join(",")}}`);
  }
  if (existsSync(join(TMP, "videos"))) {
    mkdirSync(OUT, { recursive: true });
    cpSync(join(TMP, "videos"), OUT, { recursive: true });
    console.log("[ci] restored out/ (videos + render-cache keys)");
  }
  if (hasOverlay && existsSync(join(TMP, overlay!, "videos"))) {
    cpSync(join(TMP, overlay!, "videos"), OUT, { recursive: true });
    console.log(`[ci] overlaid ${overlay}/videos onto out/`);
  }
  rmSync(TMP, { recursive: true, force: true });
}

// ─── publish ────────────────────────────────────────────────────────────────

/** branch-relative path → absolute source dir/file (recursive copy). */
type Entry = { path: string; src: string };

/** What this publish replaces on the branch; everything else is preserved. */
function buildPlan(target: string, updateCache: boolean, publishCache: boolean, publishMedia: boolean, onlyProject?: string): Entry[] {
  const prefix = target === "root" ? "" : `${target}/`;
  const entries: Entry[] = [];

  // 0. .nojekyll — GitHub Pages runs Jekyll unless this file sits at the site
  //    root, and Jekyll silently drops every underscore-prefixed file (e.g.
  //    the stitched _full-draft.mp4 → 404). Always keep one at the branch root.
  const noJekyll = join(TMP, ".nojekyll");
  writeFileSync(noJekyll, "");
  entries.push({ path: ".nojekyll", src: noJekyll });

  // 1. site shell + manifest (generated by build-dashboard.ts into site/)
  if (!existsSync(SITE)) throw new Error("site/ missing — run 'npm run dashboard' first");
  for (const f of readdirSync(SITE)) entries.push({ path: prefix + f, src: join(SITE, f) });

  // 2. videos for this build — curated copy of out/<project>/*.mp4 under
  // TMP/videos/<project>. Keep each project as its own publish entry so a
  // scoped `--only-project` refresh cannot delete sibling module videos that
  // are still referenced by the root dashboard manifest.
  const vids = join(TMP, "videos");
  rmSync(vids, { recursive: true, force: true });
  const publishedProjects: string[] = [];
  // GitHub rejects any pushed file > 100 MB (GH001 pre-receive hook). Skip
  // oversized videos so the publish push can't die on one — stitch.ts keeps
  // full-draft cuts under this, so in practice nothing is skipped.
  const MAX_PUSH_BYTES = 99 * 1024 * 1024;
  for (const p of projectsWithOutput(onlyProject)) {
    publishedProjects.push(p);
    mkdirSync(join(vids, p), { recursive: true });
    for (const f of readdirSync(join(OUT, p))) {
      // .mp4 = the video; .mp4.key = its render-cache key (skips re-render).
      if (!f.endsWith(".mp4") && !f.endsWith(".mp4.key")) continue;
      const src = join(OUT, p, f);
      if (f.endsWith(".mp4") && statSync(src).size > MAX_PUSH_BYTES) {
        console.warn(`[ci] skipping ${p}/${f} — over GitHub's 100 MB push limit`);
        continue;
      }
      cpSync(src, join(vids, p, f));
    }
  }
  for (const p of publishedProjects) {
    entries.push({ path: prefix + `videos/${p}`, src: join(vids, p) });
  }

  // 3. input media the GUI links to (= assets/, the gitignored generated dirs)
  if (publishMedia && existsSync(ASSETS)) entries.push({ path: prefix + "media", src: ASSETS });

  // 4. shared build cache — root publish always; a PR paid build with
  //    --update-cache also refreshes the canonical root cache/ + media/.
  if (publishCache && (target === "root" || updateCache)) {
    if (existsSync(CACHE)) entries.push({ path: "cache", src: CACHE });
    if (target !== "root" && publishMedia && existsSync(ASSETS)) entries.push({ path: "media", src: ASSETS });
  }
  return entries;
}

const ID_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "astria-course-ci",
  GIT_AUTHOR_EMAIL: "ci@astria.ai",
  GIT_COMMITTER_NAME: "astria-course-ci",
  GIT_COMMITTER_EMAIL: "ci@astria.ai",
};

/**
 * Assemble + push one fresh orphan commit. Optimistic concurrency: the push
 * uses --force-with-lease pinned to the branch tip we read, so a racing
 * publish (another PR, or a main publish) is detected and the whole assemble
 * is retried against the new tip instead of silently clobbering it.
 *
 *   removePaths — branch paths cleared from the index (then re-added if staged)
 *   addPaths    — branch paths added from <stage> (must exist on disk there)
 * Unnamed paths (e.g. other pr-N preview dirs) keep their original tree OIDs.
 */
function commitAndPush(
  label: string,
  removePaths: string[],
  addPaths: string[],
  stage: string,
  msg: string,
) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const idxEnv: NodeJS.ProcessEnv = { ...ID_ENV, GIT_INDEX_FILE: join(TMP, `index.${attempt}`) };

    // Full fetch (no blob filter): the orphan commit reuses the branch's
    // existing blobs, and `git push` can only build the pack if those blobs
    // are present locally. A blob:none fetch makes every push fail.
    const hasBranch = tryRun("git", [
      "fetch", "--depth", "1", "--no-tags", "origin", BRANCH,
    ]);
    const before = hasBranch ? git(["rev-parse", "FETCH_HEAD"]).trim() : "";
    sh("git", ["read-tree", hasBranch ? "FETCH_HEAD" : "--empty"], { env: idxEnv, quiet: true });

    // Run rm/add from inside <stage> with <stage> as the work-tree so branch
    // pathspecs (videos, media, pr-N/...) resolve at the branch root, not
    // relative to the repo subdirectory this script lives in.
    const treeEnv: NodeJS.ProcessEnv = { ...idxEnv, GIT_DIR, GIT_WORK_TREE: stage };
    for (const p of removePaths) {
      spawnSync("git", ["rm", "-r", "--cached", "--ignore-unmatch", "-q", "--", p], {
        cwd: stage,
        env: treeEnv,
      });
    }
    if (addPaths.length) {
      const add = spawnSync("git", ["add", "--", ...addPaths], {
        cwd: stage,
        env: treeEnv,
        stdio: "inherit",
      });
      if (add.status !== 0) throw new Error("git add (staging) failed");
    }

    const tree = sh("git", ["write-tree"], { env: idxEnv, quiet: true }).trim();
    const commit = sh("git", ["commit-tree", tree, "-m", msg], { env: ID_ENV, quiet: true }).trim();

    const refspec = `${commit}:refs/heads/${BRANCH}`;
    const pushArgs = hasBranch
      ? ["push", `--force-with-lease=refs/heads/${BRANCH}:${before}`, "origin", refspec]
      : ["push", "origin", refspec];
    const push = spawnSync("git", pushArgs, { cwd: ROOT, encoding: "utf-8" });
    if (push.status === 0) {
      console.log(`[ci] ${label} → ${BRANCH} (${commit.slice(0, 9)})`);
      return;
    }
    const why = (push.stderr || push.stdout || "").trim();
    console.log(`[ci] push attempt ${attempt}/6 failed:\n${why || "(no output)"}`);
    spawnSync("sleep", [String(2 + attempt)]); // back off so racers de-sync
  }
  throw new Error(`failed to push ${BRANCH} after 6 attempts`);
}

/** A preview directory slug — pr-<N>, module-<name>, etc. */
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

function publish(target: string, updateCache: boolean, publishCache: boolean, publishMedia: boolean, onlyProject?: string) {
  if (target !== "root" && !SLUG.test(target)) {
    throw new Error(`publish target must be 'root' or a slug (pr-N, module-X), got '${target}'`);
  }
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const stage = join(TMP, "stage");
  mkdirSync(stage, { recursive: true });

  const plan = buildPlan(target, updateCache, publishCache, publishMedia, onlyProject);

  // Lay new content into the staging work-tree once (re-added each attempt).
  for (const { path, src } of plan) {
    const dest = join(stage, path);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  }

  const paths = plan.map((e) => e.path);
  const removePaths =
    target === "root"
      ? [...paths, ...(!publishCache ? ["cache"] : []), ...(!publishMedia ? ["media"] : [])]
      : paths;
  const msg =
    target === "root"
      ? `publish: course site${publishCache || updateCache ? " + cache" : ""}`
      : `publish: ${target} preview${publishCache && updateCache ? " + cache" : ""}`;
  commitAndPush(`published ${target}`, removePaths, paths, stage, msg);
  rmSync(TMP, { recursive: true, force: true });
}

/** Remove a closed PR's preview directory from gh-pages. */
function drop(target: string) {
  if (target === "root" || !SLUG.test(target)) {
    throw new Error(`drop target must be a preview slug (pr-N, module-X), got '${target}'`);
  }
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  commitAndPush(`dropped ${target}`, [target], [], TMP, `cleanup: remove ${target} preview`);
  rmSync(TMP, { recursive: true, force: true });
}

// ─── entry ──────────────────────────────────────────────────────────────────

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "restore") {
    restore(rest.find((a) => !a.startsWith("--")));
  } else if (cmd === "publish") {
    const target = rest.find((a) => !a.startsWith("--")) ?? "root";
    const onlyProjectIdx = rest.indexOf("--only-project");
    publish(
      target,
      rest.includes("--update-cache"),
      !rest.includes("--no-cache"),
      !rest.includes("--no-media"),
      onlyProjectIdx === -1 ? undefined : rest[onlyProjectIdx + 1],
    );
  } else if (cmd === "drop") {
    const target = rest.find((a) => !a.startsWith("--"));
    if (!target) throw new Error("drop requires a pr-<N> target");
    drop(target);
  } else {
    console.error(
      "usage: gh-pages.ts restore | publish <root|pr-N> [--update-cache] [--no-cache] [--no-media] [--only-project <id>] | drop <pr-N>",
    );
    process.exit(1);
  }
}

main();
