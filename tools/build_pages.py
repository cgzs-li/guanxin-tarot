"""Build the basic GitHub Pages preview; the live AI site runs on Render."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent.parent
public = root / "public"
public.mkdir(exist_ok=True)
source = (root / "index.html").read_text(encoding="utf-8")
assert "window.GUANXIN_STATIC_PREVIEW===true" in source
source = source.replace("</head>", "<script>window.GUANXIN_STATIC_PREVIEW=true;</script></head>", 1)
(public / "index.html").write_text(source, encoding="utf-8")
shutil.copytree(root / "assets", public / "assets", dirs_exist_ok=True)
for name in (".nojekyll", "牌图来源.json"):
    if (root / name).exists():
        shutil.copy2(root / name, public / name)
