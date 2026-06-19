import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import naim_updater


class NaimUpdaterTests(unittest.TestCase):
    def write_managed_manifest(self, folder, paths):
        Path(folder, naim_updater.MANAGED_MANIFEST).write_text(
            json.dumps({"version": "test", "files": paths}),
            encoding="utf-8",
        )

    def test_verify_archive_checks_size_and_sha256(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            archive = Path(tmpdir, "update.zip")
            archive.write_bytes(b"release-data")
            digest = hashlib.sha256(b"release-data").hexdigest()

            naim_updater.verify_archive(archive, digest, len(b"release-data"))

            with self.assertRaises(ValueError):
                naim_updater.verify_archive(archive, "0" * 64, len(b"release-data"))
            with self.assertRaises(ValueError):
                naim_updater.verify_archive(archive, digest, 1)

    def test_safe_extract_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            archive = Path(tmpdir, "bad.zip")
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("NAI_Image_Manager/../../outside.txt", "bad")

            with self.assertRaises(ValueError):
                naim_updater.safe_extract(archive, Path(tmpdir, "stage"), "NAI_Image_Manager")

            self.assertFalse(Path(tmpdir, "outside.txt").exists())

    def test_safe_extract_returns_expected_payload_root(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            archive = Path(tmpdir, "good.zip")
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("NAI_Image_Manager/app.bin", "ok")

            payload = naim_updater.safe_extract(archive, Path(tmpdir, "stage"), "NAI_Image_Manager")

            self.assertEqual(payload, Path(tmpdir, "stage", "NAI_Image_Manager"))
            self.assertEqual(Path(payload, "app.bin").read_text(encoding="utf-8"), "ok")

    def test_apply_update_replaces_managed_files_and_preserves_user_data(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            install = root / "install"
            payload = root / "payload"
            install.mkdir()
            payload.mkdir()

            (install / "app.bin").write_bytes(b"old-app")
            (install / "stale.dll").write_bytes(b"old-stale")
            (install / "gallery_config.json").write_bytes(b'{"private": true}')
            (install / "TOTAL_CLASSIFIED").mkdir()
            (install / "TOTAL_CLASSIFIED" / "image.png").write_bytes(b"private-image")
            self.write_managed_manifest(install, ["app.bin", "stale.dll"])

            (payload / "app.bin").write_bytes(b"new-app")
            (payload / "new.dll").write_bytes(b"new-dll")
            self.write_managed_manifest(payload, ["app.bin", "new.dll"])

            result = naim_updater.apply_staged_update(payload, install)

            self.assertEqual(result["installed"], 2)
            self.assertEqual((install / "app.bin").read_bytes(), b"new-app")
            self.assertEqual((install / "new.dll").read_bytes(), b"new-dll")
            self.assertFalse((install / "stale.dll").exists())
            self.assertEqual((install / "gallery_config.json").read_bytes(), b'{"private": true}')
            self.assertEqual((install / "TOTAL_CLASSIFIED" / "image.png").read_bytes(), b"private-image")

    def test_legacy_update_without_old_manifest_keeps_unknown_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            install = root / "legacy"
            payload = root / "payload"
            install.mkdir()
            payload.mkdir()
            (install / "unknown-old-runtime.dll").write_bytes(b"legacy")
            (install / "lab_config.json").write_bytes(b"private")
            (payload / "app.bin").write_bytes(b"new")
            self.write_managed_manifest(payload, ["app.bin"])

            naim_updater.apply_staged_update(payload, install)

            self.assertEqual((install / "unknown-old-runtime.dll").read_bytes(), b"legacy")
            self.assertEqual((install / "lab_config.json").read_bytes(), b"private")
            self.assertEqual((install / "app.bin").read_bytes(), b"new")

    def test_apply_update_rejects_protected_managed_paths(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            install = root / "install"
            payload = root / "payload"
            install.mkdir()
            payload.mkdir()
            (payload / "gallery_config.json").write_text("{}", encoding="utf-8")
            self.write_managed_manifest(payload, ["gallery_config.json"])

            with self.assertRaises(ValueError):
                naim_updater.apply_staged_update(payload, install)

    def test_apply_update_rolls_back_after_copy_failure(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            install = root / "install"
            payload = root / "payload"
            install.mkdir()
            payload.mkdir()
            (install / "app.bin").write_bytes(b"old-app")
            (install / "stale.dll").write_bytes(b"old-stale")
            self.write_managed_manifest(install, ["app.bin", "stale.dll"])
            old_manifest = (install / naim_updater.MANAGED_MANIFEST).read_bytes()

            (payload / "app.bin").write_bytes(b"new-app")
            (payload / "new.dll").write_bytes(b"new-dll")
            self.write_managed_manifest(payload, ["app.bin", "new.dll"])

            real_copy = naim_updater.shutil.copy2

            def failing_copy(source, destination):
                if Path(source).name == "new.dll":
                    raise OSError("injected failure")
                return real_copy(source, destination)

            with self.assertRaises(OSError):
                naim_updater.apply_staged_update(payload, install, copy_file=failing_copy)

            self.assertEqual((install / "app.bin").read_bytes(), b"old-app")
            self.assertEqual((install / "stale.dll").read_bytes(), b"old-stale")
            self.assertFalse((install / "new.dll").exists())
            self.assertEqual((install / naim_updater.MANAGED_MANIFEST).read_bytes(), old_manifest)


if __name__ == "__main__":
    unittest.main()
