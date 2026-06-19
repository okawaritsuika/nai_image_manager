# EXE Self-Update and Release Design

## Goal

Publish a Windows portable EXE distribution that updates from GitHub without a separate server. Keep `master` as the source distribution updated by `update.bat`, and maintain EXE-only behavior on a dedicated `exe-release` branch.

## Branch and Release Model

- Merge `codex/gallery-prompt-search-index` into `master` first and push `master`.
- Create `exe-release` from the updated `master`.
- Keep source-only update behavior on `master`; do not add the EXE updater there.
- Add frozen-runtime packaging and self-update behavior only to `exe-release`.
- Publish EXE tags and GitHub Releases from `exe-release`. Release assets are generated artifacts, not committed binaries.

## Distribution Format

The Windows release is a portable ZIP containing `NAI_Image_Manager.exe`, its runtime dependencies, an updater helper, and managed-file metadata. Users extract the complete folder and run the EXE. The release excludes every local setting, user database override, generated result, imported image, and image-library directory.

The release also contains a one-time legacy update bridge. Existing `v1.0.0-lite` users place or run the bridge in their existing EXE folder. It installs the current managed program files while preserving all existing user data, then leaves the normal in-app updater available for later releases.

## Update Data Flow

1. The EXE update button requests a small version manifest hosted on GitHub.
2. The app compares the manifest version with its embedded version.
3. When an update exists, the app downloads the release ZIP to a temporary staging directory.
4. It verifies the ZIP SHA-256 value from the manifest before extraction.
5. The app starts the updater helper with the install directory, staged payload, current process ID, and restart target, then exits.
6. The helper waits for the app to stop, replaces only managed program files, writes the new managed-file manifest, and restarts the app.

GitHub provides both manifest hosting and release-asset storage; no custom server is required.

## User Data Boundary

The updater never packages, uploads, deletes, or overwrites user-owned content. At minimum, the protected set includes:

- `TOTAL_CLASSIFIED/`, `output/`, `canvas_imports/`, and generated work directories
- `artists.json`, `styles.json`, `gallery_config.json`, `gallery_image_tags.json`
- `lab_config.json`, `quality_presets.json`, `tag_dictionary_user_overrides.json`
- `canvas_saved_setups.json`, `data/tag_categories_ko.json`
- logs, local environment files, and any unrecognized files not listed in the managed-file manifest

The build script uses an explicit allowlist of application assets. A release privacy check fails if a protected filename or directory appears in the ZIP.

## Managed Files and Rollback

Each build generates a manifest listing files owned by the application. During update, the helper backs up files it is about to replace, installs the staged managed files, and leaves all unlisted files untouched. If replacement fails, it restores the backup and reports failure without launching a partially updated application. Backups and staging files are removed after a successful restart handoff.

## User Interface

The frozen EXE launcher adds an `업데이트 확인` button. It reports the installed and available versions, displays a short release summary, asks for confirmation, and then shows download/verification progress. Source execution keeps its existing controls and `update.bat` workflow.

## Errors and Security

- Network, GitHub rate-limit, missing-asset, checksum, extraction, disk-space, and file-lock failures produce actionable Korean messages.
- Downloads use HTTPS and must match the published SHA-256 checksum.
- ZIP entries are validated to prevent path traversal outside the staging directory.
- Update metadata rejects malformed versions and unexpected download hosts.
- The update action is disabled while another update is running.

## Verification

- Unit tests cover version comparison, manifest validation, checksum verification, protected-path handling, safe ZIP extraction, and managed-file replacement/rollback.
- Migration tests begin with a fixture matching the existing `v1.0.0-lite` folder and confirm settings plus `TOTAL_CLASSIFIED` remain byte-for-byte unchanged.
- The PyInstaller build must complete and the built EXE must launch successfully.
- ZIP inspection must prove no protected/private file is present.
- A local two-version update simulation must verify download staging, process handoff, replacement, preservation, rollback, and relaunch behavior.
- Before publishing, validate release notes, asset names, checksums, tag target, and GitHub Release download URLs.

## Release Notes

Release notes will explain the new in-app updater, the one-time migration path for legacy EXE users, preserved user data, portable ZIP usage, Lite limitations, and exact verification performed. They will not include local paths, credentials, personal settings, or user content.
