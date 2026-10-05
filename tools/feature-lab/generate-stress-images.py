#!/usr/bin/env python3
"""Regenerate the original synthetic Feature Lab pressure images (no external libraries)."""
import pathlib
import struct
import zlib

OUTPUT = pathlib.Path(__file__).resolve().parents[2] / "tests/projects/feature-lab/assets/images"
SIZE = 2048
COLORS = ((220, 40, 80), (40, 180, 220), (180, 220, 40))


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for index, color in enumerate(COLORS, 1):
        rows = []
        for y in range(SIZE):
            row = bytearray(b"\0")
            for x in range(SIZE):
                rgb = color if (x // 64 + y // 64) % 2 else (24, 32, 48)
                row.extend((*rgb, 255))
            rows.append(row)
        image = b"\x89PNG\r\n\x1a\n"
        image += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
        image += chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
        image += chunk(b"IEND", b"")
        (OUTPUT / f"stress-image-{index}.png").write_bytes(image)


if __name__ == "__main__":
    main()
