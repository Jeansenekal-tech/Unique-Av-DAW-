// WAV reading and writing. Recorded files are Broadcast WAV (BWF) with a
// `bext` chunk carrying the session time stamp, so the takes line up when
// they are imported into Pro Tools, Logic, Reaper, Waves Tracks Live etc.
#pragma once
#include <stdint.h>
#include <stdio.h>

typedef struct {
  FILE *fp;
  int bits;      // 16, 24 or 32 (32 = float)
  int channels;
  int sampleRate;
  int64_t frames;
  long riffSizePos, dataSizePos;
  int64_t dataStart;
} wav_writer;

int wav_open_write(wav_writer *w, const char *path, int sampleRate, int channels, int bits,
                   int64_t timeReference, const char *description);
// Writes interleaved float frames.
int wav_write_float(wav_writer *w, const float *interleaved, int frames);
// Rewrites the size fields so the file is valid even if the app crashes later.
void wav_update_header(wav_writer *w);
void wav_close(wav_writer *w);

typedef struct {
  FILE *fp;
  int format; // 1 = PCM, 3 = float
  int bits;
  int channels;
  int sampleRate;
  int blockAlign;
  int64_t dataStart;
  int64_t frames;
  int64_t nextFrame; // file position cache, in frames
} wav_reader;

int wav_open_read(wav_reader *r, const char *path);
// Reads up to `frames` frames of one channel starting at `frame` into out
// (as float). Returns the number of frames read.
int wav_read_channel(wav_reader *r, int64_t frame, int frames, int channel, float *out,
                     uint8_t *scratch, size_t scratchSize);
void wav_close_read(wav_reader *r);
