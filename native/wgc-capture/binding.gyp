{
  "targets": [
    {
      "target_name": "wgc_capture",
      "sources": ["src/wgc_capture.cc"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8", "WINVER=0x0A00", "_WIN32_WINNT=0x0A00"],
      "cflags_cc": ["-std=c++17"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "LanguageStandard": "stdcpp17",
          "AdditionalOptions": ["/Zc:__cplusplus"]
        }
      },
      "conditions": [
        ["OS=='win'", {
          "libraries": ["d3d11.lib", "dxgi.lib", "windowsapp.lib"]
        }, {
          "sources": ["src/stub.cc"]
        }]
      ]
    }
  ]
}
