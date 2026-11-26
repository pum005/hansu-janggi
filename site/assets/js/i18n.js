/* 한수 장기 — 언어 고르기 (한국어 / English)
   <head>에서 바로(defer 없이) 읽어 화면이 그려지기 전에 언어를 정합니다.
   - 고른 언어가 저장돼 있으면 그것, 없으면 브라우저 첫 언어가 한국어면 한국어, 아니면 영어.
     (검색 로봇은 언제나 페이지 본래 언어로 둠: 한국어 검색 노출을 지키기 위해)
   - 글 페이지는 언어별 주소가 따로 있음 (<link rel="alternate" hreflang>): 다른 언어면 그 주소로 옮김.
   - 대국 화면(<html data-i18n>)은 한 주소에서 글자만 바꿈: data-en="영어 글자",
     data-en-html="영어 HTML", data-en-<속성>="영어 속성값"(예: data-en-aria-label, data-en-href).
   - 머리말 지구본(.lang-btn)을 누르면 한국어/English 목록(.lang-menu)이 열리고, 고르면 저장하고 바꿈. */
(() => {
  const KEY = 'hansu-janggi:lang';
  const html = document.documentElement;
  const page = html.lang === 'en' ? 'en' : 'ko'; // 이 페이지를 쓴 언어
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* 사생활 보호 모드 등 */ }
  const bot = /bot|crawl|spider|slurp|yeti|daum|headless|lighthouse/i.test(navigator.userAgent);
  const first = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  const lang = saved === 'ko' || saved === 'en' ? saved : bot ? page : /^ko\b/i.test(first) ? 'ko' : 'en';

  // 같은 사이트 안의 경로만 씀 (로컬 서버에서 열어도 그 서버 안에서 오가게)
  const altHref = (l) => { const a = document.querySelector(`link[rel="alternate"][hreflang="${l}"]`); return a && new URL(a.href).pathname; };

  function setLang(l) {
    try { localStorage.setItem(KEY, l); } catch (e) { /* 저장 못 해도 이번에는 바꿈 */ }
    const alt = altHref(l);
    if (alt && l !== page) location.href = alt + location.hash;
    else location.reload();
  }
  window.HJ = { lang, setLang };

  // 글 페이지: 다른 언어 주소로
  if (lang !== page) {
    const alt = altHref(lang);
    if (alt) { location.replace(alt + location.hash); return; }
  }

  // 대국 화면: 같은 주소에서 글자 바꾸기 (바꾸기 전 한국어가 잠깐 보이지 않게 숨겨 둠)
  if (lang === 'en' && page === 'ko' && html.hasAttribute('data-i18n')) {
    html.lang = 'en';
    html.classList.add('i18n-wait');
    const apply = () => {
      if (!html.classList.contains('i18n-wait')) return;
      for (const el of document.querySelectorAll('*')) {
        for (const at of [...el.attributes]) {
          if (!at.name.startsWith('data-en')) continue;
          if (at.name === 'data-en') setText(el, at.value);
          else if (at.name === 'data-en-html') el.innerHTML = at.value;
          else el.setAttribute(at.name.slice(8), at.value);
        }
      }
      html.classList.remove('i18n-wait');
    };
    // 글자 노드가 하나면 그것만 바꿔 아이콘(svg) 같은 자식 요소는 남김
    const setText = (el, text) => {
      const nodes = [...el.childNodes].filter((n) => n.nodeType === 3 && n.nodeValue.trim());
      if (nodes.length === 1 && el.children.length) {
        const n = nodes[0], v = n.nodeValue;
        n.nodeValue = v.slice(0, v.length - v.trimStart().length) + text + v.slice(v.trimEnd().length);
      } else el.textContent = text;
    };
    // 문서를 다 읽은 직후(defer·module 스크립트보다 먼저) 바꿈
    if (document.readyState !== 'loading') apply();
    else document.addEventListener('readystatechange', apply, { once: true });
    setTimeout(apply, 4000); // 혹시 모를 경우에도 화면이 계속 숨겨져 있지 않게
  }

  // 언어 목록 열고 닫기
  const menu = () => document.querySelector('.lang-menu');
  const btn = () => document.querySelector('.lang-btn');
  function openMenu(open) {
    const m = menu(), b = btn();
    if (!m || !b) return;
    m.hidden = !open;
    b.setAttribute('aria-expanded', String(open));
    if (open) {
      m.querySelectorAll('[data-lang]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.lang === lang)));
      const cur = m.querySelector(`[data-lang="${lang}"]`);
      if (cur) cur.focus();
    }
  }
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest ? ev.target : ev.target.parentElement;
    if (t.closest('.lang-btn')) { openMenu(menu().hidden); return; }
    const pick = t.closest('.lang-menu [data-lang]');
    if (pick) { openMenu(false); if (pick.dataset.lang !== lang) setLang(pick.dataset.lang); return; }
    if (menu() && !menu().hidden && !t.closest('.lang-menu')) openMenu(false);
  });
  document.addEventListener('keydown', (ev) => {
    const m = menu();
    if (!m || m.hidden) return;
    if (ev.key === 'Escape') { ev.stopPropagation(); openMenu(false); btn().focus(); }
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault(); ev.stopPropagation(); // 대국 화면의 방향키 복기와 겹치지 않게
      const items = [...m.querySelectorAll('[data-lang]')];
      const i = items.indexOf(document.activeElement);
      items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  }, true);
})();
