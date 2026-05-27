/* Astria Academy — channel dashboard.
   Static router over site/manifest.json: channel grid + per-video watch pages. */

const STATUS_LABEL = { built: "Built", failed: "Render failed", unchanged: "Unchanged" };

let manifest = null;

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function attr(s) {
  return esc(s).replace(/'/g, "&#39;");
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

function ageLabel(m) {
  const generated = new Date(m.generatedAt).getTime();
  if (!Number.isFinite(generated)) return "latest build";
  const days = Math.max(0, Math.round((Date.now() - generated) / 86400000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}

function statusClass(project) {
  if (!project.inBuild) return "unchanged";
  if (project.failedCount) return "failed";
  return "built";
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

function channelCard(project, m) {
  const href = `#watch=${encodeURIComponent(project.id)}`;
  const status = statusClass(project);
  const failed = project.failedCount ? `<span class="warn">${project.failedCount} failed</span>` : "all segments built";
  return `
    <article class="video-card">
      <a class="thumb-link" href="${href}" aria-label="Open ${attr(project.title)}">
        ${thumbnail(project.fullDraftUrl, project.title, project.duration, status, project.thumbnailUrl)}
      </a>
      <div class="card-row">
        <a class="video-title" href="${href}">${esc(project.title)}</a>
        <button class="kebab" type="button" title="More">⋮</button>
      </div>
      <div class="video-meta">${countViews(project)} · ${ageLabel(m)}</div>
      <div class="video-submeta">${project.segmentCount} segments · ${fmtDur(project.duration)} · ${failed}</div>
    </article>`;
}

function segmentStatus(seg) {
  return `<span class="badge ${seg.status}">${STATUS_LABEL[seg.status] || seg.status}</span>`;
}

function segmentList(project) {
  return project.segments
    .map((seg, index) => {
      const href = `#watch=${encodeURIComponent(project.id)}&segment=${encodeURIComponent(seg.id)}`;
      return `
        <a class="queue-item is-${seg.status}" href="${href}" data-segment-id="${attr(seg.id)}">
          <div class="queue-index">${String(index + 1).padStart(2, "0")}</div>
          <div class="queue-thumb">
            ${
              seg.thumbnailUrl
                ? `<img src="${esc(seg.thumbnailUrl)}" alt="" loading="lazy" />`
                : seg.videoUrl
                ? `<video muted playsinline preload="metadata" src="${esc(seg.videoUrl)}#t=0.5"></video>`
                : ""
            }
            <span>${fmtDur(seg.duration)}</span>
          </div>
          <div class="queue-copy">
            <div class="queue-title">${esc(seg.title)}</div>
            <div class="queue-meta">${esc(seg.visual)} · ${esc(seg.id)}</div>
          </div>
        </a>`;
    })
    .join("");
}

function artifactLink(label, url) {
  if (!url) return `<div class="artifact missing"><span>${esc(label)}</span><b>not present</b></div>`;
  return `<a class="artifact" href="${esc(url)}" target="_blank" rel="noreferrer"><span>${esc(label)}</span><b>${esc(url)}</b></a>`;
}

function debugPanel(project, activeSegment) {
  const seg = activeSegment || project.segments[0];
  if (!seg) return "";
  return `
    <section class="debug-panel">
      <div class="panel-head">
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
      </div>
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
    </section>`;
}

function segmentPlayer(project, activeSegment) {
  if (!activeSegment?.videoUrl) return "";
  return `
    <section class="segment-player">
      <div class="section-title">Segment Player</div>
      <video controls preload="metadata" playsinline ${activeSegment.thumbnailUrl ? `poster="${esc(activeSegment.thumbnailUrl)}"` : ""} src="${esc(activeSegment.videoUrl)}"></video>
    </section>`;
}

function relatedRail(projects, currentId) {
  return projects
    .filter((p) => p.id !== currentId)
    .map(
      (p) => `
        <a class="related" href="#watch=${encodeURIComponent(p.id)}">
          <div class="related-thumb">${thumbnail(p.fullDraftUrl, p.title, p.duration, statusClass(p), p.thumbnailUrl)}</div>
          <div>
            <div class="related-title">${esc(p.title)}</div>
            <div class="related-meta">${p.segmentCount} segments · ${fmtDur(p.duration)}</div>
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
  };
}

function topBar(m, title = "Astria Academy") {
  return `
    <header class="channel-top">
      <a class="brand" href="#">
        <span class="play-mark"></span>
        <span>${esc(title)}</span>
      </a>
      <div class="search-shell">
        <input type="search" id="search" placeholder="Search tutorials" aria-label="Search tutorials" />
      </div>
      <div class="top-meta">
        <span>${esc(m.buildMode)}</span>
        ${m.commit ? `<span>${esc(m.commit)}</span>` : ""}
      </div>
    </header>`;
}

function renderChannel(m) {
  const totalDuration = m.projects.reduce((sum, p) => sum + (p.duration || 0), 0);
  document.title = "Astria Academy";
  document.getElementById("app").innerHTML = `
    ${topBar(m)}
    <main class="channel">
      <section class="channel-hero">
        <div class="avatar">A</div>
        <div>
          <div class="eyebrow">Astria Academy</div>
          <h1>Course Videos</h1>
          <p>${m.projects.length} tutorials · ${fmtDur(totalDuration)} total · ${ageLabel(m)}</p>
        </div>
      </section>
      <nav class="tabs" aria-label="Channel sections">
        <a class="active" href="#">Videos</a>
        <a href="#debug">Debug</a>
      </nav>
      <section class="video-grid" id="video-grid">
        ${m.projects.map((p) => channelCard(p, m)).join("")}
      </section>
      <section class="debug-index" id="debug">
        <div class="section-title">Build Debug</div>
        <div class="debug-table">
          ${m.projects
            .map(
              (p) => `
                <a href="#watch=${encodeURIComponent(p.id)}" class="debug-row">
                  <span class="status-dot ${statusClass(p)}"></span>
                  <b>${esc(p.title)}</b>
                  <span>${p.builtCount}/${p.segmentCount} segments</span>
                  <span>${fmtDur(p.duration)}</span>
                  <span>${p.fullDraftUrl ? esc(p.fullDraftUrl) : "no full draft"}</span>
                </a>`,
            )
            .join("")}
        </div>
      </section>
    </main>`;

  const search = document.getElementById("search");
  search?.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const card of document.querySelectorAll(".video-card")) {
      card.hidden = q && !card.textContent.toLowerCase().includes(q);
    }
  });
}

function renderWatch(m, projectId, segmentId) {
  const project = m.projects.find((p) => p.id === projectId) || m.projects[0];
  if (!project) return renderChannel(m);
  const activeSegment =
    project.segments.find((s) => s.id === segmentId) ||
    project.segments.find((s) => s.status === "built") ||
    project.segments[0];
  document.title = `${project.title} · Astria Academy`;
  document.getElementById("app").innerHTML = `
    ${topBar(m, "Astria Academy")}
    <main class="watch">
      <section class="watch-main">
        <div class="main-player">
          ${
            project.fullDraftUrl
              ? `<video controls autoplay playsinline preload="metadata" ${project.thumbnailUrl ? `poster="${esc(project.thumbnailUrl)}"` : ""} src="${esc(project.fullDraftUrl)}"></video>`
              : `<div class="player-placeholder">No full draft rendered for this video.</div>`
          }
        </div>
        <div class="watch-title-row">
          <div>
            <a class="back-link" href="#">← Back to videos</a>
            <h1>${esc(project.title)}</h1>
            <p>${countViews(project)} · ${ageLabel(m)} · ${project.segmentCount} segments · ${fmtDur(project.duration)}</p>
          </div>
          <a class="open-button" href="${esc(project.fullDraftUrl || "#")}" target="_blank" rel="noreferrer">Open MP4</a>
        </div>
        ${debugPanel(project, activeSegment)}
        ${segmentPlayer(project, activeSegment)}
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
  document.querySelector(`[data-segment-id="${CSS.escape(activeSegment?.id || "")}"]`)?.classList.add("active");
}

function render(m) {
  const r = route();
  if (r.watch) renderWatch(m, r.watch, r.segment);
  else renderChannel(m);
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
