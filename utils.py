# -*- coding: utf-8 -*-
import socket
from naim.storage.json_files import read_json, merge_json_object

# Compatibility exports keep existing imports and call signatures working.
from naim.paths import get_app_dir, is_subpath, resolve_safe_path
from naim.tags import clean_tag
from naim.gallery.query import (
    GALLERY_PROMPT_INDEX_SEMANTICS_VERSION,
    select_gallery_prompt_index_paths, normalize_gallery_prompt_search_text,
    _normalize_gallery_prompt_search_term, parse_gallery_prompt_search_query,
    _coerce_gallery_prompt_search_groups, gallery_prompt_search_matches,
    _gallery_prompt_search_candidate_where,
)
from naim.storage.history import HistoryDB

CONFIG_FILE = "gallery_config.json"


def load_config():
    return read_json(CONFIG_FILE, expected_type=dict)


def save_config(config_data):
    try:
        merge_json_object(CONFIG_FILE, config_data)
    except Exception as e:
        print(f"설정 저장 실패: {e}")


def is_port_active(port, host='127.0.0.1'):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex((host, port)) == 0
