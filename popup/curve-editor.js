// Ziehbarer Bézier-Editor auf einem Canvas. x = Zeit (0–1), y = Fortschritt (0–1, Überschwinger erlaubt).
(() => {
  const COLORS = {
    bg: "#1b1c21",
    area: "#23252c",
    grid: "#353844",
    diagonal: "#4a4e5c",
    curve: "#7fc8a9",
    handle: "#9aa0aa",
    point: "#8fb4ff",
    active: "#f0c674",
  };
  const PAD_X = 10;
  const HIT_RADIUS = 14;
  const KEY_STEP = 0.01;
  const KEY_STEP_BIG = 0.1;

  const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

  class CurveEditor {
    constructor(canvas, onChange) {
      this.canvas = canvas;
      this.onChange = onChange;
      this.b = [0, 0, 1, 1];
      this.active = 0; // 0 = P1, 1 = P2
      this.dragging = false;

      const dpr = window.devicePixelRatio || 1;
      this.w = canvas.clientWidth || 240;
      this.h = canvas.clientHeight || 140;
      canvas.width = Math.round(this.w * dpr);
      canvas.height = Math.round(this.h * dpr);
      this.ctx = canvas.getContext("2d");
      this.ctx.scale(dpr, dpr);
      canvas.tabIndex = 0;

      canvas.addEventListener("pointerdown", (e) => this.onDown(e));
      canvas.addEventListener("pointermove", (e) => this.onMove(e));
      canvas.addEventListener("pointerup", (e) => this.onUp(e));
      canvas.addEventListener("pointercancel", (e) => this.onUp(e));
      canvas.addEventListener("keydown", (e) => this.onKey(e));
      canvas.addEventListener("focus", () => this.draw());
      canvas.addEventListener("blur", () => this.draw());
      this.draw();
    }

    setBezier(b) {
      this.b = [...b];
      this.draw();
    }

    getBezier() {
      return [...this.b];
    }

    // y-Bereich −0,5…1,5 wird auf die Canvas-Höhe abgebildet
    toPx(x, y) {
      const yMin = SS.BEZIER_Y_MIN;
      const yMax = SS.BEZIER_Y_MAX;
      return [PAD_X + x * (this.w - 2 * PAD_X), this.h - ((y - yMin) / (yMax - yMin)) * this.h];
    }

    fromPx(px, py) {
      const yMin = SS.BEZIER_Y_MIN;
      const yMax = SS.BEZIER_Y_MAX;
      const x = (px - PAD_X) / (this.w - 2 * PAD_X);
      const y = yMin + ((this.h - py) / this.h) * (yMax - yMin);
      return [clamp(x, 0, 1), clamp(y, yMin, yMax)];
    }

    points() {
      return [this.toPx(this.b[0], this.b[1]), this.toPx(this.b[2], this.b[3])];
    }

    localPos(e) {
      const r = this.canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    onDown(e) {
      const [px, py] = this.localPos(e);
      const dist = this.points().map(([x, y]) => Math.hypot(x - px, y - py));
      const nearest = dist[0] <= dist[1] ? 0 : 1;
      this.active = nearest;
      if (dist[nearest] <= HIT_RADIUS) {
        this.dragging = true;
        this.canvas.setPointerCapture(e.pointerId);
      }
      this.canvas.focus();
      this.draw();
    }

    onMove(e) {
      if (!this.dragging) return;
      const [px, py] = this.localPos(e);
      this.movePoint(...this.fromPx(px, py));
    }

    onUp(e) {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    }

    onKey(e) {
      const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
      const i = this.active * 2;
      let [x, y] = [this.b[i], this.b[i + 1]];
      if (e.key === "1" || e.key === "2") {
        this.active = Number(e.key) - 1;
        this.draw();
      } else if (e.key === "ArrowLeft") x -= step;
      else if (e.key === "ArrowRight") x += step;
      else if (e.key === "ArrowUp") y += step;
      else if (e.key === "ArrowDown") y -= step;
      else return;
      e.preventDefault();
      if (e.key.startsWith("Arrow")) {
        this.movePoint(clamp(x, 0, 1), clamp(y, SS.BEZIER_Y_MIN, SS.BEZIER_Y_MAX));
      }
    }

    movePoint(x, y) {
      const i = this.active * 2;
      this.b[i] = Math.round(x * 1000) / 1000;
      this.b[i + 1] = Math.round(y * 1000) / 1000;
      this.draw();
      this.onChange(this.getBezier());
    }

    draw() {
      const c = this.ctx;
      const focused = document.activeElement === this.canvas;
      c.clearRect(0, 0, this.w, this.h);
      c.fillStyle = COLORS.bg;
      c.fillRect(0, 0, this.w, this.h);

      const [x0, y0] = this.toPx(0, 0);
      const [x1, y1] = this.toPx(1, 1);
      c.fillStyle = COLORS.area;
      c.fillRect(x0, y1, x1 - x0, y0 - y1);

      c.strokeStyle = COLORS.grid;
      c.lineWidth = 1;
      for (const g of [0, 0.5, 1]) {
        const [, gy] = this.toPx(0, g);
        const [gx] = this.toPx(g, 0);
        c.beginPath();
        c.moveTo(x0, gy);
        c.lineTo(x1, gy);
        c.moveTo(gx, y1);
        c.lineTo(gx, y0);
        c.stroke();
      }

      c.setLineDash([4, 4]);
      c.strokeStyle = COLORS.diagonal;
      c.beginPath();
      c.moveTo(x0, y0);
      c.lineTo(x1, y1);
      c.stroke();
      c.setLineDash([]);

      const [p1, p2] = this.points();
      c.strokeStyle = COLORS.handle;
      c.beginPath();
      c.moveTo(x0, y0);
      c.lineTo(...p1);
      c.moveTo(x1, y1);
      c.lineTo(...p2);
      c.stroke();

      c.strokeStyle = COLORS.curve;
      c.lineWidth = 2.5;
      c.beginPath();
      c.moveTo(x0, y0);
      c.bezierCurveTo(...p1, ...p2, x1, y1);
      c.stroke();

      [p1, p2].forEach(([px, py], i) => {
        c.fillStyle = focused && i === this.active ? COLORS.active : COLORS.point;
        c.beginPath();
        c.arc(px, py, 6, 0, Math.PI * 2);
        c.fill();
      });
    }
  }

  globalThis.CurveEditor = CurveEditor;
})();
