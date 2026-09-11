(() => {
  "use strict";

  const COMPARE3_METHODS = ["Classical Color Alignment", "Pix2Pix", "DINO-Align (Ours)"];

  const VIEW_OPTIONS = [
    { key: "single", label: "Single baseline" },
    { key: "compare3", label: "Compare: main 3" },
    { key: "compareAll", label: "Compare: all baselines" },
  ];

  const state = {
    manifest: null,
    method: null,
    task: null,
    camera: null,
    sampleIdx: 0, // index into entry.samples, single-baseline mode
    compareSampleIdxStr: null, // sample idx string ("000007"), compare modes
    viewMode: "single",
    entryIndex: new Map(), // key: method|task|camera -> entry
  };

  const el = (sel, root = document) => root.querySelector(sel);
  const els = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function keyOf(method, task, camera) { return `${method}|${task}|${camera}`; }

  function fmt(n) { return (typeof n === "number") ? n.toFixed(3) : "—"; }

  // ---------- Turbo colormap (compact polynomial approximation) ----------
  function turbo(t) {
    t = Math.min(1, Math.max(0, t));
    const kR = [0.13572138, 4.61539260, -42.66032258, 132.13108234, -152.94239396, 59.28637943];
    const kG = [0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604];
    const kB = [0.10667330, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973];
    const poly = (k) => k[0] + t*(k[1] + t*(k[2] + t*(k[3] + t*(k[4] + t*k[5]))));
    const r = Math.round(255 * Math.min(1, Math.max(0, poly(kR))));
    const g = Math.round(255 * Math.min(1, Math.max(0, poly(kG))));
    const b = Math.round(255 * Math.min(1, Math.max(0, poly(kB))));
    return [r, g, b];
  }
  const turboLUT = new Array(256);
  for (let i = 0; i < 256; i++) turboLUT[i] = turbo(i / 255);

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function computeErrorMap(refSrc, fakeBSrc, canvas) {
    const [imgRef, imgF] = await Promise.all([loadImage(refSrc), loadImage(fakeBSrc)]);
    const w = imgRef.naturalWidth, h = imgRef.naturalHeight;
    canvas.width = w; canvas.height = h;
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext("2d", { willReadFrequently: true });

    tctx.drawImage(imgRef, 0, 0, w, h);
    const dataRef = tctx.getImageData(0, 0, w, h).data;
    tctx.clearRect(0, 0, w, h);
    tctx.drawImage(imgF, 0, 0, w, h);
    const dataF = tctx.getImageData(0, 0, w, h).data;

    const out = tctx.createImageData(w, h);
    const n = w * h;
    // per-pixel mean abs diff across RGB, scaled for visibility
    const SCALE = 2.2;
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      const dr = Math.abs(dataRef[i] - dataF[i]);
      const dg = Math.abs(dataRef[i+1] - dataF[i+1]);
      const db = Math.abs(dataRef[i+2] - dataF[i+2]);
      const mag = (dr + dg + db) / 3;
      const idx = Math.min(255, Math.round(mag * SCALE));
      const [r, g, b] = turboLUT[idx];
      out.data[i] = r; out.data[i+1] = g; out.data[i+2] = b; out.data[i+3] = 255;
    }
    const ctx = canvas.getContext("2d");
    ctx.putImageData(out, 0, 0);
    return canvas.toDataURL("image/png");
  }

  // ---------- building UI ----------
  function buildTabs(container, values, onPick, getActive) {
    container.innerHTML = "";
    values.forEach((v) => {
      const b = document.createElement("button");
      b.textContent = v;
      b.className = getActive() === v ? "active" : "";
      b.addEventListener("click", () => onPick(v));
      container.appendChild(b);
    });
  }

  function refreshTabs() {
    buildTabs(el("#task-tabs"), state.manifest.tasks, (v) => { state.task = v; state.sampleIdx = 0; state.compareSampleIdxStr = null; render(); }, () => state.task);
    buildTabs(el("#camera-tabs"), state.manifest.cameras, (v) => { state.camera = v; state.sampleIdx = 0; state.compareSampleIdxStr = null; render(); }, () => state.camera);
    buildTabs(
      el("#view-tabs"),
      VIEW_OPTIONS.map((o) => o.label),
      (label) => {
        state.viewMode = VIEW_OPTIONS.find((o) => o.label === label).key;
        state.compareSampleIdxStr = null;
        render();
      },
      () => (VIEW_OPTIONS.find((o) => o.key === state.viewMode) || {}).label
    );
  }

  function buildSidebar() {
    const list = el("#method-list");
    list.innerHTML = "";
    el("#method-count").textContent = `(${state.manifest.methods.length})`;
    state.manifest.methods.forEach((m) => {
      const row = document.createElement("div");
      row.className = "method-row" + (state.method === m ? " active" : "");
      row.dataset.method = m;
      const mean = (state.manifest.means && state.manifest.means[m]) || {};
      row.innerHTML = `
        <div class="method-row-top">
          <span class="method-name">${m}</span>
        </div>
        <div class="method-badges">
          <span>LPIPS <b>${fmt(mean.lpips)}</b></span>
          <span>J&amp;F <b>${fmt(mean.jf)}</b></span>
        </div>`;
      row.addEventListener("click", () => { state.method = m; state.viewMode = "single"; state.sampleIdx = 0; render(); });
      list.appendChild(row);
    });
  }

  function entryFor(method, task, camera) {
    return state.entryIndex.get(keyOf(method, task, camera)) || null;
  }

  function currentEntry() {
    return entryFor(state.method, state.task, state.camera);
  }

  function buildSampleStrip(entry) {
    const strip = el("#sample-strip");
    strip.innerHTML = "";
    if (!entry) return;
    entry.samples.forEach((s, i) => {
      const d = document.createElement("div");
      d.className = "thumb" + (i === state.sampleIdx ? " active" : "");
      d.innerHTML = `<img src="${s.real_B}" loading="lazy" alt="sample ${s.idx}"><span class="thumb-idx">${s.idx}</span>`;
      d.addEventListener("click", () => { state.sampleIdx = i; render(); });
      strip.appendChild(d);
    });
  }

  function buildSampleStripMulti(idxList, refEntry) {
    const strip = el("#sample-strip");
    strip.innerHTML = "";
    idxList.forEach((idx) => {
      const s = refEntry.samples.find((x) => x.idx === idx);
      const d = document.createElement("div");
      d.className = "thumb" + (idx === state.compareSampleIdxStr ? " active" : "");
      d.innerHTML = `<img src="${s.real_B}" loading="lazy" alt="sample ${idx}"><span class="thumb-idx">${idx}</span>`;
      d.addEventListener("click", () => { state.compareSampleIdxStr = idx; render(); });
      strip.appendChild(d);
    });
  }

  async function renderPanels(entry) {
    if (!entry || !entry.samples.length) return;
    const s = entry.samples[state.sampleIdx];
    const panelA = el('.panel[data-kind="real_A"] .panel-img');
    const panelB = el('.panel[data-kind="real_B"] .panel-img');
    const panelF = el('.panel[data-kind="fake_B"] .panel-img');
    const panelErrGT = el('.panel[data-kind="error_gt"] .panel-error-canvas');
    const panelErrIn = el('.panel[data-kind="error_input"] .panel-error-canvas');

    panelA.src = s.real_A;
    panelB.src = s.real_B;
    panelF.src = s.fake_B;
    panelA.dataset.full = s.real_A;
    panelB.dataset.full = s.real_B;
    panelF.dataset.full = s.fake_B;

    try {
      const [gtUrl, inUrl] = await Promise.all([
        computeErrorMap(s.real_B, s.fake_B, panelErrGT),
        computeErrorMap(s.real_A, s.fake_B, panelErrIn),
      ]);
      panelErrGT.dataset.full = gtUrl;
      panelErrIn.dataset.full = inUrl;
    } catch (e) {
      console.error("error map failed", e);
    }
  }

  function renderMetrics(entry) {
    const box = el("#entry-metrics");
    box.innerHTML = "";
    if (!entry) return;
    const chips = [
      ["LPIPS ↓", fmt(entry.lpips)],
      ["J&F ↑", fmt(entry.jf)],
      ["J ↑", fmt(entry.j)],
      ["F ↑", fmt(entry.f)],
      ["AS ↑", fmt(entry.as)],
    ];
    chips.forEach(([label, val]) => {
      const c = document.createElement("div");
      c.className = "metric-chip";
      c.innerHTML = `${label}<b>${val}</b>`;
      box.appendChild(c);
    });
  }

  // ---------- compare view ----------
  function intersectIdx(entries) {
    if (!entries.length) return [];
    const sets = entries.map((e) => new Set(e.samples.map((s) => s.idx)));
    const [first, ...rest] = sets;
    const common = [...first].filter((idx) => rest.every((s) => s.has(idx)));
    return common.sort();
  }

  function makePanelFigure({ tagClass, tagText, labelText, kind, small }) {
    const fig = document.createElement("figure");
    fig.className = "panel" + (small ? " panel--sm" : "");
    fig.dataset.kind = kind;
    const isCanvas = kind.startsWith("error");
    fig.innerHTML = `
      <div class="panel-head"><span class="panel-tag ${tagClass}">${tagText}</span><span class="panel-label">${labelText}</span></div>
      <div class="panel-canvas-wrap">${isCanvas ? '<canvas class="panel-error-canvas"></canvas>' : '<img class="panel-img" alt="' + labelText + '" />'}</div>
    `;
    return fig;
  }

  async function renderCompare(methods, includeError) {
    const entries = methods.map((m) => ({ m, e: entryFor(m, state.task, state.camera) })).filter((x) => x.e);
    const compareRoot = el("#compare-view");
    const rowsRoot = el("#compare-rows");
    const refRoot = el("#compare-ref");
    rowsRoot.innerHTML = "";
    refRoot.innerHTML = "";

    el("#entry-metrics").innerHTML = "";

    if (!entries.length) {
      el("#entry-method-name").textContent = "No data";
      el("#entry-task-cam").textContent = "No baselines have data for this task/camera combination";
      el("#sample-strip").innerHTML = "";
      return;
    }

    const idxList = intersectIdx(entries.map((x) => x.e));
    if (!state.compareSampleIdxStr || !idxList.includes(state.compareSampleIdxStr)) {
      state.compareSampleIdxStr = idxList[0] || null;
    }

    el("#entry-method-name").textContent =
      methods.length === COMPARE3_METHODS.length && methods.every((m, i) => m === COMPARE3_METHODS[i])
        ? "Comparing: Classical Color Alignment · Pix2Pix · DINO-Align"
        : `Comparing all ${entries.length} baselines`;
    el("#entry-task-cam").textContent = `${state.task} · ${state.camera} camera · ${idxList.length} shared samples`;

    buildSampleStripMulti(idxList, entries[0].e);

    if (!state.compareSampleIdxStr) return;

    const refSample = entries[0].e.samples.find((s) => s.idx === state.compareSampleIdxStr);
    refRoot.appendChild(makePanelFigure({ tagClass: "tag-input", tagText: "Input", labelText: "Rendered sim (real_A)", kind: "real_A", small: true }));
    refRoot.appendChild(makePanelFigure({ tagClass: "tag-gt", tagText: "Ground truth", labelText: "Real target (real_B)", kind: "real_B", small: true }));
    el('#compare-ref .panel[data-kind="real_A"] .panel-img').src = refSample.real_A;
    el('#compare-ref .panel[data-kind="real_A"] .panel-img').dataset.full = refSample.real_A;
    el('#compare-ref .panel[data-kind="real_B"] .panel-img').src = refSample.real_B;
    el('#compare-ref .panel[data-kind="real_B"] .panel-img').dataset.full = refSample.real_B;

    const errorJobs = [];
    entries.forEach(({ m, e }) => {
      const sample = e.samples.find((s) => s.idx === state.compareSampleIdxStr);
      const row = document.createElement("div");
      row.className = "compare-row";
      row.innerHTML = `
        <div class="compare-row-head">
          <span class="compare-method-name">${m}</span>
          <span class="compare-method-metrics">
            <span>LPIPS <b>${fmt(e.lpips)}</b></span>
            <span>J&amp;F <b>${fmt(e.jf)}</b></span>
          </span>
        </div>
        <div class="compare-panels"></div>
      `;
      const panelsRoot = row.querySelector(".compare-panels");
      const outFig = makePanelFigure({ tagClass: "tag-out", tagText: "Model output", labelText: "Translated (fake_B)", kind: "fake_B", small: true });
      panelsRoot.appendChild(outFig);
      outFig.querySelector(".panel-img").src = sample.fake_B;
      outFig.querySelector(".panel-img").dataset.full = sample.fake_B;

      if (includeError) {
        const errGT = makePanelFigure({ tagClass: "tag-err", tagText: "Error vs GT", labelText: "|output − GT|", kind: "error_gt", small: true });
        const errIn = makePanelFigure({ tagClass: "tag-err2", tagText: "Error vs input", labelText: "|output − input|", kind: "error_input", small: true });
        panelsRoot.appendChild(errGT);
        panelsRoot.appendChild(errIn);
        const canvasGT = errGT.querySelector(".panel-error-canvas");
        const canvasIn = errIn.querySelector(".panel-error-canvas");
        errorJobs.push(
          computeErrorMap(sample.real_B, sample.fake_B, canvasGT).then((u) => { canvasGT.dataset.full = u; })
        );
        errorJobs.push(
          computeErrorMap(sample.real_A, sample.fake_B, canvasIn).then((u) => { canvasIn.dataset.full = u; })
        );
      }
      rowsRoot.appendChild(row);
    });

    try { await Promise.all(errorJobs); } catch (e) { console.error("compare error maps failed", e); }
  }

  function render() {
    els(".method-row").forEach((r) => r.classList.toggle("active", r.dataset.method === state.method && state.viewMode === "single"));
    els("#task-tabs button").forEach((b) => b.classList.toggle("active", b.textContent === state.task));
    els("#camera-tabs button").forEach((b) => b.classList.toggle("active", b.textContent === state.camera));
    els("#view-tabs button").forEach((b) => {
      const opt = VIEW_OPTIONS.find((o) => o.label === b.textContent);
      b.classList.toggle("active", opt && opt.key === state.viewMode);
    });

    el("#sidebar").classList.toggle("is-hidden", state.viewMode !== "single");
    el("#panels").hidden = state.viewMode !== "single";
    el("#compare-view").hidden = state.viewMode === "single";

    if (state.viewMode === "single") {
      const entry = currentEntry();
      el("#entry-method-name").textContent = state.method || "—";
      el("#entry-task-cam").textContent = entry
        ? `${entry.task} · ${entry.camera} camera · ${entry.n_samples} held-out samples`
        : "No data for this combination";
      renderMetrics(entry);
      buildSampleStrip(entry);
      renderPanels(entry);
    } else if (state.viewMode === "compare3") {
      renderCompare(COMPARE3_METHODS, true);
    } else if (state.viewMode === "compareAll") {
      renderCompare(state.manifest.methods, false);
    }
  }

  // ---------- lightbox ----------
  const lightbox = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };

  function openLightbox(tag, src) {
    const lb = el("#lightbox");
    const img = el("#lightbox-img");
    img.src = src;
    el("#lightbox-tag").textContent = tag;
    lightbox.scale = 1; lightbox.x = 0; lightbox.y = 0;
    applyLightboxTransform();
    lb.hidden = false;
  }
  function closeLightbox() { el("#lightbox").hidden = true; }
  function applyLightboxTransform() {
    const img = el("#lightbox-img");
    img.style.transform = `translate(${lightbox.x}px, ${lightbox.y}px) scale(${lightbox.scale})`;
  }

  function wireLightbox() {
    el("#lightbox-close").addEventListener("click", closeLightbox);
    el("#lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });

    const stage = el("#lightbox-stage");
    stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = -e.deltaY * 0.0015;
      lightbox.scale = Math.min(8, Math.max(1, lightbox.scale + lightbox.scale * delta));
      applyLightboxTransform();
    }, { passive: false });

    stage.addEventListener("mousedown", (e) => {
      lightbox.dragging = true; lightbox.lastX = e.clientX; lightbox.lastY = e.clientY;
      stage.classList.add("grabbing");
    });
    window.addEventListener("mousemove", (e) => {
      if (!lightbox.dragging) return;
      lightbox.x += e.clientX - lightbox.lastX;
      lightbox.y += e.clientY - lightbox.lastY;
      lightbox.lastX = e.clientX; lightbox.lastY = e.clientY;
      applyLightboxTransform();
    });
    window.addEventListener("mouseup", () => { lightbox.dragging = false; stage.classList.remove("grabbing"); });
    stage.addEventListener("dblclick", () => { lightbox.scale = 1; lightbox.x = 0; lightbox.y = 0; applyLightboxTransform(); });
  }

  // Delegated so dynamically-created compare-view panels are zoomable too.
  function wirePanelZoom() {
    document.addEventListener("click", (e) => {
      const wrap = e.target.closest(".panel-canvas-wrap");
      if (!wrap) return;
      const panel = wrap.closest(".panel");
      if (!panel) return;
      const tagEl = panel.querySelector(".panel-tag");
      const img = panel.querySelector(".panel-img");
      const canvas = panel.querySelector(".panel-error-canvas");
      let src;
      if (img && img.getAttribute("src")) src = img.dataset.full || img.src;
      else if (canvas) src = canvas.dataset.full || canvas.toDataURL("image/png");
      if (src) openLightbox(tagEl.textContent, src);
    });
  }

  function wireStripNav() {
    el("#strip-prev").addEventListener("click", () => el("#sample-strip").scrollBy({ left: -200, behavior: "smooth" }));
    el("#strip-next").addEventListener("click", () => el("#sample-strip").scrollBy({ left: 200, behavior: "smooth" }));
  }

  async function main() {
    const res = await fetch("manifest.json");
    const manifest = await res.json();
    state.manifest = manifest;
    manifest.entries.forEach((e) => state.entryIndex.set(keyOf(e.method, e.task, e.camera), e));

    state.method = manifest.methods[manifest.methods.length - 1]; // default: DINO-Align (Ours)
    state.task = manifest.tasks[0];
    state.camera = manifest.cameras[0];

    buildSidebar();
    refreshTabs();
    wirePanelZoom();
    wireLightbox();
    wireStripNav();
    render();
  }

  main();
})();
