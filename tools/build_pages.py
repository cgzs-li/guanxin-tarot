"""The historical Pages URL redirects to the authenticated live site."""
from pathlib import Path
public = Path(__file__).resolve().parent.parent / 'public'
public.mkdir(exist_ok=True)
(public / 'index.html').write_text('''<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=https://tarot.ruichi0201.cn/">
<link rel="canonical" href="https://tarot.ruichi0201.cn/">
<title>观心 · 前往正式网站</title></head>
<body style="background:#121016;color:#f2e9da;font:18px/2 sans-serif;padding:10%">
<h1>观心的新入口</h1><p>正在前往正式网站。</p>
<p><a style="color:#d7ba83" href="https://tarot.ruichi0201.cn/">点击进入观心</a></p>
<p>每个账号一次免费本地解读，不含 AI。付费流程目前仅供演示，不实际扣款。</p>
</body></html>''', encoding='utf-8')
(public / '.nojekyll').touch()
