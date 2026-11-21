#!/usr/bin/env bash
# 한수 장기 엔진 빌드 스크립트
# Fairy-Stockfish를 단일 스레드 WASI WebAssembly로 빌드해 site/assets/engine/v1/janggi-engine.wasm 을 만든다.
#
# 필요: git, curl, tar (macOS arm64/x86_64, Linux x86_64/arm64)
# 사용: ./engine/build.sh            → 빌드 후 사이트 폴더에 복사
#       OUT=/tmp/x.wasm ./engine/build.sh  → 다른 위치로 출력
set -euo pipefail

FSF_REPO="https://github.com/fairy-stockfish/Fairy-Stockfish.git"
FSF_COMMIT="52838835f7234e29fb48fd88eb39fb3c7e46fcfa"   # 2026-11-19, "Remove the all build option (#1099)"
WASI_SDK_VERSION="25"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
WORK="$HERE/.build"
OUT="${OUT:-$ROOT/site/assets/engine/v1/janggi-engine.wasm}"
mkdir -p "$WORK"

# 1) wasi-sdk 받기
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  SDK_ARCH="arm64-macos" ;;
  Darwin-x86_64) SDK_ARCH="x86_64-macos" ;;
  Linux-x86_64)  SDK_ARCH="x86_64-linux" ;;
  Linux-aarch64) SDK_ARCH="arm64-linux" ;;
  *) echo "지원하지 않는 환경: $(uname -s)-$(uname -m)"; exit 1 ;;
esac
SDK="$WORK/wasi-sdk-${WASI_SDK_VERSION}.0-${SDK_ARCH}"
if [ ! -x "$SDK/bin/clang++" ]; then
  echo "▶ wasi-sdk ${WASI_SDK_VERSION} 내려받는 중"
  curl -fsSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION}.0-${SDK_ARCH}.tar.gz" | tar xz -C "$WORK"
fi

# 2) Fairy-Stockfish 소스를 고정된 커밋으로 받고 패치 적용
SRC="$WORK/fsf"
if [ ! -d "$SRC/.git" ]; then
  echo "▶ Fairy-Stockfish 소스 받는 중"
  git clone -q "$FSF_REPO" "$SRC"
fi
git -C "$SRC" fetch -q origin "$FSF_COMMIT" 2>/dev/null || true
git -C "$SRC" checkout -q -f "$FSF_COMMIT"
git -C "$SRC" clean -qfd
for p in "$HERE"/patches/*.patch; do
  echo "▶ 패치 적용: $(basename "$p")"
  git -C "$SRC" apply "$p"
done

# 3) 컴파일
cd "$SRC/src"
SRCS="benchmark.cpp bitbase.cpp bitboard.cpp endgame.cpp evaluate.cpp main.cpp
  material.cpp misc.cpp movegen.cpp movepick.cpp pawns.cpp position.cpp psqt.cpp
  search.cpp thread.cpp timeman.cpp tt.cpp uci.cpp ucioption.cpp tune.cpp syzygy/tbprobe.cpp
  nnue/evaluate_nnue.cpp nnue/features/half_ka_v2.cpp
  partner.cpp parser.cpp piece.cpp variant.cpp xboard.cpp
  nnue/features/half_ka_v2_variants.cpp
  $HERE/wasi_stubs.cpp"

CXXFLAGS=(
  --target=wasm32-wasip1 --sysroot="$SDK/share/wasi-sysroot"
  -std=c++17 -O3 -flto -fno-exceptions
  -DNDEBUG -DIS_64BIT -DNO_PREFETCH
  -DLARGEBOARDS -DPRECOMPUTED_MAGICS     # 장기판은 9x10이라 큰 판 빌드가 필요
  -DNNUE_EMBEDDING_OFF                  # 신경망 파일을 넣지 않음 (전통 평가 함수 사용)
  -DSINGLE_THREAD                       # patches/single-thread.patch
  -include "$HERE/wasi_single_thread.h"
  -D_WASI_EMULATED_MMAN                 # syzygy 코드가 mmap을 참조함 (장기에서는 쓰지 않음)
  -Wno-deprecated-declarations
)
LDFLAGS=(
  -Wl,-z,stack-size=8388608             # 원본 엔진의 스레드 스택과 같은 8MB
  -Wl,--strip-all
  -lwasi-emulated-mman
)

echo "▶ 컴파일 중 (몇 분 걸릴 수 있음)"
# shellcheck disable=SC2086
"$SDK/bin/clang++" "${CXXFLAGS[@]}" $SRCS "${LDFLAGS[@]}" -o "$WORK/janggi-engine.wasm"

mkdir -p "$(dirname "$OUT")"
cp "$WORK/janggi-engine.wasm" "$OUT"
echo "✔ 완료: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
shasum -a 256 "$OUT"
