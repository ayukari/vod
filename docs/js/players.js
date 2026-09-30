// 動画プレイヤーの共通インターフェース
// どのサイトの動画も、同じメソッド（play・pause・seek・getTime…）で扱えるようにする。
// 同期には「外から再生・停止・シーク・現在位置の取得ができる」プレーヤーが必要なので、
// その仕組みを持つサイトだけに対応している。

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

let ytApi;
function loadYouTubeAPI() {
  if (!ytApi) {
    ytApi = new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) return resolve();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
      loadScript('https://www.youtube.com/iframe_api').catch((e) => { ytApi = null; reject(e); });
    });
  }
  return ytApi;
}

const LOAD_TIMEOUT = 20000;

class BasePlayer {
  constructor(host) {
    this.host = host;
    this.ready = false;
    this.error = null;
    this.buffering = false;
    this.supportsRate = true;
    this.canCapture = false;
    this._handlers = {};
  }
  on(ev, fn) { (this._handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...args) { (this._handlers[ev] || []).forEach((fn) => fn(...args)); }
  markReady() { if (!this.ready && !this.error) { this.ready = true; this.emit('ready'); } }
  fail(msg) { if (!this.error) { this.error = msg; this.emit('error', msg); } }
  timeout(msg) { setTimeout(() => { if (!this.ready) this.fail(msg); }, LOAD_TIMEOUT); }
}

// 現在位置を「最後に受け取った時刻 + 経過時間」で推定する（非同期 API のプレーヤー用）
class ClockMixin {
  static setup(p) { p.t = 0; p.tAt = performance.now(); p.rate = 1; p.playing = false; }
  static now(p) { return p.playing ? p.t + ((performance.now() - p.tAt) / 1000) * p.rate : p.t; }
  static mark(p, t) { p.t = t; p.tAt = performance.now(); }
}

// ---------- YouTube ----------
const YT_ERRORS = {
  2: '動画 ID が正しくありません',
  5: 'この動画は埋め込みプレーヤーで再生できません',
  100: '動画が見つかりません（削除・非公開の可能性）',
  101: '投稿者が埋め込み再生を許可していません',
  150: '投稿者が埋め込み再生を許可していません',
  153: '埋め込み再生の認証に失敗しました',
};

class YouTubePlayer extends BasePlayer {
  constructor(host, videoId) {
    super(host);
    this.kind = 'youtube';
    this.state = -1;
    const el = document.createElement('div');
    host.appendChild(el);
    loadYouTubeAPI().then(() => {
      this.p = new YT.Player(el, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          controls: 0, disablekb: 1, rel: 0, playsinline: 1, fs: 0,
          iv_load_policy: 3, origin: location.origin,
        },
        events: {
          onReady: () => {
            const d = this.p.getVideoData && this.p.getVideoData();
            if (d && d.title) this.emit('title', d.title);
            this.markReady();
          },
          onStateChange: (e) => {
            this.state = e.data;
            this.buffering = e.data === YT.PlayerState.BUFFERING;
          },
          onError: (e) => this.fail(YT_ERRORS[e.data] || `YouTube の再生エラー（コード ${e.data}）`),
        },
      });
    }).catch(() => this.fail('YouTube を読み込めませんでした（ネット接続を確認してください）'));
    this.timeout('YouTube の動画を読み込めませんでした');
  }
  // 未再生（-1）や頭出し済み（5）の状態で seekTo すると勝手に再生が始まるため、同期側で避ける
  get cued() { return this.state === -1 || this.state === 5; }
  play() { this.p?.playVideo?.(); }
  pause() { this.p?.pauseVideo?.(); }
  seek(t) { this.p?.seekTo?.(t, true); }
  getTime() { return this.ready ? this.p.getCurrentTime() || 0 : 0; }
  getDuration() { return this.ready ? this.p.getDuration() || 0 : 0; }
  isPlaying() { return this.state === 1 || this.state === 3; }
  setRate(r) { this.p?.setPlaybackRate?.(r); }
  setMuted(m) { if (this.ready) (m ? this.p.mute() : this.p.unMute()); }
  setVolume(v) { if (this.ready) this.p.setVolume(Math.round(v * 100)); }
  destroy() { try { this.p?.destroy(); } catch { /* 破棄時のエラーは無視 */ } this.host.innerHTML = ''; }
}

// ---------- Twitch（過去の配信 VOD） ----------
class TwitchPlayer extends BasePlayer {
  constructor(host, videoId) {
    super(host);
    this.kind = 'twitch';
    this.supportsRate = false; // Twitch の埋め込みプレーヤーには再生速度を変える API がない
    this.playing = false;
    const el = document.createElement('div');
    el.id = 'tw-' + Math.random().toString(36).slice(2);
    el.className = 'fill';
    host.appendChild(el);
    loadScript('https://player.twitch.tv/js/embed/v1.js').then(() => {
      this.p = new Twitch.Player(el.id, {
        video: videoId, parent: [location.hostname], autoplay: false, muted: true,
        width: '100%', height: '100%',
      });
      const E = Twitch.Player;
      this.p.addEventListener(E.READY, () => this.markReady());
      this.p.addEventListener(E.PLAYING, () => { this.playing = true; this.buffering = false; });
      this.p.addEventListener(E.PLAY, () => { this.playing = true; });
      this.p.addEventListener(E.PAUSE, () => { this.playing = false; });
      this.p.addEventListener(E.ENDED, () => { this.playing = false; });
      if (E.PLAYBACK_BLOCKED) this.p.addEventListener(E.PLAYBACK_BLOCKED, () => this.emit('blocked'));
    }).catch(() => this.fail('Twitch を読み込めませんでした（ネット接続を確認してください）'));
    // 存在しない・期限切れの VOD では READY が来ないため、時間で見切る
    this.timeout('Twitch の動画を読み込めませんでした（URL の間違い・削除済み・サブスク限定の可能性）');
  }
  play() { this.p?.play(); }
  pause() { this.p?.pause(); }
  seek(t) { this.p?.seek(t); }
  getTime() { return this.ready ? this.p.getCurrentTime() || 0 : 0; }
  getDuration() { return this.ready ? this.p.getDuration() || 0 : 0; }
  isPlaying() { return this.playing; }
  setRate() {}
  setMuted(m) { if (this.ready) this.p.setMuted(m); }
  setVolume(v) { if (this.ready) this.p.setVolume(v); }
  destroy() { this.host.innerHTML = ''; }
}

// ---------- Vimeo ----------
class VimeoPlayer extends BasePlayer {
  constructor(host, src) {
    super(host);
    this.kind = 'vimeo';
    ClockMixin.setup(this);
    this.dur = 0;
    const [id, hash] = src.split('/');
    const el = document.createElement('div');
    el.className = 'fill';
    host.appendChild(el);
    loadScript('https://player.vimeo.com/api/player.js').then(() => {
      const opts = {
        // 1つの再生で他の Vimeo プレーヤーが止まらないように autopause を切る
        autopause: false, playsinline: true, dnt: true, title: false, byline: false, portrait: false,
        controls: false, keyboard: false, width: 640,
      };
      if (hash) opts.url = `https://vimeo.com/${id}/${hash}`;
      else opts.id = Number(id);
      const p = new Vimeo.Player(el, opts);
      this.p = p;
      p.on('timeupdate', (d) => { ClockMixin.mark(this, d.seconds); if (d.duration) this.dur = d.duration; });
      p.on('play', () => { ClockMixin.mark(this, ClockMixin.now(this)); this.playing = true; });
      p.on('playing', () => { this.buffering = false; });
      p.on('pause', (d) => { this.playing = false; ClockMixin.mark(this, d?.seconds ?? this.t); });
      p.on('ended', () => { this.playing = false; });
      p.on('seeked', (d) => ClockMixin.mark(this, d.seconds));
      p.on('bufferstart', () => { this.buffering = true; });
      p.on('bufferend', () => { this.buffering = false; });
      p.on('playbackratechange', (d) => { this.rate = d.playbackRate; });
      p.ready()
        .then(() => Promise.all([p.getDuration(), p.getVideoTitle().catch(() => '')]))
        .then(([dur, title]) => {
          this.dur = dur;
          if (title) this.emit('title', title);
          this.markReady();
        })
        .catch(() => this.fail('Vimeo の動画を読み込めませんでした（非公開・埋め込み禁止の可能性）'));
    }).catch(() => this.fail('Vimeo を読み込めませんでした（ネット接続を確認してください）'));
    this.timeout('Vimeo の動画を読み込めませんでした');
  }
  play() { this.p?.play().catch(() => this.emit('blocked')); }
  pause() { this.p?.pause().catch(() => {}); }
  seek(t) { ClockMixin.mark(this, t); this.p?.setCurrentTime(t).catch(() => {}); }
  getTime() { return ClockMixin.now(this); }
  getDuration() { return this.dur || 0; }
  isPlaying() { return this.playing; }
  setRate(r) {
    if (!this.supportsRate || !this.p) return;
    // 速度変更は投稿者の設定によっては使えない。失敗したら「非対応」として扱う
    this.p.setPlaybackRate(r).then(() => { this.rate = r; }).catch(() => { this.supportsRate = false; });
  }
  // Vimeo は音量を変えるとミュートが外れるため、ミュート中は音量 0 にもしておく
  setMuted(m) { this.muted = m; this.applyAudio(); }
  setVolume(v) { this.volume = v; this.applyAudio(); }
  applyAudio() {
    if (!this.p) return;
    this.p.setVolume(this.muted ? 0 : (this.volume ?? 1)).catch(() => {});
    this.p.setMuted(!!this.muted).catch(() => {});
  }
  destroy() { try { this.p?.destroy(); } catch { /* 無視 */ } this.host.innerHTML = ''; }
}

// ---------- ニコニコ動画（埋め込みプレーヤーの postMessage API。公式ドキュメントがないため試験対応） ----------
const NICO_ORIGIN = 'https://embed.nicovideo.jp';

class NicoPlayer extends BasePlayer {
  constructor(host, videoId) {
    super(host);
    this.kind = 'niconico';
    this.supportsRate = false;
    ClockMixin.setup(this);
    this.dur = 0;
    this.playerId = 'vod' + Math.random().toString(36).slice(2, 10);
    const f = document.createElement('iframe');
    f.className = 'fill';
    f.allow = 'autoplay; fullscreen';
    f.src = `${NICO_ORIGIN}/watch/${videoId}?jsapi=1&playerId=${this.playerId}`;
    host.appendChild(f);
    this.frame = f;
    this.onMessage = (e) => {
      if (e.origin !== NICO_ORIGIN || !e.data || e.data.playerId !== this.playerId) return;
      const { eventName, data } = e.data;
      if (eventName === 'loadComplete') {
        const info = data?.videoInfo || {};
        this.dur = Number(info.lengthInSeconds) || this.dur;
        if (info.title) this.emit('title', info.title);
        this.markReady();
      } else if (eventName === 'playerMetadataChange') {
        if (Number.isFinite(data?.currentTime)) ClockMixin.mark(this, data.currentTime / 1000);
      } else if (eventName === 'playerStatusChange' || eventName === 'statusChange') {
        // 2: 再生中 / 3: 一時停止 / 4: 終了
        const was = this.playing;
        this.playing = data?.playerStatus === 2;
        if (was !== this.playing) ClockMixin.mark(this, this.t);
        if (this.playing && !was && this.muted !== undefined) this.applyAudio();
        this.buffering = data?.seekStatus === 1;
      } else if (eventName === 'error') {
        this.fail('ニコニコ動画の再生でエラーが出ました（削除・非公開・ログイン必須の可能性）');
      }
    };
    window.addEventListener('message', this.onMessage);
    this.timeout('ニコニコ動画を読み込めませんでした（削除・非公開・ログイン必須の可能性）');
  }
  post(eventName, data) {
    this.frame.contentWindow?.postMessage(
      { eventName, data, playerId: this.playerId, sourceConnectorType: 1 }, NICO_ORIGIN);
  }
  play() { this.post('play'); }
  pause() { this.post('pause'); }
  seek(t) { ClockMixin.mark(this, t); this.post('seek', { time: Math.round(t * 1000) }); }
  getTime() { return ClockMixin.now(this); }
  getDuration() { return this.dur; }
  isPlaying() { return this.playing; }
  setRate() {}
  // ミュートの命令は効かないことがあるため、音量 0 で消音する
  setMuted(m) { this.muted = m; this.applyAudio(); }
  setVolume(v) { this.volume = v; this.applyAudio(); }
  applyAudio() {
    this.post('volumeChange', { volume: this.muted ? 0 : (this.volume ?? 1) });
    this.post('mute', { mute: !!this.muted });
  }
  destroy() { window.removeEventListener('message', this.onMessage); this.host.innerHTML = ''; }
}

// ---------- 動画ファイル（手元のファイル / mp4・webm の直リンク / HLS の m3u8） ----------
class MediaPlayer extends BasePlayer {
  constructor(host, { file, url }) {
    super(host);
    this.kind = file ? 'local' : 'url';
    this.canCapture = !!file; // 直リンクは配信元の設定次第なので、スクショ時に確かめる
    this.fineRate = true;     // 小さなズレは速度の微調整で吸収できる
    const v = document.createElement('video');
    v.className = 'fill';
    v.preload = 'auto';
    v.playsInline = true;
    v.muted = true;
    v.addEventListener('loadedmetadata', () => this.markReady());
    v.addEventListener('waiting', () => { this.buffering = true; });
    ['playing', 'canplay', 'seeked', 'pause'].forEach((ev) =>
      v.addEventListener(ev, () => { this.buffering = false; }));
    v.addEventListener('error', () => this.fail(file
      ? 'このファイル形式はブラウザで再生できません（MP4 / WebM がおすすめ）'
      : '動画を読み込めませんでした（URL の間違い、または配信元が外部からの再生を許可していない可能性）'));
    host.appendChild(v);
    this.video = v;
    if (file) {
      this.objectUrl = URL.createObjectURL(file);
      v.src = this.objectUrl;
    } else if (/\.m3u8(\?|#|$)/i.test(url) && !v.canPlayType('application/vnd.apple.mpegurl')) {
      loadScript('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js').then(() => {
        if (!window.Hls || !Hls.isSupported()) return this.fail('このブラウザは HLS（m3u8）の再生に対応していません');
        this.hls = new Hls();
        this.hls.on(Hls.Events.ERROR, (_, d) => {
          if (d.fatal) this.fail('m3u8 を読み込めませんでした（配信元がブラウザからの読み込みを許可していない可能性）');
        });
        this.hls.loadSource(url);
        this.hls.attachMedia(v);
      }).catch(() => this.fail('HLS 再生用の部品を読み込めませんでした'));
    } else {
      v.src = url;
    }
  }
  play() { this.video.play().catch(() => {}); }
  pause() { this.video.pause(); }
  seek(t) { this.video.currentTime = t; }
  getTime() { return this.video.currentTime || 0; }
  getDuration() { return Number.isFinite(this.video.duration) ? this.video.duration : 0; }
  isPlaying() { return !this.video.paused && !this.video.ended; }
  setRate(r) { this.video.playbackRate = r; }
  setMuted(m) { this.video.muted = m; }
  setVolume(v) { this.video.volume = v; }
  destroy() {
    this.video.pause();
    this.hls?.destroy();
    this.video.removeAttribute('src');
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.host.innerHTML = '';
  }
}

// ---------- URL の読み取り ----------
const SOURCE_NAMES = {
  youtube: 'YouTube', twitch: 'Twitch', vimeo: 'Vimeo', niconico: 'ニコニコ', url: '直リンク', local: 'ファイル',
};

// "1h2m3s" / "90" / "90s" / "1:30" を秒に変換する
function parseTimeParam(v) {
  if (!v) return 0;
  const hms = String(v).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/);
  if (hms && (hms[1] || hms[2] || hms[3])) return (+(hms[1] || 0)) * 3600 + (+(hms[2] || 0)) * 60 + (+(hms[3] || 0));
  const t = parseClock(v);
  return t == null ? 0 : Math.max(0, t);
}

// 同期できないことが分かっているサイト（外から再生位置を操作する仕組みがない）
const UNSUPPORTED = [
  [/(^|\.)kick\.com$/, 'Kick は外部から再生位置を操作できないため、同期に対応していません'],
  [/(^|\.)(x|twitter)\.com$/, 'X（Twitter）の動画は外部から操作できないため、同期に対応していません'],
  [/(^|\.)tiktok\.com$/, 'TikTok は外部から操作できないため、同期に対応していません'],
  [/(^|\.)instagram\.com$/, 'Instagram は外部から操作できないため、同期に対応していません'],
  [/(^|\.)(facebook|fb)\.com$/, 'Facebook の動画は外部から操作できないため、同期に対応していません'],
  [/(^|\.)drive\.google\.com$/, 'Google ドライブの動画は外部から操作できないため、同期に対応していません。ファイルをダウンロードして読み込んでください'],
  [/(^|\.)bilibili\.com$/, 'bilibili は外部から操作できないため、同期に対応していません'],
];

function parseSource(input) {
  const s = input.trim();
  if (!s) return null;
  if (/^[\w-]{11}$/.test(s)) return { type: 'youtube', src: s, start: 0 };
  if (/^(sm|nm|so)\d+$/.test(s)) return { type: 'niconico', src: s, start: 0 };
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return { error: 'URL として読み取れません' }; }
  const host = u.hostname.replace(/^(www|m|music|sp)\./, '');
  const q = (k) => u.searchParams.get(k);
  const t = parseTimeParam(q('t') || q('start') || q('from'));

  if (host === 'youtu.be') {
    const id = u.pathname.slice(1, 12);
    if (/^[\w-]{11}$/.test(id)) return { type: 'youtube', src: id, start: t };
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    let id = u.pathname === '/watch' ? q('v') : null;
    const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
    if (m) id = m[2];
    if (id && /^[\w-]{11}$/.test(id)) return { type: 'youtube', src: id, start: t };
    return { error: 'YouTube の動画ページの URL を入れてください（チャンネルや再生リストには対応していません）' };
  }
  if (host === 'twitch.tv' || host === 'player.twitch.tv' || host === 'clips.twitch.tv') {
    const m = u.pathname.match(/\/videos\/(\d+)/);
    const id = m ? m[1] : (q('video') || '').replace(/^v/, '');
    if (/^\d+$/.test(id)) return { type: 'twitch', src: id, start: t };
    if (host === 'clips.twitch.tv' || /\/clip\//.test(u.pathname)) {
      return { error: 'Twitch のクリップは外部から操作できないため、同期に対応していません' };
    }
    return { error: 'Twitch はライブ配信を同期できません。過去の配信（/videos/…）の URL を入れてください' };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const nums = u.pathname.split('/').filter(Boolean);
    const i = nums.findIndex((p) => /^\d+$/.test(p));
    if (i >= 0) {
      const hash = q('h') || (nums[i + 1] && /^[0-9a-f]+$/i.test(nums[i + 1]) ? nums[i + 1] : '');
      return { type: 'vimeo', src: hash ? `${nums[i]}/${hash}` : nums[i], start: t };
    }
  }
  if (host === 'nicovideo.jp' || host === 'embed.nicovideo.jp' || host === 'nico.ms') {
    const m = u.pathname.match(/((?:sm|nm|so)\d+)/);
    if (m) return { type: 'niconico', src: m[1], start: t };
    return { error: 'ニコニコ動画の動画ページ（/watch/sm…）の URL を入れてください' };
  }
  if (/\.(mp4|webm|mov|m4v|ogv|m3u8)$/i.test(u.pathname)) {
    if (u.protocol !== 'https:') return { error: '直リンクは https:// の URL だけに対応しています' };
    return { type: 'url', src: u.href, start: t };
  }
  for (const [re, msg] of UNSUPPORTED) if (re.test(host)) return { error: msg };
  return { error: '対応していない URL です（YouTube / Twitch の過去配信 / Vimeo / ニコニコ動画 / mp4・webm・m3u8 の直リンク）' };
}

function createPlayer(tile, host) {
  switch (tile.type) {
    case 'youtube': return new YouTubePlayer(host, tile.src);
    case 'twitch': return new TwitchPlayer(host, tile.src);
    case 'vimeo': return new VimeoPlayer(host, tile.src);
    case 'niconico': return new NicoPlayer(host, tile.src);
    case 'url': return new MediaPlayer(host, { url: tile.src });
    default: return new MediaPlayer(host, { file: tile.file });
  }
}
