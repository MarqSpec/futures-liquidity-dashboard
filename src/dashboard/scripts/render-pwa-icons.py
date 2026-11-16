#!/usr/bin/env python3
"""Draw the dashboard PWA icons from the terminal theme colours in src/theme.ts.

Re-run from the repository root to regenerate the PNGs:

    python3 src/dashboard/scripts/render-pwa-icons.py
"""

import struct
import zlib
from pathlib import Path

BG = (11, 14, 20, 255)
BID = (41, 182, 246, 255)
ASK = (255, 112, 67, 255)
LAST = (255, 213, 79, 255)

OUT = Path(__file__).resolve().parents[1] / "public" / "icons"


def png(width: int, height: int, rgba: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    rows = [b"\x00" + rgba[y * width * 4 : (y + 1) * width * 4] for y in range(height)]
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")


def rect(buf: bytearray, size: int, x: int, y: int, w: int, h: int, color: tuple[int, int, int, int]) -> None:
    x0 = max(0, x)
    y0 = max(0, y)
    x1 = min(size, x + w)
    y1 = min(size, y + h)
    paint = bytes(color)
    for row in range(y0, y1):
        start = (row * size + x0) * 4
        for col in range(x0, x1):
            buf[start : start + 4] = paint
            start += 4


def ladder(size: int, inset: float, background: tuple[int, int, int, int] = BG) -> bytes:
    buf = bytearray(bytes(background) * (size * size))
    margin = int(size * inset)
    line = max(2, size // 80)
    bar_h = max(3, size // 22)
    gap = max(2, size // 40)
    count = 5
    total = count * bar_h + (count - 1) * gap
    y0 = (size - total) // 2
    cx = size // 2
    room = max(bar_h, cx - margin - line)
    bids = (0.72, 0.40, 0.88, 0.28, 0.56)
    asks = (0.48, 0.80, 0.36, 0.64, 0.44)
    for index, (bid, ask) in enumerate(zip(bids, asks, strict=True)):
        y = y0 + index * (bar_h + gap)
        bid_w = max(bar_h, int(room * bid))
        ask_w = max(bar_h, int(room * ask))
        rect(buf, size, cx - line - gap - bid_w, y, bid_w, bar_h, BID)
        rect(buf, size, cx + line + gap, y, ask_w, bar_h, ASK)
    rect(buf, size, cx - line // 2, y0, line, total, LAST)
    return png(size, size, bytes(buf))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "icon-192.png").write_bytes(ladder(192, 0.14))
    (OUT / "icon-512.png").write_bytes(ladder(512, 0.14))
    (OUT / "icon-maskable-512.png").write_bytes(ladder(512, 0.28))
    res = Path(__file__).resolve().parents[1] / "android" / "app" / "src" / "main" / "res"
    if not res.is_dir():
        return
    legacy = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    foreground = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
    clear = (0, 0, 0, 0)
    for density, size in legacy.items():
        folder = res / f"mipmap-{density}"
        image = ladder(size, 0.12)
        for name in ("ic_launcher.png", "ic_launcher_round.png"):
            (folder / name).write_bytes(image)
    for density, size in foreground.items():
        folder = res / f"mipmap-{density}"
        (folder / "ic_launcher_foreground.png").write_bytes(ladder(size, 0.28, clear))


if __name__ == "__main__":
    main()
