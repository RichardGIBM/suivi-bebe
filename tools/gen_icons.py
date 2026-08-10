#!/usr/bin/env python3
"""Génère les icônes PWA (cœur blanc sur dégradé rose->bleu) sans dépendance externe."""
import struct, zlib, os

ROSE = (207, 138, 179)   # #CF8AB3
BLEU = (128, 180, 215)   # #80B4D7

def lerp(a, b, t):
    return a + (b - a) * t

def inside_heart(u, v):
    # u,v centrés, y vers le haut. Cœur upright.
    a = u * u + v * v - 1.0
    return a * a * a - u * u * v * v * v <= 0.0

def render(size, heart_frac, out_path):
    ss = 3  # supersampling
    W = size
    scale = size * heart_frac  # demi-largeur ~1.3*scale
    cx = size / 2.0
    cy = size * 0.46  # centre légèrement au-dessus (le cœur descend)
    raw = bytearray()
    inv = 1.0 / (ss * ss)
    for py in range(W):
        raw.append(0)  # filtre PNG par ligne = None
        row = bytearray()
        for px in range(W):
            r = g = b = 0.0
            for sy in range(ss):
                fy = py + (sy + 0.5) / ss
                for sx in range(ss):
                    fx = px + (sx + 0.5) / ss
                    # dégradé diagonal
                    t = (fx + fy) / (2.0 * W)
                    br = lerp(ROSE[0], BLEU[0], t)
                    bg = lerp(ROSE[1], BLEU[1], t)
                    bb = lerp(ROSE[2], BLEU[2], t)
                    u = (fx - cx) / scale
                    vv = (cy - fy) / scale
                    if inside_heart(u, vv):
                        r += 255.0; g += 255.0; b += 255.0
                    else:
                        r += br; g += bg; b += bb
            row.append(int(r * inv + 0.5))
            row.append(int(g * inv + 0.5))
            row.append(int(b * inv + 0.5))
        raw.extend(row)

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        c += struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
        return c

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", W, W, 8, 2, 0, 0, 0)  # 8-bit RGB
    idat = zlib.compress(bytes(raw), 9)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    with open(out_path, "wb") as f:
        f.write(png)
    print("écrit", out_path, len(png), "octets")

base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# maskable : cœur plus petit (zone de sécurité ~80%)
render(512, 0.20, os.path.join(base, "icons", "icon-512.png"))
render(192, 0.20, os.path.join(base, "icons", "icon-192.png"))
# apple-touch : pas de masquage iOS agressif, cœur un peu plus grand
render(180, 0.23, os.path.join(base, "icons", "apple-touch-icon.png"))
