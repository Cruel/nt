#!/usr/bin/env python3
"""#408 only: exercise persistent libwebp animation decoding, not a player backend.

Reads the *actual* tracer-produced WebP and per-page R8 expectations, runs one
WebPAnimDecoder through presentation holds, reset/replay and backward seeks,
and checks lossless alpha output. Requires an installed libwebpdemux shared
library; no Python packages or NovelTea runtime dependencies.
"""
import ctypes
import ctypes.util
import json
from pathlib import Path
import resource
import sys


class WebPData(ctypes.Structure):
    _fields_ = [("bytes", ctypes.POINTER(ctypes.c_uint8)), ("size", ctypes.c_size_t)]


class WebPAnimInfo(ctypes.Structure):
    _fields_ = [
        ("canvas_width", ctypes.c_uint32),
        ("canvas_height", ctypes.c_uint32),
        ("loop_count", ctypes.c_uint32),
        ("bgcolor", ctypes.c_uint32),
        ("frame_count", ctypes.c_uint32),
        ("pad", ctypes.c_uint32 * 4),
    ]


def current_rss_kib():
    for line in Path('/proc/self/status').read_text().splitlines():
        if line.startswith('VmRSS:'):
            return int(line.split()[1])
    raise RuntimeError('Cannot read Linux process RSS')


def verify(manifest_path: Path):
    manifest = json.loads(manifest_path.read_text())
    library = ctypes.util.find_library("webpdemux")
    if not library:
        raise RuntimeError("libwebpdemux is not installed (test-only dependency)")
    lib = ctypes.CDLL(library)
    lib.WebPAnimDecoderNewInternal.argtypes = [ctypes.POINTER(WebPData), ctypes.c_void_p, ctypes.c_int]
    lib.WebPAnimDecoderNewInternal.restype = ctypes.c_void_p
    lib.WebPAnimDecoderGetInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(WebPAnimInfo)]
    lib.WebPAnimDecoderGetInfo.restype = ctypes.c_int
    lib.WebPAnimDecoderHasMoreFrames.argtypes = [ctypes.c_void_p]
    lib.WebPAnimDecoderHasMoreFrames.restype = ctypes.c_int
    lib.WebPAnimDecoderGetNext.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(ctypes.POINTER(ctypes.c_uint8)), ctypes.POINTER(ctypes.c_int)
    ]
    lib.WebPAnimDecoderGetNext.restype = ctypes.c_int
    lib.WebPAnimDecoderReset.argtypes = [ctypes.c_void_p]
    lib.WebPAnimDecoderDelete.argtypes = [ctypes.c_void_p]

    encoded = (manifest_path.parent / manifest["webp"]).read_bytes()
    expected = [(manifest_path.parent / name).read_bytes() for name in manifest["pages"]]
    holds = manifest["holds"]
    width = manifest["width"]
    height = manifest["height"]
    assert len(expected) == len(holds) and 0 < len(expected) <= 65536
    assert all(len(page) == width * height for page in expected)
    assert all(hold["durationMs"] > 0 for hold in holds)
    assert all(hold["startMs"] == sum(p["durationMs"] for p in holds[:i])
               for i, hold in enumerate(holds))
    data_buffer = (ctypes.c_uint8 * len(encoded)).from_buffer_copy(encoded)
    source = WebPData(data_buffer, len(encoded))
    # WebP demux ABI 1.7. libwebp checks ABI compatibility at construction.
    decoder = lib.WebPAnimDecoderNewInternal(ctypes.byref(source), None, 0x0107)
    if not decoder:
        raise RuntimeError("Unable to construct persistent WebPAnimDecoder (ABI or source)")
    try:
        info = WebPAnimInfo()
        assert lib.WebPAnimDecoderGetInfo(decoder, ctypes.byref(info))
        assert (info.canvas_width, info.canvas_height, info.frame_count) == (
            width, height, len(expected))
        rgba = ctypes.POINTER(ctypes.c_uint8)()
        timestamp = ctypes.c_int()

        def decode_all():
            pages = []
            previous_end = 0
            while lib.WebPAnimDecoderHasMoreFrames(decoder):
                assert lib.WebPAnimDecoderGetNext(decoder, ctypes.byref(rgba), ctypes.byref(timestamp))
                # Copy only one R8 alpha plane, not an intermediate full
                # RGBA canvas. libwebp owns the persistent composited pixels.
                raw = (ctypes.c_uint8 * (width * height * 4)).from_address(
                    ctypes.addressof(rgba.contents))
                pages.append(bytes(memoryview(raw).cast('B')[3::4]))
                index = len(pages) - 1
                assert index < len(expected)
                assert pages[-1] == expected[index], "Decoded WebP alpha differs at page %d" % index
                assert timestamp.value == previous_end + holds[index]["durationMs"]
                previous_end = timestamp.value
            assert len(pages) == len(expected)
            return pages

        # Reuse one decoder across resets and forwards/backwards requests.
        rss_samples = [current_rss_kib()]
        pages = decode_all()
        if 'nativeOutputs' in manifest:
            assert len(manifest['nativeOutputs']) == len(pages)
            for name, alpha in zip(manifest['nativeOutputs'], pages):
                output = Path(name)
                assert output.name == name and name.endswith('.r8')
                (manifest_path.parent / output).write_bytes(alpha)
        rss_samples.append(current_rss_kib())
        for _ in range(4):
            lib.WebPAnimDecoderReset(decoder)
            assert decode_all() == pages
            rss_samples.append(current_rss_kib())
        for time_ms in manifest["seeks"]:
            assert 0 <= time_ms < sum(h["durationMs"] for h in holds)
            # For random access, seek is implemented by reset/replay, *not*
            # by instantiating a fresh decoder for every frame.
            lib.WebPAnimDecoderReset(decoder)
            reproduced = decode_all()
            selected = next(i for i, hold in enumerate(holds)
                            if time_ms < hold["startMs"] + hold["durationMs"])
            assert reproduced[selected] == expected[selected]
            for pixel in (0, (height // 2) * width + width // 2, width * height - 1):
                assert (reproduced[selected][pixel] > 0) == (expected[selected][pixel] > 0)
            rss_samples.append(current_rss_kib())
        usage = resource.getrusage(resource.RUSAGE_SELF)
        print(json.dumps({
            "decoder": "libwebp-animated-persistent",
            "width": width, "height": height,
            "pages": len(expected), "seeks": len(manifest["seeks"]),
            "replays": 5 + len(manifest["seeks"]),
            "alphaBytesResident": width * height,
            "webpBytes": len(encoded),
            "rssSamplesKiB": rss_samples,
            "maxRssKiB": usage.ru_maxrss,
        }))
    finally:
        lib.WebPAnimDecoderDelete(decoder)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: webp_alpha_persistent_probe.py manifest.json")
    verify(Path(sys.argv[1]))
