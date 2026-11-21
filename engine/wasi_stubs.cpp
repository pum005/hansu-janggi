// wasi_stubs.cpp
// WASI(스레드 없음) 환경에 없는 함수 두 개를 대신한다.
#include <cstddef>

extern "C" {

// thread_local 변수의 소멸자 등록. 스레드가 하나뿐이라 프로그램 종료 시 정리할 필요가 없다.
int __cxa_thread_atexit(void (*)(void*), void*, void*) { return 0; }

// 큰 페이지 힌트(misc.cpp). WebAssembly 메모리에는 해당 기능이 없으므로 무시한다.
int madvise(void*, std::size_t, int) { return 0; }

}
