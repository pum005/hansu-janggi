// 목업용 장기판 렌더러 (SVG)
function drawBoard(el, s) {
  const m = s * 0.62, W = 8 * s + 2 * m, H = 9 * s + 2 * m;
  const X = f => m + f * s, Y = r => m + r * s;
  let g = '';
  // 판 배경
  g += `<defs>
    <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ecd9b0"/><stop offset="1" stop-color="#e2c993"/>
    </linearGradient>
    <filter id="sh" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="${s*0.04}" stdDeviation="${s*0.05}" flood-color="#5a4220" flood-opacity=".28"/>
    </filter>
    <marker id="ah" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#2f6fde"/>
    </marker>
  </defs>`;
  g += `<rect width="${W}" height="${H}" rx="${s*0.22}" fill="url(#wood)"/>`;
  const ln = `stroke="#6b5230" stroke-opacity=".75" stroke-width="${Math.max(1, s*0.022)}"`;
  for (let r = 0; r < 10; r++) g += `<line x1="${X(0)}" y1="${Y(r)}" x2="${X(8)}" y2="${Y(r)}" ${ln}/>`;
  for (let f = 0; f < 9; f++) g += `<line x1="${X(f)}" y1="${Y(0)}" x2="${X(f)}" y2="${Y(9)}" ${ln}/>`;
  // 궁성 대각선
  [[0, 2], [7, 9]].forEach(([a, b]) => {
    g += `<line x1="${X(3)}" y1="${Y(a)}" x2="${X(5)}" y2="${Y(b)}" ${ln}/>`;
    g += `<line x1="${X(5)}" y1="${Y(a)}" x2="${X(3)}" y2="${Y(b)}" ${ln}/>`;
  });
  g += `<rect x="${X(0)}" y="${Y(0)}" width="${8*s}" height="${9*s}" fill="none" stroke="#6b5230" stroke-width="${s*0.04}"/>`;

  // 국면: [file, rank, 글자, 진영(c=초, h=한), 크기(k/b/s)]
  const P = [
    [0,0,'車','h','b'],[1,0,'馬','h','b'],[2,0,'象','h','b'],[3,0,'士','h','s'],[5,0,'士','h','s'],[6,0,'象','h','b'],[7,0,'馬','h','b'],[8,0,'車','h','b'],
    [4,1,'漢','h','k'],[1,2,'包','h','b'],[7,2,'包','h','b'],
    [0,3,'兵','h','s'],[2,3,'兵','h','s'],[4,3,'兵','h','s'],[5,3,'兵','h','s'],[8,3,'兵','h','s'],
    [0,6,'卒','c','s'],[3,6,'卒','c','s'],[4,6,'卒','c','s'],[6,6,'卒','c','s'],[8,6,'卒','c','s'],
    [1,7,'包','c','b'],[7,7,'包','c','b'],[6,7,'馬','c','b'],[4,8,'楚','c','k'],
    [0,9,'車','c','b'],[1,9,'象','c','b'],[2,9,'馬','c','b'],[3,9,'士','c','s'],[5,9,'士','c','s'],[6,9,'象','c','b'],[8,9,'車','c','b'],
  ];
  // 직전 수 표시 (한 兵 6,3 → 5,3)
  const mark = (f, r) => { const d = s*0.5, c = s*0.14, x = X(f), y = Y(r), w = Math.max(2, s*0.045);
    let p = '';
    [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx, sy]) => {
      p += `<path d="M${x+sx*d},${y+sy*(d-c)} L${x+sx*d},${y+sy*d} L${x+sx*(d-c)},${y+sy*d}" fill="none" stroke="#d14b3c" stroke-width="${w}" stroke-linecap="round"/>`;
    });
    return p; };
  g += `<circle cx="${X(6)}" cy="${Y(3)}" r="${s*0.1}" fill="#d14b3c" fill-opacity=".45"/>`;
  g += mark(5, 3);

  const oct = (cx, cy, R) => { let pts = []; for (let i = 0; i < 8; i++) { const a = Math.PI/8 + i*Math.PI/4; pts.push((cx+R*Math.cos(a)).toFixed(1)+','+(cy+R*Math.sin(a)).toFixed(1)); } return pts.join(' '); };
  // 훈수 화살표 (초 包 7,7 → 4,7)
  g += `<line x1="${X(7)-s*0.45}" y1="${Y(7)}" x2="${X(4)+s*0.62}" y2="${Y(7)}" stroke="#2f6fde" stroke-opacity=".8" stroke-width="${s*0.13}" stroke-linecap="round" marker-end="url(#ah)"/>`;
  g += `<circle cx="${X(4)}" cy="${Y(7)}" r="${s*0.3}" fill="#2f6fde" fill-opacity=".12" stroke="#2f6fde" stroke-width="${s*0.035}" stroke-dasharray="${s*0.08} ${s*0.06}"/>`;
  P.forEach(([f, r, ch, side, sz]) => {
    const R = s * (sz === 'k' ? 0.47 : sz === 'b' ? 0.41 : 0.33);
    const col = side === 'c' ? '#17734f' : '#c0392b';
    const x = X(f), y = Y(r);
    g += `<g filter="url(#sh)"><polygon points="${oct(x, y, R)}" fill="#fbf7ee" stroke="${col}" stroke-width="${s*0.03}"/></g>`;
    g += `<polygon points="${oct(x, y, R*0.86)}" fill="none" stroke="${col}" stroke-opacity=".25" stroke-width="${s*0.015}"/>`;
    g += `<text x="${x}" y="${y}" dy=".36em" text-anchor="middle" font-family="Songti SC, AppleMyungjo, serif" font-weight="700" font-size="${R*1.08}" fill="${col}">${ch}</text>`;
  });
  g += `<line x1="${X(7)-s*0.45}" y1="${Y(7)}" x2="${X(4)+s*0.62}" y2="${Y(7)}" stroke="#2f6fde" stroke-opacity=".22" stroke-width="${s*0.13}" stroke-linecap="round"/>`;
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block">${g}</svg>`;
}
