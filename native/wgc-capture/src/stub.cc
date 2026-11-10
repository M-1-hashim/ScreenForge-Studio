/**
 * wgc_capture — non-Windows stub.
 */
#include <napi.h>

Napi::Object InitStub(Napi::Env env, Napi::Object exports) {
  Napi::Function windowsOnly = Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    Napi::Error::New(info.Env(), "wgc_capture: Windows only").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  });
  Napi::Function returnsFalse = Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), false);
  });
  exports.Set("isSupported", returnsFalse);
  exports.Set("start", returnsFalse);
  exports.Set("stop", returnsFalse);
  exports.Set("setEventCallback", windowsOnly);
  return exports;
}

NODE_API_MODULE(wgc_capture, InitStub)
