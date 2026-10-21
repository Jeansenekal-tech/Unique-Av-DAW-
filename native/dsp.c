// Built-in processors. Parameter layouts (index: meaning):
//
// EQ       0 HPF on, 1 HPF Hz, 2 LPF on, 3 LPF Hz,
//          then 4 bands at 4 + k*5: on, type (BQ_*), Hz, gain dB, Q
// COMP     0 threshold dB, 1 ratio, 2 attack ms, 3 release ms, 4 knee dB,
//          5 makeup dB, 6 model (0 VCA, 1 FET, 2 Opto, 3 Vari-Mu), 7 mix 0..1,
//          8 sidechain HPF Hz (0 = off)
// GATE     0 threshold dB, 1 range dB (negative), 2 attack ms, 3 hold ms,
//          4 release ms, 5 key HPF Hz (0 = off), 6 key LPF Hz (0 = off),
//          7 hysteresis dB
// LIMITER  0 ceiling dB, 1 release ms, 2 input gain dB
// DYNEQ    2 bands at k*7: on, Hz, Q, threshold dB, range dB (+/-), attack ms,
//          release ms
// DELAY    0 time ms, 1 feedback 0..1, 2 mix 0..1, 3 feedback high-cut Hz,
//          4 ping-pong (0/1)
// REVERB   0 size 0..1, 1 damping 0..1, 2 mix 0..1, 3 width 0..1
#include "dsp.h"
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

void bq_reset(biquad *b) {
  memset(b->z1, 0, sizeof b->z1);
  memset(b->z2, 0, sizeof b->z2);
}

void bq_set(biquad *b, int type, float sr, float freq, float q, float gainDb) {
  if (freq < 10.0f) freq = 10.0f;
  if (freq > sr * 0.49f) freq = sr * 0.49f;
  if (q < 0.05f) q = 0.05f;
  double A = pow(10.0, gainDb / 40.0);
  double w0 = 2.0 * M_PI * freq / sr;
  double cw = cos(w0), sw = sin(w0);
  double alpha = sw / (2.0 * q);
  double b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (type) {
  case BQ_PEAK:
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
    break;
  case BQ_LOWSHELF: {
    double s = 2 * sqrt(A) * alpha;
    b0 = A * ((A + 1) - (A - 1) * cw + s);
    b1 = 2 * A * ((A - 1) - (A + 1) * cw);
    b2 = A * ((A + 1) - (A - 1) * cw - s);
    a0 = (A + 1) + (A - 1) * cw + s;
    a1 = -2 * ((A - 1) + (A + 1) * cw);
    a2 = (A + 1) + (A - 1) * cw - s;
    break;
  }
  case BQ_HIGHSHELF: {
    double s = 2 * sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cw + s);
    b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    b2 = A * ((A + 1) + (A - 1) * cw - s);
    a0 = (A + 1) - (A - 1) * cw + s;
    a1 = 2 * ((A - 1) - (A + 1) * cw);
    a2 = (A + 1) - (A - 1) * cw - s;
    break;
  }
  case BQ_HP:
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    break;
  case BQ_LP:
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    break;
  case BQ_NOTCH:
    b0 = 1; b1 = -2 * cw; b2 = 1;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    break;
  case BQ_BP:
    b0 = alpha; b1 = 0; b2 = -alpha;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    break;
  }
  b->b0 = (float)(b0 / a0);
  b->b1 = (float)(b1 / a0);
  b->b2 = (float)(b2 / a0);
  b->a1 = (float)(a1 / a0);
  b->a2 = (float)(a2 / a0);
}

static inline float msCoef(float ms, float sr) {
  if (ms < 0.01f) ms = 0.01f;
  return 1.0f - expf(-1.0f / (ms * 0.001f * sr));
}

static inline float lin2db(float x) { return 20.0f * log10f(x + 1e-12f); }

static inline void grReport(fxslot *s, float gr) {
  float cur = atomic_load_explicit(&s->grMeter, memory_order_relaxed);
  if (gr > cur) atomic_store_explicit(&s->grMeter, gr, memory_order_relaxed);
}

// ---------------------------------------------------------------- reverb

#define FV_COMBS 8
#define FV_APS 4
static const int fvComb[FV_COMBS] = {1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617};
static const int fvAp[FV_APS] = {556, 441, 341, 225};
#define FV_SPREAD 23

typedef struct {
  float *buf;
  int len, pos;
  float store;
} fvline;

struct freeverb {
  fvline comb[2][FV_COMBS];
  fvline ap[2][FV_APS];
};

static void fvline_init(fvline *l, int len) {
  l->len = len < 1 ? 1 : len;
  l->buf = calloc((size_t)l->len, sizeof(float));
  l->pos = 0;
  l->store = 0;
}

static freeverb *fv_new(float sr) {
  freeverb *v = calloc(1, sizeof *v);
  float scale = sr / 44100.0f;
  for (int c = 0; c < 2; c++) {
    for (int i = 0; i < FV_COMBS; i++)
      fvline_init(&v->comb[c][i], (int)((fvComb[i] + c * FV_SPREAD) * scale));
    for (int i = 0; i < FV_APS; i++)
      fvline_init(&v->ap[c][i], (int)((fvAp[i] + c * FV_SPREAD) * scale));
  }
  return v;
}

static void fv_free(freeverb *v) {
  if (!v) return;
  for (int c = 0; c < 2; c++) {
    for (int i = 0; i < FV_COMBS; i++) free(v->comb[c][i].buf);
    for (int i = 0; i < FV_APS; i++) free(v->ap[c][i].buf);
  }
  free(v);
}

static void fv_clear(freeverb *v) {
  for (int c = 0; c < 2; c++) {
    for (int i = 0; i < FV_COMBS; i++) {
      memset(v->comb[c][i].buf, 0, sizeof(float) * (size_t)v->comb[c][i].len);
      v->comb[c][i].store = 0;
    }
    for (int i = 0; i < FV_APS; i++)
      memset(v->ap[c][i].buf, 0, sizeof(float) * (size_t)v->ap[c][i].len);
  }
}

// ---------------------------------------------------------------- config

void fx_configure(fxslot *s, int type, int on, const float *params, int nparams, float sr) {
  if (type < 0 || type >= FX_TYPE_COUNT) type = FX_NONE;
  s->sr = sr;
  if (type == FX_DELAY && !s->delayBuf[0]) {
    s->delayLen = (int)(DELAY_MAX_SEC * (sr > 0 ? sr : 48000)) + 1;
    for (int c = 0; c < FX_MAX_CH; c++) s->delayBuf[c] = calloc((size_t)s->delayLen, sizeof(float));
  }
  if (type == FX_REVERB && !s->verb) s->verb = fv_new(sr > 0 ? sr : 48000);
  if (nparams > FX_PARAMS) nparams = FX_PARAMS;
  for (int i = 0; i < nparams; i++) s->p[i] = params[i];
  atomic_store(&s->on, on);
  atomic_store(&s->type, type);
  atomic_fetch_add(&s->version, 1);
}

void fx_free(fxslot *s) {
  for (int c = 0; c < FX_MAX_CH; c++) {
    free(s->delayBuf[c]);
    s->delayBuf[c] = NULL;
  }
  fv_free(s->verb);
  s->verb = NULL;
}

static void resetState(fxslot *s) {
  for (int i = 0; i < 8; i++) bq_reset(&s->bq[i]);
  for (int c = 0; c < FX_MAX_CH; c++) s->env[c] = 0;
  s->gainEnv = 1.0f;
  s->holdCount = 0;
  s->gateOpen = 0;
  memset(s->lim, 0, sizeof s->lim);
  s->limPos = 0;
  s->dynGain[0] = s->dynGain[1] = 0;
  if (s->delayBuf[0])
    for (int c = 0; c < FX_MAX_CH; c++) memset(s->delayBuf[c], 0, sizeof(float) * (size_t)s->delayLen);
  s->delayPos = 0;
  if (s->verb) fv_clear(s->verb);
}

static void updateCoefs(fxslot *s, float sr) {
  const float *p = s->p;
  switch (s->curType) {
  case FX_EQ:
    bq_set(&s->bq[0], BQ_HP, sr, p[1], 0.541f, 0);
    bq_set(&s->bq[1], BQ_HP, sr, p[1], 1.307f, 0);
    bq_set(&s->bq[2], BQ_LP, sr, p[3], 0.707f, 0);
    for (int k = 0; k < 4; k++) {
      const float *b = p + 4 + k * 5;
      bq_set(&s->bq[3 + k], (int)b[1], sr, b[2], b[4], b[3]);
    }
    break;
  case FX_COMP:
    if (p[8] > 0) bq_set(&s->bq[0], BQ_HP, sr, p[8], 0.707f, 0);
    break;
  case FX_GATE:
    if (p[5] > 0) bq_set(&s->bq[0], BQ_HP, sr, p[5], 0.707f, 0);
    if (p[6] > 0) bq_set(&s->bq[1], BQ_LP, sr, p[6], 0.707f, 0);
    break;
  case FX_DYNEQ:
    for (int k = 0; k < 2; k++) bq_set(&s->bq[k], BQ_BP, sr, p[k * 7 + 1], p[k * 7 + 2], 0);
    break;
  case FX_DELAY:
    bq_set(&s->bq[0], BQ_LP, sr, p[3] > 0 ? p[3] : 20000, 0.707f, 0);
    break;
  }
}

// ---------------------------------------------------------------- processors

static void runEq(fxslot *s, float **ch, int nch, int n) {
  const float *p = s->p;
  int hp = p[0] > 0.5f, lp = p[2] > 0.5f;
  int bon[4];
  for (int k = 0; k < 4; k++) bon[k] = p[4 + k * 5] > 0.5f;
  for (int c = 0; c < nch; c++) {
    float *x = ch[c];
    for (int i = 0; i < n; i++) {
      float v = x[i];
      if (hp) v = bq_run(&s->bq[1], c, bq_run(&s->bq[0], c, v));
      if (lp) v = bq_run(&s->bq[2], c, v);
      for (int k = 0; k < 4; k++)
        if (bon[k]) v = bq_run(&s->bq[3 + k], c, v);
      x[i] = v;
    }
  }
}

static void runComp(fxslot *s, float **ch, int nch, int n, float sr) {
  const float *p = s->p;
  float thr = p[0], ratio = p[1] < 1 ? 1 : p[1], knee = p[4] < 0 ? 0 : p[4];
  float makeup = p[5], mix = p[7] < 0 ? 0 : (p[7] > 1 ? 1 : p[7]);
  int model = (int)p[6];
  float attMs = p[2], relMs = p[3];
  if (model == 1) { attMs *= 0.25f; relMs *= 0.6f; }       // FET: fast
  if (model == 2) { attMs *= 2.0f; if (knee < 10) knee = 10; } // Opto: slow, soft
  if (model == 3) { if (knee < 15) knee = 15; }             // Vari-Mu: very soft
  float att = msCoef(attMs, sr), rel = msCoef(relMs, sr);
  float relSlow = msCoef(relMs * 4.0f, sr);
  int sc = p[8] > 0;
  float maxGr = 0;
  for (int i = 0; i < n; i++) {
    float peak = 0;
    for (int c = 0; c < nch; c++) {
      float d = sc ? bq_run(&s->bq[0], c, ch[c][i]) : ch[c][i];
      d = fabsf(d);
      if (d > peak) peak = d;
    }
    float lv = lin2db(peak);
    float over = lv - thr;
    float r = ratio;
    if (model == 3 && over > 0) r = 1.0f + (ratio - 1.0f) * fminf(1.0f, over / 12.0f);
    float slope = 1.0f - 1.0f / r;
    float gr;
    if (knee > 0 && over > -knee / 2 && over < knee / 2) {
      float t = over + knee / 2;
      gr = slope * t * t / (2 * knee);
    } else {
      gr = over > 0 ? slope * over : 0;
    }
    float e = s->env[0];
    if (gr > e) e += (gr - e) * att;
    else e += (gr - e) * ((model == 2 && e < 3.0f) ? relSlow : rel);
    s->env[0] = e;
    if (e > maxGr) maxGr = e;
    float g = db2lin(makeup - e);
    for (int c = 0; c < nch; c++) {
      float dry = ch[c][i];
      float wet = dry * g;
      if (model == 1) wet = tanhf(wet * 1.2f) / 1.2f;          // FET grit
      else if (model == 3) wet = wet - 0.04f * wet * wet * wet; // tube warmth
      ch[c][i] = dry + (wet - dry) * mix;
    }
  }
  grReport(s, maxGr);
}

static void runGate(fxslot *s, float **ch, int nch, int n, float sr) {
  const float *p = s->p;
  float thr = p[0], range = db2lin(p[1] > 0 ? 0 : p[1]);
  float att = msCoef(p[2], sr), rel = msCoef(p[4], sr);
  int hold = (int)(p[3] * 0.001f * sr);
  float hyst = p[7] < 0 ? 0 : p[7];
  int hp = p[5] > 0, lp = p[6] > 0;
  float minG = 1;
  for (int i = 0; i < n; i++) {
    float peak = 0;
    for (int c = 0; c < nch; c++) {
      float d = ch[c][i];
      if (hp) d = bq_run(&s->bq[0], c, d);
      if (lp) d = bq_run(&s->bq[1], c, d);
      d = fabsf(d);
      if (d > peak) peak = d;
    }
    // Fast peak follower so a single zero crossing does not close the gate.
    s->env[0] = peak > s->env[0] ? peak : s->env[0] * 0.999f;
    float lv = lin2db(s->env[0]);
    if (lv > thr) { s->gateOpen = 1; s->holdCount = hold; }
    else if (lv < thr - hyst) {
      if (s->holdCount > 0) s->holdCount--;
      else s->gateOpen = 0;
    }
    float target = s->gateOpen ? 1.0f : range;
    s->gainEnv += (target - s->gainEnv) * (target > s->gainEnv ? att : rel);
    if (s->gainEnv < minG) minG = s->gainEnv;
    for (int c = 0; c < nch; c++) ch[c][i] *= s->gainEnv;
  }
  grReport(s, -lin2db(minG));
}

static void runLimiter(fxslot *s, float **ch, int nch, int n, float sr) {
  const float *p = s->p;
  float ceil = db2lin(p[0] > 0 ? 0 : p[0]);
  float inGain = db2lin(p[2]);
  float rel = msCoef(p[1] > 1 ? p[1] : 1, sr);
  float att = 1.0f - expf(-4.0f / LIM_LOOKAHEAD);
  float minG = 1;
  for (int i = 0; i < n; i++) {
    float peak = 0;
    for (int c = 0; c < nch; c++) {
      float x = ch[c][i] * inGain;
      ch[c][i] = x;
      if (fabsf(x) > peak) peak = fabsf(x);
    }
    float need = peak > ceil ? ceil / peak : 1.0f;
    if (need < s->gainEnv) s->gainEnv += (need - s->gainEnv) * att;
    else s->gainEnv += (need - s->gainEnv) * rel;
    // Track the minimum required gain across the lookahead window.
    if (need < s->gainEnv) s->gainEnv = need < s->gainEnv * 0.5f ? s->gainEnv * 0.5f : s->gainEnv;
    float g = s->gainEnv;
    if (g < minG) minG = g;
    for (int c = 0; c < nch; c++) {
      float delayed = s->lim[c][s->limPos];
      s->lim[c][s->limPos] = ch[c][i];
      float y = delayed * g;
      if (y > ceil) y = ceil;
      if (y < -ceil) y = -ceil;
      ch[c][i] = y;
    }
    s->limPos = (s->limPos + 1) % LIM_LOOKAHEAD;
  }
  grReport(s, -lin2db(minG));
}

static void runDynEq(fxslot *s, float **ch, int nch, int n, float sr) {
  const float *p = s->p;
  const int sub = 32;
  float maxGr = 0;
  for (int i0 = 0; i0 < n; i0 += sub) {
    int m = n - i0 < sub ? n - i0 : sub;
    for (int k = 0; k < 2; k++) {
      const float *b = p + k * 7;
      if (b[0] < 0.5f) continue;
      float att = msCoef(b[5], sr), rel = msCoef(b[6], sr);
      // Detector: band-passed level.
      for (int i = 0; i < m; i++) {
        float pk = 0;
        for (int c = 0; c < nch; c++) {
          float d = fabsf(bq_run(&s->bq[k], c, ch[c][i0 + i]));
          if (d > pk) pk = d;
        }
        s->env[k] += (pk - s->env[k]) * (pk > s->env[k] ? att : rel);
      }
      float over = lin2db(s->env[k]) - b[3];
      float range = b[4], g = 0;
      if (over > 0) {
        g = (range < 0 ? -over : over) * 0.66f;
        if (range < 0 && g < range) g = range;
        if (range > 0 && g > range) g = range;
      }
      s->dynGain[k] = g;
      if (-g > maxGr) maxGr = -g;
      if (fabsf(g) > 0.05f) {
        bq_set(&s->bq[2 + k], BQ_PEAK, sr, b[1], b[2], g);
        for (int c = 0; c < nch; c++)
          for (int i = 0; i < m; i++) ch[c][i0 + i] = bq_run(&s->bq[2 + k], c, ch[c][i0 + i]);
      }
    }
  }
  grReport(s, maxGr);
}

static void runDelay(fxslot *s, float **ch, int nch, int n, float sr) {
  if (!s->delayBuf[0]) return;
  const float *p = s->p;
  int d = (int)(p[0] * 0.001f * sr);
  if (d < 1) d = 1;
  if (d >= s->delayLen) d = s->delayLen - 1;
  float fb = p[1] < 0 ? 0 : (p[1] > 0.95f ? 0.95f : p[1]);
  float mix = p[2];
  int ping = p[4] > 0.5f && nch == 2;
  for (int i = 0; i < n; i++) {
    int rp = s->delayPos - d;
    if (rp < 0) rp += s->delayLen;
    float out[FX_MAX_CH];
    for (int c = 0; c < nch; c++) out[c] = s->delayBuf[c][rp];
    for (int c = 0; c < nch; c++) {
      float fbSrc = ping ? out[1 - c] : out[c];
      float in = ping && c == 1 ? 0 : ch[c][i];
      if (ping && c == 0) in = (ch[0][i] + ch[1][i]) * 0.5f;
      s->delayBuf[c][s->delayPos] = in + bq_run(&s->bq[0], c, fbSrc) * fb;
      ch[c][i] += out[c] * mix;
    }
    s->delayPos = (s->delayPos + 1) % s->delayLen;
  }
}

static void runReverb(fxslot *s, float **ch, int nch, int n) {
  freeverb *v = s->verb;
  if (!v) return;
  const float *p = s->p;
  float fb = p[0] * 0.28f + 0.7f, damp = p[1] * 0.4f, mix = p[2], width = p[3];
  float wet1 = mix * (width / 2 + 0.5f), wet2 = mix * ((1 - width) / 2);
  for (int i = 0; i < n; i++) {
    float in = (nch == 2 ? (ch[0][i] + ch[1][i]) : ch[0][i]) * 0.015f;
    float out[2] = {0, 0};
    for (int c = 0; c < 2; c++) {
      for (int k = 0; k < FV_COMBS; k++) {
        fvline *l = &v->comb[c][k];
        float y = l->buf[l->pos];
        l->store = y * (1 - damp) + l->store * damp;
        l->buf[l->pos] = in + l->store * fb;
        if (++l->pos >= l->len) l->pos = 0;
        out[c] += y;
      }
      for (int k = 0; k < FV_APS; k++) {
        fvline *l = &v->ap[c][k];
        float b = l->buf[l->pos];
        float y = -out[c] + b;
        l->buf[l->pos] = out[c] + b * 0.5f;
        if (++l->pos >= l->len) l->pos = 0;
        out[c] = y;
      }
    }
    if (nch == 2) {
      ch[0][i] += out[0] * wet1 + out[1] * wet2;
      ch[1][i] += out[1] * wet1 + out[0] * wet2;
    } else {
      ch[0][i] += (out[0] + out[1]) * 0.5f * mix;
    }
  }
}

void fx_process(fxslot *s, float **ch, int nch, int n, float sr) {
  int type = atomic_load_explicit(&s->type, memory_order_acquire);
  int ver = atomic_load_explicit(&s->version, memory_order_acquire);
  if (type != s->curType) {
    s->curType = type;
    resetState(s);
    s->seenVersion = ver - 1;
  }
  if (type == FX_NONE || !atomic_load_explicit(&s->on, memory_order_relaxed)) return;
  if (ver != s->seenVersion || sr != s->curSr) {
    s->seenVersion = ver;
    s->curSr = sr;
    updateCoefs(s, sr);
  }
  if (nch > FX_MAX_CH) nch = FX_MAX_CH;
  switch (type) {
  case FX_EQ: runEq(s, ch, nch, n); break;
  case FX_COMP: runComp(s, ch, nch, n, sr); break;
  case FX_GATE: runGate(s, ch, nch, n, sr); break;
  case FX_LIMITER: runLimiter(s, ch, nch, n, sr); break;
  case FX_DYNEQ: runDynEq(s, ch, nch, n, sr); break;
  case FX_DELAY: runDelay(s, ch, nch, n, sr); break;
  case FX_REVERB: runReverb(s, ch, nch, n); break;
  }
}
