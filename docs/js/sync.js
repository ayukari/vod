// 同期エンジン
// 「共通の時計（master）」を1本持ち、各動画は「master + 開始位置（offset）」の位置にいるように合わせ続ける。
// 特定の動画を基準にしないので、どの動画を消しても同期は崩れない。

const DRIFT_PLAYING = 0.3;    // 再生中、これ以上ずれたらシークで合わせる（秒）
const DRIFT_PAUSED = 0.08;    // 停止中はより厳しく合わせる
const SEEK_COOLDOWN_PLAYING = 1500; // シーク直後の埋め込みは古い時刻を返すため、しばらく判定しない（ms）
const SEEK_COOLDOWN_PAUSED = 250;
const STALL_LIMIT = 4000;     // 読み込み待ちで共通の時計を止めてよい最長時間（ms）
const BUFFER_PATIENCE = 3000; // 読み込み待ちの動画をシークせずに待つ最長時間（ms）
const INITIAL_LEAD = 0.25;    // 埋め込みプレーヤーをシークするとき、読み込みの遅れを見込んで先を狙う秒数（初期値）
const MAX_LEAD = 3;

class SyncEngine {
  constructor() {
    this.tiles = [];
    this.master = 0;
    this.playing = false;
    this.rate = 1;
    this.last = performance.now();
    this._handlers = {};
    setInterval(() => this.tick(), 100);
  }
  on(ev, fn) { (this._handlers[ev] ||= []).push(fn); }
  emit(ev, ...a) { (this._handlers[ev] || []).forEach((fn) => fn(...a)); }

  active() { return this.tiles.filter((t) => t.player && t.player.ready && !t.player.error); }

  // 共通タイムラインの長さ = 各動画が終わる master 時刻の最大値
  duration() {
    let d = 0;
    for (const t of this.active()) d = Math.max(d, t.player.getDuration() - t.offset);
    return Math.max(0, d);
  }

  play() {
    if (!this.active().length) return;
    if (this.master >= this.duration() - 0.1) this.master = 0;
    this.playing = true;
    this.last = performance.now();
    this.resetCooldowns();
    this.emit('state');
  }
  pause() {
    this.playing = false;
    for (const t of this.active()) { t.player.pause(); t.rt.cmdAt = performance.now(); }
    this.resetCooldowns();
    this.emit('state');
  }
  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    const d = this.duration();
    this.master = clamp(t, 0, d || 0);
    this.resetCooldowns();
    for (const tile of this.active()) this.syncTile(tile, performance.now());
    this.emit('tick');
  }
  step(dt) {
    if (this.playing) this.pause();
    this.seek(this.master + dt);
  }
  setRate(r) {
    this.rate = r;
    for (const t of this.active()) if (t.player.supportsRate) t.player.setRate(r);
    this.emit('state');
  }
  resetCooldowns() { for (const t of this.tiles) t.rt.cooldownUntil = 0; }

  tick() {
    const now = performance.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    const active = this.active();
    if (this.playing) {
      // どれかが読み込み待ちなら共通の時計を少し待たせる（ただし最長 STALL_LIMIT まで）
      const stalled = active.some((t) => {
        const target = this.master + t.offset;
        const inRange = target >= 0 && target < t.player.getDuration() - 0.1;
        if (!inRange || !t.player.buffering) { t.rt.bufSince = 0; return false; }
        if (!t.rt.bufSince) t.rt.bufSince = now;
        return now - t.rt.bufSince < STALL_LIMIT;
      });
      // 動画の実際の再生速度は時計とわずかに違うため、順調に再生している1本（リーダー）に
      // 共通の時計を合わせ、ほかの動画をリーダーにそろえる。リーダーがいないときだけ時計で進める
      const leader = this.pickLeader(active, now);
      if (leader) this.master = Math.max(0, leader.player.getTime() - leader.offset);
      else if (!stalled) this.master += dt * this.rate;
      const d = this.duration();
      if (d > 0 && this.master >= d) { this.master = d; this.pause(); }
    }
    for (const t of active) this.syncTile(t, now);
    this.emit('tick');
  }

  // 現在位置を正確に返せるプレーヤーを優先する（Vimeo・ニコニコは推定値なので後回し）
  pickLeader(active, now) {
    const ok = (t) => {
      const target = this.master + t.offset;
      return now >= t.rt.cooldownUntil && t.player.isPlaying() && !t.player.buffering
        && target >= 0 && target < t.player.getDuration() - 0.2;
    };
    // 今のリーダーが使えるうちは替えない（替えるたびに時計が跳んで、全体がずれるため）
    if (this.leader && active.includes(this.leader) && ok(this.leader)) return this.leader;
    const rank = { local: 0, url: 0, youtube: 1, twitch: 2, vimeo: 3, niconico: 4 };
    this.leader = active.filter(ok).sort((a, b) => rank[a.player.kind] - rank[b.player.kind])[0] || null;
    return this.leader;
  }

  syncTile(t, now) {
    const p = t.player;
    const rt = t.rt;
    const dur = p.getDuration();
    const target = this.master + t.offset;
    t.status = target < 0 ? 'waiting' : (dur > 0 && target >= dur - 0.05 ? 'ended' : 'ok');
    const want = this.playing && t.status === 'ok';

    if (want && !p.isPlaying() && now - rt.cmdAt > 800) { p.play(); rt.cmdAt = now; }
    if (!want && p.isPlaying() && now - rt.cmdAt > 300) { p.pause(); rt.cmdAt = now; }

    if (t.status === 'ended' || now < rt.cooldownUntil) return;
    if (p.cued && !want) return; // YouTube: 未再生の状態でシークすると再生が始まってしまう

    const goal = t.status === 'waiting' ? 0 : target;
    const drift = p.getTime() - goal;

    if (want) {
      // 読み込み待ちの間はシークしない（シークするとまた読み込み待ちになり、追いつけなくなる）
      if (p.buffering) {
        rt.bufSince ||= now;
        if (now - rt.bufSince < BUFFER_PATIENCE) return;
      } else {
        rt.bufSince = 0;
      }
      // 直前のシークでどれだけ遅れて着地したかを覚え、次は その分だけ先を狙う
      if (rt.measure && p.isPlaying() && !p.buffering) {
        rt.lead = clamp((rt.lead ?? INITIAL_LEAD) - drift, 0, MAX_LEAD);
        rt.measure = false;
      }
    }

    if (Math.abs(drift) > (want ? DRIFT_PLAYING : DRIFT_PAUSED)) {
      const lead = want && !p.fineRate ? (rt.lead ?? INITIAL_LEAD) * this.rate : 0;
      p.seek(goal + lead);
      rt.measure = want;
      rt.cooldownUntil = now + (want ? SEEK_COOLDOWN_PLAYING : SEEK_COOLDOWN_PAUSED);
      if (p.fineRate) p.setRate(this.rate);
    } else if (want && p.fineRate) {
      // ローカル動画は速度を ±6% まで微調整して、シークなしで滑らかに追いつかせる
      p.setRate(this.rate * (1 + clamp(-drift * 0.6, -0.06, 0.06)));
    }
  }
}
