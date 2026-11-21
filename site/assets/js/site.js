/* 한수 장기 — 모든 페이지 공통 스크립트: 모바일 메뉴, 광고 자리 */

/* =====================================================================
   광고 설정 — 승인받은 뒤 여기만 고치면 됩니다.
   provider: 'none'    광고 없음 (심사 전 기본값)
             'adsense' Google AdSense
             'adfit'   카카오 애드핏
   ===================================================================== */
const ADS = {
  provider: 'none',

  adsense: {
    client: 'ca-pub-0000000000000000',     // AdSense 게시자 ID
    slots: { game: '', article: '' },       // 광고 단위 ID (반응형 디스플레이 광고)
  },

  adfit: {
    // 애드핏은 고정 크기라 화면 폭별로 광고 단위를 따로 만듭니다.
    game: {
      desktop: { unit: '', w: 300, h: 250 },  // 1024px 이상: 오른쪽 패널
      tablet:  { unit: '', w: 728, h: 90 },   // 640~1023px: 패널 아래
      mobile:  { unit: '', w: 320, h: 100 },  // 639px 이하: 수순 아래
    },
    article: {
      desktop: { unit: '', w: 300, h: 250 },
      tablet:  { unit: '', w: 300, h: 250 },
      mobile:  { unit: '', w: 300, h: 250 },
    },
  },
};

// 모바일 메뉴
(() => {
  const btn = document.querySelector('.menu-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const open = document.body.classList.toggle('menu-open');
    btn.setAttribute('aria-expanded', String(open));
  });
})();

// 광고
(() => {
  const slots = [...document.querySelectorAll('.ad-slot[data-ad]')];
  if (!slots.length) return;
  const host = location.hostname;
  const preview = host === 'localhost' || host === '127.0.0.1' || host === '' || /[?&]ads=preview/.test(location.search);
  const w = window.innerWidth;
  const bp = w >= 1024 ? 'desktop' : w >= 640 ? 'tablet' : 'mobile';

  const loadScript = (src, attrs = {}) => {
    if (document.querySelector(`script[src="${src}"]`)) return;
    const s = document.createElement('script');
    s.async = true; s.src = src;
    for (const k in attrs) s.setAttribute(k, attrs[k]);
    document.head.appendChild(s);
  };

  for (const slot of slots) {
    const kind = slot.dataset.ad;

    if (ADS.provider === 'adsense' && ADS.adsense.slots[kind]) {
      loadScript(`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADS.adsense.client}`, { crossorigin: 'anonymous' });
      const ins = document.createElement('ins');
      ins.className = 'adsbygoogle';
      ins.style.display = 'block';
      ins.style.width = '100%';
      ins.dataset.adClient = ADS.adsense.client;
      ins.dataset.adSlot = ADS.adsense.slots[kind];
      ins.dataset.adFormat = 'auto';
      ins.dataset.fullWidthResponsive = 'true';
      slot.appendChild(ins);
      slot.classList.add('on');
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      continue;
    }

    const af = ADS.adfit[kind] && ADS.adfit[kind][bp];
    if (ADS.provider === 'adfit' && af && af.unit) {
      const ins = document.createElement('ins');
      ins.className = 'kakao_ad_area';
      ins.style.display = 'none';
      ins.dataset.adUnit = af.unit;
      ins.dataset.adWidth = String(af.w);
      ins.dataset.adHeight = String(af.h);
      slot.appendChild(ins);
      slot.classList.add('on');
      slot.style.minHeight = af.h + 'px';
      loadScript('https://t1.daumcdn.net/kas/static/ba.min.js');
      continue;
    }

    if (preview) {
      const size = kind === 'game' ? { desktop: '300 × 250', tablet: '728 × 90', mobile: '320 × 100' }[bp] : '300 × 250';
      slot.classList.add('on', 'placeholder');
      slot.innerHTML = `<span>광고 영역</span><small>${size} · 로컬 미리보기에서만 보임</small>`;
    }
  }
})();
