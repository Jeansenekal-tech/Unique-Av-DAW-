// BROADCAST view: the broadcast bus (follows the master or its own mix),
// loudness metering, outputs to hardware / a second device, and live
// stream destinations (RTMP/RTMPS, SRT, Icecast, custom FFmpeg URL).
import { h, select, fader, meter, fmtDb, toggle, segmented, toast, clamp } from './ui.js';
import { BROADCAST, newId } from './state.js';
import { insertSlots, addPreset } from './mixer.js';
import { PRESETS } from './state.js';

const daw = window.daw;

const TYPES = [
  { value: 'rtmp', label: 'RTMP / RTMPS (YouTube, Facebook, Twitch, Restream…)' },
  { value: 'srt', label: 'SRT' },
  { value: 'icecast', label: 'Icecast / Shoutcast (audio only)' },
  { value: 'custom', label: 'Custom FFmpeg URL' },
];
const SERVERS = {
  'YouTube': 'rtmp://a.rtmp.youtube.com/live2',
  'Facebook Live': 'rtmps://live-api-s.facebook.com:443/rtmp/',
  'Twitch': 'rtmp://live.twitch.tv/app',
  'Restream': 'rtmp://live.restream.io/live',
};
const TARGETS = [
  { value: -14, label: '-14 LUFS (Spotify / YouTube)' },
  { value: -16, label: '-16 LUFS (Podcasts / Apple)' },
  { value: -23, label: '-23 LUFS (EBU R128 TV)' },
  { value: -24, label: '-24 LKFS (ATSC A/85)' },
];

export class BroadcastView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.status = [];
    this.loud = null;
    this.history = [];
    daw.onLoudness((l) => { this.loud = l; this.history.push(l.shortTerm); if (this.history.length > 600) this.history.shift(); });
    daw.onStreamStatus((st) => { this.status = st; this.renderDests(); });
  }

  get bc() {
    return this.app.s.broadcast;
  }

  async setBc(patch) {
    Object.assign(this.bc, patch);
    this.app.markDirty();
    await this.app.syncBus(BROADCAST);
    await this.app.syncGlobal();
  }

  render() {
    const app = this.app, s = app.s;
    if (!s) return;
    const B = s.buses[BROADCAST];
    const bc = this.bc;

    // ---- column 1: program meters + loudness
    this.meterEl = meter({ channels: 2, height: 260, width: 14 });
    this.lufsEl = h('div', { class: 'lufs' });
    this.hist = h('canvas', { class: 'hist', width: 600, height: 240 });
    const col1 = h('div', { class: 'bc-col', style: { width: '360px' } },
      h('h3', {}, 'PROGRAM LOUDNESS'),
      h('div', { class: 'bc-meter' }, this.meterEl, this.lufsEl),
      this.hist,
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('span', {}, 'Target'), select(TARGETS, bc.target, (v) => { bc.target = Number(v); app.markDirty(); })),
        h('div', { class: 'field' }, h('span', {}, ' '), h('button', { onclick: () => { daw.streamResetLoudness(); this.history = []; } }, 'Reset integrated'))),
      h('div', { class: 'hint' }, 'Short-term loudness (3 s) is drawn above; the line is your target. Integrated loudness is measured since the last reset with EBU R128 gating.'),
    );

    // ---- column 2: broadcast mix
    const dbl = h('div', { class: 'db' }, fmtDb(B.fader));
    this.grEl = h('div', { class: 'hint' });
    const muteB = toggle('MUTE', B.mute, (v) => { B.mute = v; app.markDirty(); app.syncBus(BROADCAST); }, 'm');
    const mainOuts = app.outputOptions(true, 'None');
    const devices = h('select');
    daw.devices().then((d) => {
      devices.replaceChildren(h('option', { value: '' }, 'None'), ...d.outputs.map((o) => h('option', { value: o.name }, `${o.name} (${o.channels} ch)`)));
      devices.value = bc.device || '';
    });
    devices.addEventListener('change', async () => {
      await this.setBc({ device: devices.value });
      await app.applyBroadcastDevice();
    });
    const recFile = h('div', { class: 'hint' });
    const col2 = h('div', { class: 'bc-col', style: { width: '360px' } },
      h('h3', {}, 'BROADCAST MIX'),
      segmented([
        { value: 'master', label: 'FOLLOW MASTER', title: 'Broadcast = the main mix, with its own processing and level' },
        { value: 'own', label: 'SEPARATE MIX', title: 'Build a different mix with the BROADCAST sends on each channel' },
      ], bc.followMaster ? 'master' : 'own', async (v) => {
        await this.setBc({ followMaster: v === 'master' });
        app.views.mixer.render();
        this.render();
      }),
      h('div', { class: 'hint' }, bc.followMaster
        ? 'The broadcast bus receives the master mix. Its fader and processing do not affect the room.'
        : 'Each channel now has a BROADCAST send in the Mixer. Use it to build a mix for the stream that is independent from the PA.'),
      h('div', { style: { display: 'flex', gap: '16px', alignItems: 'flex-end' } },
        fader({ value: B.fader, height: 200, onChange: (v) => { B.fader = v; dbl.textContent = fmtDb(v); app.markDirty(); app.syncBus(BROADCAST); } }),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 } },
          h('div', { class: 'field' }, h('span', {}, 'Processing'), ...insertSlots(app, 'bus', BROADCAST, B)),
          h('button', { onclick: () => { const p = PRESETS.find((x) => x.label === 'Broadcast Chain'); const free = B.inserts.findIndex((x) => !x); if (free < 0) return toast('No free slots', 'error'); addPreset(app, 'bus', BROADCAST, free, p); } }, 'Add broadcast chain (comp + limiter)'),
          muteB, dbl, this.grEl)),
      h('h3', {}, 'OUTPUTS'),
      h('div', { class: 'field' }, h('span', {}, 'Main interface output'), select(mainOuts, B.hwOut, (v) => { B.hwOut = Number(v); app.markDirty(); app.syncBus(BROADCAST); })),
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('span', {}, 'Separate output device'), devices),
        h('div', { class: 'field' }, h('span', {}, 'Device channels'), select([0, 2, 4, 6, 8, 10, 12, 14].map((c) => ({ value: c, label: `${c + 1}-${c + 2}` })), bc.deviceChannel || 0, async (v) => { await this.setBc({ deviceChannel: Number(v) }); await app.applyBroadcastDevice(); }))),
      h('div', { class: 'hint' }, 'Use a separate device for a streaming PC or encoder (USB interface, Dante channel, or a virtual device like BlackHole / Loopback).'),
      h('label', { class: 'check' }, (() => {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = !!this.recording;
        cb.onchange = async () => {
          if (cb.checked) {
            const f = `${app.dir}/Mixdowns/Broadcast ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.wav`;
            await daw.streamRecord(f);
            this.recording = f;
            recFile.textContent = `Recording to ${f.split(/[\\/]/).pop()}`;
          } else {
            await daw.streamRecord(null);
            recFile.textContent = this.recording ? `Saved ${this.recording.split(/[\\/]/).pop()}` : '';
            this.recording = null;
          }
        };
        return cb;
      })(), 'Record the broadcast mix to a file'),
      recFile,
    );

    // ---- column 3: destinations
    this.destsEl = h('div', { class: 'bc-dests' });
    const goAll = h('button', { class: 'golive' }, 'GO LIVE – ALL');
    goAll.onclick = () => this.goAll();
    this.goAllBtn = goAll;
    const col3 = h('div', { class: 'bc-col', style: { flex: 1 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('h3', { style: { marginRight: 'auto' } }, 'STREAM DESTINATIONS'),
        h('button', { onclick: () => this.addDest() }, '+ DESTINATION')),
      this.destsEl,
      goAll,
    );
    this.root.replaceChildren(col1, col2, col3);
    this.renderDests();
    daw.streamStatus().then((st) => { this.status = st; this.renderDests(); });
  }

  addDest() {
    this.bc.destinations.push({ id: newId('d'), name: `Stream ${this.bc.destinations.length + 1}`, type: 'rtmp', url: SERVERS.YouTube, key: '', bitrate: 160, video: 'black', image: '', autoReconnect: true });
    this.app.markDirty();
    this.renderDests();
  }

  statusOf(id) {
    return this.status.find((x) => x.id === id) || { status: 'off' };
  }

  renderDests() {
    if (!this.destsEl || !this.app.s) return;
    const app = this.app;
    const ds = this.bc.destinations;
    if (!ds.length) {
      this.destsEl.replaceChildren(h('div', { class: 'hint' }, 'Add a destination, paste the server URL and stream key from YouTube, Facebook, Twitch, your encoder or radio server, then GO LIVE. RTMP platforms need a video track: the stream carries a black frame or an image of your choice alongside the audio.'));
    }
    const els = ds.map((d) => {
      const st = this.statusOf(d.id);
      const live = st.status === 'live' || st.status === 'connecting' || st.status === 'reconnecting';
      const set = (patch) => { Object.assign(d, patch); app.markDirty(); };
      const inp = (key, attrs = {}) => {
        const e = h('input', { type: attrs.type || 'text', value: d[key] ?? '', ...attrs });
        e.addEventListener('change', () => set({ [key]: attrs.type === 'number' ? Number(e.value) : e.value }));
        return e;
      };
      const elapsed = st.status === 'live' && st.startedAt ? Math.floor((Date.now() - st.startedAt) / 1000) : 0;
      const tm = elapsed ? ` ${Math.floor(elapsed / 3600)}:${String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}` : '';
      const go = h('button', { class: `golive${live ? ' live' : ''}`, style: { padding: '4px 12px' } }, live ? 'STOP' : 'GO LIVE');
      go.onclick = () => (live ? daw.streamStop(d.id) : this.start(d));
      const servers = select([{ value: '', label: 'Preset server…' }, ...Object.keys(SERVERS).map((k) => ({ value: k, label: k }))], '', (v) => { if (v) { set({ url: SERVERS[v], type: 'rtmp' }); this.renderDests(); } });
      return h('div', { class: 'dest' },
        h('div', { class: 'hd' }, inp('name'), h('span', { class: `st ${st.status}` }, `${st.status.toUpperCase()}${tm}${st.status === 'live' && st.kbps ? ` · ${Math.round(st.kbps)} kb/s` : ''}`), go,
          h('button', { title: 'Remove', onclick: () => { if (live) return toast('Stop this stream first', 'error'); this.bc.destinations = ds.filter((x) => x !== d); app.markDirty(); this.renderDests(); } }, '✕')),
        h('label', { class: 'full' }, 'TYPE', select(TYPES, d.type, (v) => { set({ type: v }); this.renderDests(); })),
        h('label', { class: 'full' }, d.type === 'icecast' ? 'URL (icecast://source:password@host:port/mount)' : d.type === 'srt' ? 'URL (srt://host:port?streamid=…)' : 'SERVER URL', h('div', { style: { display: 'flex', gap: '6px' } }, inp('url', { type: 'url', style: { flex: 1 } }), d.type === 'rtmp' ? servers : null)),
        d.type === 'rtmp' ? h('label', { class: 'full' }, 'STREAM KEY', inp('key', { type: 'password' })) : null,
        h('label', {}, 'AUDIO BITRATE (kb/s)', select([96, 128, 160, 192, 256, 320].map((b) => ({ value: b, label: String(b) })), d.bitrate || 160, (v) => set({ bitrate: Number(v) }))),
        d.type !== 'icecast' ? h('label', {}, 'VIDEO', select([{ value: 'black', label: 'Black frame' }, { value: 'image', label: 'Image…' }, { value: 'none', label: 'None (audio only)' }], d.video || 'black', async (v) => {
          if (v === 'image') {
            const f = await daw.pickImage();
            if (!f) return this.renderDests();
            set({ video: 'image', image: f });
          } else set({ video: v });
          this.renderDests();
        })) : h('span'),
        h('label', { class: 'check full' }, (() => { const c = h('input', { type: 'checkbox' }); c.checked = d.autoReconnect !== false; c.onchange = () => set({ autoReconnect: c.checked }); return c; })(), 'Reconnect automatically if the connection drops'),
        st.error && st.status !== 'live' ? h('div', { class: 'err' }, st.error) : null,
      );
    });
    if (ds.length) this.destsEl.replaceChildren(...els);
    const anyLive = this.status.some((x) => ['live', 'connecting', 'reconnecting'].includes(x.status));
    if (this.goAllBtn) {
      this.goAllBtn.textContent = anyLive ? 'STOP ALL STREAMS' : 'GO LIVE – ALL';
      this.goAllBtn.classList.toggle('live', anyLive);
    }
  }

  async start(d) {
    if (!this.app.audio) return toast('Open an audio device first', 'error');
    try {
      await daw.streamStart(d, {});
    } catch (e) {
      toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
    }
  }

  async goAll() {
    const anyLive = this.status.some((x) => ['live', 'connecting', 'reconnecting'].includes(x.status));
    if (anyLive) {
      for (const d of this.bc.destinations) await daw.streamStop(d.id);
      return;
    }
    if (!this.bc.destinations.length) return toast('Add a destination first', 'error');
    for (const d of this.bc.destinations) await this.start(d);
  }

  tick(meters) {
    const nt = this.app.s.tracks.length;
    const o = nt * 3 + BROADCAST * 3;
    if (this.meterEl) this.meterEl.update(meters[o] || 0, meters[o + 1] || 0);
    if (this.grEl) this.grEl.textContent = meters[o + 2] > 0.5 ? `Gain reduction ${meters[o + 2].toFixed(1)} dB` : '';
    const l = this.loud;
    if (l && this.lufsEl) {
      const tgt = this.bc.target;
      const cls = (v) => (!Number.isFinite(v) ? '' : v > tgt + 2 ? 'hi' : v < tgt - 4 ? 'lo' : 'ok');
      const f = (v) => (Number.isFinite(v) ? v.toFixed(1) : '–');
      this.lufsEl.replaceChildren(
        h('div', { class: cls(l.momentary) }, h('b', {}, f(l.momentary)), h('span', {}, 'MOMENTARY')),
        h('div', { class: cls(l.shortTerm) }, h('b', {}, f(l.shortTerm)), h('span', {}, 'SHORT-TERM')),
        h('div', { class: cls(l.integrated) }, h('b', {}, f(l.integrated)), h('span', {}, 'INTEGRATED')),
        h('div', { class: l.peak > -1 ? 'hi' : '' }, h('b', {}, f(l.peak)), h('span', {}, 'PEAK dBFS')),
      );
      this.loud = null;
      this.drawHistory();
    }
    // Refresh the on-air timers once a second.
    if (this.status.some((x) => x.status === 'live') && (!this.lastTimer || performance.now() - this.lastTimer > 1000)) {
      this.lastTimer = performance.now();
      this.renderDestsStatusOnly();
    }
  }

  renderDestsStatusOnly() {
    // Re-rendering inputs while typing would lose focus; only do it when idle.
    if (this.destsEl && !this.destsEl.contains(document.activeElement)) this.renderDests();
  }

  drawHistory() {
    const c = this.hist;
    if (!c) return;
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    const y = (v) => H - clamp((v + 40) / 40, 0, 1) * H;
    ctx.strokeStyle = '#3d4570';
    ctx.fillStyle = '#6f78a6';
    ctx.font = '18px sans-serif';
    for (const v of [-10, -20, -30]) {
      ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(W, y(v)); ctx.stroke();
      ctx.fillText(String(v), 4, y(v) - 4);
    }
    ctx.strokeStyle = '#3ddc97';
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.moveTo(0, y(this.bc.target)); ctx.lineTo(W, y(this.bc.target)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#9db1ff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    const n = this.history.length;
    this.history.forEach((v, i) => {
      const x = W - (n - i);
      const yy = y(Number.isFinite(v) ? v : -60);
      if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    });
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}
