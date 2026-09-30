// VOD — 画面の組み立てと操作
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const TILE_COLORS = ['#7fb3ff', '#f59e7a', '#9fd78a', '#d6a2f0', '#6fd3cf', '#f58fb0',
  '#b0a4ff', '#e6a86a', '#8fd1a8', '#c9c9cf', '#a3c4f3', '#c9a0dc'];
const MAX_TILES = 12;
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const LAYOUTS = ['auto', '1', '2', '3', '4', 'focus'];
const DRAW_COLORS = ['#f2d74e', '#ff5f57', '#5aa9ff', '#5fd08a', '#ffffff', '#111111'];
const CANVAS_FONT = '"IBM Plex Sans JP", "Hiragino Sans", "Yu Gothic UI", Meiryo, sans-serif';
const MOBILE = () => window.matchMedia('(max-width: 760px)').matches;

const settings = Object.assign({ skip: 5, skipBig: 30, fps: 30 }, storageGet('vod.settings', {}));
const engine = new SyncEngine();
const shortcuts = new Shortcuts();
const stage = $('#stage');
const grid = $('#grid');
const draw = new DrawLayer($('#draw-layer'), stage);

const state = {
  layout: 'auto', prevLayout: 'auto', focusId: null, selectedId: null,
  markers: [], allMuted: false, volume: 0.8, nextId: 1,
};

const timeline = new Timeline($('#timeline'), engine, {
  onOffset: (tile, v, final) => setOffset(tile, v, { seek: final }),
  onSelect: (tile) => select(tile),
  onMute: (tile) => toggleTileMute(tile),
  markers: () => state.markers,
  selectedId: () => state.selectedId,
  allMuted: () => state.allMuted,
});

// ============================================================
// お知らせ・エラー
// ============================================================
let toastTimer;
function toast(text, ms = 2600) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

let omniErrTimer;
function omniError(text) {
  const el = $('#omni-error');
  clearTimeout(omniErrTimer);
  el.hidden = !text;
  el.textContent = text || '';
  if (text) omniErrTimer = setTimeout(() => { el.hidden = true; }, 9000);
}

// このページ自身のスクリプトで起きたエラーだけを知らせる（埋め込みプレーヤー内のエラーは対象外）
window.addEventListener('error', (e) => {
  if (e.filename && e.filename.startsWith(location.origin)) toast(`エラーが発生しました: ${e.message}`, 5000);
});

// ============================================================
// 動画（タイル）の追加・削除
// ============================================================
function pickColor() {
  const used = new Set(engine.tiles.map((t) => t.color));
  return TILE_COLORS.find((c) => !used.has(c)) || TILE_COLORS[engine.tiles.length % TILE_COLORS.length];
}

function defaultLabel(spec) {
  if (spec.type === 'twitch') return `Twitch ${spec.src}`;
  if (spec.type === 'niconico') return spec.src;
  if (spec.type === 'url') {
    try { return decodeURIComponent(new URL(spec.src).pathname.split('/').pop()) || '動画'; } catch { return '動画'; }
  }
  if (spec.type === 'local') return String(spec.src || '').replace(/\.[^.]+$/, '') || '動画ファイル';
  return `${SOURCE_NAMES[spec.type]} 動画`;
}

function addTile(spec) {
  if (engine.tiles.length >= MAX_TILES) { toast(`動画は ${MAX_TILES} 本までです`); return null; }
  const tile = {
    id: state.nextId++,
    type: spec.type,
    src: spec.src,
    file: spec.file || null,
    label: spec.label || defaultLabel(spec),
    autoLabel: spec.label ? !!spec.autoLabel : true,
    offset: Number(spec.offset) || 0,
    muted: spec.muted ?? engine.tiles.length > 0, // 最初の1本だけ音を出す
    color: pickColor(),
    status: 'loading',
    rt: { cmdAt: 0, cooldownUntil: 0, bufSince: 0 },
    player: null,
  };
  engine.tiles.push(tile);
  buildTileEl(tile);
  startPlayer(tile);
  if (!state.selectedId) state.selectedId = tile.id;
  renderStructure();
  save();
  return tile;
}

function buildTileEl(tile) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.style.setProperty('--c', tile.color);
  el.innerHTML = `
    <div class="tile-media"></div>
    <div class="tile-cover"></div>
    <div class="tile-tag"><span class="chip"></span><span class="tile-name"></span></div>
    <div class="tile-ctl">
      <button class="ib" data-act="mute" aria-label="ミュート"><svg><use href="#i-vol"/></svg></button>
      <button class="ib" data-act="focus" aria-label="大きく表示"><svg><use href="#i-focus"/></svg></button>
      <button class="ib" data-act="remove" aria-label="外す"><svg><use href="#i-x"/></svg></button>
    </div>
    <div class="tile-meta"><span class="t">0:00.0</span><span class="off" hidden></span></div>
    <div class="tile-msg passive" hidden></div>`;
  tile.el = el;
  tile.media = $('.tile-media', el);
  tile.msgEl = $('.tile-msg', el);

  // 動画の上に透明な板を置き、クリックが埋め込みプレーヤーの中に入らないようにする
  // （中に入るとキーボードショートカットが効かなくなるため）
  const cover = $('.tile-cover', el);
  cover.addEventListener('click', () => select(tile));
  cover.addEventListener('dblclick', () => toggleFocus(tile));
  $('.tile-ctl', el).addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'mute') toggleTileMute(tile);
    if (act === 'focus') toggleFocus(tile);
    if (act === 'remove') removeTile(tile);
  });
  grid.appendChild(el);
}

function startPlayer(tile) {
  if (tile.type === 'local' && !tile.file) { showNeedFile(tile); return; }
  tile.status = 'loading';
  tile.player = createPlayer(tile, tile.media);
  tile.player
    .on('ready', () => {
      applyAudio(tile);
      if (tile.player.supportsRate) tile.player.setRate(engine.rate);
      tile.rt.cooldownUntil = 0;
      engine.syncTile(tile, performance.now());
      timeline.update();
      updateLive();
    })
    .on('title', (title) => {
      if (tile.autoLabel) { tile.label = title; renderStructure(); save(); }
    })
    .on('error', () => { tile.status = 'error'; renderStructure(); })
    .on('blocked', () => {
      // ブラウザが再生を止めたときは、少しの間だけ枠内を直接押せるようにする
      const cover = $('.tile-cover', tile.el);
      cover.style.pointerEvents = 'none';
      toast(`${tile.label}: ブラウザが再生を止めました。その動画の枠内の再生ボタンを一度押してください`, 6000);
      setTimeout(() => { cover.style.pointerEvents = ''; }, 15000);
    });
}

function showNeedFile(tile) {
  tile.status = 'needfile';
  const msg = tile.msgEl;
  msg.hidden = false;
  msg.className = 'tile-msg';
  msg.replaceChildren();
  const p = document.createElement('div');
  p.textContent = `「${tile.src}」を選び直してください`;
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.innerHTML = '<svg><use href="#i-file"/></svg>';
  btn.append('ファイルを選ぶ');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'video/*,.mkv';
  input.hidden = true;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) attachFile(tile, input.files[0]); });
  msg.append(p, btn, input);
  tile._msgKey = 'needfile';
}

function attachFile(tile, file) {
  tile.file = file;
  tile.src = file.name;
  tile.msgEl.hidden = true;
  tile._msgKey = null;
  startPlayer(tile);
  renderStructure();
  save();
}

function removeTile(tile) {
  tile.player?.destroy();
  tile.el.remove();
  engine.tiles = engine.tiles.filter((t) => t !== tile);
  if (state.focusId === tile.id) state.focusId = null;
  if (state.selectedId === tile.id) state.selectedId = engine.tiles[0]?.id ?? null;
  if (!engine.tiles.length && engine.playing) engine.pause();
  renderStructure();
  save();
}

function clearTiles() {
  for (const t of engine.tiles) { t.player?.destroy(); t.el.remove(); }
  engine.tiles = [];
  state.focusId = null;
  state.selectedId = null;
}

// 複数行の URL をまとめて追加する。読めなかった行は理由つきで返す
function addFromText(text) {
  const bad = [];
  let added = 0;
  for (const line of text.split(/[\r\n\s]+/)) {
    if (!line.trim()) continue;
    const r = parseSource(line);
    if (!r) continue;
    if (r.error) { bad.push({ line, reason: r.error }); continue; }
    if (addTile({ type: r.type, src: r.src, offset: r.start })) added++;
  }
  return { added, bad };
}

function submitOmni() {
  const input = $('#omni-input');
  if (!input.value.trim()) return;
  const { added, bad } = addFromText(input.value);
  if (bad.length) {
    input.value = bad.map((b) => b.line).join(' ');
    omniError(bad.map((b) => `${b.line}\n→ ${b.reason}`).join('\n\n'));
  } else {
    input.value = '';
    omniError('');
    if (added) input.blur();
  }
}

function addFiles(files) {
  let added = 0;
  for (const f of files) {
    if (!(f.type.startsWith('video/') || /\.(mp4|webm|mov|mkv|m4v|ogv)$/i.test(f.name))) continue;
    // 復元待ちの動画と名前が同じなら、そこに入れる
    const waiting = engine.tiles.find((t) => t.type === 'local' && !t.file && t.src === f.name);
    if (waiting) { attachFile(waiting, f); added++; continue; }
    if (addTile({ type: 'local', src: f.name, file: f })) added++;
  }
  if (!added) toast('動画ファイルが見つかりませんでした');
  return added;
}

// ============================================================
// 選択・音声
// ============================================================
function selectedTile() { return engine.tiles.find((t) => t.id === state.selectedId) || null; }

function select(tile) {
  state.selectedId = tile ? tile.id : null;
  for (const t of engine.tiles) {
    t.el.classList.toggle('sel', t.id === state.selectedId);
    t.row?.classList.toggle('sel', t.id === state.selectedId);
  }
  timeline.update();
}

function applyAudio(tile) {
  if (!tile.player?.ready) return;
  tile.player.setMuted(state.allMuted || tile.muted);
  tile.player.setVolume(state.volume);
}
function applyAudioAll() { engine.tiles.forEach(applyAudio); renderStructure(); }

function toggleTileMute(tile) {
  tile.muted = !tile.muted;
  if (!tile.muted) state.allMuted = false;
  applyAudioAll();
  save();
}
function soloAudio(index) {
  const tile = engine.tiles[index];
  if (!tile) return;
  engine.tiles.forEach((t, i) => { t.muted = i !== index; });
  state.allMuted = false;
  applyAudioAll();
  toast(`${index + 1}  ${tile.label} の音だけ`);
  save();
}

// ============================================================
// レイアウト
// ============================================================
function bestColumns(n) {
  // 16:9 の動画がいちばん大きく映る列数を選ぶ
  const r = stage.getBoundingClientRect();
  let best = 1;
  let bestArea = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const fitW = Math.min(r.width / cols, (r.height / rows) * 16 / 9);
    const area = fitW * fitW;
    if (area > bestArea + 1) { bestArea = area; best = cols; }
  }
  return best;
}

function applyLayout() {
  const tiles = engine.tiles;
  const n = tiles.length;
  const focus = state.layout === 'focus' && n > 1;
  grid.classList.toggle('focus', focus);
  tiles.forEach((t) => t.el.classList.remove('big'));
  // 動画の要素は並べ替えない（iframe を動かすと読み込み直しになるため）。配置は CSS grid で変える
  if (focus) {
    const big = tiles.find((t) => t.id === state.focusId) || tiles[0];
    state.focusId = big.id;
    big.el.classList.add('big');
    grid.style.gridTemplateColumns = '';
    grid.style.gridTemplateRows = `repeat(${n - 1}, 1fr)`;
  } else {
    const cols = state.layout === 'auto' || state.layout === 'focus'
      ? bestColumns(n)
      : Math.min(Number(state.layout), Math.max(n, 1));
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${Math.max(1, Math.ceil(n / cols))}, 1fr)`;
  }
  $$('#layout-seg button').forEach((b) => b.classList.toggle('on', b.dataset.layout === state.layout));
}

function setLayout(layout) {
  if (layout === 'focus' && state.layout !== 'focus') state.prevLayout = state.layout;
  state.layout = layout;
  applyLayout();
  save();
}
function toggleFocus(tile) {
  if (state.layout === 'focus' && state.focusId === tile.id) {
    setLayout(state.prevLayout === 'focus' ? 'auto' : state.prevLayout);
  } else {
    state.focusId = tile.id;
    setLayout('focus');
  }
}
function cycleLayout() {
  setLayout(LAYOUTS[(LAYOUTS.indexOf(state.layout) + 1) % LAYOUTS.length]);
}
new ResizeObserver(() => applyLayout()).observe(stage);

// ============================================================
// 再生操作
// ============================================================
function togglePlay() {
  if (!engine.playing && !engine.active().length) {
    toast(engine.tiles.length ? '読み込み中です' : 'まず動画を追加してください');
    return;
  }
  engine.toggle();
}
function seekBy(dt) { engine.seek(engine.master + dt); }

function setRate(r) {
  engine.setRate(r);
  $('#t-rate').value = String(r);
  const fixed = engine.tiles.filter((t) => t.player && !t.player.supportsRate);
  toast(`${r.toFixed(2)}×` + (fixed.length && r !== 1 ? `（${fixed.map((t) => t.label).join('、')} は速度を変えられないため、位置合わせで追いかけます）` : ''), 4000);
  save();
}
function stepRate(dir) {
  const i = RATES.indexOf(engine.rate);
  const next = RATES[clamp((i < 0 ? RATES.indexOf(1) : i) + dir, 0, RATES.length - 1)];
  if (next !== engine.rate) setRate(next);
}

engine.on('state', () => {
  if (engine.playing && $('#draw-autoclear').checked) draw.clear();
  $('#t-play use').setAttribute('href', engine.playing ? '#i-pause' : '#i-play');
  if (!engine.playing) save();
});

// ============================================================
// マーカー
// ============================================================
function addMarker() {
  if (!engine.tiles.length) { toast('まず動画を追加してください'); return; }
  const t = Math.round(engine.master * 100) / 100;
  if (state.markers.some((m) => Math.abs(m.t - t) < 0.3)) { toast('この位置にはもうマーカーがあります'); return; }
  state.markers.push({ id: Date.now() + Math.random(), t, note: '' });
  state.markers.sort((a, b) => a.t - b.t);
  renderMarkers();
  toast(`マーカー ${fmtTime(t, true)}`);
  save();
}
function jumpMarker(dir) {
  const m = dir < 0
    ? [...state.markers].reverse().find((x) => x.t < engine.master - 0.3)
    : state.markers.find((x) => x.t > engine.master + 0.05);
  if (m) engine.seek(m.t);
}

function renderMarkers() {
  const list = $('#marker-list');
  list.replaceChildren();
  for (const m of state.markers) {
    const li = document.createElement('li');
    li.className = 'marker-item';
    const time = document.createElement('button');
    time.className = 'marker-time';
    time.textContent = fmtTime(m.t, true);
    time.addEventListener('click', () => engine.seek(m.t));
    const note = document.createElement('input');
    note.type = 'text';
    note.className = 'marker-note';
    note.placeholder = 'メモ';
    note.value = m.note;
    note.addEventListener('input', () => { m.note = note.value; save(); timeline.update(); });
    const del = document.createElement('button');
    del.className = 'ib xs';
    del.setAttribute('aria-label', 'マーカーを削除');
    del.innerHTML = '<svg><use href="#i-x"/></svg>';
    del.addEventListener('click', () => {
      state.markers = state.markers.filter((x) => x !== m);
      renderMarkers();
      save();
    });
    li.append(time, note, del);
    list.appendChild(li);
  }
  $('#marker-count').textContent = state.markers.length;
  $('#marker-empty').hidden = state.markers.length > 0;
  timeline.update();
}

// ============================================================
// クリップ一覧（開始位置の調整）
// ============================================================
function setOffset(tile, v, { seek = true } = {}) {
  tile.offset = Math.round(v * 1000) / 1000;
  if (seek) {
    tile.rt.cooldownUntil = 0;
    if (tile.player?.ready && !tile.player.error) engine.syncTile(tile, performance.now());
    save();
  }
  const input = tile.row && $('.tc-input', tile.row);
  if (input && document.activeElement !== input) input.value = fmtTime(tile.offset, true);
  updateLive();
}

function nudgeSelected(seconds) {
  const tile = selectedTile();
  if (!tile) { toast('ずらす動画をクリックして選んでください'); return; }
  setOffset(tile, tile.offset + seconds);
}

function renderStructure() {
  const list = $('#clip-list');
  list.replaceChildren();
  engine.tiles.forEach((tile, i) => {
    const li = document.createElement('li');
    li.className = 'clip';
    li.style.setProperty('--c', tile.color);
    li.innerHTML = `
      <div class="clip-top">
        <span class="chip">${i + 1}</span>
        <input type="text" class="clip-name" aria-label="名前">
        <span class="clip-src">${SOURCE_NAMES[tile.type]}</span>
        <button class="ib xs" data-act="mute" aria-label="ミュート"></button>
        <button class="ib xs" data-act="remove" aria-label="外す"><svg><use href="#i-x"/></svg></button>
      </div>
      <div class="clip-off">
        <label>開始</label>
        <input type="text" class="tc-input" aria-label="開始位置" inputmode="decimal">
        <div class="nudges">
          <button data-d="-1">-1s</button><button data-f="-1">-1f</button><button data-f="1">+1f</button><button data-d="1">+1s</button>
        </div>
      </div>
      <div class="clip-status"></div>`;
    li.classList.toggle('sel', tile.id === state.selectedId);
    li.addEventListener('pointerdown', (e) => { if (!e.target.closest('button, input')) select(tile); });
    const name = $('.clip-name', li);
    name.value = tile.label;
    name.addEventListener('focus', () => select(tile));
    name.addEventListener('change', () => {
      tile.label = name.value.trim() || defaultLabel(tile);
      tile.autoLabel = false;
      renderStructure();
      save();
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    const mute = $('[data-act="mute"]', li);
    mute.innerHTML = `<svg><use href="#${tile.muted ? 'i-mute' : 'i-vol'}"/></svg>`;
    mute.addEventListener('click', () => toggleTileMute(tile));
    $('[data-act="remove"]', li).addEventListener('click', () => removeTile(tile));
    $$('.nudges button', li).forEach((b) => b.addEventListener('click', () => {
      select(tile);
      setOffset(tile, tile.offset + (b.dataset.d ? Number(b.dataset.d) : Number(b.dataset.f) / settings.fps));
    }));
    const off = $('.tc-input', li);
    off.value = fmtTime(tile.offset, true);
    off.addEventListener('focus', () => select(tile));
    off.addEventListener('change', () => {
      const v = parseClock(off.value);
      if (v == null) { toast('「1:23.5」や「-5」の形で入力してください'); off.value = fmtTime(tile.offset, true); return; }
      setOffset(tile, v);
      off.value = fmtTime(tile.offset, true);
    });
    off.addEventListener('keydown', (e) => { if (e.key === 'Enter') off.blur(); });
    tile.row = li;
    list.appendChild(li);

    $('.chip', tile.el).textContent = i + 1;
    $('.tile-name', tile.el).textContent = tile.label;
    tile.el.classList.toggle('sel', tile.id === state.selectedId);
    $('.tile-ctl [data-act="mute"]', tile.el).innerHTML =
      `<svg><use href="#${tile.muted || state.allMuted ? 'i-mute' : 'i-vol'}"/></svg>`;
  });
  $('#clip-count').textContent = engine.tiles.length;
  $('#clip-empty').hidden = engine.tiles.length > 0;
  $('#empty').hidden = engine.tiles.length > 0;
  const mb = $('#t-mute');
  mb.classList.toggle('muted', state.allMuted);
  $('use', mb).setAttribute('href', state.allMuted ? '#i-mute' : '#i-vol');
  applyLayout();
  timeline.build();
  updateLive();
}

// 0.1 秒ごとに変わる表示だけを更新する（入力欄は作り直さない）
function updateLive() {
  $('#tc-cur').textContent = fmtTC(engine.master);
  $('#tc-dur').textContent = fmtTC(engine.duration()).slice(0, 8);

  for (const tile of engine.tiles) {
    const p = tile.player;
    let status = '';
    let cls = '';
    let msg = null;
    if (tile.status === 'needfile') { status = 'ファイル未選択'; cls = 'warn'; }
    else if (!p) { status = '準備中'; }
    else if (p.error) { status = p.error; cls = 'err'; msg = { key: 'err', text: p.error, err: true }; }
    else if (!p.ready) { status = '読み込み中'; msg = { key: 'loading', text: '読み込み中' }; }
    else {
      const target = engine.master + tile.offset;
      if (tile.status === 'waiting') {
        status = `開始まで ${fmtTime(-target, true)}`;
        msg = { key: 'wait', text: `あと ${fmtTime(-target)} で始まります` };
      } else if (tile.status === 'ended') {
        status = '終了';
        msg = { key: 'end', text: '終了' };
      } else {
        status = `${fmtTime(p.getTime(), true)} / ${fmtTime(p.getDuration())}`;
        // YouTube は一度も再生していないと位置を動かせないため、その旨を出す
        if (p.cued && !engine.playing && Math.abs(p.getTime() - target) > 0.5) {
          msg = { key: 'cued', text: `再生すると ${fmtTime(target)} に合わせます` };
        }
      }
      if (!p.supportsRate && engine.rate !== 1) { status += '  速度変更不可'; cls = 'warn'; }
      $('.tile-meta .t', tile.el).textContent = fmtTime(p.getTime(), true);
    }
    if (tile.row) {
      const st = $('.clip-status', tile.row);
      if (st.textContent !== status) st.textContent = status;
      st.className = `clip-status ${cls}`;
    }
    const off = $('.tile-meta .off', tile.el);
    off.hidden = !tile.offset;
    off.textContent = `${tile.offset > 0 ? '+' : ''}${fmtTime(tile.offset, true)}`;

    if (tile.status !== 'needfile') {
      const key = msg ? msg.key + msg.text : null;
      if (tile._msgKey !== key) {
        tile._msgKey = key;
        tile.msgEl.hidden = !msg;
        if (msg) {
          tile.msgEl.className = `tile-msg ${msg.err ? 'err' : 'passive'}`;
          tile.msgEl.textContent = msg.text;
        }
      }
    }
  }
  timeline.update();
}
engine.on('tick', updateLive);

// ============================================================
// スクリーンショット
// ============================================================
// 映像を画像に描けるか調べる（配信元が許可していない動画は描くとエラーになる）
function capturableVideo(p) {
  const v = p?.video;
  if (!v || v.readyState < 2 || !v.videoWidth) return null;
  if (p.canCapture) return v;
  try {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const x = c.getContext('2d');
    x.drawImage(v, 0, 0, 1, 1);
    x.getImageData(0, 0, 1, 1);
    return v;
  } catch { return null; }
}

function takeScreenshot() {
  if (!engine.tiles.length) { toast('まず動画を追加してください'); return; }
  const r = stage.getBoundingClientRect();
  const scale = Math.max(1, window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = Math.round(r.width * scale);
  c.height = Math.round(r.height * scale);
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, r.width, r.height);
  let blocked = 0;
  engine.tiles.forEach((t, i) => {
    const tr = t.el.getBoundingClientRect();
    const x = tr.left - r.left;
    const y = tr.top - r.top;
    const w = tr.width;
    const h = tr.height;
    ctx.fillStyle = '#050505';
    ctx.fillRect(x, y, w, h);
    const v = capturableVideo(t.player);
    if (v) {
      const s = Math.min(w / v.videoWidth, h / v.videoHeight);
      const dw = v.videoWidth * s;
      const dh = v.videoHeight * s;
      ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      blocked++;
      ctx.fillStyle = '#111113';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#63636c';
      ctx.font = `12px ${CANVAS_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(`${SOURCE_NAMES[t.type]} の映像は画像に含められません`, x + w / 2, y + h / 2);
    }
    ctx.fillStyle = 'rgba(0,0,0,.62)';
    ctx.fillRect(x + 6, y + 6, Math.min(w - 12, 28 + ctx.measureText(t.label).width + 40), 20);
    ctx.fillStyle = t.color;
    ctx.fillRect(x + 8, y + 8, 16, 16);
    ctx.fillStyle = '#0b0b0c';
    ctx.font = `600 10px ${CANVAS_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), x + 16, y + 20);
    ctx.fillStyle = '#ececee';
    ctx.font = `11.5px ${CANVAS_FONT}`;
    ctx.textAlign = 'left';
    const time = t.player?.ready ? `  ${fmtTime(t.player.getTime(), true)}` : '';
    ctx.fillText(`${t.label}${time}`, x + 30, y + 20, w - 44);
  });
  draw.render(ctx, r.width, r.height);
  c.toBlob((b) => downloadBlob(b, `VOD_${stamp()}_${fmtTime(engine.master).replace(/:/g, '-')}.png`), 'image/png');
  toast(blocked ? '保存しました（埋め込み動画の映像部分は含まれません）' : '保存しました', 3500);
}

// ============================================================
// セッション・共有リンク
// ============================================================
function snapshot() {
  return {
    app: 'VOD', version: 1, savedAt: Date.now(),
    layout: state.layout,
    focusIndex: engine.tiles.findIndex((t) => t.id === state.focusId),
    rate: engine.rate, master: engine.master, volume: state.volume,
    tiles: engine.tiles.map((t) => ({
      type: t.type, src: t.type === 'local' ? (t.file?.name || t.src) : t.src,
      label: t.label, autoLabel: t.autoLabel, offset: t.offset, muted: t.muted,
    })),
    markers: state.markers.map(({ t, note }) => ({ t, note })),
    strokes: draw.strokes,
  };
}

function validSpec(s) {
  if (!s || typeof s.src !== 'string' || s.src.length > 2000) return false;
  switch (s.type) {
    case 'youtube': return /^[\w-]{11}$/.test(s.src);
    case 'twitch': return /^\d+$/.test(s.src);
    case 'vimeo': return /^\d+(\/[0-9a-f]+)?$/i.test(s.src);
    case 'niconico': return /^(sm|nm|so)\d+$/.test(s.src);
    case 'url': try { return new URL(s.src).protocol === 'https:'; } catch { return false; }
    case 'local': return true;
    default: return false;
  }
}

function restore(data) {
  if (!data || !Array.isArray(data.tiles)) { toast('読み込めない形式です'); return false; }
  if (engine.playing) engine.pause();
  clearTiles();
  state.markers = (Array.isArray(data.markers) ? data.markers : [])
    .filter((m) => Number.isFinite(m.t))
    .map((m) => ({ id: Math.random(), t: m.t, note: String(m.note || '').slice(0, 500) }));
  state.layout = LAYOUTS.includes(data.layout) ? data.layout : 'auto';
  if (Number.isFinite(data.volume)) state.volume = clamp(data.volume, 0, 1);
  $('#t-vol').value = state.volume;
  engine.rate = RATES.includes(data.rate) ? data.rate : 1;
  $('#t-rate').value = String(engine.rate);
  for (const spec of data.tiles.filter(validSpec).slice(0, MAX_TILES)) {
    addTile({
      type: spec.type, src: spec.src,
      label: typeof spec.label === 'string' ? spec.label.slice(0, 200) : '',
      autoLabel: spec.autoLabel, offset: Number(spec.offset) || 0,
      muted: spec.muted,
    });
  }
  const f = engine.tiles[data.focusIndex];
  state.focusId = f ? f.id : null;
  // 動画の長さがまだ分からないので、制限をかけずに位置だけ戻す
  engine.master = Math.max(0, Number(data.master) || 0);
  draw.load(Array.isArray(data.strokes) ? data.strokes : []);
  renderMarkers();
  renderStructure();
  const missing = engine.tiles.filter((t) => t.type === 'local' && !t.file).length;
  if (missing) toast(`手元のファイル ${missing} 本を選び直してください（画面にドロップしても入ります）`, 5000);
  return true;
}

const save = debounce(() => {
  if (engine.tiles.length) storageSet('vod.autosave', snapshot());
}, 600);
setInterval(() => { if (engine.playing) save(); }, 5000);
draw.onChange = save;

// 共有リンク：状態を URL の # 以降に入れる（サーバーには送られない）
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function shareLink() {
  const shared = engine.tiles.filter((t) => t.type !== 'local');
  const data = {
    v: 1,
    t: shared.map((t) => [t.type, t.src, Math.round(t.offset * 1000) / 1000, t.autoLabel ? '' : t.label]),
    m: state.markers.map((m) => [m.t, m.note]),
    l: state.layout,
    r: engine.rate,
    p: Math.round(engine.master * 100) / 100,
  };
  return { url: `${location.origin}${location.pathname}#s=${b64urlEncode(JSON.stringify(data))}`, skipped: engine.tiles.length - shared.length };
}

function loadShared(code) {
  try {
    const d = JSON.parse(b64urlDecode(code));
    if (!Array.isArray(d.t)) throw new Error('bad');
    return restore({
      tiles: d.t.map(([type, src, offset, label]) => ({
        type, src, offset, label: label || '', autoLabel: !label,
      })).map((s, i) => ({ ...s, muted: i > 0 })),
      markers: (d.m || []).map(([t, note]) => ({ t, note })),
      layout: d.l, rate: d.r, master: d.p,
    });
  } catch {
    toast('共有リンクを読み取れませんでした');
    return false;
  }
}

function checkHash() {
  const m = location.hash.match(/^#s=([\w-]+)$/);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + location.search);
  if (engine.tiles.length && !confirm('共有リンクの内容を開きますか？（今の画面は閉じます）')) return false;
  return loadShared(m[1]);
}
window.addEventListener('hashchange', checkHash);

function openShare() {
  if (!engine.tiles.length) { toast('共有する動画がありません'); return; }
  const { url, skipped } = shareLink();
  $('#share-url').value = url;
  const note = $('#share-note');
  note.hidden = !skipped;
  note.textContent = `手元のファイル ${skipped} 本はリンクに含まれません。`;
  $('#dlg-share').showModal();
  $('#share-url').select();
}

function sessions() { return storageGet('vod.sessions', []); }

function renderSessions() {
  const list = $('#session-list');
  list.replaceChildren();
  const all = sessions();
  if (!all.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = '保存したものはありません';
    list.appendChild(li);
    return;
  }
  for (const s of all) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 's-name';
    name.textContent = s.name;
    const meta = document.createElement('span');
    meta.className = 's-meta';
    const d = new Date(s.savedAt);
    meta.textContent = `${s.data.tiles.length}本  ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'btn';
    load.textContent = '開く';
    load.addEventListener('click', () => {
      if (engine.tiles.length && !confirm('今の画面を閉じて開きますか？')) return;
      if (restore(s.data)) { $('#dlg-session').close(); toast(`「${s.name}」を開きました`); }
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ib';
    del.setAttribute('aria-label', '削除');
    del.innerHTML = '<svg><use href="#i-trash"/></svg>';
    del.addEventListener('click', () => {
      if (!confirm(`「${s.name}」を削除しますか？（元に戻せません）`)) return;
      storageSet('vod.sessions', sessions().filter((x) => x.id !== s.id));
      renderSessions();
    });
    li.append(name, meta, load, del);
    list.appendChild(li);
  }
}

function saveSession() {
  if (!engine.tiles.length) { toast('保存する動画がありません'); return; }
  const input = $('#session-name');
  const d = new Date();
  const name = input.value.trim() || `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const all = sessions();
  const same = all.find((s) => s.name === name);
  if (same && !confirm(`「${name}」を上書きしますか？`)) return;
  const entry = { id: same ? same.id : Date.now(), name, savedAt: Date.now(), data: snapshot() };
  if (!storageSet('vod.sessions', [entry, ...all.filter((s) => s !== same)])) {
    toast('保存できませんでした（ブラウザの保存容量が足りない可能性）');
    return;
  }
  input.value = '';
  renderSessions();
  toast(`「${name}」を保存しました`);
}

// ============================================================
// 描画
// ============================================================
function setDrawMode(on) {
  draw.setEnabled(on);
  $('#drawbar').hidden = !on;
  $('#btn-draw').classList.toggle('on', on);
}

function initDrawBar() {
  const colors = $('#draw-colors');
  for (const c of DRAW_COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.setAttribute('aria-label', c);
    b.addEventListener('click', () => {
      draw.color = c;
      $$('.swatch').forEach((s) => s.classList.toggle('on', s === b));
    });
    colors.appendChild(b);
  }
  draw.color = DRAW_COLORS[0];
  colors.firstChild.classList.add('on');
  $$('#draw-tools button').forEach((b) => b.addEventListener('click', () => {
    draw.tool = b.dataset.tool;
    $$('#draw-tools button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('#draw-tools [data-tool="pen"]').classList.add('on');
  $('#draw-width').addEventListener('input', (e) => { draw.width = Number(e.target.value); });
  $('#draw-undo').addEventListener('click', () => draw.undo());
  $('#draw-clear').addEventListener('click', () => draw.clear());
  $('#draw-close').addEventListener('click', () => setDrawMode(false));
}

// ============================================================
// ダイアログ
// ============================================================
function initDialogs() {
  $('#share-copy').addEventListener('click', async () => {
    const url = $('#share-url').value;
    try {
      await navigator.clipboard.writeText(url);
      toast('コピーしました');
    } catch {
      $('#share-url').select();
      toast('Ctrl+C でコピーしてください');
    }
  });

  $('#session-save').addEventListener('click', saveSession);
  $('#session-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveSession(); } });
  $('#session-export').addEventListener('click', () => {
    if (!engine.tiles.length) { toast('書き出す動画がありません'); return; }
    downloadBlob(new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' }), `VOD_${stamp()}.json`);
  });
  $('#session-import-btn').addEventListener('click', () => $('#session-import').click());
  $('#session-import').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (engine.tiles.length && !confirm('今の画面を閉じて開きますか？')) return;
      if (restore(data)) { $('#dlg-session').close(); toast(`「${f.name}」を読み込みました`); }
    } catch {
      toast('このファイルは読み込めませんでした');
    }
  });

  const saveSettings = () => storageSet('vod.settings', settings);
  $('#set-skip').addEventListener('change', (e) => { settings.skip = clamp(Number(e.target.value) || 5, 0.5, 60); saveSettings(); });
  $('#set-skip-big').addEventListener('change', (e) => { settings.skipBig = clamp(Number(e.target.value) || 30, 1, 600); saveSettings(); });
  $('#set-fps').addEventListener('change', (e) => { settings.fps = Number(e.target.value) || 30; saveSettings(); });
  $('#keys-reset').addEventListener('click', () => {
    if (!confirm('キー割り当てを初期設定に戻しますか？')) return;
    shortcuts.reset();
    renderKeys();
  });
  $('#dlg-settings').addEventListener('cancel', (e) => { if (recording) e.preventDefault(); });
}

let recording = null;
function renderKeys() {
  const body = $('#keys-body');
  body.replaceChildren();
  for (const a of SHORTCUT_ACTIONS) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = a.label;
    const td2 = document.createElement('td');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'key-btn';
    b.textContent = comboLabel(shortcuts.map[a.id]);
    b.addEventListener('click', () => {
      $$('.key-btn').forEach((x) => x.classList.remove('rec'));
      recording = { id: a.id, btn: b };
      b.classList.add('rec');
      b.textContent = 'キーを押す';
    });
    td2.appendChild(b);
    tr.append(td1, td2);
    body.appendChild(tr);
  }
  renderHelpKeys();
}
function renderHelpKeys() {
  const box = $('#help-keys');
  box.replaceChildren();
  const rows = SHORTCUT_ACTIONS.map((a) => [a.label, comboLabel(shortcuts.map[a.id])]);
  rows.push(['その動画の音だけ出す', '1 – 9']);
  for (const [label, key] of rows) {
    const d = document.createElement('div');
    const l = document.createElement('span');
    l.textContent = label;
    const k = document.createElement('kbd');
    k.textContent = key;
    d.append(l, k);
    box.appendChild(d);
  }
}

function openSettings() {
  $('#set-skip').value = settings.skip;
  $('#set-skip-big').value = settings.skipBig;
  $('#set-fps').value = String(settings.fps);
  recording = null;
  renderKeys();
  $('#dlg-settings').showModal();
}
function openHelp() { renderHelpKeys(); $('#dlg-help').showModal(); }
function openSessions() { renderSessions(); $('#dlg-session').showModal(); }

// ============================================================
// キーボード
// ============================================================
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => toast('この端末では全画面にできません'));
}
function toggleInspector() {
  document.body.classList.toggle('insp-hidden');
  $('#btn-panel').classList.toggle('on', !document.body.classList.contains('insp-hidden'));
}

const ACTIONS = {
  toggle: togglePlay,
  back: () => seekBy(-settings.skip),
  fwd: () => seekBy(settings.skip),
  backBig: () => seekBy(-settings.skipBig),
  fwdBig: () => seekBy(settings.skipBig),
  frameBack: () => engine.step(-1 / settings.fps),
  frameFwd: () => engine.step(1 / settings.fps),
  start: () => engine.seek(0),
  nudgeBack: () => nudgeSelected(-1 / settings.fps),
  nudgeFwd: () => nudgeSelected(1 / settings.fps),
  nudgeBackBig: () => nudgeSelected(-1),
  nudgeFwdBig: () => nudgeSelected(1),
  slower: () => stepRate(-1),
  faster: () => stepRate(1),
  resetRate: () => setRate(1),
  muteAll: () => { state.allMuted = !state.allMuted; applyAudioAll(); toast(state.allMuted ? 'ミュート' : 'ミュート解除'); },
  marker: addMarker,
  prevMarker: () => jumpMarker(-1),
  nextMarker: () => jumpMarker(1),
  draw: () => setDrawMode(!draw.enabled),
  undoDraw: () => draw.undo(),
  clearDraw: () => draw.clear(),
  shot: takeScreenshot,
  layout: cycleLayout,
  side: toggleInspector,
  add: () => $('#omni-input').focus(),
  fullscreen: toggleFullscreen,
  help: openHelp,
};

document.addEventListener('keydown', (e) => {
  if (recording) {
    e.preventDefault();
    e.stopPropagation();
    const { id } = recording;
    if (e.key === 'Escape') {
      // 取り消し
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      shortcuts.set(id, '');
    } else {
      const combo = comboFromEvent(e);
      if (!combo) return;
      if (/^[1-9]$/.test(combo)) { toast('1〜9 は「その動画の音だけ出す」に使われています'); return; }
      shortcuts.set(id, combo);
    }
    recording = null;
    renderKeys();
    return;
  }
  const t = e.target;
  const typing = (t.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(t.type))
    || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
  if (typing) { if (e.key === 'Escape') t.blur(); return; }
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape' && draw.enabled) { setDrawMode(false); return; }
  if (!e.ctrlKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); soloAudio(Number(e.key) - 1); return; }
  const combo = comboFromEvent(e);
  const act = combo && shortcuts.actionFor(combo);
  if (act) { e.preventDefault(); ACTIONS[act](); }
}, true);

// URL をどこで貼り付けても追加できるようにする
document.addEventListener('paste', (e) => {
  const t = e.target;
  if ((t.tagName === 'INPUT' && t.id !== 'omni-input') || t.tagName === 'TEXTAREA') return;
  const text = e.clipboardData?.getData('text') || '';
  if (!text.trim()) return;
  if (t.id === 'omni-input') {
    // 全部読める URL なら、そのまま追加する。読めない行があれば欄に貼って理由を出す
    const lines = text.split(/[\r\n\s]+/).filter(Boolean);
    if (!lines.every((l) => { const r = parseSource(l); return r && !r.error; })) return;
    e.preventDefault();
    addFromText(text);
    t.value = '';
    omniError('');
    t.blur();
    return;
  }
  e.preventDefault();
  const { bad } = addFromText(text);
  if (bad.length) omniError(bad.map((b) => `${b.line}\n→ ${b.reason}`).join('\n\n'));
});

// iframe にフォーカスが移ってしまったら取り戻す（ショートカットが効かなくなるのを防ぐ）
window.addEventListener('blur', () => setTimeout(() => {
  if (document.activeElement?.tagName === 'IFRAME') { document.activeElement.blur(); window.focus(); }
}, 0));
// ボタンを押したあとフォーカスを残さない（スペースキーでボタンが二重に押されるのを防ぐ）
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && !b.closest('dialog')) b.blur();
});

// ============================================================
// ドラッグ＆ドロップ
// ============================================================
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].some((x) => x === 'Files' || x === 'text/uri-list' || x === 'text/plain')) return;
  dragDepth++;
  $('#drop-hint').hidden = false;
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-hint').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-hint').hidden = true;
  if (e.dataTransfer.files.length) { addFiles([...e.dataTransfer.files]); return; }
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (text) {
    const { bad } = addFromText(text.split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n'));
    if (bad.length) omniError(bad.map((b) => `${b.line}\n→ ${b.reason}`).join('\n\n'));
  }
});

// ============================================================
// 起動
// ============================================================
function init() {
  $('#omni').addEventListener('submit', (e) => { e.preventDefault(); submitOmni(); });
  $('#omni-input').addEventListener('input', () => omniError(''));
  $('#btn-file').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  $('#btn-draw').addEventListener('click', () => setDrawMode(!draw.enabled));
  $('#btn-shot').addEventListener('click', takeScreenshot);
  $('#btn-share').addEventListener('click', openShare);
  $('#btn-session').addEventListener('click', openSessions);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-help').addEventListener('click', openHelp);
  $('#btn-panel').addEventListener('click', toggleInspector);
  $$('#layout-seg button').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.layout)));

  $('#t-play').addEventListener('click', togglePlay);
  $('#t-start').addEventListener('click', () => engine.seek(0));
  $('#t-back').addEventListener('click', () => seekBy(-settings.skip));
  $('#t-fwd').addEventListener('click', () => seekBy(settings.skip));
  $('#t-fback').addEventListener('click', () => engine.step(-1 / settings.fps));
  $('#t-ffwd').addEventListener('click', () => engine.step(1 / settings.fps));
  $('#t-marker').addEventListener('click', addMarker);
  $('#t-full').addEventListener('click', toggleFullscreen);
  $('#t-mute').addEventListener('click', ACTIONS.muteAll);
  $('#t-rate').addEventListener('change', (e) => { setRate(Number(e.target.value)); e.target.blur(); });
  $('#t-vol').value = state.volume;
  $('#t-vol').addEventListener('input', (e) => {
    state.volume = Number(e.target.value);
    engine.tiles.forEach(applyAudio);
  });
  $('#t-vol').addEventListener('change', (e) => { e.target.blur(); save(); });

  $$('.insp-tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.insp-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.insp-body').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
  }));

  initDrawBar();
  initDialogs();
  if (MOBILE()) document.body.classList.add('insp-hidden');
  $('#btn-panel').classList.toggle('on', !document.body.classList.contains('insp-hidden'));
  renderMarkers();
  renderStructure();

  if (checkHash()) return;
  const auto = storageGet('vod.autosave', null);
  if (auto && Array.isArray(auto.tiles) && auto.tiles.length) {
    const b = $('#empty-restore');
    b.hidden = false;
    b.textContent = `前回の続きを開く（${auto.tiles.length}本）`;
    b.addEventListener('click', () => restore(auto));
  }
}
init();
