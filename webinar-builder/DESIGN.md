# Astria Academy — Visual Identity

## Style Prompt

Editorial, minimal, high-contrast. The feel of a fashion-industry keynote: black as canvas, off-white typography, one accent of desaturated warm coral for emphasis. Everything breathes — generous margins, sparse decoration, hero slide + hero speaker. Motion is restrained and confident: slow fades, never bouncy. Feels like Apple announcing a camera, not a tech startup demo.

## Colors

- `#0B0B0C` — canvas (primary background, almost black but not pure)
- `#F4F1EC` — text primary (warm off-white, reads as paper-white on black)
- `#A8A39A` — text secondary (muted warm grey for labels, captions)
- `#E06A4E` — accent coral (emphasis only — one element per scene max)
- `#1E1D1C` — surface (cards, slide frame, slight lift from canvas)

## Typography

- Display / headlines: **"Inter Display"**, weight 600, tracking -0.02em
- Body / narration captions: **"Inter"**, weight 400
- Numeric data (if any): **"JetBrains Mono"**, weight 500, tabular-nums

Headlines: 96–120px. Body: 28–36px. Labels: 20px.

## Motion

- Entrances: `power3.out`, 0.6–0.9s duration
- Exits: never (transitions handle scene change — see HyperFrames rule 3)
- Transitions: crossfade only, 0.6s. No wipes, no shader flash.
- Stagger: 120ms between grouped items
- Ambient: a barely-perceptible 4% opacity drift on background, 8s loop

## What NOT to Do

1. No pure white (`#FFFFFF`) on pure black — always the warm off-white on the near-black canvas.
2. No more than one `#E06A4E` accent in a single frame — coral is precious.
3. No gradient fills on text or large surfaces — kills readability and bands on H.264.
4. No bouncy eases (`elastic`, `back.out`) — breaks the editorial tone.
5. No centered body paragraphs — all body text is left-aligned.
