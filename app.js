(() => {
  "use strict";

  const state = {
    manifest: null,
    method: null,
    task: null,
    camera: null,
    sampleIdx: 0,
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

  async function computeErrorMap(realBSrc, fakeBSrc, canvas) {
    const [imgB, imgF] = await Promise.all([loadImage(realBSrc), loadImage(fakeBSrc)]);
    const w = imgB.naturalWidth, h = imgB.naturalHeight;
    canvas.width = w; canvas.height = h;
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext("2d", { willReadFrequently: true });

    tctx.drawImage(imgB, 0, 0, w, h);
    const dataB = tctx.getImageData(0, 0, w, h).data;
    tctx.clearRect(0, 0, w, h);
    tctx.drawImage(imgF, 0, 0, w, h);
    const dataF = tctx.getImageData(0, 0, w, h).data;

    const out = tctx.createImageData(w, h);
    const n = w * h;
    // per-pixel mean abs diff across RGB, scaled for visibility
    const SCALE = 2.2;
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      const dr = Math.abs(dataB[i] - dataF[i]);
      const dg = Math.abs(dataB[i+1] - dataF[i+1]);
      const db = Math.abs(dataB[i+2] - dataF[i+2]);
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
    buildTabs(el("#task-tabs"), state.manifest.tasks, (v) => { state.task = v; state.sampleIdx = 0; render(); }, () => state.task);
    buildTabs(el("#camera-tabs"), state.manifest.cameras, (v) => { state.camera = v; state.sampleIdx = 0; render(); }, () => state.camera);
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
      row.addEventListener("click", () => { state.method = m; state.sampleIdx = 0; render(); });
      list.appendChild(row);
    });
  }

  function currentEntry() {
    return state.entryIndex.get(keyOf(state.method, state.task, state.camera)) || null;
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

  async function renderPanels(entry) {
    if (!entry || !entry.samples.length) return;
    const s = entry.samples[state.sampleIdx];
    const panelA = el('.panel[data-kind="real_A"] .panel-img');
    const panelB = el('.panel[data-kind="real_B"] .panel-img');
    const panelF = el('.panel[data-kind="fake_B"] .panel-img');
    const panelErr = el('.panel[data-kind="error"] .panel-error-canvas');

    panelA.src = s.real_A;
    panelB.src = s.real_B;
    panelF.src = s.fake_B;
    panelA.dataset.full = s.real_A;
    panelB.dataset.full = s.real_B;
    panelF.dataset.full = s.fake_B;

    try {
      const dataUrl = await computeErrorMap(s.real_B, s.fake_B, panelErr);
      panelErr.dataset.full = dataUrl;
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

  function render() {
    els(".method-row").forEach((r) => r.classList.toggle("active", r.dataset.method === state.method));
    els("#task-tabs button").forEach((b) => b.classList.toggle("active", b.textContent === state.task));
    els("#camera-tabs button").forEach((b) => b.classList.toggle("active", b.textContent === state.camera));

    const entry = currentEntry();
    el("#entry-method-name").textContent = state.method || "—";
    el("#entry-task-cam").textContent = entry
      ? `${entry.task} · ${entry.camera} camera · ${entry.n_samples} held-out samples`
      : "No data for this combination";

    renderMetrics(entry);
    buildSampleStrip(entry);
    renderPanels(entry);
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

  function wirePanelZoom() {
    els(".panel").forEach((panel) => {
      panel.querySelector(".panel-canvas-wrap").addEventListener("click", () => {
        const tagEl = panel.querySelector(".panel-tag");
        const img = panel.querySelector(".panel-img");
        const canvas = panel.querySelector(".panel-error-canvas");
        let src;
        if (img) src = img.dataset.full || img.src;
        else if (canvas) src = canvas.dataset.full || canvas.toDataURL("image/png");
        if (src) openLightbox(tagEl.textContent, src);
      });
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
