// wasi_single_thread.h
// WASI(wasm32-wasip1)용 libc++에는 스레드가 없어 std::mutex, std::condition_variable,
// std::thread가 정의되지 않는다. 단일 스레드 빌드에서는 잠금이 필요 없으므로
// 아무 일도 하지 않는 대체 타입을 넣는다. 컴파일러 옵션 -include 로 모든 소스에 먼저 포함된다.
// std::thread는 생성 즉시 함수를 그 자리에서 실행한다(TranspositionTable::clear 등).
// Thread::idle_loop 처럼 계속 대기하는 스레드는 thread.cpp 패치(SINGLE_THREAD)로 처리한다.
#pragma once
#if defined(__wasi__) && !defined(_REENTRANT)

#include <__config>
#include <chrono>
#include <functional>
#include <mutex>
#include <utility>

namespace std {

struct mutex {
  constexpr mutex() noexcept = default;
  mutex(const mutex&) = delete;
  mutex& operator=(const mutex&) = delete;
  void lock() {}
  bool try_lock() { return true; }
  void unlock() {}
};

template <class M> class unique_lock {
public:
  explicit unique_lock(M& m) : m_(&m) {}
  void lock() {}
  void unlock() {}
private:
  M* m_;
};

template <class... M> class scoped_lock {
public:
  explicit scoped_lock(M&...) {}
};

struct condition_variable {
  void notify_one() noexcept {}
  void notify_all() noexcept {}
  // 단일 스레드에서는 다른 스레드가 조건을 바꿔 줄 수 없으므로 기다리지 않고 돌아온다.
  template <class L> void wait(L&) {}
  template <class L, class P> void wait(L&, P) {}
};

class thread {
public:
  thread() noexcept = default;
  template <class F, class... A>
  explicit thread(F&& f, A&&... a) { std::invoke(std::forward<F>(f), std::forward<A>(a)...); }
  bool joinable() const noexcept { return false; }
  void join() {}
  void detach() {}
};

} // namespace std

#endif
