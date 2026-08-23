#!/usr/bin/env python3
"""Generate every store image from one piece of geometry.

  tools/make-app-icon.py

writes the iOS app icon (1024), the Play listing icon (512) and the Play
feature graphic (1024x500). Three sizes, one definition — so the mark cannot
drift between the two stores, which is exactly what happens when somebody
resizes a PNG by hand at eleven at night.

A script rather than a committed-and-forgotten binary: the icon is 30 lines of
geometry, and this way changing it is editing numbers instead of finding
whoever has the source file. Pure stdlib — zlib and struct are a complete PNG
encoder for what this needs.

App Store icons MUST be opaque. An alpha channel is rejected at upload with no
useful message, so this writes RGB with no transparency at all and lets iOS
apply its own corner mask.
"""
import struct, zlib, pathlib

SS = 2            # supersample factor, for antialiased edges

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


def render(S, H=None):
    """@param S width @param H height, defaulting to square."""
    H = H or S
    N = S * SS
    NH = H * SS
    counts = S * H
    # Render at SS scale, box-downsample into the final buffer.
    sums = [[0, 0, 0] for _ in range(counts)]
    # The bars are placed in units of the SHORT side, so the mark keeps its
    # proportions on a wide canvas instead of stretching into a smear.
    unit = min(N, NH)
    inset_x = (N - unit) / 2
    inset_y = (NH - unit) / 2
    bars = [
        (
            inset_x + BAR_X * unit,
            inset_y + y * unit,
            inset_x + (BAR_X + w) * unit,
            inset_y + (y + BAR_H) * unit,
            BAR_H * unit / 2,
            c,
        )
        for (y, w, c) in BARS
    ]
    for sy in range(NH):
        t = sy / (NH - 1)
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
    acc = bytearray(counts * 3)
    n = SS * SS
    for i, cell in enumerate(sums):
        acc[i * 3] = cell[0] // n
        acc[i * 3 + 1] = cell[1] // n
        acc[i * 3 + 2] = cell[2] // n
    return bytes(acc)


def png(rgb, width, height=None):
    height = height or width
    raw = b''.join(b'\x00' + rgb[y * width * 3:(y + 1) * width * 3] for y in range(height))

    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


root = pathlib.Path(__file__).resolve().parent.parent

# (path, width, height). The Play listing icon is 512 and the feature graphic
# is 1024x500 — both fixed by Google, neither negotiable.
TARGETS = [
    ('apps/ios/Fleetwright/Assets.xcassets/AppIcon.appiconset/icon-1024.png', 1024, None),
    ('apps/android/store/icon-512.png', 512, None),
    ('apps/android/store/feature-graphic-1024x500.png', 1024, 500),
]

for rel, w, h in TARGETS:
    out = root / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(png(render(w, h), w, h))
    print(f'wrote {rel} ({w}x{h or w}, {out.stat().st_size} bytes)')
