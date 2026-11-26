#!/usr/bin/env python3
"""글 페이지 생성기: tools/pages/*.html 본문을 공통 머리말·꼬리말로 감싸 site/<경로>/index.html로 씁니다.
영어판은 tools/pages/en/<같은 파일 이름>.html에 두면 site/en/<경로>/index.html로 쓰고,
두 페이지에 서로를 가리키는 hreflang 링크를 넣습니다 (언어 바꾸기 버튼과 i18n.js가 이 링크로 오갑니다).
본문 파일 첫 줄들은 메타데이터입니다 (영어판의 path는 /en/으로 시작):
  <!-- path: /rules/ -->
  <!-- title: 장기 규칙 -->
  <!-- desc: 설명 -->
사용: python3 tools/build_pages.py           글 페이지 생성 + 모든 HTML의 CSS·JS 주소에 버전 붙이기
      python3 tools/build_pages.py --check   버전이 파일 내용과 맞는지만 확인 (배포 전 점검, 틀리면 종료 코드 1)

CSS·JS는 하루 캐시되므로, 파일을 고치고 배포하면 예전 파일을 쓰는 사람이 생깁니다.
그래서 HTML 안의 /assets/css/*.css, /assets/js/*.js 주소에 내용 해시를 ?v=로 붙여
파일이 바뀌면 주소도 바뀌게 합니다. (엔진은 폴더 이름 v1로 버전을 관리하므로 제외)
"""
import hashlib, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
DOMAIN = "https://hansujanggi.com"  # canonical, sitemap에 쓰임

NAV = [("/", "대국"), ("/rules/", "장기 규칙"), ("/setups/", "상차림"), ("/strategy/", "초보 전략"), ("/engine/", "엔진 소개")]
NAV_EN = [("/", "Play"), ("/en/rules/", "Rules"), ("/en/setups/", "Setups"), ("/en/strategy/", "Strategy"), ("/en/engine/", "Engine")]

GLOBE = '<svg class="lang-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>'
CARET = '<svg class="lang-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>'
def lang_menu(cur):
    """머리말의 언어 고르기: 지구본 버튼 + 한국어/English 목록 (i18n.js가 열고 닫음)"""
    label, aria = ("English", "Language (언어)") if cur == "en" else ("한국어", "언어 (Language)")
    items = "\n".join(f'      <button type="button" role="menuitemradio" data-lang="{l}" lang="{l}" aria-checked="{str(l == cur).lower()}">{name}</button>'
                      for l, name in (("ko", "한국어"), ("en", "English")))
    return (f'<div class="lang">\n    <button class="lang-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="langMenu" aria-label="{aria}">'
            f'{GLOBE}<span class="lang-tx">{label}</span>{CARET}</button>\n'
            f'    <div class="lang-menu" id="langMenu" role="menu" hidden>\n{items}\n    </div>\n  </div>')
LANG_MENU = {"ko": lang_menu("ko"), "en": lang_menu("en")}

# 언어별 머리말·꼬리말 글자
L10N = {
    "ko": dict(site="한수 장기", locale="ko_KR", menu="메뉴", nav_label="주 메뉴",
               lang_menu=LANG_MENU["ko"],
               foot='© 2026 한수 장기 · <a href="/engine/">Fairy-Stockfish 엔진</a> 사용 (GPL-3.0)',
               foot_nav='<a href="/privacy/">개인정보처리방침</a><a href="/source/">소스 공개</a>'),
    "en": dict(site="Hansu Janggi", locale="en_US", menu="Menu", nav_label="Main menu",
               lang_menu=LANG_MENU["en"],
               foot='© 2026 Hansu Janggi · Uses the <a href="/en/engine/">Fairy-Stockfish engine</a> (GPL-3.0)',
               foot_nav='<a href="/en/privacy/">Privacy</a><a href="/en/source/">Source code</a>'),
}

TEMPLATE = """<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title} — {site}</title>
<meta name="description" content="{desc}">
<meta name="theme-color" content="#f5f4f0">
<link rel="canonical" href="{domain}{path}">
{alternates}
<meta property="og:url" content="{domain}{path}">
<meta property="og:type" content="article">
<meta property="og:title" content="{title} — {site}">
<meta property="og:description" content="{desc}">
<meta property="og:site_name" content="{site}">
<meta property="og:locale" content="{locale}">
<meta property="og:image" content="{domain}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="google-adsense-account" content="ca-pub-6082998240145089">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6082998240145089" crossorigin="anonymous"></script>
<script src="/assets/js/i18n.js"></script>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@900&display=swap">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<link rel="stylesheet" href="/assets/css/site.css">
<link rel="stylesheet" href="/assets/css/article.css">
<script src="/assets/js/site.js" defer></script>
</head>
<body>
<header class="site-header">
  <a class="logo" href="/"><span class="logo-mark">將</span>{site}</a>
  {lang_menu}
  <button class="menu-btn" aria-expanded="false" aria-controls="mainNav"><span></span><span></span><span></span><b class="menu-tx">{menu}</b></button>
  <nav class="nav" id="mainNav" aria-label="{nav_label}">
{nav}
  </nav>
</header>

<main class="article">
{body}
</main>

<footer class="site-footer">
  <span>{foot}</span>
  <nav>{foot_nav}</nav>
</footer>
</body>
</html>
"""

def meta(src, key):
    m = re.search(rf"<!--\s*{key}:\s*(.*?)\s*-->", src)
    return m.group(1) if m else ""

def read_page(f):
    src = f.read_text(encoding="utf-8")
    body = re.sub(r"^\s*(<!--.*?-->\s*)+", "", src, flags=re.S).rstrip()
    return dict(path=meta(src, "path"), title=meta(src, "title"), desc=meta(src, "desc"), body=body)

def write_page(lang, pg, paths):
    """paths: {"ko": 한국어 경로, "en": 영어 경로(없으면 None)}"""
    cur = ' aria-current="page"'
    nav = "\n".join(f'    <a href="{href}"{cur if href == pg["path"] else ""}>{label}</a>'
                    for href, label in (NAV_EN if lang == "en" else NAV))
    alternates = ""
    if paths.get("en"):
        alternates = "\n".join([f'<link rel="alternate" hreflang="ko" href="{DOMAIN}{paths["ko"]}">',
                                f'<link rel="alternate" hreflang="en" href="{DOMAIN}{paths["en"]}">',
                                f'<link rel="alternate" hreflang="x-default" href="{DOMAIN}{paths["ko"]}">'])
    html = TEMPLATE.format(lang=lang, title=pg["title"], desc=pg["desc"], path=pg["path"], domain=DOMAIN, nav=nav,
                           body=pg["body"], alternates=alternates, **L10N[lang])
    html = html.replace("\n\n<meta", "\n<meta")  # 대체 링크가 없을 때 빈 줄 없애기
    out = SITE / pg["path"].strip("/") / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print("wrote", out.relative_to(ROOT))

def main():
    urls = ["/"]
    pages = ROOT / "tools" / "pages"
    for f in sorted(pages.glob("*.html")):
        ko = read_page(f)
        en_file = pages / "en" / f.name
        en = read_page(en_file) if en_file.exists() else None
        paths = {"ko": ko["path"], "en": en and en["path"]}
        write_page("ko", ko, paths)
        urls.append(ko["path"])
        if en:
            write_page("en", en, paths)
            urls.append(en["path"])
    sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    sm += [f"  <url><loc>{DOMAIN}{u}</loc></url>" for u in urls]
    sm.append("</urlset>")
    (SITE / "sitemap.xml").write_text("\n".join(sm) + "\n", encoding="utf-8")
    (SITE / "robots.txt").write_text(f"User-agent: *\nAllow: /\n\nSitemap: {DOMAIN}/sitemap.xml\n", encoding="utf-8")
    print("wrote site/sitemap.xml, site/robots.txt")

ASSET_RE = re.compile(r'(["\'])(/assets/(?:css|js)/[\w.-]+\.(?:css|js))(?:\?v=[0-9a-f]*)?\1')

def asset_version(url):
    data = (SITE / url.lstrip("/")).read_bytes()
    return hashlib.sha256(data).hexdigest()[:10]

def stamp(html):
    return ASSET_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={asset_version(m.group(2))}{m.group(1)}", html)

def stamp_all(check=False):
    stale = []
    for f in sorted(SITE.rglob("*.html")):
        src = f.read_text(encoding="utf-8")
        out = stamp(src)
        if out != src:
            stale.append(f.relative_to(ROOT))
            if not check:
                f.write_text(out, encoding="utf-8")
    return stale

if __name__ == "__main__":
    if "--check" in sys.argv:
        stale = stamp_all(check=True)
        for f in stale:
            print("버전이 맞지 않음:", f)
        if stale:
            print("python3 tools/build_pages.py 를 실행한 뒤 커밋하세요.")
            sys.exit(1)
        print("모든 HTML의 CSS·JS 버전이 최신입니다.")
    else:
        main()
        for f in stamp_all():
            print("versioned", f)
