/**
 * Compiled for scripts/intent/09c-technicalities.yaml.
 *
 * Plays before 09d-build-look — the technicalities overview happens
 * first so the audience knows the framework before we start filling in
 * cubes. Opens the Lookbook to expose the settings row, then moves the
 * cursor over each settings box (Model / Resolution / Aspect / Count)
 * timed to narration anchors. Cubes are empty at this point — that's
 * fine; we're showing the settings, not the references.
 *
 * Narration anchors (≈24 s):
 *    0.00 s  "Now for a few technicalities"
 *    2.69 s  "Model — Nano Banana 2"
 *    6.65 s  "Resolution — 2K"
 *   12.97 s  "Aspect ratio — 3:4"
 *   18.78 s  "2 images per prompt"
 *   24.16 s  end
 *
 * Run headed: `HEADED=1 npx tsx pipeline/record-screencast.ts 09c-technicalities`
 *
 * Timing discipline: every locator must fail FAST (≤500 ms) with .catch().
 */
import type { RecordScript } from "../../../pipeline/record-screencast.js";

const BASE_URL = process.env.ASTRIA_BASE_URL ?? "https://www.astria.ai";

async function glide(page: import("playwright").Page, x: number, y: number, steps = 16) {
  await page.mouse.move(x, y, { steps });
}


const script: RecordScript = async ({ page, sleep }) => {
  // Land on /prompts. Open the Lookbook to expose the cube grid above;
  // populated cubes from 09c persist server-side in the demo workspace
  // (when state isn't there, cubes show empty — still a working tour).
  await page.goto(`${BASE_URL}/prompts`, { waitUntil: "domcontentloaded" });
  await sleep(600);

  const toggle = page.locator(
    `.lookbook-toggle, button:has-text("Lookbook"), [role="tab"]:has-text("Lookbook")`
  ).first();
  const tbox = await toggle.boundingBox({ timeout: 500 }).catch(() => null);
  if (tbox) await toggle.click({ timeout: 500 }).catch(() => {});
  await sleep(700);

  // Find the Nano Banana button by its visible text and force its
  // ancestor row into the lower-middle of the viewport. Use scrollTo
  // on documentElement directly — scrollIntoView on the cube grid's
  // child often resolves to the cube grid container, leaving the
  // settings row off-screen below.
  await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button'], [class*='select']"));
    const nano = all.find((b) => /nano banana/i.test((b.textContent ?? "").trim()));
    if (nano) {
      // Use scrollIntoView with center alignment so the settings row
      // lands in the middle of the viewport regardless of which scroll
      // container actually moves (window vs an inner overflow:auto div).
      nano.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    } else {
      // Fallback: scroll near bottom of page so prompt + settings sit in view.
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" as ScrollBehavior });
    }
  }).catch(() => {});
  await sleep(800);                                   // ≈ t=2.1 — settle after scroll

  // Resolve each settings-row button's actual coordinates via JS, then
  // glide the cursor to those exact viewport positions. This sidesteps
  // Playwright's locator/scroll quirks — settings-row controls are inside
  // a Stimulus-managed dropdown wrapper that doesn't always honor
  // scrollIntoViewIfNeeded the way `.hover()` expects.

  // Astria's settings row is a series of <select> elements styled to
  // look like dropdown buttons. Target each by its `name` attribute.
  // For the model, the visible <select> has w=1 (hidden behind a custom
  // button), so fall back to the visible wrapper containing "Nano Banana".
  //
  // Passed as a raw STRING to evaluate — tsx/esbuild rewrites named
  // arrow-function bodies with a `__name` runtime helper that isn't
  // defined in the browser, blowing up the eval. String-form bypasses
  // the rewrite.
  const settingsCoords = await page.evaluate(`(() => {
    function center(el) {
      if (!el) return null;
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    var selects = Array.from(document.querySelectorAll("select"));
    function byName(name) {
      for (var i = 0; i < selects.length; i++) {
        if (selects[i].name === name) return selects[i];
      }
      return null;
    }
    var allEls = Array.from(document.querySelectorAll("*"));
    var nanoTrigger = null;
    for (var j = 0; j < allEls.length; j++) {
      var el = allEls[j];
      var t = (el.textContent || "").trim();
      if (!/Nano Banana/i.test(t)) continue;
      var rr = el.getBoundingClientRect();
      if (rr.width < 50 || rr.width > 500) continue;
      if (rr.height < 16 || rr.height > 80) continue;
      var ctx = 0;
      for (var k = 0; k < el.children.length; k++) {
        if ((el.children[k].textContent || "").trim().length > 0) ctx++;
      }
      if (ctx <= 4) { nanoTrigger = el; break; }
    }
    return {
      model: center(nanoTrigger || byName("prompt[tune_id]")),
      resolution: center(byName("prompt[resolution]")),
      aspect: center(byName("prompt[aspect_ratio]")),
      count: center(byName("prompt[num_images]")),
    };
  })()`).catch(() => ({ model: null, resolution: null, aspect: null, count: null })) as { model: { x: number; y: number } | null; resolution: { x: number; y: number } | null; aspect: { x: number; y: number } | null; count: { x: number; y: number } | null };

  const hoverAt = async (coord: { x: number; y: number } | null, holdMs: number) => {
    if (!coord) return;
    await glide(page, coord.x, coord.y, 18);
    await page.waitForTimeout(holdMs);
  };

  // "Model — Nano Banana 2" @2.69, hold to ~6.4
  await hoverAt(settingsCoords.model, 600);
  await sleep(2900);

  // "Resolution — 2K" @6.65, hold to ~12.7
  await hoverAt(settingsCoords.resolution, 600);
  await sleep(5000);

  // "Aspect ratio — 3:4" @12.97, hold to ~18.5
  await hoverAt(settingsCoords.aspect, 600);
  await sleep(4500);

  // "2 images per prompt" @18.78, hold to end (~24s)
  await hoverAt(settingsCoords.count, 600);
  await sleep(4500);
};

export default script;
