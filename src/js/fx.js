// Plugin window: the insert chain on the left, the selected processor's
// editor on the right (EQ curve, compressor models with VU, gate, etc).
import { h, knob, select, toggle, drag, clamp } from './ui.js';
import { FX, PRESETS, MAX_FX, sync } from './state.js';
import { pluginMenu, slotMenu } from './mixer.js';

const ms = (v) => (v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`);
const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k` : `${Math.round(v)}`);
const dbf = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
const pct = (v) => `${Math.round(v * 100)}%`;

const MODELS = [
  ['VCA', 'Clean & precise'],
  ['FET', 'Fast & aggressive'],
  ['OPTO', 'Smooth, program dependent'],
  ['VARI-MU', 'Tube glue & warmth'],
];
const BAND_TYPES = [
  { value: 0, label: 'Bell' }, { value: 1, label: 'Low shelf' }, { value: 2, label: 'High shelf' },
  { value: 5, label: 'Notch' }, { value: 3, label: 'High pass' }, { value: 4, label: 'Low pass' },
];

// RBJ biquad, mirroring native/dsp.c, for drawing response curves.
function coefs(type, sr, f, q, g) {
  f = clamp(f, 10, sr * 0.49);
  q = Math.max(q, 0.05);
  const A = 10 ** (g / 40), w0 = (2 * Math.PI * f) / sr, cw = Math.cos(w0), sw = Math.sin(w0), al = sw / (2 * q);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  if (type === 0) { b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
  else if (type === 1 || type === 2) {
    const s = 2 * Math.sqrt(A) * al, sg = type === 1 ? 1 : -1;
    b0 = A * ((A + 1) - sg * (A - 1) * cw + s); b1 = sg * 2 * A * ((A - 1) - sg * (A + 1) * cw); b2 = A * ((A + 1) - sg * (A - 1) * cw - s);
    a0 = (A + 1) + sg * (A - 1) * cw + s; a1 = -sg * 2 * ((A - 1) + sg * (A + 1) * cw); a2 = (A + 1) + sg * (A - 1) * cw - s;
  } else if (type === 3) { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else if (type === 4) { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else if (type === 5) { b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function magDb(c, f, sr) {
  const w = (2 * Math.PI * f) / sr;
  const cr = Math.cos(w), ci = -Math.sin(w), c2r = Math.cos(2 * w), c2i = -Math.sin(2 * w);
  const nr = c[0] + c[1] * cr + c[2] * c2r, ni = c[1] * ci + c[2] * c2i;
  const dr = 1 + c[3] * cr + c[4] * c2r, di = c[3] * ci + c[4] * c2i;
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) + 1e-20);
}

export class FxWindow {
  constructor(app, kind, index, slot) {
    this.app = app;
    this.kind = kind;
    this.index = index;
    this.slot = slot;
    this.gr = 0;
    this.el = h('div', { class: 'fxwin' });
    document.body.append(this.el);
    this.render();
  }

  get target() {
    return this.kind === 'bus' ? this.app.s.buses[this.index] : this.app.s.tracks[this.index];
  }

  get fx() {
    return this.target && this.target.inserts[this.slot];
  }

  close() {
    this.el.remove();
    if (this.app.fx === this) this.app.fx = null;
  }

  push() {
    sync.insert(this.app.s, this.kind, this.index, this.slot);
    this.app.markDirty();
  }

  render() {
    this.redraw = null;
    this.vuEl = null;
    const t = this.target;
    if (!t) return this.close();
    const title = h('div', { class: 'fx-title' }, h('b', {}, `FX – ${t.name}`), h('button', { class: 'x', onclick: () => this.close() }, '✕'));
    let pos = null;
    drag(title, {
      down: (e) => { if (e.target.tagName === 'BUTTON') return false; const r = this.el.getBoundingClientRect(); pos = [r.left, r.top]; return true; },
      move: (dx, dy) => { this.el.style.left = `${pos[0] + dx}px`; this.el.style.top = `${pos[1] + dy}px`; this.el.style.transform = 'none'; },
    });
    const chain = h('div', { class: 'fx-chain' }, h('div', { class: 'hdr' }, 'FX CHAIN'), h('div', { class: 'who' }, t.name));
    t.inserts.forEach((fx, k) => {
      if (!fx) return;
      const pw = h('button', { class: `pw${fx.on ? ' on' : ''}`, title: fx.on ? 'Bypass' : 'Enable' }, '⏻');
      pw.onclick = (e) => { e.stopPropagation(); fx.on = !fx.on; sync.insert(this.app.s, this.kind, this.index, k); this.app.markDirty(); this.render(); this.app.views.mixer.render(); };
      const item = h('div', { class: `item${k === this.slot ? ' cur' : ''}` }, pw, h('span', {}, fx.preset && fx.preset !== FX[fx.type].name && fx.preset.length < 18 ? fx.preset : FX[fx.type].title));
      item.onclick = () => { this.slot = k; this.render(); };
      item.oncontextmenu = (e) => { e.preventDefault(); slotMenu(this.app, this.kind, this.index, k, e.clientX, e.clientY); };
      chain.append(item);
    });
    const free = t.inserts.findIndex((x) => !x);
    if (free >= 0) {
      const add = h('div', { class: 'item empty' }, '+ PLUGIN');
      add.onclick = (e) => pluginMenu(this.app, this.kind, this.index, free, e.clientX, e.clientY, (s) => { this.slot = s; this.render(); });
      chain.append(add);
    }
    chain.append(h('div', { class: 'hint', style: { marginTop: 'auto' } }, 'Signal flows top to bottom. Right-click a plugin to bypass or remove it.'));
    const panel = h('div', { class: 'fx-panel' });
    const fx = this.fx;
    if (!fx) {
      const first = t.inserts.findIndex((x) => x);
      if (first >= 0) { this.slot = first; return this.render(); }
      panel.append(h('div', { class: 'hint' }, 'This channel has no plugins yet. Click + PLUGIN to add one.'));
    } else {
      panel.append(this.head(fx));
      const ed = { 1: this.eq, 2: this.comp, 3: this.gate, 4: this.limiter, 5: this.dyneq, 6: this.delay, 7: this.reverb }[fx.type];
      ed.call(this, panel, fx);
    }
    this.el.replaceChildren(title, h('div', { class: 'fx-body' }, chain, panel));
  }

  head(fx) {
    const meta = FX[fx.type];
    const presets = PRESETS.filter((p) => p !== '-' && p.fx.length === 1 && p.fx[0][0] === fx.type);
    const ps = presets.length > 1 ? select([{ value: '', label: 'Preset…' }, ...presets.map((p, i) => ({ value: i, label: p.label }))], '', (v) => {
      if (v === '') return;
      const p = presets[Number(v)];
      fx.params = [...(p.fx[0][1] || FX[fx.type].params)];
      fx.preset = p.label;
      this.push();
      this.render();
    }) : null;
    return h('div', { class: 'fx-head' },
      h('h2', {}, meta.title.toUpperCase()),
      h('span', { class: 'sub' }, meta.sub),
      h('span', { class: 'sp' }),
      ps,
      toggle(fx.on ? 'ON' : 'BYPASSED', fx.on, (v) => { fx.on = v; this.push(); this.render(); this.app.views.mixer.render(); }),
    );
  }

  k(fx, idx, label, min, max, opts = {}) {
    return knob({
      label,
      value: fx.params[idx],
      min,
      max,
      def: FX[fx.type].params[idx],
      log: opts.log,
      fmt: opts.fmt || ((v) => v.toFixed(1)),
      size: opts.size || 'lg',
      onChange: (v) => {
        fx.params[idx] = opts.int ? Math.round(v) : v;
        this.push();
        if (this.redraw) this.redraw();
      },
    });
  }

  // ------------------------------------------------------------- EQ

  eq(panel, fx) {
    const sr = this.app.sr();
    const W = 600, Hc = 220;
    const cv = h('canvas', { class: 'fx-graph', width: W * 2, height: Hc * 2, style: { width: `${W}px`, height: `${Hc}px` } });
    const fx2x = (f) => (Math.log10(f / 20) / 3) * W;
    const x2f = (x) => 20 * 10 ** ((x / W) * 3);
    const g2y = (g) => Hc / 2 - (g / 20) * (Hc / 2 - 12);
    const y2g = (y) => ((Hc / 2 - y) / (Hc / 2 - 12)) * 20;
    const p = fx.params;
    const draw = () => {
      const ctx = cv.getContext('2d');
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.clearRect(0, 0, W, Hc);
      ctx.strokeStyle = '#2c3354';
      ctx.fillStyle = '#6f78a6';
      ctx.font = '9px sans-serif';
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const x = fx2x(f);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, Hc); ctx.stroke();
        ctx.fillText(hz(f), x + 2, Hc - 3);
      }
      for (const g of [-12, -6, 0, 6, 12]) {
        const y = g2y(g);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        ctx.fillText(`${g}`, 2, y - 2);
      }
      const filters = [];
      if (p[0] > 0.5) { filters.push(coefs(3, sr, p[1], 0.541, 0)); filters.push(coefs(3, sr, p[1], 1.307, 0)); }
      if (p[2] > 0.5) filters.push(coefs(4, sr, p[3], 0.707, 0));
      for (let b = 0; b < 4; b++) {
        const o = 4 + b * 5;
        if (p[o] > 0.5) filters.push(coefs(p[o + 1], sr, p[o + 2], p[o + 4], p[o + 3]));
      }
      ctx.beginPath();
      for (let x = 0; x <= W; x += 2) {
        const f = x2f(x);
        let g = 0;
        for (const c of filters) g += magDb(c, f, sr);
        const y = g2y(clamp(g, -24, 24));
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = fx.on ? '#e8ecff' : '#6f78a6';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineTo(W, Hc / 2); ctx.lineTo(0, Hc / 2);
      ctx.fillStyle = '#9db1ff22';
      ctx.fill();
      ctx.lineWidth = 1;
      const colors = ['#ff8a7a', '#ffc46b', '#7ee0a8', '#6fd6e8'];
      for (let b = 0; b < 4; b++) {
        const o = 4 + b * 5;
        const x = fx2x(p[o + 2]), y = [3, 4, 5].includes(p[o + 1]) ? Hc / 2 : g2y(p[o + 3]);
        ctx.fillStyle = p[o] > 0.5 ? colors[b] : '#555';
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1d2133';
        ctx.fillText(String(b + 1), x - 2.5, y + 3);
      }
    };
    this.redraw = draw;
    let dragBand = -1;
    drag(cv, {
      down: (e) => {
        const r = cv.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        dragBand = -1;
        let best = 14;
        for (let b = 0; b < 4; b++) {
          const o = 4 + b * 5;
          const d = Math.hypot(fx2x(p[o + 2]) - x, g2y(p[o + 3]) - y);
          if (d < best) { best = d; dragBand = b; }
        }
        return dragBand >= 0;
      },
      move: (dx, dy, e) => {
        const r = cv.getBoundingClientRect();
        const o = 4 + dragBand * 5;
        p[o] = 1;
        p[o + 2] = clamp(x2f(e.clientX - r.left), 20, 20000);
        if (![3, 4, 5].includes(p[o + 1])) p[o + 3] = clamp(y2g(e.clientY - r.top), -18, 18);
        this.push();
        draw();
        this.bandsEl.replaceWith((this.bandsEl = bands()));
      },
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left;
      let b = 0, best = 1e9;
      for (let k = 0; k < 4; k++) { const d = Math.abs(fx2x(p[4 + k * 5 + 2]) - x); if (d < best) { best = d; b = k; } }
      const o = 4 + b * 5;
      p[o + 4] = clamp(p[o + 4] * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.1, 18);
      this.push();
      draw();
      this.bandsEl.replaceWith((this.bandsEl = bands()));
    }, { passive: false });
    const bands = () => h('div', { class: 'fx-bands' }, ...[0, 1, 2, 3].map((b) => {
      const o = 4 + b * 5;
      return h('div', { class: `fx-band${p[o] > 0.5 ? '' : ' off'}` },
        h('div', { class: 'row', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          toggle(`BAND ${b + 1}`, p[o] > 0.5, (v) => { p[o] = v ? 1 : 0; this.push(); draw(); this.bandsEl.replaceWith((this.bandsEl = bands())); }),
          select(BAND_TYPES, p[o + 1], (v) => { p[o + 1] = Number(v); this.push(); draw(); })),
        h('div', { class: 'bk' },
          this.k(fx, o + 2, 'Freq', 20, 20000, { log: true, fmt: hz, size: 'md' }),
          this.k(fx, o + 3, 'Gain', -18, 18, { fmt: dbf, size: 'md' }),
          this.k(fx, o + 4, 'Q', 0.1, 18, { log: true, fmt: (v) => v.toFixed(2), size: 'md' })));
    }));
    this.bandsEl = bands();
    panel.append(
      h('div', { class: 'fx-row' }, cv,
        h('div', { class: 'fx-knobs', style: { flexDirection: 'column', alignItems: 'center' } },
          toggle('HPF', p[0] > 0.5, (v) => { p[0] = v ? 1 : 0; this.push(); draw(); }),
          this.k(fx, 1, 'Low cut', 20, 1000, { log: true, fmt: hz, size: 'md' }),
          toggle('LPF', p[2] > 0.5, (v) => { p[2] = v ? 1 : 0; this.push(); draw(); }),
          this.k(fx, 3, 'High cut', 1000, 20000, { log: true, fmt: hz, size: 'md' }))),
      this.bandsEl,
      h('div', { class: 'hint' }, 'Drag a numbered point to set frequency and gain · scroll over the curve to change Q.'),
    );
    draw();
  }

  // ------------------------------------------------------------- dynamics

  vu(label, max = 20) {
    const W = 300, Hc = 150;
    const cv = h('canvas', { class: 'vu', width: W * 2, height: Hc * 2, style: { width: `${W}px`, height: `${Hc}px` } });
    let needle = 0;
    cv.update = (gr) => {
      needle += (gr - needle) * 0.35;
      const ctx = cv.getContext('2d');
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.clearRect(0, 0, W, Hc);
      const cx = W / 2, cy = Hc + 40, R = 150;
      const ang = (v) => -0.8 + 1.6 * (1 - clamp(v / max, 0, 1));
      ctx.strokeStyle = '#1d2133';
      ctx.fillStyle = '#1d2133';
      ctx.font = '10px sans-serif';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, R, -Math.PI / 2 - 0.8, -Math.PI / 2 + 0.8);
      ctx.stroke();
      for (const v of [0, 1, 2, 3, 5, 7, 10, 15, 20].filter((x) => x <= max)) {
        const a = ang(v) - Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.lineTo(cx + Math.cos(a) * (R - 10), cy + Math.sin(a) * (R - 10));
        ctx.stroke();
        ctx.fillText(String(v), cx + Math.cos(a) * (R - 22) - 4, cy + Math.sin(a) * (R - 22) + 3);
      }
      ctx.fillText(label, 10, Hc - 10);
      ctx.fillText(`${needle.toFixed(1)} dB`, W - 56, Hc - 10);
      const a = ang(needle) - Math.PI / 2;
      ctx.strokeStyle = '#c0392b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * (R + 4), cy + Math.sin(a) * (R + 4));
      ctx.stroke();
    };
    cv.update(0);
    this.vuEl = cv;
    return cv;
  }

  comp(panel, fx) {
    const models = h('div', { class: 'fx-models' }, h('div', { class: 'hint' }, 'MODEL'), ...MODELS.map(([n, d], i) => {
      const b = h('button', { class: Math.round(fx.params[6]) === i ? 'on' : '' }, h('b', {}, n), h('span', {}, d));
      b.onclick = () => { fx.params[6] = i; this.push(); this.render(); };
      return b;
    }));
    panel.append(
      h('div', { class: 'fx-row' }, models, this.vu('GAIN REDUCTION')),
      h('div', { class: 'fx-knobs' },
        this.k(fx, 0, 'Threshold', -60, 0, { fmt: dbf }),
        this.k(fx, 1, 'Ratio', 1, 20, { log: true, fmt: (v) => `${v.toFixed(1)}:1` }),
        this.k(fx, 2, 'Attack', 0.1, 100, { log: true, fmt: ms }),
        this.k(fx, 3, 'Release', 10, 2000, { log: true, fmt: ms }),
        this.k(fx, 4, 'Knee', 0, 24, { fmt: (v) => `${v.toFixed(0)} dB` }),
        this.k(fx, 5, 'Makeup', -6, 24, { fmt: dbf }),
        this.k(fx, 7, 'Mix', 0, 1, { fmt: pct }),
        this.k(fx, 8, 'SC HPF', 0, 500, { fmt: (v) => (v < 20 ? 'Off' : `${Math.round(v)} Hz`) })),
    );
  }

  gate(panel, fx) {
    panel.append(
      h('div', { class: 'fx-row' }, this.vu('ATTENUATION', 60), h('div', { class: 'hint', style: { maxWidth: '300px' } }, 'The gate closes when the key signal drops below the threshold minus the hysteresis, and opens again above the threshold. Use the key filters so kick bleed does not open a tom gate, or hi-hat does not open a snare gate.')),
      h('div', { class: 'fx-knobs' },
        this.k(fx, 0, 'Threshold', -80, 0, { fmt: dbf }),
        this.k(fx, 1, 'Range', -80, 0, { fmt: dbf }),
        this.k(fx, 2, 'Attack', 0.05, 50, { log: true, fmt: ms }),
        this.k(fx, 3, 'Hold', 0, 500, { fmt: ms }),
        this.k(fx, 4, 'Release', 5, 2000, { log: true, fmt: ms }),
        this.k(fx, 7, 'Hysteresis', 0, 12, { fmt: (v) => `${v.toFixed(1)} dB` }),
        this.k(fx, 5, 'Key HPF', 0, 2000, { fmt: (v) => (v < 20 ? 'Off' : hz(v)) }),
        this.k(fx, 6, 'Key LPF', 0, 20000, { fmt: (v) => (v < 100 ? 'Off' : hz(v)) })),
    );
  }

  limiter(panel, fx) {
    panel.append(
      h('div', { class: 'fx-row' }, this.vu('LIMITING', 20)),
      h('div', { class: 'fx-knobs' },
        this.k(fx, 2, 'Input', 0, 24, { fmt: dbf, size: 'xl' }),
        this.k(fx, 0, 'Ceiling', -12, 0, { fmt: dbf, size: 'xl' }),
        this.k(fx, 1, 'Release', 1, 1000, { log: true, fmt: ms, size: 'xl' })),
    );
  }

  dyneq(panel, fx) {
    const band = (b) => {
      const o = b * 7;
      return h('div', { class: 'fx-knobs', style: { flexDirection: 'column', alignItems: 'flex-start' } },
        toggle(`BAND ${b + 1}`, fx.params[o] > 0.5, (v) => { fx.params[o] = v ? 1 : 0; this.push(); }),
        h('div', { style: { display: 'flex', gap: '14px' } },
          this.k(fx, o + 1, 'Freq', 20, 20000, { log: true, fmt: hz, size: 'md' }),
          this.k(fx, o + 2, 'Q', 0.2, 10, { log: true, fmt: (v) => v.toFixed(2), size: 'md' }),
          this.k(fx, o + 3, 'Threshold', -60, 0, { fmt: dbf, size: 'md' }),
          this.k(fx, o + 4, 'Range', -18, 18, { fmt: dbf, size: 'md' }),
          this.k(fx, o + 5, 'Attack', 0.5, 100, { log: true, fmt: ms, size: 'md' }),
          this.k(fx, o + 6, 'Release', 10, 1000, { log: true, fmt: ms, size: 'md' })));
    };
    panel.append(
      h('div', { class: 'fx-row' }, this.vu('BAND ACTIVITY', 18), h('div', { class: 'hint', style: { maxWidth: '320px' } }, 'Each band only acts when its frequency range goes above the threshold. Negative range cuts (de-ess, tame boom); positive range boosts.')),
      band(0), band(1),
    );
  }

  delay(panel, fx) {
    panel.append(h('div', { class: 'fx-knobs' },
      this.k(fx, 0, 'Time', 1, 2000, { log: true, fmt: ms, size: 'xl' }),
      this.k(fx, 1, 'Feedback', 0, 0.95, { fmt: pct, size: 'xl' }),
      this.k(fx, 2, 'Mix', 0, 1, { fmt: pct, size: 'xl' }),
      this.k(fx, 3, 'Hi cut', 500, 20000, { log: true, fmt: hz, size: 'xl' }),
      toggle('PING-PONG', fx.params[4] > 0.5, (v) => { fx.params[4] = v ? 1 : 0; this.push(); })));
    panel.append(h('div', { class: 'hint' }, 'Tip: put delays and reverbs on an AUX bus and use sends, so several channels share one effect.'));
  }

  reverb(panel, fx) {
    panel.append(h('div', { class: 'fx-knobs' },
      this.k(fx, 0, 'Size', 0, 1, { fmt: pct, size: 'xl' }),
      this.k(fx, 1, 'Damping', 0, 1, { fmt: pct, size: 'xl' }),
      this.k(fx, 2, 'Mix', 0, 1, { fmt: pct, size: 'xl' }),
      this.k(fx, 3, 'Width', 0, 1, { fmt: pct, size: 'xl' })));
    panel.append(h('div', { class: 'hint' }, 'On an AUX bus set Mix to 100% and control the amount with each channel’s send.'));
  }

  tick() {
    if (!this.vuEl || !this.vuEl.isConnected || !this.app.meters) return;
    const nt = this.app.s.tracks.length;
    const gr = this.kind === 'bus' ? this.app.meters[nt * 3 + this.index * 3 + 2] : this.app.meters[this.index * 3 + 2];
    this.vuEl.update(gr || 0);
  }
}

export { MAX_FX };
