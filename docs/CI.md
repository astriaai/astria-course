# CI & publishing

How `astria-course` builds, reviews, and publishes itself on GitHub.

## TL;DR

- Open a PR → it builds a **free DRAFT** of the changed modules and posts a
  **preview link**. Claude auto-reviews it.
- Comment **`/render-paid`** on the PR → it renders the real narration,
  avatars and video (only what changed costs money — the rest is cached).
- Merge to `main` → the course **publishes** to the GitHub Pages site.
- Mention **`@claude`** anywhere in a PR or issue to get Claude's help.

## The published site

Everything lives on the **`gh-pages`** branch and is served at:

```
https://<owner>.github.io/astria-course/
```

It is a debug dashboard — every course module, every segment, the rendered
video, the narration script, and the input artifacts (avatar clip, screencast
capture, narration audio). Built for editors and non-technical reviewers.

Each open PR also gets its own preview at `…/pr-<N>/`.

## Workflows (`.github/workflows/`)

| File | Trigger | Does | Cost |
|---|---|---|---|
| `pr-build.yml` | PR opened / pushed | DRAFT render of affected modules → preview at `pr-<N>/` | free |
| `pr-render-paid.yml` | PR comment `/render-paid` (write access) | real paid render → updates `pr-<N>/` + shared cache | paid, cache-gated |
| `publish.yml` | push to `main` | render every module, stitch, publish to site root | mostly free (cache) |
| `pages-deploy.yml` | push to `gh-pages` or manual dispatch | deploy the current `gh-pages` artifact tree to GitHub Pages | free |
| `pr-cleanup.yml` | PR closed | remove `pr-<N>/` preview | free |
| `claude.yml` | `@claude` mention | interactive Claude Code | Anthropic API |
| `claude-review.yml` | PR opened / pushed | automatic Claude code review | Anthropic API |

## DRAFT vs PAID

macOS `say` does not exist on Linux runners, so PR builds run with `DRAFT=1`:
silent placeholder audio, burned-in caption text, no avatars, no paid APIs.
That fully validates layout, timing, captions and lint — for free.

When the script in a PR is approved, a maintainer comments `/render-paid`.
That runs the real build with the API secrets. Because every generator caches
its result by a content hash, only segments whose text/prompt actually
changed cost money; everything else is a cache hit.

## The artifact cache

The expensive API outputs (`.cache/`) and generated media (`assets/avatars`,
`assets/audio`, `assets/captures`, …) are stored on `gh-pages` under `cache/`
and `media/`. Every build restores them first (`npm run ci:restore`) and a
paid build saves the refreshed cache back. So a segment is paid for **once** —
the PR's `/render-paid`, the `main` publish, and any later PR all reuse it.

**Render caching.** The slowest step is the hyperframes render itself, not the
API calls. Each segment's mp4 is stored under `gh-pages` `videos/` next to a
`.mp4.key` — a content hash of the composition HTML and every asset it
references. On the next build, an unchanged segment matches its key and the
render is skipped entirely. So a re-run only re-renders what actually changed.
The first build of any segment is always a full render; set `NO_RENDER_CACHE=1`
to force one.

**Setup caching.** `actions/setup-node` caches npm packages, and the shared
setup action also caches Playwright's browser binaries under
`~/.cache/ms-playwright`, keyed by `webinar-builder/package-lock.json`.
Ubuntu system packages still install on each fresh runner, but Chromium should
only download on cache misses. External install steps are wrapped with `timeout`,
and workflows put a 45-minute ceiling on setup, so a stuck setup fails visibly.
The `main` publish lane also cancels older in-progress publishes when a newer
push arrives, which keeps an obsolete run from blocking the current site.

`gh-pages` is rebuilt as a single fresh orphan commit on every deploy
(`pipeline/ci/gh-pages.ts`), so its history never bloats; git deduplicates
unchanged blobs by SHA.

## One-time setup

1. **Secrets** — repo → Settings → Secrets and variables → Actions:

   | Secret | For |
   |---|---|
   | `CLAUDE_CODE_OAUTH_TOKEN` | Claude workflows (`claude setup-token`) |
   | `VERTEX_API_KEY` | Gemini TTS |
   | `WAVESPEED_API_KEY` | Inworld TTS + OmniHuman / InfiniteTalk avatars |
   | `HEYGEN_API_KEY` | HeyGen Avatar IV |
   | `BYTEPLUS_ACCESS_KEY_ID`, `BYTEPLUS_SECRET_ACCESS_KEY` | BytePlus OmniHuman 1.5 |
   | `REPLICATE_API_KEY` | Pruna avatar (optional) |
   | `ASTRIA_AUTH_TOKEN`, `GEMINI_TUNE_ID` | Astria Seedance video |
   | `WORKSPACE_ID`, `ASTRIA_BASE_URL` | optional Astria overrides |

2. **GitHub Pages** — Settings → Pages → Deploy from a branch → `gh-pages` / `root`.
   (The `gh-pages` branch is created automatically by the first `publish` run;
   run the `publish` workflow once via *Actions → Publish course → Run workflow*.)

3. **Claude GitHub App** — install it on the repo (in Claude Code, run
   `/install-github-app`). For `CLAUDE_CODE_OAUTH_TOKEN`, run `claude
   setup-token` locally — it mints a token against your Claude subscription —
   then `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo astriaai/astria-course`.

## Local equivalents

```bash
cd webinar-builder
npm run ci:restore                                  # pull cache from gh-pages
DRAFT=1 NO_SCREENCAST=1 npm run build -- --project edit-image --all
npm run dashboard                                   # generate site/ — open site/index.html
```

Screencast recording can't run in CI (it needs a logged-in Astria session),
so `NO_SCREENCAST=1` skips it and falls back to each segment's
`screencast.fallback_image`. Record screencasts locally and let CI consume
them from the cache.

## Publishing safely

Use the helper instead of hand-running a partial root publish:

```bash
cd webinar-builder
npm run publish:academy
```

If local API keys are available, it restores the cache, builds and stitches all
modules locally, rebuilds the dashboard, publishes all root artifacts to
`gh-pages`, and triggers the Pages deploy workflow. A direct push to `gh-pages`
also triggers `pages-deploy.yml`, so locally published artifacts become live
without a separate manual redeploy. If the required local keys are not
available, the helper triggers the GitHub `Publish course` workflow so the build
happens with repository secrets.

To install the optional local pre-push hook:

```bash
cd webinar-builder
npm run hooks:install
```

The hook runs before pushes to `main`. With local keys it publishes artifacts
first; without local keys it lets the push continue so the `push` trigger on
`publish.yml` builds and publishes from GitHub.

Do not use a scoped root publish for the course site unless you only want to
refresh one project's video blobs while preserving every other project:

```bash
npm run ci:publish -- root --only-project face-inpainting
```

The publish script preserves sibling `videos/<project>/` folders for scoped
refreshes, but the safest main-site publish remains:

```bash
npm run ci:publish -- root
```
