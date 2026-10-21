#include "engine.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

engine E;

#define RLX memory_order_relaxed
static inline float ldf(_Atomic float *x) { return atomic_load_explicit(x, RLX); }
static inline int ldi(_Atomic int *x) { return atomic_load_explicit(x, RLX); }
static inline void meterMax(_Atomic float *m, float v) {
  if (v > atomic_load_explicit(m, RLX)) atomic_store_explicit(m, v, RLX);
}

static void sleepMs(int ms) {
  struct timespec ts = {ms / 1000, (long)(ms % 1000) * 1000000L};
  nanosleep(&ts, NULL);
}

static double nowSec(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + ts.tv_nsec * 1e-9;
}

void engine_init(void) {
  memset(&E, 0, sizeof E);
  E.sr = 48000;
  pthread_mutex_init(&E.peaksMutex, NULL);
  for (int t = 0; t < MAX_TRACKS; t++) {
    track *T = &E.tracks[t];
    pthread_mutex_init(&T->clipMutex, NULL);
    atomic_store(&T->input, -1);
    atomic_store(&T->hwOut, -1);
    atomic_store(&T->trim, 1.0f);
    atomic_store(&T->fader, 1.0f);
    atomic_store(&T->dest, 0);
  }
  for (int b = 0; b < MAX_BUSES; b++) {
    bus *B = &E.buses[b];
    atomic_store(&B->fader, 1.0f);
    atomic_store(&B->toMaster, b != 0);
    atomic_store(&B->hwOut, b == 0 ? 0 : -1);
  }
  E.nbuses = 1;
  atomic_store(&E.seekGen, 0);
  atomic_store(&E.readerAck, -1);
  atomic_store(&E.audioAck, -1);
  atomic_store(&E.prefilled, -1);
  E.bcCap = 1 << 16;
  E.bcRing = calloc(E.bcCap, sizeof(float));
  E.tapCap = 1 << 16;
  E.tapRing = calloc(E.tapCap, sizeof(float));
}

void engine_set_sample_rate(float sr) {
  E.sr = sr;
}

// ---------------------------------------------------------------- rings

static inline size_t ringAvail(_Atomic size_t *w, _Atomic size_t *r) {
  return atomic_load_explicit(w, memory_order_acquire) - atomic_load_explicit(r, memory_order_acquire);
}

static void stereoPush(float *ring, size_t cap, _Atomic size_t *w, _Atomic size_t *r,
                       const float *l, const float *rr, int n) {
  size_t wi = atomic_load_explicit(w, RLX);
  size_t space = cap - (wi - atomic_load_explicit(r, memory_order_acquire));
  if (space < (size_t)n * 2) return; // reader is not keeping up: drop
  for (int i = 0; i < n; i++) {
    ring[(wi + 2 * (size_t)i) & (cap - 1)] = l[i];
    ring[(wi + 2 * (size_t)i + 1) & (cap - 1)] = rr[i];
  }
  atomic_store_explicit(w, wi + (size_t)n * 2, memory_order_release);
}

void engine_bc_push(const float *l, const float *r, int n) {
  stereoPush(E.bcRing, E.bcCap, &E.bcW, &E.bcR, l, r, n);
}

// ---------------------------------------------------------------- audio

static float pbuf[BLOCK], xbuf[BLOCK];
static float bcL[BLOCK], bcR[BLOCK], tpL[BLOCK], tpR[BLOCK];

static void rampGain(float *g, float target, float *dst, int n) {
  float step = (target - *g) / (float)n;
  float v = *g;
  for (int i = 0; i < n; i++) {
    v += step;
    dst[i] = v;
  }
  *g = target;
}

static float gainRamp[BLOCK], gainRamp2[BLOCK];

static void processBus(int b, float *out, int outCh, int n, int *bcUsed, int *tapUsed) {
  bus *B = &E.buses[b];
  float *chs[2] = {B->buf[0], B->buf[1]};
  for (int s = 0; s < MAX_FX; s++) fx_process(&B->fx[s], chs, 2, n, E.sr);
  float f = ldi(&B->mute) ? 0.0f : ldf(&B->fader);
  float pan = ldf(&B->pan);
  float tl = f * (pan > 0 ? 1.0f - pan : 1.0f);
  float tr = f * (pan < 0 ? 1.0f + pan : 1.0f);
  rampGain(&B->g[0], tl, gainRamp, n);
  rampGain(&B->g[1], tr, gainRamp2, n);
  float pl = 0, pr = 0;
  for (int i = 0; i < n; i++) {
    B->buf[0][i] *= gainRamp[i];
    B->buf[1][i] *= gainRamp2[i];
    float a = fabsf(B->buf[0][i]), c = fabsf(B->buf[1][i]);
    if (a > pl) pl = a;
    if (c > pr) pr = c;
  }
  meterMax(&B->mL, pl);
  meterMax(&B->mR, pr);
  if (b != 0 && ldi(&B->toMaster) && !ldi(&B->feedMaster)) {
    bus *M = &E.buses[0];
    for (int i = 0; i < n; i++) {
      M->buf[0][i] += B->buf[0][i];
      M->buf[1][i] += B->buf[1][i];
    }
  }
  int hw = out ? ldi(&B->hwOut) : -1;
  if (hw >= 0 && hw + 1 < outCh) {
    for (int i = 0; i < n; i++) {
      out[i * outCh + hw] += B->buf[0][i];
      out[i * outCh + hw + 1] += B->buf[1][i];
    }
  } else if (hw >= 0 && hw < outCh) { // mono output device
    for (int i = 0; i < n; i++) out[i * outCh + hw] += 0.5f * (B->buf[0][i] + B->buf[1][i]);
  }
  if (ldi(&B->toBcDevice)) {
    *bcUsed = 1;
    for (int i = 0; i < n; i++) { bcL[i] += B->buf[0][i]; bcR[i] += B->buf[1][i]; }
  }
  if (ldi(&B->tap)) {
    *tapUsed = 1;
    for (int i = 0; i < n; i++) { tpL[i] += B->buf[0][i]; tpR[i] += B->buf[1][i]; }
  }
}

static void processBlock(const float *in, float *out, int n) {
  int inCh = E.inCh, outCh = E.outCh;
  int sg = atomic_load(&E.seekGen);
  int acked = atomic_load(&E.audioAck) == sg;
  if (!acked && atomic_load(&E.readerAck) == sg) {
    for (int t = 0; t < E.ntracks; t++)
      atomic_store(&E.tracks[t].rr, atomic_load(&E.tracks[t].rw));
    atomic_store(&E.pos, atomic_load(&E.seekPos));
    atomic_store(&E.audioAck, sg);
    acked = 1;
  }
  int advance = atomic_load(&E.playing) && acked && atomic_load(&E.prefilled) == sg;
  if (advance && atomic_load(&E.recPending)) {
    atomic_store(&E.recStart, atomic_load(&E.pos));
    atomic_store(&E.recording, 1);
    atomic_store(&E.recPending, 0);
  }
  int src = ldi(&E.source);
  int anySolo = ldi(&E.anySolo);

  for (int b = 0; b < E.nbuses; b++) {
    memset(E.buses[b].buf[0], 0, sizeof(float) * (size_t)n);
    memset(E.buses[b].buf[1], 0, sizeof(float) * (size_t)n);
  }
  memset(bcL, 0, sizeof bcL); memset(bcR, 0, sizeof bcR);
  memset(tpL, 0, sizeof tpL); memset(tpR, 0, sizeof tpR);

  for (int t = 0; t < E.ntracks; t++) {
    track *T = &E.tracks[t];
    // Playback is consumed whenever the transport runs, even with live
    // sources, so switching to virtual soundcheck stays in sync.
    if (advance) {
      size_t rr = atomic_load_explicit(&T->rr, RLX);
      size_t avail = atomic_load_explicit(&T->rw, memory_order_acquire) - rr;
      if (avail >= (size_t)n) {
        for (int i = 0; i < n; i++) pbuf[i] = T->ring[(rr + (size_t)i) & (PLAY_RING - 1)];
        atomic_store_explicit(&T->rr, rr + (size_t)n, memory_order_release);
      } else {
        memset(pbuf, 0, sizeof(float) * (size_t)n);
        atomic_fetch_add(&E.xruns, 1);
      }
    } else {
      memset(pbuf, 0, sizeof(float) * (size_t)n);
    }

    if (src == 1) {
      memcpy(xbuf, pbuf, sizeof(float) * (size_t)n);
      int hw = ldi(&T->hwOut);
      if (out && hw >= 0 && hw < outCh)
        for (int i = 0; i < n; i++) out[i * outCh + hw] += pbuf[i];
    } else {
      int ch = ldi(&T->input);
      if (in && ch >= 0 && ch < inCh)
        for (int i = 0; i < n; i++) xbuf[i] = in[i * inCh + ch];
      else
        memset(xbuf, 0, sizeof(float) * (size_t)n);
    }

    float g = ldf(&T->trim) * (ldi(&T->phase) ? -1.0f : 1.0f);
    float pk = 0;
    for (int i = 0; i < n; i++) {
      float a = fabsf(xbuf[i]);
      if (a > pk) pk = a;
      xbuf[i] *= g;
    }
    meterMax(&T->mIn, pk);

    float *chs[1] = {xbuf};
    for (int s = 0; s < MAX_FX; s++) fx_process(&T->fx[s], chs, 1, n, E.sr);

    for (int b = 1; b < E.nbuses; b++) {
      float lv = ldf(&T->send[b]);
      if (lv <= 0 || !ldi(&T->sendPre[b])) continue;
      bus *B = &E.buses[b];
      for (int i = 0; i < n; i++) {
        B->buf[0][i] += xbuf[i] * lv;
        B->buf[1][i] += xbuf[i] * lv;
      }
    }

    int silenced = ldi(&T->mute) || (anySolo && !ldi(&T->solo));
    float f = silenced ? 0.0f : ldf(&T->fader);
    float pan = ldf(&T->pan);
    float ang = (pan + 1.0f) * 0.25f * 3.14159265f;
    rampGain(&T->gL, f * cosf(ang), gainRamp, n);
    rampGain(&T->gR, f * sinf(ang), gainRamp2, n);
    float po = 0;
    int dest = ldi(&T->dest);
    bus *D = dest >= 0 && dest < E.nbuses ? &E.buses[dest] : NULL;
    for (int i = 0; i < n; i++) {
      float l = xbuf[i] * gainRamp[i], r = xbuf[i] * gainRamp2[i];
      float a = fabsf(l) > fabsf(r) ? fabsf(l) : fabsf(r);
      if (a > po) po = a;
      if (D) { D->buf[0][i] += l; D->buf[1][i] += r; }
      if (E.stems) { E.stems[t][0][i] = l; E.stems[t][1][i] = r; }
    }
    meterMax(&T->mOut, po);
    for (int b = 1; b < E.nbuses; b++) {
      float lv = ldf(&T->send[b]);
      if (lv <= 0 || ldi(&T->sendPre[b])) continue;
      bus *B = &E.buses[b];
      for (int i = 0; i < n; i++) {
        B->buf[0][i] += xbuf[i] * gainRamp[i] * lv;
        B->buf[1][i] += xbuf[i] * gainRamp2[i] * lv;
      }
    }
  }

  // Recording: raw inputs, before trim and processing.
  if (atomic_load(&E.recording)) {
    int K = E.recCount;
    size_t w = atomic_load_explicit(&E.recW, RLX);
    size_t used = w - atomic_load_explicit(&E.recR, memory_order_acquire);
    if (E.recCap - used >= (size_t)n * (size_t)K) {
      for (int i = 0; i < n; i++)
        for (int k = 0; k < K; k++) {
          int ch = ldi(&E.tracks[E.recMap[k]].input);
          float v = (in && ch >= 0 && ch < inCh) ? in[i * inCh + ch] : 0.0f;
          E.recRing[(w + (size_t)i * (size_t)K + (size_t)k) % E.recCap] = v;
        }
      atomic_store_explicit(&E.recW, w + (size_t)n * (size_t)K, memory_order_release);
    } else {
      atomic_fetch_add(&E.recDropped, n);
    }
  }

  int bcUsed = 0, tapUsed = 0;
  for (int b = 1; b < E.nbuses; b++)
    if (!ldi(&E.buses[b].feedMaster)) processBus(b, out, outCh, n, &bcUsed, &tapUsed);
  processBus(0, out, outCh, n, &bcUsed, &tapUsed);
  for (int b = 1; b < E.nbuses; b++) {
    bus *B = &E.buses[b];
    if (!ldi(&B->feedMaster)) continue;
    for (int i = 0; i < n; i++) {
      B->buf[0][i] += E.buses[0].buf[0][i];
      B->buf[1][i] += E.buses[0].buf[1][i];
    }
    processBus(b, out, outCh, n, &bcUsed, &tapUsed);
  }
  if (bcUsed) engine_bc_push(bcL, bcR, n);
  if (tapUsed) stereoPush(E.tapRing, E.tapCap, &E.tapW, &E.tapR, tpL, tpR, n);

  if (advance) {
    int64_t p = atomic_fetch_add(&E.pos, n) + n;
    if (ldi(&E.loopOn) && !atomic_load(&E.recording)) {
      int64_t le = atomic_load(&E.loopEnd);
      if (le > atomic_load(&E.loopStart) && p >= le) engine_locate(atomic_load(&E.loopStart));
    }
  }
}

void engine_process(const float *in, float *out, int frames) {
  double t0 = nowSec();
  if (out) memset(out, 0, sizeof(float) * (size_t)frames * (size_t)E.outCh);
  for (int o = 0; o < frames; o += BLOCK) {
    int n = frames - o < BLOCK ? frames - o : BLOCK;
    processBlock(in ? in + (size_t)o * (size_t)E.inCh : NULL,
                 out ? out + (size_t)o * (size_t)E.outCh : NULL, n);
  }
  atomic_fetch_add(&E.blocks, 1);
  float load = (float)((nowSec() - t0) / (frames / (double)E.sr));
  float cur = ldf(&E.cpu);
  atomic_store_explicit(&E.cpu, load > cur ? load : cur * 0.95f + load * 0.05f, RLX);
}

void engine_locate(int64_t pos) {
  if (pos < 0) pos = 0;
  atomic_store(&E.seekPos, pos);
  atomic_fetch_add(&E.seekGen, 1);
}

// ---------------------------------------------------------------- reader

#define CHUNK 4096
#define PREFILL 16384

int engine_fill_track(track *T, int64_t at, float *dst, int frames) {
  static _Thread_local float tmp[CHUNK];
  static _Thread_local uint8_t scratch[CHUNK * 32];
  memset(dst, 0, sizeof(float) * (size_t)frames);
  int any = 0;
  pthread_mutex_lock(&T->clipMutex);
  for (int c = 0; c < T->nclips; c++) {
    clip *C = &T->clips[c];
    int64_t s = at > C->start ? at : C->start;
    int64_t e = at + frames < C->start + C->length ? at + frames : C->start + C->length;
    for (int64_t p = s; p < e;) {
      int m = (int)(e - p < CHUNK ? e - p : CHUNK);
      int got = wav_read_channel(&C->rd, C->offset + (p - C->start), m, C->channel, tmp, scratch, sizeof scratch);
      if (got <= 0) break;
      float *d = dst + (p - at);
      for (int i = 0; i < got; i++) d[i] += tmp[i] * C->gain;
      p += got;
      any = 1;
    }
  }
  pthread_mutex_unlock(&T->clipMutex);
  return any;
}

static void ringPushTrack(track *T, const float *src, int n) {
  size_t w = atomic_load_explicit(&T->rw, RLX);
  for (int i = 0; i < n; i++) T->ring[(w + (size_t)i) & (PLAY_RING - 1)] = src[i];
  atomic_store_explicit(&T->rw, w + (size_t)n, memory_order_release);
}

static void *readerMain(void *arg) {
  (void)arg;
  float *buf = malloc(sizeof(float) * CHUNK);
  int myGen = -1;
  while (atomic_load(&E.readerRun)) {
    if (atomic_load(&E.readerPause)) {
      atomic_store(&E.readerPaused, 1);
      sleepMs(2);
      continue;
    }
    atomic_store(&E.readerPaused, 0);
    int g = atomic_load(&E.seekGen);
    if (g != myGen) {
      atomic_store(&E.readerAck, g);
      while (atomic_load(&E.audioAck) != g && atomic_load(&E.readerRun) && atomic_load(&E.seekGen) == g) {
        if (!atomic_load(&E.running)) {
          for (int t = 0; t < MAX_TRACKS; t++) atomic_store(&E.tracks[t].rr, atomic_load(&E.tracks[t].rw));
          atomic_store(&E.pos, atomic_load(&E.seekPos));
          atomic_store(&E.audioAck, g);
          break;
        }
        sleepMs(1);
      }
      if (atomic_load(&E.seekGen) != g) continue;
      myGen = g;
      int64_t sp = atomic_load(&E.seekPos);
      for (int t = 0; t < MAX_TRACKS; t++) E.tracks[t].readPos = sp;
      for (int t = 0; t < E.ntracks && atomic_load(&E.seekGen) == g; t++) {
        track *T = &E.tracks[t];
        while (ringAvail(&T->rw, &T->rr) < PREFILL) {
          engine_fill_track(T, T->readPos, buf, CHUNK);
          ringPushTrack(T, buf, CHUNK);
          T->readPos += CHUNK;
        }
      }
      if (atomic_load(&E.seekGen) == g) atomic_store(&E.prefilled, g);
      continue;
    }
    int did = 0;
    for (int t = 0; t < E.ntracks && atomic_load(&E.seekGen) == myGen; t++) {
      track *T = &E.tracks[t];
      if (PLAY_RING - ringAvail(&T->rw, &T->rr) >= CHUNK) {
        engine_fill_track(T, T->readPos, buf, CHUNK);
        ringPushTrack(T, buf, CHUNK);
        T->readPos += CHUNK;
        did = 1;
      }
    }
    if (!did) sleepMs(3);
  }
  free(buf);
  return NULL;
}

void engine_reader_start(void) {
  if (atomic_load(&E.readerRun)) return;
  for (int t = 0; t < MAX_TRACKS; t++)
    if (!E.tracks[t].ring) E.tracks[t].ring = calloc(PLAY_RING, sizeof(float));
  atomic_store(&E.readerRun, 1);
  pthread_create(&E.reader, NULL, readerMain, NULL);
}

void engine_reader_stop(void) {
  if (!atomic_load(&E.readerRun)) return;
  atomic_store(&E.readerRun, 0);
  pthread_join(E.reader, NULL);
}

int engine_set_clips(int t, clip *clips, int n) {
  if (t < 0 || t >= MAX_TRACKS) return -1;
  track *T = &E.tracks[t];
  pthread_mutex_lock(&T->clipMutex);
  clip *old = T->clips;
  int nold = T->nclips;
  T->clips = clips;
  T->nclips = n;
  pthread_mutex_unlock(&T->clipMutex);
  for (int i = 0; i < nold; i++) {
    wav_close_read(&old[i].rd);
    free(old[i].path);
  }
  free(old);
  return 0;
}

// ---------------------------------------------------------------- recording

static void setTimeRef(wav_writer *w, int64_t ref) {
  // bext TimeReference sits at a fixed offset (see wav_open_write).
  if (!w->fp) return;
  off_t here = ftello(w->fp);
  uint8_t v[8];
  for (int i = 0; i < 8; i++) v[i] = (uint8_t)(((uint64_t)ref >> (8 * i)) & 255);
  fseek(w->fp, 12 + 8 + 338, SEEK_SET);
  fwrite(v, 1, 8, w->fp);
  fseeko(w->fp, here, SEEK_SET);
}

static void addPeaks(track *T, const float *x, int n) {
  for (int i = 0; i < n; i++) {
    if (x[i] < T->pkMin) T->pkMin = x[i];
    if (x[i] > T->pkMax) T->pkMax = x[i];
    if (++T->pkCount == PEAK_SPP) {
      pthread_mutex_lock(&E.peaksMutex);
      if (T->npeaks + 2 > T->peaksCap) {
        size_t cap = T->peaksCap ? T->peaksCap * 2 : 8192;
        int8_t *p = realloc(T->peaks, cap);
        if (p) { T->peaks = p; T->peaksCap = cap; }
      }
      if (T->npeaks + 2 <= T->peaksCap) {
        float lo = T->pkMin < -1 ? -1 : T->pkMin, hi = T->pkMax > 1 ? 1 : T->pkMax;
        T->peaks[T->npeaks++] = (int8_t)lrintf(lo * 127);
        T->peaks[T->npeaks++] = (int8_t)lrintf(hi * 127);
      }
      pthread_mutex_unlock(&E.peaksMutex);
      T->pkMin = 1e9f;
      T->pkMax = -1e9f;
      T->pkCount = 0;
    }
  }
}

static void *writerMain(void *arg) {
  (void)arg;
  int K = E.recCount;
  const int F = 4096;
  float *chunk = malloc(sizeof(float) * (size_t)F * (size_t)K);
  float *mono = malloc(sizeof(float) * (size_t)F);
  int64_t sinceHeader = 0;
  for (;;) {
    size_t r = atomic_load_explicit(&E.recR, RLX);
    size_t avail = atomic_load_explicit(&E.recW, memory_order_acquire) - r;
    if (avail < (size_t)K) {
      if (!atomic_load(&E.writerRun)) break;
      sleepMs(5);
      continue;
    }
    int frames = (int)(avail / (size_t)K);
    if (frames > F) frames = F;
    size_t cnt = (size_t)frames * (size_t)K;
    for (size_t i = 0; i < cnt; i++) chunk[i] = E.recRing[(r + i) % E.recCap];
    atomic_store_explicit(&E.recR, r + cnt, memory_order_release);
    for (int k = 0; k < K; k++) {
      track *T = &E.tracks[E.recMap[k]];
      for (int i = 0; i < frames; i++) mono[i] = chunk[(size_t)i * (size_t)K + (size_t)k];
      wav_write_float(&T->rec, mono, frames);
      addPeaks(T, mono, frames);
    }
    sinceHeader += frames;
    if (sinceHeader > (int64_t)(E.sr * 2)) {
      sinceHeader = 0;
      for (int k = 0; k < K; k++) wav_update_header(&E.tracks[E.recMap[k]].rec);
    }
  }
  free(chunk);
  free(mono);
  return NULL;
}

int engine_record_start(const char *dir, const char *prefix, int bits) {
  (void)dir; (void)prefix;
  if (atomic_load(&E.recording) || atomic_load(&E.recPending) || E.recCount) return -1;
  int K = 0;
  for (int t = 0; t < E.ntracks; t++) {
    track *T = &E.tracks[t];
    if (!T->recPath) continue;
    if (wav_open_write(&T->rec, T->recPath, (int)E.sr, 1, bits, 0, "Unique AV DAW recording") != 0) {
      for (int k = 0; k < K; k++) wav_close(&E.tracks[E.recMap[k]].rec);
      return -2;
    }
    pthread_mutex_lock(&E.peaksMutex);
    T->npeaks = 0;
    pthread_mutex_unlock(&E.peaksMutex);
    T->pkMin = 1e9f;
    T->pkMax = -1e9f;
    T->pkCount = 0;
    E.recMap[K++] = t;
  }
  if (!K) return 0;
  E.recCount = K;
  E.recBits = bits;
  E.recCap = (size_t)K * (size_t)(1 << 17);
  E.recRing = malloc(sizeof(float) * E.recCap);
  atomic_store(&E.recW, 0);
  atomic_store(&E.recR, 0);
  atomic_store(&E.recDropped, 0);
  atomic_store(&E.writerRun, 1);
  pthread_create(&E.writer, NULL, writerMain, NULL);
  atomic_store(&E.recPending, 1);
  return K;
}

int engine_record_stop(void) {
  if (!E.recCount) return 0;
  atomic_store(&E.recPending, 0);
  atomic_store(&E.recording, 0);
  // Let any callback that is mid-write finish before draining.
  uint64_t b0 = atomic_load(&E.blocks);
  for (int i = 0; i < 100 && atomic_load(&E.running) && atomic_load(&E.blocks) < b0 + 2; i++) sleepMs(2);
  atomic_store(&E.writerRun, 0);
  pthread_join(E.writer, NULL);
  int64_t start = atomic_load(&E.recStart);
  for (int k = 0; k < E.recCount; k++) {
    track *T = &E.tracks[E.recMap[k]];
    setTimeRef(&T->rec, start);
    wav_close(&T->rec);
  }
  int K = E.recCount;
  E.recCount = 0;
  free(E.recRing);
  E.recRing = NULL;
  return K;
}
