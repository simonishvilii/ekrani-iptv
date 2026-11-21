"""Android launcher icons and the Android TV banner (320x180), from the same artwork as tools/make-icons.py.
   python tools/make-android-icons.py   -> android/app/src/main/res/mipmap-*/ic_launcher.png, drawable-xhdpi/banner.png"""
import os
import importlib.util
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")

# reuse draw() from make-icons.py without running its main part
src = open(os.path.join(ROOT, "tools", "make-icons.py"), encoding="utf-8").read().split("\nout = sys.argv")[0]
ns = {}
exec(compile(src, "make-icons.py", "exec"), ns)
draw = ns["draw"]

for name, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
    d = os.path.join(RES, "mipmap-" + name)
    os.makedirs(d, exist_ok=True)
    draw(size).save(os.path.join(d, "ic_launcher.png"))

# banner: dark tile, icon on the left, the name on the right (drawn at 4x, then scaled down)
W, H, K = 320, 180, 4
img = Image.new("RGBA", (W * K, H * K), (11, 15, 23, 255))
icon = draw(110 * K // 2).resize((110 * K, 110 * K), Image.LANCZOS)
img.paste(icon, (22 * K, 35 * K), icon)
d = ImageDraw.Draw(img)
font_path = "C:/Windows/Fonts/segoeuib.ttf"
big = ImageFont.truetype(font_path, 40 * K)
small = ImageFont.truetype(font_path.replace("segoeuib", "segoeui"), 24 * K)
d.text((146 * K, 52 * K), "Ekrani", font=big, fill=(255, 255, 255, 255))
d.text((148 * K, 100 * K), "IPTV", font=small, fill=(138, 151, 173, 255))
os.makedirs(os.path.join(RES, "drawable-xhdpi"), exist_ok=True)
img.resize((W, H), Image.LANCZOS).save(os.path.join(RES, "drawable-xhdpi", "banner.png"))
print("ok")
