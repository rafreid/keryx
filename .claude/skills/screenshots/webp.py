#!/usr/bin/env python3
"""Write a .webp beside every .png in docs/img. The website serves the webp through <picture> and keeps the png as the fallback and the Open Graph image, so run this after replacing any screenshot."""
import os, sys
from PIL import Image  # pip install pillow

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "docs", "img")
for name in sorted(os.listdir(root)):
    if not name.endswith(".png"):
        continue
    src = os.path.join(root, name)
    dst = src[:-4] + ".webp"
    Image.open(src).save(dst, "WEBP", quality=82, method=6)
    print(f"{name}: {os.path.getsize(src)//1024} kB -> {os.path.getsize(dst)//1024} kB")
