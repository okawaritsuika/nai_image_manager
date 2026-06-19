# EXE Self-Update and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the current gallery feature into `master`, create an `exe-release` branch, add a GitHub-hosted self-updater that preserves all user data, and publish a verified Windows release.

**Architecture:** `master` remains the source distribution and continues to use `update.bat`. The `exe-release` branch adds a small standard-library update client, a standalone updater/legacy bridge, PyInstaller build definitions, and release metadata. Release ZIPs contain only allowlisted managed application files; updates verify SHA-256, back up replaced managed files, preserve every unlisted user file, and roll back on failure.

**Tech Stack:** Python 3.10+, Tkinter, urllib, zipfile, hashlib, unittest, PyInstaller, PowerShell, Git, GitHub CLI

---

## File Map

- `exe_update.py`: version and remote-manifest parsing/comparison shared by the launcher and updater.
- `naim_updater.py`: standalone GUI/CLI updater and legacy bridge; safe extraction, managed-file replacement, backup, rollback, and restart.
- `main_executor.pyw`: frozen-only update button and updater process handoff.
- `NAI_Image_Manager.spec`: main portable application build.
- `NAIM_Updater.spec`: standalone updater build.
- `tools/build_exe_release.ps1`: reproducible builds, managed-file manifest generation, privacy scan, ZIP creation, and checksums.
- `release_manifest.json`: stable GitHub-hosted pointer to the current EXE release asset.
- `tests/test_exe_update.py`: version and remote-manifest behavior.
- `tests/test_naim_updater.py`: archive safety, preservation, replacement, rollback, and legacy migration.
- `patch_notes/2026-06-20-v1.1.0-exe-release.md`: GitHub Release notes.

### Task 1: Integrate the Approved Source Branch

- [ ] Merge `codex/gallery-prompt-search-index` into local `master` with a merge commit.
- [ ] Run `python -m unittest tests.test_gallery_prompt_index -v`; expect all tests to pass.
- [ ] Push `master` to `origin/master`.
- [ ] Create and switch to `exe-release` from the updated `master`.

### Task 2: Add Version and Manifest Validation

**Files:**
- Create: `tests/test_exe_update.py`
- Create: `exe_update.py`

- [ ] Write tests proving semantic version comparison, required manifest fields, HTTPS-only asset URLs, GitHub-host validation, 64-character lowercase SHA-256 validation, and newer-version detection.
- [ ] Run `python -m unittest tests.test_exe_update -v`; expect failure because `exe_update` does not exist.
- [ ] Implement `APP_VERSION = "1.1.0"`, `MANIFEST_URL`, `parse_version()`, `validate_manifest()`, `fetch_manifest()`, and `is_update_available()` using only the standard library.
- [ ] Run the focused test module; expect all tests to pass.
- [ ] Commit with `feat: add EXE update manifest client`.

### Task 3: Add Safe Managed-File Updating and Legacy Migration

**Files:**
- Create: `tests/test_naim_updater.py`
- Create: `naim_updater.py`

- [ ] Write tests that reject absolute and `..` ZIP entries, reject checksum mismatches, copy only payload files, preserve `TOTAL_CLASSIFIED` and JSON settings byte-for-byte, remove only files from an old managed manifest, and restore replaced files after an injected copy failure.
- [ ] Run `python -m unittest tests.test_naim_updater -v`; expect failure because `naim_updater` does not exist.
- [ ] Implement `safe_extract()`, `sha256_file()`, `load_managed_files()`, `apply_staged_update()`, and rollback with `tempfile`, `pathlib`, `shutil`, and `zipfile`.
- [ ] Add updater entry modes: no arguments means legacy bridge in the updater's folder; explicit arguments accept install directory, current PID, manifest URL, and restart executable.
- [ ] Add a small Tkinter status window for download, verification, installation, error reporting, and successful restart.
- [ ] Run focused updater tests; expect all tests to pass.
- [ ] Commit with `feat: add preserving EXE updater and migration bridge`.

### Task 4: Add the Frozen-Only Update Button

**Files:**
- Modify: `main_executor.pyw` in `NaiaHyperExecutor.setup_ui()` and adjacent methods.
- Test: `tests/test_exe_update.py`

- [ ] Add a test for resolving `NAIM_Updater.exe` from the frozen application directory and refusing updater launch in source mode.
- [ ] Run the focused test; expect failure before launcher helper implementation.
- [ ] Add `업데이트 확인` beside the log toggle only when `is_frozen_app()` is true.
- [ ] On click, fetch and validate the manifest in a daemon thread, show installed/latest versions and release summary, then launch `NAIM_Updater.exe` after confirmation and close the app.
- [ ] Keep source execution unchanged so `master`/source users continue using `update.bat`.
- [ ] Run focused tests; expect all tests to pass.
- [ ] Commit with `feat: add in-app EXE update button`.

### Task 5: Build and Privacy Automation

**Files:**
- Modify: `NAI_Image_Manager.spec`
- Create: `NAIM_Updater.spec`
- Create: `tools/build_exe_release.ps1`
- Create: `release_manifest.json`

- [ ] Add the updater executable and version module to the main distribution while retaining the existing Lite dependency exclusions.
- [ ] Build the updater as a separate one-file windowed executable with Tkinter and standard-library networking support.
- [ ] In the PowerShell build script, clean only generated release directories, invoke both PyInstaller specs, generate `.naim-managed-files.json`, copy the updater into the portable folder, and ZIP the folder as `NAI_Image_Manager_v1.1.0-exe_windows.zip`.
- [ ] Fail the build if the ZIP contains protected names such as `TOTAL_CLASSIFIED`, `gallery_config.json`, `lab_config.json`, `canvas_saved_setups.json`, or local environment files.
- [ ] Generate SHA-256 and byte size, then write matching values to `release_manifest.json` for tag `v1.1.0-exe`.
- [ ] Run the build script; expect two EXEs, one ZIP, one checksum, and a passing privacy scan.
- [ ] Commit with `build: add reproducible EXE release packaging`.

### Task 6: End-to-End Verification and Release Notes

**Files:**
- Create: `patch_notes/2026-06-20-v1.1.0-exe-release.md`

- [ ] Run all unittest modules; expect zero failures.
- [ ] Run `python -m py_compile exe_update.py naim_updater.py main_executor.pyw`; expect exit code 0.
- [ ] Compare a legacy `v1.0.0-lite` fixture before and after bridge execution; expect protected files and directories to have identical hashes.
- [ ] Simulate a local `1.1.1` update and verify managed-file replacement, old managed-file cleanup, rollback, and restart handoff.
- [ ] Launch the built `NAI_Image_Manager.exe`, verify the main window and update button appear, then close it.
- [ ] Inspect the final ZIP names and assert no protected/private content exists.
- [ ] Write Korean release notes covering the update button, one-time legacy bridge, preservation guarantees, portable ZIP usage, Lite limitations, and verification evidence.
- [ ] Commit with `docs: add v1.1.0 EXE release notes`.

### Task 7: Publish Branch, Tag, and GitHub Release

- [ ] Push `exe-release` to `origin/exe-release`.
- [ ] Confirm `release_manifest.json` contains the exact final asset hash and size, then tag the manifest commit as `v1.1.0-exe`.
- [ ] Push tag `v1.1.0-exe`.
- [ ] Create a GitHub Release targeting `exe-release` with the Korean notes and attach the portable ZIP plus standalone `NAIM_Updater.exe` legacy bridge and checksum file.
- [ ] Query the published release and download URLs; expect the tag, target branch, asset sizes, and checksums to match local artifacts.
- [ ] Confirm the raw `exe-release/release_manifest.json` URL resolves and points to the published release asset.
