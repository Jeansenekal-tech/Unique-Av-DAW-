// Node-API bindings. The addon is loaded once, in Electron's main process.
#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_ENCODING
#define MA_NO_DECODING
#define MA_NO_GENERATION
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#include "vendor/miniaudio.h"

#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include "engine.h"

static ma_context ctx;
static int ctxReady = 0;
static int ctxNull = 0;
static ma_device dev;
static int devOpen = 0;
static ma_device bcDev;
static int bcOpen = 0;
static int bcChannels = 2;

static ma_device_info *capInfos, *playInfos;
static ma_uint32 capCount, playCount;

#define CHECK(call) do { if ((call) != napi_ok) { napi_throw_error(env, NULL, "N-API call failed: " #call); return NULL; } } while (0)

static napi_value throwErr(napi_env env, const char *msg) {
  napi_throw_error(env, NULL, msg);
  return NULL;
}

static napi_value undef(napi_env env) {
  napi_value u;
  napi_get_undefined(env, &u);
  return u;
}

static napi_value num(napi_env env, double v) {
  napi_value r;
  napi_create_double(env, v, &r);
  return r;
}

static napi_value str(napi_env env, const char *s) {
  napi_value r;
  napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &r);
  return r;
}

static void setProp(napi_env env, napi_value obj, const char *k, napi_value v) {
  napi_set_named_property(env, obj, k, v);
}

static int hasProp(napi_env env, napi_value obj, const char *k) {
  bool has = false;
  napi_has_named_property(env, obj, k, &has);
  if (!has) return 0;
  napi_value v;
  napi_valuetype t;
  napi_get_named_property(env, obj, k, &v);
  napi_typeof(env, v, &t);
  return t != napi_undefined && t != napi_null;
}

static double getNum(napi_env env, napi_value obj, const char *k, double def) {
  if (!hasProp(env, obj, k)) return def;
  napi_value v;
  double d = def;
  napi_get_named_property(env, obj, k, &v);
  if (napi_get_value_double(env, v, &d) != napi_ok) {
    bool b;
    if (napi_get_value_bool(env, v, &b) == napi_ok) d = b ? 1 : 0;
  }
  return d;
}

static char *getStr(napi_env env, napi_value v) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) return NULL;
  char *s = malloc(len + 1);
  napi_get_value_string_utf8(env, v, s, len + 1, &len);
  return s;
}

static char *getStrProp(napi_env env, napi_value obj, const char *k) {
  if (!hasProp(env, obj, k)) return NULL;
  napi_value v;
  napi_get_named_property(env, obj, k, &v);
  return getStr(env, v);
}

static int args(napi_env env, napi_callback_info info, napi_value *argv, size_t n) {
  size_t argc = n;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  return (int)argc;
}

static int argInt(napi_env env, napi_value v, int def) {
  int32_t i;
  return napi_get_value_int32(env, v, &i) == napi_ok ? i : def;
}

// ---------------------------------------------------------------- devices

static int ensureContext(int useNull) {
  if (ctxReady && ctxNull == useNull) return 0;
  if (ctxReady) {
    ma_context_uninit(&ctx);
    ctxReady = 0;
  }
  ma_backend nullBackend[] = {ma_backend_null};
  ma_context_config cfg = ma_context_config_init();
  if (ma_context_init(useNull ? nullBackend : NULL, useNull ? 1 : 0, &cfg, &ctx) != MA_SUCCESS) return -1;
  ctxReady = 1;
  ctxNull = useNull;
  return 0;
}

static int deviceChannels(ma_device_type type, ma_device_info *info) {
  ma_device_info full;
  int best = 0;
  if (ma_context_get_device_info(&ctx, type, &info->id, &full) == MA_SUCCESS) {
    for (ma_uint32 i = 0; i < full.nativeDataFormatCount; i++)
      if ((int)full.nativeDataFormats[i].channels > best) best = (int)full.nativeDataFormats[i].channels;
  }
  return best ? best : 2;
}

static napi_value deviceList(napi_env env, ma_device_type type, ma_device_info *infos, ma_uint32 count) {
  napi_value arr;
  napi_create_array_with_length(env, count, &arr);
  for (ma_uint32 i = 0; i < count; i++) {
    napi_value o;
    napi_create_object(env, &o);
    setProp(env, o, "index", num(env, i));
    setProp(env, o, "name", str(env, infos[i].name));
    setProp(env, o, "channels", num(env, deviceChannels(type, &infos[i])));
    napi_value d;
    napi_get_boolean(env, infos[i].isDefault, &d);
    setProp(env, o, "isDefault", d);
    napi_set_element(env, arr, i, o);
  }
  return arr;
}

static napi_value ListDevices(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int argc = args(env, info, argv, 1);
  int useNull = argc > 0 ? (int)getNum(env, argv[0], "nullBackend", 0) : 0;
  if (ensureContext(useNull)) return throwErr(env, "Could not start the audio system");
  if (ma_context_get_devices(&ctx, &playInfos, &playCount, &capInfos, &capCount) != MA_SUCCESS)
    return throwErr(env, "Could not list audio devices");
  napi_value o;
  napi_create_object(env, &o);
  setProp(env, o, "backend", str(env, ma_get_backend_name(ctx.backend)));
  setProp(env, o, "inputs", deviceList(env, ma_device_type_capture, capInfos, capCount));
  setProp(env, o, "outputs", deviceList(env, ma_device_type_playback, playInfos, playCount));
  return o;
}

static void dataCallback(ma_device *d, void *out, const void *in, ma_uint32 frames) {
  (void)d;
  engine_process((const float *)in, (float *)out, (int)frames);
}

static void closeDevice(void) {
  if (!devOpen) return;
  ma_device_uninit(&dev);
  devOpen = 0;
  atomic_store(&E.running, 0);
}

// open({ input, output, inputChannels, outputChannels, sampleRate, bufferSize })
static napi_value Open(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (args(env, info, argv, 1) < 1) return throwErr(env, "open() needs options");
  int useNull = (int)getNum(env, argv[0], "nullBackend", 0);
  if (ensureContext(useNull)) return throwErr(env, "Could not start the audio system");
  if (!capInfos && !playInfos)
    ma_context_get_devices(&ctx, &playInfos, &playCount, &capInfos, &capCount);
  closeDevice();

  int inIdx = (int)getNum(env, argv[0], "input", -1);
  int outIdx = (int)getNum(env, argv[0], "output", -1);
  int inCh = (int)getNum(env, argv[0], "inputChannels", 0);
  int outCh = (int)getNum(env, argv[0], "outputChannels", 0);
  int sr = (int)getNum(env, argv[0], "sampleRate", 48000);
  int buf = (int)getNum(env, argv[0], "bufferSize", 256);
  if (inIdx >= (int)capCount) inIdx = -1;
  if (outIdx >= (int)playCount) outIdx = -1;
  if (inIdx < 0 && outIdx < 0) return throwErr(env, "Choose an input or an output device");
  if (inIdx >= 0 && inCh <= 0) inCh = deviceChannels(ma_device_type_capture, &capInfos[inIdx]);
  if (outIdx >= 0 && outCh <= 0) outCh = deviceChannels(ma_device_type_playback, &playInfos[outIdx]);
  if (inCh > MAX_IO) inCh = MAX_IO;
  if (outCh > MAX_IO) outCh = MAX_IO;

  ma_device_type type = inIdx >= 0 && outIdx >= 0 ? ma_device_type_duplex
                        : inIdx >= 0 ? ma_device_type_capture : ma_device_type_playback;
  ma_device_config cfg = ma_device_config_init(type);
  cfg.sampleRate = (ma_uint32)sr;
  cfg.periodSizeInFrames = (ma_uint32)buf;
  cfg.performanceProfile = ma_performance_profile_low_latency;
  cfg.noPreSilencedOutputBuffer = MA_TRUE;
  cfg.noClip = MA_TRUE;
  cfg.dataCallback = dataCallback;
  if (inIdx >= 0) {
    cfg.capture.pDeviceID = &capInfos[inIdx].id;
    cfg.capture.format = ma_format_f32;
    cfg.capture.channels = (ma_uint32)inCh;
    cfg.capture.shareMode = ma_share_mode_shared;
  }
  if (outIdx >= 0) {
    cfg.playback.pDeviceID = &playInfos[outIdx].id;
    cfg.playback.format = ma_format_f32;
    cfg.playback.channels = (ma_uint32)outCh;
    cfg.playback.shareMode = ma_share_mode_shared;
  }
  engine_set_sample_rate((float)sr);
  E.inCh = inIdx >= 0 ? inCh : 0;
  E.outCh = outIdx >= 0 ? outCh : 0;
  if (ma_device_init(&ctx, &cfg, &dev) != MA_SUCCESS) return throwErr(env, "Could not open the audio device");
  devOpen = 1;
  E.sr = (float)dev.sampleRate;
  E.inCh = inIdx >= 0 ? (int)dev.capture.channels : 0;
  E.outCh = outIdx >= 0 ? (int)dev.playback.channels : 0;
  engine_reader_start();
  atomic_store(&E.running, 1);
  if (ma_device_start(&dev) != MA_SUCCESS) {
    closeDevice();
    return throwErr(env, "Could not start the audio device");
  }
  napi_value o;
  napi_create_object(env, &o);
  setProp(env, o, "sampleRate", num(env, E.sr));
  setProp(env, o, "inputChannels", num(env, E.inCh));
  setProp(env, o, "outputChannels", num(env, E.outCh));
  setProp(env, o, "bufferSize", num(env, type == ma_device_type_capture ? dev.capture.internalPeriodSizeInFrames
                                                                      : dev.playback.internalPeriodSizeInFrames));
  setProp(env, o, "backend", str(env, ma_get_backend_name(ctx.backend)));
  return o;
}

static napi_value Close(napi_env env, napi_callback_info info) {
  (void)info;
  engine_record_stop();
  closeDevice();
  return undef(env);
}

// ---------------------------------------------------------------- broadcast device

static void bcCallback(ma_device *d, void *outv, const void *in, ma_uint32 frames) {
  (void)d; (void)in;
  float *out = outv;
  int ch = bcChannels;
  int off = atomic_load(&E.bcHwOut);
  if (off < 0 || off + 1 >= ch) off = 0;
  memset(out, 0, sizeof(float) * frames * (size_t)ch);
  size_t r = atomic_load(&E.bcR);
  size_t avail = atomic_load(&E.bcW) - r;
  // Keep latency bounded when the two device clocks drift apart.
  size_t target = (size_t)frames * 2 * 4;
  if (avail > target * 3) {
    size_t skip = (avail - target) & ~(size_t)1;
    r += skip;
    avail -= skip;
  }
  size_t want = (size_t)frames * 2;
  size_t take = avail < want ? avail : want;
  for (size_t i = 0; i < take / 2; i++) {
    out[i * (size_t)ch + (size_t)off] = E.bcRing[(r + 2 * i) & (E.bcCap - 1)];
    out[i * (size_t)ch + (size_t)off + 1] = E.bcRing[(r + 2 * i + 1) & (E.bcCap - 1)];
  }
  atomic_store(&E.bcR, r + take);
}

static napi_value OpenBroadcast(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (args(env, info, argv, 1) < 1) return throwErr(env, "openBroadcast() needs options");
  if (bcOpen) { ma_device_uninit(&bcDev); bcOpen = 0; }
  int idx = (int)getNum(env, argv[0], "output", -1);
  if (idx < 0 || idx >= (int)playCount) return undef(env);
  int ch = deviceChannels(ma_device_type_playback, &playInfos[idx]);
  if (ch < 2) ch = 2;
  ma_device_config cfg = ma_device_config_init(ma_device_type_playback);
  cfg.playback.pDeviceID = &playInfos[idx].id;
  cfg.playback.format = ma_format_f32;
  cfg.playback.channels = (ma_uint32)ch;
  cfg.sampleRate = (ma_uint32)E.sr;
  cfg.periodSizeInFrames = 256;
  cfg.dataCallback = bcCallback;
  atomic_store(&E.bcHwOut, (int)getNum(env, argv[0], "channel", 0));
  if (ma_device_init(&ctx, &cfg, &bcDev) != MA_SUCCESS) return throwErr(env, "Could not open the broadcast device");
  bcChannels = (int)bcDev.playback.channels;
  bcOpen = 1;
  atomic_store(&E.bcR, atomic_load(&E.bcW));
  ma_device_start(&bcDev);
  return num(env, bcChannels);
}

static napi_value CloseBroadcast(napi_env env, napi_callback_info info) {
  (void)info;
  if (bcOpen) { ma_device_uninit(&bcDev); bcOpen = 0; }
  return undef(env);
}

// ---------------------------------------------------------------- mixer

static napi_value SetCounts(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  int argc = args(env, info, argv, 2);
  int nt = argc > 0 ? argInt(env, argv[0], E.ntracks) : E.ntracks;
  int nb = argc > 1 ? argInt(env, argv[1], E.nbuses) : E.nbuses;
  if (nt < 0) nt = 0;
  if (nt > MAX_TRACKS) nt = MAX_TRACKS;
  if (nb < 1) nb = 1;
  if (nb > MAX_BUSES) nb = MAX_BUSES;
  engine_reader_start(); // allocates the playback rings
  E.ntracks = nt;
  E.nbuses = nb;
  return undef(env);
}

static napi_value SetTrack(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (args(env, info, argv, 2) < 2) return throwErr(env, "setTrack(index, params)");
  int i = argInt(env, argv[0], -1);
  if (i < 0 || i >= MAX_TRACKS) return throwErr(env, "track index out of range");
  track *T = &E.tracks[i];
  napi_value o = argv[1];
#define SETI(k) if (hasProp(env, o, #k)) atomic_store(&T->k, (int)getNum(env, o, #k, 0))
#define SETF(k) if (hasProp(env, o, #k)) atomic_store(&T->k, (float)getNum(env, o, #k, 0))
  SETI(input); SETI(hwOut); SETI(mute); SETI(solo); SETI(phase); SETI(dest);
  SETF(trim); SETF(fader); SETF(pan);
  if (hasProp(env, o, "sends")) {
    napi_value arr;
    napi_get_named_property(env, o, "sends", &arr);
    uint32_t len = 0;
    napi_get_array_length(env, arr, &len);
    for (int b = 0; b < MAX_BUSES; b++) atomic_store(&T->send[b], 0.0f);
    for (uint32_t k = 0; k < len; k++) {
      napi_value s;
      napi_get_element(env, arr, k, &s);
      int b = (int)getNum(env, s, "bus", -1);
      if (b <= 0 || b >= MAX_BUSES) continue;
      atomic_store(&T->send[b], (float)getNum(env, s, "level", 0));
      atomic_store(&T->sendPre[b], (int)getNum(env, s, "pre", 0));
    }
  }
  if (hasProp(env, o, "recordPath")) {
    free(T->recPath);
    T->recPath = getStrProp(env, o, "recordPath");
    if (T->recPath && !*T->recPath) { free(T->recPath); T->recPath = NULL; }
  }
#undef SETI
#undef SETF
  return undef(env);
}

static napi_value SetBus(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (args(env, info, argv, 2) < 2) return throwErr(env, "setBus(index, params)");
  int i = argInt(env, argv[0], -1);
  if (i < 0 || i >= MAX_BUSES) return throwErr(env, "bus index out of range");
  bus *B = &E.buses[i];
  napi_value o = argv[1];
#define SETI(k) if (hasProp(env, o, #k)) atomic_store(&B->k, (int)getNum(env, o, #k, 0))
#define SETF(k) if (hasProp(env, o, #k)) atomic_store(&B->k, (float)getNum(env, o, #k, 0))
  SETF(fader); SETF(pan); SETI(mute); SETI(toMaster); SETI(feedMaster); SETI(hwOut); SETI(toBcDevice); SETI(tap);
#undef SETI
#undef SETF
  if (i == 0) {
    atomic_store(&B->toMaster, 0);
    atomic_store(&B->feedMaster, 0);
  }
  return undef(env);
}

// setInsert(kind 'track'|'bus', index, slot, { type, on, params })
static napi_value SetInsert(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  if (args(env, info, argv, 4) < 4) return throwErr(env, "setInsert(kind, index, slot, fx)");
  char *kind = getStr(env, argv[0]);
  int i = argInt(env, argv[1], -1), s = argInt(env, argv[2], -1);
  int isBus = kind && !strcmp(kind, "bus");
  free(kind);
  if (s < 0 || s >= MAX_FX) return throwErr(env, "slot out of range");
  fxslot *slot;
  if (isBus) {
    if (i < 0 || i >= MAX_BUSES) return throwErr(env, "bus index out of range");
    slot = &E.buses[i].fx[s];
  } else {
    if (i < 0 || i >= MAX_TRACKS) return throwErr(env, "track index out of range");
    slot = &E.tracks[i].fx[s];
  }
  int type = (int)getNum(env, argv[3], "type", 0);
  int on = (int)getNum(env, argv[3], "on", 1);
  float p[FX_PARAMS] = {0};
  int np = 0;
  if (hasProp(env, argv[3], "params")) {
    napi_value arr;
    napi_get_named_property(env, argv[3], "params", &arr);
    uint32_t len = 0;
    napi_get_array_length(env, arr, &len);
    for (uint32_t k = 0; k < len && k < FX_PARAMS; k++) {
      napi_value v;
      double d = 0;
      napi_get_element(env, arr, k, &v);
      napi_get_value_double(env, v, &d);
      p[k] = (float)d;
    }
    np = (int)(len < FX_PARAMS ? len : FX_PARAMS);
  }
  fx_configure(slot, type, on, p, np, E.sr);
  return undef(env);
}

static napi_value SetGlobal(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (args(env, info, argv, 1) < 1) return undef(env);
  napi_value o = argv[0];
  if (hasProp(env, o, "source")) atomic_store(&E.source, (int)getNum(env, o, "source", 0));
  if (hasProp(env, o, "anySolo")) atomic_store(&E.anySolo, (int)getNum(env, o, "anySolo", 0));
  if (hasProp(env, o, "loopOn")) atomic_store(&E.loopOn, (int)getNum(env, o, "loopOn", 0));
  if (hasProp(env, o, "loopStart")) atomic_store(&E.loopStart, (int64_t)getNum(env, o, "loopStart", 0));
  if (hasProp(env, o, "loopEnd")) atomic_store(&E.loopEnd, (int64_t)getNum(env, o, "loopEnd", 0));
  if (hasProp(env, o, "broadcastChannel")) atomic_store(&E.bcHwOut, (int)getNum(env, o, "broadcastChannel", 0));
  return undef(env);
}

// ---------------------------------------------------------------- clips

static napi_value SetClips(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (args(env, info, argv, 2) < 2) return throwErr(env, "setClips(track, clips)");
  int t = argInt(env, argv[0], -1);
  if (t < 0 || t >= MAX_TRACKS) return throwErr(env, "track index out of range");
  uint32_t len = 0;
  napi_get_array_length(env, argv[1], &len);
  clip *cl = calloc(len ? len : 1, sizeof(clip));
  int n = 0, failed = 0;
  for (uint32_t k = 0; k < len; k++) {
    napi_value o;
    napi_get_element(env, argv[1], k, &o);
    clip *C = &cl[n];
    C->path = getStrProp(env, o, "path");
    if (!C->path || wav_open_read(&C->rd, C->path) != 0) {
      free(C->path);
      failed++;
      continue;
    }
    C->start = (int64_t)getNum(env, o, "start", 0);
    C->offset = (int64_t)getNum(env, o, "offset", 0);
    C->length = (int64_t)getNum(env, o, "length", (double)C->rd.frames);
    C->channel = (int)getNum(env, o, "channel", 0);
    C->gain = (float)getNum(env, o, "gain", 1);
    n++;
  }
  engine_set_clips(t, cl, n);
  return num(env, failed);
}

static napi_value WavInfo(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (args(env, info, argv, 1) < 1) return throwErr(env, "wavInfo(path)");
  char *p = getStr(env, argv[0]);
  wav_reader r;
  int ok = p && wav_open_read(&r, p) == 0;
  free(p);
  if (!ok) {
    napi_value nul;
    napi_get_null(env, &nul);
    return nul;
  }
  napi_value o;
  napi_create_object(env, &o);
  setProp(env, o, "sampleRate", num(env, r.sampleRate));
  setProp(env, o, "channels", num(env, r.channels));
  setProp(env, o, "frames", num(env, (double)r.frames));
  setProp(env, o, "bits", num(env, r.bits));
  wav_close_read(&r);
  return o;
}

// ---------------------------------------------------------------- transport

static napi_value Play(napi_env env, napi_callback_info info) {
  (void)info;
  atomic_store(&E.playing, 1);
  return undef(env);
}

static napi_value Stop(napi_env env, napi_callback_info info) {
  (void)info;
  atomic_store(&E.playing, 0);
  return undef(env);
}

static napi_value Locate(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  args(env, info, argv, 1);
  double p = 0;
  napi_get_value_double(env, argv[0], &p);
  engine_locate((int64_t)p);
  return undef(env);
}

static napi_value GetState(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value o;
  napi_create_object(env, &o);
  int sg = atomic_load(&E.seekGen);
  setProp(env, o, "pos", num(env, (double)atomic_load(&E.pos)));
  setProp(env, o, "playing", num(env, atomic_load(&E.playing)));
  setProp(env, o, "ready", num(env, atomic_load(&E.prefilled) == sg && atomic_load(&E.audioAck) == sg));
  setProp(env, o, "recording", num(env, atomic_load(&E.recording) || atomic_load(&E.recPending)));
  setProp(env, o, "recStart", num(env, (double)atomic_load(&E.recStart)));
  setProp(env, o, "recDropped", num(env, atomic_load(&E.recDropped)));
  setProp(env, o, "xruns", num(env, atomic_load(&E.xruns)));
  setProp(env, o, "cpu", num(env, atomic_load(&E.cpu)));
  setProp(env, o, "running", num(env, atomic_load(&E.running)));
  setProp(env, o, "sampleRate", num(env, E.sr));
  setProp(env, o, "inputChannels", num(env, E.inCh));
  setProp(env, o, "outputChannels", num(env, E.outCh));
  return o;
}

static napi_value GetMeters(napi_env env, napi_callback_info info) {
  (void)info;
  int nt = E.ntracks, nb = E.nbuses;
  size_t n = (size_t)(nt * 3 + nb * 3);
  napi_value ab, ta;
  void *data;
  napi_create_arraybuffer(env, n * sizeof(float), &data, &ab);
  float *m = data;
  for (int t = 0; t < nt; t++) {
    track *T = &E.tracks[t];
    m[t * 3] = atomic_exchange(&T->mIn, 0.0f);
    m[t * 3 + 1] = atomic_exchange(&T->mOut, 0.0f);
    float gr = 0;
    for (int s = 0; s < MAX_FX; s++) {
      float g = atomic_exchange(&T->fx[s].grMeter, 0.0f);
      if (g > gr) gr = g;
    }
    m[t * 3 + 2] = gr;
  }
  for (int b = 0; b < nb; b++) {
    bus *B = &E.buses[b];
    float *o = m + nt * 3 + b * 3;
    o[0] = atomic_exchange(&B->mL, 0.0f);
    o[1] = atomic_exchange(&B->mR, 0.0f);
    float gr = 0;
    for (int s = 0; s < MAX_FX; s++) {
      float g = atomic_exchange(&B->fx[s].grMeter, 0.0f);
      if (g > gr) gr = g;
    }
    o[2] = gr;
  }
  napi_create_typedarray(env, napi_float32_array, n, ab, 0, &ta);
  return ta;
}

// Per-slot gain reduction for the plugin window: getSlotMeter(kind, index, slot)
static napi_value GetSlotMeter(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  if (args(env, info, argv, 3) < 3) return num(env, 0);
  char *kind = getStr(env, argv[0]);
  int isBus = kind && !strcmp(kind, "bus");
  free(kind);
  int i = argInt(env, argv[1], 0), s = argInt(env, argv[2], 0);
  if (s < 0 || s >= MAX_FX) return num(env, 0);
  if (isBus ? (i < 0 || i >= MAX_BUSES) : (i < 0 || i >= MAX_TRACKS)) return num(env, 0);
  fxslot *slot = isBus ? &E.buses[i].fx[s] : &E.tracks[i].fx[s];
  return num(env, atomic_load(&slot->grMeter));
}

// ---------------------------------------------------------------- recording

static napi_value RecordStart(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int argc = args(env, info, argv, 1);
  int bits = argc > 0 ? (int)getNum(env, argv[0], "bits", 24) : 24;
  if (bits != 16 && bits != 24 && bits != 32) bits = 24;
  if (!atomic_load(&E.running)) return throwErr(env, "Open an audio device before recording");
  int k = engine_record_start(NULL, NULL, bits);
  if (k == -1) return throwErr(env, "Already recording");
  if (k == -2) return throwErr(env, "Could not create the recording files (is the disk full or read-only?)");
  atomic_store(&E.playing, 1);
  return num(env, k);
}

static napi_value RecordStop(napi_env env, napi_callback_info info) {
  (void)info;
  int K = E.recCount;
  int map[MAX_TRACKS];
  memcpy(map, E.recMap, sizeof map);
  engine_record_stop();
  napi_value arr;
  napi_create_array_with_length(env, (size_t)K, &arr);
  for (int k = 0; k < K; k++) {
    track *T = &E.tracks[map[k]];
    napi_value o;
    napi_create_object(env, &o);
    setProp(env, o, "track", num(env, map[k]));
    setProp(env, o, "path", str(env, T->recPath ? T->recPath : ""));
    setProp(env, o, "start", num(env, (double)atomic_load(&E.recStart)));
    setProp(env, o, "length", num(env, (double)T->rec.frames));
    napi_set_element(env, arr, (uint32_t)k, o);
  }
  return arr;
}

// getRecordPeaks(track, fromByte) -> Int8Array of min/max pairs
static napi_value GetRecordPeaks(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  args(env, info, argv, 2);
  int t = argInt(env, argv[0], -1);
  int from = argInt(env, argv[1], 0);
  if (t < 0 || t >= MAX_TRACKS) return throwErr(env, "track index out of range");
  track *T = &E.tracks[t];
  pthread_mutex_lock(&E.peaksMutex);
  size_t n = T->npeaks > (size_t)from ? T->npeaks - (size_t)from : 0;
  napi_value ab, ta;
  void *data;
  napi_create_arraybuffer(env, n, &data, &ab);
  if (n) memcpy(data, T->peaks + from, n);
  pthread_mutex_unlock(&E.peaksMutex);
  napi_create_typedarray(env, napi_int8_array, n, ab, 0, &ta);
  return ta;
}

// ---------------------------------------------------------------- stream tap

static napi_value ReadTap(napi_env env, napi_callback_info info) {
  (void)info;
  size_t r = atomic_load(&E.tapR);
  size_t avail = atomic_load(&E.tapW) - r;
  napi_value ab, ta;
  void *data;
  napi_create_arraybuffer(env, avail * sizeof(float), &data, &ab);
  float *o = data;
  for (size_t i = 0; i < avail; i++) o[i] = E.tapRing[(r + i) & (E.tapCap - 1)];
  atomic_store(&E.tapR, r + avail);
  napi_create_typedarray(env, napi_float32_array, avail, ab, 0, &ta);
  return ta;
}

// ---------------------------------------------------------------- async jobs

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  char *path;
  int channel;
  int8_t *out;
  size_t n;
  int err;
} peaksJob;

static void peaksExec(napi_env env, void *data) {
  (void)env;
  peaksJob *j = data;
  wav_reader r;
  if (wav_open_read(&r, j->path) != 0) { j->err = 1; return; }
  size_t np = (size_t)((r.frames + PEAK_SPP - 1) / PEAK_SPP);
  j->out = malloc(np * 2 + 1);
  float *buf = malloc(sizeof(float) * PEAK_SPP * 8);
  uint8_t *scratch = malloc(PEAK_SPP * 8 * 32);
  int64_t f = 0;
  size_t k = 0;
  while (f < r.frames) {
    int got = wav_read_channel(&r, f, PEAK_SPP * 8, j->channel, buf, scratch, PEAK_SPP * 8 * 32);
    if (got <= 0) break;
    for (int i0 = 0; i0 < got; i0 += PEAK_SPP) {
      float lo = 1, hi = -1;
      int m = got - i0 < PEAK_SPP ? got - i0 : PEAK_SPP;
      for (int i = 0; i < m; i++) {
        float v = buf[i0 + i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (lo < -1) lo = -1;
      if (hi > 1) hi = 1;
      if (k + 2 <= np * 2) {
        j->out[k++] = (int8_t)lrintf(lo * 127);
        j->out[k++] = (int8_t)lrintf(hi * 127);
      }
    }
    f += got;
  }
  j->n = k;
  free(buf);
  free(scratch);
  wav_close_read(&r);
}

static void peaksDone(napi_env env, napi_status status, void *data) {
  (void)status;
  peaksJob *j = data;
  if (j->err) {
    napi_value e;
    napi_create_error(env, NULL, str(env, "Could not read the audio file"), &e);
    napi_reject_deferred(env, j->deferred, e);
  } else {
    napi_value ab, ta;
    void *d;
    napi_create_arraybuffer(env, j->n, &d, &ab);
    if (j->n) memcpy(d, j->out, j->n);
    napi_create_typedarray(env, napi_int8_array, j->n, ab, 0, &ta);
    napi_resolve_deferred(env, j->deferred, ta);
  }
  napi_delete_async_work(env, j->work);
  free(j->out);
  free(j->path);
  free(j);
}

static napi_value ComputePeaks(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  int argc = args(env, info, argv, 2);
  peaksJob *j = calloc(1, sizeof *j);
  j->path = getStr(env, argv[0]);
  j->channel = argc > 1 ? argInt(env, argv[1], 0) : 0;
  napi_value promise, name;
  napi_create_promise(env, &j->deferred, &promise);
  napi_create_string_utf8(env, "computePeaks", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, peaksExec, peaksDone, j, &j->work);
  napi_queue_async_work(env, j->work);
  return promise;
}

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  char *path;
  char *stemDir;
  int64_t start, end;
  int bits;
  int err;
  char errMsg[200];
} exportJob;

static _Atomic float exportProgress;
static _Atomic int exportCancel;

static void exportExec(napi_env env, void *data) {
  (void)env;
  exportJob *j = data;
  int nt = E.ntracks;
  wav_writer mix;
  wav_writer *stems = NULL;
  if (wav_open_write(&mix, j->path, (int)E.sr, 2, j->bits, j->start, "Unique AV DAW mixdown") != 0) {
    j->err = 1;
    snprintf(j->errMsg, sizeof j->errMsg, "Could not create %s", j->path);
    return;
  }
  float (*stemBuf)[2][BLOCK] = NULL;
  if (j->stemDir) {
    stems = calloc((size_t)nt, sizeof(wav_writer));
    stemBuf = calloc((size_t)nt, sizeof *stemBuf);
    for (int t = 0; t < nt; t++) {
      char p[4096];
      snprintf(p, sizeof p, "%s/Track %02d.wav", j->stemDir, t + 1);
      wav_open_write(&stems[t], p, (int)E.sr, 2, j->bits, j->start, "Unique AV DAW stem");
    }
    E.stems = stemBuf;
  }
  float *buf = malloc(sizeof(float) * BLOCK);
  float inter[BLOCK * 2];
  for (int64_t p = j->start; p < j->end && !atomic_load(&exportCancel); p += BLOCK) {
    int sg = atomic_load(&E.seekGen);
    int n = (int)(j->end - p < BLOCK ? j->end - p : BLOCK);
    for (int t = 0; t < nt; t++) {
      track *T = &E.tracks[t];
      engine_fill_track(T, p, buf, n);
      atomic_store(&T->rr, 0);
      for (int i = 0; i < n; i++) T->ring[i] = buf[i];
      atomic_store(&T->rw, (size_t)n);
    }
    atomic_store(&E.audioAck, sg);
    atomic_store(&E.prefilled, sg);
    atomic_store(&E.pos, p);
    engine_process(NULL, NULL, n);
    for (int i = 0; i < n; i++) {
      inter[2 * i] = E.buses[0].buf[0][i];
      inter[2 * i + 1] = E.buses[0].buf[1][i];
    }
    wav_write_float(&mix, inter, n);
    if (stems)
      for (int t = 0; t < nt; t++) {
        for (int i = 0; i < n; i++) {
          inter[2 * i] = stemBuf[t][0][i];
          inter[2 * i + 1] = stemBuf[t][1][i];
        }
        wav_write_float(&stems[t], inter, n);
      }
    atomic_store(&exportProgress, (float)(p - j->start) / (float)(j->end - j->start));
  }
  E.stems = NULL;
  wav_close(&mix);
  if (stems) {
    for (int t = 0; t < nt; t++) wav_close(&stems[t]);
    free(stems);
    free(stemBuf);
  }
  free(buf);
  atomic_store(&exportProgress, 1.0f);
}

static int exportRunning = 0;
static int exportWasRunning = 0;
static int exportSavedSource, exportSavedPlaying, exportSavedLoop;
static int64_t exportSavedPos;

static void exportDone(napi_env env, napi_status status, void *data) {
  (void)status;
  exportJob *j = data;
  atomic_store(&E.source, exportSavedSource);
  atomic_store(&E.playing, exportSavedPlaying);
  atomic_store(&E.loopOn, exportSavedLoop);
  atomic_store(&E.readerPause, 0);
  engine_locate(exportSavedPos);
  if (exportWasRunning && devOpen) {
    atomic_store(&E.running, 1);
    ma_device_start(&dev);
  }
  exportRunning = 0;
  if (j->err) {
    napi_value e;
    napi_create_error(env, NULL, str(env, j->errMsg), &e);
    napi_reject_deferred(env, j->deferred, e);
  } else {
    napi_value b;
    napi_get_boolean(env, !atomic_load(&exportCancel), &b);
    napi_resolve_deferred(env, j->deferred, b);
  }
  napi_delete_async_work(env, j->work);
  free(j->path);
  free(j->stemDir);
  free(j);
}

// exportMix({ path, start, end, bits, stemDir }) -> Promise<boolean completed>
static napi_value ExportMix(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (args(env, info, argv, 1) < 1) return throwErr(env, "exportMix(options)");
  if (exportRunning) return throwErr(env, "An export is already running");
  if (E.recCount) return throwErr(env, "Stop recording before exporting");
  exportJob *j = calloc(1, sizeof *j);
  j->path = getStrProp(env, argv[0], "path");
  j->stemDir = getStrProp(env, argv[0], "stemDir");
  j->start = (int64_t)getNum(env, argv[0], "start", 0);
  j->end = (int64_t)getNum(env, argv[0], "end", 0);
  j->bits = (int)getNum(env, argv[0], "bits", 24);
  if (!j->path || j->end <= j->start) {
    free(j->path); free(j->stemDir); free(j);
    return throwErr(env, "Nothing to export");
  }
  // Pause live audio and the disk reader; the export reuses the mixer.
  exportRunning = 1;
  exportWasRunning = devOpen && atomic_load(&E.running);
  if (exportWasRunning) {
    ma_device_stop(&dev);
    atomic_store(&E.running, 0);
  }
  atomic_store(&E.readerPause, 1);
  while (atomic_load(&E.readerRun) && !atomic_load(&E.readerPaused)) {
    struct timespec ts = {0, 1000000};
    nanosleep(&ts, NULL);
  }
  exportSavedSource = atomic_load(&E.source);
  exportSavedPlaying = atomic_load(&E.playing);
  exportSavedPos = atomic_load(&E.pos);
  exportSavedLoop = atomic_load(&E.loopOn);
  atomic_store(&E.loopOn, 0);
  atomic_store(&E.source, 1);
  atomic_store(&E.playing, 1);
  atomic_store(&exportProgress, 0);
  atomic_store(&exportCancel, 0);
  napi_value promise, name;
  napi_create_promise(env, &j->deferred, &promise);
  napi_create_string_utf8(env, "exportMix", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, exportExec, exportDone, j, &j->work);
  napi_queue_async_work(env, j->work);
  return promise;
}

static napi_value ExportProgress(napi_env env, napi_callback_info info) {
  (void)info;
  return num(env, atomic_load(&exportProgress));
}

static napi_value ExportCancel(napi_env env, napi_callback_info info) {
  (void)info;
  atomic_store(&exportCancel, 1);
  return undef(env);
}

// ---------------------------------------------------------------- module

static void cleanup(void *arg) {
  (void)arg;
  engine_record_stop();
  if (bcOpen) ma_device_uninit(&bcDev);
  closeDevice();
  engine_reader_stop();
  if (ctxReady) ma_context_uninit(&ctx);
}

static napi_value Init(napi_env env, napi_value exports) {
  static int inited = 0;
  if (!inited) {
    engine_init();
    inited = 1;
  }
  napi_add_env_cleanup_hook(env, cleanup, NULL);
  struct { const char *name; napi_callback fn; } fns[] = {
    {"listDevices", ListDevices}, {"open", Open}, {"close", Close},
    {"openBroadcast", OpenBroadcast}, {"closeBroadcast", CloseBroadcast},
    {"setCounts", SetCounts}, {"setTrack", SetTrack}, {"setBus", SetBus},
    {"setInsert", SetInsert}, {"setGlobal", SetGlobal}, {"setClips", SetClips},
    {"wavInfo", WavInfo}, {"play", Play}, {"stop", Stop}, {"locate", Locate},
    {"getState", GetState}, {"getMeters", GetMeters}, {"getSlotMeter", GetSlotMeter},
    {"recordStart", RecordStart}, {"recordStop", RecordStop}, {"getRecordPeaks", GetRecordPeaks},
    {"readTap", ReadTap}, {"computePeaks", ComputePeaks},
    {"exportMix", ExportMix}, {"exportProgress", ExportProgress}, {"exportCancel", ExportCancel},
  };
  for (size_t i = 0; i < sizeof fns / sizeof fns[0]; i++) {
    napi_value f;
    napi_create_function(env, fns[i].name, NAPI_AUTO_LENGTH, fns[i].fn, NULL, &f);
    napi_set_named_property(env, exports, fns[i].name, f);
  }
  napi_value v;
  napi_create_int32(env, MAX_TRACKS, &v);
  napi_set_named_property(env, exports, "MAX_TRACKS", v);
  napi_create_int32(env, MAX_BUSES, &v);
  napi_set_named_property(env, exports, "MAX_BUSES", v);
  napi_create_int32(env, MAX_FX, &v);
  napi_set_named_property(env, exports, "MAX_FX", v);
  napi_create_int32(env, PEAK_SPP, &v);
  napi_set_named_property(env, exports, "PEAK_SPP", v);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
