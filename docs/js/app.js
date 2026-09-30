// VOD — 画面の組み立てと操作
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const VOD_COLORS = ['#7fb3ff', '#f59e7a', '#9fd78a', '#d6a2f0', '#6fd3cf', '#f58fb0'];
const MAX_TILES = 12;
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const LAYOUTS = ['auto', '1', '2', '3', '4', 'focus'];
const DRAW_COLORS = ['#f2d74e', '#ff5f57', '#5aa9ff', '#5fd08a', '#ffffff', '#111111'];
const MOBILE = () => window.matchMedia('(max-width: 760px)').matches;

const settings = Object.assign({ skip: 5, skipBig: 30, fps: 30 }, storageGet('vod.settings', {}));
const engine = new SyncEngine();
const shortcuts = new Shortcuts();
const roster = new Roster();
const stage = $('#stage');
const grid = $('#grid');
const draw = new DrawLayer($('#draw-layer'), stage);

const state = {
  layout: 'auto', prevLayout: 'auto', focusId: null, selectedId: null,
  markers: [], allMuted: false, volume: 0.8, nextId: 1,
  editing: null, // 左の一覧で「…」を開いているもの { kind: 'person' | 'group', key }
};

const timeline = new Timeline($('#timeline'), engine, {
  onOffset: (tile, v, final) => setOffset(tile, v, { seek: final }),
  onSelect: (tile) => select(tile),
  onMute: (tile) => toggleTileMute(tile),
  markers: () => state.markers,
  selectedId: () => state.selectedId,
  allMuted: () => state.allMuted,
});

const vodTiles = () => engine.tiles.filter((t) => t.type !== 'live');
const liveTile = (login) => engine.tiles.find((t) => t.type === 'live' && t.src === login) || null;

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
// タイル（ライブ・過去配信）の追加・削除
// ============================================================
function vodColor() {
  const used = new Set(engine.tiles.map((t) => t.color));
  return VOD_COLORS.find((c) => !used.has(c)) || VOD_COLORS[engine.tiles.length % VOD_COLORS.length];
}

function addTile(spec) {
  if (engine.tiles.length >= MAX_TILES) { toast(`同時に出せるのは ${MAX_TILES} 本までです`); return null; }
  const person = spec.type === 'live' ? roster.add(spec.src, spec.label) : null;
  const tile = {
    id: state.nextId++,
    type: spec.type,
    src: spec.src,
    label: person ? person.name : (spec.label || `過去配信 ${spec.src}`),
    autoLabel: !spec.label,
    offset: spec.type === 'live' ? 0 : Number(spec.offset) || 0,
    muted: spec.muted ?? engine.tiles.length > 0, // 最初の1本だけ音を出す
    color: person ? person.color : vodColor(),
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
  // 名前やボタンは映像の上に重ねず、上の細い帯に置く
  // （Twitch は映像の上に何か重なっていると自動再生しないことがあるため）
  el.innerHTML = `
    <div class="tile-bar">
      <span class="chip"></span><span class="tile-name"></span>
      <span class="tile-meta"><span class="t"></span><span class="off" hidden></span></span>
      <button class="ib" data-act="mute" aria-label="ミュート"><svg><use href="#i-vol"/></svg></button>
      <button class="ib" data-act="focus" aria-label="大きく表示"><svg><use href="#i-focus"/></svg></button>
      <button class="ib" data-act="remove" aria-label="外す"><svg><use href="#i-x"/></svg></button>
    </div>
    <div class="tile-media"></div>
    <div class="tile-msg passive" hidden></div>`;
  tile.el = el;
  tile.media = $('.tile-media', el);
  tile.msgEl = $('.tile-msg', el);

  const bar = $('.tile-bar', el);
  bar.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'mute') toggleTileMute(tile);
    else if (act === 'focus') toggleFocus(tile);
    else if (act === 'remove') removeTile(tile);
    else select(tile);
  });
  bar.addEventListener('dblclick', (e) => { if (!e.target.closest('[data-act]')) toggleFocus(tile); });
  grid.appendChild(el);
}

function startPlayer(tile) {
  tile.status = 'loading';
  tile.player = createPlayer(tile, tile.media);
  tile.player
    .on('ready', () => {
      applyAudio(tile);
      tile.rt.cooldownUntil = 0;
      if (tile.type !== 'live') engine.syncTile(tile, performance.now());
      updateLive();
    })
    .on('online', () => renderRoster())
    .on('error', () => { tile.status = 'error'; renderStructure(); })
    .on('blocked', () => {
      toast(`${tile.label}: ブラウザが再生を止めました。その枠内の再生ボタンを一度押してください`, 6000);
    });
}

function removeTile(tile) {
  tile.player?.destroy();
  tile.el.remove();
  engine.tiles = engine.tiles.filter((t) => t !== tile);
  if (state.focusId === tile.id) state.focusId = null;
  if (state.selectedId === tile.id) state.selectedId = engine.tiles[0]?.id ?? null;
  if (!vodTiles().length && engine.playing) engine.pause();
  renderStructure();
  save();
}

function clearTiles() {
  for (const t of engine.tiles) { t.player?.destroy(); t.el.remove(); }
  engine.tiles = [];
  state.focusId = null;
  state.selectedId = null;
}

// ============================================================
// メンバーのスイッチ
// ============================================================
function setLive(login, on) {
  const cur = liveTile(login);
  if (on && !cur) return !!addTile({ type: 'live', src: login });
  if (!on && cur) removeTile(cur);
  return true;
}

function groupMembers(g) { return g.members.filter((l) => roster.get(l)); }
function groupState(g) {
  const m = groupMembers(g);
  const n = m.filter((l) => liveTile(l)).length;
  if (!m.length || !n) return 'off';
  return n === m.length ? 'on' : 'some';
}
function toggleGroup(g) {
  const members = groupMembers(g);
  if (!members.length) { toast('このグループにはまだ誰もいません'); return; }
  if (groupState(g) === 'on') {
    members.forEach((l) => setLive(l, false));
    return;
  }
  const need = members.filter((l) => !liveTile(l));
  const room = MAX_TILES - engine.tiles.length;
  need.slice(0, room).forEach((l) => setLive(l, true));
  if (need.length > room) toast(`同時に出せるのは ${MAX_TILES} 本までのため、${need.length - room} 人は出せませんでした`, 4000);
}

function liveBadge(login) {
  const p = liveTile(login)?.player;
  if (!p || p.online == null) return '';
  return p.online ? '<span class="live-badge">LIVE</span>' : '<span class="off-badge">OFF</span>';
}

function renderRoster() {
  // グループ
  const gl = $('#group-list');
  gl.replaceChildren();
  for (const g of roster.groups) {
    const li = document.createElement('li');
    li.className = groupState(g);
    const editing = state.editing?.kind === 'group' && state.editing.key === g.id;
    li.classList.toggle('editing', editing);
    li.innerHTML = `
      <div class="roster-row">
        <button class="roster-main"><span class="sw"></span><span class="roster-name"></span><span class="roster-sub">${groupMembers(g).length}人</span></button>
        <button class="ib xs" aria-label="グループを編集"><svg><use href="#i-more"/></svg></button>
      </div>`;
    $('.roster-name', li).textContent = g.name;
    $('.roster-main', li).addEventListener('click', () => toggleGroup(g));
    $('.ib', li).addEventListener('click', () => { state.editing = editing ? null : { kind: 'group', key: g.id }; renderRoster(); });
    if (editing) li.appendChild(groupEditor(g));
    gl.appendChild(li);
  }
  $('#group-empty').hidden = roster.groups.length > 0;

  // 全員
  const pl = $('#people-list');
  pl.replaceChildren();
  for (const p of roster.people) {
    const li = document.createElement('li');
    li.className = liveTile(p.login) ? 'on' : 'off';
    li.style.setProperty('--c', p.color);
    const editing = state.editing?.kind === 'person' && state.editing.key === p.login;
    li.classList.toggle('editing', editing);
    li.innerHTML = `
      <div class="roster-row">
        <button class="roster-main"><span class="sw"></span><span class="person-dot"></span><span class="roster-name"></span>${liveBadge(p.login)}</button>
        <button class="ib xs" aria-label="メンバーを編集"><svg><use href="#i-more"/></svg></button>
      </div>`;
    $('.roster-name', li).textContent = p.name;
    $('.roster-main', li).title = p.name === p.login ? p.login : `${p.name}（${p.login}）`;
    $('.roster-main', li).addEventListener('click', () => setLive(p.login, !liveTile(p.login)));
    $('.ib', li).addEventListener('click', () => { state.editing = editing ? null : { kind: 'person', key: p.login }; renderRoster(); });
    if (editing) li.appendChild(personEditor(p));
    pl.appendChild(li);
  }
  $('#people-empty').hidden = roster.people.length > 0;
  $('#people-count').textContent = roster.people.length || '';
}

function personEditor(p) {
  const box = document.createElement('div');
  box.className = 'roster-edit';
  const name = document.createElement('input');
  name.type = 'text';
  name.value = p.name;
  name.maxLength = 60;
  name.setAttribute('aria-label', '表示名');
  name.addEventListener('change', () => {
    roster.rename(p.login, name.value);
    const t = liveTile(p.login);
    if (t) { t.label = roster.get(p.login).name; renderStructure(); save(); }
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
  box.appendChild(name);

  if (roster.groups.length) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const g of roster.groups) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = g.name;
      b.classList.toggle('on', g.members.includes(p.login));
      b.addEventListener('click', () => roster.toggleMember(g.id, p.login));
      chips.appendChild(b);
    }
    box.appendChild(chips);
  } else {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'グループを作ると、ここで出し入れできます';
    box.appendChild(hint);
  }

  const row = document.createElement('div');
  row.className = 'row';
  const link = document.createElement('a');
  link.href = `https://www.twitch.tv/${p.login}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = `twitch.tv/${p.login}`;
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'txt small danger';
  del.textContent = '登録を外す';
  del.addEventListener('click', () => {
    if (!confirm(`「${p.name}」の登録を外しますか？（グループからも外れます）`)) return;
    setLive(p.login, false);
    state.editing = null;
    roster.remove(p.login);
  });
  row.append(link, del);
  box.appendChild(row);
  return box;
}

function groupEditor(g) {
  const box = document.createElement('div');
  box.className = 'roster-edit';
  const name = document.createElement('input');
  name.type = 'text';
  name.value = g.name;
  name.maxLength = 60;
  name.setAttribute('aria-label', 'グループ名');
  name.addEventListener('change', () => roster.renameGroup(g.id, name.value));
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
  box.appendChild(name);

  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const p of roster.people) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.name;
    b.classList.toggle('on', g.members.includes(p.login));
    b.addEventListener('click', () => roster.toggleMember(g.id, p.login));
    chips.appendChild(b);
  }
  box.appendChild(chips);

  const row = document.createElement('div');
  row.className = 'row';
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = '押して出し入れ';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'txt small danger';
  del.textContent = 'グループを削除';
  del.addEventListener('click', () => {
    if (!confirm(`グループ「${g.name}」を削除しますか？（メンバーの登録は残ります）`)) return;
    state.editing = null;
    roster.removeGroup(g.id);
  });
  row.append(hint, del);
  box.appendChild(row);
  return box;
}

roster.onChange = renderRoster;

function saveGroupFromScreen(name) {
  const members = engine.tiles.filter((t) => t.type === 'live').map((t) => t.src);
  if (!members.length) { toast('ライブが表示されていません。先にメンバーのスイッチを入れてください'); return false; }
  const n = name.trim() || `グループ ${roster.groups.length + 1}`;
  roster.addGroup(n, members);
  toast(`「${n}」を保存しました（${members.length}人）`);
  return true;
}

function exportRoster() {
  if (!roster.people.length) { toast('登録しているメンバーがいません'); return; }
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  downloadBlob(new Blob([JSON.stringify(roster.toFile(), null, 2)], { type: 'application/json' }), `VOD_メンバー_${ymd}.json`);
}

async function importRoster(file) {
  try {
    const { addedPeople, addedGroups } = roster.merge(JSON.parse(await file.text()));
    toast(`メンバー ${addedPeople} 人、グループ ${addedGroups} 個を追加しました`);
  } catch {
    toast('メンバーのファイルとして読み込めませんでした');
  }
}

// ============================================================
// 入力欄
// ============================================================
// 複数行・複数語をまとめて追加する。読めなかったものは理由つきで返す
function addFromText(text) {
  const bad = [];
  let added = 0;
  for (const word of text.split(/[\r\n\s,、]+/)) {
    if (!word.trim()) continue;
    const r = parseSource(word);
    if (!r) continue;
    if (r.error) { bad.push({ line: word, reason: r.error }); continue; }
    if (r.type === 'live') {
      const cur = liveTile(r.src);
      if (cur) { select(cur); added++; continue; }
      if (setLive(r.src, true)) added++;
    } else if (addTile({ type: r.type, src: r.src, offset: r.start })) {
      added++;
    }
  }
  return { added, bad };
}

function showBad(bad) { omniError(bad.map((b) => `${b.line}\n→ ${b.reason}`).join('\n\n')); }

function submitOmni() {
  const input = $('#omni-input');
  if (!input.value.trim()) return;
  const { added, bad } = addFromText(input.value);
  if (bad.length) {
    input.value = bad.map((b) => b.line).join(' ');
    showBad(bad);
  } else {
    input.value = '';
    omniError('');
    if (added) input.blur();
  }
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
  // 16:9 の映像がいちばん大きく映る列数を選ぶ
  const r = stage.getBoundingClientRect();
  let best = 1;
  let bestArea = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const fitW = Math.min(r.width / cols, (r.height / rows - 26) * 16 / 9); // 26px は上の帯
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
  // タイルの要素は並べ替えない（iframe を動かすと読み込み直しになるため）。配置は CSS grid で変える
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
// 過去配信の再生操作
// ============================================================
function togglePlay() {
  if (!vodTiles().length) { if (engine.tiles.length) toast('再生操作は過去配信にだけ使えます（ライブは止まりません）'); return; }
  if (!engine.playing && !engine.active().length) { toast('読み込み中です'); return; }
  engine.toggle();
}
function seekBy(dt) { engine.seek(engine.master + dt); }

function setRate(r) {
  engine.setRate(r);
  $('#t-rate').value = String(r);
  toast(`${r.toFixed(2)}×` + (r !== 1 ? '（Twitch は速度を変えられないため、位置合わせで追いかけます）' : ''), 4000);
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
  if (!vodTiles().length) { toast('マーカーは過去配信に使えます'); return; }
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
// クリップ一覧（過去配信の開始位置の調整）
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
  if (!tile || tile.type === 'live') { toast('ずらす過去配信をクリックして選んでください'); return; }
  setOffset(tile, tile.offset + seconds);
}

function renderStructure() {
  engine.tiles.forEach((tile, i) => {
    tile.num = i + 1;
    $('.chip', tile.el).textContent = tile.num;
    $('.tile-name', tile.el).textContent = tile.label;
    tile.el.classList.toggle('sel', tile.id === state.selectedId);
    $('.tile-bar [data-act="mute"]', tile.el).innerHTML =
      `<svg><use href="#${tile.muted || state.allMuted ? 'i-mute' : 'i-vol'}"/></svg>`;
  });

  const list = $('#clip-list');
  list.replaceChildren();
  for (const tile of vodTiles()) {
    const li = document.createElement('li');
    li.className = 'clip';
    li.style.setProperty('--c', tile.color);
    li.innerHTML = `
      <div class="clip-top">
        <span class="chip">${tile.num}</span>
        <input type="text" class="clip-name" aria-label="名前">
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
      tile.label = name.value.trim() || `過去配信 ${tile.src}`;
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
  }
  const vods = vodTiles().length;
  $('#clip-count').textContent = vods;
  $('#clip-empty').hidden = vods > 0;
  document.body.classList.toggle('no-vod', !vods);
  $('#empty').hidden = engine.tiles.length > 0;
  const mb = $('#t-mute');
  mb.classList.toggle('muted', state.allMuted);
  $('use', mb).setAttribute('href', state.allMuted ? '#i-mute' : '#i-vol');
  applyLayout();
  timeline.build();
  renderRoster();
  updateLive();
}

// 0.1 秒ごとに変わる表示だけを更新する（入力欄は作り直さない）
function updateLive() {
  $('#tc-cur').textContent = fmtTC(engine.master);
  $('#tc-dur').textContent = fmtTC(engine.duration()).slice(0, 8);

  for (const tile of engine.tiles) {
    const p = tile.player;
    const meta = $('.tile-meta .t', tile.el);
    let status = '';
    let cls = '';
    let msg = null;
    if (!p) { status = '準備中'; }
    else if (p.error) { status = p.error; cls = 'err'; msg = { key: 'err', text: p.error, err: true }; }
    else if (!p.ready) { status = '読み込み中'; msg = { key: 'loading', text: '読み込み中' }; }
    else if (tile.type === 'live') {
      // オフラインのときは Twitch 自身がオフライン画面を出すので、こちらでは重ねない
      const label = p.online === true ? 'LIVE' : p.online === false ? 'OFFLINE' : '';
      if (meta.textContent !== label) {
        meta.textContent = label;
        meta.className = `t ${p.online ? 'live' : 'offline'}`;
      }
      meta.hidden = !label;
    } else {
      const target = engine.master + tile.offset;
      if (tile.status === 'waiting') {
        status = `開始まで ${fmtTime(-target, true)}`;
        msg = { key: 'wait', text: `あと ${fmtTime(-target)} で始まります` };
      } else if (tile.status === 'ended') {
        status = '終了';
        msg = { key: 'end', text: '終了' };
      } else {
        status = `${fmtTime(p.getTime(), true)} / ${fmtTime(p.getDuration())}`;
      }
      if (engine.rate !== 1) { status += '  速度変更不可'; cls = 'warn'; }
      meta.textContent = fmtTime(p.getTime(), true);
    }
    if (tile.row) {
      const st = $('.clip-status', tile.row);
      if (st.textContent !== status) st.textContent = status;
      st.className = `clip-status ${cls}`;
    }
    const off = $('.tile-meta .off', tile.el);
    off.hidden = !tile.offset;
    off.textContent = `${tile.offset > 0 ? '+' : ''}${fmtTime(tile.offset, true)}`;

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
  timeline.update();
}
engine.on('tick', updateLive);

// ============================================================
// セッション・共有リンク
// ============================================================
function snapshot() {
  return {
    app: 'VOD', version: 2, savedAt: Date.now(),
    layout: state.layout,
    focusIndex: engine.tiles.findIndex((t) => t.id === state.focusId),
    rate: engine.rate, master: engine.master, volume: state.volume,
    tiles: engine.tiles.map((t) => ({
      type: t.type, src: t.src, label: t.type === 'live' ? '' : t.label,
      autoLabel: t.autoLabel, offset: t.offset, muted: t.muted,
    })),
    markers: state.markers.map(({ t, note }) => ({ t, note })),
    strokes: draw.strokes,
  };
}

function validSpec(s) {
  if (!s || typeof s.src !== 'string') return false;
  if (s.type === 'live') return LOGIN_RE.test(s.src);
  if (s.type === 'twitch') return /^\d+$/.test(s.src);
  return false;
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
  const ok = data.tiles.filter(validSpec).slice(0, MAX_TILES);
  for (const spec of ok) {
    addTile({
      type: spec.type, src: spec.src,
      label: typeof spec.label === 'string' ? spec.label.slice(0, 200) : '',
      offset: Number(spec.offset) || 0, muted: spec.muted,
    });
  }
  const f = engine.tiles[data.focusIndex];
  state.focusId = f ? f.id : null;
  // 動画の長さがまだ分からないので、制限をかけずに位置だけ戻す
  engine.master = Math.max(0, Number(data.master) || 0);
  draw.load(Array.isArray(data.strokes) ? data.strokes : []);
  updateDrawVisibility();
  renderMarkers();
  renderStructure();
  const dropped = data.tiles.length - ok.length;
  if (dropped > 0) toast(`Twitch 以外の ${dropped} 本は読み込めません（このサイトは Twitch 専用になりました）`, 5000);
  return true;
}

const save = debounce(() => {
  if (engine.tiles.length) storageSet('vod.autosave', snapshot());
}, 600);
setInterval(() => { if (engine.playing) save(); }, 5000);

// 描画用の透明な板は、描画中か線が残っているときだけ映像の上に出す
function updateDrawVisibility() {
  $('#draw-layer').classList.toggle('show', draw.enabled || draw.strokes.length > 0);
  draw.resize();
}
draw.onChange = () => { updateDrawVisibility(); save(); };

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
  const data = {
    v: 2,
    t: engine.tiles.map((t) => [t.type, t.src, Math.round(t.offset * 1000) / 1000, t.type === 'live' || t.autoLabel ? '' : t.label]),
    m: state.markers.map((m) => [m.t, m.note]),
    l: state.layout,
    r: engine.rate,
    p: Math.round(engine.master * 100) / 100,
  };
  return `${location.origin}${location.pathname}#s=${b64urlEncode(JSON.stringify(data))}`;
}

function loadShared(code) {
  try {
    const d = JSON.parse(b64urlDecode(code));
    if (!Array.isArray(d.t)) throw new Error('bad');
    return restore({
      tiles: d.t.map(([type, src, offset, label], i) => ({ type, src, offset, label: label || '', muted: i > 0 })),
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
  if (!engine.tiles.length) { toast('共有するものがありません'); return; }
  $('#share-url').value = shareLink();
  $('#share-note').hidden = true;
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
  if (!engine.tiles.length) { toast('保存するものがありません'); return; }
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
  updateDrawVisibility();
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
    if (!engine.tiles.length) { toast('書き出すものがありません'); return; }
    downloadBlob(new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' }), `VOD_${stamp()}.json`);
  });
  $('#session-import-btn').addEventListener('click', () => $('#session-import').click());
  $('#session-import').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data?.kind === 'roster') { await importRoster(f); $('#dlg-session').close(); return; }
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
  rows.push(['その番号の枠の音だけ出す', '1 – 9']);
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
// パネルの出し入れ・キーボード
// ============================================================
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => toast('この端末では全画面にできません'));
}
function syncPanelButtons() {
  $('#btn-panel').classList.toggle('on', !document.body.classList.contains('insp-hidden'));
  $('#btn-rail').classList.toggle('on', !document.body.classList.contains('rail-hidden'));
}
function toggleInspector() {
  document.body.classList.toggle('insp-hidden');
  // スマホでは下から出るシートなので、2つ同時には出さない
  if (MOBILE() && !document.body.classList.contains('insp-hidden')) document.body.classList.add('rail-hidden');
  syncPanelButtons();
}
function toggleRail() {
  document.body.classList.toggle('rail-hidden');
  if (MOBILE() && !document.body.classList.contains('rail-hidden')) document.body.classList.add('insp-hidden');
  syncPanelButtons();
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
  layout: cycleLayout,
  rail: toggleRail,
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
      if (/^[1-9]$/.test(combo)) { toast('1〜9 は「その番号の枠の音だけ出す」に使われています'); return; }
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

// チャンネル名や URL をどこで貼り付けても追加できるようにする
document.addEventListener('paste', (e) => {
  const t = e.target;
  if ((t.tagName === 'INPUT' && t.id !== 'omni-input') || t.tagName === 'TEXTAREA') return;
  const text = e.clipboardData?.getData('text') || '';
  if (!text.trim()) return;
  if (t.id === 'omni-input') {
    // URL として全部読めるときだけ、そのまま追加する（チャンネル名の手入力の途中は邪魔しない）
    const words = text.split(/[\r\n\s]+/).filter(Boolean);
    if (!words.every((w) => /[/.]/.test(w) && !parseSource(w)?.error)) return;
    e.preventDefault();
    addFromText(text);
    t.value = '';
    omniError('');
    t.blur();
    return;
  }
  e.preventDefault();
  const { bad } = addFromText(text);
  if (bad.length) showBad(bad);
});

// iframe にフォーカスが移ってしまったら取り戻す（ショートカットが効かなくなるのを防ぐ）
window.addEventListener('blur', () => setTimeout(() => {
  if (document.activeElement?.tagName === 'IFRAME') { document.activeElement.blur(); window.focus(); }
}, 0));
// ボタンを押したあとフォーカスを残さない（スペースキーでボタンが二重に押されるのを防ぐ）
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && !b.closest('dialog, .roster-edit, #group-form')) b.blur();
});

// ============================================================
// ドラッグ＆ドロップ（URL の文字列だけ受け付ける）
// ============================================================
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].some((x) => x === 'text/uri-list' || x === 'text/plain')) return;
  dragDepth++;
  $('#drop-hint').hidden = false;
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-hint').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-hint').hidden = true;
  if (e.dataTransfer.files.length) { toast('ファイルには対応していません（Twitch 専用です）'); return; }
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (text) {
    const { bad } = addFromText(text.split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n'));
    if (bad.length) showBad(bad);
  }
});

// ============================================================
// 起動
// ============================================================
function init() {
  $('#omni').addEventListener('submit', (e) => { e.preventDefault(); submitOmni(); });
  $('#omni-input').addEventListener('input', () => omniError(''));
  $('#btn-rail').addEventListener('click', toggleRail);
  $('#btn-draw').addEventListener('click', () => setDrawMode(!draw.enabled));
  $('#btn-share').addEventListener('click', openShare);
  $('#btn-session').addEventListener('click', openSessions);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-help').addEventListener('click', openHelp);
  $('#btn-panel').addEventListener('click', toggleInspector);
  $$('#layout-seg button').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.layout)));

  $('#roster-export').addEventListener('click', exportRoster);
  $('#roster-import-btn').addEventListener('click', () => $('#roster-import').click());
  $('#roster-import').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await importRoster(f);
  });
  $('#group-new').addEventListener('click', () => {
    const form = $('#group-form');
    form.hidden = !form.hidden;
    if (!form.hidden) $('#group-name').focus();
  });
  $('#group-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (saveGroupFromScreen($('#group-name').value)) {
      $('#group-name').value = '';
      $('#group-form').hidden = true;
    }
  });

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
  if (MOBILE()) document.body.classList.add('insp-hidden', 'rail-hidden');
  // 画面幅がスマホ幅をまたいだら、パネルの出し方を切り替える
  window.matchMedia('(max-width: 760px)').addEventListener('change', (e) => {
    if (e.matches) document.body.classList.add('insp-hidden', 'rail-hidden');
    else document.body.classList.remove('insp-hidden', 'rail-hidden');
    syncPanelButtons();
  });
  syncPanelButtons();
  renderMarkers();
  renderStructure();

  if (checkHash()) return;
  const auto = storageGet('vod.autosave', null);
  const usable = auto && Array.isArray(auto.tiles) ? auto.tiles.filter(validSpec).length : 0;
  if (usable) {
    const b = $('#empty-restore');
    b.hidden = false;
    b.textContent = `前回の続きを開く（${usable}本）`;
    b.addEventListener('click', () => restore(auto));
  }
}
init();
