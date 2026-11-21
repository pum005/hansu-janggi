// 한수 장기 — 대국 화면
// 규칙 판정: ffish (Fairy-Stockfish 규칙 라이브러리, GPL-3.0)
// 수 읽기: 단일 스레드로 빌드한 Fairy-Stockfish WebAssembly (Web Worker에서 실행)
import FFishModule from '../engine/v1/ffish.js';

const ENGINE_DIR = new URL('../engine/v1/', import.meta.url);
const SAVE_KEY = 'hansu-janggi:game:v1';

const SETUPS = ['마상상마', '상마마상', '마상마상', '상마상마'];
const LEVELS = [
  { name: '입문', skill: 0, ms: 300 },
  { name: '중수', skill: 7, ms: 700 },
  { name: '고수', skill: 14, ms: 1500 },
  { name: '최강', skill: 20, ms: 3000 },
];
const HANJA = { cho: { k: '楚', r: '車', c: '包', n: '馬', b: '象', a: '士', p: '卒' },
                han: { k: '漢', r: '車', c: '包', n: '馬', b: '象', a: '士', p: '兵' } };
const SIZE = { k: 46, r: 40, c: 40, n: 40, b: 40, a: 32, p: 32 };
const POINTS = { r: 13, c: 7, n: 5, b: 3, a: 3, p: 2, k: 0 };
const KO_NAME = { K: '궁', A: '사', R: '차', C: '포', H: '마', E: '상', P: '졸' };
const NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);
const svg = $('board');

let ff = null, board = null, worker = null, engineReady = false;
let reqId = 0, pending = null, resultDismissed = false;
const st = {
  side: 'cho', level: 2, mySetup: '마상상마', engSetup: '마상상마',
  startFen: '', moves: [], notes: [],
  selected: null, hint: null, evalCho: 0, evalText: '0.0', depth: '', thinking: null, over: null,
};

// ---------- 좌표 ----------
const parseMove = (m) => { const r = /^([a-i])(\d{1,2})([a-i])(\d{1,2})$/.exec(m); return r ? { ff: r[1].charCodeAt(0) - 97, fr: +r[2], tf: r[3].charCodeAt(0) - 97, tr: +r[4] } : null; };
const isPass = (p) => p && p.ff === p.tf && p.fr === p.tr;
function toXY(f, r) { // 내 진영이 항상 아래
  const flip = st.side === 'han';
  const col = flip ? 8 - f : f;
  const row = flip ? r - 1 : 10 - r;
  return [50 + col * 100, 50 + row * 100];
}
function fromXY(x, y) {
  const col = Math.round((x - 50) / 100), row = Math.round((y - 50) / 100);
  if (col < 0 || col > 8 || row < 0 || row > 9) return null;
  if (Math.hypot(x - (50 + col * 100), y - (50 + row * 100)) > 50) return null;
  const flip = st.side === 'han';
  return { f: flip ? 8 - col : col, r: flip ? row + 1 : 10 - row };
}
const sideToMove = () => (board.turn() ? 'cho' : 'han');
const other = (s) => (s === 'cho' ? 'han' : 'cho');
const movedBy = (i) => (i % 2 === 0 ? 'cho' : 'han');

// ---------- 상차림 → FEN ----------
function backRank(setup, upper) {
  const pc = [...setup].map((ch) => (ch === '마' ? 'n' : 'b'));
  // 초는 a→i가 왼쪽→오른쪽, 한은 반대편에서 보므로 i→a가 왼쪽→오른쪽
  const [b, c, g, h] = upper ? pc : [pc[3], pc[2], pc[1], pc[0]];
  const s = `r${b}${c}a1a${g}${h}r`;
  return upper ? s.toUpperCase() : s;
}
function buildStartFen() {
  const pick = (v) => (v === '무작위' ? SETUPS[Math.floor(Math.random() * 4)] : v);
  const my = pick(st.mySetup), eng = pick(st.engSetup);
  const cho = st.side === 'cho' ? my : eng, han = st.side === 'cho' ? eng : my;
  return `${backRank(han, false)}/4k4/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/4K4/${backRank(cho, true)} w - - 0 1`;
}

// ---------- 판 상태 ----------
function rebuild() {
  if (board) board.delete();
  board = new ff.Board('janggi', st.startFen);
  st.notes = [];
  for (const m of st.moves) { st.notes.push(noteFor(m)); board.push(m); }
}
function noteFor(m) {
  if (isPass(parseMove(m))) return '한수 쉼';
  const s = board.sanMove(m, ff.Notation.JANGGI); // 예: H02-83
  const r = /^([A-Z])(\d+)-(\d+)$/.exec(s);
  if (!r) return s;
  let name = KO_NAME[r[1]] || r[1];
  if (r[1] === 'P' && !board.turn()) name = '병';
  return `${r[2]}${name}${r[3]}`;
}
function pieceGrid() {
  const out = [];
  board.fen().split(' ')[0].split('/').forEach((row, i) => {
    const r = 10 - i; let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += +ch;
      else { out.push({ f, r, t: ch.toLowerCase(), side: ch === ch.toUpperCase() ? 'cho' : 'han' }); f++; }
    }
  });
  return out;
}
const legalList = () => board.legalMoves().split(' ').filter(Boolean);
const legalFrom = (f, r) => legalList().filter((m) => { const p = parseMove(m); return p && p.ff === f && p.fr === r && !isPass(p); });
const passMove = () => legalList().find((m) => isPass(parseMove(m))) || null;

// ---------- 그리기 ----------
function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function octagon(cx, cy, R) {
  const pts = [];
  for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + i * Math.PI / 4; pts.push(`${(cx + R * Math.cos(a)).toFixed(1)},${(cy + R * Math.sin(a)).toFixed(1)}`); }
  return pts.join(' ');
}
function drawStatic() {
  svg.innerHTML = `<defs>
    <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ecd9b0"/><stop offset="1" stop-color="#e2c993"/></linearGradient>
    <filter id="pshadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#5a4220" flood-opacity=".28"/></filter>
  </defs>`;
  el('rect', { x: -30, y: -30, width: 960, height: 1060, rx: 26, fill: 'url(#wood)' }, svg);
  const g = el('g', { class: 'grid' }, svg);
  for (let c = 1; c < 8; c++) el('line', { x1: 50 + c * 100, y1: 50, x2: 50 + c * 100, y2: 950 }, g);
  for (let r = 1; r < 9; r++) el('line', { x1: 50, y1: 50 + r * 100, x2: 850, y2: 50 + r * 100 }, g);
  for (const top of [50, 750]) {
    el('line', { x1: 350, y1: top, x2: 550, y2: top + 200 }, g);
    el('line', { x1: 550, y1: top, x2: 350, y2: top + 200 }, g);
  }
  el('rect', { class: 'edge', x: 50, y: 50, width: 800, height: 900 }, g);
  el('g', { id: 'underLayer' }, svg);
  el('g', { id: 'pieceLayer' }, svg);
  el('g', { id: 'markLayer' }, svg);
}

function render() {
  const pl = $('pieceLayer'), ml = $('markLayer'), ul = $('underLayer');
  pl.innerHTML = ''; ml.innerHTML = ''; ul.innerHTML = '';

  // 직전 수: 출발점 점, 도착점 모서리 표시
  const last = st.moves[st.moves.length - 1];
  if (last) {
    const p = parseMove(last);
    const [x1, y1] = toXY(p.ff, p.fr), [x2, y2] = toXY(p.tf, p.tr);
    if (!isPass(p)) {
      el('circle', { class: 'last-from', cx: x1, cy: y1, r: 11 }, ul);
      const d = 50, c = 15;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        el('path', { class: 'last-to', d: `M${x2 + sx * d},${y2 + sy * (d - c)} L${x2 + sx * d},${y2 + sy * d} L${x2 + sx * (d - c)},${y2 + sy * d}` }, ml);
      }
    }
  }

  // 훈수: 선은 기물 아래, 머리와 도착 표시는 위
  if (st.hint) {
    const p = parseMove(st.hint);
    const [x1, y1] = toXY(p.ff, p.fr), [x2, y2] = toXY(p.tf, p.tr);
    if (isPass(p)) {
      el('circle', { class: 'hint-ring', cx: x1, cy: y1, r: 58 }, ml);
    } else {
      const ang = Math.atan2(y2 - y1, x2 - x1);
      el('line', { class: 'hint-line', x1, y1, x2: x2 - Math.cos(ang) * 60, y2: y2 - Math.sin(ang) * 60 }, ul);
      el('circle', { class: 'hint-ring', cx: x2, cy: y2, r: 30 }, ml);
      const s = 32, hx = x2 - Math.cos(ang) * 30, hy = y2 - Math.sin(ang) * 30;
      const pts = [[hx, hy], [hx - s * Math.cos(ang - 0.5), hy - s * Math.sin(ang - 0.5)], [hx - s * Math.cos(ang + 0.5), hy - s * Math.sin(ang + 0.5)]];
      el('polygon', { class: 'hint-head', points: pts.map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' ') }, ml);
    }
  }

  const grid = pieceGrid();
  const inCheck = board.isCheck();
  const stm = sideToMove();
  for (const p of grid) {
    const [x, y] = toXY(p.f, p.r);
    const R = SIZE[p.t];
    const g = el('g', { class: `piece ${p.side}` }, pl);
    el('polygon', { class: 'octa', points: octagon(x, y, R), filter: 'url(#pshadow)' }, g);
    el('polygon', { class: 'inner', points: octagon(x, y, R - 6) }, g);
    const t = el('text', { x, y: y + 1, 'font-size': Math.round(R * 1.08) }, g);
    t.textContent = HANJA[p.side][p.t];
    if (inCheck && p.t === 'k' && p.side === stm) el('polygon', { class: 'check-ring', points: octagon(x, y, R + 9) }, ml);
  }

  if (st.selected) {
    const [x, y] = toXY(st.selected.f, st.selected.r);
    el('polygon', { class: 'sel-ring', points: octagon(x, y, SIZE[st.selected.t] + 7) }, ml);
    const occ = new Set(grid.map((p) => `${p.f},${p.r}`));
    for (const m of st.selected.moves) {
      const p = parseMove(m);
      const [dx, dy] = toXY(p.tf, p.tr);
      if (occ.has(`${p.tf},${p.tr}`)) el('circle', { class: 'dest-cap', cx: dx, cy: dy, r: 47 }, ml);
      else el('circle', { class: 'dest', cx: dx, cy: dy, r: 14 }, ml);
    }
  }
  renderPanel();
}

function material() {
  const sum = { cho: 0, han: 1.5 }; // 한 덤 1.5점
  for (const p of pieceGrid()) sum[p.side] += POINTS[p.t];
  return sum;
}

function renderPanel() {
  const ready = engineReady && board;
  const stm = board ? sideToMove() : 'cho';
  const myTurn = ready && !st.over && !st.thinking && stm === st.side;
  const lv = LEVELS[st.level];

  // 플레이어 줄
  const me = st.side, ai = other(st.side);
  $('aiChip').className = `chip ${ai}`; $('aiChip').textContent = ai === 'cho' ? '楚' : '漢';
  $('meChip').className = `chip ${me}`; $('meChip').textContent = me === 'cho' ? '楚' : '漢';
  $('aiName').textContent = `AI · ${lv.name}`;
  $('meSetup').textContent = st.mySetup === '무작위' ? '' : `상차림 · ${st.mySetup}`;
  const aiTurn = $('aiTurn'), meTurn = $('meTurn');
  aiTurn.className = `turn ${ai}` + (st.thinking === 'engine' ? ' thinking' : '');
  meTurn.className = `turn ${me}` + (st.thinking === 'hint' ? ' thinking' : '');
  aiTurn.hidden = !(ready && !st.over && stm === ai);
  meTurn.hidden = !(ready && !st.over && stm === me);
  $('aiTurnText').textContent = st.thinking === 'engine' ? (st.depth ? `생각 중 · 깊이 ${st.depth}` : '생각 중') : '차례';
  $('meTurnText').textContent = st.thinking === 'hint' ? '훈수 찾는 중' : '내 차례';

  // 상태
  let status, sub = '';
  if (!engineReady) { status = '엔진을 불러오는 중…'; sub = '처음 한 번만 엔진 파일(약 1MB)을 받습니다'; }
  else if (st.over) { status = st.over.title; sub = st.over.text; }
  else if (st.thinking === 'engine') { status = '상대가 수를 읽는 중'; sub = st.depth ? `${st.depth}수 앞까지 읽음` : '준비 중'; }
  else if (st.thinking === 'hint') { status = '훈수를 찾는 중'; sub = st.depth ? `${st.depth}수 앞까지 읽음` : '준비 중'; }
  else { status = myTurn ? '내 차례' : '상대 차례'; sub = st.selected ? '움직일 곳을 누르세요' : '내 기물을 눌러 움직일 곳을 고르세요'; }
  if (ready && !st.over && board.isCheck()) sub = `<span class="alert">장군!</span> ${stm === st.side ? '궁을 지켜야 합니다' : ''}`;
  else if (ready && !st.over && board.isBikjang()) sub = '<span class="alert">빅장</span> 궁끼리 마주 보고 있습니다';
  $('statusText').textContent = status;
  $('subText').innerHTML = sub;

  const pct = 50 + 50 * Math.tanh(st.evalCho / 700);
  $('evalFill').style.width = pct.toFixed(1) + '%';
  const et = $('evalText');
  et.textContent = st.evalText;
  et.className = st.evalCho > 0 ? 'cho' : st.evalCho < 0 ? 'han' : '';
  if (board) { const m = material(); $('materialText').textContent = `기물 점수 초 ${m.cho} · 한 ${m.han}`; }

  // 버튼
  $('hintBtn').disabled = !myTurn;
  $('passBtn').disabled = !myTurn || !passMove();
  $('undoBtn').disabled = !engineReady || st.thinking === 'hint' || !st.moves.some((_, i) => movedBy(i) === st.side);
  $('newBtn').disabled = !ff;

  // 수순
  const list = $('moveList');
  if (!st.notes.length) list.innerHTML = '<span class="empty">아직 둔 수가 없습니다</span>';
  else {
    let html = '';
    const lastI = st.notes.length - 1;
    for (let i = 0; i < st.notes.length; i += 2) {
      const cls = (j, side) => `m ${side}` + (j === lastI ? ` last${side === 'c' ? ' c' : ''}` : '');
      html += `<span class="n">${i / 2 + 1}</span><span class="${cls(i, 'c')}">${st.notes[i]}</span><span class="${cls(i + 1, 'h')}">${st.notes[i + 1] || ''}</span>`;
    }
    list.innerHTML = html;
    list.scrollTop = list.scrollHeight;
  }

  // 결과 창
  const res = $('result');
  if (st.over && !resultDismissed) {
    res.hidden = false;
    $('resultTitle').textContent = st.over.title;
    $('resultText').textContent = st.over.text;
  } else res.hidden = true;
}

// ---------- 대국 진행 ----------
function checkOver() {
  if (!board.isGameOver(false)) { st.over = null; return false; }
  const res = board.result(false);
  const reason = board.isBikjang() ? '빅장으로 점수 판정' : board.isCheck() ? '외통수' : '규칙에 따른 판정';
  if (res === '1/2-1/2') st.over = { title: '무승부', text: reason };
  else {
    const winner = res === '1-0' ? 'cho' : 'han';
    st.over = winner === st.side
      ? { title: '이겼습니다!', text: `${reason}로 AI(${LEVELS[st.level].name})를 꺾었습니다.` }
      : { title: '졌습니다', text: `${reason}. 무르기로 돌아가 다시 둬 보세요.` };
  }
  return true;
}
function play(m) {
  st.notes.push(noteFor(m));
  board.push(m);
  st.moves.push(m);
  st.selected = null; st.hint = null; resultDismissed = false;
  checkOver();
  render();
  save();
  if (!st.over && sideToMove() !== st.side) askEngine('engine');
}
function askEngine(kind) {
  const lv = LEVELS[st.level];
  const full = kind === 'hint';
  st.thinking = kind; st.depth = '';
  const id = ++reqId;
  pending = { id, kind, rootSide: sideToMove() };
  worker.postMessage({ type: 'go', id, commands: [
    'setoption name UCI_Variant value janggi',
    `setoption name Skill Level value ${full ? 20 : lv.skill}`,
    `position fen ${st.startFen}${st.moves.length ? ' moves ' + st.moves.join(' ') : ''}`,
    `go movetime ${full ? 1500 : lv.ms}`,
  ] });
  render();
}
function applyInfo(line, rootSide) {
  const d = /\bdepth (\d+)/.exec(line); if (d) st.depth = d[1];
  const cp = /score cp (-?\d+)/.exec(line), mate = /score mate (-?\d+)/.exec(line);
  const sign = rootSide === 'cho' ? 1 : -1;
  if (cp) { st.evalCho = sign * +cp[1]; const v = st.evalCho / 100; st.evalText = (v > 0 ? '초 +' : v < 0 ? '한 +' : '') + Math.abs(v).toFixed(1); }
  else if (mate) { const n = +mate[1] * sign; st.evalCho = n > 0 ? 5000 : -5000; st.evalText = `${n > 0 ? '초' : '한'} ${Math.abs(+mate[1])}수 외통`; }
}
function onWorker(ev) {
  const msg = ev.data;
  if (msg.type === 'ready') {
    engineReady = true; render();
    if (!st.over && sideToMove() !== st.side) askEngine('engine');
    return;
  }
  if (!pending || msg.id !== pending.id) return;
  if (msg.type === 'info') { applyInfo(msg.line, pending.rootSide); renderPanel(); return; }
  if (msg.type === 'error') { st.thinking = null; pending = null; render(); $('subText').textContent = '엔진 오류: ' + msg.message; return; }
  if (msg.type === 'bestmove') {
    const kind = pending.kind; pending = null; st.thinking = null;
    if (msg.info) applyInfo(msg.info, sideToMove());
    if (!msg.move || msg.move === '(none)') { checkOver(); render(); return; }
    if (kind === 'engine') play(msg.move);
    else { st.hint = msg.move; render(); }
  }
}
function startWorker() {
  if (worker) worker.terminate();
  engineReady = false; pending = null; st.thinking = null;
  worker = new Worker(new URL('engine-worker.js', ENGINE_DIR));
  worker.onmessage = onWorker;
  worker.onerror = (e) => { $('statusText').textContent = '엔진을 시작하지 못했습니다'; $('subText').textContent = e.message || '새로고침해 보세요'; };
  worker.postMessage({ type: 'init', url: new URL('janggi-engine.wasm', ENGINE_DIR).href });
}
// 엔진이 읽는 중에 판을 바꿔야 하면 워커를 새로 띄움 (단일 스레드라 중간에 멈출 수 없음)
function interruptEngine() { if (st.thinking || pending) startWorker(); }

// ---------- 입력 ----------
svg.addEventListener('click', (ev) => {
  if (!engineReady || st.over || st.thinking || sideToMove() !== st.side) return;
  const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  const at = fromXY(p.x, p.y);
  if (!at) return;
  const here = pieceGrid().find((q) => q.f === at.f && q.r === at.r);
  if (st.selected) {
    if (st.selected.f === at.f && st.selected.r === at.r) { st.selected = null; render(); return; }
    const mv = st.selected.moves.find((m) => { const q = parseMove(m); return q.tf === at.f && q.tr === at.r; });
    if (mv) { play(mv); return; }
  }
  st.selected = here && here.side === st.side ? { f: at.f, r: at.r, t: here.t, moves: legalFrom(at.f, at.r) } : null;
  render();
});
$('hintBtn').onclick = () => { st.selected = null; askEngine('hint'); };
$('passBtn').onclick = () => { const m = passMove(); if (m) play(m); };
function undo() {
  if (st.thinking === 'hint') return;
  let i = st.moves.length - 1;
  while (i >= 0 && movedBy(i) !== st.side) i--;
  if (i < 0) return;
  interruptEngine();
  st.moves = st.moves.slice(0, i);
  st.selected = null; st.hint = null; st.over = null; resultDismissed = false;
  rebuild(); checkOver(); render(); save();
}
$('undoBtn').onclick = undo;
$('resultUndo').onclick = undo;
$('newBtn').onclick = () => newGame();
$('resultNew').onclick = () => newGame();
$('resultClose').onclick = () => { resultDismissed = true; renderPanel(); };

// 설정
let chosenSide = 'cho';
function setSide(side) {
  chosenSide = side;
  $('sideCho').setAttribute('aria-pressed', String(side === 'cho'));
  $('sideHan').setAttribute('aria-pressed', String(side === 'han'));
}
$('sideCho').onclick = () => setSide('cho');
$('sideHan').onclick = () => setSide('han');

function setLevel(lv) {
  st.level = lv;
  document.querySelectorAll('#levelSeg button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.level === lv)));
  if (board) { renderPanel(); save(); }
}
document.querySelectorAll('#levelSeg button').forEach((b) => { b.onclick = () => setLevel(+b.dataset.level); });

const fillSetup = (id, withRandom) => { $(id).innerHTML = SETUPS.map((v) => `<option>${v}</option>`).join('') + (withRandom ? '<option>무작위</option>' : ''); };
fillSetup('mySetup', false); fillSetup('engSetup', true);

function newGame() {
  st.side = chosenSide;
  st.mySetup = $('mySetup').value;
  st.engSetup = $('engSetup').value;
  st.startFen = buildStartFen();
  st.moves = []; st.selected = null; st.hint = null; st.over = null; resultDismissed = false;
  st.evalCho = 0; st.evalText = '0.0'; st.depth = '';
  interruptEngine();
  rebuild(); drawStatic(); render(); save();
  if (engineReady && sideToMove() !== st.side) askEngine('engine');
}

// ---------- 이어하기 (브라우저 저장소) ----------
function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      side: st.side, level: st.level, mySetup: st.mySetup, engSetup: st.engSetup, startFen: st.startFen, moves: st.moves,
    }));
  } catch (e) { /* 사생활 보호 모드 등 */ }
}
function load() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { return null; }
}

async function start() {
  ff = await FFishModule({ locateFile: (f) => new URL(f, ENGINE_DIR).href });
  const data = load();
  let restored = false;
  if (data && data.startFen) {
    try {
      setSide(data.side); setLevel(data.level ?? 2);
      $('mySetup').value = data.mySetup; $('engSetup').value = data.engSetup;
      Object.assign(st, { side: data.side, mySetup: data.mySetup, engSetup: data.engSetup, startFen: data.startFen, moves: data.moves || [] });
      rebuild(); checkOver(); resultDismissed = !!st.over; drawStatic(); render();
      restored = true;
    } catch (e) { st.moves = []; }
  }
  if (!restored) { setLevel(2); newGame(); }
  startWorker();
}
start().catch((e) => {
  $('statusText').textContent = '불러오지 못했습니다';
  $('subText').textContent = String((e && e.message) || e);
});
