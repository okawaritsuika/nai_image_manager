# -*- coding: utf-8 -*-
import os, json, shutil, sys, re, concurrent.futures, hashlib, gzip, warnings, time
from PIL import Image
import utils
import datetime
import re

warnings.filterwarnings("ignore")
USE_AI_FILTER = False
USE_GPU_MODE = False # 🌟 추가: GPU 사용 여부를 저장할 전역 변수
nsfw_ai = None

def build_gallery_index_records_from_success(success_records, classified_root):
    records = []
    classified_root_abs = os.path.abspath(classified_root)

    for item in success_records or []:
        if not isinstance(item, dict):
            continue
        final_path = item.get("final_path") or item.get("path")
        if not final_path:
            continue
        try:
            rel_path = os.path.relpath(final_path, classified_root_abs).replace("\\", "/")
        except Exception:
            continue
        if rel_path.startswith(".."):
            continue

        folder_path = os.path.dirname(rel_path).replace("\\", "/")
        file_name = os.path.basename(rel_path)
        mode = "general"
        if rel_path.startswith("_R-18/") or rel_path.startswith("_R-15/"):
            mode = "r18"
        elif rel_path.startswith("_TRASH/"):
            mode = "trash"

        try:
            mtime = os.path.getmtime(final_path)
        except Exception:
            mtime = time.time()

        names = item.get("character_names") or item.get("names") or []
        character_names = json.dumps(list(names), ensure_ascii=False) if isinstance(names, (list, tuple, set)) else str(names or "")
        reasons = item.get("reason") or item.get("nsfw_reasons") or ""
        reason = "<br>".join(str(v) for v in reasons if v) if isinstance(reasons, (list, tuple)) else str(reasons or "")

        records.append({
            "rel_path": rel_path,
            "folder_path": folder_path,
            "file_name": file_name,
            "mode": mode,
            "rating": str(item.get("rating") or ""),
            "brand": str(item.get("brand") or ""),
            "character_names": character_names,
            "is_dakimakura": 1 if item.get("is_dakimakura") else 0,
            "width": item.get("width"),
            "height": item.get("height"),
            "mtime": mtime,
            "reason": reason,
            "gallery_tag": ""
        })

    return records


# 🌟 1. AI 설치 여부 확인
def is_ai_available():
    try:
        import torch
        import transformers
        import torchvision # 🌟 [추가] torchvision 설치 여부도 함께 체크합니다.
        return True
    except ImportError:
        return False


# 🌟 2. AI 모델 로딩 (호환성 에러 해결 버전)
# image_logic.py 내부

def get_nsfw_model(): # 🌟 인자를 제거하고 전역 변수를 참조하게 변경
    global nsfw_ai, USE_GPU_MODE
    if nsfw_ai is not None:
        current_device = "gpu" if nsfw_ai.device.type == "cuda" else "cpu"
        # 🌟 현재 엔진과 설정값이 다를 때만 초기화
        if USE_GPU_MODE != (current_device == "gpu"): nsfw_ai = None

    if nsfw_ai is None:
        if not is_ai_available(): return None
        try:
            from transformers import pipeline, AutoModelForImageClassification, ViTImageProcessor
            import torch

            # 🌟 CUDA 가속 사용 가능 여부와 사용자 선택 확인
            device = 0 if (USE_GPU_MODE and torch.cuda.is_available()) else -1
            if device == 0:
                print("🚀 그래픽 가속(GPU) 모드가 활성화되었습니다.")
            else:
                print("💻 CPU 연산 모드로 작동합니다.")

            torch.set_num_threads(1)
            model_id = "LukeJacob2023/nsfw-image-detector"
            processor = ViTImageProcessor.from_pretrained(model_id)
            model = AutoModelForImageClassification.from_pretrained(model_id)

            nsfw_ai = pipeline("image-classification", model=model, image_processor=processor, device=device)
            print("✅ AI 모델 로딩 완료!")
        except Exception as e:
            print(f"⚠️ AI 로딩 실패: {e}")
            return None
    return nsfw_ai


def load_ai_model():
    get_nsfw_model()  # 동일 로직 사용


# 🌟 1. 사용자님의 스텔스 데이터 해독기 (함수 밖 독립적인 헬퍼 함수로 추가)
def strip_negative_weighted_prompt_blocks(text):
    """NSFW 키워드 판독용: -3::nude:: 같은 마이너스 가중치 프롬프트 블록은 무시한다."""
    if not text:
        return ""
    return re.sub(
        r'(?<![\w.])-\d+(?:\.\d+)?::.*?::',
        ' ',
        str(text),
        flags=re.DOTALL
    )

def has_ignore_marker(folder_path):
    return os.path.isfile(os.path.join(folder_path, ".ignore"))


def prune_ignored_dirs(root, dirs):
    """
    os.walk용: .ignore 파일이 있는 폴더는 하위 탐색에서 제외한다.
    root 자체에 .ignore가 있으면 호출부에서 continue 처리한다.
    """
    kept = []

    for dirname in dirs:
        full_dir = os.path.join(root, dirname)

        if has_ignore_marker(full_dir):
            continue

        kept.append(dirname)

    dirs[:] = kept

def read_stealth_info(image):
    if image.mode != 'RGBA':
        return None

    # 🌟 [초고속 해독] 픽셀을 2중 루프로 일일이 순회하는 대신 C언어 기반의 바이트 배열로 한 번에 추출 (수백 배 가속)
    try:
        width, height = image.size
        alpha_bytes = image.getchannel('A').tobytes()
    except Exception:
        return None

    # NAI 스텔스 데이터는 세로(y) 방향으로 먼저 기록되므로, 1차원 배열에서 정확한 위치를 집어내는 수학 공식 적용
    def get_bit(idx):
        x = idx // height
        y = idx % height
        return str(alpha_bytes[y * width + x] & 1)

    try:
        # 1. 시그니처 120비트(15바이트) 확인
        sig_bits = "".join(get_bit(i) for i in range(120))
        decoded_sig = bytearray(int(sig_bits[i:i + 8], 2) for i in range(0, 120, 8)).decode('utf-8', errors='ignore')

        if decoded_sig != 'stealth_pngcomp':
            return None

        # 2. 파라미터 길이 32비트(4바이트) 확인
        len_bits = "".join(get_bit(i) for i in range(120, 152))
        param_len = int(len_bits, 2)

        # 3. 실제 파라미터 내용 추출 (전체 이미지 순회 없이 필요한 만큼만 정확하게 슬라이싱)
        data_bits = "".join(get_bit(i) for i in range(152, 152 + param_len))
        byte_data = bytearray(int(data_bits[i:i + 8], 2) for i in range(0, param_len, 8))

        return gzip.decompress(bytes(byte_data)).decode('utf-8')
    except Exception:
        return None


# 🌟 2. 메인 작업자 함수
# [95라인 부근] 함수 인자에 override_cache를 추가합니다.
def analyze_file_worker(full_path, override_cache=None, ai_threshold=0.9998, skip_nsfw=False, allow_ai=True, mark_ai_pending=False):
    file_hash = None
    try:
        size = os.path.getsize(full_path)
        hasher = hashlib.md5()
        hasher.update(str(size).encode('utf-8'))
        with open(full_path, 'rb') as f:
            hasher.update(f.read(102400))
        file_hash = hasher.hexdigest()
    except Exception:
        file_hash = None

    # 🌟 [추가] 수동 분류 여부 미리 확인
    manual_res = override_cache.get(file_hash) if override_cache else None

    is_nsfw = False
    char_tags = []
    base_tags = []
    nsfw_reasons = []
    ai_pending = False
    meta_source = "none"

    def make_result(rating_value=None):
        result = (
            full_path,
            file_hash,
            char_tags,
            base_tags,
            (2 if is_nsfw else 0) if rating_value is None else rating_value,
            nsfw_reasons
        )
        if mark_ai_pending:
            return result + (ai_pending, meta_source)
        return result


    # 🌟 [수정 1] 캐시 적중 시 수동 분류 꼬리표 달아주기 (문구 통일)
    if override_cache is not None and full_path in override_cache:
        is_nsfw = override_cache[full_path]
        label = "R-19로 지정됨" if is_nsfw == 2 else "일반짤로 지정됨"
        nsfw_reasons.append(f"✅ [수동] 사용자 분류 ({label})")
        return make_result(2 if is_nsfw else 0)

    try:
        with Image.open(full_path) as img:
            # --- (생략 없이 기존 메타데이터 추출 로직 그대로 유지) ---
            raw_meta = ""
            meta_source = "none"

            # 1) 빠른 텍스트 메타데이터를 먼저 확인한다.
            if "parameters" in img.info:
                raw_meta = img.info["parameters"]
                meta_source = "parameters"

            elif "Comment" in img.info:
                raw_meta = img.info["Comment"]
                if isinstance(raw_meta, bytes):
                    raw_meta = raw_meta.decode('utf-8', 'ignore')
                meta_source = "comment"

            elif hasattr(img, 'getexif'):
                exif = img.getexif()
                if exif and 37510 in exif:
                    user_comment = exif[37510]
                    if isinstance(user_comment, bytes):
                        raw_meta = user_comment.decode('utf-8', errors='ignore').replace('\x00', '')
                        if raw_meta.startswith('UNICODE') or raw_meta.startswith('ASCII'):
                            raw_meta = raw_meta[8:]
                    else:
                        raw_meta = str(user_comment)
                    if raw_meta:
                        meta_source = "exif"

            # 2) 텍스트 메타가 없을 때만 무거운 stealth 해독을 시도한다.
            if not raw_meta:
                stealth_data = read_stealth_info(img)
                if stealth_data:
                    raw_meta = stealth_data
                    meta_source = "stealth"

            if not raw_meta:
                raw_meta = "{}"
                meta_source = "none"

            meta = {}
            if raw_meta.strip().startswith('{'):
                try:
                    meta = json.loads(raw_meta)
                    if "Comment" in meta and isinstance(meta["Comment"], str) and meta["Comment"].strip().startswith(
                            '{'):
                        meta = json.loads(meta["Comment"])
                except json.JSONDecodeError:
                    meta = {}
            else:
                prompt_part = raw_meta.split("Negative prompt:")[0]
                if "\n" in prompt_part: prompt_part = prompt_part.split("\n")[0]
                meta = {"prompt": prompt_part}

            nai_rating = meta.get("rating", "unknown")
            base_p = str(meta.get("prompt", "")).lower()
            v4_p = meta.get("v4_prompt", {})
            v4_b = str(v4_p.get("caption", {}).get("base_caption", "")).lower()
            char_caps = v4_p.get("caption", {}).get("char_captions", [])
            char_nsfw_texts = []
            if isinstance(char_caps, list):
                for c in char_caps:
                    if isinstance(c, dict):
                        char_caption_text = str(c.get("char_caption", ""))
                        char_nsfw_texts.append(char_caption_text)
                        char_tags.extend(char_caption_text.split(","))
            if base_p: base_tags.extend(base_p.split(","))
            if v4_b: base_tags.extend(v4_b.split(","))

            nsfw_base_p = strip_negative_weighted_prompt_blocks(base_p).lower()
            nsfw_v4_b = strip_negative_weighted_prompt_blocks(v4_b).lower()
            nsfw_char_text = strip_negative_weighted_prompt_blocks(" ".join(char_nsfw_texts)).lower()
            combined_text = nsfw_base_p + " " + nsfw_v4_b + " " + nsfw_char_text
            r18_keywords = [r'\bsex\b', r'\bpussy\b', r'\bpenis\b', r'\bareolas?\b', r'\bpenetration\b', r'\bnsfw\b',
                            r'\bnude\b']
            pat18 = re.compile('|'.join(r18_keywords))

            # 🌟 [수정된 판독 로직]
            # 1단계: 수동 분류 이력이 있다면 최우선 적용하고 종료
            if manual_res is not None:
                is_nsfw = (manual_res == 2)
                label = "R-19로 지정됨" if is_nsfw else "일반짤로 지정됨"
                nsfw_reasons.append(f"✅ [수동] 사용자 분류 ({label})")

            # 2단계: 수동 분류가 없을 때만 기존 판독 절차 진행
            else:
                if skip_nsfw:
                    pass  # is_nsfw는 초기값 False로 유지됨
                elif nai_rating == 'e':
                    is_nsfw = True
                    nsfw_reasons.append("📝 [NAI 등급] 메타데이터상 확실한 야짤(Explicit)")
                elif pat18.search(combined_text):
                    is_nsfw = True
                    match_word = pat18.search(combined_text).group()
                    nsfw_reasons.append(f"[키워드] '{match_word}' 단어 발견!")
                # 🌟 [수정 포인트 2] 대망의 AI 판독 블록 간소화 (소수점 5자리 반올림 적용)
                elif USE_AI_FILTER:
                    if not allow_ai:
                        ai_pending = True
                    else:
                        model = get_nsfw_model()
                        if model:
                            ai_img = img.convert('RGB').resize((224, 224))
                            results = model(ai_img)
                            hentai_score = next((r['score'] for r in results if r['label'] == 'hentai'), 0)
                            porn_score = next((r['score'] for r in results if r['label'] == 'porn'), 0)
                            max_s = max(hentai_score, porn_score)

                            nsfw_reasons.append(f"[AI] 수위 감지 ({max_s * 100:.3f}%)")

                            if round(max_s, 5) >= ai_threshold:
                                is_nsfw = True


    except Exception as e:
        unreadable_reason = f"__UNREADABLE__:{e}"
        result = (full_path, file_hash, [], [], -999, [unreadable_reason])
        if mark_ai_pending:
            return result + (False, meta_source)
        return result

    return make_result()

def ai_classify_pending_result(base_result, ai_threshold=0.9998):
    full_path, file_hash, char_tags, base_tags, rating, nsfw_reasons = base_result
    nsfw_reasons = list(nsfw_reasons or [])

    is_nsfw = rating == 2

    try:
        model = get_nsfw_model()
        if model:
            with Image.open(full_path) as img:
                ai_img = img.convert('RGB').resize((224, 224))

            results = model(ai_img)
            hentai_score = next((r['score'] for r in results if r['label'] == 'hentai'), 0)
            porn_score = next((r['score'] for r in results if r['label'] == 'porn'), 0)
            max_s = max(hentai_score, porn_score)

            nsfw_reasons.append(f"[AI] 수위 감지 ({max_s * 100:.3f}%)")

            if round(max_s, 5) >= ai_threshold:
                is_nsfw = True

    except Exception as e:
        nsfw_reasons.append(f"⚠️ [AI] 판정 실패: {e}")

    return (
        full_path,
        file_hash,
        char_tags,
        base_tags,
        2 if is_nsfw else 0,
        nsfw_reasons
    )

def file_io_worker(src, dest, method, nsfw_reasons=None):  # 🌟 인자 추가
    try:
        if method == "copy":
            shutil.copy2(src, dest)
        else:
            try:
                os.replace(src, dest)
            except OSError:
                shutil.move(src, dest)

        # 🌟 [추가] 야짤 사유가 있으면 이미지 옆에 .txt 파일로 저장
        if nsfw_reasons:
            txt_dest = os.path.splitext(dest)[0] + ".txt"
            try:
                with open(txt_dest, "w", encoding="utf-8") as f:
                    f.write("<br>".join(nsfw_reasons))
            except Exception as e:
                print(f"⚠️ 사유 텍스트 저장 실패: {txt_dest} | {e}")
        return True
    except Exception:
        return False


# 🌟 [추가] 멀티프로세싱 가속을 위해 전역 범위로 이동된 개별 이미지 처리 함수
def _worker_process_image(file_info):
    full_path, rel_path = file_info
    raw_meta = ""
    try:
        # 🌟 PIL.Image.open은 lazy 모드라 실제 데이터를 읽기 전까지는 빠릅니다.
        with Image.open(full_path) as img:
            # Stealth Info는 픽셀 데이터를 직접 읽어야 하므로 CPU 부하가 높습니다.
            stealth_data = read_stealth_info(img)
            if stealth_data:
                raw_meta = stealth_data
            else:
                if "parameters" in img.info:
                    raw_meta = img.info["parameters"]
                elif "Comment" in img.info:
                    raw_meta = img.info["Comment"]
                    if isinstance(raw_meta, bytes): raw_meta = raw_meta.decode('utf-8', 'ignore')
    except:
        pass

    extracted_styles = []
    if raw_meta:
        # 정규식 컴파일 (워커 내부에 캐싱됨)
        import re
        p_artist = re.compile(r'(?:\d*::)?artist:\s*([^,\]\}\|\n\r\t\\]+)', re.IGNORECASE)
        p_weighted_block = re.compile(r'((?:\d*::)?artist:.*?(?:\d*::)?artist\s*collaboration(?:\]|::|\b)?)',
                                      re.IGNORECASE | re.DOTALL)

        # 1. 가중치 블록 추출
        for w_match in p_weighted_block.findall(raw_meta):
            block = w_match.strip().replace('\\n', '\n')
            if len(block) > 5: extracted_styles.append(f"[가중치] {block}")

        # 2. 조합형 추출
        artists = set()
        safe_meta = raw_meta.replace('\\n', ' ').replace('\n', ' ').replace('\\r', ' ').replace('\r', ' ').replace(
            '\\t', ' ')
        for m in p_artist.findall(safe_meta):
            temp_name = m.replace('_', ' ').strip().lower()
            name = "_".join(temp_name.split()).replace('::', '').strip()
            if name.endswith(':'): name = name[:-1].strip()
            if len(name) > 1 and name not in {'1', '3', 'collaboration', 'artist_collaboration', 'multiple_artists'}:
                artists.add(f"artist:{name}")
        if artists:
            extracted_styles.append(", ".join(sorted(list(artists))))

    return rel_path, extracted_styles


# 🌟 [수정] 멀티프로세싱 호환을 위해 작업을 전역 함수로 분리하고 로직을 정교화함
def _worker_art_scan(file_info):
    full_path, rel_path = file_info
    raw_meta = ""
    try:
        with Image.open(full_path) as img:
            stealth_data = read_stealth_info(img)
            if stealth_data:
                raw_meta = stealth_data
            else:
                if "parameters" in img.info:
                    raw_meta = img.info["parameters"]
                elif "Comment" in img.info:
                    raw_meta = img.info["Comment"]
                    if isinstance(raw_meta, bytes): raw_meta = raw_meta.decode('utf-8', 'ignore')
    except:
        return None, []

    if not raw_meta: return rel_path, []

    # 🌟 [정밀 수정] JSON 내부의 base_caption 섹션만 완벽하게 타겟팅하는 폴백 로직 강화
    target_text = raw_meta
    if "base_caption" in raw_meta:
        try:
            # 1. 표준 JSON 파싱 시도 (텍스트 전체가 JSON인 경우)
            if raw_meta.strip().startswith('{'):
                m_data = json.loads(raw_meta)
                v4_p = m_data.get("v4_prompt", {})
                if isinstance(v4_p, dict):
                    target_text = v4_p.get("caption", {}).get("base_caption", "")

            # 2. 파싱 실패 시 정규식으로 "base_caption" 따옴표 내부 값만 강제 추출 (JSON 이스케이프 지원)
            if not target_text or target_text == raw_meta:
                cap_match = re.search(r'"base_caption":\s*"(.+?)(?<!\\)"', raw_meta)
                if cap_match:
                    target_text = cap_match.group(1).encode().decode('unicode_escape', errors='ignore')
        except:
            pass

    if not target_text: return rel_path, []

    # 🌟 [개선] 가중치 블록 중지 키워드에 JSON 따옴표(\") 및 이스케이프 문자 대응 보강
    # JSON 내부에 정보가 들어있을 경우 steps나 seed 앞에 붙은 따옴표까지 인식하여 정확히 끊어냅니다.
    extracted_styles = []

    artist_tokens = []
    artists = set()

    safe_text = target_text.replace('\\\\n', '\n').replace('\\n', '\n')

    weighted_artist_pattern = re.compile(
        r'([-+]?\d+(?:\.\d+)?)::\s*artist:\s*(.*?)(?=::)',
        re.IGNORECASE | re.DOTALL
    )

    weighted_spans = []

    for match in weighted_artist_pattern.finditer(safe_text):
        raw_weight = match.group(1)
        raw_name = match.group(2)

        name = raw_name.strip()
        name = name.strip(',')
        name = name.strip()
        name = re.sub(r'\s+', ' ', name)

        name_key = name.replace('_', ' ').lower().strip()
        if name_key in {
            '',
            '1',
            '3',
            'collaboration',
            'artist collaboration',
            'artist_collaboration',
            'multiple artists',
            'solo artist',
            'artist request'
        }:
            continue

        artist_tokens.append(f"{raw_weight}::artist:{name}::")
        artists.add(f"artist:{'_'.join(name.lower().split())}")
        weighted_spans.append(match.span())

    if artist_tokens:
        extracted_styles.append(f"[가중치] {', '.join(artist_tokens)}")

    remainder_parts = []
    last = 0

    for start, end in weighted_spans:
        remainder_parts.append(safe_text[last:start])
        remainder_parts.append(' ')
        last = end

    remainder_parts.append(safe_text[last:])
    remainder_text = ''.join(remainder_parts)

    plain_artist_pattern = re.compile(
        r'artist:\s*([^,\]\}\|\n\r\t\\:]+)',
        re.IGNORECASE
    )

    for match in plain_artist_pattern.finditer(remainder_text):
        name = match.group(1).replace('_', ' ').strip().lower()
        name = "_".join(name.split())

        if len(name) > 1 and name not in {
            '1',
            '3',
            'collaboration',
            'artist_collaboration',
            'multiple_artists',
            'solo_artist',
            'artist_request'
        }:
            artists.add(f"artist:{name}")

    if artists:
        extracted_styles.append(f"[조합형] {', '.join(sorted(artists))}")

    return rel_path, extracted_styles


def scan_and_extract_artists(classified_root, clear_db=False, log_func=print, stop_check=None):
    import concurrent.futures
    import json
    import re
    log_func("🎨 [그림체 정밀 스캔] 전체 폴더의 아티스트 정보를 수집합니다...")
    log_func("🔗 [설정] 조합형 및 가중치(원본) 그림체 투트랙 수집 모드가 활성화되었습니다.")
    db = utils.HistoryDB()
    try:
        with db.conn:
            db.conn.execute('''
                CREATE TABLE IF NOT EXISTS artist_scanned_files (
                    path TEXT PRIMARY KEY
                )
            ''')
            if clear_db:
                log_func("🧹 기존 그림체 데이터를 모두 비우고 새로운 기준으로 스캔을 준비합니다.")
                db.conn.execute("DELETE FROM image_artists")
                db.conn.execute("DELETE FROM art_styles")
                db.conn.execute("DELETE FROM artist_scanned_files")

            cursor = db.conn.cursor()
            cursor.execute("SELECT path FROM artist_scanned_files")
            scanned_paths = set(row[0] for row in cursor.fetchall())

        all_files = []
        all_files = []
        ignored_folder_count = 0

        for root_dir, dirs, files in os.walk(classified_root):
            if has_ignore_marker(root_dir):
                dirs[:] = []
                ignored_folder_count += 1
                continue

            prune_ignored_dirs(root_dir, dirs)

            if "_TRASH" in root_dir:
                dirs[:] = []
                continue

            for f in files:
                if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
                    full_path = os.path.join(root_dir, f)
                    rel_path = os.path.relpath(full_path, classified_root).replace('\\', '/')
                    if rel_path not in scanned_paths:
                        all_files.append((full_path, rel_path))

        if ignored_folder_count:
            log_func(f"🚫 .ignore 폴더 {ignored_folder_count}개를 그림체 스캔에서 제외했습니다.")

        total = len(all_files)
        if total == 0:
            log_func("✨ 새로 스캔할 이미지가 없습니다. (모두 이미 수집됨)")
            return

        p_std = re.compile(r'(?:[\d\.]*::)?artist:\s*([^,\]\}\|\n\r\t\\]+)', re.IGNORECASE)

        def process_file(file_info):
            if stop_check and stop_check():
                return None, []

            full_path, rel_path = file_info
            raw_meta = ""
            try:
                with Image.open(full_path) as img:
                    stealth_data = read_stealth_info(img)
                    if stealth_data:
                        raw_meta = stealth_data
                    else:
                        if "parameters" in img.info:
                            raw_meta = img.info["parameters"]
                        elif "Comment" in img.info:
                            raw_meta = img.info["Comment"]
                            if isinstance(raw_meta, bytes):
                                raw_meta = raw_meta.decode('utf-8', 'ignore')
                        elif hasattr(img, 'getexif'):
                            exif = img.getexif()
                            if exif and 37510 in exif:
                                user_comment = exif[37510]
                                if isinstance(user_comment, bytes):
                                    raw_meta = user_comment.decode('utf-8', errors='ignore').replace('\x00', '')
                                    if raw_meta.startswith('UNICODE') or raw_meta.startswith('ASCII'):
                                        raw_meta = raw_meta[8:]
                                else:
                                    raw_meta = str(user_comment)
            except Exception:
                return None, []

            if not raw_meta: return rel_path, []

            target_text = ""
            try:
                if raw_meta.strip().startswith('{'):
                    m_data = json.loads(raw_meta)
                    if "v4_prompt" in m_data and isinstance(m_data["v4_prompt"], dict):
                        target_text = m_data["v4_prompt"].get("caption", {}).get("base_caption", "")

                    if not target_text:
                        target_text = m_data.get("prompt", "")

                if not target_text and "base_caption" in raw_meta:
                    safe_meta_for_regex = raw_meta.replace('\\"', '"')
                    cap_match = re.search(r'"base_caption"\s*:\s*"((?:\\.|[^"\\])*)"', safe_meta_for_regex, re.DOTALL)
                    if cap_match:
                        target_text = cap_match.group(1).encode().decode('unicode_escape', errors='ignore')
            except Exception:
                pass

            if not target_text:
                target_text = raw_meta

            split_pattern = r'\\?"v4_negative_prompt\\?"|Negative prompt:|\\?"uc\\?"\s*:'
            target_text = re.split(split_pattern, target_text, flags=re.IGNORECASE)[0]

            extracted_styles = []

            artist_tokens = []
            artist_names = set()

            safe_artist_text = target_text.replace('\\\\n', '\n').replace('\\n', '\n')

            # 1) 가중치 artist 토큰 직접 수집
            # 예:
            # 1.2::artist:migolu::
            # 1.13::artist:tarou2, ::
            # 0.77::artist:raika9 ::
            weighted_artist_pattern = re.compile(
                r'([-+]?\d+(?:\.\d+)?)::\s*artist:\s*(.*?)(?=::)',
                re.IGNORECASE | re.DOTALL
            )

            weighted_spans = []

            for match in weighted_artist_pattern.finditer(safe_artist_text):
                raw_weight = match.group(1)
                raw_name = match.group(2)

                name = raw_name.strip()
                name = name.strip(',')
                name = name.strip()
                name = re.sub(r'\s+', ' ', name)

                # artist collaboration 같은 품질/협업 토큰은 작가로 저장하지 않는다.
                name_key = name.replace('_', ' ').lower().strip()
                if name_key in {
                    '',
                    '1',
                    '3',
                    'collaboration',
                    'artist collaboration',
                    'artist_collaboration',
                    'multiple artists',
                    'solo artist',
                    'artist request'
                }:
                    continue

                token = f"{raw_weight}::artist:{name}::"
                artist_tokens.append(token)
                artist_names.add(f"artist:{'_'.join(name.lower().split())}")
                weighted_spans.append(match.span())

            if artist_tokens:
                extracted_styles.append(f"[가중치] {', '.join(artist_tokens)}")

            # 2) 가중치 토큰을 제외한 나머지에서 일반 artist:xxx도 수집
            # 예: artist:foo, artist:bar
            remainder_parts = []
            last = 0

            for start, end in weighted_spans:
                remainder_parts.append(safe_artist_text[last:start])
                remainder_parts.append(' ')
                last = end

            remainder_parts.append(safe_artist_text[last:])
            remainder_text = ''.join(remainder_parts)

            plain_artist_pattern = re.compile(
                r'artist:\s*([^,\]\}\|\n\r\t\\:]+)',
                re.IGNORECASE
            )

            for match in plain_artist_pattern.finditer(remainder_text):
                name = match.group(1).strip()
                name = name.strip(',')
                name = name.strip()
                name = re.sub(r'\s+', '_', name).lower()

                if name in {
                    '',
                    '1',
                    '3',
                    'collaboration',
                    'artist_collaboration',
                    'artist_request',
                    'multiple_artists',
                    'solo_artist'
                }:
                    continue

                artist_names.add(f"artist:{name}")

            if artist_names:
                joined_artists = ", ".join(sorted(artist_names))

                # 가중치 블록이 이미 있으면 조합형은 보조 정보로만 저장한다.
                if joined_artists and not any(item.startswith("[조합형]") for item in extracted_styles):
                    extracted_styles.append(f"[조합형] {joined_artists}")

            artists = set()
            safe_text = target_text.replace('\\n', ' ').replace('\n', ' ')
            for m in p_std.finditer(safe_text):
                name = m.group(1).replace('_', ' ').strip().lower().replace('::', '')
                name = "_".join(name.split())
                if len(name) > 1 and name not in {'1', '3', 'collaboration', 'artist_collaboration', 'multiple_artists',
                                                  'none'}:
                    artists.add(f"artist:{name}")

            if artists:
                valid_artists = sorted(list(artists))
                style_str = ", ".join(valid_artists)
                extracted_styles.append(style_str)

            return rel_path, extracted_styles

        records = []
        unique_artists = set()
        new_scanned_files = []

        def save_progress_to_db():
            if not new_scanned_files: return
            with db.conn:
                db.conn.executemany("INSERT OR IGNORE INTO image_artists (path, artist_name) VALUES (?, ?)", records)
                db.conn.executemany("INSERT OR IGNORE INTO artist_scanned_files (path) VALUES (?)", new_scanned_files)
                db.conn.executemany("INSERT OR IGNORE INTO art_styles (artist_name, name_kr) VALUES (?, '')",
                                    [(a,) for a in unique_artists])
            records.clear()
            unique_artists.clear()
            new_scanned_files.clear()

        thread_count = min(32, (os.cpu_count() or 4) * 4)
        log_func(f"🚀 초광속 스레드 엔진({thread_count}개) 가동! 총 {total}개의 이미지를 분석합니다.")

        processed_count = 0
        is_stopped = False

        with concurrent.futures.ThreadPoolExecutor(max_workers=thread_count) as executor:
            future_to_file = {executor.submit(process_file, fi): fi for fi in all_files}
            for future in concurrent.futures.as_completed(future_to_file):
                if stop_check and stop_check():
                    if not is_stopped:
                        log_func("🛑 스캔 정지 요청 감지! 대기 작업을 취소합니다...")
                        for f in future_to_file: f.cancel()
                        is_stopped = True
                    break
                try:
                    rel_path, artists = future.result()
                    if rel_path is None: continue
                    new_scanned_files.append((rel_path,))
                    for a in artists:
                        records.append((rel_path, a))
                        unique_artists.add(a)
                    processed_count += 1
                    if processed_count % 1000 == 0 or processed_count == total:
                        log_func(
                            f"   ▶ 스캔 진행 중: {processed_count} / {total} 장 ({(processed_count / total) * 100:.1f}%)")
                    if processed_count % 5000 == 0: save_progress_to_db()
                except Exception as inner_err:
                    log_func(f"⚠️ 개별 파일 분석 오류 무시: {inner_err}")

        if new_scanned_files: save_progress_to_db()
        log_func("✨ 작업이 완료되었습니다. (저장 완료)" if not is_stopped else "🛑 작업 중지 및 저장 완료.")
    except Exception as e:
        log_func(f"❌ 오류: {e}")
    finally:
        db.close()

def process(source_path, method="copy", is_fast=True, reorg_mode=False, use_ai=False, use_gpu=True, max_workers=None, normal_workers=None, ai_workers=None, ai_threshold=0.9998, log_func=print, stop_check=None, progress_update=None, skip_nsfw=False, skip_char_id=False, reorg_target=None):
    global USE_AI_FILTER, USE_GPU_MODE
    USE_AI_FILTER = use_ai
    USE_GPU_MODE = use_gpu  # 🌟 사용자 선택값을 전역 변수에 저장
    if USE_AI_FILTER:
        get_nsfw_model()
    if getattr(sys, 'frozen', False):
        current_dir = os.path.dirname(sys.executable)
    else:
        current_dir = os.path.dirname(os.path.abspath(sys.argv[0]))

    classified_root = os.path.join(current_dir, "TOTAL_CLASSIFIED")
    os.makedirs(classified_root, exist_ok=True)

    classified_root_abs = os.path.abspath(classified_root)
    trash_root_abs = os.path.abspath(os.path.join(classified_root, "_TRASH"))

    # 🌟 [수정] 재정렬 모드일 때는 타겟이 지정되었다면 그곳을 소스로, 아니면 전체를 소스로 설정
    if reorg_mode:
        source_path = reorg_target if reorg_target else classified_root
        method = "move"
        is_fast = False
        action_text = "부분 재정렬(이동)" if reorg_target else "전면 재정렬(이동)"
    else:
        action_text = "복사" if method == "copy" else "이동"

    stats = {
        "total_scanned": 0, "success": 0, "skipped_db": 0,
        "skipped_duplicate": 0, "error": 0, "unreadable": 0
    }

    log_func(f"🚀 {action_text} 작업 시작 (단보루 DB 메모리 전체 로딩 + 가짜 캐릭터 차단 모드)")
    log_func("-" * 50)

    db = utils.HistoryDB()
    # 🌟 수동 분류 오버라이드(사용자 확정 선택) 캐시 로드
    OVERRIDE_CACHE = {}
    try:
        db.conn.execute("CREATE TABLE IF NOT EXISTS manual_overrides (file_hash TEXT PRIMARY KEY, is_nsfw INTEGER)")
        cur = db.conn.cursor()
        cur.execute("SELECT file_hash, is_nsfw FROM manual_overrides")
        for row in cur.fetchall():
            OVERRIDE_CACHE[row[0]] = int(row[1])  # bool에서 int로 변경!
    except Exception as e:
        log_func(f"⚠️ 수동 분류 캐시 로드 실패: {e}")
    ignore_words = {"girl", "girls", "1girl", "2girls", "3girls", "4girls", "5girls",
                    "boy", "boys", "1boy", "2boys", "solo", "group", "unknown_char", "comic", "no_metadata"}

    DANBOORU_RAM_CACHE = set()
    try:
        log_func("⚡ 단보루 DB를 메모리(RAM)에 로드 중입니다...")
        if db.danbooru_conn:
            cur = db.danbooru_conn.cursor()
            cur.execute("SELECT name FROM characters")
            for row in cur.fetchall():
                DANBOORU_RAM_CACHE.add(row[0].strip().lower())
    except Exception as e:
        log_func(f"⚠️ 메모리 로드 중 오류: {e}")

    processed_hashes = set()
    if is_fast and not reorg_mode:
        log_func("⚡ 이전 이력 DB를 메모리에 로드 중입니다...")
        try:
            cur = db.conn.cursor()
            cur.execute("SELECT file_hash FROM processed_files")
            processed_hashes = {row[0] for row in cur.fetchall()}
        except Exception as e:
            log_func(f"⚠️ 이전 이력 캐시 로드 실패: {e}")

    all_images = []
    ignored_folder_count = 0

    for root, dirs, files in os.walk(source_path):
        # .ignore가 있는 폴더는 그 폴더와 하위 폴더 전체를 분류/재정렬 대상에서 제외
        if has_ignore_marker(root):
            dirs[:] = []
            ignored_folder_count += 1
            continue

        prune_ignored_dirs(root, dirs)

        # 🌟 재정렬 모드일 때는 TOTAL_CLASSIFIED 내부를 허용하되 _TRASH는 무시합니다.
        root_abs = os.path.abspath(root)

        # 일반 분류 모드에서는 "프로젝트의 실제 결과 폴더"만 제외한다.
        # 폴더 이름이 우연히 TOTAL_CLASSIFIED인 외부 원본 폴더는 제외하면 안 된다.
        if not reorg_mode and utils.is_subpath(root_abs, classified_root_abs):
            dirs[:] = []
            continue

        # 휴지통은 실제 프로젝트 휴지통 경로만 제외한다.
        if utils.is_subpath(root_abs, trash_root_abs):
            dirs[:] = []
            continue

        for f in files:
            if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
                all_images.append(os.path.abspath(os.path.join(root, f)))

    if ignored_folder_count:
        log_func(f"🚫 .ignore 폴더 {ignored_folder_count}개를 분류 대상에서 제외했습니다.")

    total_images = len(all_images)
    stats["total_scanned"] = total_images
    if not all_images:
        log_func("탐색된 이미지가 없습니다.")
        db.close()
        return

    job_started_at = time.perf_counter()

    def format_elapsed(seconds):
        seconds = float(seconds or 0)
        minutes = int(seconds // 60)
        remain = seconds - minutes * 60
        if minutes:
            return f"{minutes}분 {remain:.1f}초"
        return f"{remain:.1f}초"

    def emit_progress(current, total, phase="진행 중"):
        if not progress_update:
            return
        try:
            progress_update(current, total, phase)
        except TypeError:
            progress_update(current, total)

    cpu_count = os.cpu_count() or 4

    def clamp_worker_count(value, fallback, upper=64):
        try:
            value = int(value)
        except Exception:
            value = fallback
        return max(1, min(upper, value))

    # 기존 max_workers 인자는 하위 호환용으로 일반 스레드에 매핑한다.
    if normal_workers is None:
        if max_workers:
            normal_workers = max_workers
        elif USE_AI_FILTER:
            normal_workers = min(32, max(4, cpu_count * 2))
        else:
            normal_workers = min(32, cpu_count * 2)

    if ai_workers is None:
        if max_workers and USE_AI_FILTER:
            ai_workers = min(4, max_workers)
        elif USE_AI_FILTER:
            ai_workers = min(4, max(1, cpu_count // 2))
        else:
            ai_workers = 1

    normal_worker_count = clamp_worker_count(normal_workers, min(32, cpu_count * 2), 64)
    ai_worker_count = clamp_worker_count(ai_workers, min(4, max(1, cpu_count // 2)), 16)

    ai_status = "🧠 AI 모드 ON" if USE_AI_FILTER else "⚡ 일반 고속 모드"
    if USE_AI_FILTER and not skip_nsfw:
        log_func(
            f"🔍 [1/3 단계] {total_images}장 스캔 중... "
            f"({ai_status} | 일반 🧵 {normal_worker_count} / AI 🧠 {ai_worker_count})"
        )
    else:
        log_func(
            f"🔍 [1/3 단계] {total_images}장 스캔 중... "
            f"({ai_status} | 일반 🧵 {normal_worker_count})"
        )

    metadata_results = []
    ai_pending_results = []
    meta_source_counts = {
        "parameters": 0,
        "comment": 0,
        "exif": 0,
        "stealth": 0,
        "none": 0
    }

    def record_meta_source(source):
        source = str(source or "none").strip().lower()
        if source not in meta_source_counts:
            source = "none"
        meta_source_counts[source] += 1

    if USE_AI_FILTER and not skip_nsfw:
        log_func(f"   ▶ 1A: 일반 메타데이터/프롬프트 분석은 {normal_worker_count}스레드로 처리합니다.")
        stage1a_started_at = time.perf_counter()
        emit_progress(0, total_images, "1A 일반 분석")
        with concurrent.futures.ThreadPoolExecutor(max_workers=normal_worker_count) as executor:
            futures = {
                executor.submit(
                    analyze_file_worker,
                    img,
                    override_cache=OVERRIDE_CACHE,
                    ai_threshold=ai_threshold,
                    skip_nsfw=skip_nsfw,
                    allow_ai=False,
                    mark_ai_pending=True
                ): img for img in all_images
            }

            for i, future in enumerate(concurrent.futures.as_completed(futures), 1):
                if stop_check and stop_check():
                    log_func(f"🛑 [즉시 정지] {i}장 스캔 중단 요청 수락됨.")
                    for f in futures:
                        f.cancel()
                    db.close()
                    return

                try:
                    result = future.result()
                    if len(result) >= 8:
                        record_meta_source(result[7])
                    else:
                        record_meta_source("none")

                    if len(result) >= 7 and result[6]:
                        ai_pending_results.append(result[:6])
                    else:
                        metadata_results.append(result[:6])
                except Exception as e:
                    log_func(f"⚠️ 스캔 에러: {e}")
                    record_meta_source("none")

                emit_progress(i, total_images, "1A 일반 분석")

                if i % 2000 == 0 or i == total_images:
                    log_func(f"   ▶ 일반 스캔 진행 중: {i} / {total_images} 장 ({(i / total_images) * 100:.1f}%)")

        stage1a_elapsed = time.perf_counter() - stage1a_started_at
        ai_pending_ratio = (len(ai_pending_results) / max(1, total_images)) * 100
        log_func(
            f"⏱️ [계측] 1A 일반 분석 완료: {format_elapsed(stage1a_elapsed)} | "
            f"AI 판정 대상 {len(ai_pending_results)} / {total_images}장 ({ai_pending_ratio:.1f}%)"
        )
        log_func(
            "📊 [계측] 1A 메타 소스: "
            f"parameters={meta_source_counts['parameters']}, "
            f"Comment={meta_source_counts['comment']}, "
            f"EXIF={meta_source_counts['exif']}, "
            f"stealth={meta_source_counts['stealth']}, "
            f"none={meta_source_counts['none']}"
        )

        if ai_pending_results:
            log_func(f"   ▶ 1B: AI 판정 필요 이미지 {len(ai_pending_results)}장을 AI 전용 {ai_worker_count}스레드로 처리합니다.")
            stage1b_started_at = time.perf_counter()
            emit_progress(0, len(ai_pending_results), "1B AI 판정")

            with concurrent.futures.ThreadPoolExecutor(max_workers=ai_worker_count) as executor:
                futures = {
                    executor.submit(
                        ai_classify_pending_result,
                        base_result,
                        ai_threshold
                    ): base_result for base_result in ai_pending_results
                }

                for i, future in enumerate(concurrent.futures.as_completed(futures), 1):
                    if stop_check and stop_check():
                        log_func(f"🛑 [즉시 정지] AI 판정 {i}장 처리 중단 요청 수락됨.")
                        for f in futures:
                            f.cancel()
                        db.close()
                        return

                    fallback_result = futures[future]

                    try:
                        metadata_results.append(future.result())
                    except Exception as e:
                        log_func(f"⚠️ AI 판정 에러: {e}")
                        metadata_results.append(fallback_result)

                    emit_progress(i, len(ai_pending_results), "1B AI 판정")

                    if i % 500 == 0 or i == len(ai_pending_results):
                        log_func(
                            f"   ▶ AI 판정 진행 중: {i} / {len(ai_pending_results)} 장 "
                            f"({(i / max(1, len(ai_pending_results))) * 100:.1f}%)"
                        )
            stage1b_elapsed = time.perf_counter() - stage1b_started_at
            log_func(f"⏱️ [계측] 1B AI 판정 완료: {format_elapsed(stage1b_elapsed)}")
        else:
            log_func("   ▶ AI 판정이 필요한 이미지가 없습니다.")
    else:
        stage1_started_at = time.perf_counter()
        emit_progress(0, total_images, "1단계 스캔")
        with concurrent.futures.ThreadPoolExecutor(max_workers=normal_worker_count) as executor:
            futures = {
                executor.submit(
                    analyze_file_worker,
                    img,
                    override_cache=OVERRIDE_CACHE,
                    ai_threshold=ai_threshold,
                    skip_nsfw=skip_nsfw
                ): img for img in all_images
            }

            for i, future in enumerate(concurrent.futures.as_completed(futures), 1):
                if stop_check and stop_check():
                    log_func(f"🛑 [즉시 정지] {i}장 스캔 중단 요청 수락됨.")
                    for f in futures:
                        f.cancel()
                    db.close()
                    return

                try:
                    metadata_results.append(future.result())
                except Exception as e:
                    log_func(f"⚠️ 스캔 에러: {e}")

                emit_progress(i, total_images, "1단계 스캔")

                if i % 2000 == 0 or i == total_images:
                    log_func(f"   ▶ 스캔 진행 중: {i} / {total_images} 장 ({(i / total_images) * 100:.1f}%)")
    if not (USE_AI_FILTER and not skip_nsfw):
        stage1_elapsed = time.perf_counter() - stage1_started_at
        log_func(f"⏱️ [계측] 1단계 스캔 완료: {format_elapsed(stage1_elapsed)}")

    log_func(f"⚡ [2/3 단계] 초고속 RAM 캐시 기반 캐릭터 식별 및 분류 중...")
    stage2_started_at = time.perf_counter()
    emit_progress(0, len(metadata_results), "2/3 분류 경로 결정")
    move_queue = []
    success_records = []
    gallery_success_records = []
    gallery_pending_by_src = {}

    # 🌟 [해결 1] 루프 밖에서 딱 한 번만 규칙을 읽습니다! (규칙 증발 완벽 차단)
    config = utils.load_config()
    custom_rules = config.get("custom_rules", [])
    if not any(r.get("type") == "default" for r in custom_rules):
        custom_rules.append({"type": "default"})

    # 🌟 [해결 2] 긴 이름 저장 함수도 루프 밖으로 뺍니다. (DB 렉 방지)
    def save_long_name(physical, full):
        if physical != full:
            try:
                # process 최상단에 이미 선언된 db 객체를 그대로 재사용합니다.
                with db.conn:
                    db.conn.execute(
                        "CREATE TABLE IF NOT EXISTS folder_display_names (physical_name TEXT PRIMARY KEY, full_name TEXT)")
                    db.conn.execute(
                        "INSERT OR REPLACE INTO folder_display_names (physical_name, full_name) VALUES (?, ?)",
                        (physical, full))
            except Exception as e:
                log_func(f"⚠️ 긴 폴더명 저장 실패: {physical} | {e}")

    # 🚀 자, 이제 윈도우 방해 없는 초고속 루프 시작
    for i, (full_path, file_hash, char_tags, base_tags, rating, nsfw_reasons) in enumerate(metadata_results, 1):
        img_name = os.path.basename(full_path)

        unreadable_reason = ""
        if rating == -999:
            for reason in nsfw_reasons or []:
                text_reason = str(reason)
                if text_reason.startswith("__UNREADABLE__:"):
                    unreadable_reason = text_reason.replace("__UNREADABLE__:", "", 1).strip()
                    break
            if not unreadable_reason:
                unreadable_reason = "이미지 파일을 Pillow가 읽지 못했습니다."

            unreadable_dir = os.path.join(classified_root, "_UNREADABLE", datetime.datetime.now().strftime("%Y-%m-%d"))
            os.makedirs(unreadable_dir, exist_ok=True)

            dest_path = os.path.join(unreadable_dir, img_name)
            if os.path.abspath(full_path) == os.path.abspath(dest_path):
                stats["unreadable"] += 1
                log_func(f"⚠️ 이미지 판독 실패 유지: {img_name} | {unreadable_reason}")
                continue

            if os.path.exists(dest_path):
                base_name, ext = os.path.splitext(img_name)
                dest_path = os.path.join(
                    unreadable_dir,
                    f"{base_name}_{int(time.time() * 1000)}{ext}"
                )

            unreadable_reasons = [
                "⚠️ 이미지 판독 실패",
                unreadable_reason
            ]

            move_queue.append((full_path, dest_path, img_name, "_UNREADABLE", file_hash, unreadable_reasons))
            stats["unreadable"] += 1
            log_func(f"⚠️ 이미지 판독 실패 → _UNREADABLE 이동 예정: {img_name} | {unreadable_reason}")
            continue

        if is_fast and file_hash in processed_hashes:
            if method == "move" and os.path.exists(full_path):
                pass
            else:
                stats["skipped_db"] += 1
                continue

        detected_names = set()
        is_daki = False

        def fast_memory_extract(raw_tag):
            t_clean = raw_tag.strip().lower()
            if not t_clean: return None

            # NAI 프롬프트 가중치 기호 제거 (예: {{{tag}}}, tag:1.2 등)
            clean = re.sub(r'^[-0-9.]+:+\s*', '', t_clean)
            clean = re.sub(r'\s*:+$', '', clean)
            clean = re.sub(r':[0-9.]+$', '', clean).strip()

            # 태그 전체를 감싸는 괄호만 안전하게 벗김 (단, march_7th_(honkai) 처럼 일부만 감싸는 건 유지)
            while clean.startswith('(') and clean.endswith(')'): clean = clean[1:-1].strip()
            while clean.startswith('[') and clean.endswith(']'): clean = clean[1:-1].strip()
            while clean.startswith('{') and clean.endswith('}'): clean = clean[1:-1].strip()

            clean = re.sub(r'\s+', '_', clean).lower().strip()
            if len(clean) < 2: return None

            # [핵심 1] 프롬프트가 캐릭터로 둔갑하는 것을 막는 차단 키워드 추가
            blacklist = [
                '(medium)', '(object)', '(clothes)', '(creature)', '(species)',
                '(item)', '(anatomy)', '(background)', '(cosplay)', '(style)',
                '(studio)', 'artist', 'uniform', 'reality_arc', 'must_include'
            ]
            if any(b in clean for b in blacklist): return None

            # 🌟 [핵심 2] 괄호 패턴(re.search)으로 캐릭터를 때려맞추는 꼼수 완전 삭제!
            # 오직 '단보루 DB(DANBOORU_RAM_CACHE)'에 정확히 등록된 공식 태그만 인정합니다.
            if clean in DANBOORU_RAM_CACHE:
                return clean.title()

            return None

        # ----------------------------------------------------
        # 🌟 추출 루프 통합: 괄호가 포함된 태그도 원형 그대로 검사합니다.
        # ----------------------------------------------------
        all_prompt_tags = char_tags + base_tags

        for tag in all_prompt_tags:
            clean_tag = tag.strip().lower()
            if not clean_tag: continue

            if "dakimakura" in clean_tag:
                is_daki = True

            if not skip_char_id:
                # 모든 태그를 DB와 1:1 대조합니다.
                matched = fast_memory_extract(clean_tag)
                if matched:
                    detected_names.add(matched)

        final_names = set()
        for n in detected_names:
            clean_n = n.strip().lower()
            if clean_n and clean_n not in ignore_words:
                final_names.add(n)

        names_list = list(final_names)
        num = len(names_list)

        # ----------------------------------------------------
        # 🌟 커스텀 규칙 + 기본 분류 (우선순위 엔진)
        # ----------------------------------------------------

        all_tags = [str(t) for t in (char_tags + base_tags) if t]

        def clean_route_prompt_text(value):
            return re.sub(r"\s+", " ", str(value or "").strip())

        def route_prompt_match_keys(value):
            text = clean_route_prompt_text(value).lower()
            if not text:
                return set()

            space_text = re.sub(r"\s+", " ", text.replace("_", " ")).strip()
            underscore_text = re.sub(r"\s+", "_", space_text)
            compact_text = re.sub(r"[\s_]+", "", space_text)

            return {key for key in (text, space_text, underscore_text, compact_text) if key}

        def dedupe_route_prompts_for_match(items):
            prompts = []
            seen = set()

            for item in items or []:
                prompt = clean_route_prompt_text(item)
                if not prompt:
                    continue

                keys = route_prompt_match_keys(prompt)
                dedupe_key = next(iter(sorted(keys)), "")
                if not dedupe_key or dedupe_key in seen:
                    continue

                seen.add(dedupe_key)
                prompts.append(prompt)

            return prompts

        def normalize_route_tag_groups_for_match(raw_groups):
            groups = []
            seen_groups = set()

            if not isinstance(raw_groups, list):
                return groups

            for raw_group in raw_groups:
                if isinstance(raw_group, list):
                    group_items = raw_group
                else:
                    group_items = [raw_group]

                group = dedupe_route_prompts_for_match(group_items)
                if not group:
                    continue

                group_key = tuple(
                    next(iter(sorted(route_prompt_match_keys(tag))), "")
                    for tag in group
                )
                if group_key in seen_groups:
                    continue

                seen_groups.add(group_key)
                groups.append(group)

            return groups

        full_route_tag_keys = set()
        for tag in all_tags:
            full_route_tag_keys.update(route_prompt_match_keys(tag))

        def route_rule_prompt_matches(prompt):
            return any(key in full_route_tag_keys for key in route_prompt_match_keys(prompt))

        def route_rule_matches(rule):
            prompt_mode = "group" if rule.get("prompt_mode") == "group" else "single"
            rule_tags = dedupe_route_prompts_for_match(rule.get("tags", []))
            tag_groups = normalize_route_tag_groups_for_match(rule.get("tag_groups", []))

            if prompt_mode == "group":
                if not tag_groups and rule_tags:
                    tag_groups = [[tag] for tag in rule_tags]

                return any(
                    all(route_rule_prompt_matches(tag) for tag in group)
                    for group in tag_groups
                    if group
                )

            if not rule_tags:
                return False

            condition = rule.get("condition", "any")
            try:
                match_count = int(rule.get("match_count", 1) or 1)
            except Exception:
                match_count = 1

            match_count = max(1, match_count)

            if condition == "all":
                return all(route_rule_prompt_matches(tag) for tag in rule_tags)

            matched = sum(1 for tag in rule_tags if route_rule_prompt_matches(tag))
            return matched >= match_count

        def find_matching_child_route(children):
            children = children or []

            for child in children:
                if not isinstance(child, dict):
                    continue

                if child.get("type") == "default":
                    continue

                if not route_rule_matches(child):
                    continue

                parts = [str(child.get("folder") or "").strip()]
                nested_children = (
                    child.get("children")
                    or child.get("sub_rules")
                    or child.get("rules")
                    or []
                )
                nested = find_matching_child_route(nested_children)

                if nested:
                    parts.append(nested)

                return os.path.join(*[p for p in parts if p])

            return ""

        def clean_route_folder_part(part):
            part = str(part or "").strip()
            part = re.sub(r'[<>:"|?*]', '', part)
            part = part.strip('. ')

            if not part:
                return ""

            if len(part) > 100:
                short_part = part[:100].strip('_ ') + "_and_Others"
                save_long_name(short_part, part)
                part = short_part

            return part

        def normalize_route_folder_path(raw_path):
            parts = [
                clean_route_folder_part(part)
                for part in re.split(r'[\\/]+', str(raw_path or ""))
            ]
            parts = [part for part in parts if part]

            if not parts:
                return "3_Group"

            return os.path.join(*parts)

        cat_raw = None

        for rule in custom_rules:
            if rule.get("type") == "default":
                cat_raw = "1_Solo" if num == 1 else "2_Duo" if num == 2 else "3_Group" if num >= 3 else "0_No_Metadata"
                break

            if not route_rule_matches(rule):
                continue

            route_parts = [str(rule.get("folder") or "").strip()]

            children = (
                rule.get("children")
                or rule.get("sub_rules")
                or rule.get("rules")
                or []
            )
            child_route = find_matching_child_route(children)

            if child_route:
                route_parts.append(child_route)

            cat_raw = os.path.join(*[p for p in route_parts if p])
            break

        if not cat_raw:
            cat_raw = "3_Group"

        cat = normalize_route_folder_path(cat_raw)

        # 🌟 3단계 등급에 따른 폴더 분배
        if rating in [1, 2]:
            cat = os.path.join("_R-18", cat)

        # 🌟 폴더명(캐릭터명) 원본 생성 로직
        if skip_char_id:
            original_folder = ""
        else:
            original_folder = "_and_".join(sorted(names_list)) or "Unknown_Char"

        if is_daki:
            original_folder += "_Dakimakura" if original_folder else "Dakimakura"

        original_folder = re.sub(r'[<>:"/\\|?*]', '', original_folder).strip('. ')

        # 🌟 2. 캐릭터 폴더명 길이 제한 및 DB 저장 (100자 제한)
        if len(original_folder) > 100:
            folder_name = original_folder[:100].strip('_ ') + "_and_Others"
            if is_daki and not folder_name.endswith("Dakimakura"):
                folder_name += "_Dakimakura"
            save_long_name(folder_name, original_folder)
        else:
            folder_name = original_folder

        # 폴더 생성 실행
        dest_dir = os.path.join(classified_root, cat, folder_name)
        os.makedirs(dest_dir, exist_ok=True)
        dest_path = os.path.join(dest_dir, img_name)

        # 🌟 [교정] 목적지가 야짤 폴더인지 확인하는 변수 추가
        is_target_nsfw = "_R-18" in cat or "_R-15" in cat
        txt_path = os.path.splitext(dest_path)[0] + ".txt"

        if os.path.abspath(full_path) == os.path.abspath(dest_path):
            # 🌟 [수정] 폴더 위치와 상관없이 사유(nsfw_reasons)가 있다면 무조건 생성/유지
            if nsfw_reasons:
                txt_path = os.path.splitext(dest_path)[0] + ".txt"
                try:
                    with open(txt_path, "w", encoding="utf-8") as f:
                        f.write("<br>".join(nsfw_reasons))
                except Exception as e:
                    log_func(f"⚠️ 대표/현재 위치 사유 저장 실패: {txt_path} | {e}")

            success_records.append((full_path, file_hash, img_name, folder_name))
            gallery_success_records.append({
                "final_path": dest_path,
                "rating": rating,
                "names": names_list,
                "is_dakimakura": is_daki,
                "nsfw_reasons": nsfw_reasons
            })
            continue

        if os.path.exists(dest_path):
            stats["skipped_duplicate"] += 1
            success_records.append((full_path, file_hash, img_name, folder_name))
            continue

        move_queue.append((full_path, dest_path, img_name, folder_name, file_hash, nsfw_reasons))
        gallery_pending_by_src[full_path] = {
            "final_path": dest_path,
            "rating": rating,
            "names": names_list,
            "is_dakimakura": is_daki,
            "nsfw_reasons": nsfw_reasons
        }

        if i % 500 == 0 or i == len(metadata_results):
            emit_progress(i, len(metadata_results), "2/3 분류 경로 결정")

        if i % 4000 == 0 or i == len(metadata_results):
            log_func(f"   ▶ 매칭 완료: {i} / {len(metadata_results)} 장")

    stage2_elapsed = time.perf_counter() - stage2_started_at
    log_func(f"⏱️ [계측] 2단계 분류 경로 결정 완료: {format_elapsed(stage2_elapsed)}")

    total_moves = len(move_queue)
    stage3_started_at = time.perf_counter()
    emit_progress(0, total_moves, f"3/3 파일 {action_text}")

    if total_moves > 0:
        log_func(f"🚚 [3/3 단계] {total_moves}개 파일의 물리적 {action_text} 시작...")
    else:
        log_func(f"🚚 [3/3 단계] 새롭게 {action_text}할 파일이 없습니다.")

    max_io_workers = min(16, (os.cpu_count() or 4) * 2)
    batch_records = []  # 🌟 [추가] 100장 단위 저장을 위한 임시 바구니

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_io_workers) as executor:
        future_to_info = {
            executor.submit(file_io_worker, src, dest, method, nsfw_reasons): (src, img_name, folder_name, file_hash)
            for src, dest, img_name, folder_name, file_hash, nsfw_reasons in move_queue}

        for i, f in enumerate(concurrent.futures.as_completed(future_to_info), 1):
            # 🌟 [추가] 매 장마다 실시간 UI 숫자 업데이트
            emit_progress(i, total_moves, f"3/3 파일 {action_text}")

            # 🌟 [추가] 사용자가 정지 버튼을 눌렀는지 확인
            if stop_check and stop_check():
                log_func(f"🛑 사용자에 의해 정지됨. ({i}장 지점에서 중단)")
                break  # 루프 탈출 (이후 하단의 batch_records 저장 로직으로 이동)
            src, img_name, folder_name, file_hash = future_to_info[f]
            if f.result():
                success_records.append((src, file_hash, img_name, folder_name))
                gallery_record = gallery_pending_by_src.get(src)
                if gallery_record:
                    gallery_success_records.append(gallery_record)
                batch_records.append((file_hash, img_name, folder_name))  # 🌟 바구니에 담기
                stats["success"] += 1
            else:
                stats["error"] += 1

            # 🌟 [추가] 100장이 찰 때마다 즉시 DB에 저장 (이어하기 세이브포인트)
            if len(batch_records) >= 100:
                try:
                    with db.conn:
                        db.conn.executemany(
                            "INSERT OR IGNORE INTO processed_files (file_hash, file_name, characters) VALUES (?, ?, ?)",
                            batch_records
                        )
                    # 콘솔창이 너무 더러워지지 않게 조용히 저장만 합니다.
                    batch_records = []  # 바구니 비우기
                except Exception as e:
                    log_func(f"⚠️ 중간 이력 저장 실패: {e}")

            if i % 1000 == 0 or i == total_moves:
                log_func(f"   ▶ 파일 {action_text} 진행 중: {i} / {total_moves} 개 완료 ({(i / total_moves) * 100:.1f}%)")

    # 🌟 [추가] 100장이 안 채워지고 남은 자투리 데이터들 최종 저장
    if batch_records:
        try:
            with db.conn:
                db.conn.executemany(
                    "INSERT OR IGNORE INTO processed_files (file_hash, file_name, characters) VALUES (?, ?, ?)",
                    batch_records
                )
        except Exception as e:
            log_func(f"⚠️ 최종 이력 저장 실패: {e}")

    # 🌟 재정렬 후 껍데기만 남은 빈 폴더 삭제 로직
    stage3_elapsed = time.perf_counter() - stage3_started_at
    log_func(f"⏱️ [계측] 3단계 파일 {action_text} 완료: {format_elapsed(stage3_elapsed)}")

    if reorg_mode:
        log_func("🧹 아카이브 청소 중: 비어있는 옛날 폴더들을 삭제합니다...")
        for root, dirs, files in os.walk(classified_root, topdown=False):
            if "_TRASH" in root: continue
            for d in dirs:
                dir_path = os.path.join(root, d)
                try:
                    if not os.listdir(dir_path):
                        os.rmdir(dir_path)
                except OSError:
                    pass
        log_func("✨ 아카이브 청소 완료!")

    stage_db_started_at = time.perf_counter()
    emit_progress(0, 1, "DB 저장/갤러리 인덱스")

    if success_records:
        log_func("💾 최종 이력을 데이터베이스에 일괄 기록 중입니다...")
        try:
            with db.conn:
                for src, file_hash, img_name, folder_name in success_records:
                    if file_hash:
                        # 1. 파일 처리 이력 저장
                        db.conn.execute(
                            "INSERT OR IGNORE INTO processed_files (file_hash, file_name, characters) VALUES (?, ?, ?)",
                            (file_hash, img_name, folder_name)
                        )

                        # 2. 🌟 [핵심] 발견된 캐릭터 태그들을 known_characters 테이블에 저장
                        # folder_name에 합쳐진 캐릭터들을 다시 분리해서 개별 태그로 저장합니다.
                        chars = [c.strip() for c in
                                 folder_name.replace("_and_", ",").replace("_Dakimakura", "").split(",") if c.strip()]
                        for char_tag in chars:
                            if char_tag.lower() not in ignore_words:
                                db.conn.execute(
                                    "INSERT OR IGNORE INTO known_characters (tag) VALUES (?)",
                                    (char_tag,)
                                )
            log_func(f"✅ {len(success_records)}장의 이력 및 캐릭터 정보가 DB에 저장되었습니다.")
        except Exception as e:
            log_func(f"⚠️ DB 저장 중 오류 발생: {e}")

    if gallery_success_records:
        try:
            gallery_records = build_gallery_index_records_from_success(gallery_success_records, classified_root)
            if gallery_records:
                db.upsert_gallery_image_records(gallery_records)

                if db.get_gallery_index_state("gallery_index_reset_for_reclassify", "0") == "1":
                    if stats.get("error", 0) > 0:
                        db.set_gallery_index_state("full_index_built", "0")
                        log_func("⚠️ 실패한 이미지가 있어 갤러리 full index 확정을 보류합니다.")
                    elif stats.get("skipped_duplicate", 0) > 0:
                        db.set_gallery_index_state("full_index_built", "0")
                        log_func("⚠️ 파일 중복 스킵이 있어 갤러리 full index 확정을 보류합니다.")
                    else:
                        try:
                            log_func("🧭 전체 재분류 기준으로 갤러리 인덱스 요약을 생성 중입니다...")
                            db.rebuild_gallery_folder_summaries()
                            db.set_gallery_index_state("full_index_built", "1")
                            db.set_gallery_index_state("gallery_index_reset_for_reclassify", "0")
                            log_func("✅ 갤러리 인덱스를 전체 재분류 결과로 확정했습니다.")
                        except Exception as index_err:
                            db.set_gallery_index_state("full_index_built", "0")
                            log_func(f"⚠️ 갤러리 인덱스 확정 실패: {index_err}")
        except Exception as e:
            log_func(f"[WARN] gallery index write failed: {e}")

    stage_db_elapsed = time.perf_counter() - stage_db_started_at
    emit_progress(1, 1, "DB 저장/갤러리 인덱스")
    log_func(f"⏱️ [계측] DB 저장/갤러리 인덱스 처리 완료: {format_elapsed(stage_db_elapsed)}")

    total_elapsed = time.perf_counter() - job_started_at
    log_func(f"⏱️ [계측] 전체 작업 소요 시간: {format_elapsed(total_elapsed)}")

    log_func("-" * 50)
    log_func("🏁 [전체 작업 요약 리포트]")
    log_func(f"  1. 총 탐색 이미지: {stats['total_scanned']}장")
    log_func(f"  2. {action_text} 성공: {stats['success']}장")
    log_func(f"  3. 중복 스킵(DB): {stats['skipped_db']}장")
    log_func(f"  4. 중복 스킵(파일존재): {stats['skipped_duplicate']}장")
    log_func(f"  5. 처리 실패(오류): {stats['error']}장")
    log_func(f"  6. 이미지 판독 실패 격리: {stats.get('unreadable', 0)}장")
    log_func("-" * 50)
    log_func(f"✨ 모든 작업이 완료되었습니다.")
    db.close()


def handle_integrated_tasks(fixed_root, data, log_func=print):
    import datetime
    import utils  # 🌟 DB 사용을 위해 추가

    thumbs = data.get("thumbs", [])
    deletes = data.get("deletes", [])
    db = utils.HistoryDB()  # 🌟 DB 인스턴스 생성

    # 1. 삭제 작업 (휴지통 이동 OR 영구 삭제)
    trash_root = os.path.join(fixed_root, "_TRASH", datetime.datetime.now().strftime("%Y-%m-%d"))
    trash_base = os.path.join(fixed_root, "_TRASH")

    for target_path in deletes:
        try:
            full_path = utils.resolve_safe_path(fixed_root, target_path, strip_prefix="TOTAL_CLASSIFIED/")
        except ValueError as e:
            log_func(f"❌ 삭제 경로 거부: {target_path} | {e}")
            continue

        if os.path.exists(full_path):
            file_name = os.path.basename(full_path)
            try:
                # 🌟 이미 휴지통에 있는 파일이라면 '영구 삭제' 수행
                if utils.is_subpath(full_path, trash_base):
                    os.remove(full_path)
                    db.remove_trash_path(full_path)  # 🌟 DB에서도 삭제 이력 지우기
                    
                    # 🌟 [추가] 통계 및 그림체 스캔 DB에서도 완전히 기록 말소
                    db.remove_all_file_records(target_path)

                    txt_path = os.path.splitext(full_path)[0] + ".txt"
                    if os.path.exists(txt_path):
                        os.remove(txt_path)

                    log_func(f"🔥 영구 삭제 완료: {file_name}")

                # 🌟 일반 폴더에 있다면 '휴지통으로 대피'하고 위치 기억
                else:
                    os.makedirs(trash_root, exist_ok=True)
                    timestamp = datetime.datetime.now().strftime("%H%M%S_")
                    trash_path = os.path.join(trash_root, timestamp + file_name)

                    os.replace(full_path, trash_path)
                    db.save_trash_path(trash_path, full_path)  # 🌟 DB에 원래 위치 기록!
                    
                    # 🌟 [추가] 기존 위치의 DB 기록 말소 (통계 등에서 즉각 제외되도록)
                    db.remove_all_file_records(target_path)

                    old_txt = os.path.splitext(full_path)[0] + ".txt"
                    if os.path.exists(old_txt):
                        new_txt = os.path.splitext(trash_path)[0] + ".txt"
                        os.replace(old_txt, new_txt)

                    log_func(f"♻️ 휴지통 이동 완료: {file_name}")
            except Exception as e:
                log_func(f"❌ 처리 실패 ({file_name}): {e}")

    # (이후 2. 대표 이미지 변경 썸네일 로직은 기존 코드 그대로 유지)
    # 2. 🌟 대표 이미지 변경 (중복 제거 및 사유 .txt 파일 유지 통합)
    for t in thumbs:
        new_thumb = t.get("new_thumb")
        if not new_thumb: continue

        try:
            full_path = utils.resolve_safe_path(fixed_root, new_thumb, strip_prefix="TOTAL_CLASSIFIED/")
        except ValueError as e:
            log_func(f"❌ 대표 이미지 경로 거부: {new_thumb} | {e}")
            continue
        if not os.path.exists(full_path): continue

        dirname = os.path.dirname(full_path)
        basename = os.path.basename(full_path)

        if not utils.is_subpath(dirname, fixed_root):
            log_func(f"❌ 대표 이미지 폴더 거부: {dirname}")
            continue

        if basename.startswith("000_MAIN_"): continue

        try:
            # 기존 대표 이미지 꼬리표 떼기 (.txt 포함)
            for f in os.listdir(dirname):
                if f.startswith("000_MAIN_"):
                    old_p = os.path.join(dirname, f)
                    new_p = os.path.join(dirname, f.replace("000_MAIN_", "", 1))
                    if os.path.exists(old_p): os.replace(old_p, new_p)

                    old_txt = os.path.splitext(old_p)[0] + ".txt"
                    new_txt = os.path.splitext(new_p)[0] + ".txt"
                    if os.path.exists(old_txt): os.replace(old_txt, new_txt)

            # 새 대표 이미지 지정 (.txt 포함)
            new_full_path = os.path.join(dirname, "000_MAIN_" + basename)
            os.replace(full_path, new_full_path)

            full_txt = os.path.splitext(full_path)[0] + ".txt"
            new_full_txt = os.path.splitext(new_full_path)[0] + ".txt"
            if os.path.exists(full_txt): os.replace(full_txt, new_full_txt)

            log_func(f"🖼️ 대표 변경 완료: {basename}")
        except Exception as e:
            log_func(f"❌ 대표 변경 중 에러 ({basename}): {e}")


    db.close()
