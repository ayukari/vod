// 描画レイヤー：動画の上にペン・矢印・線・四角・丸を描く
// 座標は画面サイズに対する割合（0〜1）で持つので、ウィンドウサイズを変えても位置がずれない。

class DrawLayer {
  constructor(canvas, stage) {
    this.canvas = canvas;
    this.stage = stage;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];
    this.current = null;
    this.tool = 'pen';
    this.color = '#ff5a5f';
    this.width = 4;
    this.enabled = false;
    this.onChange = () => {};
    new ResizeObserver(() => this.resize()).observe(stage);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
  }

  setEnabled(on) {
    this.enabled = on;
    this.canvas.classList.toggle('on', on);
  }

  resize() {
    const r = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.redraw();
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }
  down(e) {
    if (!this.enabled || e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.pos(e);
    this.current = { tool: this.tool, color: this.color, width: this.width, points: [p, p] };
    this.redraw();
  }
  move(e) {
    if (!this.current) return;
    const p = this.pos(e);
    if (this.current.tool === 'pen') this.current.points.push(p);
    else this.current.points[1] = p;
    this.redraw();
  }
  up() {
    if (!this.current) return;
    const s = this.current;
    this.current = null;
    const [a, b] = [s.points[0], s.points[s.points.length - 1]];
    const tiny = s.tool !== 'pen' && Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.005;
    if (!tiny) { this.strokes.push(s); this.onChange(); }
    this.redraw();
  }

  undo() { if (this.strokes.pop()) { this.redraw(); this.onChange(); } }
  clear() { if (this.strokes.length) { this.strokes = []; this.redraw(); this.onChange(); } }
  load(strokes) { this.strokes = Array.isArray(strokes) ? strokes : []; this.redraw(); }

  redraw() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    this.render(this.ctx, w, h);
  }

  // スクリーンショットでも使うため、描画先と大きさを引数で受け取る
  render(ctx, w, h) {
    const all = this.current ? [...this.strokes, this.current] : this.strokes;
    for (const s of all) {
      ctx.save();
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(0,0,0,.55)';
      ctx.shadowBlur = 3;
      const pts = s.points.map(([x, y]) => [x * w, y * h]);
      const [a, b] = [pts[0], pts[pts.length - 1]];
      ctx.beginPath();
      if (s.tool === 'pen') {
        ctx.moveTo(...a);
        for (const p of pts.slice(1)) ctx.lineTo(...p);
        ctx.stroke();
      } else if (s.tool === 'line' || s.tool === 'arrow') {
        ctx.moveTo(...a);
        ctx.lineTo(...b);
        ctx.stroke();
        if (s.tool === 'arrow') {
          const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
          const len = 10 + s.width * 3;
          ctx.beginPath();
          ctx.moveTo(...b);
          ctx.lineTo(b[0] - len * Math.cos(ang - 0.45), b[1] - len * Math.sin(ang - 0.45));
          ctx.lineTo(b[0] - len * Math.cos(ang + 0.45), b[1] - len * Math.sin(ang + 0.45));
          ctx.closePath();
          ctx.fill();
        }
      } else if (s.tool === 'rect') {
        ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      } else if (s.tool === 'circle') {
        ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}
