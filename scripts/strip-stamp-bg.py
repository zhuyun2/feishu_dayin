"""
去除印章 PNG 的白底背景，仅保留红色印章部分。
公式: alpha = 255 - min(R, G, B)
  - 纯白(255,255,255) -> alpha=0 (透明)
  - 纯红(255,0,0)     -> alpha=255 (不透明)
  - 抗锯齿浅红        -> 部分透明，过渡自然
"""
import sys
from PIL import Image


def remove_white_bg(src: str, dst: str) -> None:
    img = Image.open(src).convert("RGBA")
    px = img.load()
    w, h = img.size
    transparent = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            new_a = max(0, 255 - min(r, g, b))
            if new_a != a:
                px[x, y] = (r, g, b, new_a)
            if new_a == 0:
                transparent += 1
    img.save(dst, "PNG", optimize=True)
    total = w * h
    print(f"{src} -> {dst}")
    print(f"  {w}x{h}, 透明像素 {transparent}/{total} ({transparent*100//total}%)")


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        remove_white_bg(arg, arg)