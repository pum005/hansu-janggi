#!/usr/bin/env python3
"""글 페이지 생성기: tools/pages/*.html 본문을 공통 머리말·꼬리말로 감싸 site/<경로>/index.html로 씁니다.
본문 파일 첫 줄들은 메타데이터입니다:
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

TEMPLATE = """<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title} — 한수 장기</title>
<meta name="description" content="{desc}">
<meta name="theme-color" content="#f5f4f0">
<link rel="canonical" href="{domain}{path}">
<meta property="og:url" content="{domain}{path}">
<meta property="og:type" content="article">
<meta property="og:title" content="{title} — 한수 장기">
<meta property="og:description" content="{desc}">
<meta property="og:site_name" content="한수 장기">
<meta property="og:locale" content="ko_KR">
<meta property="og:image" content="{domain}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="google-adsense-account" content="ca-pub-6082998240145089">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6082998240145089" crossorigin="anonymous"></script>
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
  <a class="logo" href="/"><span class="logo-mark">將</span>한수 장기</a>
  <button class="menu-btn" aria-expanded="false" aria-controls="mainNav"><span></span><span></span><span></span><b class="menu-tx">메뉴</b></button>
  <nav class="nav" id="mainNav" aria-label="주 메뉴">
{nav}
  </nav>
</header>

<main class="article">
{body}
</main>

<footer class="site-footer">
  <span>© 2026 한수 장기 · <a href="/engine/">Fairy-Stockfish 엔진</a> 사용 (GPL-3.0)</span>
  <nav><a href="/privacy/">개인정보처리방침</a><a href="/source/">소스 공개</a></nav>
</footer>
</body>
</html>
"""

def meta(src, key):
    m = re.search(rf"<!--\s*{key}:\s*(.*?)\s*-->", src)
    return m.group(1) if m else ""

def main():
    urls = ["/"]
    for f in sorted((ROOT / "tools" / "pages").glob("*.html")):
        src = f.read_text(encoding="utf-8")
        path, title, desc = meta(src, "path"), meta(src, "title"), meta(src, "desc")
        body = re.sub(r"^\s*(<!--.*?-->\s*)+", "", src, flags=re.S).rstrip()
        cur = ' aria-current="page"'
        nav = "\n".join(f'    <a href="{href}"{cur if href == path else ""}>{label}</a>' for href, label in NAV)
        html = TEMPLATE.format(title=title, desc=desc, path=path, domain=DOMAIN, nav=nav, body=body)
        out = SITE / path.strip("/") / "index.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(html, encoding="utf-8")
        urls.append(path)
        print("wrote", out.relative_to(ROOT))
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
