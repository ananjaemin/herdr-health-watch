#!/usr/bin/env python3
"""Build a mod-only ZIP from the explicit distribution allowlist. Never publish."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import zipfile

from distribution import PACKAGE_FILES, ROOT, regular_file, sha256


def build(output):
    metadata = json.loads(regular_file(ROOT / "package.json").read_text())
    version = metadata["version"]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("package.json version is not a safe release version")
    files = [(name, regular_file(ROOT / name)) for name in PACKAGE_FILES]
    if (ROOT / "preview.png").read_bytes()[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("preview.png must be a real cropped mod PNG screenshot")
    output = output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    prefix = "herdr-health-watch-" + version
    archive = output / (prefix + ".zip")
    checksum = output / (archive.name + ".sha256")
    if os.path.lexists(archive) or os.path.lexists(checksum):
        raise ValueError(f"Release output already exists; choose a new --output directory: {archive}")
    created_archive = False
    created_checksum = False
    try:
        with archive.open("xb") as target:
            created_archive = True
            with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
                for name, source in files:
                    info = zipfile.ZipInfo(prefix + "/" + name, date_time=(2026, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.create_system = 3
                    info.external_attr = 0o100644 << 16
                    package.writestr(info, source.read_bytes())
        with checksum.open("x") as target:
            created_checksum = True
            target.write(f"{sha256(archive)}  {archive.name}\n")
    except Exception:
        # Remove only outputs this invocation created, never existing releases.
        if created_archive:
            archive.unlink(missing_ok=True)
        if created_checksum:
            checksum.unlink(missing_ok=True)
        raise
    print(archive)
    print(checksum)



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    try:
        build(args.output)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"Health Watch package: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
