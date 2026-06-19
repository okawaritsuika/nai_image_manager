import io
import json
import tempfile
import unittest
from pathlib import Path

import exe_update


class ExeUpdateTests(unittest.TestCase):
    def valid_manifest(self, **overrides):
        manifest = {
            "schema_version": 1,
            "version": "1.1.0",
            "tag": "v1.1.0-exe",
            "asset_url": "https://github.com/okawaritsuika/nai_image_manager/releases/download/v1.1.0-exe/NAI_Image_Manager_v1.1.0-exe_windows.zip",
            "sha256": "a" * 64,
            "size": 12345,
            "payload_root": "NAI_Image_Manager",
            "summary": "업데이트 기능 추가",
        }
        manifest.update(overrides)
        return manifest

    def test_parse_version_accepts_three_numeric_parts(self):
        self.assertEqual(exe_update.parse_version("1.2.30"), (1, 2, 30))

    def test_parse_version_rejects_non_semantic_version(self):
        for value in ("v1.2.3", "1.2", "1.2.3.4", "1.a.3", ""):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    exe_update.parse_version(value)

    def test_validate_manifest_returns_normalized_copy(self):
        source = self.valid_manifest(sha256="A" * 64)

        validated = exe_update.validate_manifest(source)

        self.assertEqual(validated["sha256"], "a" * 64)
        self.assertEqual(validated["version"], "1.1.0")
        self.assertIsNot(validated, source)

    def test_validate_manifest_rejects_missing_fields(self):
        for field in ("version", "tag", "asset_url", "sha256", "size", "payload_root"):
            manifest = self.valid_manifest()
            del manifest[field]
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    exe_update.validate_manifest(manifest)

    def test_validate_manifest_rejects_non_github_or_http_asset(self):
        for url in (
            "http://github.com/example/file.zip",
            "https://example.com/file.zip",
            "file:///tmp/file.zip",
        ):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    exe_update.validate_manifest(self.valid_manifest(asset_url=url))

    def test_validate_manifest_rejects_bad_hash_size_tag_or_root(self):
        invalid = (
            {"sha256": "bad"},
            {"size": 0},
            {"tag": "v9.9.9-exe"},
            {"payload_root": "../NAI_Image_Manager"},
        )
        for override in invalid:
            with self.subTest(override=override):
                with self.assertRaises(ValueError):
                    exe_update.validate_manifest(self.valid_manifest(**override))

    def test_is_update_available_only_for_newer_version(self):
        self.assertTrue(exe_update.is_update_available("1.0.9", self.valid_manifest()))
        self.assertFalse(exe_update.is_update_available("1.1.0", self.valid_manifest()))
        self.assertFalse(exe_update.is_update_available("1.2.0", self.valid_manifest()))

    def test_fetch_manifest_reads_and_validates_json(self):
        payload = json.dumps(self.valid_manifest()).encode("utf-8")

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

        opened = []

        def opener(request, timeout):
            opened.append((request.full_url, timeout))
            return Response(payload)

        result = exe_update.fetch_manifest("https://example.invalid/manifest.json", timeout=3, opener=opener)

        self.assertEqual(result["version"], "1.1.0")
        self.assertEqual(opened, [("https://example.invalid/manifest.json", 3)])

    def test_resolve_updater_executable_requires_frozen_mode_and_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            updater = Path(tmpdir, "NAIM_Updater.exe")
            updater.write_bytes(b"exe")

            self.assertEqual(exe_update.resolve_updater_executable(tmpdir, frozen=True), updater)
            with self.assertRaises(RuntimeError):
                exe_update.resolve_updater_executable(tmpdir, frozen=False)
            updater.unlink()
            with self.assertRaises(FileNotFoundError):
                exe_update.resolve_updater_executable(tmpdir, frozen=True)

    def test_build_updater_command_passes_install_pid_restart_and_manifest(self):
        command = exe_update.build_updater_command(
            Path("C:/Portable/NAI"),
            321,
            Path("C:/Portable/NAI/NAI_Image_Manager.exe"),
        )

        self.assertEqual(command[0], str(Path("C:/Portable/NAI/NAIM_Updater.exe")))
        self.assertEqual(command[1:3], ["--install-dir", str(Path("C:/Portable/NAI"))])
        self.assertIn("321", command)
        self.assertIn(exe_update.MANIFEST_URL, command)


if __name__ == "__main__":
    unittest.main()
