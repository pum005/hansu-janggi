# 엔진 빌드

`site/assets/engine/v1/janggi-engine.wasm`을 소스에서 만듭니다.

```bash
./engine/build.sh                         # 빌드 후 site/assets/engine/v1/ 에 복사
OUT=/tmp/test.wasm ./engine/build.sh      # 다른 곳에 출력
```

처음 실행할 때 `engine/.build/`에 wasi-sdk 25(약 100MB)와 Fairy-Stockfish 소스를 내려받습니다. 이 폴더는 git에 올리지 않습니다.

| 파일 | 역할 |
| --- | --- |
| `build.sh` | 고정 커밋 받기 → 패치 적용 → wasi-sdk clang으로 컴파일 |
| `patches/single-thread.patch` | `thread.cpp`: `SINGLE_THREAD`일 때 `start_searching()`이 그 자리에서 `search()`를 실행 |
| `wasi_single_thread.h` | WASI libc++에 없는 `std::mutex`, `condition_variable`, `thread` 등을 빈 동작으로 대체 (`-include`로 강제 포함) |
| `wasi_stubs.cpp` | `__cxa_thread_atexit`, `madvise` 빈 구현 |

## 동작 방식

WASI 프로그램이라 `_start` 한 번에 표준입력의 UCI 명령을 모두 읽고 끝납니다.
`site/assets/engine/v1/engine-worker.js`가 수마다 새 인스턴스를 만들어
`setoption … / position … / go movetime … / quit`을 넣고 `bestmove`를 받습니다.
단일 스레드라 `go`는 탐색이 끝날 때까지 돌아오지 않고, 시간 관리는 `MainThread::check_time()`이 맡습니다.

## 원본 버전 올리기

1. `build.sh`의 `FSF_COMMIT`을 새 커밋으로 바꿉니다.
2. 패치가 안 맞으면 `engine/.build/fsf`에서 고친 뒤 `git -C engine/.build/fsf diff > engine/patches/single-thread.patch`.
3. 엔진 파일은 1년 캐시되므로, 이미 배포한 뒤라면 `v2` 폴더로 올리고 `site/assets/js/game.js`의 `ENGINE_DIR`을 바꿉니다.

라이선스: GPL-3.0 (Fairy-Stockfish 원본과 같음)
