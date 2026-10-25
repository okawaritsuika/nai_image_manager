"""Shared legacy tag normalization."""
import re

def clean_tag(raw_tag):
    """프롬프트의 텍스트를 Danbooru DB 표준 포맷으로 완벽 정제합니다."""
    if not raw_tag: return ""
    clean = raw_tag.strip()

    # 1. 가중치 완벽 제거
    clean = re.sub(r'^[-0-9.]+:+\s*', '', clean)
    clean = re.sub(r'\s*:+$', '', clean)
    clean = re.sub(r':[0-9.]+$', '', clean).strip()

    # 2. 강조용 겉 괄호만 벗기기
    while clean.startswith('(') and clean.endswith(')'):
        clean = clean[1:-1].strip()
    while clean.startswith('[') and clean.endswith(']'):
        clean = clean[1:-1].strip()
    while clean.startswith('{') and clean.endswith('}'):
        clean = clean[1:-1].strip()

    # 3. 특수 공백 및 띄어쓰기 언더바 변환
    clean = re.sub(r'\s+', '_', clean).lower().strip()
    return clean
