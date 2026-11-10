{
  "targets": [
    {
      "target_name": "cursor_hook",
      "sources": ["src/cursor_hook.cc"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
      "cflags_cc": ["-std=c++17"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/Zc:__cplusplus"]
        }
      },
      "conditions": [
        ["OS=='win'", {
          "libraries": ["user32.lib", "kernel32.lib"]
        }, {
          "sources": ["src/stub.cc"]
        }]
      ]
    }
  ]
}
