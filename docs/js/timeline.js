// トラック式タイムライン
// 各動画を「共通タイムライン上のどこからどこまでにあるか」を示す横棒で表示する。
// 棒をドラッグすると開始位置（offset）が変わる。目盛りや空いている所をドラッグすると全体をシークする。

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const SNAP_PX = 7;

class Timeline {
  constructor(root, engine, hooks) {
    this.root = root;
    this.engine = engine;
    this.hooks = hooks; // { onOffset(tile, v, final), onSelect(tile), onMute(tile), markers(), selectedId(), allMuted() }
    this.view = { start: 0, span: 60 };
    this.fit = true;
    this.drag = null;
    this.tickKey = '';
    root.innerHTML = `
      <div class="tl-row tl-ruler-row">
        <div class="tl-corner">
          <button class="ib sm" data-z="out" data-tip="縮小"><svg><use href="#i-minus"/></svg></button>
          <button class="ib sm" data-z="fit" data-tip="全体を表示"><svg><use href="#i-fit"/></svg></button>
          <button class="ib sm" data-z="in" data-tip="拡大（Ctrl + ホイールでも可）"><svg><use href="#i-plus"/></svg></button>
        </div>
        <div class="tl-ruler"><div class="tl-ticks"></div><div class="tl-marks"></div><div class="tl-knob"></div></div>
      </div>
      <div class="tl-body"><div class="tl-tracks"></div><div class="tl-line"></div><div class="tl-empty">過去配信を追加すると、ここに並びます</div></div>
      <div class="tl-tip" hidden></div>`;
    this.ruler = root.querySelector('.tl-ruler');
    this.ticks = root.querySelector('.tl-ticks');
    this.marks = root.querySelector('.tl-marks');
    this.knob = root.querySelector('.tl-knob');
    this.body = root.querySelector('.tl-body');
    this.tracks = root.querySelector('.tl-tracks');
    this.line = root.querySelector('.tl-line');
    this.tip = root.querySelector('.tl-tip');

    root.querySelectorAll('[data-z]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.z === 'fit') this.fit = true;
      else this.zoom(b.dataset.z === 'in' ? 0.5 : 2, this.engine.master);
      this.update();
    }));
    this.ruler.addEventListener('pointerdown', (e) => this.startScrub(e));
    this.body.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.trk-bar, .trk-head')) return;
      if (e.target.closest('.trk-lane') || e.target === this.body || e.target === this.tracks) this.startScrub(e);
    });
    root.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.end(e));
    window.addEventListener('pointercancel', (e) => this.end(e));
    new ResizeObserver(() => { this.tickKey = ''; this.update(); }).observe(root);
  }

  // ライブは時間の軸を持たないので、タイムラインには過去配信だけを並べる
  vods() { return this.engine.tiles.filter((t) => t.type !== 'live'); }

  // ---------- 座標変換 ----------
  laneRect() { return this.ruler.getBoundingClientRect(); }
  // 横幅は update() のたびに測り直して使い回す（毎回測ると重いため）
  x(t) { return ((t - this.view.start) / this.view.span) * this.w; }
  tAt(clientX) {
    const r = this.laneRect();
    return this.view.start + ((clientX - r.left) / r.width) * this.view.span;
  }
  total() { return Math.max(1, this.engine.duration()); }

  zoom(factor, anchor) {
    const D = this.total();
    const span = clamp(this.view.span * factor, 2, D);
    const ratio = (anchor - this.view.start) / this.view.span;
    this.view.span = span;
    this.view.start = clamp(anchor - ratio * span, 0, Math.max(0, D - span));
    this.fit = span >= D - 0.01;
  }

  wheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      this.zoom(e.deltaY > 0 ? 1.25 : 0.8, this.tAt(e.clientX));
      this.update();
    } else if (!this.fit && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
      e.preventDefault();
      const d = (e.shiftKey ? e.deltaY : e.deltaX) / this.laneRect().width * this.view.span;
      this.view.start = clamp(this.view.start + d, 0, Math.max(0, this.total() - this.view.span));
      this.update();
    }
  }

  // ---------- ドラッグ ----------
  startScrub(e) {
    if (e.button !== 0 || !this.vods().length) return;
    e.preventDefault();
    this.drag = { kind: 'scrub', last: 0 };
    this.scrubTo(e.clientX, true);
  }
  scrubTo(clientX, force) {
    const now = performance.now();
    const t = clamp(this.tAt(clientX), 0, this.engine.duration());
    this.engine.master = t;
    if (force || now - this.drag.last > 90) { this.drag.last = now; this.engine.seek(t); }
    this.update();
  }

  startBar(e, tile) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.hooks.onSelect(tile);
    this.drag = { kind: 'bar', tile, x0: e.clientX, off0: tile.offset, moved: false };
  }

  snapTargets(tile) {
    const out = [0, this.engine.master];
    for (const t of this.vods()) {
      if (t === tile || !t.player?.ready) continue;
      out.push(-t.offset, t.player.getDuration() - t.offset);
    }
    for (const m of this.hooks.markers()) out.push(m.t);
    return out;
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'scrub') { this.scrubTo(e.clientX, false); return; }
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const w = this.laneRect().width;
    let off = d.off0 - (dx / w) * this.view.span;
    // 近くの目印（0・再生位置・他の動画の端・マーカー）に吸い付かせる。Alt で無効
    if (!e.altKey && d.tile.player?.ready) {
      const dur = d.tile.player.getDuration();
      const pxPerSec = w / this.view.span;
      let best = null;
      for (const target of this.snapTargets(d.tile)) {
        for (const edge of [-off, dur - off]) {
          const dist = Math.abs(edge - target) * pxPerSec;
          if (dist < SNAP_PX && (!best || dist < best.dist)) best = { dist, shift: target - edge };
        }
      }
      if (best) off -= best.shift;
    }
    this.hooks.onOffset(d.tile, off, false);
    this.showTip(e.clientX, `開始位置 ${fmtTime(d.tile.offset, true)}`);
    this.update();
  }

  end() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.tip.hidden = true;
    if (d.kind === 'scrub') this.engine.seek(this.engine.master);
    if (d.kind === 'bar' && d.moved) this.hooks.onOffset(d.tile, d.tile.offset, true);
  }

  showTip(clientX, text) {
    const r = this.root.getBoundingClientRect();
    this.tip.hidden = false;
    this.tip.textContent = text;
    this.tip.style.left = `${clamp(clientX - r.left, 40, r.width - 40)}px`;
  }

  // ---------- 描画 ----------
  // 動画の追加・削除・名前変更のときだけ作り直す
  build() {
    this.tracks.innerHTML = '';
    this.vods().forEach((tile, i) => {
      const row = document.createElement('div');
      row.className = 'trk';
      row.style.setProperty('--c', tile.color);
      row.innerHTML = `
        <div class="trk-head">
          <span class="chip">${tile.num ?? i + 1}</span>
          <span class="trk-name"></span>
          <button class="ib xs trk-mute" data-tip="ミュート"><svg><use href="#i-vol"/></svg></button>
        </div>
        <div class="trk-lane"><div class="trk-bar"><span class="trk-bar-label"></span></div></div>`;
      row.querySelector('.trk-name').textContent = tile.label;
      row.querySelector('.trk-bar-label').textContent = tile.label;
      row.querySelector('.trk-head').addEventListener('click', (e) => {
        if (e.target.closest('.trk-mute')) this.hooks.onMute(tile);
        else this.hooks.onSelect(tile);
      });
      row.querySelector('.trk-bar').addEventListener('pointerdown', (e) => this.startBar(e, tile));
      tile.trk = row;
      this.tracks.appendChild(row);
    });
    this.root.classList.toggle('is-empty', !this.vods().length);
    this.update();
  }

  renderTicks() {
    const w = this.w;
    const key = `${this.view.start.toFixed(3)}|${this.view.span.toFixed(3)}|${Math.round(w)}`;
    if (key === this.tickKey || w <= 0) return;
    this.tickKey = key;
    const step = TICK_STEPS.find((s) => (s / this.view.span) * w >= 72) || 3600;
    const minor = step / 5;
    const end = this.view.start + this.view.span + 1e-6;
    const frag = document.createDocumentFragment();
    for (let i = Math.ceil(this.view.start / minor - 1e-6); i * minor <= end; i++) {
      const t = i * minor;
      const major = i % 5 === 0;
      const el = document.createElement('span');
      el.className = major ? 'tk major' : 'tk';
      el.style.left = `${this.x(t)}px`;
      if (major) el.dataset.label = fmtTime(t, step < 1);
      frag.appendChild(el);
    }
    this.ticks.replaceChildren(frag);
  }

  renderMarks() {
    const frag = document.createDocumentFragment();
    for (const m of this.hooks.markers()) {
      const x = this.x(m.t);
      if (x < -6 || x > this.w + 6) continue;
      const el = document.createElement('button');
      el.className = 'mk';
      el.style.left = `${x}px`;
      el.dataset.tip = m.note ? `${fmtTime(m.t, true)}  ${m.note}` : fmtTime(m.t, true);
      el.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.engine.seek(m.t); });
      frag.appendChild(el);
    }
    this.marks.replaceChildren(frag);
  }

  update() {
    this.w = this.laneRect().width;
    const D = this.total();
    if (this.fit) this.view = { start: 0, span: D };
    this.view.span = Math.min(this.view.span, D);
    // 再生中に再生位置が画面の外へ出たら、ページをめくるように追いかける
    const m = this.engine.master;
    if (!this.fit && this.engine.playing && !this.drag && (m > this.view.start + this.view.span * 0.96 || m < this.view.start)) {
      this.view.start = clamp(m - this.view.span * 0.05, 0, Math.max(0, D - this.view.span));
    }
    this.renderTicks();
    this.renderMarks();
    const w = this.w;
    const px = this.x(m);
    const visible = px >= -1 && px <= w + 1;
    this.knob.style.transform = `translateX(${px}px)`;
    this.line.style.transform = `translateX(${px}px)`;
    this.knob.hidden = !visible;
    this.line.hidden = !visible || !this.vods().length;
    const sel = this.hooks.selectedId();
    for (const tile of this.vods()) {
      if (!tile.trk) continue;
      const bar = tile.trk.querySelector('.trk-bar');
      const p = tile.player;
      const ok = p?.ready && !p.error;
      const dur = ok ? p.getDuration() : 0;
      const a = this.x(-tile.offset);
      const b = this.x((dur || D) - tile.offset);
      bar.style.left = `${a}px`;
      bar.style.width = `${Math.max(2, b - a)}px`;
      bar.classList.toggle('pending', !ok);
      bar.classList.toggle('err', !!p?.error);
      tile.trk.classList.toggle('sel', tile.id === sel);
      const mute = tile.trk.querySelector('.trk-mute use');
      const muted = tile.muted || this.hooks.allMuted();
      if (mute.getAttribute('href') !== (muted ? '#i-mute' : '#i-vol')) mute.setAttribute('href', muted ? '#i-mute' : '#i-vol');
    }
  }
}
