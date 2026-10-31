"""Authenticated API for settings shared with the linked style workspace."""
import math
import secrets
import unicodedata
from pathlib import Path

from flask import jsonify, request

from naim.storage.json_files import merge_json_object, read_json


_DEFAULT_FIELDS = (
    "model",
    "width",
    "height",
    "steps",
    "scale",
    "cfg_rescale",
    "sampler",
    "noise_schedule",
)
_TEXT_FIELDS = {"model", "sampler", "noise_schedule"}
_INTEGER_RANGES = {"width": (64, 4096), "height": (64, 4096), "steps": (1, 50)}
_NUMBER_RANGES = {"scale": (1, 20), "cfg_rescale": (0, 1)}


def _validate_key(value):
    if not isinstance(value, str):
        raise ValueError("invalid key")
    if any(unicodedata.category(character) == "Cc" for character in value):
        raise ValueError("invalid key")
    value = value.strip()
    if len(value) > 8192:
        raise ValueError("invalid key")
    return value


def _validate_defaults(value):
    if not isinstance(value, dict) or any(field not in _DEFAULT_FIELDS for field in value):
        raise ValueError("invalid defaults")

    validated = {}
    for field, setting in value.items():
        if field in _TEXT_FIELDS:
            if not isinstance(setting, str):
                raise ValueError("invalid defaults")
            setting = setting.strip()
            if not setting or len(setting) > 128:
                raise ValueError("invalid defaults")
            validated[field] = setting
            continue

        if field in _INTEGER_RANGES:
            if isinstance(setting, bool) or not isinstance(setting, int):
                raise ValueError("invalid defaults")
            minimum, maximum = _INTEGER_RANGES[field]
            if not minimum <= setting <= maximum:
                raise ValueError("invalid defaults")
            validated[field] = setting
            continue

        if field in _NUMBER_RANGES:
            if isinstance(setting, bool) or not isinstance(setting, (int, float)):
                raise ValueError("invalid defaults")
            try:
                number = float(setting)
            except (OverflowError, ValueError):
                raise ValueError("invalid defaults") from None
            minimum, maximum = _NUMBER_RANGES[field]
            if not math.isfinite(number) or not minimum <= number <= maximum:
                raise ValueError("invalid defaults")
            validated[field] = setting

    return validated


def _settings_payload(config):
    key = config.get("key")
    return {
        "key": key.strip() if isinstance(key, str) else "",
        "defaults": {
            field: config[field]
            for field in _DEFAULT_FIELDS
            if field in config
        },
    }


def register_style_shared_settings(app, config_path, token):
    """Register authenticated GET/PATCH access to the shared lab settings."""
    config_path = Path(config_path)
    expected_token = token if isinstance(token, str) else ""

    @app.after_request
    def style_shared_settings_no_store(response):
        if request.path == "/api/style-workspace/settings":
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.route("/api/style-workspace/settings", methods=["GET", "PATCH"])
    def style_shared_settings():
        origin = request.headers.get("Origin")
        if origin is not None and origin != request.host_url.rstrip("/"):
            return jsonify(error="Origin not allowed"), 403

        authorization = request.headers.get("Authorization", "")
        if not expected_token or not authorization.startswith("Bearer "):
            return jsonify(error="Unauthorized"), 401
        supplied_token = authorization[len("Bearer "):]
        if not secrets.compare_digest(
            expected_token.encode("utf-8"), supplied_token.encode("utf-8")
        ):
            return jsonify(error="Unauthorized"), 401

        if request.method == "PATCH":
            payload = request.get_json(silent=True)
            if not isinstance(payload, dict) or any(field not in ("key", "defaults") for field in payload):
                return jsonify(error="Invalid settings"), 400

            changes = {}
            try:
                if "key" in payload:
                    changes["key"] = _validate_key(payload["key"])
                if "defaults" in payload:
                    changes.update(_validate_defaults(payload["defaults"]))
            except ValueError:
                return jsonify(error="Invalid settings"), 400

            if changes:
                try:
                    config = merge_json_object(config_path, changes)
                except Exception:
                    return jsonify(error="Settings could not be saved"), 500
            else:
                try:
                    config = read_json(config_path, expected_type=dict)
                except Exception:
                    return jsonify(error="Settings could not be read"), 500
        else:
            try:
                config = read_json(config_path, expected_type=dict)
            except Exception:
                return jsonify(error="Settings could not be read"), 500

        return jsonify(_settings_payload(config))

    return None
