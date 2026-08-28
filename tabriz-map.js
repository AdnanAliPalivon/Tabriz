/* Tabriz map engine — no dependencies, no tiles, no projection code.
 *
 * The whole study sits in one UTM 43N frame, so the base image and every vector
 * layer share a single linear transform. That is the entire reason this file is
 * 500 lines instead of a 800 KB library: at a 2 km site there is nothing for a
 * projection engine to do.
 *
 * Coordinates arrive as integer metres east/north of bundle.meta.origin_utm.
 * Screen = (world - centre) * scale + half the viewport.
 */
(function (global) {
  'use strict';

  var RM = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* requestAnimationFrame is paused in a hidden tab, so an animation started there
     never completes and the view is stranded mid-tween. Snap instead. */
  function noAnim() { return RM || document.hidden; }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  /* ---------------------------------------------------------------- palette */
  var PALETTES = {
    light: {
      tabriz: '#C0562A', tabrizGlow: 'rgba(255,255,255,.55)',
      canal: '#0E6E93', penstock: '#B23A2E', ink: '#12181A', halo: 'rgba(255,255,255,.92)',
      contour: 'rgba(24,40,44,.22)', contourIndex: 'rgba(24,40,44,.38)',
      command: '#2E8B6F', flood: ['#0B3D5C', '#1E5E80', '#2A6E92', '#5C9CBA', '#83B4CC', '#9CC4D6'],
      river: '#2E7FA6', riverBelt: '#B9C3C6', road: '#F0E4CE', roadMinor: '#E2D6C0',
      roadCasing: 'rgba(40,34,24,.72)',
      alloc: ['#2F7D5C', '#7BA05B', '#B0472C', '#7A3E7E', '#C9B77E', 'rgba(120,124,118,.30)'],
      suit: ['#1F7A5A', '#69A96F', '#C9B063', 'rgba(120,124,118,.30)'],
      constraint: ['#4E9B6B', '#C9B063', '#D4834A', '#9E3B2E'],
      slope: ['#18685A', '#4E9A72', '#8EB77F', '#D6B65C', '#A9502F'],
      scrim: 'rgba(252,253,252,.86)', scrimLine: 'rgba(18,24,26,.10)'
    },
    dark: {
      tabriz: '#E8804F', tabrizGlow: 'rgba(0,0,0,.45)',
      canal: '#63BEE0', penstock: '#E8806A', ink: '#E6EDEE', halo: 'rgba(10,18,21,.90)',
      contour: 'rgba(180,220,235,.20)', contourIndex: 'rgba(180,220,235,.34)',
      command: '#4FBF9B', flood: ['#1B4E6E', '#256A90', '#2F80A8', '#57A8C6', '#7EC0D8', '#9AD0E2'],
      river: '#5FB6D8', riverBelt: '#5A6A70', road: '#E8DCC4', roadMinor: '#C3B69E',
      roadCasing: 'rgba(6,12,15,.80)',
      alloc: ['#3EA075', '#93BE6E', '#D2603F', '#A05BA6', '#D6C48C', 'rgba(140,150,150,.24)'],
      suit: ['#37A177', '#7FC287', '#D6C06E', 'rgba(140,150,150,.24)'],
      constraint: ['#5FB47E', '#D6C071', '#E2955A', '#C05141'],
      slope: ['#2A8A75', '#63B98C', '#A3CC92', '#E2C76B', '#C4653D'],
      scrim: 'rgba(14,24,27,.84)', scrimLine: 'rgba(230,237,238,.12)'
    }
  };

  /* ---------------------------------------------------------------- engine */
  function TabrizMap(el, bundle, opts) {
    opts = opts || {};
    this.el = el;
    this.b = bundle;
    this.meta = bundle.meta;
    this.W = bundle.frame.w;              // frame size in metres
    this.H = bundle.frame.h;
    this.layers = {};                     // name -> config
    this.order = [];
    this.labels = [];
    this._anim = null;
    this._raf = null;
    this._images = {};
    this.theme = opts.theme || 'auto';
    // The home view was also the widest possible view, which meant the maps could
    // not zoom out at all. minZoomOut is now the ratio that reaches the widest base
    // frame the map has been given.
    this._fixedMin = opts.minZoomOut !== undefined;
    this.minZoomOut = opts.minZoomOut !== undefined ? opts.minZoomOut : 1.0;
    this.maxZoomIn = opts.maxZoomIn || 9.0;
    this.onView = opts.onView || null;

    el.classList.add('tzmap');
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'application');
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', 'Interactive map of Tabriz');

    this.cv = document.createElement('canvas');
    this.cv.className = 'tzmap-canvas';
    el.appendChild(this.cv);
    this.ctx = this.cv.getContext('2d');

    this.lyr = document.createElement('div');
    this.lyr.className = 'tzmap-labels';
    this.lyr.setAttribute('aria-hidden', 'true');
    el.appendChild(this.lyr);

    this.ui = document.createElement('div');
    this.ui.className = 'tzmap-ui';
    el.appendChild(this.ui);
    this._buildControls();
    this.coarse = global.matchMedia && global.matchMedia('(pointer: coarse)').matches;

    var v = bundle.views[opts.view || 'tabriz'];
    this.home = { cx: v.x + v.w / 2, cy: v.y + v.h / 2, w: v.w, h: v.h };
    this.view = { cx: this.home.cx, cy: this.home.cy, scale: 1 };

    this._bind();
    this._resize();
    this.resetView(false);
  }

  TabrizMap.prototype.pal = function () {
    var t = this.theme;
    if (t === 'auto') {
      var r = document.documentElement.getAttribute('data-theme');
      if (r === 'dark' || r === 'light') t = r;
      else t = (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches)
        ? 'dark' : 'light';
    }
    return PALETTES[t] || PALETTES.light;
  };

  TabrizMap.prototype.themeName = function () {
    return this.pal() === PALETTES.dark ? 'dark' : 'light';
  };

  /* ------------------------------------------------------------ base imagery
     The study sits inside four nested frames — 2.1 km, 2.2 km, 12 km and 34 km —
     so a reader can pull back from the terrace to the Karakoram. They are painted
     coarse-first, which means detail simply appears wherever it exists and there is
     never a cut between two differently-rendered maps. Finer frames are drawn with a
     faded border by _feathered(), which is what actually delivers that. */
  TabrizMap.prototype.setBase = function (light, dark) {
    return this.setBases([{ id: 'frame', x: 0, y: 0, w: this.W, h: this.H,
                            urls: { light: light, dark: dark } }]);
  };

  TabrizMap.prototype.setBases = function (list) {
    var self = this;
    this._bases = (list || []).map(function (b) {
      var rec = { x: b.x, y: b.y, w: b.w, h: b.h, id: b.id, res: b.res_m_per_px || 0, im: {} };
      ['light', 'dark'].forEach(function (t) {
        var url = (b.urls || {})[t];
        if (!url) return;
        var im = new Image();
        im.decoding = 'async';
        im.onload = function () { self.draw(); };
        im.src = url;
        rec.im[t] = im;
      });
      return rec;
    });
    // coarsest first, so finer frames paint over them
    this._bases.sort(function (a, b) { return (b.res || 0) - (a.res || 0); });
    this._recalcMin();
    this.draw();
    return this;
  };

  /** A base with its border faded out, cached per theme and drawn size. */
  TabrizMap.prototype._feathered = function (B, im, theme, w, h) {
    var cw = Math.max(2, Math.round(w)), ch = Math.max(2, Math.round(h));
    // Cap the working canvas: past the image's own resolution the fade gains nothing.
    var lim = Math.max(im.naturalWidth, 32);
    if (cw > lim) { ch = Math.round(ch * lim / cw); cw = lim; ch = Math.max(2, ch); }
    var key = theme + ':' + cw + 'x' + ch;
    B._fx = B._fx || {};
    if (B._fx.key === key && B._fx.src === im) return B._fx.cv;
    var cv = B._fx.cv || document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    var g = cv.getContext('2d');
    g.clearRect(0, 0, cw, ch);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(im, 0, 0, cw, ch);
    var f = Math.max(2, Math.round(Math.min(cw, ch) * 0.10));
    g.globalCompositeOperation = 'destination-out';
    var edges = [[0, 0, f, 0, 0, 0, f, ch],                 // west
                 [cw, 0, cw - f, 0, cw - f, 0, f, ch],      // east
                 [0, 0, 0, f, 0, 0, cw, f],                 // north
                 [0, ch, 0, ch - f, 0, ch - f, cw, f]];     // south
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i], gr = g.createLinearGradient(e[0], e[1], e[2], e[3]);
      gr.addColorStop(0, 'rgba(0,0,0,1)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(e[4], e[5], e[6], e[7]);
    }
    g.globalCompositeOperation = 'source-over';
    B._fx.key = key; B._fx.src = im; B._fx.cv = cv;
    return cv;
  };

  /* ---------------------------------------------------------------- layers */
  TabrizMap.prototype.layer = function (name, cfg) {
    if (cfg === false) { delete this.layers[name]; this.order = this.order.filter(function (n) { return n !== name; }); }
    else {
      if (!this.layers[name]) this.order.push(name);
      this.layers[name] = Object.assign({ opacity: 1, reveal: 1, visible: true }, this.layers[name], cfg);
    }
    this.draw();
    return this;
  };

  TabrizMap.prototype.get = function (name) { return this.layers[name]; };

  /** Animate a numeric property of a layer (or several) to a target. */
  TabrizMap.prototype.tween = function (name, props, ms) {
    var L = this.layers[name];
    if (!L) return this;
    if (noAnim() || !ms) { Object.assign(L, props); this.draw(); return this; }
    var from = {}, k;
    for (k in props) from[k] = L[k] === undefined ? 0 : L[k];
    var t0 = performance.now(), self = this;
    (function step(t) {
      var u = clamp((t - t0) / ms, 0, 1), e = easeOut(u), kk;
      for (kk in props) L[kk] = lerp(from[kk], props[kk], e);
      self.draw();
      if (u < 1) requestAnimationFrame(step);
    })(t0);
    return this;
  };

  /* --------------------------------------------------------------- geometry */
  TabrizMap.prototype._resize = function () {
    var r = this.el.getBoundingClientRect();
    this.vw = Math.max(1, Math.round(r.width));
    this.vh = Math.max(1, Math.round(r.height));
    var dpr = Math.min(global.devicePixelRatio || 1, this.vw < 700 ? 2 : 2.5);
    this.dpr = dpr;
    this.cv.width = Math.round(this.vw * dpr);
    this.cv.height = Math.round(this.vh * dpr);
    this.cv.style.width = this.vw + 'px';
    this.cv.style.height = this.vh + 'px';
    this.fit = Math.max(this.vw / this.home.w, this.vh / this.home.h);
    this._recalcMin();
  };

  /** The zoom floor is whatever it takes to frame the widest base, with a little
      slack. Guessing it clamped Valley and Region onto the same scale. */
  TabrizMap.prototype._recalcMin = function () {
    if (this._fixedMin || !this.fit) return;
    var B = this.bounds();
    var need = Math.min(this.vw / B.w, this.vh / B.h) / this.fit;
    this.minZoomOut = need * 0.92;
  };

  TabrizMap.prototype.k = function () { return this.fit * this.view.scale; };

  TabrizMap.prototype.toScreen = function (x, y) {
    var k = this.k();
    return [(x - this.view.cx) * k + this.vw / 2, (this.view.cy - y) * k + this.vh / 2];
  };

  TabrizMap.prototype.toWorld = function (px, py) {
    var k = this.k();
    return [(px - this.vw / 2) / k + this.view.cx, this.view.cy - (py - this.vh / 2) / k];
  };

  /** The rectangle the reader is allowed to wander in: the widest base frame, or the
      bundle frame if the map only has one. Prevents meaningless global panning while
      still allowing the full pull-back to the Karakoram. */
  TabrizMap.prototype.bounds = function () {
    var b = (this._bases || []).slice().sort(function (p, q) { return q.w - p.w; })[0];
    return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : { x: 0, y: 0, w: this.W, h: this.H };
  };

  TabrizMap.prototype._clampView = function () {
    this.view.scale = clamp(this.view.scale, this.minZoomOut, this.maxZoomIn);
    var k = this.k(), B = this.bounds(),
      halfW = this.vw / 2 / k, halfH = this.vh / 2 / k;
    // keep at least a third of the viewport over real ground at every zoom
    var mx = Math.max(0, halfW - B.w / 3), my = Math.max(0, halfH - B.h / 3);
    this.view.cx = clamp(this.view.cx, B.x - mx, B.x + B.w + mx);
    this.view.cy = clamp(this.view.cy, B.y - my, B.y + B.h + my);
  };

  /** Fly to a named view from bundle.views. */
  TabrizMap.prototype.goToView = function (name, animate) {
    var v = this.b.views && this.b.views[name];
    if (!v) return this;
    var scale = Math.min(this.vw / v.w, this.vh / v.h) / this.fit;
    return this.flyTo(v.x + v.w / 2, v.y + v.h / 2, scale, animate === false ? 0 : 620);
  };

  TabrizMap.prototype.flyTo = function (cx, cy, scale, ms) {
    var to = { cx: cx, cy: cy, scale: clamp(scale, this.minZoomOut, this.maxZoomIn) };
    if (noAnim() || !ms) { this.view = to; this._clampView(); this.draw(); this._emit(); return this; }
    var from = { cx: this.view.cx, cy: this.view.cy, scale: this.view.scale },
      t0 = performance.now(), self = this;
    (function step(t) {
      var u = clamp((t - t0) / ms, 0, 1), e = easeOut(u);
      self.view.cx = lerp(from.cx, to.cx, e);
      self.view.cy = lerp(from.cy, to.cy, e);
      // interpolate zoom logarithmically so the flight feels even
      self.view.scale = Math.exp(lerp(Math.log(from.scale), Math.log(to.scale), e));
      self._clampView(); self.draw();
      if (u < 1) requestAnimationFrame(step); else self._emit();
    })(t0);
    return this;
  };

  TabrizMap.prototype.resetView = function (animate) {
    var to = { cx: this.home.cx, cy: this.home.cy, scale: 1 };
    if (noAnim() || animate === false) { this.view = to; this._clampView(); this.draw(); this._emit(); return this; }
    var from = { cx: this.view.cx, cy: this.view.cy, scale: this.view.scale },
      t0 = performance.now(), self = this;
    (function step(t) {
      var u = clamp((t - t0) / 460, 0, 1), e = easeOut(u);
      self.view.cx = lerp(from.cx, to.cx, e);
      self.view.cy = lerp(from.cy, to.cy, e);
      self.view.scale = lerp(from.scale, to.scale, e);
      self._clampView(); self.draw();
      if (u < 1) requestAnimationFrame(step); else self._emit();
    })(t0);
    return this;
  };

  TabrizMap.prototype.zoomBy = function (f, px, py) {
    var before = this.toWorld(px === undefined ? this.vw / 2 : px, py === undefined ? this.vh / 2 : py);
    this.view.scale = clamp(this.view.scale * f, this.minZoomOut, this.maxZoomIn);
    var after = this.toWorld(px === undefined ? this.vw / 2 : px, py === undefined ? this.vh / 2 : py);
    this.view.cx += before[0] - after[0];
    this.view.cy += before[1] - after[1];
    this._clampView(); this.draw(); this._emit();
    return this;
  };

  /** Show the two-finger hint briefly after a one-finger touch. */
  TabrizMap.prototype._hint = function () {
    var self = this;
    clearTimeout(this._hintT);
    this.el.classList.add('show-hint');
    this._hintT = setTimeout(function () { self.el.classList.remove('show-hint'); }, 1800);
  };

  TabrizMap.prototype._emit = function () {
    if (this.onView) this.onView(this.view.scale);
    var b = this.ui.querySelector('[data-act="reset"]');
    if (b) b.hidden = Math.abs(this.view.scale - 1) < 0.02 &&
      Math.abs(this.view.cx - this.home.cx) < 8 && Math.abs(this.view.cy - this.home.cy) < 8;
  };

  /* ---------------------------------------------------------------- drawing */
  TabrizMap.prototype.draw = function () {
    if (this._raf) return;
    var self = this;
    this._raf = requestAnimationFrame(function () { self._raf = null; self._paint(); });
  };

  TabrizMap.prototype._paint = function () {
    var c = this.ctx, P = this.pal(), k = this.k();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.vw, this.vh);

    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    var theme = this.themeName(), bases = this._bases || [];
    for (var bi = 0; bi < bases.length; bi++) {
      var B = bases[bi], im = B.im[theme] || B.im.light;
      if (!im || !im.complete || !im.naturalWidth) continue;
      var tl = this.toScreen(B.x, B.y + B.h);
      var w = B.w * k, h = B.h * k;
      if (tl[0] > this.vw || tl[1] > this.vh || tl[0] + w < 0 || tl[1] + h < 0) continue;
      // The coarsest frame is the backdrop and keeps its edges. Every finer frame sits
      // inside another one, and drawn square it reads as a photograph pasted onto a map
      // — the imagery-led context frame against the terrain-led valley frame especially,
      // where the content changes kind at the seam. Fading the border crossfades the two
      // renderings of the same ground instead of cutting between them.
      c.drawImage(bi === 0 ? im : this._feathered(B, im, theme, w, h), tl[0], tl[1], w, h);
    }

    for (var i = 0; i < this.order.length; i++) {
      var name = this.order[i], L = this.layers[name];
      if (!L || !L.visible || L.opacity <= 0.002) continue;
      c.save();
      c.globalAlpha = L.opacity;
      this._drawLayer(name, L, P, k);
      c.restore();
    }
    this._paintLabels(P);
  };

  TabrizMap.prototype._path = function (rings, close) {
    var c = this.ctx, k = this.k(), cx = this.view.cx, cy = this.view.cy,
      hw = this.vw / 2, hh = this.vh / 2;
    c.beginPath();
    for (var r = 0; r < rings.length; r++) {
      var p = rings[r];
      if (!p || p.length < 2) continue;
      c.moveTo((p[0][0] - cx) * k + hw, (cy - p[0][1]) * k + hh);
      for (var j = 1; j < p.length; j++) c.lineTo((p[j][0] - cx) * k + hw, (cy - p[j][1]) * k + hh);
      if (close) c.closePath();
    }
  };

  /** Draw the first `reveal` fraction of a polyline, measured by length. */
  TabrizMap.prototype._partial = function (pts, reveal) {
    if (reveal >= 1) return pts;
    var total = 0, i;
    for (i = 1; i < pts.length; i++)
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    var want = total * clamp(reveal, 0, 1), run = 0, out = [pts[0]];
    for (i = 1; i < pts.length; i++) {
      var seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (run + seg >= want) {
        var t = seg ? (want - run) / seg : 0;
        out.push([lerp(pts[i - 1][0], pts[i][0], t), lerp(pts[i - 1][1], pts[i][1], t)]);
        return out;
      }
      run += seg; out.push(pts[i]);
    }
    return out;
  };

  TabrizMap.prototype._drawLayer = function (name, L, P, k) {
    var c = this.ctx, d = this.b.layers[L.data || name], self = this;
    if (!d) return;

    if (d.kind === 'ring') {
      this._path(d.rings, true);
      c.lineJoin = 'round'; c.lineCap = 'round';
      c.strokeStyle = P.tabrizGlow; c.lineWidth = (L.width || 2.4) + 3.6; c.stroke();
      c.strokeStyle = L.color || P.tabriz; c.lineWidth = L.width || 2.4; c.stroke();
      if (L.fill) { c.fillStyle = L.fill; c.fill('evenodd'); }
      return;
    }

    if (d.kind === 'contours') { /* handled by 'lines' */ }

    if (d.kind === 'lines') {
      var sel = L.select;
      d.lines.forEach(function (ln) {
        if (sel && !sel(ln)) return;
        var pts = self._partial(ln.p, L.reveal);
        if (pts.length < 2) return;
        self._path([pts], false);
        c.lineJoin = 'round'; c.lineCap = 'round';
        var isIdx = ln.i === 1;
        if (L.halo) { c.strokeStyle = P.halo; c.lineWidth = (L.width || 2) + 3.4; c.setLineDash([]); c.stroke(); }
        c.setLineDash(L.dash || []);
        c.strokeStyle = L.color || (name === 'contours' ? (isIdx ? P.contourIndex : P.contour) : P.ink);
        c.lineWidth = L.width || (name === 'contours' ? (isIdx ? 1.1 : 0.7) : 2);
        c.stroke();
        c.setLineDash([]);
      });
      return;
    }

    if (d.kind === 'steps') {
      var idx = L.index === undefined ? 0 : L.index;
      var lo = Math.floor(idx), hi = Math.min(d.steps.length - 1, lo + 1), f = idx - lo;
      // Draw the lower step solid and cross-fade the next one in, so the slider
      // reads as continuous even though the analysis is stepped.
      var drawStep = function (s, alpha) {
        if (!s || alpha <= 0.002) return;
        c.save(); c.globalAlpha = L.opacity * alpha;
        self._path(s.rings, true);
        c.fillStyle = L.color || P.command; c.fill('evenodd');
        c.globalAlpha = Math.min(1, L.opacity * alpha * 1.7);
        c.strokeStyle = L.color || P.command; c.lineWidth = 1.1; c.stroke();
        c.restore();
      };
      if (L.stack) {                       // flood: every stage below, darkest first
        for (var s = d.steps.length - 1; s >= 0; s--) {
          var a = s <= idx ? 1 : (s - 1 < idx ? idx - (s - 1) : 0);
          drawStep(d.steps[s], clamp(a, 0, 1) * (L.palette ? 1 : 1));
          if (L.palette) { /* colour set per step below */ }
        }
      } else {
        drawStep(d.steps[lo], 1);
        drawStep(d.steps[hi], f);
      }
      return;
    }

    if (d.kind === 'classes') {
      var pal = L.palette || P[L.data || name] || P.slope;
      d.classes.forEach(function (cl, i) {
        if (L.only && L.only.indexOf(cl.v) < 0) return;
        var a = L.perClass ? (L.perClass[i] === undefined ? 1 : L.perClass[i]) : 1;
        if (a <= 0.002) return;
        c.save(); c.globalAlpha = L.opacity * a;
        self._path(cl.rings, true);
        c.fillStyle = pal[i] || pal[pal.length - 1];
        c.fill('evenodd');
        // A faint edge in the fill's own colour separates adjacent classes without
        // needing more opacity, which would bury the relief underneath.
        c.globalAlpha = Math.min(1, L.opacity * a * 1.6);
        c.strokeStyle = pal[i] || pal[pal.length - 1];
        c.lineWidth = 1; c.stroke();
        c.restore();
      });
      return;
    }

    if (d.kind === 'river') {
      // A river is not a constant-width polyline. The braided gravel belt is drawn
      // first as a pale band, then the wet channel as a darker ribbon inside it, both
      // from widths measured perpendicular to the line in Sentinel-2. The ribbon
      // tapers because the river does.
      var minPx = L.minPx === undefined ? 1.4 : L.minPx;
      d.river.forEach(function (rv) {
        [['belt_m', L.beltColor || P.riverBelt, 0.55],
         ['wet_m', L.color || P.river, 1]].forEach(function (spec) {
          if (spec[0] === 'belt_m' && L.showBelt === false) return;
          var pts = self._partial(rv.p, L.reveal), w = rv[spec[0]];
          if (pts.length < 2) return;
          var left = [], right = [];
          for (var i = 0; i < pts.length; i++) {
            var a = pts[Math.max(0, i - 1)], b2 = pts[Math.min(pts.length - 1, i + 1)];
            var dx = b2[0] - a[0], dy = b2[1] - a[1], len = Math.hypot(dx, dy) || 1;
            // half width in metres, but never thinner than a hairline on screen
            var hw = Math.max((w[i] || w[w.length - 1]) / 2, minPx / (2 * k));
            var nx2 = -dy / len * hw, ny2 = dx / len * hw;
            left.push([pts[i][0] + nx2, pts[i][1] + ny2]);
            right.unshift([pts[i][0] - nx2, pts[i][1] - ny2]);
          }
          self._path([left.concat(right)], true);
          c.globalAlpha = L.opacity * spec[2];
          c.fillStyle = spec[1];
          c.fill();
          c.globalAlpha = L.opacity;
        });
      });
      return;
    }

    if (d.kind === 'road') {
      // Casing and fill, the way a road is drawn on any map worth reading: a dark
      // outer stroke that separates it from the ground, a lighter core inside it.
      var order = ['main', 'lane', 'track', 'path'];
      [1, 0].forEach(function (pass) {
        d.roads.forEach(function (rd) {
          if (L.only && L.only.indexOf(rd.kind) < 0) return;
          var pts = self._partial(rd.p, L.reveal);
          if (pts.length < 2) return;
          // width in metres, floored so the road stays visible when zoomed out
          var wm = Math.max(rd.width_m, (L.minPx || 2.4) / k);
          self._path([pts], false);
          c.lineCap = 'round'; c.lineJoin = 'round';
          c.setLineDash(rd.kind === 'path' ? [6, 5] : []);
          if (pass) {
            c.strokeStyle = L.casing || P.roadCasing;
            c.lineWidth = wm * k + (rd.kind === 'main' ? 3.0 : 2.2);
          } else {
            c.strokeStyle = L.color || (rd.kind === 'main' ? P.road : P.roadMinor);
            c.lineWidth = Math.max(1, wm * k);
          }
          c.stroke();
          c.setLineDash([]);
        });
      });
      return;
    }

    if (d.kind === 'measure') {
      // An animated measurement line: dashes travel from Tabriz to the target while
      // the reveal runs, and the distance sits on the midpoint.
      var m = L.item;
      if (!m) return;
      var a = m.from, b2 = m.to;
      var t = clamp(L.reveal, 0, 1);
      var mid = [lerp(a[0], b2[0], t), lerp(a[1], b2[1], t)];
      self._path([[a, mid]], false);
      c.lineCap = 'round';
      c.strokeStyle = P.halo; c.lineWidth = 5.5; c.setLineDash([]); c.stroke();
      c.strokeStyle = L.color || P.tabriz; c.lineWidth = 2.2;
      c.setLineDash([7, 5]); c.lineDashOffset = -(L.phase || 0); c.stroke();
      c.setLineDash([]);
      [[a, 4.5], [mid, t >= 1 ? 6 : 3.5]].forEach(function (pr) {
        var s2 = self.toScreen(pr[0][0], pr[0][1]);
        c.beginPath(); c.arc(s2[0], s2[1], pr[1], 0, 6.2832);
        c.fillStyle = L.color || P.tabriz; c.fill();
        c.lineWidth = 2; c.strokeStyle = P.halo; c.stroke();
      });
      return;
    }

    if (d.kind === 'scheme') {
      var opt = d.options.filter(function (o) { return o.option === (L.option || 'A'); })[0] || d.options[0];
      if (L.showPenstock !== false) {
        var pts = self._partial(opt.p, L.reveal);
        if (pts.length > 1) {
          self._path([pts], false);
          c.lineJoin = 'round'; c.lineCap = 'round';
          c.strokeStyle = P.halo; c.lineWidth = 6; c.stroke();
          c.setLineDash(L.flow ? [10, 7] : []);
          c.lineDashOffset = L.flow ? -(L.phase || 0) : 0;
          c.strokeStyle = P.penstock; c.lineWidth = 3; c.stroke();
          c.setLineDash([]);
        }
      }
    }
  };

  /* ---------------------------------------------------------------- labels */
  TabrizMap.prototype.setLabels = function (list) { this.labels = list || []; this.draw(); return this; };

  TabrizMap.prototype._paintLabels = function (P) {
    var frag = '', self = this, k = this.k();
    this.labels.forEach(function (L) {
      if (L.minScale && self.view.scale < L.minScale) return;
      if (L.maxScale && self.view.scale > L.maxScale) return;
      var s = self.toScreen(L.at[0], L.at[1]);
      if (s[0] < -220 || s[1] < -120 || s[0] > self.vw + 220 || s[1] > self.vh + 120) return;
      // text may be a function so a bilingual page can re-resolve it on a language
      // change without the caller having to rebuild every label set
      var txt = typeof L.text === 'function' ? L.text() : L.text;
      var cls = 'tzlabel' + (L.kind ? ' is-' + L.kind : '');
      frag += '<div class="' + cls + '" style="left:' + s[0].toFixed(1) + 'px;top:' + s[1].toFixed(1) +
        'px' + (L.anchor ? ';--ax:' + L.anchor[0] + ';--ay:' + L.anchor[1] : '') + '">' +
        (L.marker ? '<i class="tzdot" style="--c:' + (L.color || P.canal) + '"></i>' : '') +
        '<span>' + txt + '</span></div>';
    });
    this.lyr.innerHTML = frag;
  };

  /* -------------------------------------------------------------- controls */
  TabrizMap.prototype._buildControls = function () {
    this.ui.innerHTML =
      '<div class="tzmap-zoom">' +
      '<button type="button" data-act="in"  aria-label="Zoom in">+</button>' +
      '<button type="button" data-act="out" aria-label="Zoom out">−</button>' +
      '</div>' +
      '<button type="button" class="tzmap-reset" data-act="reset" hidden>Reset to Tabriz</button>' +
      '<div class="tzmap-scale" aria-hidden="true"><span class="bar"></span><span class="txt"></span></div>' +
      '<div class="tzmap-hint" aria-hidden="true">Use two fingers to move the map</div>';
    var self = this;
    this.ui.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      e.stopPropagation();
      if (b.dataset.act === 'in') self.zoomBy(1.55);
      else if (b.dataset.act === 'out') self.zoomBy(1 / 1.55);
      else self.resetView(true);
    });
  };

  TabrizMap.prototype._updateScalebar = function () {
    var k = this.k(), el = this.ui.querySelector('.tzmap-scale');
    if (!el) return;
    var targets = [50, 100, 200, 250, 500, 1000], want = 130 / k, pick = targets[0];
    for (var i = 0; i < targets.length; i++) if (targets[i] <= want) pick = targets[i];
    el.querySelector('.bar').style.width = (pick * k).toFixed(1) + 'px';
    el.querySelector('.txt').textContent = pick >= 1000 ? (pick / 1000) + ' km' : pick + ' m';
  };

  /* ---------------------------------------------------------------- events */
  TabrizMap.prototype._bind = function () {
    var self = this, drag = null, pinch = null;

    var ro = global.ResizeObserver ? new ResizeObserver(function () {
      self._resize(); self._clampView(); self.draw();
    }) : null;
    if (ro) ro.observe(this.el); else global.addEventListener('resize', function () {
      self._resize(); self._clampView(); self.draw();
    });

    this.el.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = self.el.getBoundingClientRect();
      self.zoomBy(Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    this.el.addEventListener('pointerdown', function (e) {
      if (e.target.closest('[data-act]')) return;
      // One finger scrolls the page on a touch screen; two drive the map.
      if (e.pointerType === 'touch') { self._hint(); return; }
      // setPointerCapture throws if the pointer is not active (it also throws on some
      // synthetic events); capture is a convenience, not a requirement.
      try { self.el.setPointerCapture(e.pointerId); } catch (err) {}
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
      self.el.classList.add('is-grabbing');
    });
    this.el.addEventListener('pointermove', function (e) {
      if (!drag || drag.id !== e.pointerId) return;
      var k = self.k();
      self.view.cx -= (e.clientX - drag.x) / k;
      self.view.cy += (e.clientY - drag.y) / k;
      drag.moved += Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
      drag.x = e.clientX; drag.y = e.clientY;
      self._clampView(); self.draw(); self._emit();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      self.el.addEventListener(ev, function () { drag = null; self.el.classList.remove('is-grabbing'); });
    });

    this.el.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) {
        drag = null;
        pinch = { d: dist(e.touches), s: self.view.scale, mid: mid(e.touches) };
      }
    }, { passive: true });
    this.el.addEventListener('touchmove', function (e) {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();                       // two fingers belong to the map
      var r = self.el.getBoundingClientRect(),
        m2 = mid(e.touches),
        mx = m2[0] - r.left, my = m2[1] - r.top,
        k = self.k();
      // pan by the midpoint delta, then zoom about the midpoint
      self.view.cx -= (m2[0] - pinch.mid[0]) / k;
      self.view.cy += (m2[1] - pinch.mid[1]) / k;
      pinch.mid = m2;
      var target = clamp(pinch.s * dist(e.touches) / pinch.d, self.minZoomOut, self.maxZoomIn);
      self.zoomBy(target / self.view.scale, mx, my);
    }, { passive: false });
    this.el.addEventListener('touchend', function (e) { if (e.touches.length < 2) pinch = null; }, { passive: true });

    this.el.addEventListener('dblclick', function (e) {
      var r = self.el.getBoundingClientRect();
      self.zoomBy(1.9, e.clientX - r.left, e.clientY - r.top);
    });

    this.el.addEventListener('keydown', function (e) {
      var step = 60 / self.k(), used = true;
      switch (e.key) {
        case '+': case '=': self.zoomBy(1.4); break;
        case '-': case '_': self.zoomBy(1 / 1.4); break;
        case 'ArrowLeft': self.view.cx -= step; break;
        case 'ArrowRight': self.view.cx += step; break;
        case 'ArrowUp': self.view.cy += step; break;
        case 'ArrowDown': self.view.cy -= step; break;
        case 'Home': case '0': self.resetView(true); break;
        default: used = false;
      }
      if (used) { e.preventDefault(); self._clampView(); self.draw(); self._emit(); }
    });

    function dist(t) {
      return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    }
    function mid(t) {
      return [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
    }

    if (global.matchMedia) {
      var mq = global.matchMedia('(prefers-color-scheme: dark)');
      (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(
        function () { self.draw(); });
    }
    new MutationObserver(function () { self.draw(); }).observe(
      document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  };

  var _paint = TabrizMap.prototype._paint;
  TabrizMap.prototype._paint = function () { _paint.call(this); this._updateScalebar(); };

  global.TabrizMap = TabrizMap;
  global.TabrizMap.reducedMotion = RM;
})(window);
