#!/usr/bin/env python3
"""Generate apps/ios/.../AppIcon.appiconset/icon-1024.png.

A script rather than a committed-and-forgotten binary: the icon is 30 lines of
geometry, and this way changing it is editing numbers instead of finding
whoever has the source file. Pure stdlib — zlib and struct are a complete PNG
encoder for what this needs.

App Store icons MUST be opaque. An alpha channel is rejected at upload with no
useful message, so this writes RGB with no transparency at all and lets iOS
apply its own corner mask.
"""
import struct, zlib, pathlib

S = 1024          # final size
SS = 2            # supersample factor, for antialiased edges
N = S * SS

BG_TOP = (0x10, 0x16, 0x20)
BG_BOTTOM = (0x1C, 0x26, 0x33)
# Two calm bars and one amber: a fleet of sessions, one of which wants a person.
# That is the whole product in three rectangles.
BARS = [
    (0.30, 0.62, (0x5A, 0xA9, 0xFF)),
    (0.46, 0.78, (0x7F, 0xC4, 0xFF)),
    (0.62, 0.50, (0xFF, 0xB0, 0x3A)),
]
BAR_H = 0.105
BAR_X = 0.185


def rounded(px, py, x0, y0, x1, y1, r):
    """Is (px, py) inside the rounded rect? Centre-of-pixel sampling."""
    if not (x0 <= px <= x1 and y0 <= py <= y1):
        return False
    cx = min(max(px, x0 + r), x1 - r)
    cy = min(max(py, y0 + r), y1 - r)
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r


def render():
    acc = bytearray(S * S * 3)
    counts = S * S
    # Render at SS scale, box-downsample into the final buffer.
    sums = [[0, 0, 0] for _ in range(counts)]
    bars = [
        (BAR_X * N, y * N, (BAR_X + w) * N, (y + BAR_H) * N, BAR_H * N / 2, c)
        for (y, w, c) in BARS
    ]
    for sy in range(N):
        t = sy / (N - 1)
        bg = tuple(int(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM))
        row_base = (sy // SS) * S
        for sx in range(N):
            colour = bg
            for (x0, y0, x1, y1, r, c) in bars:
                if rounded(sx, sy, x0, y0, x1, y1, r):
                    colour = c
                    break
            cell = sums[row_base + (sx // SS)]
            cell[0] += colour[0]
            cell[1] += colour[1]
            cell[2] += colour[2]
    n = SS * SS
    for i, cell in enumerate(sums):
        acc[i * 3] = cell[0] // n
        acc[i * 3 + 1] = cell[1] // n
        acc[i * 3 + 2] = cell[2] // n
    return bytes(acc)


def png(rgb, size):
    raw = b''.join(b'\x00' + rgb[y * size * 3:(y + 1) * size * 3] for y in range(size))

    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


out = pathlib.Path(__file__).resolve().parent.parent / 'apps/ios/Fleetwright/Assets.xcassets/AppIcon.appiconset/icon-1024.png'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_bytes(png(render(), S))
print(f'wrote {out} ({out.stat().st_size} bytes)')
