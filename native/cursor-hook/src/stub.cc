/**
 * cursor_hook — non-Windows stub.
 *
 * The addon loads everywhere so development and typechecking work on any OS,
 * but start() always reports false and other calls are harmless no-ops.
 */
#include <napi.h>

Napi::Object InitStub(Napi::Env env, Napi::Object exports) {
  Napi::Function windowsOnly = Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    Napi::Error::New(info.Env(), "cursor_hook: Windows only").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  });
  Napi::Function returnsFalse = Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), false);
  });
  Napi::Function noop = Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    return info.Env().Undefined();
  });
  exports.Set("setEventCallback", windowsOnly);
  exports.Set("start", returnsFalse);
  exports.Set("stop", noop);
  exports.Set("isRunning", returnsFalse);
  exports.Set("excludeWindowFromCapture", returnsFalse);
  exports.Set("setMoveSamplingHz", noop);
  return exports;
}

NODE_API_MODULE(cursor_hook, InitStub)
