#!/usr/bin/env bash
# 공유 미리보기 그림을 headless Chrome으로 다시 만듭니다: site/og-image.png (1200x630)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$(dirname "$HERE")")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --virtual-time-budget=5000 --allow-file-access-from-files \
  --screenshot="$ROOT/site/og-image.png" "file://$HERE/og-image.html"
echo "wrote site/og-image.png"
