// 時刻の表示と読み取り

// 秒 → "1:02:03" / "2:03"（tenths=true なら "2:03.4"）
function fmtTime(sec, tenths = false) {
  const neg = sec < 0;
  let t = Math.abs(sec || 0);
  if (!tenths) t = Math.floor(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  return (neg ? '-' : '') + body;
}

// 秒 → "00:12:34.56"（メインの時刻表示用）
function fmtTC(sec) {
  const t = Math.max(0, sec || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t * 100) % 100);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(cs)}`;
}

// "1:23.5" / "-0:05" / "83.5" / "1:02:03" → 秒（読めなければ null）
function parseClock(text) {
  const s = String(text).trim().replace(/[：]/g, ':').replace(/[－ー−]/g, '-');
  const m = s.match(/^(-)?(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?(?::(\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  const parts = [m[2], m[3], m[4]].filter((x) => x != null).map(Number);
  let v = 0;
  for (const p of parts) v = v * 60 + p;
  return m[1] ? -v : v;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function debounce(fn, ms) {
  let id;
  return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); };
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function storageGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
