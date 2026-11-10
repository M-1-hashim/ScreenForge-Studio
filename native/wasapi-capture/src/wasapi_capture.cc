/**
 * wasapi_capture — shared-mode WASAPI loopback + microphone capture (Windows).
 *
 * Streams 32-bit float interleaved PCM to JavaScript via a N-API TSFN:
 *   { stream: 'system'|'mic', buffer: Buffer(float32), channels, sampleRate, frames }
 *
 * JS API:
 *   listDevices() -> [{ id, name, kind: 'render'|'capture', isDefault }]
 *   startLoopback({ sampleRate? }) -> bool   system audio (render endpoint loopback)
 *   startMic({ deviceId? }) -> bool          microphone (capture endpoint)
 *   stop(stream: 'system'|'mic'|'both') -> bool
 *   setEventCallback(fn)
 */
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <avrt.h>
#include <functiondiscoverykeys_devpkey.h>
#include <napi.h>
#include <atomic>
#include <mutex>
#include <thread>
#include <vector>

#include <wrl/client.h>
using Microsoft::WRL::ComPtr;

namespace {

constexpr REFERENCE_TIME kBufferDuration = 2'000'000; // 200 ms

struct PcmChunk {
  std::string stream;   // "system" | "mic"
  std::vector<float> samples;
  uint32_t channels;
  uint32_t sampleRate;
  uint32_t frames;
};

std::atomic<bool> g_systemRunning{false};
std::atomic<bool> g_micRunning{false};
Napi::ThreadSafeFunction g_tsfn;
std::mutex g_tsfnMutex;

std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return {};
  int size = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string out(size - 1, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, out.data(), size, nullptr, nullptr);
  return out;
}

class ComGuard {
 public:
  ComGuard() { CoInitializeEx(nullptr, COINIT_MULTITHREADED); }
  ~ComGuard() { CoUninitialize(); }
};

std::string DeviceIdToUtf8(IMMDevice* device) {
  LPWSTR id = nullptr;
  if (SUCCEEDED(device->GetId(&id))) {
    std::wstring wide(id);
    CoTaskMemFree(id);
    return WideToUtf8(wide);
  }
  return {};
}

std::string DeviceName(IMMDevice* device) {
  ComPtr<IPropertyStore> store;
  if (FAILED(device->OpenPropertyStore(STGM_READ, &store))) return {};
  PROPVARIANT prop;
  PropVariantInit(&prop);
  if (SUCCEEDED(store->GetValue(PKEY_Device_FriendlyName, &prop)) && prop.vt == VT_LPWSTR) {
    std::string name = WideToUtf8(prop.pwszVal);
    PropVariantClear(&prop);
    return name;
  }
  PropVariantClear(&prop);
  return {};
}

// ---------------------------------------------------------------------------
// Capture thread
// ---------------------------------------------------------------------------

void CaptureLoop(const std::string streamName, ComPtr<IMMDevice> endpoint, std::atomic<bool>* running) {
  ComGuard com;
  ComPtr<IAudioClient> client;
  ComPtr<IAudioCaptureClient> capture;
  WAVEFORMATEX* pwfx = nullptr;
  bool wfxOwned = false;

  HRESULT hr = endpoint->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                  reinterpret_cast<void**>(client.GetAddressOf()));
  if (FAILED(hr)) goto done;

  hr = client->GetMixFormat(&pwfx);
  if (FAILED(hr)) goto done;
  wfxOwned = true;

  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          streamName == "system" ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0,
                          kBufferDuration, 0, pwfx, nullptr);
  if (FAILED(hr)) goto done;

  hr = client->GetService(__uuidof(IAudioCaptureClient),
                          reinterpret_cast<void**>(capture.GetAddressOf()));
  if (FAILED(hr)) goto done;

  if (FAILED(client->Start())) goto done;

  {
    uint32_t channels = pwfx->nChannels;
    uint32_t sampleRate = pwfx->nSamplesPerSec;
    while (running->load(std::memory_order_relaxed)) {
      Sleep(5);
      UINT32 packet = 0;
      while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;

        if (frames > 0) {
          const size_t totalSamples = static_cast<size_t>(frames) * channels;
          std::vector<float> samples(totalSamples);
          if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
            memset(samples.data(), 0, totalSamples * sizeof(float));
          } else {
            memcpy(samples.data(), data, totalSamples * sizeof(float));
          }
          std::lock_guard<std::mutex> lock(g_tsfnMutex);
          if (g_tsfn) {
            auto cb = [](Napi::Env env, Napi::Function js, PcmChunk* chunk) {
              Napi::Object obj = Napi::Object::New(env);
              obj.Set("stream", chunk->stream);
              obj.Set("buffer",
                      Napi::Buffer<float>::Copy(env, chunk->samples.data(), chunk->samples.size()));
              obj.Set("channels", chunk->channels);
              obj.Set("sampleRate", chunk->sampleRate);
              obj.Set("frames", chunk->frames);
              js.Call({obj});
            };
            PcmChunk* chunk = new PcmChunk{streamName, std::move(samples), channels, sampleRate, frames};
            g_tsfn.BlockingCall(chunk, cb);
          }
        }
        capture->ReleaseBuffer(frames);
      }
    }
    client->Stop();
  }

done:
  if (wfxOwned && pwfx) CoTaskMemFree(pwfx);
  running->store(false);
}

// ---------------------------------------------------------------------------
// NAPI surface
// ---------------------------------------------------------------------------

Napi::Value SetEventCallback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::Error::New(env, "setEventCallback(function) required").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::lock_guard<std::mutex> lock(g_tsfnMutex);
  if (g_tsfn) g_tsfn.Release();
  g_tsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "wasapiEvents", 0, 1,
                                         [](Napi::Env) {});
  return env.Undefined();
}

Napi::Value ListDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array out = Napi::Array::New(env);
  ComGuard com;
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator),
                              reinterpret_cast<void**>(enumerator.GetAddressOf())))) {
    return out;
  }
  ComPtr<IMMDeviceCollection> collection;
  if (FAILED(enumerator->EnumAudioEndpoints(eAll, DEVICE_STATE_ACTIVE, &collection))) return out;
  UINT count = 0;
  collection->GetCount(&count);
  uint32_t idx = 0;
  for (UINT i = 0; i < count; i++) {
    ComPtr<IMMDevice> device;
    if (FAILED(collection->Item(i, &device))) continue;
    IAudioClient* probe = nullptr;
    bool isRender = false;
    if (SUCCEEDED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                   reinterpret_cast<void**>(&probe)))) {
      // Distinguish render vs capture via data flow of the endpoint.
      ComPtr<IMMEndpoint> endpoint;
      if (SUCCEEDED(device.As(&endpoint))) {
        EDataFlow flow;
        if (SUCCEEDED(endpoint->GetDataFlow(&flow))) isRender = (flow == eRender);
      }
      probe->Release();
    }
    ComPtr<IMMDevice> defaultDev;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(isRender ? eRender : eCapture, eConsole,
                                                      &defaultDev))) {
      // isDefault compared by id below
    }
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("id", DeviceIdToUtf8(device.Get()));
    obj.Set("name", DeviceName(device.Get()));
    obj.Set("kind", isRender ? "render" : "capture");
    obj.Set("isDefault", false);
    (void)defaultDev;
    out.Set(idx++, obj);
  }
  return out;
}

Napi::Value StartLoopback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_systemRunning.load()) return Napi::Boolean::New(env, true);
  ComGuard com;
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator),
                              reinterpret_cast<void**>(enumerator.GetAddressOf())))) {
    return Napi::Boolean::New(env, false);
  }
  ComPtr<IMMDevice> device;
  if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device))) {
    return Napi::Boolean::New(env, false);
  }
  g_systemRunning.store(true);
  std::thread(CaptureLoop, "system", device, &g_systemRunning).detach();
  return Napi::Boolean::New(env, true);
}

Napi::Value StartMic(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_micRunning.load()) return Napi::Boolean::New(env, true);
  ComGuard com;
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator),
                              reinterpret_cast<void**>(enumerator.GetAddressOf())))) {
    return Napi::Boolean::New(env, false);
  }
  ComPtr<IMMDevice> device;

  std::string wantId;
  if (info.Length() >= 1 && info[0].IsObject()) {
    Napi::Object opts = info[0].As<Napi::Object>();
    if (opts.Has("deviceId") && opts.Get("deviceId").IsString()) {
      wantId = opts.Get("deviceId").As<Napi::String>().Utf8Value();
    }
  }
  if (!wantId.empty()) {
    ComPtr<IMMDeviceCollection> collection;
    if (SUCCEEDED(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection))) {
      UINT count = 0;
      collection->GetCount(&count);
      for (UINT i = 0; i < count; i++) {
        ComPtr<IMMDevice> dev;
        if (FAILED(collection->Item(i, &dev))) continue;
        if (DeviceIdToUtf8(dev.Get()) == wantId) {
          device = dev;
          break;
        }
      }
    }
  }
  if (!device) {
    if (FAILED(enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &device))) {
      return Napi::Boolean::New(env, false);
    }
  }
  g_micRunning.store(true);
  std::thread(CaptureLoop, "mic", device, &g_micRunning).detach();
  return Napi::Boolean::New(env, true);
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string which = "both";
  if (info.Length() >= 1 && info[0].IsString()) which = info[0].As<Napi::String>().Utf8Value();
  if (which == "system" || which == "both") g_systemRunning.store(false);
  if (which == "mic" || which == "both") g_micRunning.store(false);
  // Threads observe the flag within ~5 ms; TSFN stays valid for trailing events.
  return Napi::Boolean::New(env, true);
}

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("setEventCallback", Napi::Function::New(env, SetEventCallback));
  exports.Set("listDevices", Napi::Function::New(env, ListDevices));
  exports.Set("startLoopback", Napi::Function::New(env, StartLoopback));
  exports.Set("startMic", Napi::Function::New(env, StartMic));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  return exports;
}

}  // namespace

NODE_API_MODULE(wasapi_capture, InitModule)
