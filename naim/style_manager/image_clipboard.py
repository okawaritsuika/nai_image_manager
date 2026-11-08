"""Build temporary clipboard images with NovelAI-readable generation metadata."""

import gzip
import io
import json

from PIL import Image, ImageOps
from PIL.PngImagePlugin import PngInfo

from .arca_style_collector import extract_novelai_metadata


def prepare_clipboard_png(image_bytes):
    metadata = extract_novelai_metadata(image_bytes)
    raw = json.loads(metadata["raw_metadata_json"]) if metadata["metadata_status"] == "ok" else None
    with Image.open(io.BytesIO(image_bytes)) as source:
        if getattr(source, "n_frames", 1) != 1:
            raise ValueError("움직이는 이미지는 복사할 수 없습니다.")
        if raw is None and source.format == "PNG":
            return image_bytes
        image = ImageOps.exif_transpose(source).convert("RGBA")

    png_info = PngInfo()
    if raw is not None:
        # NovelAI's public format stores gzip JSON in alpha LSBs, column first.
        # Clipboard PNG re-encoding can discard text chunks, but keeps these bits.
        envelope = {
            "Software": raw.get("software") or "NovelAI",
            "Source": raw.get("source") or raw.get("model") or "",
            "Description": metadata.get("base_prompt") or "",
            "Comment": json.dumps(raw, ensure_ascii=False, separators=(",", ":")),
        }
        compressed = gzip.compress(json.dumps(envelope, ensure_ascii=False).encode("utf-8"), mtime=0)
        payload = b"stealth_pngcomp" + (len(compressed) * 8).to_bytes(4, "big") + compressed
        width, height = image.size
        if len(payload) * 8 > width * height:
            raise ValueError("이미지가 너무 작아 생성 정보를 담아 복사할 수 없습니다. 원본 파일을 사용해 주세요.")
        alpha = bytearray(image.getchannel("A").tobytes())
        for index in range(len(payload) * 8):
            x, y = divmod(index, height)
            offset = y * width + x
            bit = (payload[index // 8] >> (7 - index % 8)) & 1
            alpha[offset] = (alpha[offset] & 0xFE) | bit
        image.putalpha(Image.frombytes("L", image.size, bytes(alpha)))
        for key, value in envelope.items():
            png_info.add_text(key, value)
    output = io.BytesIO()
    image.save(output, "PNG", pnginfo=png_info)
    return output.getvalue()
