// Built-in processors: EQ, compressor (4 models), noise gate, limiter,
// dynamic EQ, delay and reverb. Every processor runs in an insert slot and
// works on 1 (track) or 2 (bus) channels.
#pragma once
#include <stdatomic.h>
#include <stddef.h>
#include <math.h>

#define FX_PARAMS 24
#define FX_MAX_CH 2

enum {
  FX_NONE = 0,
  FX_EQ = 1,
  FX_COMP = 2,
  FX_GATE = 3,
  FX_LIMITER = 4,
  FX_DYNEQ = 5,
  FX_DELAY = 6,
  FX_REVERB = 7,
  FX_TYPE_COUNT
};

enum { BQ_PEAK = 0, BQ_LOWSHELF, BQ_HIGHSHELF, BQ_HP, BQ_LP, BQ_NOTCH, BQ_BP };

typedef struct {
  float b0, b1, b2, a1, a2;
  float z1[FX_MAX_CH], z2[FX_MAX_CH];
} biquad;

void bq_set(biquad *b, int type, float sr, float freq, float q, float gainDb);
void bq_reset(biquad *b);
static inline float bq_run(biquad *b, int c, float x) {
  float y = b->b0 * x + b->z1[c];
  b->z1[c] = b->b1 * x - b->a1 * y + b->z2[c];
  b->z2[c] = b->b2 * x - b->a2 * y;
  return y;
}

#define DELAY_MAX_SEC 2.0f
#define LIM_LOOKAHEAD 64

typedef struct freeverb freeverb;

typedef struct {
  // Written by the control thread; read by the audio thread.
  _Atomic int type;
  _Atomic int on;
  float p[FX_PARAMS];
  _Atomic int version; // bumped after every parameter write

  // Audio-thread state.
  int curType;
  int seenVersion;
  float sr, curSr;
  biquad bq[8];
  float env[FX_MAX_CH];
  float gainEnv;
  int holdCount;
  int gateOpen;
  float lim[FX_MAX_CH][LIM_LOOKAHEAD];
  int limPos;
  float dynGain[2];

  // Delay/reverb memory, allocated by the control thread before the type is
  // published and kept for the lifetime of the slot.
  float *delayBuf[FX_MAX_CH];
  int delayLen;
  int delayPos;
  freeverb *verb;

  _Atomic float grMeter; // gain reduction in dB (positive), max since read
} fxslot;

// Control thread: change type and parameters. Allocates memory if needed.
void fx_configure(fxslot *s, int type, int on, const float *params, int nparams, float sr);
void fx_free(fxslot *s);
// Audio thread.
void fx_process(fxslot *s, float **ch, int nch, int n, float sr);

static inline float db2lin(float db) {
  return powf(10.0f, db * 0.05f);
}
