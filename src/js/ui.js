// Small DOM helpers and the knob / fader / meter widgets used everywhere.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function select(options, value, onChange, cls = '') {
  const el = h('select', { class: cls });
  for (const o of options) {
    const opt = h('option', { value: String(o.value) }, o.label);
    if (o.disabled) opt.disabled = true;
    el.append(opt);
  }
  el.value = String(value);
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

// Dragging helper: calls move(dx, dy, event) relative to the press point.
export function drag(el, { down, move, up }) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (down && down(e) === false) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY;
    const mv = (ev) => move && move(ev.clientX - x0, ev.clientY - y0, ev);
    const end = (ev) => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      if (up) up(ev);
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  });
}

// Rotary knob. map: { min, max, curve: 'lin'|'log', def, fmt, step }
export function knob({ label, value, min, max, def = value, log = false, fmt = (v) => v.toFixed(1), onChange, size = 'md', title }) {
  const toNorm = (v) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromNorm = (n) => (log ? min * (max / min) ** n : min + n * (max - min));
  let cur = value;
  const arc = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arc.setAttribute('viewBox', '0 0 40 40');
  arc.innerHTML = '<circle class="k-track" cx="20" cy="20" r="16"/><path class="k-val"/><circle class="k-cap" cx="20" cy="20" r="11"/><line class="k-ptr" x1="20" y1="20" x2="20" y2="11"/>';
  const val = h('div', { class: 'k-num' });
  const el = h('div', { class: `knob knob-${size}`, title: title || label }, arc, label ? h('div', { class: 'k-label' }, label) : null, val);
  const path = arc.querySelector('.k-val');
  const ptr = arc.querySelector('.k-ptr');
  function draw() {
    const n = clamp(toNorm(cur), 0, 1);
    const a0 = -135, a1 = -135 + 270 * n;
    const p = (a) => [20 + 16 * Math.sin((a * Math.PI) / 180), 20 - 16 * Math.cos((a * Math.PI) / 180)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    path.setAttribute('d', n > 0.001 ? `M${x0},${y0} A16,16 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1},${y1}` : '');
    ptr.setAttribute('transform', `rotate(${a1} 20 20)`);
    val.textContent = fmt(cur);
  }
  function set(v, emit = true) {
    cur = clamp(v, Math.min(min, max), Math.max(min, max));
    draw();
    if (emit && onChange) onChange(cur);
  }
  let startN = 0;
  drag(arc, {
    down: () => { startN = toNorm(cur); },
    move: (dx, dy, e) => set(fromNorm(clamp(startN - dy / (e.shiftKey ? 600 : 150), 0, 1))),
  });
  arc.addEventListener('dblclick', () => set(def));
  arc.addEventListener('wheel', (e) => {
    e.preventDefault();
    set(fromNorm(clamp(toNorm(cur) - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.02), 0, 1)));
  }, { passive: false });
  val.addEventListener('dblclick', () => {
    const s = prompt(label || 'Value', String(+cur.toFixed(3)));
    if (s !== null && !Number.isNaN(parseFloat(s))) set(parseFloat(s));
  });
  draw();
  el.setValue = (v) => set(v, false);
  return el;
}

// Fader in dB with a long throw: -inf .. +10 dB.
export function faderPos(db) {
  if (db <= -90) return 0;
  if (db >= 10) return 1;
  // piecewise: -60..+10 occupies 90% of the throw
  if (db < -60) return 0.1 * (db + 90) / 30;
  return 0.1 + 0.9 * ((db + 60) / 70) ** 1.6;
}

export function faderDb(pos) {
  if (pos <= 0.001) return -Infinity;
  if (pos < 0.1) return -90 + (pos / 0.1) * 30;
  return -60 + 70 * ((pos - 0.1) / 0.9) ** (1 / 1.6);
}

export function fmtDb(db) {
  if (!Number.isFinite(db) || db <= -90) return '-∞';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`;
}

export function fader({ value, onChange, height = 180 }) {
  let db = value;
  const cap = h('div', { class: 'f-cap' });
  const track = h('div', { class: 'f-track' });
  const el = h('div', { class: 'fader', style: { height: `${height}px` } }, track, h('div', { class: 'f-scale' }, ...[10, 0, -10, -20, -40, -60].map((d) => h('span', { style: { bottom: `${faderPos(d) * 100}%` } }, d > 0 ? `+${d}` : d))), cap);
  const draw = () => { cap.style.bottom = `calc(${faderPos(db) * 100}% - 9px)`; };
  const set = (v, emit = true) => {
    db = v;
    draw();
    if (emit) onChange(db);
  };
  let p0 = 0;
  drag(el, {
    down: (e) => {
      p0 = faderPos(db);
      if (e.target !== cap) {
        const r = el.getBoundingClientRect();
        p0 = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
        set(faderDb(p0));
      }
    },
    move: (dx, dy, e) => set(faderDb(clamp(p0 - dy / (height * (e.shiftKey ? 4 : 1)), 0, 1))),
  });
  el.addEventListener('dblclick', () => set(0));
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    set(faderDb(clamp(faderPos(db) - Math.sign(e.deltaY) * 0.01, 0, 1)));
  }, { passive: false });
  draw();
  el.setValue = (v) => set(v, false);
  return el;
}

// Vertical peak meter with hold. Call meter.update(linearPeak[, linearPeak2]).
export function meter({ channels = 1, height = 180, width = 8 }) {
  const c = h('canvas', { class: 'meter', width: width * channels + (channels - 1) * 2, height });
  const ctx = c.getContext('2d');
  const lvl = new Array(channels).fill(0);
  const hold = new Array(channels).fill(0);
  const holdT = new Array(channels).fill(0);
  let clip = false;
  const pos = (lin) => {
    const db = 20 * Math.log10(lin + 1e-9);
    return clamp((db + 60) / 66, 0, 1);
  };
  c.update = (...vals) => {
    const now = performance.now();
    ctx.clearRect(0, 0, c.width, c.height);
    for (let i = 0; i < channels; i++) {
      const v = vals[i] ?? vals[0] ?? 0;
      lvl[i] = v > lvl[i] ? v : lvl[i] * 0.85;
      if (v >= hold[i] || now - holdT[i] > 1500) { hold[i] = v; holdT[i] = now; }
      if (v >= 1) clip = true;
      const x = i * (width + 2);
      ctx.fillStyle = '#151827';
      ctx.fillRect(x, 0, width, height);
      const y = height * (1 - pos(lvl[i]));
      const g = ctx.createLinearGradient(0, height, 0, 0);
      g.addColorStop(0, '#3ddc97');
      g.addColorStop(0.75, '#3ddc97');
      g.addColorStop(0.86, '#ffd166');
      g.addColorStop(0.95, '#ff5c5c');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, width, height - y);
      const hy = height * (1 - pos(hold[i]));
      ctx.fillStyle = hold[i] >= 1 ? '#ff5c5c' : '#e8ecff';
      ctx.fillRect(x, hy, width, 2);
    }
    if (clip) {
      ctx.fillStyle = '#ff5c5c';
      ctx.fillRect(0, 0, c.width, 4);
    }
  };
  c.addEventListener('click', () => { clip = false; hold.fill(0); });
  c.title = 'Click to reset peak hold';
  c.update(0);
  return c;
}

export function toggle(label, on, onChange, cls = '') {
  const b = h('button', { class: `tog ${cls}${on ? ' on' : ''}` }, label);
  b.addEventListener('click', () => {
    const v = !b.classList.contains('on');
    b.classList.toggle('on', v);
    onChange(v);
  });
  b.setOn = (v) => b.classList.toggle('on', !!v);
  return b;
}

export function segmented(options, value, onChange, cls = '') {
  const el = h('div', { class: `seg ${cls}` });
  for (const o of options) {
    const b = h('button', { class: o.value === value ? 'on' : '', dataset: { v: o.value }, title: o.title || '' }, o.label);
    b.addEventListener('click', () => {
      if (o.disabled) return;
      el.setValue(o.value);
      onChange(o.value);
    });
    el.append(b);
  }
  el.setValue = (v) => {
    for (const b of el.children) b.classList.toggle('on', b.dataset.v === String(v));
  };
  return el;
}

// Modal dialog. Returns { el, close }.
export function modal(title, body, buttons = [], cls = '') {
  const overlay = h('div', { class: 'overlay' });
  const box = h('div', { class: `dialog ${cls}` }, h('div', { class: 'dlg-title' }, title), h('div', { class: 'dlg-body' }, body));
  const foot = h('div', { class: 'dlg-foot' });
  const close = () => overlay.remove();
  for (const b of buttons) {
    const btn = h('button', { class: b.primary ? 'primary' : '' }, b.label);
    btn.addEventListener('click', async () => {
      if (b.onClick && (await b.onClick()) === false) return;
      close();
    });
    foot.append(btn);
  }
  if (buttons.length) box.append(foot);
  overlay.append(box);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay && !buttons.some((b) => b.primary)) close(); });
  document.body.append(overlay);
  const first = box.querySelector('input,select');
  if (first) setTimeout(() => first.focus(), 0);
  return { el: box, close };
}

export function contextMenu(x, y, items) {
  document.querySelectorAll('.ctx').forEach((m) => m.remove());
  const m = h('div', { class: 'ctx', style: { left: `${x}px`, top: `${y}px` } });
  for (const it of items) {
    if (it === '-') { m.append(h('div', { class: 'ctx-sep' })); continue; }
    const row = h('div', { class: `ctx-item${it.disabled ? ' disabled' : ''}` }, it.label);
    row.addEventListener('click', () => {
      if (it.disabled) return;
      m.remove();
      it.onClick();
    });
    m.append(row);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  if (r.right > innerWidth) m.style.left = `${innerWidth - r.width - 4}px`;
  if (r.bottom > innerHeight) m.style.top = `${innerHeight - r.height - 4}px`;
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off); }
  }), 0);
}

export function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 3000);
}
