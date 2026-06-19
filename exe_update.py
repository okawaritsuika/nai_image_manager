import json
import re
import urllib.request
from urllib.parse import urlsplit


APP_VERSION = "1.1.0"
MANIFEST_URL = (
    "https://raw.githubusercontent.com/okawaritsuika/"
    "nai_image_manager/exe-release/release_manifest.json"
)
_VERSION_PATTERN = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
_SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
_REQUIRED_FIELDS = {
    "version",
    "tag",
    "asset_url",
    "sha256",
    "size",
    "payload_root",
}


def parse_version(value):
    match = _VERSION_PATTERN.fullmatch(str(value or ""))
    if not match:
        raise ValueError("버전은 major.minor.patch 형식이어야 합니다.")
    return tuple(int(part) for part in match.groups())


def validate_manifest(data):
    if not isinstance(data, dict):
        raise ValueError("업데이트 정보 형식이 올바르지 않습니다.")
    missing = sorted(_REQUIRED_FIELDS.difference(data))
    if missing:
        raise ValueError(f"업데이트 정보에 필수 항목이 없습니다: {', '.join(missing)}")

    result = dict(data)
    version = str(result["version"])
    parse_version(version)
    if result.get("schema_version", 1) != 1:
        raise ValueError("지원하지 않는 업데이트 정보 버전입니다.")
    if result["tag"] != f"v{version}-exe":
        raise ValueError("업데이트 태그와 버전이 일치하지 않습니다.")

    asset = urlsplit(str(result["asset_url"]))
    if asset.scheme != "https" or asset.hostname != "github.com":
        raise ValueError("업데이트 파일은 GitHub HTTPS 주소여야 합니다.")
    if not asset.path.lower().endswith(".zip"):
        raise ValueError("업데이트 파일은 ZIP 형식이어야 합니다.")

    checksum = str(result["sha256"])
    if not _SHA256_PATTERN.fullmatch(checksum):
        raise ValueError("업데이트 체크섬이 올바르지 않습니다.")
    result["sha256"] = checksum.lower()

    size = result["size"]
    if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
        raise ValueError("업데이트 파일 크기가 올바르지 않습니다.")
    if result["payload_root"] != "NAI_Image_Manager":
        raise ValueError("업데이트 압축의 루트 폴더가 올바르지 않습니다.")
    result["version"] = version
    result["summary"] = str(result.get("summary", "")).strip()
    return result


def fetch_manifest(url=MANIFEST_URL, timeout=10, opener=urllib.request.urlopen):
    request = urllib.request.Request(url, headers={"User-Agent": "NAI-Image-Manager-Updater"})
    with opener(request, timeout=timeout) as response:
        payload = response.read(1024 * 1024 + 1)
    if len(payload) > 1024 * 1024:
        raise ValueError("업데이트 정보 파일이 너무 큽니다.")
    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("업데이트 정보 JSON을 읽을 수 없습니다.") from exc
    return validate_manifest(data)


def is_update_available(current_version, manifest):
    validated = validate_manifest(manifest)
    return parse_version(validated["version"]) > parse_version(current_version)
