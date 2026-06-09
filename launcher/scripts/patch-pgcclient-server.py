#!/usr/bin/env python3
"""Set explicit Minerent server port in pgcclient jar (SRV fallback)."""

from __future__ import annotations

import os
import shutil
import struct
import sys
import zipfile

DEFAULT_HOST = b"operativniki.minerent.io"
DEFAULT_TARGET = b"operativniki.minerent.io:31018"
CLASSES = (
    "io/minerent/svo/client/SvoConnect.class",
    "io/minerent/svo/client/SvoServerScreen.class",
)


def patch_class(data: bytes, old: bytes, new: bytes) -> tuple[bytes, int]:
    marker = bytes([1]) + struct.pack(">H", len(old)) + old
    idx = data.find(marker)
    if idx < 0:
        return data, 0
    replacement = bytes([1]) + struct.pack(">H", len(new)) + new
    out = data[:idx] + replacement + data[idx + len(marker) :]
    return out, 1


def patch_jar(jar_path: str, old: bytes = DEFAULT_HOST, new: bytes = DEFAULT_TARGET) -> int:
    with zipfile.ZipFile(jar_path, "r") as zin:
        entries = {info.filename: zin.read(info.filename) for info in zin.infolist()}

    total = 0
    for name in CLASSES:
        if name not in entries:
            continue
        patched, count = patch_class(entries[name], old, new)
        if count:
            entries[name] = patched
            total += count

    if total == 0:
        return 0

    backup = jar_path + ".bak"
    if not os.path.exists(backup):
        shutil.copy2(jar_path, backup)

    with zipfile.ZipFile(jar_path, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        for name, body in entries.items():
            zout.writestr(name, body)
    return total


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: patch-pgcclient-server.py <pgcclient.jar>", file=sys.stderr)
        return 2
    jar = sys.argv[1]
    if not os.path.isfile(jar):
        print(f"Not found: {jar}", file=sys.stderr)
        return 1
    count = patch_jar(jar)
    print(f"Patched {count} class constant(s) in {jar}")
    return 0 if count else 1


if __name__ == "__main__":
    raise SystemExit(main())
