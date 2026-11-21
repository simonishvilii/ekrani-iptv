"""Draws the app icons (own artwork): rounded tile, TV outline, play triangle."""
import sys
from PIL import Image, ImageDraw

def draw(size):
    S = size * 4  # supersample
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # diagonal gradient
    grad = Image.new("RGBA", (S, S))
    px = grad.load()
    a, b = (34, 110, 246), (124, 58, 237)
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    w = int(S * 0.055)
    # TV body
    l, t, r, btm = S * 0.18, S * 0.28, S * 0.82, S * 0.72
    d.rounded_rectangle([l, t, r, btm], radius=int(S * 0.07), outline=(255, 255, 255, 255), width=w)
    # antenna
    d.line([(S * 0.38, S * 0.14), (S * 0.5, S * 0.27)], fill=(255, 255, 255, 255), width=w)
    d.line([(S * 0.62, S * 0.14), (S * 0.5, S * 0.27)], fill=(255, 255, 255, 255), width=w)
    # stand
    d.line([(S * 0.36, S * 0.82), (S * 0.64, S * 0.82)], fill=(255, 255, 255, 255), width=w)
    # play triangle
    d.polygon([(S * 0.44, S * 0.39), (S * 0.44, S * 0.61), (S * 0.62, S * 0.5)], fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)

out = sys.argv[1]
draw(80).save(out + "/icon.png")
draw(130).save(out + "/largeIcon.png")
draw(512).save(out + "/icon-512.png")
print("ok")
