#include "wav.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if defined(_WIN32)
#define fseek64 _fseeki64
#define ftell64 _ftelli64
#else
#define fseek64 fseeko
#define ftell64 ftello
#endif

static void put16(uint8_t *p, uint16_t v) { p[0] = v & 255; p[1] = v >> 8; }
static void put32(uint8_t *p, uint32_t v) {
  p[0] = v & 255; p[1] = (v >> 8) & 255; p[2] = (v >> 16) & 255; p[3] = v >> 24;
}
static uint16_t get16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t get32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

#define BEXT_SIZE 602

int wav_open_write(wav_writer *w, const char *path, int sampleRate, int channels, int bits,
                   int64_t timeReference, const char *description) {
  memset(w, 0, sizeof *w);
  w->fp = fopen(path, "wb");
  if (!w->fp) return -1;
  setvbuf(w->fp, NULL, _IOFBF, 1 << 18);
  w->bits = bits;
  w->channels = channels;
  w->sampleRate = sampleRate;

  uint8_t h[12 + 8 + BEXT_SIZE + 8 + 18 + 8];
  memset(h, 0, sizeof h);
  size_t o = 0;
  memcpy(h + o, "RIFF", 4); o += 4;
  w->riffSizePos = (long)o; o += 4;
  memcpy(h + o, "WAVE", 4); o += 4;

  memcpy(h + o, "bext", 4); put32(h + o + 4, BEXT_SIZE); o += 8;
  uint8_t *b = h + o;
  if (description) strncpy((char *)b, description, 255);
  strncpy((char *)b + 256, "Unique AV DAW", 31);
  time_t now = time(NULL);
  struct tm tmv;
#if defined(_WIN32)
  localtime_s(&tmv, &now);
#else
  localtime_r(&now, &tmv);
#endif
  char date[11], tim[9];
  strftime(date, sizeof date, "%Y-%m-%d", &tmv);
  strftime(tim, sizeof tim, "%H:%M:%S", &tmv);
  memcpy(b + 256 + 32 + 32, date, 10);
  memcpy(b + 256 + 32 + 32 + 10, tim, 8);
  put32(b + 338, (uint32_t)(timeReference & 0xffffffffu));
  put32(b + 342, (uint32_t)((uint64_t)timeReference >> 32));
  put16(b + 346, 1); // BWF version
  o += BEXT_SIZE;

  int isFloat = bits == 32;
  int fmtSize = isFloat ? 18 : 16;
  memcpy(h + o, "fmt ", 4); put32(h + o + 4, (uint32_t)fmtSize); o += 8;
  int bytes = bits / 8;
  put16(h + o, isFloat ? 3 : 1);
  put16(h + o + 2, (uint16_t)channels);
  put32(h + o + 4, (uint32_t)sampleRate);
  put32(h + o + 8, (uint32_t)(sampleRate * channels * bytes));
  put16(h + o + 12, (uint16_t)(channels * bytes));
  put16(h + o + 14, (uint16_t)bits);
  o += (size_t)fmtSize;

  memcpy(h + o, "data", 4); o += 4;
  w->dataSizePos = (long)o; o += 4;
  w->dataStart = (int64_t)o;
  if (fwrite(h, 1, o, w->fp) != o) {
    fclose(w->fp);
    w->fp = NULL;
    return -1;
  }
  return 0;
}

int wav_write_float(wav_writer *w, const float *in, int frames) {
  int n = frames * w->channels;
  int bytes = w->bits / 8;
  uint8_t tmp[4096 * 3];
  int per = (int)(sizeof tmp / (size_t)bytes);
  for (int i0 = 0; i0 < n; i0 += per) {
    int m = n - i0 < per ? n - i0 : per;
    uint8_t *p = tmp;
    for (int i = 0; i < m; i++) {
      float x = in[i0 + i];
      if (w->bits == 32) {
        memcpy(p, &x, 4);
        p += 4;
        continue;
      }
      if (x > 1.0f) x = 1.0f;
      if (x < -1.0f) x = -1.0f;
      if (w->bits == 24) {
        int32_t v = (int32_t)lrintf(x * 8388607.0f);
        p[0] = v & 255; p[1] = (v >> 8) & 255; p[2] = (v >> 16) & 255;
        p += 3;
      } else {
        int16_t v = (int16_t)lrintf(x * 32767.0f);
        p[0] = v & 255; p[1] = (v >> 8) & 255;
        p += 2;
      }
    }
    size_t len = (size_t)(p - tmp);
    if (fwrite(tmp, 1, len, w->fp) != len) return -1;
  }
  w->frames += frames;
  return 0;
}

void wav_update_header(wav_writer *w) {
  if (!w->fp) return;
  int64_t dataBytes = w->frames * w->channels * (w->bits / 8);
  uint8_t v[4];
  int64_t end = ftell64(w->fp);
  put32(v, (uint32_t)(w->dataStart + dataBytes - 8));
  fseek64(w->fp, w->riffSizePos, SEEK_SET);
  fwrite(v, 1, 4, w->fp);
  put32(v, (uint32_t)dataBytes);
  fseek64(w->fp, w->dataSizePos, SEEK_SET);
  fwrite(v, 1, 4, w->fp);
  fseek64(w->fp, end, SEEK_SET);
  fflush(w->fp);
}

void wav_close(wav_writer *w) {
  if (!w->fp) return;
  int64_t dataBytes = w->frames * w->channels * (w->bits / 8);
  if (dataBytes & 1) fputc(0, w->fp); // RIFF chunks are word aligned
  wav_update_header(w);
  fclose(w->fp);
  w->fp = NULL;
}

int wav_open_read(wav_reader *r, const char *path) {
  memset(r, 0, sizeof *r);
  r->fp = fopen(path, "rb");
  if (!r->fp) return -1;
  uint8_t h[12];
  if (fread(h, 1, 12, r->fp) != 12 || memcmp(h, "RIFF", 4) || memcmp(h + 8, "WAVE", 4)) goto fail;
  int haveFmt = 0;
  for (;;) {
    uint8_t ch[8];
    if (fread(ch, 1, 8, r->fp) != 8) goto fail;
    uint32_t size = get32(ch + 4);
    if (!memcmp(ch, "fmt ", 4)) {
      uint8_t f[40];
      uint32_t take = size < sizeof f ? size : (uint32_t)sizeof f;
      if (fread(f, 1, take, r->fp) != take) goto fail;
      r->format = get16(f);
      r->channels = get16(f + 2);
      r->sampleRate = (int)get32(f + 4);
      r->blockAlign = get16(f + 12);
      r->bits = get16(f + 14);
      if (r->format == 0xFFFE && take >= 26) r->format = get16(f + 24); // extensible
      fseek64(r->fp, (int64_t)(size - take + (size & 1)), SEEK_CUR);
      haveFmt = 1;
    } else if (!memcmp(ch, "data", 4)) {
      if (!haveFmt || r->blockAlign <= 0) goto fail;
      r->dataStart = ftell64(r->fp);
      fseek64(r->fp, 0, SEEK_END);
      int64_t avail = ftell64(r->fp) - r->dataStart;
      // Size 0 or 0xFFFFFFFF means the writer never finished (crash
      // recovery, or a file still being recorded): use the file length.
      int64_t declared = size;
      if (declared == 0 || declared == 0xFFFFFFFFll || declared > avail) declared = avail;
      r->frames = declared / r->blockAlign;
      r->nextFrame = -1;
      break;
    } else {
      fseek64(r->fp, (int64_t)size + (size & 1), SEEK_CUR);
    }
  }
  if (!((r->format == 1 && (r->bits == 16 || r->bits == 24 || r->bits == 32)) ||
        (r->format == 3 && r->bits == 32)))
    goto fail;
  setvbuf(r->fp, NULL, _IOFBF, 1 << 16);
  return 0;
fail:
  fclose(r->fp);
  r->fp = NULL;
  return -1;
}

int wav_read_channel(wav_reader *r, int64_t frame, int frames, int channel, float *out,
                     uint8_t *scratch, size_t scratchSize) {
  if (!r->fp || frame < 0 || frame >= r->frames) return 0;
  if (frame + frames > r->frames) frames = (int)(r->frames - frame);
  if (channel >= r->channels) channel = 0;
  int bytes = r->bits / 8;
  int done = 0;
  if (r->nextFrame != frame) fseek64(r->fp, r->dataStart + frame * r->blockAlign, SEEK_SET);
  while (done < frames) {
    int m = (int)(scratchSize / (size_t)r->blockAlign);
    if (m > frames - done) m = frames - done;
    size_t got = fread(scratch, (size_t)r->blockAlign, (size_t)m, r->fp);
    for (size_t i = 0; i < got; i++) {
      const uint8_t *p = scratch + i * (size_t)r->blockAlign + (size_t)channel * (size_t)bytes;
      float v;
      if (r->format == 3) memcpy(&v, p, 4);
      else if (bytes == 2) v = (int16_t)get16(p) / 32768.0f;
      else if (bytes == 3) v = (float)((int32_t)((uint32_t)p[0] << 8 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 24) >> 8) / 8388608.0f;
      else v = (float)((int32_t)get32(p) / 2147483648.0);
      out[done + (int)i] = v;
    }
    done += (int)got;
    if ((int)got < m) break;
  }
  r->nextFrame = frame + done;
  return done;
}

void wav_close_read(wav_reader *r) {
  if (r->fp) fclose(r->fp);
  r->fp = NULL;
}
