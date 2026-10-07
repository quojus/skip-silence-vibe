// Cubic-Bézier wie in CSS: Kurve von (0,0) nach (1,1) mit Kontrollpunkten P1, P2.
(() => {
  const SS = (globalThis.SS = globalThis.SS || {});

  // Eine Koordinate der Kurve zum Parameter s ∈ [0,1]
  const coord = (p1, p2, s) => {
    const inv = 1 - s;
    return 3 * inv * inv * s * p1 + 3 * inv * s * s * p2 + s * s * s;
  };
  const slope = (p1, p2, s) => {
    const inv = 1 - s;
    return 3 * inv * inv * p1 + 6 * inv * s * (p2 - p1) + 3 * s * s * (1 - p2);
  };

  /** Fortschritt y zur Zeit t ∈ [0,1]. */
  SS.bezierY = function bezierY(b, t) {
    const [x1, y1, x2, y2] = b;
    const x = Math.min(1, Math.max(0, t));
    if (x === 0 || x === 1) return x;

    // Newton-Verfahren für x(s) = t
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = coord(x1, x2, s) - x;
      if (Math.abs(err) < 1e-7) return coord(y1, y2, s);
      const d = slope(x1, x2, s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
      if (s < 0 || s > 1) break;
    }

    // Fallback: Bisektion (x(s) ist für x1, x2 ∈ [0,1] monoton)
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 40; i++) {
      const cx = coord(x1, x2, s);
      if (Math.abs(cx - x) < 1e-7) break;
      if (cx < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return coord(y1, y2, s);
  };

  /** n gleichmäßig verteilte Stützstellen y(i/(n-1)). */
  SS.sampleBezier = function sampleBezier(b, n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = SS.bezierY(b, n === 1 ? 1 : i / (n - 1));
    return out;
  };

  if (typeof module !== "undefined") module.exports = SS;
})();
