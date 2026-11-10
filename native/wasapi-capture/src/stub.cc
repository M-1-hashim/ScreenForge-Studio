/**
 * wasapi_capture — non-Windows stub.
 */
#include <napi.h>

Napi::Object InitStub(Napi::Env env, Napi::Object exports) {
  Napi::Function windowsOnly = Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    Napi::Error::New(info.Env(), "wasapi_capture: Windows only").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  });
  Napi::Function returnsFalse = Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), false);
  });
  exports.Set("setEventCallback", windowsOnly);
  exports.Set("listDevices", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
                return Napi::Array::New(info.Env());
              }));
  exports.Set("startLoopback", returnsFalse);
  exports.Set("startMic", returnsFalse);
  exports.Set("stop", returnsFalse);
  exports.Set("isSupported", returnsFalse);
  return exports;
}

NODE_API_MODULE(wasapi_capture, InitStub)
