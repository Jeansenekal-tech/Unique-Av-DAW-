// MIXER view: a channel strip per track, then group/aux buses, the broadcast
// bus and the master.
import { h, select, knob, fader, meter, fmtDb, contextMenu, toast } from './ui.js';
import { FX, PRESETS, MAX_FX, MASTER, BROADCAST, sync } from './state.js';

export function addPreset(app, kind, i, slot, preset) {
  const target = kind === 'bus' ? app.s.buses[i] : app.s.tracks[i];
  const free = [];
  for (let k = slot; k < MAX_FX && free.length < preset.fx.length; k++) if (!target.inserts[k] || k === slot) free.push(k);
  for (let k = 0; k < MAX_FX && free.length < preset.fx.length; k++) if (!target.inserts[k] && !free.includes(k)) free.push(k);
  if (free.length < preset.fx.length) return toast('Not enough free insert slots', 'error');
  app.undoPoint('Add plugin');
  preset.fx.forEach(([type, params], n) => {
    target.inserts[free[n]] = { type, on: true, params: [...(params || FX[type].params)], preset: preset.label };
    sync.insert(app.s, kind, i, free[n]);
  });
  app.markDirty();
  app.views.mixer.render();
  app.views.broadcast.render();
  return free[0];
}

export function pluginMenu(app, kind, i, slot, x, y, after) {
  contextMenu(x, y, PRESETS.map((p) => (p === '-' ? '-' : {
    label: p.label,
    onClick: () => {
      const s = addPreset(app, kind, i, slot, p);
      if (s !== undefined && after) after(s);
    },
  })));
}

export function slotMenu(app, kind, i, slot, x, y) {
  const target = kind === 'bus' ? app.s.buses[i] : app.s.tracks[i];
  const fx = target.inserts[slot];
  contextMenu(x, y, [
    { label: 'Open…', onClick: () => app.openFx(kind, i, slot) },
    { label: fx.on ? 'Bypass' : 'Enable', onClick: () => { fx.on = !fx.on; sync.insert(app.s, kind, i, slot); app.markDirty(); app.views.mixer.render(); app.views.broadcast.render(); } },
    { label: 'Remove', onClick: () => { app.undoPoint('Remove plugin'); target.inserts[slot] = null; sync.insert(app.s, kind, i, slot); app.markDirty(); app.views.mixer.render(); app.views.broadcast.render(); if (app.fx) app.fx.render(); } },
  ]);
}

export function insertSlots(app, kind, i, target) {
  return target.inserts.map((fx, slot) => {
    const el = h('div', { class: `slot${fx ? ' fx' : ''}${fx && !fx.on ? ' off' : ''}`, title: fx ? `${FX[fx.type].title}${fx.preset && fx.preset !== FX[fx.type].name ? ` – ${fx.preset}` : ''}` : 'Add a plugin' }, fx ? (fx.preset && fx.preset.length < 14 ? fx.preset : FX[fx.type].name) : '—');
    el.addEventListener('click', (e) => {
      if (fx) app.openFx(kind, i, slot);
      else pluginMenu(app, kind, i, slot, e.clientX, e.clientY, (s) => app.openFx(kind, i, s));
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (fx) slotMenu(app, kind, i, slot, e.clientX, e.clientY);
    });
    return el;
  });
}

export class MixerView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.strips = [];
    this.busStrips = [];
  }

  sendBuses() {
    const s = this.app.s;
    return s.buses.map((b, i) => ({ b, i })).filter(({ b, i }) => b.kind === 'aux' || (i === BROADCAST && !s.broadcast.followMaster));
  }

  render() {
    const app = this.app, s = app.s;
    if (!s) return;
    const bar = h('div', { class: 'mx-bar' },
      h('span', { class: 'lbl' }, 'MIXER'),
      h('button', { onclick: () => app.addBus('group') }, '+ GROUP'),
      h('button', { onclick: () => app.addBus('aux') }, '+ AUX'),
      h('span', { class: 'lbl', style: { marginLeft: '12px' } }, `${s.tracks.length} CHANNELS`),
      h('span', { class: 'hint', style: { marginLeft: 'auto' } }, 'Click an insert slot to add EQ, compressor, gate, dynamic EQ, limiter, delay or reverb · right-click a send for pre/post · double-click resets'),
    );
    const strips = h('div', { class: 'mx-strips' });
    this.strips = s.tracks.map((t, i) => this.trackStrip(t, i));
    strips.append(...this.strips);
    const groups = s.buses.map((b, i) => ({ b, i })).filter(({ b }) => b.kind === 'group' || b.kind === 'aux');
    this.busStrips = [];
    if (groups.length) {
      strips.append(h('div', { class: 'mx-sep' }));
      for (const { b, i } of groups) strips.append(this.busStrip(b, i));
    }
    const fixed = h('div', { class: 'mx-fixed' }, this.busStrip(s.buses[BROADCAST], BROADCAST), this.busStrip(s.buses[MASTER], MASTER));
    this.root.replaceChildren(bar, h('div', { class: 'mx-wrap' }, strips, fixed));
  }

  trackStrip(t, i) {
    const app = this.app, s = app.s;
    const set = (patch) => {
      Object.assign(t, patch);
      app.markDirty();
      app.syncTrack(i);
    };
    const btn = (cls, label, key, title) => {
      const b = h('button', { class: `${cls}${t[key] ? ' on' : ''}`, title }, label);
      b.onclick = () => {
        set({ [key]: !t[key] });
        b.classList.toggle('on', t[key]);
        if (key === 'solo') app.syncGlobal();
        app.views.live.render();
      };
      return b;
    };
    const dests = [{ value: MASTER, label: '→ Master' }, ...s.buses.map((b, k) => ({ b, k })).filter(({ b }) => b.kind === 'group').map(({ b, k }) => ({ value: k, label: `→ ${b.name}` })), { value: -1, label: '→ None' }];
    const sends = this.sendBuses().map(({ b, i: bi }) => {
      let snd = t.sends.find((x) => x.bus === bi);
      const val = snd ? snd.level : -Infinity;
      const r = h('input', { type: 'range', min: -60, max: 6, step: 0.5, value: Number.isFinite(val) ? val : -60 });
      const lab = h('span', { style: { width: '34px', overflow: 'hidden', whiteSpace: 'nowrap' } }, `${snd && snd.pre ? '◦' : ''}${b.name}`);
      r.title = `${b.name} send (${snd && snd.pre ? 'pre' : 'post'}-fader). Right-click for pre/post.`;
      r.addEventListener('input', () => {
        const lv = Number(r.value) <= -60 ? -Infinity : Number(r.value);
        snd = t.sends.find((x) => x.bus === bi);
        if (!snd) t.sends.push((snd = { bus: bi, level: lv, pre: b.kind === 'aux' && false }));
        snd.level = lv;
        app.markDirty();
        app.syncTrack(i);
      });
      r.addEventListener('dblclick', () => { r.value = 0; r.dispatchEvent(new Event('input')); });
      r.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        snd = t.sends.find((x) => x.bus === bi) || (t.sends.push({ bus: bi, level: -Infinity, pre: false }), t.sends[t.sends.length - 1]);
        snd.pre = !snd.pre;
        app.markDirty();
        app.syncTrack(i);
        lab.textContent = `${snd.pre ? '◦' : ''}${b.name}`;
      });
      return h('div', { class: 'send' }, lab, r);
    });
    const m = meter({ channels: 1, height: 230, width: 7 });
    const dbl = h('div', { class: 'db' }, fmtDb(t.fader));
    const f = fader({ value: t.fader, height: 230, onChange: (v) => { set({ fader: v }); dbl.textContent = fmtDb(v); } });
    const gr = h('div', { class: 'gr' });
    const el = h('div', { class: `strip${app.sel.track === i ? ' sel' : ''}` },
      h('div', { class: 's-name', style: { borderTopColor: t.color }, title: t.name, ondblclick: () => { const n = prompt('Track name', t.name); if (n) { t.name = n; app.markDirty(); app.renderAll(); } } }, t.name),
      select(app.inputOptions(), t.input, (v) => { set({ input: Number(v) }); app.views.live.render(); }),
      h('div', { class: 'knobs' },
        knob({ label: 'Gain', value: t.trim, min: -24, max: 24, def: 0, size: 'sm', fmt: (v) => v.toFixed(1), onChange: (v) => set({ trim: v }) }),
        knob({ label: 'Pan', value: t.pan, min: -1, max: 1, def: 0, size: 'sm', fmt: (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`), onChange: (v) => set({ pan: v }) })),
      h('div', { class: 'row' }, btn('m', 'M', 'mute', 'Mute'), btn('s', 'S', 'solo', 'Solo'), btn('p', 'Ø', 'phase', 'Polarity invert')),
      h('div', { class: 'sect' }, 'INSERTS'),
      ...insertSlots(app, 'track', i, t),
      sends.length ? h('div', { class: 'sect' }, 'SENDS') : null,
      sends.length ? h('div', { class: 'sends' }, ...sends) : null,
      select(dests, t.dest, (v) => set({ dest: Number(v) })),
      h('div', { class: 'fz' }, f, m),
      dbl,
      gr,
    );
    el.meter = m;
    el.gr = gr;
    el.addEventListener('pointerdown', () => { app.sel.track = i; });
    return el;
  }

  busStrip(B, b) {
    const app = this.app, s = app.s;
    const set = (patch) => {
      Object.assign(B, patch);
      app.markDirty();
      app.syncBus(b);
    };
    const kindCls = b === MASTER ? 'master' : b === BROADCAST ? 'bcast' : 'bus';
    const m = meter({ channels: 2, height: 230, width: 6 });
    const dbl = h('div', { class: 'db' }, fmtDb(B.fader));
    const f = fader({ value: B.fader, height: 230, onChange: (v) => { set({ fader: v }); dbl.textContent = fmtDb(v); } });
    const gr = h('div', { class: 'gr' });
    const muteB = h('button', { class: `m${B.mute ? ' on' : ''}` }, 'M');
    muteB.onclick = () => { set({ mute: !B.mute }); muteB.classList.toggle('on', B.mute); };
    const outSel = select(app.outputOptions(true, b === MASTER ? 'No output' : 'No direct out'), B.hwOut, (v) => set({ hwOut: Number(v) }));
    outSel.title = b === MASTER ? 'Master output (monitors / PA)' : 'Hardware output pair for this bus';
    const label = b === BROADCAST ? (s.broadcast.followMaster ? 'Follows master' : 'Own mix (sends)') : B.kind === 'group' ? 'Group → Master' : B.kind === 'aux' ? 'Aux → Master' : 'Main mix';
    const el = h('div', { class: `strip ${kindCls}` },
      h('div', { class: 's-name', style: { borderTopColor: B.color }, ondblclick: () => { if (b <= 1) return; const n = prompt('Bus name', B.name); if (n) { B.name = n; app.markDirty(); this.render(); } } }, B.name),
      h('div', { class: 'hint', style: { textAlign: 'center', fontSize: '9px' } }, label),
      h('div', { class: 'knobs' }, knob({ label: 'Bal', value: B.pan, min: -1, max: 1, def: 0, size: 'sm', fmt: (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`), onChange: (v) => set({ pan: v }) })),
      h('div', { class: 'row' }, muteB, b > 1 ? h('button', { title: 'Delete bus', onclick: () => app.removeBus(b) }, '✕') : null),
      h('div', { class: 'sect' }, 'INSERTS'),
      ...insertSlots(app, 'bus', b, B),
      h('div', { class: 'sect' }, 'OUTPUT'),
      outSel,
      h('div', { class: 'fz' }, f, m),
      dbl,
      gr,
    );
    el.meter = m;
    el.gr = gr;
    el.busIndex = b;
    this.busStrips.push(el);
    return el;
  }

  tick(meters) {
    const nt = this.app.s.tracks.length;
    for (let i = 0; i < this.strips.length; i++) {
      const el = this.strips[i];
      el.meter.update(meters[i * 3 + 1] || 0);
      const g = meters[i * 3 + 2] || 0;
      el.gr.textContent = g > 0.5 ? `GR ${g.toFixed(1)}` : '';
    }
    for (const el of this.busStrips) {
      const o = nt * 3 + el.busIndex * 3;
      el.meter.update(meters[o] || 0, meters[o + 1] || 0);
      const g = meters[o + 2] || 0;
      el.gr.textContent = g > 0.5 ? `GR ${g.toFixed(1)}` : '';
    }
  }
}
