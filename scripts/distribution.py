"""Explicit distribution surface; no directory-wide copies or runtime dependencies."""
from pathlib import Path
import hashlib
import stat

ROOT = Path(__file__).resolve().parent.parent
MOD_FILES = (
    "mod.json", "main.js", "ui.js", "ui-messages.js", "engine.js",
    "runtime.js", "collector.js", "probe.js", "notifications.js", "i18n.js",
    "system-messages.js", "environment.js", "notification-command.js",
)
SCREENSHOT_FILES = tuple(
    f"screenshots/{locale}/{tab}.png"
    for locale in ("en", "ko", "ja", "zh-CN")
    for tab in ("overview", "settings", "exceptions", "history")
)
PACKAGE_FILES = (
    "README.md", "RECIPE.md", "preview.png", "LICENSE", "THIRD_PARTY_NOTICES.md",
    "package.json", "dependencies.json", "scripts/install.py", "scripts/package.py",
    "scripts/distribution.py",
) + tuple("mods/health-watch/" + name for name in MOD_FILES) + SCREENSHOT_FILES


def regular_file(path):
    """Reject links in both the file and its parent chain."""
    for item in (path, *path.parents):
        if item.is_symlink():
            raise ValueError(f"Symlink not permitted: {item}")
    if not path.is_file() or not stat.S_ISREG(path.stat().st_mode):
        raise ValueError(f"Required regular file missing: {path}")
    return path


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
