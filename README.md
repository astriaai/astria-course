# Astria Academy

A bi-weekly series of cinematic tutorial videos for [Astria](https://www.astria.ai) —
fashion-lookbook automation, edit-image, 3D packshots, video style transfer and
more. Each module is **scripted in YAML and rendered by a reproducible
pipeline**, so a one-line narration tweak re-renders only what changed.

## Course site

The whole course is published as a browsable debug dashboard:

**https://www.astria.ai/academy/**

Every module, every segment — the rendered video, the narration script, and
the input artifacts side by side. Built so an editor or non-technical reviewer
can spot what's wrong without touching the code.

## Repository layout

```
webinar-builder/      the video harness — see webinar-builder/README.md
  script/             YAML source of truth (projects, segments)
  pipeline/           the TypeScript build pipeline
  dashboard/          the course debug-GUI shell
.github/workflows/    CI — build, review, publish
docs/CI.md            how CI & publishing work
```

## Working on the course

1. Branch, edit a segment's `narration:` (or add a module) under
   `webinar-builder/script/`, open a PR.
2. CI posts a **free DRAFT preview** link and Claude reviews the PR.
3. When the script reads right, a maintainer comments **`/render-paid`** to
   render real narration, avatars and video.
4. Merge → the course **publishes** to the site above.

See [`docs/CI.md`](docs/CI.md) for the full workflow and
[`webinar-builder/README.md`](webinar-builder/README.md) for the pipeline.

For an explicit local-or-GitHub publish, run:

```bash
cd webinar-builder
npm run publish:academy
```

Mention **`@claude`** in any PR or issue for help.
