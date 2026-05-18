/**
 * Walks the "publish your workspace as a public landing page" flow.
 *
 * Astria UI surface (verified live, May 2026):
 *   - Workspaces list:       /workspaces  →  <a href="/workspaces/121?ws=...">
 *   - Workspace settings:    /workspaces/121
 *   - Edit pencil:           <a href="/workspaces/121/edit?ws=...">
 *   - Brief textarea:        textarea#workspace_brief
 *   - Public toggle:         input.toggle#workspace_public  (daisyui switch)
 *   - Save:                  input[type='submit'][value='Save']
 *   - Public link (post-save): <a href="/w/maison-lume?ws=...">Public</a>
 *   - Landing page:          /w/<slug>  (templates gallery with brand brief)
 *   - AI assistant button:   <a aria-label="AI assistant">  (top-right, btn-primary)
 *   - Chat composer:         textarea.aui-composer-input
 *
 * Narration anchors (~75s total):
 *    0.0 s  land on /workspaces
 *    4.0 s  "select your workspace"
 *    9.0 s  "click the pencil to edit"
 *   13.0 s  "expand the brief — describe the brand voice"
 *   30.0 s  "toggle Public on"
 *   35.0 s  "save"
 *   40.0 s  "now a Public link appears"
 *   44.0 s  "click it to view your branded landing page"
 *   52.0 s  "open the AI assistant"
 *   56.0 s  "ask it to refine the layout in plain language"
 *   72.0 s  end (response begins rendering)
 *
 * Run headed:
 *   HEADED=1 npx tsx pipeline/record-screencast.ts --project workspace-public-page 02-workflow
 */
import type { RecordScript } from "../../../pipeline/record-screencast.js";

const BASE_URL = process.env.ASTRIA_UI_URL ?? "https://www.astria.ai";

// Workspace owned by the demo account (storageState.json). Renamed to
// "Maison Lume" with the slug below so the published URL is clean.
const WORKSPACE_ID = "159";
const WORKSPACE_SLUG = "maison-lume-demo";

// The expanded brief typed during the demo. Replaces the short pre-saved
// placeholder. Kept editorial-luxe — the AI uses this to compose the
// public landing page.
const BRIEF_TEXT = [
  "Maison Lume is a contemporary fashion atelier rooted in quiet luxury.",
  "We design timeless silhouettes in natural fibres — raw linen,",
  "cashmere, silk — in a muted palette of bone, sand, smoke and warm gold.",
  "Our editorial campaigns lean cinematic: soft daylight, calm postures,",
  "and an unhurried, lived-in elegance.",
].join(" ");

// What the user types into the AI assistant chat to iterate on the
// landing page. Kept short enough to fit inside the 14-second window.
const CHAT_PROMPT =
  "Change the hero title to \"Maison Lume — Spring '26\" and add a soft cream banner above the templates.";

async function glide(page: import("playwright").Page, x: number, y: number, steps = 16) {
  await page.mouse.move(x, y, { steps });
}

/**
 * Close any dismissible top banners (alert/info/announcement strips,
 * "verify email", upgrade nudges, balance warnings, …). Tolerant — does
 * nothing when no banner is present. Call after every navigation and
 * after the AI chat opens.
 *
 * The pattern is captured in the webinar-builder skill ("Step 2 — Source
 * assets"): every recorder script in this repo should call this helper.
 */
async function dismissBanners(
  page: import("playwright").Page,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  // Astria lazy-renders the announcement strip after DOMContentLoaded.
  // Give it a beat so the very-first navigation can still catch it.
  await sleep(400);
  const closed = await page
    .evaluate(() => {
      const out: string[] = [];
      // Astria-specific announcement stack — top of page, `data-announcement-banner`
      const banners = Array.from(
        document.querySelectorAll<HTMLElement>(
          [
            "[data-announcement-banner]",
            ".alert",
            ".banner",
            "[role='alert']",
            "[class*='announce' i]",
            "[class*='notification' i]",
            "[class*='toast' i]",
            "[class*='flash' i]",
          ].join(","),
        ),
      );
      for (const b of banners) {
        const cs = getComputedStyle(b);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        // Prefer a child button with × / close affordance.
        const closeBtn =
          b.querySelector<HTMLElement>(
            "button[aria-label*='close' i], button.btn-ghost.btn-xs, button.btn-circle, .close, [data-action*='close']",
          ) ??
          // Fall back: any button whose visible text is just '×' or 'X'.
          Array.from(b.querySelectorAll<HTMLElement>("button")).find(
            (el) => /^[×x✕✖]\s*$/i.test((el.textContent || "").trim()),
          ) ??
          null;
        if (closeBtn) {
          closeBtn.click();
          out.push(b.className.slice(0, 60) || b.tagName);
        } else if (b.matches("[data-announcement-banner]")) {
          // Banner has no usable button — remove the wrapper directly so it
          // doesn't eat vertical pixels. Equivalent to the site's own
          // onclick="this.closest('div').remove()".
          b.remove();
          out.push(`removed:${b.className.slice(0, 40)}`);
        }
      }
      return out;
    })
    .catch(() => [] as string[]);
  if (closed.length) {
    console.log(`[record] dismissed banners: ${closed.join(" | ")}`);
    await sleep(250);
  }
}

async function clickFirst(
  page: import("playwright").Page,
  candidates: string[],
  sleep: (ms: number) => Promise<void>,
  perTimeoutMs = 600,
): Promise<boolean> {
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    const box = await el.boundingBox({ timeout: perTimeoutMs }).catch(() => null);
    if (!box) continue;
    await glide(page, box.x + box.width / 2, box.y + box.height / 2, 14);
    await sleep(180);
    await el.click({ timeout: 800 }).catch(() => {});
    return true;
  }
  return false;
}

/** Click into a form field at a precise spot so subsequent typing lands cleanly. */
async function focusField(
  page: import("playwright").Page,
  selector: string,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const el = page.locator(selector).first();
  const box = await el.boundingBox({ timeout: 1000 }).catch(() => null);
  if (!box) return false;
  await glide(page, box.x + box.width / 2, box.y + box.height / 2, 14);
  await sleep(150);
  await el.click({ timeout: 600 }).catch(() => {});
  return true;
}

const script: RecordScript = async ({ page, sleep }) => {
  // ── Step 1 — Workspaces list ─────────────────────────────────────
  // @0 → 4   "Open your workspaces dashboard…"
  await page.goto(`${BASE_URL}/workspaces`, { waitUntil: "domcontentloaded" });
  await dismissBanners(page, sleep);
  await sleep(2000);

  // ── Step 2 — Click Maison Lume row ───────────────────────────────
  // @4 → 9   "…and pick the workspace you want to publish."
  const wsRowSel = `a[href*='/workspaces/${WORKSPACE_ID}']`;
  const rowBox = await page
    .locator(wsRowSel)
    .first()
    .boundingBox({ timeout: 2000 })
    .catch(() => null);
  if (rowBox) {
    await glide(page, rowBox.x + 60, rowBox.y + rowBox.height / 2, 14);
    await sleep(400);
  }
  await clickFirst(page, [wsRowSel], sleep);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await dismissBanners(page, sleep);
  await sleep(2000);                                 // ≈ t=9

  // ── Step 3 — Click the pencil → edit page ────────────────────────
  // @9 → 13  "Click the pencil to open the brief."
  await clickFirst(
    page,
    [
      `a[href*='/workspaces/${WORKSPACE_ID}/edit']`,
      `a[aria-label*='edit' i]`,
    ],
    sleep,
  );
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await dismissBanners(page, sleep);
  await sleep(1500);                                 // ≈ t=13

  // ── Step 4 — Expand the brief ────────────────────────────────────
  // @13 → 30  "Describe your brand — the AI uses this to write the page."
  await focusField(page, "textarea#workspace_brief", sleep);
  await sleep(250);
  // Select-all + delete the placeholder before typing the richer brief.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await sleep(150);
  await page.keyboard.press("Backspace").catch(() => {});
  await sleep(200);
  await page.keyboard.type(BRIEF_TEXT, { delay: 22 }).catch(() => {});
  await sleep(1500);                                 // settle — ≈ t=30

  // ── Step 5 — Toggle Public on ────────────────────────────────────
  // @30 → 35  "Flip Public on."
  //
  // The visible switch is a daisyui `.toggle` styled input. Clicking
  // the wrapping <label> hits the affordance the user actually sees.
  // We belt-and-suspenders the underlying checkbox in case the click
  // missed (e.g. layout shift) — the form is what the server reads.
  await clickFirst(
    page,
    [
      `label.label:has(#workspace_public)`,
      `input#workspace_public + label`,
      `label[for='workspace_public']`,
      `#workspace_public`,
    ],
    sleep,
  );
  await sleep(400);
  await page
    .evaluate(() => {
      const cb = document.querySelector<HTMLInputElement>("#workspace_public");
      if (cb && !cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      }
    })
    .catch(() => {});
  await sleep(3500);                                 // ≈ t=35

  // ── Step 6 — Save ────────────────────────────────────────────────
  // @35 → 40  "Save."
  await clickFirst(
    page,
    [
      `input[type='submit'][value='Save']`,
      `button[type='submit']:has-text('Save')`,
    ],
    sleep,
  );
  // Save redirects to /workspaces/<id>; tolerate slow re-render or a
  // transient Turbo error page by simply waiting on the DOM.
  await page.waitForLoadState("domcontentloaded", { timeout: 6000 }).catch(() => {});
  await sleep(3500);                                 // ≈ t=40

  // If the save landed on an error page, navigate manually to the
  // workspace — the data was persisted server-side either way.
  const onError = await page
    .locator("text=/something went wrong/i")
    .isVisible()
    .catch(() => false);
  if (onError) {
    await page
      .goto(`${BASE_URL}/workspaces/${WORKSPACE_ID}?ws=${WORKSPACE_ID}`, {
        waitUntil: "domcontentloaded",
      })
      .catch(() => {});
    await sleep(1500);
  }

  // ── Step 7 — Click the "Public" link ─────────────────────────────
  // @40 → 44  "A 'Public' link appears next to the title…"
  //
  // The badge is a small `btn btn-sm btn-secondary` <a> next to the
  // header buttons. Glide+click for the visual beat, then guarantee
  // navigation with a goto fallback if we somehow stayed put — the
  // recording must land on the public page.
  const publicHref = `/w/${WORKSPACE_SLUG}?ws=${WORKSPACE_ID}`;
  await clickFirst(
    page,
    [`a[href*='/w/${WORKSPACE_SLUG}']`, `a.btn-secondary:has-text('Public')`],
    sleep,
  );
  await page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => {});
  await sleep(800);
  if (!page.url().includes(`/w/${WORKSPACE_SLUG}`)) {
    await page.goto(`${BASE_URL}${publicHref}`, { waitUntil: "domcontentloaded" }).catch(() => {});
  }
  await dismissBanners(page, sleep);
  await sleep(3500);                                 // landing settles — ≈ t=48

  // Glide around the hero area so viewers see "what the page looks like."
  await glide(page, 480, 260, 18);
  await sleep(900);
  await glide(page, 1100, 420, 18);
  await sleep(1200);                                 // ≈ t=52

  // ── Step 8 — Back to workspace settings for the chat ─────────────
  // The AI assistant button lives in the authenticated chrome (top
  // right of /workspaces/<id>), not on the bare public landing page.
  // Navigate back so the chat is reachable.
  await page.goto(`${BASE_URL}/workspaces/${WORKSPACE_ID}?ws=${WORKSPACE_ID}`, {
    waitUntil: "domcontentloaded",
  });
  await dismissBanners(page, sleep);
  await sleep(1200);                                 // ≈ t=54

  // ── Step 9 — Open AI assistant ───────────────────────────────────
  // @54 → 56  "Open the assistant…"
  await clickFirst(
    page,
    [
      `a[aria-label='AI assistant']`,
      `a.btn.btn-primary[aria-label*='assistant' i]`,
    ],
    sleep,
  );
  await sleep(800);                                  // panel opens — ≈ t=53
  await dismissBanners(page, sleep);                 // intro tip strip, if any

  // Start a fresh chat so prior runs' messages don't pile up in the
  // panel. Astria renders a "New chat" / "+" button at the top of the
  // chat sidebar. Tolerant — no-op if absent.
  await clickFirst(
    page,
    [
      `.chat-sidebar button[aria-label*='new' i]`,
      `.chat-sidebar button[title*='new' i]`,
      `.chat-sidebar a[aria-label*='new' i]`,
      `button:has-text('New chat')`,
    ],
    sleep,
    400,
  );
  await sleep(800);                                  // ≈ t=54

  // ── Step 9 — Type a refinement prompt ────────────────────────────
  // @56 → 70  "…and describe the change in plain language."
  await focusField(page, "textarea.aui-composer-input", sleep);
  await sleep(250);
  await page.keyboard.type(CHAT_PROMPT, { delay: 26 }).catch(() => {});
  await sleep(1500);                                 // ≈ t=70

  // ── Step 10 — Send ───────────────────────────────────────────────
  // @70 → 75  hold while the assistant starts responding.
  // The composer usually accepts Enter as send (Shift+Enter for newline).
  await page.keyboard.press("Enter").catch(() => {});
  await sleep(5000);                                 // ≈ t=75 — end
};

export default script;
