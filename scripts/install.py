#!/usr/bin/env python3
"""Install only Health Watch and explicitly supplied, pinned local dependencies."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import sys
import tarfile
import tempfile
import zipfile

from distribution import MOD_FILES, ROOT, regular_file, sha256

VITALS_CONFIG = '{"background":false,"alerts":false,"ai_alerts":false,"herdr_machines":false,"local":true,"interval_seconds":10}'
DEFAULT_APP_HOME = Path.home() / ".config/herdr-app"
DEFAULT_DATA_HOME = Path.home() / ".local/share/herdr-health-watch"
MAX_MEMBER = 128 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024


def exists(path):
    return os.path.lexists(path)


def valid_config(path):
    # POSIX command substitution in probe.js removes trailing LF bytes only.
    return path.is_file() and path.read_bytes().rstrip(b"\n") == VITALS_CONFIG.encode()


def safe_path(root, *parts):
    path = root.joinpath(*parts)
    for item in (path, *path.parents):
        if item == root:
            break
        if item.is_symlink():
            raise ValueError(f"Refusing destination symlink: {item}")
    return path


def directory(path):
    if exists(path) and not path.is_dir():
        raise ValueError(f"Expected directory: {path}")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)


def platform_key():
    system = platform.system().lower()
    arch = {"aarch64": "arm64", "amd64": "x86_64"}.get(platform.machine().lower(), platform.machine().lower())
    if system not in ("darwin", "linux"):
        raise ValueError("Only macOS and Linux probes are supported; Windows is not supported")
    return system + "_" + arch


def member_name(name):
    if not name or name.startswith("/") or "\\" in name or ":" in name or "\0" in name or ".." in name.split("/"):
        raise ValueError(f"Unsafe archive path: {name!r}")
    return str(PurePosixPath(name))


def archive_binary(archive):
    """Validate every member; read one binary without extracting archive paths."""
    seen = set()
    binaries = []
    total = 0

    def check(name, size):
        nonlocal total
        name = member_name(name)
        if name in seen:
            raise ValueError(f"Duplicate archive member: {name}")
        seen.add(name)
        total += size
        if size < 0 or size > MAX_MEMBER or total > MAX_TOTAL:
            raise ValueError("Archive exceeds dependency size limits")
        return name

    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as source:
            for info in source.infolist():
                name = check(info.filename, info.file_size)
                mode = info.external_attr >> 16
                kind = stat.S_IFMT(mode)
                if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or info.flag_bits & 1:
                    raise ValueError(f"Unsafe archive member: {name}")
                if PurePosixPath(name).name == "herdr-vitals" and not info.is_dir():
                    binaries.append(source.read(info))
    else:
        with tarfile.open(archive, "r:*") as source:
            for info in source:
                name = check(info.name, info.size)
                if not (info.isfile() or info.isdir()):
                    raise ValueError(f"Unsafe archive member: {name}")
                if PurePosixPath(name).name == "herdr-vitals" and info.isfile():
                    stream = source.extractfile(info)
                    if stream is None:
                        raise ValueError("Missing dependency binary contents")
                    with stream:
                        binaries.append(stream.read(MAX_MEMBER + 1))
    if len(binaries) != 1 or not binaries[0] or len(binaries[0]) > MAX_MEMBER:
        raise ValueError("Archive must contain exactly one nonempty herdr-vitals regular file")
    return binaries[0]


def dependency_plan(data_home, archive, notifier):
    manifest = json.loads(regular_file(ROOT / "dependencies.json").read_text())
    vitals = manifest["vitals"]
    key = platform_key()
    entry = vitals["platforms"].get(key)
    binary = safe_path(data_home, "vitals", vitals["version"], "herdr-vitals")
    config = safe_path(data_home, "config", "config.json")
    content = None
    if archive:
        if not entry:
            raise ValueError(f"No verified dependency pin for {key}; do not substitute an unpinned build")
        archive = regular_file(archive.expanduser().resolve())
        if sha256(archive) != entry["archive_sha256"]:
            raise ValueError("Vitals archive SHA256 does not match the pinned official release")
        content = archive_binary(archive)
        expected_binary = entry.get("binary_sha256")
        if expected_binary and hashlib.sha256(content).hexdigest() != expected_binary:
            raise ValueError("Vitals binary SHA256 does not match its pinned checksum")
        if exists(binary) and (not binary.is_file() or sha256(binary) != hashlib.sha256(content).hexdigest()):
            raise ValueError(f"Existing dependency differs; refusing to replace it: {binary}")
        if exists(config) and not valid_config(config):
            raise ValueError(f"Isolated Vitals config differs; refusing to overwrite it: {config}")
    notifier_target = None
    link = data_home / "terminal-notifier"
    safe_path(data_home, "home")
    safe_path(data_home, "state")
    if notifier:
        if platform.system() != "Darwin":
            raise ValueError("--notifier is for macOS terminal-notifier; Linux uses notify-send")
        notifier_target = notifier.expanduser().resolve(strict=True)
        if not notifier_target.is_file() or not os.access(notifier_target, os.X_OK):
            raise ValueError("--notifier must name an existing executable file")
        safe_path(data_home, "vitals")
        if exists(link) and (not link.is_symlink() or link.resolve() != notifier_target):
            raise ValueError(f"Notifier link already exists and differs: {link}")
    return binary, config, content, link, notifier_target


def write_exclusive(path, content, mode):
    with path.open("xb") as target:
        target.write(content)
    path.chmod(mode)


def install_dependencies(data_home, plan):
    binary, config, content, link, notifier_target = plan
    if content is not None:
        for parts in (("vitals",), ("vitals", "0.3.1"), ("config",), ("home",), ("state",)):
            directory(safe_path(data_home, *parts))
        if not exists(binary):
            write_exclusive(binary, content, 0o755)
        elif not os.access(binary, os.X_OK):
            raise ValueError(f"Existing verified binary is not executable; adjust its permissions manually: {binary}")
        if not exists(config):
            write_exclusive(config, VITALS_CONFIG.encode(), 0o600)
    if notifier_target is not None and not exists(link):
        directory(data_home)
        link.symlink_to(notifier_target)
    ready = binary.is_file() and os.access(binary, os.X_OK) and valid_config(config)
    if ready:
        print("Collector files present; installer did not execute or live-test Vitals.")
    else:
        print("WARNING: Collector not ready. Mod installed, but monitoring cannot run until the pinned local Vitals archive is installed with --vitals-archive.", file=sys.stderr)


def backup_mod(app_home, target):
    backups = safe_path(app_home, "mod-backups")
    directory(backups)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = safe_path(app_home, "mod-backups", "health-watch-" + stamp)
    target.rename(backup)
    print(f"Mod backup: {backup}")
    return backup


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--app-home", type=Path, default=DEFAULT_APP_HOME)
    result.add_argument("--data-home", type=Path, default=DEFAULT_DATA_HOME)
    result.add_argument("--vitals-archive", type=Path, help="explicit local official pinned archive; never downloaded or executed")
    result.add_argument("--notifier", type=Path, help="explicit existing macOS terminal-notifier executable to link")
    result.add_argument("--upgrade", action="store_true", help="back up only an existing Health Watch mod before replacement")
    modes = result.add_mutually_exclusive_group()
    modes.add_argument("--remove", action="store_true", help="rename mod to backup; retain all data and dependencies")
    modes.add_argument("--restore-backup", metavar="NAME", help="restore a Health Watch backup basename printed by this installer")
    return result


def run(args):
    app_home = args.app_home.expanduser().resolve()
    data_home = args.data_home.expanduser().resolve()
    target = safe_path(app_home, "mods", "health-watch")
    if target == ROOT / "mods/health-watch":
        raise ValueError("Refusing to install over this distribution's source mod")
    if data_home != DEFAULT_DATA_HOME.resolve():
        print("WARNING: --data-home override is isolated QA only. Runtime still reads ~/.local/share/herdr-health-watch on each target machine; it will NOT use this override.", file=sys.stderr)
    if (args.remove or args.restore_backup) and (args.vitals_archive or args.notifier):
        raise ValueError("Removal/restore cannot install dependencies or notifier links")
    if exists(target) and not target.is_dir():
        raise ValueError(f"Existing mod path is not a directory: {target}")
    if args.remove:
        if not exists(target):
            raise ValueError(f"Health Watch is not installed: {target}")
        backup_mod(app_home, target)
        print("Removed by rename only. Runtime data/history and external dependencies were preserved.")
        return
    if exists(target) and not args.upgrade:
        raise ValueError("Health Watch already exists; use --upgrade to back up and replace only this mod")
    restore = None
    if args.restore_backup:
        name = args.restore_backup
        if not name.startswith("health-watch-") or Path(name).name != name or "/" in name or "\\" in name:
            raise ValueError("--restore-backup requires a Health Watch backup basename, not a path")
        restore = safe_path(app_home, "mod-backups", name)
        if not restore.is_dir():
            raise ValueError(f"Backup directory not found: {restore}")
    if restore is None:
        sources = [regular_file(ROOT / "mods/health-watch" / name) for name in MOD_FILES]
        plan = dependency_plan(data_home, args.vitals_archive, args.notifier)
    directory(safe_path(app_home, "mods"))
    if restore is not None:
        backup = backup_mod(app_home, target) if exists(target) else None
        try:
            restore.rename(target)
        except OSError:
            if backup:
                backup.rename(target)
            raise
        print(f"Restored mod only: {target}; shared configuration/state unchanged.")
        return
    # Stage the exact source allowlist before renaming any existing mod.
    with tempfile.TemporaryDirectory(prefix=".health-watch-stage-", dir=target.parent) as stage:
        staged = Path(stage) / "health-watch"
        staged.mkdir()
        for source in sources:
            shutil.copyfile(source, staged / source.name)
        install_dependencies(data_home, plan)
        backup = backup_mod(app_home, target) if exists(target) else None
        try:
            staged.rename(target)
        except OSError:
            if backup:
                backup.rename(target)
            raise
    print(f"Installed mod only: {target}")
    print("No layouts, themes, keys, shared.json, sessions, startup services or shell configuration were changed.")


def main():
    args = parser().parse_args()
    try:
        run(args)
    except (OSError, ValueError, KeyError, tarfile.TarError, zipfile.BadZipFile) as error:
        print(f"Health Watch: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
