/* Astria Academy — channel dashboard.
   Static router over site/manifest.json: channel grid + per-video watch pages. */

const STATUS_LABEL = { built: "Built", failed: "Render failed", unchanged: "Unchanged" };
const SHORTS_MAX_SECONDS = 10 * 60;
const CHANNEL_SECTIONS = [
  { id: "all", label: "All" },
  { id: "shorts", label: "Shorts" },
  { id: "videos", label: "Videos" },
  { id: "archived", label: "Archived" },
];

let manifest = null;

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function attr(s) {
  return esc(s).replace(/'/g, "&#39;");
}

function routeHash(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) qs.set(key, value);
  }
  const next = qs.toString();
  return next ? `#${next}` : "#";
}

function normalizeSection(section) {
  return CHANNEL_SECTIONS.some((item) => item.id === section) ? section : "all";
}

function sectionParam(section) {
  const normalized = normalizeSection(section);
  return normalized === "all" ? "" : normalized;
}

function projectTags(project) {
  return Array.isArray(project.tags) ? project.tags.map((tag) => String(tag).toLowerCase()) : [];
}

function hasProjectTag(project, tag) {
  return projectTags(project).includes(tag);
}

function isArchivedProject(project) {
  return hasProjectTag(project, "archived");
}

function activeProjects(projects) {
  return projects.filter((project) => !isArchivedProject(project));
}

function projectSection(project) {
  if (isArchivedProject(project)) return "archived";
  const duration = Number(project.duration);
  if (!Number.isFinite(duration) || duration <= 0) return "unknown";
  return duration < SHORTS_MAX_SECONDS ? "shorts" : "videos";
}

function emptyStateCopy(section, hasSearch) {
  if (hasSearch) {
    return {
      title: "No tutorials found",
      body: "Try another search term.",
    };
  }
  if (section === "shorts") {
    return {
      title: "No shorts yet",
      body: "Shorts are tutorials under 10 minutes.",
    };
  }
  if (section === "videos") {
    return {
      title: "No videos yet",
      body: "Videos are tutorials 10 minutes or longer.",
    };
  }
  if (section === "archived") {
    return {
      title: "No archived tutorials",
      body: "Archived tutorials will appear here.",
    };
  }
  return {
    title: "No tutorials found",
    body: "There are no course videos in this build yet.",
  };
}

function fmtDur(sec) {
  if (!sec || sec <= 0) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

function countViews(project) {
  const seed = [...project.id].reduce((n, ch) => n + ch.charCodeAt(0), 0);
  return `${Math.max(71, project.builtCount * 63 + seed)} views`;
}

function dateLabel(value) {
  const dateParts = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = dateParts
    ? new Date(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3]))
    : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function buildDateLabel(m) {
  const label = dateLabel(m.generatedAt);
  return label ? `Updated ${label}` : "Latest build";
}

function publishDateLabel(project) {
  const label = dateLabel(project.addedAt);
  return label ? `Published ${label}` : "Publish date unavailable";
}

function statusClass(project) {
  if (!project.inBuild) return "unchanged";
  if (project.failedCount) return "failed";
  return "built";
}

function shareButton(title, href) {
  return `
    <button class="icon-button share-button" type="button" title="Share" aria-label="Share ${attr(title)}" data-share-title="${attr(title)}" data-share-href="${attr(href)}">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
        <path d="M12 16V4" />
        <path d="m7 9 5-5 5 5" />
      </svg>
    </button>`;
}

function cardDetails(project) {
  const details = [fmtDur(project.duration)];
  if (isArchivedProject(project)) details.push("Archived");
  if (project.failedCount) details.push(`${project.failedCount} failed`);
  return details.join(" · ");
}

function thumbnail(videoUrl, title, duration, status, thumbnailUrl) {
  if (!videoUrl) {
    return `
      <div class="thumb no-video">
        <div class="thumb-missing">No full cut</div>
        <span class="duration">--:--</span>
      </div>`;
  }
  return `
    <div class="thumb">
      ${
        thumbnailUrl
          ? `<img src="${esc(thumbnailUrl)}" alt="" loading="lazy" />`
          : `<video muted playsinline preload="metadata" src="${esc(videoUrl)}#t=1"></video>`
      }
      <div class="thumb-sheen"></div>
      <span class="duration">${fmtDur(duration)}</span>
      <span class="status-dot ${status}" aria-label="${esc(status)}"></span>
    </div>`;
}

function channelCard(project) {
  const href = `#watch=${encodeURIComponent(project.id)}`;
  const status = statusClass(project);
  const section = projectSection(project);
  const tags = projectTags(project);
  const searchText = [
    project.title,
    project.id,
    tags.join(" "),
    project.addedAt,
    project.addedCommit,
    project.segments.map((seg) => [seg.title, seg.visual, seg.id, seg.script].join(" ")).join(" "),
  ].join(" ");
  return `
    <article class="video-card" data-search="${attr(searchText.toLowerCase())}" data-section="${attr(section)}" data-tags="${attr(tags.join(" "))}" data-archived="${isArchivedProject(project) ? "true" : "false"}">
      <a class="thumb-link" href="${href}" aria-label="Open ${attr(project.title)}">
        ${thumbnail(project.fullDraftUrl, project.title, project.duration, status, project.thumbnailUrl)}
      </a>
      <div class="card-row">
        <a class="video-title" href="${href}">${esc(project.title)}</a>
        ${shareButton(project.title, href)}
      </div>
      <div class="video-meta">${countViews(project)} · ${publishDateLabel(project)}</div>
      <div class="video-submeta">${cardDetails(project)}</div>
    </article>`;
}

function segmentStatus(seg) {
  return `<span class="badge ${seg.status}">${STATUS_LABEL[seg.status] || seg.status}</span>`;
}

function playableSegments(project) {
  return project.segments.filter((seg) => Boolean(seg.videoUrl));
}

function firstPlayableSegment(project) {
  return playableSegments(project)[0] || null;
}

function watchHref(project, seg) {
  const base = `#watch=${encodeURIComponent(project.id)}`;
  return seg ? `${base}&segment=${encodeURIComponent(seg.id)}` : base;
}

function segmentList(project) {
  return project.segments
    .map((seg, index) => {
      const playable = Boolean(seg.videoUrl);
      const inner = `
          <div class="queue-index">${String(index + 1).padStart(2, "0")}</div>
          <div class="queue-thumb">
            ${
              seg.thumbnailUrl
                ? `<img src="${esc(seg.thumbnailUrl)}" alt="" loading="lazy" />`
                : seg.videoUrl
                ? `<video muted playsinline preload="metadata" src="${esc(seg.videoUrl)}#t=0.5"></video>`
                : ""
            }
            <span>${playable ? fmtDur(seg.duration) : "N/A"}</span>
          </div>
          <div class="queue-copy">
            <div class="queue-title">${esc(seg.title)}</div>
            <div class="queue-meta">${esc(seg.visual)} · ${esc(seg.id)}${playable ? "" : " · unavailable"}</div>
          </div>
        `;
      if (!playable) {
        return `<div class="queue-item is-${seg.status} disabled" aria-disabled="true" data-segment-id="${attr(seg.id)}">${inner}</div>`;
      }
      return `<a class="queue-item is-${seg.status}" href="${watchHref(project, seg)}" data-segment-id="${attr(seg.id)}">${inner}</a>`;
    })
    .join("");
}

function artifactLink(label, url) {
  if (!url) return `<div class="artifact missing"><span>${esc(label)}</span><b>not present</b></div>`;
  return `<a class="artifact" href="${esc(url)}" target="_blank" rel="noreferrer"><span>${esc(label)}</span><b>${esc(url)}</b></a>`;
}

function debugPanel(project, activeSegment, isSegmentMode) {
  if (!isSegmentMode) {
    return `
      <details class="debug-panel">
        <summary>
          <div>
            <div class="panel-kicker">Full Video</div>
            <h2>${esc(project.title)}</h2>
          </div>
          <div class="segment-pills">
            <span class="badge built">Full cut</span>
            <span class="pill">${fmtDur(project.duration)}</span>
            <span class="pill mono">${esc(project.id)}</span>
          </div>
        </summary>
        <div class="debug-grid">
          <div class="script-box">
            <div class="label">Playback</div>
            <p>Complete stitched tutorial cut. Switch to Segments to review individual chapters as a playlist.</p>
          </div>
          <div class="artifact-box">
            <div class="label">Build artifacts</div>
            ${artifactLink("Full draft video", project.fullDraftUrl)}
            ${artifactLink("Thumbnail", project.thumbnailUrl)}
          </div>
        </div>
      </details>`;
  }
  const seg = activeSegment;
  if (!seg) return "";
  return `
    <details class="debug-panel">
      <summary>
        <div>
          <div class="panel-kicker">Selected Segment</div>
          <h2>${esc(seg.title)}</h2>
        </div>
        <div class="segment-pills">
          ${segmentStatus(seg)}
          <span class="pill">${esc(seg.visual)}</span>
          <span class="pill">${fmtDur(seg.duration)}</span>
          <span class="pill mono">${esc(seg.id)}</span>
        </div>
      </summary>
      <div class="debug-grid">
        <div class="script-box">
          <div class="label">Script / on-screen text</div>
          <p>${esc(seg.script)}</p>
        </div>
        <div class="artifact-box">
          <div class="label">Build artifacts</div>
          ${artifactLink("Segment video", seg.videoUrl)}
          ${artifactLink("Narration audio", seg.inputs?.audio)}
          ${artifactLink("Avatar / talking head", seg.inputs?.avatar)}
          ${artifactLink("Screencast capture", seg.inputs?.capture)}
        </div>
      </div>
    </details>`;
}

function playerMarkup(project, activeSegment, isSegmentMode) {
  const source = isSegmentMode ? activeSegment?.videoUrl : project.fullDraftUrl;
  const poster = isSegmentMode ? activeSegment?.thumbnailUrl : project.thumbnailUrl;
  const title = isSegmentMode ? activeSegment?.title : "Full video";
  if (!source) return `<div class="player-placeholder">No video available for this selection.</div>`;
  return `<video id="watch-video" controls autoplay playsinline preload="metadata" ${
    poster ? `poster="${esc(poster)}"` : ""
  } src="${esc(source)}" data-mode="${isSegmentMode ? "segment" : "full"}" aria-label="${attr(title)}"></video>`;
}

function modeSwitch(project, activeSegment, isSegmentMode) {
  const firstSegment = activeSegment || firstPlayableSegment(project);
  return `
    <div class="mode-switch" aria-label="Playback mode">
      <a class="${isSegmentMode ? "" : "active"}" href="${watchHref(project)}">Full video</a>
      ${
        firstSegment
          ? `<a class="${isSegmentMode ? "active" : ""}" href="${watchHref(project, firstSegment)}">Segments</a>`
          : `<span class="disabled">Segments</span>`
      }
    </div>`;
}

function nextSegmentHref(project, activeSegment) {
  if (!activeSegment) return "";
  const segments = playableSegments(project);
  const index = segments.findIndex((seg) => seg.id === activeSegment.id);
  return index >= 0 && segments[index + 1] ? watchHref(project, segments[index + 1]) : "";
}

function wireWatchPlayer(project, activeSegment, isSegmentMode) {
  const video = document.getElementById("watch-video");
  if (!video || !isSegmentMode) return;
  const nextHref = nextSegmentHref(project, activeSegment);
  if (!nextHref) return;
  video.addEventListener("ended", () => {
    location.hash = nextHref.slice(1);
  });
}

function relatedRail(projects, currentId) {
  return projects
    .filter((p) => p.id !== currentId && !isArchivedProject(p))
    .map(
      (p) => `
        <a class="related" href="#watch=${encodeURIComponent(p.id)}">
          <div class="related-thumb">${thumbnail(p.fullDraftUrl, p.title, p.duration, statusClass(p), p.thumbnailUrl)}</div>
          <div>
            <div class="related-title">${esc(p.title)}</div>
            <div class="related-meta">${fmtDur(p.duration)}</div>
          </div>
        </a>`,
    )
    .join("");
}

function route() {
  const raw = location.hash.replace(/^#/, "");
  const params = new URLSearchParams(raw);
  return {
    watch: params.get("watch"),
    segment: params.get("segment"),
    section: normalizeSection(params.get("section")),
    q: params.get("q") || "",
  };
}

function topBar(_m, title = "Astria Academy", q = "") {
  return `
    <header class="channel-top">
      <a class="brand" href="#">
        <img class="brand-logo" src="brand/astria-logo.png" alt="Astria" />
        <span>${esc(title)}</span>
      </a>
      <div class="search-shell">
        <input type="search" id="search" placeholder="Search tutorials" aria-label="Search tutorials" value="${attr(q)}" />
      </div>
    </header>`;
}

function shareUrl(href) {
  const url = new URL(location.href);
  url.hash = href.replace(/^#/, "");
  return url.toString();
}

function copyShareUrl(url) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(url);
  const input = document.createElement("textarea");
  input.value = url;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.top = "-999px";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
  return Promise.resolve();
}

function flashShared(button) {
  const label = button.dataset.originalLabel || button.getAttribute("aria-label") || "Share";
  button.dataset.originalLabel = label;
  button.classList.add("copied");
  button.setAttribute("aria-label", "Link copied");
  window.clearTimeout(button.shareTimer);
  button.shareTimer = window.setTimeout(() => {
    button.classList.remove("copied");
    button.setAttribute("aria-label", label);
  }, 1600);
}

function wireShareButtons() {
  for (const button of document.querySelectorAll("[data-share-href]")) {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const title = button.dataset.shareTitle || document.title;
      const url = shareUrl(button.dataset.shareHref || "#");
      try {
        if (navigator.share) {
          await navigator.share({ title, url });
        } else {
          await copyShareUrl(url);
        }
        flashShared(button);
      } catch (err) {
        if (err?.name === "AbortError") return;
        await copyShareUrl(url);
        flashShared(button);
      }
    });
  }
}

function sectionTabs(q, activeSection) {
  const selected = normalizeSection(activeSection);
  return `
      <nav class="tabs" aria-label="Channel sections">
        ${CHANNEL_SECTIONS.map((section) => {
          const active = section.id === selected;
          return `<a href="${attr(routeHash({ section: sectionParam(section.id), q }))}" data-section-filter="${attr(section.id)}"${
            active ? ` class="active" aria-current="page"` : ""
          }>${esc(section.label)}</a>`;
        }).join("")}
      </nav>`;
}

function updateSectionLinks(q) {
  for (const link of document.querySelectorAll("[data-section-filter]")) {
    link.setAttribute("href", routeHash({ section: sectionParam(link.dataset.sectionFilter), q }));
  }
}

function applyFilters(q, section = "all") {
  const needle = q.trim().toLowerCase();
  const selected = normalizeSection(section);
  let shown = 0;
  for (const card of document.querySelectorAll(".video-card")) {
    const sectionMatch = selected === "all" ? card.dataset.archived !== "true" : card.dataset.section === selected;
    const searchMatch = !needle || card.dataset.search.includes(needle);
    const match = sectionMatch && searchMatch;
    card.hidden = !match;
    if (match) shown += 1;
  }
  const empty = document.getElementById("no-results");
  if (empty) {
    const copy = emptyStateCopy(selected, Boolean(needle));
    empty.querySelector("h2").textContent = copy.title;
    empty.querySelector("p").textContent = copy.body;
    empty.hidden = shown > 0;
  }
}

function wireSearch(q, isWatchPage, section = "all") {
  const search = document.getElementById("search");
  if (!search) return;
  search.addEventListener("input", () => {
    const next = search.value.trim();
    if (isWatchPage) {
      const current = route();
      location.hash = routeHash({ watch: current.watch, segment: current.segment, q: next }).slice(1);
      return;
    }
    const selected = normalizeSection(section);
    history.replaceState(null, "", routeHash({ section: sectionParam(selected), q: next }));
    updateSectionLinks(next);
    applyFilters(next, selected);
  });
  if (!isWatchPage) applyFilters(q, section);
}

function renderChannel(m, q = "", section = "all") {
  const activeSection = normalizeSection(section);
  const visibleProjects = activeProjects(m.projects);
  const totalDuration = visibleProjects.reduce((sum, p) => sum + (p.duration || 0), 0);
  document.title = "Astria Academy";
  document.getElementById("app").innerHTML = `
    ${topBar(m, "Astria Academy", q)}
    <main class="channel">
      <section class="channel-hero">
        <div class="avatar">A</div>
        <div>
          <div class="eyebrow">Astria Academy</div>
          <h1>Course Videos</h1>
          <p>${visibleProjects.length} tutorials · ${fmtDur(totalDuration)} total · ${buildDateLabel(m)}</p>
        </div>
      </section>
      ${sectionTabs(q, activeSection)}
      <section class="video-grid" id="video-grid">
        ${m.projects.map((p) => channelCard(p)).join("")}
      </section>
      <div class="no-results" id="no-results" hidden>
        <h2>No tutorials found</h2>
        <p>Try another search term.</p>
      </div>
    </main>`;

  wireSearch(q, false, activeSection);
  wireShareButtons();
}

function renderWatch(m, projectId, segmentId, q = "") {
  const project = m.projects.find((p) => p.id === projectId) || m.projects[0];
  if (!project) return renderChannel(m);
  const activeSegment = segmentId ? project.segments.find((s) => s.id === segmentId && s.videoUrl) || firstPlayableSegment(project) : null;
  const isSegmentMode = Boolean(segmentId && activeSegment);
  document.title = `${project.title} · Astria Academy`;
  document.getElementById("app").innerHTML = `
    ${topBar(m, "Astria Academy", q)}
    <main class="watch">
      <section class="watch-main">
        <div class="watch-player-head">
          <a class="back-link" href="#">← Back to videos</a>
          ${modeSwitch(project, activeSegment, isSegmentMode)}
        </div>
        <div class="main-player">
          ${playerMarkup(project, activeSegment, isSegmentMode)}
        </div>
        <div class="watch-title-row">
          <div>
            <h1>${esc(project.title)}</h1>
            <p>${
              isSegmentMode
                ? `Segment: ${esc(activeSegment.title)} · ${fmtDur(activeSegment.duration)} · ${esc(activeSegment.id)}`
                : `${countViews(project)} · ${addedDateLabel(project)} · ${project.segmentCount} segments · ${fmtDur(project.duration)}`
            }</p>
          </div>
          <div class="watch-actions">
            ${shareButton(isSegmentMode ? `${project.title}: ${activeSegment.title}` : project.title, isSegmentMode ? watchHref(project, activeSegment) : watchHref(project))}
          </div>
        </div>
        ${debugPanel(project, activeSegment, isSegmentMode)}
      </section>
      <aside class="watch-side">
        <div class="side-card">
          <div class="section-title">Segments</div>
          <div class="queue">${segmentList(project)}</div>
        </div>
        <div class="side-card">
          <div class="section-title">More Videos</div>
          <div class="related-list">${relatedRail(m.projects, project.id)}</div>
        </div>
      </aside>
    </main>`;
  if (isSegmentMode) document.querySelector(`[data-segment-id="${CSS.escape(activeSegment.id)}"]`)?.classList.add("active");
  wireWatchPlayer(project, activeSegment, isSegmentMode);
  wireSearch(q, true);
  wireShareButtons();
}

function render(m) {
  const r = route();
  if (r.watch) renderWatch(m, r.watch, r.segment, r.q);
  else renderChannel(m, r.q, r.section);
}

fetch("manifest.json", { cache: "no-store" })
  .then((r) => {
    if (!r.ok) throw new Error(`manifest.json ${r.status}`);
    return r.json();
  })
  .then((m) => {
    manifest = m;
    render(manifest);
    window.addEventListener("hashchange", () => render(manifest));
  })
  .catch((err) => {
    document.getElementById("app").innerHTML =
      `<div class="boot">Could not load manifest.json — ${esc(err.message)}</div>`;
  });
