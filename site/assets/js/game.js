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
const SIZE = { k: 50, r: 44, c: 44, n: 44, b: 44, a: 36, p: 36 }; // 칸 간격 100 기준 반지름
const POINTS = { r: 13, c: 7, n: 5, b: 3, a: 3, p: 2, k: 0 };
const KO_NAME = { K: '궁', A: '사', R: '차', C: '포', H: '마', E: '상', P: '졸' };
const NS = 'http://www.w3.org/2000/svg';
const AN_MS = 300;       // 분석할 때 국면마다 엔진이 읽는 시간(ms)
const MATE = 100000;     // 외통 점수: ±(MATE - 남은 수)

const $ = (id) => document.getElementById(id);
const svg = $('board');

let ff = null, board = null, worker = null, engineReady = false;
let viewBoard = null; // 복기 중에 보여 줄 판 (진행 중인 판 board와 따로 둠)
let reqId = 0, pending = null, resultDismissed = false;
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
  if (isPass(parseMove(m))) return '한수 쉼';
  const s = b.sanMove(m, ff.Notation.JANGGI); // 예: H02-83, 잡는 수는 R71x81
  const r = /^([A-Z])(\d+)[-x](\d+)/.exec(s);
  if (!r) return s;
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
  const arrow = st.hint || ((reviewing() || st.shared) && st.thinking !== 'analyze' ? st.an.best[shownCount()] : null);
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
  $('meName').textContent = st.shared ? '공유한 사람' : '나';
  $('sharedBar').hidden = !st.shared;
  $('meSetup').textContent = st.mySetup === '무작위' ? '' : `상차림 · ${st.mySetup}`;
  const aiTurn = $('aiTurn'), meTurn = $('meTurn');
  aiTurn.className = `turn ${ai}` + (st.thinking === 'engine' ? ' thinking' : '');
  meTurn.className = `turn ${me}` + (st.thinking === 'hint' ? ' thinking' : '');
  aiTurn.hidden = !(ready && !st.over && stm === ai && (!browsing || st.thinking === 'engine'));
  meTurn.hidden = !(ready && !st.over && stm === me && !browsing);
  $('aiTurnText').textContent = st.thinking === 'engine' ? (st.depth ? `생각 중 · 깊이 ${st.depth}` : '생각 중') : '차례';
  $('meTurnText').textContent = st.thinking === 'hint' ? '훈수 찾는 중' : '내 차례';

  // 상태
  let status, sub = '';
  if (!engineReady) { status = '엔진을 불러오는 중…'; sub = '처음 한 번만 엔진 파일(약 1MB)을 받습니다'; }
  else if (st.thinking === 'engine') { status = '상대가 수를 읽는 중'; sub = st.depth ? `${st.depth}수 앞까지 읽음` : '준비 중'; }
  else if (st.thinking === 'analyze') { status = '대국을 분석하는 중'; sub = `국면 ${anDone} / ${anTotal} · 중지해도 끝난 부분은 남습니다`; }
  else if (st.thinking === 'hint') { status = '훈수를 찾는 중'; sub = st.depth ? `${st.depth}수 앞까지 읽음` : '준비 중'; }
  else if (reviewing()) {
    status = st.view === 0 ? '복기 · 첫 배치' : `복기 · ${st.view}수째 ${st.notes[st.view - 1]}`;
    sub = st.over || st.shared ? '◀ ▶ 버튼으로 한 수씩 넘겨 보세요' : '맨 끝(▶|)으로 가면 이어서 둘 수 있습니다';
    const v = st.view > 0 ? judge(st.view - 1) : null;
    if (v) sub = judgeText(st.view - 1, v);
  }
  else if (st.shared) {
    status = st.over ? `공유받은 기보 · ${st.over.title === '무승부' ? '무승부' : (board.result(false) === '1-0' ? '초' : '한') + ' 승'}` : '공유받은 기보 · 진행 중';
    sub = `전체 ${st.moves.length}수 · ◀ 버튼으로 처음부터 넘겨 보세요`;
  }
  else if (st.over) { status = st.over.title; sub = st.over.text; } // 분석·복기 중이 아닐 때만 결과 문구
  else { status = myTurn ? '내 차례' : '상대 차례'; sub = st.selected ? '움직일 곳을 누르세요' : '내 기물을 눌러 움직일 곳을 고르세요'; }
  if (browsing || st.thinking) { /* 복기·생각 중에는 위 문구를 그대로 */ }
  else if (ready && !st.over && board.isCheck()) sub = `<span class="alert">장군!</span> ${stm === st.side ? '궁을 지켜야 합니다' : ''}`;
  else if (ready && !st.over && board.isBikjang()) sub = '<span class="alert">빅장</span> 궁끼리 마주 보고 있습니다';
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
  if (board) { const m = material(shownBoard()); $('materialText').textContent = `기물 점수 초 ${m.cho} · 한 ${m.han}`; }

  // 버튼
  $('hintBtn').disabled = browsing ? !ready || !!st.thinking || shownBoard().isGameOver(false) : !myTurn;
  $('passBtn').disabled = !myTurn || reviewing() || !passMove();
  $('undoBtn').disabled = !engineReady || st.shared || st.thinking === 'hint' || !st.moves.some((_, i) => movedBy(i) === st.side);
  $('newBtn').disabled = !ff;
  $('shareBtn').disabled = !board || !st.moves.length;

  // 수순
  const list = $('moveList');
  list.classList.toggle('reviewing', reviewing());
  if (!st.notes.length) list.innerHTML = '<span class="empty">아직 둔 수가 없습니다</span>';
  else {
    let html = '';
    const curI = shownCount() - 1; // 지금 판에 보이는 마지막 수
    const cell = (j, side) => {
      if (j >= st.notes.length) return `<span class="m ${side}"></span>`;
      const cls = `m ${side}` + (j === curI ? ` last${side === 'c' ? ' c' : ''}` : '');
      const v = judge(j), mk = v && MARKS[v.kind];
      return `<span class="${cls}" data-i="${j}">${st.notes[j]}${mk ? ` <i class="q ${v.kind}" title="${mk.ko}">${mk.sym}</i>` : ''}</span>`;
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
  clearView(); // 새 수가 두어지면 복기를 끝내고 최신 판으로 돌아옴
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
  if (cp) { st.evalCho = sign * +cp[1]; const v = st.evalCho / 100; st.evalText = (v > 0 ? '초 +' : v < 0 ? '한 +' : '') + Math.abs(v).toFixed(1); }
  else if (mate) { const n = +mate[1] * sign; st.evalCho = n > 0 ? 5000 : -5000; st.evalText = `${n > 0 ? '초' : '한'} ${Math.abs(+mate[1])}수 외통`; }
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
  if (msg.type === 'error') { st.thinking = null; pending = null; render(); $('subText').textContent = '엔진 오류: ' + msg.message; return; }
  if (msg.type === 'bestmove') {
    const { kind, rootSide, at } = pending; pending = null;
    if (kind === 'analyze') { onAnalyzed(msg, rootSide, at); return; }
    st.thinking = null;
    if (msg.info) applyInfo(msg.info, rootSide);
    if (!msg.move || msg.move === '(none)') { checkOver(); render(); return; }
    if (kind === 'engine') play(msg.move);
    else { st.hint = at === shownCount() ? msg.move : null; render(); }
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
function fmtEval(cp) {
  if (Math.abs(cp) === MATE) return `${cp > 0 ? '초' : '한'} 승`; // 이미 끝난 국면
  if (Math.abs(cp) > MATE / 2) return `${cp > 0 ? '초' : '한'} ${MATE - Math.abs(cp)}수 외통`;
  const v = cp / 100;
  return (v > 0 ? '초 +' : v < 0 ? '한 +' : '') + Math.abs(v).toFixed(1);
}
const MARKS = { inaccuracy: { sym: '?!', ko: '부정확' }, mistake: { sym: '?', ko: '실수' }, blunder: { sym: '??', ko: '패착' } };
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
  $('anTipVal').textContent = Math.abs(cp) > MATE / 2 ? fmtEval(cp) : wc >= 50 ? `초 ${wc}%` : `한 ${100 - wc}%`;
  const v = i > 0 ? judge(i - 1) : null;
  $('anTipLab').textContent = i === 0 ? '첫 배치' : `${i}수 ${st.notes[i - 1]}` + (v && MARKS[v.kind] ? ` · ${MARKS[v.kind].ko}` : '');
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
  btn.textContent = all ? '분석 완료' : has ? '이어서 분석' : '분석하기';
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
  const head = { best: '최선의 수', good: '무난한 수' }[v.kind] || `<span class="q ${v.kind}">${MARKS[v.kind].sym}</span> ${MARKS[v.kind].ko}`;
  const alt = st.an.best[j];
  if (!alt || alt === st.moves[j] || v.kind === 'best' || v.kind === 'good') return head;
  const b = new ff.Board('janggi', st.startFen);
  try { for (const m of st.moves.slice(0, j)) b.push(m); return `${head} · 최선은 ${noteFor(alt, b)}`; }
  finally { b.delete(); }
}

// ---------- 휴대폰 하단 버튼 ----------
// 상황(대국 중 / 복기 중 / 대국 끝 / 분석 중)에 맞는 버튼 줄만 보여 줌
function renderMobileBar(browsing) {
  const bar = $('mbar');
  const mode = st.thinking === 'analyze' ? 'analyze' : browsing ? 'review' : st.over ? 'over' : 'play';
  bar.dataset.mode = mode;
  const n = shownCount();
  $('mbHint').disabled = $('hintBtn').disabled;
  $('mbUndo').disabled = $('undoBtn').disabled;
  $('mbPass').disabled = $('passBtn').disabled;
  $('mbNew').disabled = $('mbNew2').disabled = $('newBtn').disabled;
  $('mbBack').disabled = !board || !st.moves.length || !!st.thinking;
  $('mbPrev').disabled = n === 0;
  $('mbNext').disabled = !reviewing();
  $('mbHint2').disabled = $('hintBtn').disabled;
  const canAnalyze = !analyzedAll() && st.moves.length > 0;
  $('mbAnalyze').hidden = !canAnalyze;
  $('mbAnalyze').disabled = !engineReady || !!st.thinking;
  $('mbAnalyze').parentElement.classList.toggle('no-an', !canAnalyze);
  $('mbExit').textContent = st.shared ? '내 대국으로' : '복기 끝내기';
  $('mbReview').disabled = !st.moves.length;
  $('mbShare').disabled = $('shareBtn').disabled;
  if (mode === 'analyze') $('mbFill').style.width = (anTotal ? (100 * anDone / anTotal) : 0).toFixed(1) + '%';
}
$('mbHint').onclick = $('mbHint2').onclick = () => $('hintBtn').click();
$('mbUndo').onclick = () => $('undoBtn').click();
$('mbPass').onclick = () => $('passBtn').click();
$('mbBack').onclick = () => setView(shownCount() - 1);
$('mbPrev').onclick = () => setView(shownCount() - 1);
$('mbNext').onclick = () => setView(shownCount() + 1);
$('mbExit').onclick = () => (st.shared ? $('sharedExit').click() : setView(null));
$('mbAnalyze').onclick = startAnalysis;
$('mbStop').onclick = stopAnalysis;
$('mbReview').onclick = () => { setView(0); if (!analyzedAll()) startAnalysis(); };
$('mbShare').onclick = () => $('shareBtn').click();
$('mbNew').onclick = $('mbNew2').onclick = () => newGame();

// ---------- 입력 ----------
svg.addEventListener('click', (ev) => {
  if (!engineReady || st.shared || reviewing() || st.over || st.thinking || sideToMove() !== st.side) return;
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
  if (!board || ev.altKey || ev.ctrlKey || ev.metaKey || /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;
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

const fillSetup = (id, withRandom) => { $(id).innerHTML = SETUPS.map((v) => `<option>${v}</option>`).join('') + (withRandom ? '<option>무작위</option>' : ''); };
fillSetup('mySetup', false); fillSetup('engSetup', true);

function newGame() {
  leaveShared();
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
// 휴대폰은 공유 창, 컴퓨터는 클립보드 복사. 둘 다 안 되면 상태 줄에 주소를 보여 줌
let shareTimer = 0;
$('shareBtn').onclick = async () => {
  const url = shareUrl();
  if (!url) return;
  const btn = $('shareBtn');
  const done = (text) => {
    btn.textContent = text; btn.classList.add('done');
    $('mbShare').textContent = '링크를 복사했습니다 ✓';
    clearTimeout(shareTimer);
    shareTimer = setTimeout(() => { btn.textContent = '기보 공유'; btn.classList.remove('done'); $('mbShare').textContent = '기보 보내기 (카톡 등)'; }, 2000);
  };
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: '한수 장기 기보', url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); done('링크 복사됨'); }
  catch (e) {
    $('subText').innerHTML = '';
    const a = document.createElement('a'); a.href = url; a.textContent = url; a.className = 'share-url';
    $('subText').append('이 주소를 복사해 보내세요: ', a);
  }
};
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
  $('statusText').textContent = '불러오지 못했습니다';
  $('subText').textContent = String((e && e.message) || e);
});
