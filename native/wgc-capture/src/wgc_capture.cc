/**
 * wgc_capture — Windows Graphics Capture (WGC) frame streaming (Windows).
 *
 * Captures a monitor (or window) as BGRA frames and streams CPU-readback
 * buffers to JavaScript via a N-API TSFN. The main process pipes those
 * buffers into FFmpeg rawvideo -> H.264 for real-time MP4 recording.
 *
 * JS API:
 *   isSupported() -> bool
 *   start({ kind: 'monitor'|'window', monitorIndex?, hwndBuffer?, fps?,
 *           crop?: {x,y,width,height}|null, includeCursor?: bool }, callback)
 *     callback receives { buffer (BGRA, tightly packed), width, height, tMs }
 *             or { error: string }
 *   stop() -> bool
 *   setEventCallback(fn) — for { error } events outside the frame callback
 */
#include <windows.h>
#include <dxgi1_2.h>
#include <d3d11.h>
#include <napi.h>
#include <atomic>
#include <chrono>
#include <mutex>
#include <thread>
#include <vector>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
namespace Interop = ::Windows::Graphics::DirectX::Direct3D11;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;

#include <wrl/client.h>
using Microsoft::WRL::ComPtr;

namespace {

struct FramePayload {
  std::vector<uint8_t> pixels; // BGRA, tightly packed width*height*4
  uint32_t width;
  uint32_t height;
  double tMs;
};

struct Session {
  std::thread worker;
  std::atomic<bool> running{false};
  bool isMonitor = true;
  int monitorIndex = 0;
  HWND hwnd = nullptr;
  double minFrameGapMs = 0.0;
  RECT cropRect{};       // physical, item-local
  bool hasCrop = false;
  bool includeCursor = false;
  std::mutex mutex;      // guards members below
  Napi::ThreadSafeFunction frameTsfn;
  LARGE_INTEGER qpcStart{};
  double qpcFreqMs = 1.0;
};

std::unique_ptr<Session> g_session;
std::mutex g_sessionMutex;
Napi::ThreadSafeFunction g_errorTsfn;
std::mutex g_errorMutex;

void EmitError(const std::string& message) {
  std::lock_guard<std::mutex> lock(g_errorMutex);
  if (g_errorTsfn) {
    g_errorTsfn.BlockingCall(new std::string(message),
                             [](Napi::Env env, Napi::Function js, std::string* msg) {
                               js.Call({Napi::String::New(env, *msg)});
                               delete msg;
                             });
  }
}

// Copy the GPU texture to a tightly packed BGRA CPU buffer. When `useCrop`
// is true only the crop rect is read back.
bool ReadBackFrame(ID3D11Device* device, ID3D11DeviceContext* context,
                   ID3D11Texture2D* source, const RECT& crop, bool useCrop,
                   std::vector<uint8_t>* out, uint32_t* outW, uint32_t* outH) {
  D3D11_TEXTURE2D_DESC desc;
  source->GetDesc(&desc);

  const LONG left = useCrop ? crop.left : 0;
  const LONG top = useCrop ? crop.top : 0;
  const LONG width = useCrop ? (crop.right - crop.left) : static_cast<LONG>(desc.Width);
  const LONG height = useCrop ? (crop.bottom - crop.top) : static_cast<LONG>(desc.Height);
  if (width <= 0 || height <= 0) return false;

  D3D11_TEXTURE2D_DESC stagingDesc = desc;
  stagingDesc.Width = static_cast<UINT>(width);
  stagingDesc.Height = static_cast<UINT>(height);
  stagingDesc.Usage = D3D11_USAGE_STAGING;
  stagingDesc.BindFlags = 0;
  stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  stagingDesc.MipLevels = 1;
  stagingDesc.MiscFlags = 0;
  stagingDesc.ArraySize = 1;
  stagingDesc.SampleDesc.Count = 1;

  ComPtr<ID3D11Texture2D> staging;
  if (FAILED(device->CreateTexture2D(&stagingDesc, nullptr, staging.GetAddressOf()))) return false;

  D3D11_BOX box{static_cast<UINT>(left), static_cast<UINT>(top), 0u,
                static_cast<UINT>(left + width), static_cast<UINT>(top + height), 1u};
  context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, source, 0,
                                 useCrop ? &box : nullptr);

  D3D11_MAPPED_SUBRESOURCE mapped{};
  if (FAILED(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped))) return false;

  out->resize(static_cast<size_t>(width) * height * 4);
  const uint8_t* src = static_cast<const uint8_t*>(mapped.pData);
  const size_t rowBytes = static_cast<size_t>(width) * 4;
  for (LONG row = 0; row < height; row++) {
    memcpy(out->data() + row * rowBytes, src + static_cast<size_t>(row) * mapped.RowPitch,
           rowBytes);
  }
  context->Unmap(staging.Get(), 0);

  *outW = static_cast<uint32_t>(width);
  *outH = static_cast<uint32_t>(height);
  return true;
}

void CaptureThread(Session* s, GraphicsCaptureItem item) {
  winrt::init_apartment(winrt::apartment_type::multi_threaded);

  UINT createFlags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  ComPtr<ID3D11Device> d3dDevice;
  ComPtr<ID3D11DeviceContext> context;
  D3D_FEATURE_LEVEL featureLevel;
  if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, createFlags, nullptr, 0,
                               D3D11_SDK_VERSION, d3dDevice.GetAddressOf(), &featureLevel,
                               context.GetAddressOf()))) {
    EmitError("wgc: D3D11CreateDevice failed");
    s->running.store(false);
    return;
  }

  winrt::com_ptr<::IUnknown> dxgiUnknown;
  Interop::IDirect3DDevice interopDevice = nullptr;
  try {
    ComPtr<IDXGIDevice> dxgiDevice;
    if (FAILED(d3dDevice.As(&dxgiDevice))) throw std::runtime_error("dxgi as failed");
    winrt::com_ptr<::IInspectable> inspectable;
    CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.Get(), inspectable.put());
    interopDevice = inspectable.as<Interop::IDirect3DDevice>();
  } catch (...) {
    EmitError("wgc: interop device creation failed");
    s->running.store(false);
    return;
  }

  try {
    const auto dxgiFormat = DirectXPixelFormat::B8G8R8A8UIntNormalized;
    auto size = item.Size();
    winrt::Windows::Graphics::SizeInt32 poolSize{size.Width, size.Height};

    auto framePool = Direct3D11CaptureFramePool::CreateFreeThreaded(interopDevice, dxgiFormat, 2, poolSize);
    auto sessionObj = framePool.CreateCaptureSession(item);

    // Version-gated niceties (API may not exist on older Win10 builds).
    try {
      sessionObj.IsCursorCaptureEnabled(s->includeCursor);
    } catch (...) {
    }
    try {
      if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
              L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired")) {
        sessionObj.IsBorderRequired(false);
      }
    } catch (...) {
    }

    auto frameArrived = framePool.FrameArrived(
        [s, d3dDevice, context, framePool, item, interopDevice, poolSize](
            Direct3D11CaptureFramePool const& sender, auto&&) {
          if (!s->running.load(std::memory_order_relaxed)) return;

          auto frame = sender.TryGetNextFrame();
          if (!frame) return;

          auto contentSize = frame.ContentSize();

          // Recreate the pool if the content size changed (window resize).
          if (contentSize.Width != poolSize.Width || contentSize.Height != poolSize.Height) {
            poolSize = contentSize;
            sender.Recreate(interopDevice, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, poolSize);
            return;
          }

          // Gate to requested fps.
          if (s->minFrameGapMs > 0.0) {
            static thread_local LARGE_INTEGER last{};
            LARGE_INTEGER now;
            QueryPerformanceCounter(&now);
            if (last.QuadPart != 0) {
              const double gapMs =
                  static_cast<double>(now.QuadPart - last.QuadPart) / (s->qpcFreqMs * 1000.0);
              if (gapMs < s->minFrameGapMs) return;
            }
            last = now;
          }

          auto surface = frame.Surface();
          auto dxgiInterface = surface.as<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
          ComPtr<ID3D11Texture2D> texture;
          if (FAILED(dxgiInterface->GetInterface(__uuidof(ID3D11Texture2D),
                                                 reinterpret_cast<void**>(texture.GetAddressOf())))) {
            return;
          }

          FramePayload payload;
          RECT crop{};
          bool useCrop = false;
          {
            std::lock_guard<std::mutex> lock(s->mutex);
            crop = s->cropRect;
            useCrop = s->hasCrop;
          }
          if (!ReadBackFrame(d3dDevice.Get(), context.Get(), texture.Get(), crop, useCrop,
                             &payload.pixels, &payload.width, &payload.height)) {
            return;
          }
          LARGE_INTEGER now;
          QueryPerformanceCounter(&now);
          payload.tMs = static_cast<double>(now.QuadPart - s->qpcStart.QuadPart) / s->qpcFreqMs;

          std::lock_guard<std::mutex> lock(s->mutex);
          if (s->frameTsfn) {
            s->frameTsfn.BlockingCall(
                new FramePayload(std::move(payload)),
                [](Napi::Env env, Napi::Function js, FramePayload* p) {
                  Napi::Object obj = Napi::Object::New(env);
                  obj.Set("buffer", Napi::Buffer<uint8_t>::Copy(env, p->pixels.data(), p->pixels.size()));
                  obj.Set("width", p->width);
                  obj.Set("height", p->height);
                  obj.Set("tMs", p->tMs);
                  js.Call({obj});
                  delete p;
                });
          }
        });

    sessionObj.StartCapture();

    // Run until stopped; WGC free-threaded pool delivers frames without a
    // dispatcher, so this thread just sleeps as the lifetime anchor.
    while (s->running.load(std::memory_order_relaxed)) {
      Sleep(50);
    }

    frameArrived.revoke();
    try {
      sessionObj.Close();
    } catch (...) {
    }
    try {
      framePool.Close();
    } catch (...) {
    }
  } catch (...) {
    EmitError("wgc: capture loop failed");
  }

  s->running.store(false);
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
  std::lock_guard<std::mutex> lock(g_errorMutex);
  if (g_errorTsfn) g_errorTsfn.Release();
  g_errorTsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "wgcErrors", 0, 1,
                                              [](Napi::Env) {});
  return env.Undefined();
}

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  try {
    return Napi::Boolean::New(env, GraphicsCaptureSession::IsSupported());
  } catch (...) {
    return Napi::Boolean::New(env, false);
  }
}

RECT ParseCrop(Napi::Object opts) {
  RECT rect{};
  if (opts.Has("crop") && opts.Get("crop").IsObject()) {
    auto crop = opts.Get("crop").As<Napi::Object>();
    if (!crop.Get("x").IsUndefined()) {
      rect.left = static_cast<LONG>(crop.Get("x").As<Napi::Number>().Int32Value());
      rect.top = static_cast<LONG>(crop.Get("y").As<Napi::Number>().Int32Value());
      rect.right = rect.left + static_cast<LONG>(crop.Get("width").As<Napi::Number>().Int32Value());
      rect.bottom = rect.top + static_cast<LONG>(crop.Get("height").As<Napi::Number>().Int32Value());
    }
  }
  return rect;
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    Napi::Error::New(env, "start(options, frameCallback) required").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }
  {
    std::lock_guard<std::mutex> lock(g_sessionMutex);
    if (g_session && g_session->running.load()) {
      return Napi::Boolean::New(env, false);
    }
  }
  try {
    auto opts = info[0].As<Napi::Object>();

    auto session = std::make_unique<Session>();
    session->isMonitor = true;
    if (opts.Has("kind") && opts.Get("kind").IsString()) {
      session->isMonitor = opts.Get("kind").As<Napi::String>().Utf8Value() != "window";
    }
    if (opts.Has("monitorIndex") && opts.Get("monitorIndex").IsNumber()) {
      session->monitorIndex = opts.Get("monitorIndex").As<Napi::Number>().Int32Value();
    }
    if (!session->isMonitor && opts.Has("hwndBuffer") && opts.Get("hwndBuffer").IsBuffer()) {
      auto buf = opts.Get("hwndBuffer").As<Napi::Buffer<uint8_t>>();
      if (buf.Length() >= sizeof(HWND)) memcpy(&session->hwnd, buf.Data(), sizeof(HWND));
    }
    if (opts.Has("fps") && opts.Get("fps").IsNumber()) {
      const double fps = opts.Get("fps").As<Napi::Number>().DoubleValue();
      if (fps > 0 && fps < 1000) session->minFrameGapMs = 1000.0 / fps;
    }
    if (opts.Has("includeCursor") && opts.Get("includeCursor").IsBoolean()) {
      session->includeCursor = opts.Get("includeCursor").As<Napi::Boolean>().Value();
    } else {
      session->includeCursor = false;
    }
    session->cropRect = ParseCrop(opts);
    session->hasCrop = session->cropRect.right > session->cropRect.left &&
                       session->cropRect.bottom > session->cropRect.top;

    LARGE_INTEGER freq;
    QueryPerformanceFrequency(&freq);
    session->qpcFreqMs = static_cast<double>(freq.QuadPart) / 1000.0;
    QueryPerformanceCounter(&session->qpcStart);

    session->frameTsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(),
                                                       "wgcFrames", 0, 2, [](Napi::Env) {});

    GraphicsCaptureItem item = nullptr;
    if (session->isMonitor) {
      // EnumDisplayMonitors ordering matches monitorIndex semantics (0-based).
      struct Ctx {
        std::vector<HMONITOR> monitors;
      } ctx;
      EnumDisplayMonitors(
          nullptr, nullptr,
          [](HMONITOR monitor, HDC, LPRECT, LPARAM lparam) -> BOOL {
            reinterpret_cast<Ctx*>(lparam)->monitors.push_back(monitor);
            return TRUE;
          },
          reinterpret_cast<LPARAM>(&ctx));
      if (ctx.monitors.empty() || session->monitorIndex >= static_cast<int>(ctx.monitors.size())) {
        return Napi::Boolean::New(env, false);
      }
      item = GraphicsCaptureItem::CreateForMonitor(ctx.monitors[session->monitorIndex]);
    } else if (session->hwnd) {
      item = GraphicsCaptureItem::CreateForWindow(session->hwnd);
    }
    if (!item) {
      return Napi::Boolean::New(env, false);
    }

    session->running.store(true);
    auto* raw = session.get();
    {
      std::lock_guard<std::mutex> lock(g_sessionMutex);
      g_session = std::move(session);
    }
    raw->worker = std::thread(CaptureThread, raw, item);
    return Napi::Boolean::New(env, true);
  } catch (...) {
    return Napi::Boolean::New(env, false);
  }
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Session* raw = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_sessionMutex);
    if (!g_session) return Napi::Boolean::New(env, false);
    raw = g_session.get();
  }
  raw->running.store(false);
  if (raw->worker.joinable()) raw->worker.join();
  {
    std::lock_guard<std::mutex> lock(raw->mutex);
    if (raw->frameTsfn) {
      raw->frameTsfn.Release();
      raw->frameTsfn = nullptr;
    }
  }
  std::lock_guard<std::mutex> lock(g_sessionMutex);
  g_session.reset();
  return Napi::Boolean::New(env, true);
}

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("setEventCallback", Napi::Function::New(env, SetEventCallback));
  return exports;
}

}  // namespace

NODE_API_MODULE(wgc_capture, InitModule)
