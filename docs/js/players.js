// Twitch の埋め込みプレーヤー
// ・過去の配信（VOD）: 共通タイムラインで同期させる
// ・ライブ: 同期はせず、そのまま並べて見る

const scriptCache = {};
function loadScript(src) {
  if (!scriptCache[src]) {
    scriptCache[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => { delete scriptCache[src]; reject(new Error('load failed: ' + src)); };
      document.head.appendChild(s);
    });
  }
  return scriptCache[src];
}
const loadTwitch = () => loadScript('https://player.twitch.tv/js/embed/v1.js');

const LOAD_TIMEOUT = 20000;

class BasePlayer {
  constructor(host) {
    this.host = host;
    this.ready = false;
    this.error = null;
    this.buffering = false;
    this.supportsRate = false; // Twitch の埋め込みプレーヤーには再生速度を変える API がない
    this.playing = false;
    this._handlers = {};
  }
  on(ev, fn) { (this._handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...args) { (this._handlers[ev] || []).forEach((fn) => fn(...args)); }
  markReady() { if (!this.ready && !this.error) { this.ready = true; this.emit('ready'); } }
  fail(msg) { if (!this.error) { this.error = msg; this.emit('error', msg); } }
  timeout(msg) { setTimeout(() => { if (!this.ready) this.fail(msg); }, LOAD_TIMEOUT); }

  mount(opts) {
    const el = document.createElement('div');
    el.id = 'tw-' + Math.random().toString(36).slice(2);
    el.className = 'fill';
    this.host.appendChild(el);
    loadTwitch().then(() => {
      // 最初は必ずミュートで作る。音を出すのは app.js の applyAudio だけ
      this.p = new Twitch.Player(el.id, {
        ...opts, parent: [location.hostname], muted: true, width: '100%', height: '100%',
      });
      const E = Twitch.Player;
      this.p.addEventListener(E.READY, () => this.markReady());
      this.p.addEventListener(E.PLAYING, () => { this.playing = true; this.buffering = false; this.emit('playing'); });
      this.p.addEventListener(E.PLAY, () => { this.playing = true; });
      this.p.addEventListener(E.PAUSE, () => { this.playing = false; });
      this.p.addEventListener(E.ENDED, () => { this.playing = false; });
      if (E.PLAYBACK_BLOCKED) this.p.addEventListener(E.PLAYBACK_BLOCKED, () => this.emit('blocked'));
      this.bind?.(E);
    }).catch(() => this.fail('Twitch を読み込めませんでした（ネット接続を確認してください）'));
  }

  play() { this.p?.play(); }
  pause() { this.p?.pause(); }
  seek(t) {
    this.p?.seek(t);
    // シーク直後は古い位置が返ってくるので、しばらくはシーク先から数える
    this._raw = t;
    this._rawAt = performance.now();
    this._ignoreUntil = this._rawAt + 1500;
  }
  // Twitch の getCurrentTime は約 1.5 秒ごとにしか更新されないため、
  // 最後に値が変わった時刻からの経過時間を足して、途切れない位置にする
  getTime() {
    if (!this.ready) return 0;
    const now = performance.now();
    const raw = this.p.getCurrentTime() || 0;
    if (now >= (this._ignoreUntil || 0) && raw !== this._raw) { this._raw = raw; this._rawAt = now; }
    const base = this._raw ?? raw;
    if (!this.playing || this.buffering) return base;
    return base + Math.min(2, (now - this._rawAt) / 1000);
  }
  getDuration() { return this.ready ? this.p.getDuration() || 0 : 0; }
  isPlaying() { return this.playing; }
  getMuted() { return this.ready ? this.p.getMuted() : true; }
  setRate() {}
  setMuted(m) { if (this.ready) this.p.setMuted(m); }
  setVolume(v) { if (this.ready) this.p.setVolume(v); }
  destroy() { this.host.innerHTML = ''; }
}

// 過去の配信
class TwitchVodPlayer extends BasePlayer {
  constructor(host, videoId) {
    super(host);
    this.kind = 'twitch';
    this.mount({ video: videoId, autoplay: false });
    // 存在しない・期限切れの VOD では READY が来ないため、時間で見切る
    this.timeout('過去の配信を読み込めませんでした（URL の間違い・削除済み・サブスク限定の可能性）');
  }
}

// ライブ
class TwitchLivePlayer extends BasePlayer {
  constructor(host, login) {
    super(host);
    this.kind = 'live';
    this.online = null; // null: まだ分からない / true / false
    this.mount({ channel: login, autoplay: true });
    this.timeout('チャンネルを読み込めませんでした（名前の間違いの可能性）');
  }
  bind(E) {
    // READY はオフラインでも来るため、配信中かどうかは ONLINE / OFFLINE で判断する
    this.p.addEventListener(E.ONLINE, () => { this.online = true; this.emit('online', true); });
    this.p.addEventListener(E.OFFLINE, () => { this.online = false; this.emit('online', false); });
  }
}

// ---------- 入力の読み取り ----------
const SOURCE_NAMES = { twitch: '過去配信', live: 'ライブ' };

const TWITCH_RESERVED = new Set([
  'directory', 'videos', 'search', 'settings', 'p', 'downloads', 'jobs', 'turbo', 'prime', 'store',
  'popout', 'embed', 'u', 'subscriptions', 'inventory', 'wallet', 'drops', 'friends', 'following',
  'messages', 'payments', 'login', 'signup', 'broadcast', 'dashboard', 'creatorcamp', 'team',
]);
const LOGIN_RE = /^[a-z0-9_]{4,25}$/;

// "1h2m3s" / "90" / "90s" / "1:30" を秒に変換する
function parseTimeParam(v) {
  if (!v) return 0;
  const hms = String(v).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/);
  if (hms && (hms[1] || hms[2] || hms[3])) return (+(hms[1] || 0)) * 3600 + (+(hms[2] || 0)) * 60 + (+(hms[3] || 0));
  const t = parseClock(v);
  return t == null ? 0 : Math.max(0, t);
}

const NOT_TWITCH = 'Twitch 専用です。Twitch のチャンネル名か、twitch.tv の URL を入れてください';

// チャンネル名 / twitch.tv の URL / 過去配信の URL を読み取る
function parseSource(input) {
  const s = input.trim().replace(/^@/, '');
  if (!s) return null;
  if (/^\d{6,}$/.test(s)) return { type: 'twitch', src: s, start: 0 };
  if (/^[A-Za-z0-9_]+$/.test(s)) {
    const login = s.toLowerCase();
    if (!LOGIN_RE.test(login)) return { error: 'Twitch のチャンネル名は 4〜25 文字の英数字と _ です' };
    return { type: 'live', src: login };
  }
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return { error: NOT_TWITCH }; }
  const host = u.hostname.replace(/^(www|m|go)\./, '');
  if (host === 'clips.twitch.tv') return { error: 'クリップは外から操作できないため、読み込めません' };
  if (host !== 'twitch.tv' && host !== 'player.twitch.tv') return { error: NOT_TWITCH };
  const q = (k) => u.searchParams.get(k);
  const parts = u.pathname.split('/').filter(Boolean).map((p) => p.toLowerCase());

  const vid = u.pathname.match(/\/videos\/(\d+)/)?.[1] || (q('video') || '').replace(/^v/, '');
  if (/^\d+$/.test(vid)) return { type: 'twitch', src: vid, start: parseTimeParam(q('t')) };
  if (parts.includes('clip')) return { error: 'クリップは外から操作できないため、読み込めません' };

  let login = host === 'player.twitch.tv' ? (q('channel') || '').toLowerCase() : parts[0];
  if (login === 'moderator' || login === 'popout') login = parts[1];
  if (!login || TWITCH_RESERVED.has(login)) return { error: 'チャンネルのページ（twitch.tv/名前）か、過去配信（/videos/…）の URL を入れてください' };
  if (!LOGIN_RE.test(login)) return { error: 'チャンネル名として読み取れません' };
  return { type: 'live', src: login };
}

function createPlayer(tile, host) {
  return tile.type === 'live' ? new TwitchLivePlayer(host, tile.src) : new TwitchVodPlayer(host, tile.src);
}
