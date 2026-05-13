# webinar-builder

A scriptable, rebuildable video harness. The default project is the Astria
fashion-lookbook webinar; the same pipeline drives bi-weekly one-off tutorials
(e.g. `video-style-transfer`) by addressing them with `--project <name>`.

- **Script** (`script/projects/<project>.yaml` + `script/segments/<project>/*.yaml`) is the source of truth.
- **Pipeline** (`pipeline/*.ts`) regenerates only what changed: narration audio, avatar clips, and the HTML composition.
- **Render** (`hyperframes render`) produces the MP4 at `out/<project>/<segment>.mp4`.

Edit a narration line → re-run `npm run build:segment -- <id>` → only that segment re-renders.

## Tiers

| Tier  | Needs             | What you get                                                                 |
| ----- | ----------------- | ---------------------------------------------------------------------------- |
| **A** | nothing extra     | macOS `say` narration over a design-matched slide. Fast, free, validates layout. |
| **B** | `HEYGEN_API_KEY`  | HeyGen Avatar IV lip-synced talking head + native HeyGen voice.              |

The same `npm run build` command drives both — if `HEYGEN_API_KEY` is set in `.env`, Tier B kicks in; otherwise Tier A.

## Quickstart

```bash
npm install
npm run build:segment -- 03-traditional-photoshoot   # renders out/03-traditional-photoshoot.mp4
```

## Switching to Tier B (real avatar)

```bash
cp .env.example .env
# edit .env — paste your HeyGen key into HEYGEN_API_KEY=
npm run build:segment -- 03-traditional-photoshoot
```

The build script will:
1. Call HeyGen Avatar IV with the segment's narration text
2. Poll until the job completes
3. Download the MP4 to `assets/avatars/<id>.mp4` (cached by hash of text+avatar+voice)
4. Extract the audio track to `assets/audio/<id>.mp3`
5. Swap the `<!-- tier-a:start ... end -->` block in `index.html` for a `<video>` element
6. Re-render the composition

Change the narration text → the hash changes → HeyGen is called again for that segment only.

## Iteration loop

Fastest feedback:

```bash
npm run preview   # opens HyperFrames studio with hot-reload
```

Full render:

```bash
npm run build:segment -- 03-traditional-photoshoot
```

Multiple segments (once the script has them):

```bash
npm run build:all
```

## Editing a segment

1. Open `script/segments/<project>/<id>.yaml` (default project: `webinar`)
2. Tweak the `narration:` block
3. `npm run build:segment -- <id>`     (or `--project <name> --segment <id>` for non-webinar projects)

## One-off tutorials

The harness is project-keyed. To author a new bi-weekly video without touching
the webinar, create a project manifest and segments under its namespace:

```
script/projects/<name>.yaml         # ordered segment list + defaults
script/segments/<name>/<id>.yaml    # per-segment config
scripts/record/<name>/<id>.ts       # (optional) Playwright recorder
assets/results/<name>/              # finished demo videos for video-showcase
```

Then build with `npm run build -- --project <name> --all` (or use a project-specific
script alias such as `build:vst` for `video-style-transfer`).

## Directory map

```
webinar-builder/
├── index.html                   # Per-segment composition, overwritten by build.ts
├── hyperframes.json             # HyperFrames project config
├── DESIGN.md                    # Visual identity (colors, type, motion)
├── script/
│   ├── projects/
│   │   ├── webinar.yaml
│   │   └── video-style-transfer.yaml
│   └── segments/
│       ├── webinar/             # 01-opening.yaml, 02-outline.yaml, …
│       └── video-style-transfer/
├── layouts/                     # avatar-hero.html, presenter-slide.html,
│                                # screencast-pip.html, video-showcase.html
├── assets/
│   ├── audio/<project>/         # TTS audio per project
│   ├── avatars/<project>/       # talking-head MP4s per project
│   ├── captures/<project>/      # Playwright screencasts per project
│   ├── results/<project>/       # finished demo videos (video-showcase intros)
│   └── slides/                  # static slide imagery
├── scripts/
│   ├── auth/                    # storageState.json bootstrap
│   ├── intent/<project>/        # natural-language intent yaml (planning)
│   └── record/<project>/        # Playwright recording scripts
├── pipeline/
│   ├── build.ts                 # orchestrator (npm run build:*)
│   ├── stitch.ts                # concat segments → _full-draft.mp4
│   └── record-screencast.ts     # Playwright runner
└── out/<project>/
    ├── *.mp4                    # rendered per-segment outputs
    └── _full-draft.mp4          # stitched
```

## Roadmap

- [x] Tier-A render path (macOS say + slide)
- [x] Tier-B HeyGen Avatar IV client with hash cache
- [ ] `website-to-hyperframes` integration for Astria UI demo segments
- [ ] Multi-segment composition (sub-compositions per segment)
- [ ] Burned-in captions from `transcript_en.srt`
- [ ] Voice clone of Alon (ElevenLabs)
