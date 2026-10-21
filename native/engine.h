// Audio engine: multichannel device I/O (Core Audio on macOS, so Dante
// Virtual Soundcard, Waves SoundGrid / QRec, MADI, AVB, USB and Thunderbolt
// interfaces all appear as ordinary devices), recording, playback for
// virtual soundcheck, the mixer and the broadcast output.
#pragma once
#include <stdatomic.h>
#include <stdint.h>
#include <pthread.h>
#include "dsp.h"
#include "wav.h"

#define MAX_TRACKS 128
#define MAX_BUSES 16 // bus 0 is the master
#define MAX_FX 6
#define BLOCK 512
#define MAX_IO 256
#define PLAY_RING (1 << 17)
#define PEAK_SPP 1024 // samples per waveform peak

typedef struct {
  char *path;
  int64_t start, offset, length;
  int channel;
  float gain;
  wav_reader rd;
} clip;

typedef struct {
  // Parameters (control thread writes, audio thread reads).
  _Atomic int input;  // capture channel, -1 = none
  _Atomic int hwOut;  // playback channel for virtual soundcheck, -1 = none
  _Atomic int mute, solo, phase, armed;
  _Atomic int dest;   // bus index; 0 = master, -1 = none
  _Atomic float trim, fader, pan;
  _Atomic float send[MAX_BUSES];
  _Atomic int sendPre[MAX_BUSES];
  fxslot fx[MAX_FX];

  // Playback ring (reader thread writes, audio thread reads).
  float *ring;
  _Atomic size_t rw, rr;
  int64_t readPos;
  clip *clips;
  int nclips;
  pthread_mutex_t clipMutex;

  // Audio thread state.
  float gL, gR, sendG[MAX_BUSES];

  // Meters: max since last read.
  _Atomic float mIn, mOut;

  // Recording (writer thread).
  wav_writer rec;
  char *recPath;
  int8_t *peaks;
  size_t npeaks, peaksCap;
  float pkMin, pkMax;
  int pkCount;
} track;

typedef struct {
  _Atomic float fader, pan;
  _Atomic int mute;
  _Atomic int toMaster;
  _Atomic int feedMaster; // receives the master mix (broadcast bus)
  _Atomic int hwOut;      // first channel of the output pair, -1 = none
  _Atomic int toBcDevice; // also feeds the separate broadcast device
  _Atomic int tap;        // feeds the stream encoder
  fxslot fx[MAX_FX];
  float buf[2][BLOCK];
  float g[2];
  _Atomic float mL, mR;
} bus;

typedef struct {
  float sr;
  int inCh, outCh;
  int ntracks, nbuses;
  track tracks[MAX_TRACKS];
  bus buses[MAX_BUSES];

  _Atomic int running;
  _Atomic int source; // 0 = live inputs, 1 = playback (virtual soundcheck)
  _Atomic int anySolo;
  _Atomic int playing;
  _Atomic int64_t pos;
  _Atomic int loopOn;
  _Atomic int64_t loopStart, loopEnd;

  // Seek handshake between control, reader and audio threads.
  _Atomic int seekGen, readerAck, audioAck, prefilled;
  _Atomic int64_t seekPos;

  // Recording.
  _Atomic int recPending, recording;
  _Atomic int64_t recStart;
  int recCount;
  int recMap[MAX_TRACKS];
  float *recRing;
  size_t recCap; // floats, multiple of recCount
  _Atomic size_t recW, recR;
  _Atomic int recDropped;
  _Atomic int writerRun;
  pthread_t writer;
  pthread_mutex_t peaksMutex;
  int recBits;

  // Broadcast device and stream tap (stereo float rings).
  float *bcRing;
  size_t bcCap;
  _Atomic size_t bcW, bcR;
  _Atomic int bcHwOut;
  float *tapRing;
  size_t tapCap;
  _Atomic size_t tapW, tapR;

  // Threads.
  _Atomic int readerRun, readerPause, readerPaused;
  pthread_t reader;
  _Atomic uint64_t blocks;
  _Atomic int xruns;
  _Atomic float cpu;

  // Offline export: per-track post-fader stereo, or NULL.
  float (*stems)[2][BLOCK];
} engine;

extern engine E;

void engine_init(void);
void engine_set_sample_rate(float sr);
// Audio callback body: interleaved input/output.
void engine_process(const float *in, float *out, int frames);
void engine_reader_start(void);
void engine_reader_stop(void);
int engine_fill_track(track *t, int64_t at, float *dst, int frames);
void engine_locate(int64_t pos);
int engine_record_start(const char *dir, const char *prefix, int bits);
int engine_record_stop(void);
int engine_set_clips(int t, clip *clips, int n);
void engine_bc_push(const float *l, const float *r, int n);
