"""Draws the Racing app icons (own artwork): rounded tile, road in perspective, chequered flag stripe."""
import sys
from PIL import Image, ImageDraw

def draw(size):
    S = size * 4
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = Image.new("RGBA", (S, S))
    px = grad.load()
    top, bot = (255, 122, 48), (214, 34, 70)
    for y in range(S):
        t = y / S
        c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,)
        for x in range(S):
            px[x, y] = c
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    # road
    d.polygon([(S * 0.44, S * 0.30), (S * 0.56, S * 0.30), (S * 0.92, S * 0.92), (S * 0.08, S * 0.92)], fill=(32, 34, 44, 255))
    for k in range(4):   # centre dashes
        y0 = 0.36 + k * 0.15
        y1 = y0 + 0.07
        w0 = 0.006 + y0 * 0.02
        w1 = 0.006 + y1 * 0.02
        d.polygon([(S * (0.5 - w0), S * y0), (S * (0.5 + w0), S * y0), (S * (0.5 + w1), S * y1), (S * (0.5 - w1), S * y1)], fill=(255, 255, 255, 255))
    # chequered band at the top
    n, h = 8, S * 0.09
    for i in range(n):
        for j in range(2):
            col = (255, 255, 255, 255) if (i + j) % 2 == 0 else (20, 20, 26, 255)
            x0 = S * 0.14 + i * S * 0.72 / n
            d.rectangle([x0, S * 0.12 + j * h / 2, x0 + S * 0.72 / n, S * 0.12 + (j + 1) * h / 2], fill=col)
    return img.resize((size, size), Image.LANCZOS)

out = sys.argv[1]
draw(80).save(out + "/icon.png")
draw(130).save(out + "/largeIcon.png")
print("ok")
