/**
 * cursor_hook — global low-level mouse hook addon (Windows).
 *
 * Streams cursor move / button / wheel events from a WH_MOUSE_LL hook to
 * JavaScript via a N-API thread-safe function. Also exposes
 * SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) so the app can hide its
 * overlay/toolbar windows from screen capture.
 *
 * JS API:
 *   setEventCallback(fn)      fn receives { type, x, y, button, delta, t }
 *   start(hz = 120) -> bool   install hook, begin emitting (move events
 *                             throttled to `hz`)
 *   stop()                    uninstall hook, stop emitting
 *   isRunning() -> bool
 *   excludeWindowFromCapture(hwndBuffer) -> bool
 *
 * Built only on Windows (binding.gyp swaps in stub.cc elsewhere).
 */
#include <windows.h>
#include <napi.h>
#include <atomic>
#include <mutex>
#include <thread>
#include <vector>

namespace {

// ---------------------------------------------------------------------------
// Lock-free-ish SPSC ring buffer (single hook producer, single consumer).
// ---------------------------------------------------------------------------

struct MouseEvent {
  enum Type : uint8_t { kMove = 0, kDown = 1, kUp = 2, kWheel = 3 } type;
  int32_t x;
  int32_t y;
  uint8_t button; // 0 left, 1 right, 2 middle
  int16_t delta;  // wheel delta
  int64_t tMs;    // ms since hook start
};

class RingBuffer {
 public:
  explicit RingBuffer(size_t capacity) : mask_(capacity - 1) {
    slots_.resize(capacity);
  }
  void Push(const MouseEvent& e) {
    const size_t next = (head_ + 1) & mask_;
    if (next == tail_) {
      // full — drop oldest to keep latency bounded
      tail_ = (tail_ + 1) & mask_;
    }
    slots_[head_] = e;
    head_ = next;
  }
  bool Pop(MouseEvent* out) {
    if (tail_ == head_) return false;
    *out = slots_[tail_];
    tail_ = (tail_ + 1) & mask_;
    return true;
  }

 private:
  std::vector<MouseEvent> slots_;
  const size_t mask_;
  size_t head_ = 0;
  size_t tail_ = 0;
};

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

std::atomic<bool> g_running{false};
std::atomic<int> g_moveHz{120};
HHOOK g_hook = nullptr;
RingBuffer* g_ring = nullptr;
LARGE_INTEGER g_qpcStart;
double g_qpcFreqMs = 1.0;
std::thread g_pumpThread;
Napi::ThreadSafeFunction g_tsfn;
std::mutex g_tsfnMutex;

int64_t NowMs() {
  LARGE_INTEGER now;
  QueryPerformanceCounter(&now);
  return static_cast<int64_t>((now.QuadPart - g_qpcStart.QuadPart) / g_qpcFreqMs);
}

MouseEvent FromMSLL(const MSLLHOOKSTRUCT& data, MouseEvent::Type type, uint8_t button, int16_t delta) {
  MouseEvent e;
  e.type = type;
  e.x = static_cast<int32_t>(data.pt.x);
  e.y = static_cast<int32_t>(data.pt.y);
  e.button = button;
  e.delta = delta;
  e.tMs = NowMs();
  return e;
}

LRESULT CALLBACK LowLevelMouseProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code >= 0 && g_running.load(std::memory_order_relaxed) && g_ring) {
    const MSLLHOOKSTRUCT* data = reinterpret_cast<MSLLHOOKSTRUCT*>(lParam);
    switch (wParam) {
      case WM_MOUSEMOVE:
        g_ring->Push(FromMSLL(*data, MouseEvent::kMove, 0, 0));
        break;
      case WM_LBUTTONDOWN:
        g_ring->Push(FromMSLL(*data, MouseEvent::kDown, 0, 0));
        break;
      case WM_RBUTTONDOWN:
        g_ring->Push(FromMSLL(*data, MouseEvent::kDown, 1, 0));
        break;
      case WM_MBUTTONDOWN:
        g_ring->Push(FromMSLL(*data, MouseEvent::kDown, 2, 0));
        break;
      case WM_LBUTTONUP:
        g_ring->Push(FromMSLL(*data, MouseEvent::kUp, 0, 0));
        break;
      case WM_RBUTTONUP:
        g_ring->Push(FromMSLL(*data, MouseEvent::kUp, 1, 0));
        break;
      case WM_MBUTTONUP:
        g_ring->Push(FromMSLL(*data, MouseEvent::kUp, 2, 0));
        break;
      case WM_MOUSEWHEEL:
        g_ring->Push(FromMSLL(*data, MouseEvent::kWheel, 0,
                              static_cast<int16_t>(HIWORD(data->mouseData))));
        break;
      default:
        break;
    }
  }
  return CallNextHookEx(g_hook, code, wParam, lParam);
}

void PumpLoop() {
  // Emit thread: drains the ring and forwards to JS at a bounded rate.
  int64_t lastMoveMs = 0;
  MouseEvent e;
  while (g_running.load(std::memory_order_relaxed)) {
    bool emitted = false;
    while (g_ring->Pop(&e)) {
      if (e.type == MouseEvent::kMove) {
        const int hz = g_moveHz.load(std::memory_order_relaxed);
        const int64_t minGap = hz > 0 ? 1000 / hz : 0;
        if (e.tMs - lastMoveMs < minGap) continue;
        lastMoveMs = e.tMs;
      }
      napi_value undefined;
      {
        std::lock_guard<std::mutex> lock(g_tsfnMutex);
        if (!g_tsfn) continue;
        auto cb = [](Napi::Env env, Napi::Function jsCallback, MouseEvent* ev) {
          Napi::Object obj = Napi::Object::New(env);
          static const char* names[] = {"move", "down", "up", "wheel"};
          obj.Set("type", names[ev->type]);
          obj.Set("x", static_cast<double>(ev->x));
          obj.Set("y", static_cast<double>(ev->y));
          obj.Set("button", static_cast<double>(ev->button));
          obj.Set("delta", static_cast<double>(ev->delta));
          obj.Set("t", static_cast<double>(ev->tMs));
          jsCallback.Call({obj});
        };
        g_tsfn.BlockingCall(new MouseEvent(e), cb);
        (void)undefined;
      }
      emitted = true;
    }
    if (!emitted) Sleep(2);
  }
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
  g_tsfn = Napi::ThreadSafeFunction::New(
      env, info[0].As<Napi::Function>(), "cursorHookEvents", 0, 1,
      [](Napi::Env) { /* finalizer: TSFN released on stop */ });
  return env.Undefined();
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_running.load()) return Napi::Boolean::New(env, true);
  if (info.Length() >= 1 && info[0].IsNumber()) {
    g_moveHz.store(info[0].As<Napi::Number>().Int32Value(), std::memory_order_relaxed);
  }

  // Per-monitor-v2 DPI awareness so hook coordinates are physical pixels.
  using SetCtxFn = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (user32) {
    auto setCtx = reinterpret_cast<SetCtxFn>(GetProcAddress(user32, "SetProcessDpiAwarenessContext"));
    if (setCtx) {
      setCtx(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
  }

  LARGE_INTEGER freq;
  QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&g_qpcStart);
  g_qpcFreqMs = static_cast<double>(freq.QuadPart) / 1000.0;

  static RingBuffer ring(16384);
  g_ring = &ring;

  g_running.store(true);
  g_hook = SetWindowsHookExW(WH_MOUSE_LL, LowLevelMouseProc, GetModuleHandleW(nullptr), 0);
  if (!g_hook) {
    g_running.store(false);
    g_ring = nullptr;
    return Napi::Boolean::New(env, false);
  }
  g_pumpThread = std::thread(PumpLoop);
  return Napi::Boolean::New(env, true);
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_running.load()) return env.Undefined();
  g_running.store(false);
  if (g_hook) {
    UnhookWindowsHookEx(g_hook);
    g_hook = nullptr;
  }
  if (g_pumpThread.joinable()) g_pumpThread.join();
  g_ring = nullptr;
  std::lock_guard<std::mutex> lock(g_tsfnMutex);
  if (g_tsfn) {
    g_tsfn.Release();
    g_tsfn = nullptr;
  }
  return env.Undefined();
}

Napi::Value IsRunning(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_running.load());
}

Napi::Value ExcludeWindowFromCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::Error::New(env, "excludeWindowFromCapture(hwndBuffer) required").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto buf = info[0].As<Napi::Buffer<uint8_t>>();
  if (buf.Length() < sizeof(HWND)) {
    return Napi::Boolean::New(env, false);
  }
  HWND hwnd;
  memcpy(&hwnd, buf.Data(), sizeof(HWND));
  // WDA_EXCLUDEFROMCAPTURE (Win10 2004+); WDA_MONITOR is the graceful fallback.
  if (SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)) {
    return Napi::Boolean::New(env, true);
  }
  BOOL ok = SetWindowDisplayAffinity(hwnd, WDA_MONITOR);
  return Napi::Boolean::New(env, ok != 0);
}

Napi::Value SetMoveSamplingHz(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() >= 1 && info[0].IsNumber()) {
    g_moveHz.store(info[0].As<Napi::Number>().Int32Value(), std::memory_order_relaxed);
  }
  return env.Undefined();
}

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("setEventCallback", Napi::Function::New(env, SetEventCallback));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("isRunning", Napi::Function::New(env, IsRunning));
  exports.Set("excludeWindowFromCapture", Napi::Function::New(env, ExcludeWindowFromCapture));
  exports.Set("setMoveSamplingHz", Napi::Function::New(env, SetMoveSamplingHz));
  return exports;
}

$}  // namespace

NODE_API_MODULE(cursor_hook, InitModule)
