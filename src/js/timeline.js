// LIVE view: track list with input/output routing and arm buttons, and the
// multitrack timeline with waveforms, playhead, loop and clip editing.
import { h, select, contextMenu, clamp, toast } from './ui.js';
import { COLORS, PEAK_SPP, fmtTime, sessionEnd, newId } from './state.js';
import * as dialogs from './dialogs.js';

const HEAD_W = 300;
const EDGE = 6;

export class LiveView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.lanesDirty = true;
    this.overlayDirty = true;
    this.lastPos = -1;
    this.drag = null;
    this.build();
  }

  get s() {
    return this.app.s;
  }

  get H() {
    return this.s ? this.s.view.trackHeight || 46 : 46;
  }

  build() {
    this.ruler = h('canvas');
    this.heads = h('div', { class: 'tl-heads' });
    this.lanesCanvas = h('canvas');
    this.overlay = h('canvas', { class: 'tl-overlay' });
    this.sticky = h('div', { style: { position: 'sticky', top: '0', zIndex: 1 } }, this.lanesCanvas, this.overlay);
    this.spacer = h('div');
    this.lanes = h('div', { class: 'tl-lanes' }, this.sticky, this.spacer);
    this.body = h('div', { class: 'tl-body' }, h('div', { class: 'tl-inner' }, this.heads, this.lanes));
    this.hscroll = h('input', { type: 'range', min: 0, max: 1000, value: 0 });
    this.empty = h('div', { class: 'tl-empty' }, 'No tracks yet – use QUICK SETUP to create one track per input, or import audio.');
    this.root.append(
      h('div', { class: 'tl-top' },
        h('div', { class: 'tl-corner' },
          h('span', { class: 'lbl' }, 'TRACKS'),
          h('button', { onclick: () => this.app.addTracks([{}]), title: 'Add a track' }, '+ TRACK'),
          h('button', { onclick: () => dialogs.quickSetup(this.app), title: 'Create one track per input' }, 'QUICK SETUP'),
          h('button', { onclick: () => this.zoom(-1), title: 'Zoom out' }, '−'),
          h('button', { onclick: () => this.zoom(1), title: 'Zoom in' }, '+')),
        h('div', { class: 'tl-ruler' }, this.ruler)),
      this.body,
      h('div', { class: 'tl-hscroll' }, this.hscroll),
      this.empty,
    );
    this.body.addEventListener('scroll', () => { this.lanesDirty = true; this.overlayDirty = true; });
    new ResizeObserver(() => { this.lanesDirty = true; this.overlayDirty = true; this.drawRuler(); }).observe(this.body);
    this.hscroll.addEventListener('input', () => {
      const max = this.maxSample();
      this.s.view.x0 = (this.hscroll.value / 1000) * max;
      this.invalidate();
    });
    this.lanes.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.ruler.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.lanes.addEventListener('pointerdown', (e) => this.onDown(e));
    this.lanes.addEventListener('pointermove', (e) => this.onMove(e));
    this.lanes.addEventListener('pointerup', (e) => this.onUp(e));
    this.lanes.addEventListener('contextmenu', (e) => this.onContext(e));
    this.ruler.addEventListener('pointerdown', (e) => this.onRulerDown(e));
  }

  // ------------------------------------------------------------- geometry

  maxSample() {
    const sr = this.app.sr();
    return Math.max(sessionEnd(this.s), this.app.st.pos || 0, sr * 600);
  }

  xToSample(x) {
    return this.s.view.x0 + x * this.s.view.spp;
  }

  sampleToX(p) {
    return (p - this.s.view.x0) / this.s.view.spp;
  }

  zoom(dir, anchorX) {
    if (!this.s) return;
    const v = this.s.view;
    const w = this.lanesCanvas.clientWidth || 800;
    const ax = anchorX ?? (this.app.st.pos >= v.x0 && this.sampleToX(this.app.st.pos) < w ? this.sampleToX(this.app.st.pos) : w / 2);
    const at = this.xToSample(ax);
    v.spp = clamp(v.spp * (dir > 0 ? 0.7 : 1 / 0.7), 8, this.app.sr() * 60);
    v.x0 = Math.max(0, at - ax * v.spp);
    this.invalidate();
  }

  invalidate() {
    this.lanesDirty = true;
    this.overlayDirty = true;
    this.drawRuler();
    if (this.s) this.hscroll.value = String(Math.round((this.s.view.x0 / this.maxSample()) * 1000));
  }

  dirtyLanes() {
    this.lanesDirty = true;
  }

  dirtyOverlay() {
    this.overlayDirty = true;
  }

  // ------------------------------------------------------------- render

  render() {
    const s = this.s;
    if (!s) return;
    this.empty.classList.toggle('hidden', s.tracks.length > 0);
    this.heads.replaceChildren(...s.tracks.map((t, i) => this.header(t, i)));
    this.spacer.style.height = `${s.tracks.length * this.H + 120}px`;
    this.invalidate();
  }

  header(t, i) {
    const app = this.app;
    const set = (patch, sync = true) => {
      Object.assign(t, patch);
      app.markDirty();
      if (sync) app.syncTrack(i);
    };
    const name = h('input', { class: 'name', value: t.name, spellcheck: 'false' });
    name.addEventListener('change', () => { set({ name: name.value || `Track ${i + 1}` }, false); this.lanesDirty = true; app.views.mixer.render(); });
    const ins = select(app.inputOptions(), t.input, (v) => set({ input: Number(v) }));
    ins.title = 'Input';
    const outs = select(app.outputOptions(false), t.hwOut, (v) => set({ hwOut: Number(v) }));
    outs.title = 'Virtual soundcheck output (where this track plays back to)';
    const btn = (cls, label, key, title) => {
      const b = h('button', { class: `${cls}${t[key] ? ' on' : ''}`, title }, label);
      b.onclick = () => {
        if (key === 'armed' && app.rec) return toast('Arm tracks before you start recording', 'error');
        set({ [key]: !t[key] });
        b.classList.toggle('on', t[key]);
        if (key === 'solo') app.syncGlobal();
        if (key === 'armed') app.renderHeader();
      };
      return b;
    };
    const meterC = h('canvas', { class: 'hm', width: 8, height: 38 });
    const el = h('div', { class: `th${app.sel.track === i ? ' sel' : ''}`, style: { height: `${this.H}px` } },
      h('div', { class: 'num', style: { borderLeftColor: t.color } }, String(i + 1)),
      name,
      h('div', { class: 'btns' }, btn('m', 'M', 'mute', 'Mute'), btn('s', 'S', 'solo', 'Solo'), btn('r', '●', 'armed', 'Record arm'), meterC),
      h('div', { class: 'io' }, ins, h('span', {}, 'OUT'), outs),
    );
    el.meter = meterC;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      app.sel.track = app.sel.track === i ? -1 : i;
      for (const [k, c] of [...this.heads.children].entries()) c.classList.toggle('sel', k === app.sel.track);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Insert Track Below', onClick: async () => { await app.addTracks([{}]); this.moveTrack(app.s.tracks.length - 1, i + 1); } },
        { label: 'Duplicate Track (settings)', onClick: async () => { await app.addTracks([{ ...JSON.parse(JSON.stringify(t)), id: newId('t'), name: `${t.name} copy`, clips: [], armed: false }]); this.moveTrack(app.s.tracks.length - 1, i + 1); } },
        { label: 'Move Up', disabled: i === 0, onClick: () => this.moveTrack(i, i - 1) },
        { label: 'Move Down', disabled: i === app.s.tracks.length - 1, onClick: () => this.moveTrack(i, i + 1) },
        '-',
        ...COLORS.map((c, k) => ({ label: `Colour ${k + 1}`, onClick: () => { set({ color: c }, false); this.render(); app.views.mixer.render(); } })).slice(0, 4),
        { label: 'Edit Plugins…', onClick: () => app.openFx('track', i, 0) },
        '-',
        { label: 'Delete Track', onClick: () => app.removeTrack(i) },
      ]);
    });
    return el;
  }

  async moveTrack(from, to) {
    const s = this.s;
    if (to < 0 || to >= s.tracks.length) return;
    this.app.undoPoint('Move track');
    const [t] = s.tracks.splice(from, 1);
    s.tracks.splice(to, 0, t);
    await this.app.resyncStructure();
  }

  tick(meters, st) {
    if (!this.s) return;
    const nt = this.s.tracks.length;
    const top = this.body.scrollTop, hgt = this.body.clientHeight;
    const first = Math.floor(top / this.H), last = Math.min(nt - 1, Math.ceil((top + hgt) / this.H));
    for (let i = first; i <= last; i++) {
      const el = this.heads.children[i];
      if (!el || !el.meter) continue;
      const c = el.meter.getContext('2d');
      const v = meters[i * 3] || 0;
      const db = 20 * Math.log10(v + 1e-9);
      const p = clamp((db + 60) / 60, 0, 1);
      c.fillStyle = '#151827';
      c.fillRect(0, 0, 8, 38);
      c.fillStyle = v >= 1 ? '#ff4f5e' : db > -6 ? '#ffd166' : '#3ddc97';
      c.fillRect(0, 38 * (1 - p), 8, 38 * p);
    }
    if (st.pos !== this.lastPos) {
      this.lastPos = st.pos;
      this.overlayDirty = true;
      // Page the view to follow the playhead.
      const w = this.lanesCanvas.clientWidth;
      const x = this.sampleToX(st.pos);
      if (st.playing && w > 0 && (x > w - 20 || x < 0) && !this.drag) {
        this.s.view.x0 = Math.max(0, st.pos - 20 * this.s.view.spp);
        this.invalidate();
      }
    }
    if (this.app.rec) this.lanesDirty = true;
    if (this.lanesDirty) this.drawLanes();
    if (this.overlayDirty) this.drawOverlay();
  }

  sizeCanvas(c, w, hgt) {
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${hgt}px`;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  drawRuler() {
    if (!this.s) return;
    const w = this.ruler.parentElement.clientWidth, hgt = 30;
    const ctx = this.sizeCanvas(this.ruler, w, hgt);
    const sr = this.app.sr(), v = this.s.view;
    ctx.fillStyle = '#23283d';
    ctx.fillRect(0, 0, w, hgt);
    const L = this.s.loop;
    if (L.end > L.start) {
      const a = this.sampleToX(L.start), b = this.sampleToX(L.end);
      ctx.fillStyle = L.on ? '#9db1ffaa' : '#9db1ff44';
      ctx.fillRect(a, 0, b - a, 6);
    }
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find((st) => (st * sr) / v.spp >= 70) || 3600;
    const t0 = Math.floor(v.x0 / sr / step) * step;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textBaseline = 'top';
    for (let t = t0; ; t += step) {
      const x = this.sampleToX(t * sr);
      if (x > w) break;
      if (x < -50) continue;
      ctx.fillStyle = '#4a538a';
      ctx.fillRect(Math.round(x), 14, 1, 16);
      for (let k = 1; k < 4; k++) ctx.fillRect(Math.round(x + (k * step * sr) / v.spp / 4), 24, 1, 6);
      ctx.fillStyle = '#9aa3cc';
      const mm = Math.floor(t / 60), ss = t % 60;
      ctx.fillText(step < 1 ? `${mm}:${ss.toFixed(2).padStart(5, '0')}` : `${mm}:${String(Math.floor(ss)).padStart(2, '0')}`, x + 3, 12);
    }
    for (const m of this.s.markers) {
      const x = this.sampleToX(m.pos);
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(x, 0, 2, hgt);
      ctx.fillText(m.name, x + 4, 1);
    }
  }

  drawLanes() {
    this.lanesDirty = false;
    const s = this.s;
    const w = this.lanes.clientWidth, hgt = this.body.clientHeight;
    if (!w || !hgt) return;
    this.sticky.style.height = `${hgt}px`;
    this.sticky.style.marginBottom = `-${hgt}px`;
    const ctx = this.sizeCanvas(this.lanesCanvas, w, hgt);
    this.sizeCanvas(this.overlay, w, hgt);
    this.overlay.style.left = '0';
    this.overlay.style.top = '0';
    const H = this.H, top = this.body.scrollTop;
    ctx.fillStyle = '#2a3050';
    ctx.fillRect(0, 0, w, hgt);
    const first = Math.floor(top / H), last = Math.min(s.tracks.length - 1, Math.ceil((top + hgt) / H));
    const sr = this.app.sr();
    const v = s.view;
    for (let i = first; i <= last; i++) {
      const t = s.tracks[i];
      if (!t) continue;
      const y = i * H - top;
      ctx.fillStyle = i % 2 ? '#515d8f' : '#56639a';
      ctx.fillRect(0, y + 1, w, H - 2);
      for (const c of t.clips) this.drawClip(ctx, c, i, y, w, H, false);
      if (this.app.rec && this.app.rec.tracks.includes(i)) {
        const st = this.app.st;
        const start = st.recStart || st.pos;
        this.drawClip(ctx, { start, length: Math.max(0, st.pos - start), offset: 0, live: this.app.rec.peaks.get(i), name: `● ${t.name} – take ${this.app.rec.take}` }, i, y, w, H, true);
      }
    }
    // Grid lines every second-ish step for orientation.
    ctx.fillStyle = '#ffffff10';
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((st) => (st * sr) / v.spp >= 70) || 600;
    for (let tt = Math.floor(v.x0 / sr / step) * step; ; tt += step) {
      const x = this.sampleToX(tt * sr);
      if (x > w) break;
      ctx.fillRect(Math.round(x), 0, 1, hgt);
    }
  }

  drawClip(ctx, c, ti, y, w, H, live) {
    const x0 = this.sampleToX(c.start), x1 = this.sampleToX(c.start + c.length);
    if (x1 < 0 || x0 > w) return;
    const sel = this.app.sel.clip && this.app.sel.clip.id === c.id;
    const cx = Math.max(x0, -2), cw = Math.min(x1, w + 2) - cx;
    ctx.fillStyle = live ? '#c06478' : sel ? '#aeb9ee' : c.muted ? '#646d94' : '#8693d0';
    ctx.beginPath();
    ctx.roundRect(cx, y + 3, Math.max(cw, 1), H - 6, 3);
    ctx.fill();
    if (sel) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    const peaks = live ? c.live : this.app.getPeaks(c);
    const mid = y + H / 2 + 4, amp = (H - 18) / 2;
    if (peaks && peaks.length) {
      ctx.fillStyle = '#f5f7ff';
      const spp = this.s.view.spp;
      const xa = Math.max(0, Math.floor(x0)), xb = Math.min(w, Math.ceil(x1));
      for (let x = xa; x < xb; x++) {
        const f0 = c.offset + (this.xToSample(x) - c.start), f1 = f0 + spp;
        let p0 = Math.floor(f0 / PEAK_SPP), p1 = Math.max(p0 + 1, Math.ceil(f1 / PEAK_SPP));
        p0 = Math.max(0, p0);
        p1 = Math.min(peaks.length / 2, p1);
        let lo = 0, hi = 0;
        for (let p = p0; p < p1; p++) {
          if (peaks[p * 2] < lo) lo = peaks[p * 2];
          if (peaks[p * 2 + 1] > hi) hi = peaks[p * 2 + 1];
        }
        const g = c.gain ? 10 ** (c.gain / 20) : 1;
        const a = Math.max(0.5, ((hi - lo) / 254) * amp * g);
        ctx.fillRect(x, mid - (hi / 127) * amp * g, 1, Math.max(1, a));
      }
    } else if (!live) {
      ctx.fillStyle = '#ffffff55';
      ctx.fillRect(Math.max(x0, 0), mid, Math.min(x1, w) - Math.max(x0, 0), 1);
    }
    if (x1 - x0 > 40) {
      ctx.fillStyle = live ? '#fff' : '#1d2133cc';
      ctx.font = '600 9.5px -apple-system, sans-serif';
      ctx.textBaseline = 'top';
      const label = c.name || `${(c.file || '').replace(/\.wav$/i, '')}${c.muted ? ' (muted)' : ''}`;
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx, y, cw, H);
      ctx.clip();
      ctx.fillText(label, Math.max(x0, 0) + 5, y + 5);
      ctx.restore();
    }
  }

  drawOverlay() {
    this.overlayDirty = false;
    const w = this.lanes.clientWidth, hgt = this.body.clientHeight;
    const ctx = this.sizeCanvas(this.overlay, w, hgt);
    ctx.clearRect(0, 0, w, hgt);
    const L = this.s.loop;
    if (L.on && L.end > L.start) {
      const a = this.sampleToX(L.start), b = this.sampleToX(L.end);
      ctx.fillStyle = '#9db1ff18';
      ctx.fillRect(a, 0, b - a, hgt);
    }
    const x = Math.round(this.sampleToX(this.app.st.pos)) + 0.5;
    if (x >= 0 && x <= w) {
      ctx.strokeStyle = this.app.rec ? '#ff4f5e' : '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, hgt);
      ctx.stroke();
    }
    this.drawRulerHead();
  }

  drawRulerHead() {
    this.drawRuler();
    const ctx = this.ruler.getContext('2d');
    const x = this.sampleToX(this.app.st.pos);
    ctx.fillStyle = this.app.rec ? '#ff4f5e' : '#ffffff';
    ctx.beginPath();
    ctx.moveTo(x - 5, 18);
    ctx.lineTo(x + 5, 18);
    ctx.lineTo(x, 28);
    ctx.fill();
  }

  // ------------------------------------------------------------- interaction

  hit(e) {
    const r = this.lanes.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top + this.body.scrollTop - this.body.scrollTop;
    const row = Math.floor((e.clientY - this.body.getBoundingClientRect().top + this.body.scrollTop) / this.H);
    const t = this.s.tracks[row];
    const sample = this.xToSample(x);
    let clip = null, edge = null;
    if (t) {
      for (let k = t.clips.length - 1; k >= 0; k--) {
        const c = t.clips[k];
        const a = this.sampleToX(c.start), b = this.sampleToX(c.start + c.length);
        if (x >= a - 2 && x <= b + 2) {
          clip = c;
          if (x - a < EDGE) edge = 'l';
          else if (b - x < EDGE) edge = 'r';
          break;
        }
      }
    }
    return { x, y, row, t, sample, clip, edge };
  }

  onDown(e) {
    if (!this.s || e.button !== 0) return;
    const hit = this.hit(e);
    if (hit.clip) {
      this.app.sel.clip = { ...hit.clip, track: hit.row, id: hit.clip.id };
      this.app.sel.track = hit.row;
      if (this.app.rec) return this.lanesDirty = true;
      this.app.undoPoint(hit.edge ? 'Trim clip' : 'Move clip');
      this.drag = { hit, x0: e.clientX, orig: { ...hit.clip }, row: hit.row };
      this.lanes.setPointerCapture(e.pointerId);
    } else {
      this.app.sel.clip = null;
      this.app.locate(hit.sample);
    }
    this.lanesDirty = true;
  }

  onMove(e) {
    if (!this.s) return;
    if (!this.drag) {
      const hit = this.hit(e);
      this.lanes.style.cursor = hit.edge ? 'ew-resize' : hit.clip ? 'grab' : 'text';
      return;
    }
    const { hit, orig } = this.drag;
    const ds = Math.round((e.clientX - this.drag.x0) * this.s.view.spp);
    const c = hit.clip;
    if (hit.edge === 'l') {
      const d = clamp(ds, -orig.offset, orig.length - 64);
      c.start = orig.start + d;
      c.offset = orig.offset + d;
      c.length = orig.length - d;
    } else if (hit.edge === 'r') {
      c.length = Math.max(64, orig.length + ds);
    } else {
      c.start = Math.max(0, orig.start + ds);
    }
    this.drag.moved = true;
    this.lanesDirty = true;
  }

  async onUp() {
    if (!this.drag) return;
    const { row, moved } = this.drag;
    this.drag = null;
    if (moved) {
      this.app.markDirty();
      await this.app.syncClips(row);
      await this.app.locate(this.app.st.pos);
    } else {
      this.app.hist.undo.pop();
    }
  }

  onContext(e) {
    e.preventDefault();
    const hit = this.hit(e);
    if (!hit.clip) return;
    const app = this.app;
    const t = hit.t, c = hit.clip;
    const apply = async (label, fn) => {
      app.undoPoint(label);
      fn();
      app.markDirty();
      await app.syncClips(hit.row);
      this.lanesDirty = true;
    };
    contextMenu(e.clientX, e.clientY, [
      { label: `Clip: ${c.file}`, disabled: true, onClick() {} },
      { label: c.muted ? 'Unmute Clip' : 'Mute Clip', onClick: () => apply('Mute clip', () => { c.muted = !c.muted; }) },
      { label: 'Clip Gain +3 dB', onClick: () => apply('Clip gain', () => { c.gain = (c.gain || 0) + 3; }) },
      { label: 'Clip Gain −3 dB', onClick: () => apply('Clip gain', () => { c.gain = (c.gain || 0) - 3; }) },
      { label: 'Reset Clip Gain', onClick: () => apply('Clip gain', () => { c.gain = 0; }) },
      { label: 'Split at Playhead', onClick: () => app.splitAtPlayhead() },
      { label: 'Set Loop to Clip', onClick: async () => { app.s.loop = { on: true, start: c.start, end: c.start + c.length }; await app.syncGlobal(); app.renderHeader(); this.invalidate(); } },
      '-',
      { label: 'Delete Clip', onClick: () => apply('Delete clip', () => { t.clips = t.clips.filter((x) => x.id !== c.id); }) },
    ]);
  }

  onRulerDown(e) {
    if (!this.s) return;
    const r = this.ruler.getBoundingClientRect();
    const x = e.clientX - r.left;
    const start = this.xToSample(x);
    if (!e.shiftKey) {
      this.app.locate(start);
      return;
    }
    // Shift-drag on the ruler sets the loop range.
    this.ruler.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const b = this.xToSample(ev.clientX - r.left);
      this.s.loop.start = Math.max(0, Math.min(start, b));
      this.s.loop.end = Math.max(start, b);
      this.invalidate();
    };
    const up = async () => {
      this.ruler.removeEventListener('pointermove', move);
      this.ruler.removeEventListener('pointerup', up);
      if (this.s.loop.end - this.s.loop.start > this.app.sr() * 0.1) this.s.loop.on = true;
      await this.app.syncGlobal();
      this.app.markDirty();
      this.app.renderHeader();
      this.invalidate();
    };
    this.ruler.addEventListener('pointermove', move);
    this.ruler.addEventListener('pointerup', up);
  }

  onWheel(e) {
    if (!this.s) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const r = this.lanes.getBoundingClientRect();
      this.zoom(e.deltaY < 0 ? 1 : -1, e.clientX - r.left);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const d = (e.shiftKey ? e.deltaY : e.deltaX) * this.s.view.spp;
      this.s.view.x0 = Math.max(0, this.s.view.x0 + d);
      this.invalidate();
    }
  }
}

export { fmtTime };
