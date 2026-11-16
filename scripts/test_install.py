"""Focused stdlib-only archive and mod-lifecycle tests; no dependency execution."""
import contextlib
import io
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
import zipfile

import install


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="health watch installer tests ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.app = self.root / "app home"
        self.data = self.root / "data home"

    def run_installer(self, *flags):
        args = install.parser().parse_args([
            "--app-home", str(self.app), "--data-home", str(self.data), *flags,
        ])
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            install.run(args)

    def tar(self, name="herdr-vitals", kind=tarfile.REGTYPE):
        archive = self.root / "dependency.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            info = tarfile.TarInfo(name)
            info.type = kind
            if kind == tarfile.REGTYPE:
                info.size = 6
                output.addfile(info, io.BytesIO(b"binary"))
            else:
                info.linkname = "/tmp/outside"
                output.addfile(info)
        return archive

    def test_tar_traversal_and_absolute_paths_rejected(self):
        for name in ("../herdr-vitals", "/herdr-vitals", "sub/../../herdr-vitals", "C:/herdr-vitals", "sub\\herdr-vitals"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                install.archive_binary(self.tar(name))
        self.assertFalse((self.root.parent / "herdr-vitals").exists())

    def test_tar_symlink_hardlink_and_device_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                install.archive_binary(self.tar(kind=kind))

    def test_zip_traversal_and_symlink_rejected(self):
        archive = self.root / "dependency.zip"
        for name, mode in (("../herdr-vitals", stat.S_IFREG), ("herdr-vitals", stat.S_IFLNK)):
            with zipfile.ZipFile(archive, "w") as output:
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = (mode | 0o755) << 16
                output.writestr(info, "outside")
            with self.subTest(name=name), self.assertRaises(ValueError):
                install.archive_binary(archive)

    def test_safe_tar_reads_binary_without_extracting(self):
        self.assertEqual(install.archive_binary(self.tar("release/herdr-vitals")), b"binary")
        self.assertFalse((self.root / "release").exists())

    def test_duplicate_binary_rejected(self):
        archive = self.root / "duplicate.zip"
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr("a/herdr-vitals", "one")
            output.writestr("b/herdr-vitals", "two")
        with self.assertRaises(ValueError):
            install.archive_binary(archive)

    def test_unpinned_archive_rejected_before_install(self):
        archive = self.tar()
        (self.root / "dependency.tar.gz.sha256").write_text(install.sha256(archive))
        with self.assertRaisesRegex(ValueError, "SHA256|verified dependency pin"):
            self.run_installer("--vitals-archive", str(archive))
        self.assertFalse(self.app.exists())
        self.assertFalse(self.data.exists())

    def test_upgrade_remove_restore_preserve_unrelated_files(self):
        original = self.app / "mods/health-watch"
        original.mkdir(parents=True)
        (original / "main.js").write_text("old mod only")
        protected = {
            "shared.json": '{"health-watch.config":{"language":"ko"}}',
            "keys.json": '{"global":{}}', "layouts/personal.json": "layout",
            "themes/personal.json": "theme", "mods/other/main.js": "other mod",
        }
        for name, content in protected.items():
            target = self.app / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        self.data.mkdir()
        (self.data / "history-sentinel").write_text("keep collector data")
        self.run_installer("--upgrade")
        backups = list((self.app / "mod-backups").iterdir())
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "main.js").read_text(), "old mod only")
        self.assertEqual(set(path.name for path in original.iterdir()), set(install.MOD_FILES))
        self.run_installer("--remove")
        self.assertFalse(original.exists())
        self.run_installer("--restore-backup", backups[0].name)
        self.assertEqual((original / "main.js").read_text(), "old mod only")
        for name, content in protected.items():
            self.assertEqual((self.app / name).read_text(), content)
        self.assertEqual((self.data / "history-sentinel").read_text(), "keep collector data")

    def test_conflict_refuses_without_side_effects(self):
        target = self.app / "mods/health-watch"
        target.mkdir(parents=True)
        (target / "sentinel").write_text("keep")
        with self.assertRaisesRegex(ValueError, "--upgrade"):
            self.run_installer()
        self.assertEqual((target / "sentinel").read_text(), "keep")
        self.assertFalse((self.app / "mod-backups").exists())
        self.assertFalse(self.data.exists())

    def test_destination_symlink_refused(self):
        outside = self.root / "outside"
        outside.mkdir()
        self.app.mkdir()
        (self.app / "mods").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.run_installer()
        self.assertEqual(list(outside.iterdir()), [])

    @unittest.skipUnless(install.platform.system() == "Darwin", "macOS notifier option")
    def test_notifier_link_requires_explicit_executable_and_survives_remove(self):
        executable = Path(install.sys.executable).resolve()
        self.run_installer("--notifier", str(executable))
        link = self.data / "terminal-notifier"
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.resolve(), executable)
        self.run_installer("--remove")
        self.assertEqual(link.resolve(), executable)
        link.unlink()
        link.write_text("existing user file")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.run_installer("--notifier", str(executable))
        self.assertEqual(link.read_text(), "existing user file")
        self.assertFalse((self.app / "mods/health-watch").exists())

    def test_backup_traversal_refused(self):
        with self.assertRaisesRegex(ValueError, "basename"):
            self.run_installer("--restore-backup", "health-watch-../../outside")
        self.assertFalse(self.app.exists())

    def test_existing_collector_config_matches_probe_linefeed_semantics(self):
        config = self.root / "config.json"
        for suffix, expected in ((b"", True), (b"\n", True), (b"\n\n", True), (b"\r\n", False), (b" ", False)):
            config.write_bytes(install.VITALS_CONFIG.encode() + suffix)
            with self.subTest(suffix=suffix):
                self.assertEqual(install.valid_config(config), expected)



if __name__ == "__main__":
    unittest.main()
