import hashlib
import json
import tempfile
import unittest
from unittest import mock
import zipfile
from pathlib import Path

import naim_updater


class NaimUpdaterTests(unittest.TestCase):
    def test_failed_rollback_retains_backup_for_recovery(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            install, payload, backup = root / "install", root / "payload", root / "backup"
            for folder in (install, payload, backup):
                folder.mkdir()
            (install / "app.bin").write_bytes(b"old")
            (payload / "app.bin").write_bytes(b"new")
            self.write_managed_manifest(install, ["app.bin"])
            self.write_managed_manifest(payload, ["app.bin"])
            real_copy = naim_updater.shutil.copy2

            def fail_restore(source, target):
                if Path(source).parent == backup:
                    raise OSError("restore locked")
                return real_copy(source, target)

            with mock.patch.object(naim_updater.tempfile, "mkdtemp", return_value=str(backup)), \
                 mock.patch.object(naim_updater.shutil, "copy2", side_effect=fail_restore):
                with self.assertRaises(RuntimeError):
                    naim_updater.apply_staged_update(
                        payload, install, copy_file=mock.Mock(side_effect=OSError("update failed"))
                    )
            self.assertEqual((backup / "app.bin").read_bytes(), b"old")

    def test_backup_failure_does_not_delete_unbacked_installation_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            install, payload = root / "install", root / "payload"
            install.mkdir()
            payload.mkdir()
            for name in ("a.bin", "b.bin"):
                (install / name).write_bytes(b"old-" + name.encode())
                (payload / name).write_bytes(b"new")
            self.write_managed_manifest(install, ["a.bin", "b.bin"])
            self.write_managed_manifest(payload, ["a.bin", "b.bin"])
            original = {p.name: p.read_bytes() for p in install.iterdir()}
            real_copy = naim_updater.shutil.copy2

            def fail_backup(source, target):
                if Path(source) == install / "a.bin":
                    raise OSError("backup failed")
                return real_copy(source, target)

            with mock.patch.object(naim_updater.shutil, "copy2", side_effect=fail_backup):
                with self.assertRaises(OSError):
                    naim_updater.apply_staged_update(payload, install)
            self.assertEqual({p.name: p.read_bytes() for p in install.iterdir()}, original)

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
            (install / "daki_projects.json").write_bytes(b'{"enabled": false, "projects": []}')
            (install / "daki_style_tests" / "sample").mkdir(parents=True)
            (install / "daki_style_tests" / "sample" / "batch.json").write_bytes(b'{"completed": 1}')
            (install / "daki_imported_styles").mkdir()
            (install / "daki_imported_styles" / "catalog.json").write_bytes(b'{"styles": []}')
            (install / "daki_personal_styles").mkdir()
            (install / "daki_personal_styles" / "catalog.json").write_bytes(b'{"styles": [{"name":"personal ink"}]}')
            (install / "daki_worldcups").mkdir()
            (install / "daki_worldcups" / "record.json").write_bytes(b'{"winner":"synthetic.png"}')
            (install / "daki_drafts" / "synthetic").mkdir(parents=True)
            (install / "daki_drafts" / "synthetic" / "draft.json").write_bytes(b'{"status":"completed"}')
            (install / "daki_tag_examples").mkdir()
            (install / "daki_tag_examples" / "catalog.json").write_bytes(b'{"examples":[]}')
            (install / "daki_dictionary_user").mkdir()
            (install / "daki_dictionary_user" / "user_edits.json").write_bytes(b'{"smile":{"ko":"synthetic"}}')
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
            self.assertEqual((install / "daki_projects.json").read_bytes(), b'{"enabled": false, "projects": []}')
            self.assertEqual((install / "daki_style_tests" / "sample" / "batch.json").read_bytes(), b'{"completed": 1}')
            self.assertEqual((install / "daki_imported_styles" / "catalog.json").read_bytes(), b'{"styles": []}')
            self.assertEqual((install / "daki_personal_styles" / "catalog.json").read_bytes(), b'{"styles": [{"name":"personal ink"}]}')
            self.assertEqual((install / "daki_worldcups" / "record.json").read_bytes(), b'{"winner":"synthetic.png"}')
            self.assertEqual((install / "daki_drafts" / "synthetic" / "draft.json").read_bytes(), b'{"status":"completed"}')
            self.assertEqual((install / "daki_tag_examples" / "catalog.json").read_bytes(), b'{"examples":[]}')
            self.assertEqual((install / "daki_dictionary_user" / "user_edits.json").read_bytes(), b'{"smile":{"ko":"synthetic"}}')
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
            for name in ("gallery_config.json", "daki_projects.json", "daki_personal_styles/catalog.json",
                         "style_workspace.local.json"):
                with self.subTest(name=name):
                    (payload / name).parent.mkdir(parents=True, exist_ok=True)
                    (payload / name).write_text("{}", encoding="utf-8")
                    self.write_managed_manifest(payload, [name])
                    with self.assertRaises(ValueError):
                        naim_updater.apply_staged_update(payload, install)

    def test_apply_update_rejects_environment_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            install = root / "install"
            payload = root / "payload"
            install.mkdir()
            payload.mkdir()
            (payload / ".env.local").write_text("SECRET=value", encoding="utf-8")
            self.write_managed_manifest(payload, [".env.local"])

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
