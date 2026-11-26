# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

한수 장기 (hansujanggi.com): a static, serverless Janggi (Korean chess) site. Fairy-Stockfish runs as WebAssembly inside the visitor's browser. `site/` is the deploy folder (Cloudflare static assets) and has **no build step or bundler**: plain HTML/CSS and ES-module JS. There is no test suite or linter. The UI text, code comments and commit messages are all in Korean.

## Commands

```bash
cd site && python3 -m http.server 8000      # run locally; file:// breaks module scripts and the Worker
python3 tools/build_pages.py                # regenerate article pages + sitemap/robots + stamp ?v= asset hashes
python3 tools/build_pages.py --check        # pre-deploy check: exits 1 if any HTML has a stale ?v= hash
./engine/build.sh                           # rebuild janggi-engine.wasm (downloads wasi-sdk 25 + pinned FSF commit into engine/.build/)
OUT=/tmp/x.wasm ./engine/build.sh           # build to another path
./tools/og/render.sh                        # re-render site/og-image.png (share preview, 1200x630) from tools/og/og-image.html via headless Chrome
```

## Architecture

**Runtime split (browser):**
- Main thread: `site/assets/js/game.js` (single large module) draws the board as SVG and uses **ffish** (`site/assets/engine/v1/ffish.js`, the Fairy-Stockfish rules library) for legal moves, check, bikjang and game-over. The engine never decides legality.
- Web Worker: `site/assets/engine/v1/engine-worker.js` runs `janggi-engine.wasm`, a **single-threaded WASI** build, through a hand-written minimal WASI shim. A WASI program reads all of stdin once in `_start` and exits, so **every request creates a new instance**: game.js sends a list of UCI commands (`setoption … / position fen … moves … / go movetime …`), the worker appends `quit`, then sends back `info` lines and `bestmove`.
- A running search cannot be stopped, so `interruptEngine()` in game.js **terminates the worker and starts a new one**. Requests are matched by `reqId` / `pending.id`. Late replies to old requests are dropped.
- The engine is single-threaded on purpose: it needs no `SharedArrayBuffer` and so no COOP/COEP headers, which would block the AdSense/AdFit scripts. Don't add those headers or a threaded build.

**game.js state model:** the whole game lives in `st`. It holds `startFen` and `moves` (UCI strings like `a1a2`; a pass is a move from a square to the same square). The ffish `board` is rebuilt from these by replaying the moves. `st.view` (review index) shows a separate `viewBoard`. `st.shared` marks a read-only game opened from a share link `#g=…` (base64url-encoded moves). Saved games use localStorage key `hansu-janggi:game:v1`. The analysis data (`st.an.evals/best`) is computed one position at a time with `AN_MS` per position.

**Pages:**
- `site/index.html` (game) and `site/404.html` are hand-written.
- `site/{rules,setups,strategy,engine,privacy,source}/index.html` are **generated**: edit the body in `tools/pages/*.html` (first-line metadata comments `path`/`title`/`desc`). The header, nav and footer template is in `tools/build_pages.py` (`TEMPLATE`, `NAV`). Don't edit the generated files directly.
- Mobile (≤639px) is a separate no-scroll UI on the same page: header `#hdrNew`, `#mbar` (play/over/review modes), new-game bottom sheet `#newDialog`. The panel cards are hidden there. `mrv` in game.js means mobile review mode, which can be on even while `st.view` is null (viewing the latest move). The board size comes from `--m-reserve` in game.css: if you change the height of the mobile controls, update it. Desktop must stay pixel-identical when you touch mobile code.
- SEO: `site/index.html` has a visually hidden `<h1>`, JSON-LD (`WebSite`/`WebApplication`/`FAQPage`) in `<head>`, and a visible intro/FAQ section (`.about`) below the game. The FAQ text in the JSON-LD must match the visible FAQ.
- `site/assets/js/site.js`: mobile menu and the ad config (`ADS` object at the top: provider `none`/`adsense`/`adfit`).

**Caching / versioning (important when deploying):**
- `site/_headers`: CSS/JS are cached for 1 day, so HTML points to them as `?v=<sha256[:10]>`. **After editing anything in `site/assets/css` or `site/assets/js`, rerun `python3 tools/build_pages.py`** so every HTML file gets the new hash.
- Engine files are cached for 1 year (immutable) and versioned by folder name (`assets/engine/v1/`). To change the engine after it's deployed, add a `v2/` folder and update `ENGINE_DIR` in game.js (the ffish import path too). Don't overwrite files in `v1`.

**Engine build** (`engine/`): pinned `FSF_COMMIT` in `build.sh`. `patches/single-thread.patch` makes `start_searching()` run `search()` inline under `SINGLE_THREAD`. `wasi_single_thread.h` (force-included) stubs out std::thread/mutex/condvar. Built with `LARGEBOARDS` and `NNUE_EMBEDDING_OFF` (uses the classical evaluation). `engine/.build/` is gitignored.

## Conventions

- Git flow: `feature/*` / `fix/*` branches → merge into `develop` → release merged to `main` ("Release vX.Y.Z").
- Commit messages: `type(scope): 한국어 설명` (e.g. `fix(cache): …`, `feat(mobile): …`, `style(a11y): …`).
- Responsive breakpoints: desktop ≥1024px, tablet 640–1023px, mobile ≤639px.
- `design/` holds design mockups only and is not deployed.
- License is GPL-3.0 (because it includes Fairy-Stockfish and ffish). Keep `/source/` and the license notices accurate.
