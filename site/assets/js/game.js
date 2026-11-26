// 한수 장기 — 대국 화면
// 규칙 판정: ffish (Fairy-Stockfish 규칙 라이브러리, GPL-3.0)
// 수 읽기: 단일 스레드로 빌드한 Fairy-Stockfish WebAssembly (Web Worker에서 실행)
import FFishModule from '../engine/v1/ffish.js';

const ENGINE_DIR = new URL('../engine/v1/', import.meta.url);
const SAVE_KEY = 'hansu-janggi:game:v1';

// 언어: i18n.js가 <html lang>을 정해 둠. 화면 글자는 T('한국어', 'English')로 고름
const EN = document.documentElement.lang === 'en';
const T = (ko, en) => (EN ? en : ko);

// 상차림 값(저장·공유에 쓰는 이름)은 언어와 상관없이 한국어. 화면에만 suName()으로 보임
const SETUPS = ['마상상마', '상마마상', '마상마상', '상마상마'];
const suName = (v) => (!EN ? v : v === '무작위' ? 'Random' : v.replace(/마/g, 'H').replace(/상/g, 'E'));
const LEVELS = [
  { name: T('입문', 'Easy'), skill: 0, ms: 300 },
  { name: T('중수', 'Medium'), skill: 7, ms: 700 },
  { name: T('고수', 'Hard'), skill: 14, ms: 1500 },
  { name: T('최강', 'Max'), skill: 20, ms: 3000 },
];
const HANJA = { cho: { k: '楚', r: '車', c: '包', n: '馬', b: '象', a: '士', p: '卒' },
                han: { k: '漢', r: '車', c: '包', n: '馬', b: '象', a: '士', p: '兵' } };
const SIZE = { k: 50, r: 44, c: 44, n: 44, b: 44, a: 36, p: 36 }; // 칸 간격 100 기준 반지름
const POINTS = { r: 13, c: 7, n: 5, b: 3, a: 3, p: 2, k: 0 };
const KO_NAME = { K: '궁', A: '사', R: '차', C: '포', H: '마', E: '상', P: '졸' };
const EN_NAME = { K: 'General', A: 'Guard', R: 'Chariot', C: 'Cannon', H: 'Horse', E: 'Elephant', P: 'Soldier' };
const NS = 'http://www.w3.org/2000/svg';
const AN_MS = 300;       // 분석할 때 국면마다 엔진이 읽는 시간(ms)
const MATE = 100000;     // 외통 점수: ±(MATE - 남은 수)

const $ = (id) => document.getElementById(id);
const svg = $('board');

let ff = null, board = null, worker = null, engineReady = false;
let viewBoard = null; // 복기 중에 보여 줄 판 (진행 중인 판 board와 따로 둠)
let reqId = 0, pending = null, resultDismissed = false;
// 휴대폰은 '복기'를 누르면 최신 수부터 넘겨 보는 복기 화면이 됨 (st.view가 null이어도 복기 중일 수 있음)
let mrv = false;
const mq = matchMedia('(max-width: 639px)');
const isMobile = () => mq.matches;
const BAD = ['inaccuracy', 'mistake', 'blunder'];
const st = {
  side: 'cho', level: 2, mySetup: '마상상마', engSetup: '마상상마',
  startFen: '', moves: [], notes: [],
  selected: null, hint: null, evalCho: 0, evalText: '0.0', depth: '', thinking: null, over: null,
  view: null, // 복기 중이면 보고 있는 수 번호(0 = 첫 배치), 아니면 null
  shared: false, // 공유 링크로 연 기보를 보는 중이면 true (두기·저장 안 함)
  // 대국 분석: i번째 국면(i수를 둔 뒤)의 형세(초 기준 cp)와 그 국면의 최선 수
  an: { evals: [], best: [] },
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
const fenFor = (cho, han) => `${backRank(han, false)}/4k4/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/4K4/${backRank(cho, true)} w - - 0 1`;
function buildStartFen() {
  const pick = (v) => (v === '무작위' ? SETUPS[Math.floor(Math.random() * 4)] : v);
  const my = pick(st.mySetup), eng = pick(st.engSetup);
  return st.side === 'cho' ? fenFor(my, eng) : fenFor(eng, my);
}
// 시작 FEN에서 초·한 상차림을 거꾸로 찾음 (못 찾으면 null)
function setupsFromFen(fen) {
  const rows = fen.split(' ')[0].split('/');
  const cho = SETUPS.find((v) => backRank(v, true) === rows[9]);
  const han = SETUPS.find((v) => backRank(v, false) === rows[0]);
  return cho && han && fenFor(cho, han) === fen ? { cho, han } : null;
}

// ---------- 판 상태 ----------
function rebuild() {
  clearView();
  // 무르기 등으로 수순이 줄면 그 뒤 국면의 분석은 버림 (앞 국면 분석은 그대로 유효)
  st.an.evals.length = Math.min(st.an.evals.length, st.moves.length + 1);
  st.an.best.length = Math.min(st.an.best.length, st.moves.length + 1);
  if (board) board.delete();
  board = new ff.Board('janggi', st.startFen);
  st.notes = [];
  for (const m of st.moves) { st.notes.push(noteFor(m)); board.push(m); }
}
function noteFor(m, b = board) {
  if (isPass(parseMove(m))) return T('한수 쉼', 'Pass');
  const s = b.sanMove(m, ff.Notation.JANGGI); // 예: H02-83, 잡는 수는 R71x81
  const r = /^([A-Z])(\d+)[-x](\d+)/.exec(s);
  if (!r) return s;
  if (EN) return r[0]; // 영어는 국제 표기 그대로 (H02-83)
  let name = KO_NAME[r[1]] || r[1];
  if (r[1] === 'P' && !b.turn()) name = '병';
  return `${r[2]}${name}${r[3]}`;
}
function pieceGrid(b = board) {
  const out = [];
  b.fen().split(' ')[0].split('/').forEach((row, i) => {
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

// ---------- 화면에 보이는 판 ----------
// 복기 중이면 st.view 수까지 둔 판, 아니면 진행 중인 판
const reviewing = () => st.view !== null;
const shownBoard = () => (reviewing() ? viewBoard : board);
const shownCount = () => (reviewing() ? st.view : st.moves.length);
function clearView() {
  if (viewBoard) { viewBoard.delete(); viewBoard = null; }
  st.view = null;
}
function setView(n) {
  if (n === null || n >= st.moves.length) n = null;
  else n = Math.max(0, n);
  if (n === st.view) return;
  clearView();
  st.view = n;
  if (n !== null) {
    viewBoard = new ff.Board('janggi', st.startFen);
    for (const m of st.moves.slice(0, n)) viewBoard.push(m);
  }
  st.selected = null; st.hint = null;
  render();
}

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
    <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e8bf78"/><stop offset="1" stop-color="#d6a258"/></linearGradient>
    <radialGradient id="pface" cx=".42" cy=".36" r=".8"><stop offset="0" stop-color="#fffdf7"/><stop offset=".75" stop-color="#f8f1e1"/><stop offset="1" stop-color="#efe3c8"/></radialGradient>
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
  const b = shownBoard();

  // 직전 수: 출발점 점, 도착점 모서리 표시
  const last = st.moves[shownCount() - 1];
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
  // 복기·공유 보기에서 분석 결과가 있으면 그 국면의 최선 수를 같은 화살표로 보여 줌
  let arrow = st.hint || ((reviewing() || st.shared) && st.thinking !== 'analyze' ? st.an.best[shownCount()] : null);
  if (isMobile() && mBrowsing()) {
    const j = shownCount() - 1, v = j >= 0 ? judge(j) : null;
    arrow = v && BAD.includes(v.kind) && st.an.best[j] !== st.moves[j] ? st.an.best[j] : null;
  }
  if (arrow) {
    const p = parseMove(arrow);
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

  const grid = pieceGrid(b);
  const inCheck = b.isCheck();
  const stm = b.turn() ? 'cho' : 'han';
  for (const p of grid) {
    const [x, y] = toXY(p.f, p.r);
    const R = SIZE[p.t];
    const g = el('g', { class: `piece ${p.side}` }, pl);
    el('polygon', { class: 'octa', points: octagon(x, y, R), filter: 'url(#pshadow)' }, g);
    el('polygon', { class: 'inner', points: octagon(x, y, R - 6) }, g);
    // 작은 기물(사·졸)은 글자 비율을 조금 키워 휴대폰에서도 잘 읽히게
    const t = el('text', { x, y: y + 1, 'font-size': Math.round(R * (R < 40 ? 1.12 : 1.04)) }, g);
    t.textContent = HANJA[p.side][p.t];
    if (inCheck && p.t === 'k' && p.side === stm) el('polygon', { class: 'check-ring', points: octagon(x, y, R + 9) }, ml);
  }

  // AI가 방금 둔 수: 출발점에서 미끄러져 오고, 도착한 자리에 파란 테두리가 세 번 깜빡임
  if (moveFx && !reviewing() && moveFx.i === st.moves.length - 1) {
    const p = parseMove(st.moves[moveFx.i]);
    moveFx = null;
    if (!isPass(p)) {
      const [fx, fy] = toXY(p.ff, p.fr), [tx, ty] = toXY(p.tf, p.tr);
      const idx = grid.findIndex((q) => q.f === p.tf && q.r === p.tr);
      if (idx >= 0) {
        el('polygon', { class: 'ai-pulse', points: octagon(tx, ty, SIZE[grid[idx].t] + 8) }, ml);
        const g = pl.children[idx];
        if (g && g.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
          g.animate([{ transform: `translate(${fx - tx}px, ${fy - ty}px)` }, { transform: 'translate(0, 0)' }], { duration: 340, easing: 'cubic-bezier(.2, .8, .2, 1)' });
        }
      }
    }
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

function material(b = board) {
  const sum = { cho: 0, han: 1.5 }; // 한 덤 1.5점
  for (const p of pieceGrid(b)) sum[p.side] += POINTS[p.t];
  return sum;
}

function renderPanel() {
  const ready = engineReady && board;
  const stm = board ? sideToMove() : 'cho';
  const myTurn = ready && !st.shared && !st.over && !st.thinking && stm === st.side;
  const browsing = reviewing() || st.shared; // 판을 보기만 하는 중
  const lv = LEVELS[st.level];

  // 플레이어 줄
  const me = st.side, ai = other(st.side);
  $('aiChip').className = `chip ${ai}`; $('aiChip').textContent = ai === 'cho' ? '楚' : '漢';
  $('meChip').className = `chip ${me}`; $('meChip').textContent = me === 'cho' ? '楚' : '漢';
  $('aiName').textContent = `AI · ${lv.name}`;
  $('meName').textContent = st.shared ? T('공유한 사람', 'Sharer') : T('나', 'You');
  $('sharedBar').hidden = !st.shared;
  $('meSetup').textContent = st.mySetup === '무작위' ? '' : `${T('상차림', 'Setup')} · ${suName(st.mySetup)}`;
  const aiTurn = $('aiTurn'), meTurn = $('meTurn');
  aiTurn.className = `turn ${ai}` + (st.thinking === 'engine' ? ' thinking' : '');
  meTurn.className = `turn ${me}` + (st.thinking === 'hint' ? ' thinking' : '');
  aiTurn.hidden = !(ready && !st.over && stm === ai && (!browsing || st.thinking === 'engine'));
  meTurn.hidden = !(ready && !st.over && stm === me && !browsing);
  $('aiTurnText').textContent = st.thinking === 'engine' ? (st.depth ? T(`생각 중 · 깊이 ${st.depth}`, `Thinking · depth ${st.depth}`) : T('생각 중', 'Thinking')) : T('차례', 'To move');
  $('meTurnText').textContent = st.thinking === 'hint' ? T('훈수 찾는 중', 'Finding a hint') : T('내 차례', 'Your turn');

  // 상태
  let status, sub = '';
  const readAhead = () => (st.depth ? T(`${st.depth}수 앞까지 읽음`, `Looked ${st.depth} moves ahead`) : T('준비 중', 'Getting ready'));
  if (!engineReady) { status = T('엔진을 불러오는 중…', 'Loading the engine…'); sub = T('처음 한 번만 엔진 파일(약 1MB)을 받습니다', 'The engine (about 1 MB) is downloaded only once'); }
  else if (st.thinking === 'engine') { status = T('상대가 수를 읽는 중', 'The AI is thinking'); sub = readAhead(); }
  else if (st.thinking === 'analyze') { status = T('대국을 분석하는 중', 'Analyzing the game'); sub = T(`국면 ${anDone} / ${anTotal} · 중지해도 끝난 부분은 남습니다`, `Position ${anDone} / ${anTotal} · Stopping keeps what is done`); }
  else if (st.thinking === 'hint') { status = T('훈수를 찾는 중', 'Looking for a hint'); sub = readAhead(); }
  else if (reviewing()) {
    status = st.view === 0 ? T('복기 · 첫 배치', 'Review · start position') : T(`복기 · ${st.view}수째 ${st.notes[st.view - 1]}`, `Review · move ${st.view} ${st.notes[st.view - 1]}`);
    sub = st.over || st.shared ? T('◀ ▶ 버튼으로 한 수씩 넘겨 보세요', 'Use ◀ ▶ to step through the moves') : T('맨 끝(▶|)으로 가면 이어서 둘 수 있습니다', 'Go to the end (▶|) to keep playing');
    const v = st.view > 0 ? judge(st.view - 1) : null;
    if (v) sub = judgeText(st.view - 1, v);
  }
  else if (st.shared) {
    const res = st.over ? board.result(false) : '';
    const out = res === '1/2-1/2' ? T('무승부', 'Draw') : res === '1-0' ? T('초 승', 'Cho wins') : T('한 승', 'Han wins');
    status = `${T('공유받은 기보', 'Shared game')} · ${st.over ? out : T('진행 중', 'in progress')}`;
    sub = T(`전체 ${st.moves.length}수 · ◀ 버튼으로 처음부터 넘겨 보세요`, `${st.moves.length} moves · Use ◀ to step back from the start`);
  }
  else if (st.over) { status = st.over.title; sub = st.over.text; } // 분석·복기 중이 아닐 때만 결과 문구
  else { status = myTurn ? T('내 차례', 'Your turn') : T('상대 차례', "AI's turn"); sub = st.selected ? T('움직일 곳을 누르세요', 'Tap where to move') : T('내 기물을 눌러 움직일 곳을 고르세요', 'Tap one of your pieces to move it'); }
  if (browsing || st.thinking) { /* 복기·생각 중에는 위 문구를 그대로 */ }
  else if (ready && !st.over && board.isCheck()) sub = `<span class="alert">${T('장군!', 'Check!')}</span> ${stm === st.side ? T('궁을 지켜야 합니다', 'Protect your general') : ''}`;
  else if (ready && !st.over && board.isBikjang()) sub = T('<span class="alert">빅장</span> 궁끼리 마주 보고 있습니다', '<span class="alert">Bikjang</span> The generals face each other');
  $('statusText').textContent = status;
  $('subText').innerHTML = sub;
  $('mbStatus').textContent = status;
  $('mbSub').innerHTML = sub;
  // 상태 앞 점: 지금 둘 차례인 진영 색 (대국이 끝났거나 보기만 할 때는 회색)
  $('mbDot').className = 'mb-dot' + (ready && !st.over && !browsing ? ' ' + stm : '');

  // 그 국면의 분석 값이 있으면 그것을, 아니면 마지막으로 엔진이 읽은 값을 보여 줌
  const anEval = st.thinking !== 'hint' && st.thinking !== 'engine' ? st.an.evals[shownCount()] : null;
  const evCho = anEval != null ? Math.max(-5000, Math.min(5000, anEval)) : st.evalCho;
  const pct = 50 + 50 * Math.tanh(evCho / 700);
  $('evalFill').style.width = pct.toFixed(1) + '%';
  const et = $('evalText');
  et.textContent = anEval != null ? fmtEval(anEval) : st.evalText;
  et.className = evCho > 0 ? 'cho' : evCho < 0 ? 'han' : '';
  $('mEvalFill').style.width = pct.toFixed(1) + '%';
  $('mEval').textContent = et.textContent; $('mEval').className = 'm-eval ' + et.className;
  if (board) { const m = material(shownBoard()); $('materialText').textContent = T(`기물 점수 초 ${m.cho} · 한 ${m.han}`, `Material Cho ${m.cho} · Han ${m.han}`); }

  // 버튼
  $('hintBtn').disabled = browsing ? !ready || !!st.thinking || shownBoard().isGameOver(false) : !myTurn;
  $('passBtn').disabled = !myTurn || reviewing() || !passMove();
  $('undoBtn').disabled = !engineReady || st.shared || st.thinking === 'hint' || !st.moves.some((_, i) => movedBy(i) === st.side);
  $('newBtn').disabled = !ff;
  $('shareBtn').disabled = !board || !st.moves.length;

  // 수순
  const list = $('moveList');
  list.classList.toggle('reviewing', reviewing());
  if (!st.notes.length) list.innerHTML = `<span class="empty">${T('아직 둔 수가 없습니다', 'No moves yet')}</span>`;
  else {
    let html = '';
    const curI = shownCount() - 1; // 지금 판에 보이는 마지막 수
    const cell = (j, side) => {
      if (j >= st.notes.length) return `<span class="m ${side}"></span>`;
      const cls = `m ${side}` + (j === curI ? ` last${side === 'c' ? ' c' : ''}` : '');
      const v = judge(j), mk = v && MARKS[v.kind];
      return `<span class="${cls}" data-i="${j}">${st.notes[j]}${mk ? ` <i class="q ${v.kind}" title="${mk.name}">${mk.sym}</i>` : ''}</span>`;
    };
    for (let i = 0; i < st.notes.length; i += 2) html += `<span class="n">${i / 2 + 1}</span>${cell(i, 'c')}${cell(i + 1, 'h')}`;
    list.innerHTML = html;
    const cur = list.querySelector('.last');
    if (!reviewing() || !cur) list.scrollTop = list.scrollHeight;
    else if (cur.offsetTop < list.scrollTop || cur.offsetTop + cur.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = cur.offsetTop - list.clientHeight / 2;
  }

  // 복기 이동
  const n = shownCount(), total = st.moves.length;
  $('navFirst').disabled = $('navPrev').disabled = !board || n === 0;
  $('navNext').disabled = $('navLast').disabled = !reviewing();
  $('navPos').textContent = `${n} / ${total}`;
  $('navPos').classList.toggle('on', reviewing());

  renderAnalysis();
  renderMobileBar(browsing);

  // 결과 창
  const res = $('result');
  if (st.over && !resultDismissed) {
    res.hidden = false;
    $('resultTitle').textContent = st.over.title;
    $('resultText').textContent = st.over.text;
  } else res.hidden = true;
}

// ---------- 착수 소리 ----------
// 소리 파일 없이 Web Audio로 나무판에 장기알 놓는 '탁' 소리를 만듦
const SOUND_KEY = 'hansu-janggi:sound';
let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) !== '0'; } catch (e) { return true; } })();
let actx = null;
function audio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC();
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
// 휴대폰은 화면을 한 번 눌러야 소리를 낼 수 있어서 첫 터치 때 미리 깨워 둠
document.addEventListener('pointerdown', () => { if (soundOn) audio(); }, { once: true, capture: true });
function knock({ capture = false, check = false } = {}) {
  if (!soundOn) return;
  const ac = audio();
  if (!ac) return;
  try {
    const t = ac.currentTime + 0.01, vol = capture ? 1 : 0.7;
    // 딱: 짧은 잡음을 대역 필터로 걸러 나무 부딪히는 소리
    const len = Math.floor(0.05 * ac.sampleRate);
    const buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 5);
    const src = ac.createBufferSource(); src.buffer = buf;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = capture ? 1500 : 1900; bp.Q.value = 1.1;
    const g1 = ac.createGain(); g1.gain.value = 0.9 * vol;
    src.connect(bp).connect(g1).connect(ac.destination); src.start(t);
    // 탁: 낮게 울리는 몸통 소리
    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(capture ? 300 : 380, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.09);
    const g2 = ac.createGain(); g2.gain.setValueAtTime(0.55 * vol, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    o.connect(g2).connect(ac.destination); o.start(t); o.stop(t + 0.15);
    if (check) { // 장군: 맑은 두 음
      [880, 1175].forEach((f, k) => {
        const c = ac.createOscillator(); c.type = 'triangle'; c.frequency.value = f;
        const g = ac.createGain(), s0 = t + 0.12 + k * 0.13;
        g.gain.setValueAtTime(0.0001, s0); g.gain.exponentialRampToValueAtTime(0.28, s0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, s0 + 0.22);
        c.connect(g).connect(ac.destination); c.start(s0); c.stop(s0 + 0.24);
      });
    }
  } catch (e) { /* 소리는 없어도 대국은 계속 */ }
}
function setSound(on) {
  soundOn = on;
  try { localStorage.setItem(SOUND_KEY, on ? '1' : '0'); } catch (e) { /* 저장 못 해도 이번에는 적용 */ }
  paintSound();
  if (on) knock(); // 켜면 어떤 소리인지 한 번 들려 줌
}
// 소리 버튼은 메뉴 안과 설정 카드에 하나씩 있음
const soundBtns = [...document.querySelectorAll('[data-toggle="sound"]')];
const paintSound = () => soundBtns.forEach((b) => b.setAttribute('aria-pressed', String(soundOn)));
paintSound();
soundBtns.forEach((b) => { b.onclick = () => setSound(!soundOn); });

// AI가 방금 둔 수: 다음 render() 한 번에만 미끄러지는 움직임과 깜빡임을 보여 줌
let moveFx = null;

// ---------- 대국 진행 ----------
function checkOver() {
  if (!board.isGameOver(false)) { st.over = null; return false; }
  const res = board.result(false);
  const reason = board.isBikjang() ? T('빅장으로 점수 판정', 'Bikjang, decided on points') : board.isCheck() ? T('외통수', 'Checkmate') : T('규칙에 따른 판정', 'Decided by the rules');
  if (res === '1/2-1/2') st.over = { title: T('무승부', 'Draw'), text: reason };
  else {
    const winner = res === '1-0' ? 'cho' : 'han';
    st.over = winner === st.side
      ? { title: T('이겼습니다!', 'You won!'), text: T(`${reason}로 AI(${LEVELS[st.level].name})를 꺾었습니다.`, `${reason}. You beat the AI (${LEVELS[st.level].name}).`) }
      : { title: T('졌습니다', 'You lost'), text: T(`${reason}. 무르기로 돌아가 다시 둬 보세요.`, `${reason}. Undo and try again.`) };
  }
  return true;
}
function play(m, by = 'me') {
  clearView(); // 새 수가 두어지면 복기를 끝내고 최신 판으로 돌아옴
  const capture = board.isCapture(m);
  st.notes.push(noteFor(m));
  board.push(m);
  st.moves.push(m);
  knock({ capture, check: board.isCheck() });
  moveFx = by === 'ai' ? { i: st.moves.length - 1 } : null;
  st.selected = null; st.hint = null; resultDismissed = false;
  checkOver();
  render();
  save();
  if (!st.over && sideToMove() !== st.side) askEngine('engine');
}
function askEngine(kind) {
  const lv = LEVELS[st.level];
  const full = kind === 'hint';
  // 훈수는 화면에 보이는 국면(복기 중이면 그 수)에서 찾음
  const moves = full ? st.moves.slice(0, shownCount()) : st.moves;
  const rootBoard = full ? shownBoard() : board;
  st.thinking = kind; st.depth = '';
  const id = ++reqId;
  pending = { id, kind, rootSide: rootBoard.turn() ? 'cho' : 'han', at: moves.length };
  worker.postMessage({ type: 'go', id, commands: [
    'setoption name UCI_Variant value janggi',
    `setoption name Skill Level value ${full ? 20 : lv.skill}`,
    `position fen ${st.startFen}${moves.length ? ' moves ' + moves.join(' ') : ''}`,
    `go movetime ${full ? 1500 : lv.ms}`,
  ] });
  render();
}
function applyInfo(line, rootSide) {
  const d = /\bdepth (\d+)/.exec(line); if (d) st.depth = d[1];
  const cp = /score cp (-?\d+)/.exec(line), mate = /score mate (-?\d+)/.exec(line);
  const sign = rootSide === 'cho' ? 1 : -1;
  if (cp) { st.evalCho = sign * +cp[1]; st.evalText = fmtEval(st.evalCho); }
  else if (mate) { const n = +mate[1] * sign; st.evalCho = n > 0 ? 5000 : -5000; st.evalText = mateText(n > 0 ? 'cho' : 'han', Math.abs(+mate[1])); }
}
function onWorker(ev) {
  const msg = ev.data;
  if (msg.type === 'ready') {
    engineReady = true; render();
    if (!st.shared && !st.over && sideToMove() !== st.side) askEngine('engine');
    return;
  }
  if (!pending || msg.id !== pending.id) return;
  if (msg.type === 'info') { if (pending.kind !== 'analyze') { applyInfo(msg.line, pending.rootSide); renderPanel(); } return; }
  if (msg.type === 'error') { st.thinking = null; pending = null; render(); $('subText').textContent = T('엔진 오류: ', 'Engine error: ') + msg.message; return; }
  if (msg.type === 'bestmove') {
    const { kind, rootSide, at } = pending; pending = null;
    if (kind === 'analyze') { onAnalyzed(msg, rootSide, at); return; }
    st.thinking = null;
    if (msg.info) applyInfo(msg.info, rootSide);
    if (!msg.move || msg.move === '(none)') { checkOver(); render(); return; }
    if (kind === 'engine') play(msg.move, 'ai');
    else { st.hint = at === shownCount() ? msg.move : null; render(); }
  }
}
function startWorker() {
  if (worker) worker.terminate();
  engineReady = false; pending = null; st.thinking = null;
  worker = new Worker(new URL('engine-worker.js', ENGINE_DIR));
  worker.onmessage = onWorker;
  worker.onerror = (e) => { $('statusText').textContent = T('엔진을 시작하지 못했습니다', "Couldn't start the engine"); $('subText').textContent = e.message || T('새로고침해 보세요', 'Try reloading the page'); };
  worker.postMessage({ type: 'init', url: new URL('janggi-engine.wasm', ENGINE_DIR).href });
}
// 엔진이 읽는 중에 판을 바꿔야 하면 워커를 새로 띄움 (단일 스레드라 중간에 멈출 수 없음)
function interruptEngine() { if (st.thinking || pending) startWorker(); }

// ---------- 대국 분석 ----------
// 형세 점수 → 초가 이길 가능성(0~1). 체스 분석 사이트에서 흔히 쓰는 로지스틱 곡선
const winCho = (cp) => 1 / (1 + Math.exp(-0.00368208 * Math.max(-3000, Math.min(3000, cp))));
const parseScore = (line, side) => { // 엔진 info 줄 → 초 기준 점수
  const sign = side === 'cho' ? 1 : -1;
  const cp = /score cp (-?\d+)/.exec(line), mate = /score mate (-?\d+)/.exec(line);
  if (cp) return sign * +cp[1];
  if (mate) { const n = +mate[1]; return sign * (n >= 0 ? 1 : -1) * (MATE - Math.abs(n)); }
  return null;
};
const sideName = (s) => (s === 'cho' ? T('초', 'Cho') : T('한', 'Han'));
const mateText = (s, n) => T(`${sideName(s)} ${n}수 외통`, `${sideName(s)} mates in ${n}`);
function fmtEval(cp) {
  const s = cp > 0 ? 'cho' : 'han';
  if (Math.abs(cp) === MATE) return T(`${sideName(s)} 승`, `${sideName(s)} wins`); // 이미 끝난 국면
  if (Math.abs(cp) > MATE / 2) return mateText(s, MATE - Math.abs(cp));
  const v = cp / 100;
  return (v ? `${sideName(s)} +` : '') + Math.abs(v).toFixed(1);
}
const MARKS = { inaccuracy: { sym: '?!', name: T('부정확', 'Inaccuracy') }, mistake: { sym: '?', name: T('실수', 'Mistake') }, blunder: { sym: '??', name: T('패착', 'Blunder') } };
// j번째 수(국면 j → j+1)의 평가. 두 국면이 모두 분석돼야 함
function judge(j) {
  const a = st.an.evals[j], b = st.an.evals[j + 1];
  if (a == null || b == null) return null;
  const mover = movedBy(j);
  const before = mover === 'cho' ? winCho(a) : 1 - winCho(a);
  const after = mover === 'cho' ? winCho(b) : 1 - winCho(b);
  const drop = Math.max(0, before - after) * 100;
  const kind = drop >= 30 ? 'blunder' : drop >= 20 ? 'mistake' : drop >= 10 ? 'inaccuracy' : st.moves[j] === st.an.best[j] ? 'best' : 'good';
  // 수마다 정확도: 이길 가능성을 얼마나 잃었는지로 0~100
  const acc = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
  return { mover, drop, kind, acc };
}
const analyzedAll = () => st.moves.length > 0 && st.an.evals.length === st.moves.length + 1 && !st.an.evals.includes(undefined) && !st.an.evals.includes(null);
function startAnalysis() {
  if (!engineReady || st.thinking || !st.moves.length) return;
  st.selected = null; st.hint = null;
  st.thinking = 'analyze';
  anTotal = 0;
  for (let i = 0; i <= st.moves.length; i++) if (st.an.evals[i] == null) anTotal++;
  anDone = 0;
  analyzeNext();
}
let anTotal = 0, anDone = 0;
function analyzeNext() {
  if (st.thinking !== 'analyze') return;
  let i = 0;
  while (i <= st.moves.length && st.an.evals[i] != null) i++;
  if (i > st.moves.length) { // 끝
    st.thinking = null; save(); render();
    if (!st.shared && !st.over && sideToMove() !== st.side) askEngine('engine');
    return;
  }
  const b = new ff.Board('janggi', st.startFen);
  for (const m of st.moves.slice(0, i)) b.push(m);
  try {
    if (b.isGameOver(false)) { // 끝난 국면은 엔진 대신 결과로
      const res = b.result(false);
      st.an.evals[i] = res === '1-0' ? MATE : res === '0-1' ? -MATE : 0;
      st.an.best[i] = null;
      anDone++; renderPanel();
      setTimeout(analyzeNext, 0);
      return;
    }
    const id = ++reqId;
    pending = { id, kind: 'analyze', rootSide: b.turn() ? 'cho' : 'han', at: i };
  } finally { b.delete(); }
  worker.postMessage({ type: 'go', id: reqId, commands: [
    'setoption name UCI_Variant value janggi',
    'setoption name Skill Level value 20',
    `position fen ${st.startFen}${i ? ' moves ' + st.moves.slice(0, i).join(' ') : ''}`,
    `go movetime ${AN_MS}`,
  ] });
}
function onAnalyzed(msg, rootSide, at) {
  const score = msg.info ? parseScore(msg.info, rootSide) : null;
  st.an.evals[at] = score ?? 0;
  st.an.best[at] = msg.move && msg.move !== '(none)' ? msg.move : null;
  anDone++;
  render();
  analyzeNext();
}
function stopAnalysis() {
  if (st.thinking !== 'analyze') return;
  interruptEngine(); // 워커를 새로 띄우면 진행 중인 분석이 멈춤 (이미 끝난 국면 분석은 남음)
  save(); render();
}
$('analyzeBtn').onclick = startAnalysis;
$('anStop').onclick = stopAnalysis;

// 형세 그래프. 그릴 때마다 실제 폭에 맞춰 viewBox를 잡아 원·선이 찌그러지지 않게 함
const CH = { H: 96, pad: 6 };
let chartHover = null;
function chartGeom() {
  const W = $('anChart').clientWidth || 300, N = Math.max(1, st.moves.length);
  return {
    W, N,
    x: (i) => CH.pad + (i / N) * (W - 2 * CH.pad),
    y: (cp) => CH.pad + (1 - winCho(cp)) * (CH.H - 2 * CH.pad),
  };
}
function renderChart() {
  const c = $('anChart');
  const evals = st.an.evals;
  const pts = [];
  for (let i = 0; i <= st.moves.length && evals[i] != null; i++) pts.push(i); // 앞에서부터 이어진 부분만
  $('anChartWrap').hidden = pts.length < 2;
  if (pts.length < 2) return;
  const g = chartGeom();
  c.setAttribute('viewBox', `0 0 ${g.W} ${CH.H}`);
  c.innerHTML = '';
  const mid = g.y(0), last = pts[pts.length - 1];
  const line = pts.map((i, k) => `${k ? 'L' : 'M'}${g.x(i).toFixed(1)},${g.y(evals[i]).toFixed(1)}`).join(' ');
  const area = `${line} L${g.x(last).toFixed(1)},${mid.toFixed(1)} L${g.x(0).toFixed(1)},${mid.toFixed(1)} Z`;
  const defs = el('defs', {}, c);
  const ct = el('clipPath', { id: 'anClipTop' }, defs); el('rect', { x: 0, y: 0, width: g.W, height: mid }, ct);
  const cb = el('clipPath', { id: 'anClipBot' }, defs); el('rect', { x: 0, y: mid, width: g.W, height: CH.H - mid }, cb);
  el('path', { class: 'fill-cho', d: area, 'clip-path': 'url(#anClipTop)' }, c);
  el('path', { class: 'fill-han', d: area, 'clip-path': 'url(#anClipBot)' }, c);
  el('line', { class: 'mid', x1: 0, x2: g.W, y1: mid, y2: mid }, c);
  const n = shownCount();
  if (reviewing() || st.shared) el('line', { class: 'cur', x1: g.x(n), x2: g.x(n), y1: 0, y2: CH.H }, c);
  if (chartHover !== null) el('line', { class: 'hover', x1: g.x(chartHover), x2: g.x(chartHover), y1: 0, y2: CH.H }, c);
  el('path', { class: 'line', d: line }, c);
  // 실수·패착은 둔 쪽 색 점으로
  for (let j = 0; j < last; j++) {
    const v = judge(j);
    if (v && (v.kind === 'mistake' || v.kind === 'blunder')) el('circle', { class: `dot ${v.mover}`, cx: g.x(j + 1), cy: g.y(evals[j + 1]), r: v.kind === 'blunder' ? 5 : 4 }, c);
  }
}
function chartIndexAt(ev) {
  const r = $('anChart').getBoundingClientRect(), g = chartGeom();
  const i = Math.round(((ev.clientX - r.left) - CH.pad) / (g.W - 2 * CH.pad) * g.N);
  let maxI = 0;
  while (maxI + 1 <= st.moves.length && st.an.evals[maxI + 1] != null) maxI++;
  return Math.max(0, Math.min(maxI, i));
}
function showTip(i) {
  chartHover = i;
  renderChart();
  const g = chartGeom(), cp = st.an.evals[i];
  const tip = $('anTip');
  tip.hidden = false;
  tip.style.left = Math.max(60, Math.min(g.W - 60, g.x(i))) + 'px';
  const wc = Math.round(winCho(cp) * 100);
  $('anTipVal').textContent = Math.abs(cp) > MATE / 2 ? fmtEval(cp) : wc >= 50 ? `${sideName('cho')} ${wc}%` : `${sideName('han')} ${100 - wc}%`;
  const v = i > 0 ? judge(i - 1) : null;
  $('anTipLab').textContent = i === 0 ? T('첫 배치', 'Start position') : T(`${i}수 ${st.notes[i - 1]}`, `Move ${i} ${st.notes[i - 1]}`) + (v && MARKS[v.kind] ? ` · ${MARKS[v.kind].name}` : '');
}
function hideTip() { chartHover = null; $('anTip').hidden = true; renderChart(); }
$('anChart').addEventListener('pointermove', (ev) => showTip(chartIndexAt(ev)));
$('anChart').addEventListener('pointerleave', hideTip);
$('anChart').addEventListener('click', (ev) => setView(chartIndexAt(ev)));
if (window.ResizeObserver) new ResizeObserver(() => { if (!$('anChartWrap').hidden) renderChart(); }).observe($('analysisCard'));

function renderAnalysis() {
  const has = st.an.evals.some((v) => v != null);
  const running = st.thinking === 'analyze';
  // 대국 중에는 숨기고, 끝났거나 복기·공유 보기·분석 결과가 있을 때만 보여 줌
  $('analysisCard').hidden = !(st.over || reviewing() || st.shared || has || running);
  const all = analyzedAll();
  const btn = $('analyzeBtn');
  btn.hidden = running;
  btn.disabled = !engineReady || !!st.thinking || all || !st.moves.length;
  btn.textContent = all ? T('분석 완료', 'Analyzed') : has ? T('이어서 분석', 'Continue') : T('분석하기', 'Analyze');
  $('anEmpty').hidden = has || running;
  $('anProgress').hidden = !running;
  if (running) {
    $('anFill').style.width = (anTotal ? (100 * anDone / anTotal) : 0).toFixed(1) + '%';
    $('anCount').textContent = `${anDone} / ${anTotal}`;
  }
  // 요약 표
  const sum = { cho: { acc: [], inaccuracy: 0, mistake: 0, blunder: 0 }, han: { acc: [], inaccuracy: 0, mistake: 0, blunder: 0 } };
  let any = false;
  for (let j = 0; j < st.moves.length; j++) {
    const v = judge(j);
    if (!v) continue;
    any = true;
    sum[v.mover].acc.push(v.acc);
    if (v.kind in sum[v.mover]) sum[v.mover][v.kind]++;
  }
  $('anSum').hidden = !any;
  if (!$('analysisCard').hidden) renderChart();
  for (const [side, k] of [['cho', 'C'], ['han', 'H']]) {
    const x = sum[side];
    $('anAcc' + k).textContent = x.acc.length ? Math.round(x.acc.reduce((a, b) => a + b, 0) / x.acc.length) + '%' : '–';
    $('anIna' + k).textContent = x.inaccuracy; $('anMis' + k).textContent = x.mistake; $('anBlu' + k).textContent = x.blunder;
  }
}

// 상태 줄에 쓸 한 수 평가 문구. 더 나은 수가 있었으면 그 수를 알려 줌
function judgeText(j, v) {
  const head = { best: T('최선의 수', 'Best move'), good: T('무난한 수', 'Good move') }[v.kind] || `<span class="q ${v.kind}">${MARKS[v.kind].sym}</span> ${MARKS[v.kind].name}`;
  const alt = st.an.best[j];
  if (!alt || alt === st.moves[j] || v.kind === 'best' || v.kind === 'good') return head;
  const b = new ff.Board('janggi', st.startFen);
  try { for (const m of st.moves.slice(0, j)) b.push(m); return `${head} · ${T('최선은', 'best was')} ${noteFor(alt, b)}`; }
  finally { b.delete(); }
}

// ---------- 휴대폰: 판 아래 조작 ----------
// 대국 중·대국 끝: 상태 줄 + 버튼 4개 / 복기: 설명 카드 + 형세 막대 + 이동 버튼
const mBrowsing = () => mrv || reviewing() || st.shared;
function renderMobileBar() {
  $('hdrNew').disabled = !ff;
  if (!isMobile()) return;
  const rv = mBrowsing();
  $('mbar').dataset.mode = rv ? 'review' : st.over ? 'over' : 'play';
  document.querySelector('.board-col').dataset.m = rv ? 'review' : 'play';
  if (rv) { renderRv(); return; }
  const res = st.over && board ? board.result(false) : null;
  const draw = res === '1/2-1/2', win = !!res && !draw && (res === '1-0') === (st.side === 'cho');
  $('mbStatusBox').classList.toggle('win', !!st.over && win);
  $('mbStatusBox').classList.toggle('lose', !!st.over && !win && !draw);
  $('mbHint').disabled = $('hintBtn').disabled;
  $('mbUndo').disabled = $('undoBtn').disabled;
  $('mbPass').hidden = $('passBtn').disabled;
  $('mbReview').disabled = !board || !st.moves.length || !!st.thinking;
  $('mbShare').disabled = $('shareBtn').disabled;
  $('mbNew').disabled = !ff;
}
function enterReview() {
  if (!board || !st.moves.length || st.thinking) return;
  mrv = true; st.selected = null; st.hint = null;
  render();
  if (st.over && !analyzedAll()) startAnalysis(); // 끝난 대국은 바로 실수 찾기
}
function exitReview() {
  if (st.thinking === 'analyze') stopAnalysis();
  mrv = false;
  if (st.view !== null) setView(null); else render();
}
$('mbHint').onclick = () => $('hintBtn').click();
$('mbUndo').onclick = () => $('undoBtn').click();
$('mbPass').onclick = () => $('passBtn').click();
$('mbReview').onclick = enterReview;
// 휴대폰 공유 창(카톡 등)만 씀. 공유 창을 못 여는 브라우저(http 주소, 일부 앱 안 브라우저)에서는 링크만 복사
$('mbShare').onclick = async () => {
  const url = shareUrl();
  if (!url) return;
  if (navigator.share) {
    try { await navigator.share({ title: T('한수 장기 기보', 'Hansu Janggi game'), url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast(T('링크를 복사했습니다. 카톡에 붙여 넣어 보내세요', 'Link copied. Paste it into a message to share')); }
  catch (e) { toast(T('이 브라우저에서는 공유할 수 없습니다', "This browser can't share")); }
};
$('mbNew').onclick = $('hdrNew').onclick = () => openNewDialog();

// 복기 화면
const LABEL = { best: T('최선의 수', 'Best move'), good: T('좋은 수', 'Good move'), inaccuracy: T('아쉬운 수', 'Inaccuracy'), mistake: T('실수', 'Mistake'), blunder: T('큰 실수', 'Blunder') };
const plainMove = (note) => {
  if (EN) { const r = /^([A-Z])(\d+)[-x](\d+)$/.exec(note); return r ? `${EN_NAME[r[1]]} ${r[2]}→${r[3]}` : note; }
  const r = /^(\d+)(\D+?)(\d+)$/.exec(note); return r ? `${r[2]} ${r[1]}→${r[3]}` : note;
};
function noteAt(j, m) { // j수째 앞 국면에서 m을 두었을 때의 기보 표기
  const b = new ff.Board('janggi', st.startFen);
  try { for (const x of st.moves.slice(0, j)) b.push(x); return noteFor(m, b); } finally { b.delete(); }
}
function nextMiss(n) { // 지금 보는 수 다음의 실수·큰 실수 (수 번호 j, 없으면 -1)
  for (let j = n; j < st.moves.length; j++) { const v = judge(j); if (v && (v.kind === 'mistake' || v.kind === 'blunder')) return j; }
  return -1;
}
function rvCardHtml(n) {
  if (st.thinking === 'analyze') {
    const pct = anTotal ? 100 * anDone / anTotal : 0;
    return `<div class="rv-h"><b>${T('실수 찾는 중', 'Finding mistakes')}</b><span class="rv-mv">${anDone} / ${anTotal}</span></div>`
      + `<div class="rv-prog"><span style="width:${pct.toFixed(1)}%"></span></div>`
      + `<p class="rv-note">${T('그만해도 읽은 데까지는 남습니다.', 'If you stop, the moves checked so far are kept.')}</p>`;
  }
  if (n === 0) return `<div class="rv-h"><b>${T('첫 배치', 'Start position')}</b></div><p class="rv-note wrap">${T('‘다음 ▶’을 누르거나 아래 막대를 밀어서 한 수씩 넘겨 보세요.', 'Tap “Next ▶” or drag the bar below to step through the moves.')}</p>`;
  const j = n - 1, side = movedBy(j), v = judge(j);
  const who = st.shared ? T(side === 'cho' ? '초가 둔 수' : '한이 둔 수', `by ${sideName(side)}`) : side === st.side ? T('내가 둔 수', 'by you') : T('AI가 둔 수', 'by the AI');
  let html = `<div class="rv-h"><span class="chip ${side}">${side === 'cho' ? '楚' : '漢'}</span><b>${T(`${n}수째`, `Move ${n}`)}</b><span>${who}</span><span class="rv-mv">${plainMove(st.notes[j])}</span></div>`;
  if (!v) return html + `<p class="rv-note wrap">${T('‘실수 찾기’를 누르면 이 수가 좋은 수였는지 AI가 알려 줍니다.', 'Tap “Find mistakes” and the AI will tell you whether this was a good move.')}</p>`;
  const pct = (cp) => Math.round((side === 'cho' ? winCho(cp) : 1 - winCho(cp)) * 100);
  const whose = st.shared ? sideName(side) : side === st.side ? T('내', 'Your') : 'AI';
  html += `<div class="rv-j"><span class="rv-badge ${v.kind}">${LABEL[v.kind]}</span><span>${whose} ${T('승률', 'win chance')} ${pct(st.an.evals[j])}% → ${pct(st.an.evals[j + 1])}%</span></div>`;
  const alt = st.an.best[j];
  if (BAD.includes(v.kind) && alt && alt !== st.moves[j]) html += `<p class="rv-alt">${T('더 좋은 수', 'Better')} <b>${plainMove(noteAt(j, alt))}</b> <i></i> ${T('판의 파란 화살표', 'blue arrow on the board')}</p>`;
  else html += `<p class="rv-note">${v.kind === 'best' ? T('AI가 고른 수와 같습니다.', 'The same move the AI picked.') : T('흐름을 잃지 않은 수입니다.', 'This move kept the position steady.')}</p>`;
  return html;
}
function renderRv() {
  const n = shownCount(), N = st.moves.length;
  $('rvTitle').textContent = st.shared ? T('공유받은 기보', 'Shared game') : T('복기', 'Review');
  $('rvPos').textContent = n === 0 ? T(`첫 배치 · 전체 ${N}수`, `Start · ${N} moves`) : T(`${n} / ${N}수`, `${n} / ${N}`);
  $('rvExit').textContent = st.shared ? T('내 대국으로', 'My game') : T('끝내기', 'Done');
  $('rvPrev').disabled = n === 0;
  $('rvNext').disabled = n >= N;
  const more = $('rvMore');
  if (st.thinking === 'analyze') { more.dataset.act = 'stop'; more.textContent = T('그만', 'Stop'); more.disabled = false; }
  else if (analyzedAll()) { more.dataset.act = 'next'; more.textContent = T('다음 실수 ▶', 'Next miss ▶'); more.disabled = nextMiss(n) < 0; }
  else { more.dataset.act = 'analyze'; more.textContent = T('실수 찾기', 'Find mistakes'); more.disabled = !engineReady || !!st.thinking || !N; }
  more.classList.toggle('hint', more.dataset.act !== 'stop');
  $('rvCard').innerHTML = rvCardHtml(n);
  renderRvChart();
}
$('rvPrev').onclick = () => setView(shownCount() - 1);
$('rvNext').onclick = () => setView(shownCount() + 1);
$('rvMore').onclick = () => {
  const act = $('rvMore').dataset.act;
  if (act === 'stop') stopAnalysis();
  else if (act === 'analyze') startAnalysis();
  else { const j = nextMiss(shownCount()); if (j >= 0) setView(j + 1); }
};
$('rvExit').onclick = () => (st.shared ? $('sharedExit').click() : exitReview());

// 형세 막대: 분석 전에는 진행 막대, 분석 뒤에는 형세 그래프. 누르거나 밀어서 수를 옮김
const RV = { pad: 10 };
function rvGeom() { // 실제 크기에 맞춰 그려 원·선이 찌그러지지 않게
  const c = $('rvChart'), W = c.clientWidth || 300, H = c.clientHeight || 56, N = Math.max(1, st.moves.length);
  return { W, H, N, x: (i) => RV.pad + (i / N) * (W - 2 * RV.pad), y: (cp) => 7 + (1 - winCho(cp)) * (H - 14) };
}
function renderRvChart() {
  const c = $('rvChart'), g = rvGeom(), ev = st.an.evals, n = shownCount(), N = st.moves.length;
  c.setAttribute('viewBox', `0 0 ${g.W} ${g.H}`);
  c.setAttribute('aria-valuemax', N); c.setAttribute('aria-valuenow', n);
  c.setAttribute('aria-valuetext', n === 0 ? T('첫 배치', 'Start position') : T(`${n}수째`, `Move ${n}`));
  c.innerHTML = '';
  const mid = g.y(0);
  const pts = [];
  for (let i = 0; i <= N && ev[i] != null; i++) pts.push(i);
  if (pts.length >= 2) {
    const last = pts[pts.length - 1];
    const line = pts.map((i, k) => `${k ? 'L' : 'M'}${g.x(i).toFixed(1)},${g.y(ev[i]).toFixed(1)}`).join(' ');
    const area = `${line} L${g.x(last).toFixed(1)},${mid.toFixed(1)} L${g.x(0).toFixed(1)},${mid.toFixed(1)} Z`;
    const defs = el('defs', {}, c);
    el('rect', { x: 0, y: 0, width: g.W, height: mid }, el('clipPath', { id: 'rvClipTop' }, defs));
    el('rect', { x: 0, y: mid, width: g.W, height: g.H - mid }, el('clipPath', { id: 'rvClipBot' }, defs));
    el('path', { class: 'fill-cho', d: area, 'clip-path': 'url(#rvClipTop)' }, c);
    el('path', { class: 'fill-han', d: area, 'clip-path': 'url(#rvClipBot)' }, c);
    el('line', { class: 'mid', x1: 0, x2: g.W, y1: mid, y2: mid }, c);
    el('path', { class: 'line', d: line }, c);
    for (let j = 0; j < last; j++) {
      const v = judge(j);
      if (v && (v.kind === 'mistake' || v.kind === 'blunder')) el('circle', { class: `miss ${v.kind}`, cx: g.x(j + 1), cy: g.y(ev[j + 1]), r: v.kind === 'blunder' ? 5 : 4 }, c);
    }
  } else {
    el('line', { class: 'base', x1: g.x(0), x2: g.x(N), y1: mid, y2: mid }, c);
    el('line', { class: 'done', x1: g.x(0), x2: g.x(n), y1: mid, y2: mid }, c);
  }
  el('line', { class: 'cur', x1: g.x(n), x2: g.x(n), y1: 0, y2: g.H }, c);
  el('circle', { class: 'knob', cx: g.x(n), cy: ev[n] != null && pts.length >= 2 ? g.y(ev[n]) : mid, r: 8 }, c);
}
let rvDrag = false;
function rvIndexAt(ev) {
  const r = $('rvChart').getBoundingClientRect(), g = rvGeom();
  return Math.max(0, Math.min(st.moves.length, Math.round(((ev.clientX - r.left) - RV.pad) / (g.W - 2 * RV.pad) * g.N)));
}
$('rvChart').addEventListener('pointerdown', (ev) => { rvDrag = true; $('rvChart').setPointerCapture(ev.pointerId); setView(rvIndexAt(ev)); });
$('rvChart').addEventListener('pointermove', (ev) => { if (rvDrag) setView(rvIndexAt(ev)); });
for (const t of ['pointerup', 'pointercancel']) $('rvChart').addEventListener(t, () => { rvDrag = false; });
if (window.ResizeObserver) new ResizeObserver(() => { if (isMobile() && mBrowsing()) renderRvChart(); }).observe($('rvChart'));
mq.addEventListener('change', () => { if (!isMobile()) mrv = false; if (board) render(); });

// ---------- 새 대국 시트 (휴대폰) ----------
// 고른 값은 '대국 시작'을 눌러야 적용되고, 닫으면 그대로
const LEVEL_DESC = EN
  ? ['For new players. It makes mistakes fairly often.', 'For players who know the rules.', 'For players with some experience.', 'Plays at full strength. Very hard to beat.']
  : ['처음 배우는 분께 맞습니다. 실수도 곧잘 합니다.', '규칙을 아는 분께 맞습니다.', '장기 좀 두는 분께 맞습니다.', '있는 힘껏 둡니다. 이기기 아주 어렵습니다.'];
const ng = { level: 2, side: 'cho', my: SETUPS[0], eng: SETUPS[0] };
let ngReturnFocus = null;
// 판 위 기물과 같은 모양의 작은 장기알 (팔각형·상아색 면·진영 색 테두리와 글자)
const HANJA_SU = { 마: '馬', 상: '象' };
const miniPiece = (x, y, r, ch) => `<polygon class="octa" points="${octagon(x, y, r)}"/><polygon class="inner" points="${octagon(x, y, r * .82)}"/><text x="${x}" y="${y + r * .08}">${ch}</text>`;
const pieceSvg = (ch, side) => `<svg class="mp ${side}" viewBox="-25 -25 50 50" aria-hidden="true">${miniPiece(0, 0, 23, ch)}</svg>`;
// 상차림 한 가지: 맨 끝줄 선 위에 마·상 넷을 왼쪽부터
const rankSvg = (v, side) => `<svg class="mp su-rank ${side}" viewBox="0 0 100 20" aria-hidden="true"><line class="rank" x1="0" x2="100" y1="10" y2="10"/>${[...v].map((c, i) => miniPiece(12.5 + i * 25, 10, 9.2, HANJA_SU[c])).join('')}</svg>`;
// 이름은 카드 대신 줄 머리(나 · 마상상마)에 보여 장기알을 크게
const suButtons = (list) => list.map((v) => `<button type="button" data-su="${v}" aria-label="${suName(v)}"><span class="su-wood"></span></button>`).join('');
$('ngMySu').innerHTML = suButtons(SETUPS);
$('ngEngSu').innerHTML = suButtons(SETUPS);
document.querySelectorAll('.ng-token').forEach((t) => { t.innerHTML = pieceSvg(t.textContent, t.classList.contains('han') ? 'han' : 'cho'); });
function paintNewDialog() {
  document.querySelectorAll('#ngLevel button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.level === ng.level)));
  document.querySelectorAll('#ngSide button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.side === ng.side)));
  // 내 줄은 내 진영 색, AI 줄은 상대 진영 색
  const rows = [['ngMySu', 'ngMyPc', 'ngMyName', ng.side, ng.my], ['ngEngSu', 'ngEngPc', 'ngEngName', other(ng.side), ng.eng]];
  for (const [id, pc, nm, side, val] of rows) {
    $(nm).textContent = suName(val);
    $(nm).className = side;
    const row = $(id);
    row.dataset.side = side;
    row.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.su === val));
      b.querySelector('.su-wood').innerHTML = rankSvg(b.dataset.su, side);
    });
    $(pc).innerHTML = pieceSvg(side === 'cho' ? '楚' : '漢', side);
  }
  $('ngLevelDesc').textContent = LEVEL_DESC[ng.level];
}
function openNewDialog() {
  ng.level = st.level; ng.side = chosenSide; ng.my = $('mySetup').value; ng.eng = $('engSetup').value;
  if (!SETUPS.includes(ng.eng)) ng.eng = SETUPS[0]; // 휴대폰 시트에는 무작위가 없음 (컴퓨터 설정 카드에만)
  $('ngWarn').hidden = !(st.moves.length && !st.over && !st.shared); // 두던 대국이 있을 때만 경고
  paintNewDialog();
  ngReturnFocus = document.activeElement;
  $('newDialog').hidden = false;
  document.body.classList.add('modal-open');
  $('ngStart').focus();
}
function closeNewDialog() {
  $('newDialog').hidden = true;
  document.body.classList.remove('modal-open');
  if (ngReturnFocus && ngReturnFocus.focus) ngReturnFocus.focus();
}
const newDialogOpen = () => !$('newDialog').hidden;
document.querySelectorAll('#ngLevel button').forEach((b) => { b.onclick = () => { ng.level = +b.dataset.level; paintNewDialog(); }; });
document.querySelectorAll('#ngSide button').forEach((b) => { b.onclick = () => { ng.side = b.dataset.side; paintNewDialog(); }; });
$('ngMySu').onclick = (ev) => { const b = ev.target.closest('[data-su]'); if (b) { ng.my = b.dataset.su; paintNewDialog(); } };
$('ngEngSu').onclick = (ev) => { const b = ev.target.closest('[data-su]'); if (b) { ng.eng = b.dataset.su; paintNewDialog(); } };
$('ngCancel').onclick = $('ngDim').onclick = closeNewDialog;
$('ngStart').onclick = () => {
  setLevel(ng.level); setSide(ng.side);
  $('mySetup').value = ng.my; $('engSetup').value = ng.eng;
  closeNewDialog();
  newGame();
  window.scrollTo(0, 0);
};
$('newDialog').addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closeNewDialog(); } });

// ---------- 짧은 알림 ----------
let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = true; void t.offsetWidth; t.hidden = false; // 연달아 눌러도 다시 나타나게
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

// ---------- 입력 ----------
svg.addEventListener('click', (ev) => {
  if (!engineReady || st.shared || reviewing() || mrv || st.over || st.thinking || sideToMove() !== st.side) return;
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
$('navFirst').onclick = () => setView(0);
$('navPrev').onclick = () => setView(shownCount() - 1);
$('navNext').onclick = () => setView(shownCount() + 1);
$('navLast').onclick = () => setView(null);
$('moveList').addEventListener('click', (ev) => {
  const m = ev.target.closest('[data-i]');
  if (m) setView(+m.dataset.i + 1);
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
// 결과 창에서 바로 첫 배치부터 복기하며, 아직 분석 안 했으면 분석도 시작
$('resultReview').onclick = () => { resultDismissed = true; setView(0); renderPanel(); if (!analyzedAll()) startAnalysis(); };

// 방향키로 복기: ← → 한 수, Home/End 처음·최신 (입력칸에 있을 때는 제외)
document.addEventListener('keydown', (ev) => {
  if (!board || newDialogOpen() || ev.altKey || ev.ctrlKey || ev.metaKey || /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;
  const n = shownCount();
  const to = { ArrowLeft: n - 1, ArrowRight: n + 1, Home: 0, End: null }[ev.key];
  if (to === undefined) return;
  ev.preventDefault();
  setView(to);
});

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

const fillSetup = (id, withRandom) => { $(id).innerHTML = [...SETUPS, ...(withRandom ? ['무작위'] : [])].map((v) => `<option value="${v}">${suName(v)}</option>`).join(''); };
fillSetup('mySetup', false); fillSetup('engSetup', true);

function newGame() {
  leaveShared();
  mrv = false;
  st.side = chosenSide;
  st.mySetup = $('mySetup').value;
  st.engSetup = $('engSetup').value;
  st.startFen = buildStartFen();
  st.moves = []; st.selected = null; st.hint = null; st.over = null; resultDismissed = false;
  st.evalCho = 0; st.evalText = '0.0'; st.depth = '';
  st.an = { evals: [], best: [] };
  interruptEngine();
  rebuild(); drawStatic(); render(); save();
  if (engineReady && sideToMove() !== st.side) askEngine('engine');
}

// ---------- 기보 공유 링크 ----------
// #g=1.<초 상차림><한 상차림><진영 c|h><실력>.<수순>
// 수순은 한 수를 3글자로: (출발칸×90 + 도착칸)을 base64url 18비트로. 칸 = 줄(a~i)×10 + (단-1)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const FILES = 'abcdefghi';
function encodeGame() {
  const su = setupsFromFen(st.startFen);
  if (!su) return null;
  let ms = '';
  for (const m of st.moves) {
    const p = parseMove(m);
    const v = (p.ff * 10 + p.fr - 1) * 90 + (p.tf * 10 + p.tr - 1);
    ms += B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
  }
  return `1.${SETUPS.indexOf(su.cho)}${SETUPS.indexOf(su.han)}${st.side === 'cho' ? 'c' : 'h'}${st.level}.${ms}`;
}
function shareUrl() {
  const g = encodeGame();
  return g && `${location.origin}/#g=${g}`;
}
// 잘못된 링크면 null. 수순은 합법인 데까지만 받아들임
function decodeGame(hash) {
  const r = /^#g=1\.([0-3])([0-3])([ch])([0-3])\.([A-Za-z0-9_-]*)$/.exec(hash);
  if (!r) return null;
  const startFen = fenFor(SETUPS[+r[1]], SETUPS[+r[2]]);
  const b = new ff.Board('janggi', startFen);
  const moves = [];
  try {
    for (let i = 0; i + 3 <= r[5].length; i += 3) {
      const v = (B64.indexOf(r[5][i]) << 12) | (B64.indexOf(r[5][i + 1]) << 6) | B64.indexOf(r[5][i + 2]);
      const from = Math.floor(v / 90), to = v % 90;
      if (from >= 90) break;
      const m = `${FILES[Math.floor(from / 10)]}${from % 10 + 1}${FILES[Math.floor(to / 10)]}${to % 10 + 1}`;
      if (!b.legalMoves().split(' ').includes(m)) break;
      b.push(m); moves.push(m);
    }
  } finally { b.delete(); }
  if (r[5] && !moves.length) return null; // 수순이 있는데 한 수도 못 읽으면 깨진 링크
  return { side: r[3] === 'c' ? 'cho' : 'han', level: +r[4], startFen, moves };
}
function openShared(g) {
  st.shared = true;
  mrv = false;
  Object.assign(st, { side: g.side, startFen: g.startFen, moves: g.moves, selected: null, hint: null, an: { evals: [], best: [] } });
  const su = setupsFromFen(g.startFen);
  st.mySetup = g.side === 'cho' ? su.cho : su.han; st.engSetup = g.side === 'cho' ? su.han : su.cho;
  setSide(g.side); setLevel(g.level);
  rebuild(); checkOver(); resultDismissed = true; drawStatic(); render();
}
function leaveShared() {
  if (!st.shared) return;
  st.shared = false;
  history.replaceState(null, '', location.pathname + location.search);
}
$('sharedExit').onclick = () => {
  leaveShared();
  interruptEngine();
  if (!restoreSaved()) newGame();
  else if (engineReady && !st.over && sideToMove() !== st.side) askEngine('engine');
};
// 컴퓨터 화면의 '기보 공유': 터치 기기는 공유 창, 아니면 클립보드 복사. 둘 다 안 되면 onFail로 주소를 직접 보여 줌
async function shareGame(onCopied, onFail) {
  const url = shareUrl();
  if (!url) return;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: T('한수 장기 기보', 'Hansu Janggi game'), url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); onCopied(); }
  catch (e) { onFail(url); }
}
let shareTimer = 0;
$('shareBtn').onclick = () => shareGame(() => {
  const btn = $('shareBtn');
  btn.textContent = T('링크 복사됨', 'Link copied'); btn.classList.add('done');
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => { btn.textContent = T('기보 공유', 'Share game'); btn.classList.remove('done'); }, 2000);
}, (url) => {
  $('subText').innerHTML = '';
  const a = document.createElement('a'); a.href = url; a.textContent = url; a.className = 'share-url';
  $('subText').append(T('이 주소를 복사해 보내세요: ', 'Copy and send this link: '), a);
});
window.addEventListener('hashchange', () => { if (/^#g=/.test(location.hash)) location.reload(); });

// ---------- 이어하기 (브라우저 저장소) ----------
function save() {
  if (st.shared) return; // 공유받은 기보로 내 대국을 덮어쓰지 않음
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      side: st.side, level: st.level, mySetup: st.mySetup, engSetup: st.engSetup, startFen: st.startFen, moves: st.moves,
      an: st.an,
    }));
  } catch (e) { /* 사생활 보호 모드 등 */ }
}
function load() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { return null; }
}

function restoreSaved() {
  const data = load();
  if (!data || !data.startFen) return false;
  mrv = false;
  try {
    // st를 먼저 채워야 setLevel()이 저장할 때 다른 판으로 덮어쓰지 않음
    const an = data.an && Array.isArray(data.an.evals) && Array.isArray(data.an.best) ? data.an : { evals: [], best: [] };
    Object.assign(st, { side: data.side, mySetup: data.mySetup, engSetup: data.engSetup, startFen: data.startFen, moves: data.moves || [], an });
    setSide(data.side); setLevel(data.level ?? 2);
    $('mySetup').value = data.mySetup; $('engSetup').value = data.engSetup;
    rebuild(); checkOver(); resultDismissed = !!st.over; drawStatic(); render();
    return true;
  } catch (e) { st.moves = []; return false; }
}

async function start() {
  ff = await FFishModule({ locateFile: (f) => new URL(f, ENGINE_DIR).href });
  const shared = location.hash ? decodeGame(location.hash) : null;
  if (shared) openShared(shared);
  else if (!restoreSaved()) { setLevel(2); newGame(); }
  startWorker();
}
start().catch((e) => {
  $('statusText').textContent = T('불러오지 못했습니다', "Couldn't load the game");
  $('subText').textContent = String((e && e.message) || e);
});
