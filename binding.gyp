{
  "targets": [
    {
      "target_name": "uavdaw",
      "sources": [
        "native/addon.c",
        "native/engine.c",
        "native/dsp.c",
        "native/wav.c"
      ],
      "defines": ["_FILE_OFFSET_BITS=64", "_GNU_SOURCE", "MA_NO_RUNTIME_LINKING"],
      "cflags_c": ["-std=gnu11", "-O2", "-Wno-unused-function", "-Wno-unused-parameter"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "OTHER_CFLAGS": ["-std=gnu11", "-O2", "-Wno-unused-function"],
            "MACOSX_DEPLOYMENT_TARGET": "11.0"
          },
          "link_settings": {
            "libraries": [
              "-framework CoreAudio",
              "-framework AudioToolbox",
              "-framework CoreFoundation",
              "-framework AudioUnit"
            ]
          }
        }],
        ["OS=='linux'", {
          "defines!": ["MA_NO_RUNTIME_LINKING"],
          "libraries": ["-lpthread", "-lm", "-ldl"]
        }]
      ]
    }
  ]
}
