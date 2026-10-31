# 구조 개선 및 호환성 기록

- 캔버스 인스턴스 디테일 프리셋: `static/canvas_detail_presets.js/.css`는 인스턴스의 접이식 선택기와 `도구 → 디테일 프리셋 관리`를 소유한다. 공통·현재 연결 프로젝트의 항목을 함께 검색하고, 클릭할 때마다 Base/Negative 원문을 각 인스턴스 입력 끝에 추가한다. 선택 영역 반영은 기존 `saveClipPromptModal` 저장 경계를 유지한다. 관리 창은 공통·현재 프로젝트의 추가/수정/삭제와 범위 간 복사를 제공하며 이미 삽입한 문구는 수정하지 않는다.
- 기본 37종의 목록·검증·변경 규칙은 `naim/detail_prompt_presets.py`, `/api/canvas/detail-presets`의 GET/POST/PUT/DELETE는 `naim/web/canvas_detail_presets.py`, 저장은 `DakiProjectsStore.get_detail_prompt_presets`·`mutate_detail_prompt_presets`가 담당한다. 기존 `daki_projects.json`의 루트와 개별 프로젝트에 선택적 `detailPromptPresets: {revision, items}`를 사용한다. 누락 시 공통은 내장 목록, 프로젝트는 빈 목록이며 조회만으로 파일을 만들지 않는다. 기존 JSON 잠금·원자 저장·손상 복구·업데이트 보호를 재사용하고 알 수 없는 필드를 보존한다. 일반 프로젝트 응답에서는 프리셋 문구를 제외한다.
- 프리셋 저장 충돌은 409로 반환하고 편집 내용을 유지한 채 최신 목록을 다시 불러오도록 한다. 생성 재시도는 같은 ID를 사용하며 늦은 응답은 프로젝트·창 세션으로 차단한다. 회귀: `test_canvas_detail_presets.py/.js`, 기존 인스턴스·프로젝트·설정·모달·저장본 검사. `.qa/verify_canvas_detail_presets.cjs`와 합성 Flask 응답으로 1280×900·800×800, 브라우저 100%·DPR 1에서 삽입·관리·오류 복구·프로젝트 분리를 확인한다. 실제 NovelAI 생성 품질과 EXE 재빌드는 별도 검증 대상이다.

- 클립 인페인팅의 인스턴스 프롬프트: `canvas.html`의 `clipInstancePromptInput`과 `static/canvas.js`의 `openClipPromptModal`·`saveClipPromptModal`이 선택 레이어의 선택적 문자열 `instancePrompt`·`instanceNegativePrompt`를 편집한다. 같은 선택 영역의 클립만 공유하며 공용 `promptInfo`에는 넣지 않는다. `buildEffectiveClipPromptInfo`가 제어 그룹을 적용한 Base Prompt·Negative Prompt 뒤에 각각 붙이고, 기존 레이어 스냅샷·복원 경계가 그대로 저장한다. 필드 없는 저장본은 빈 문자열로 취급한다. 회귀: `tests/test_canvas_instance_prompt.js`, `tests/test_canvas_inpaint_settings.js`.

작업 브랜치: `codex/structure-refactor`. 기존 미커밋 변경을 유지한 상태에서 기능별로 분리한다.
`NAI_Image_Manager_2.0/`은 별도 계획 자료이며 이번 구현의 실행 경로가 아니다.

## 변경 경계

- 공유 테스트 배포: `tools/export_daki_test_packs.py`는 명시적으로 선택한 완료 테스트만 `style_test_packs.json`과 개별 ZIP으로 내보낸다. 상반신의 `legacy_preview`는 실제 원본 그림으로 포함하고 경로·임의 로컬 필드는 제외한다. 원본 이미지 바이트와 생성 요청 스냅샷을 보존하며 입력 자료는 수정하지 않는다.
- `naim/daki_test_packs.py`는 기존 Hugging Face 데이터셋의 동일 리비전 목록·ZIP을 읽고 크기·SHA-256·압축 항목·이미지·생성 설정을 검증한다. `naim/web/daki_test_packs.py`의 `/api/daki/style-test-packs` GET/POST, `/job` GET, `/stop` POST가 목록·비동기 다운로드·중지를 제공한다. `daki_style_tests/.packs/`에서 이어받기·임시 검증 후 `DakiStyleTests.install_shared_pack`이 잠금 안에서 없는 테스트 폴더만 원자 추가한다. 기존 테스트 ID·사용자 편집·완료 결과는 덮어쓰지 않으며 유료 생성은 시작하지 않는다.
- `static/daki_test_packs.js/.css`는 공유 그림체 루트의 선택 다운로드 창과 진행·중지·재시도를 담당한다. 받은 테스트는 기존 이름 변경·그림체 추가·설정 수정·생성 API를 사용한다. 창을 닫으면 화면 조회만 정리하고 다운로드는 계속되며, 서버 종료 시 다운로드 중지를 요청한다. 회귀: `test_daki_test_packs.py`, `test_daki_test_pack_export.py`, `test_daki_test_packs.js`와 기존 테스트 생성/API/화면 검증.

### 업스케일 선택 모델과 설치 관리

- `upscale_logic.py`가 기존 엔진과 선택 모델을 분기하며 기존 URL·대기열·메타데이터·프로젝트 결과 저장 경로를 유지한다. `naim/upscale_catalog.py`는 공식 URL·고정 버전·SHA256·배율별 모델 목록, `naim/upscale_assets.py`는 설치 상태·다운로드·취소·안전한 삭제와 공유 실행 환경을 소유한다. HTTP 경계는 `naim/web/upscale_models.py`의 `/api/upscale/models`와 모델별 `/download`, `/cancel`, `/delete`이다.
- `naim/images/model_upscale.py`가 별도 Python 프로세스와 GPU 사용을 직렬화하고 `naim/upscale_worker.py`가 타일 추론·알파 보존·원자 결과 저장을 처리한다. 선택 자료는 `upscale_models/`에만 저장하고 배포본에는 워커 소스만 포함한다. 기존 `tools/` 엔진은 유지한다.
- `naim/images/nai_upscale.py`는 가운데 5:16 자르기·64 배수·최대 3MP 입력 계획과 단일 NAI 요청을 소유한다. `/api/upscale/nai/preview`는 크기만 계산하며 원본이나 키를 전송하지 않는다. 과금 확인은 요청마다 필요하고 키는 작업 목록이나 메타데이터에 저장하지 않는다. 공식 API와 스튜디오의 V5 curated/sigma 0/2배 규칙을 2026-10-24 확인했다.
- `static/upscale_models.js/.css`는 두 업스케일 모달의 설치 상태·다운로드·삭제·NAI 안내를 공유한다. 기존 갤러리/캔버스 제어기는 이 패널의 준비 결과를 기존 요청에 전달한다. 검증: `test_upscale_assets.py`, `test_model_upscale.py`, `test_nai_upscale.py`, `test_upscale_models.js`와 기존 업스케일·프로젝트 결과 회귀 테스트.
- 갤러리·캔버스의 2배/4배는 기존 목표 크기 필드를 사용한다. 선택적 `fit_5_16: true`는 NAI 이외 엔진에서 지정 크기로 확대한 뒤 최대 정수 5:16 중앙 영역을 자르며, `upscale_logic.run_upscale` 결과의 `final_width`/`final_height`가 실제 저장 크기다. 캔버스 응답도 실제 크기를 반환한다. 다운로드 화면의 백분율은 `downloaded_bytes / download_bytes`를 사용하고 바이트 정보가 없으면 기존 진행률을 사용한다.

### 갤러리 형식 표시와 WebP 교체

- 갤러리 우클릭 변환은 기존 모달 안에서 **원본 유지 + WebP 추가**(매번 기본 선택) 또는 **원본을 WebP로 교체**를 고른다. `/api/gallery/webp`의 선택적 `keep_original`은 엄격한 bool이며 생략하면 기존 교체 동작이다. 현재 폴더 일괄 변환은 기존 동작을 유지한다. 리모콘은 실제 실행 직전 공통 테마의 저장 방식 모달로 두 방식과 취소를 선택하며 예상 용량 계산·새 분류 자동 변환은 기존 동작을 유지한다.
- 추가 모드는 `naim/storage/webp_conversion.py`의 `add_webp_gallery_image`로 새 WebP만 기존 갤러리 인덱스에 등록한다. 원본 파일·태그·별칭·프로젝트 연결은 이동하지 않으며, 취소·검증 실패 시 새 등록을 되돌린다. 추가 모드의 용량 표시는 절약량이 아닌 추가 WebP 용량이다. 파일 이름과 이름 충돌 시 건너뛰기 정책은 교체 모드와 같다.
- 우클릭 개별 변환은 시작 요청 즉시 같은 모달을 진행 화면으로 전환한다. 서버의 처리 장수·진행률·성공/건너뜀/실패와 용량을 표시하고, 한 장을 처리하는 동안에는 대기 중인 진행바를 보여 준다. 완료·중지·요청 실패 후 결과를 유지하며 설정으로 돌아가 재시도할 수 있다. 실행 중 닫았다 다시 열면 진행 화면으로 복원한다. 현재 폴더 일괄 변환과 리모콘의 진행 화면은 기존 동작을 유지한다.
- 갤러리 모달을 닫아도 상태 조회는 계속되며 페이지 우측 하단의 WebP 진행 카드로 진행·결과를 확인한다. ‘자세히’로 모달을 다시 열고 ‘중지’로만 취소를 요청한다. 페이지 이탈 때는 상태 조회만 정리하고 서버 작업은 유지한다. 건너뜀 결과에는 가능한 경우 서버가 반환한 이유를 표시한다.
- 프로젝트 후보의 우클릭은 기존 `projectContext`(프로젝트·면·후보 ID)를 WebP 요청에 함께 보낸다. `naim/images/project_results.py`가 후보와 원본 일치를 검증하고, **원본 유지 + 추가**는 임시 사본을 변환한 뒤 `naim/images/canvas_export.py`의 `save_project_webp_candidate`로 같은 면에 영구 WebP 후보를 추가한다. 실제 파일과 새 저장 주소 모두 `.webp`를 사용한다. 기존 프로젝트 내보내기의 `.png` 주소도 계속 읽되 실제 WebP라면 API의 `path`·`src`와 이미지 확장자가 있는 표시·다운로드 이름은 `.webp`로 반환한다. 교체는 기존 후보 ID와 저장된 연결을 유지하며 기존 JSON을 일괄 변경하지 않는다. 프로젝트 없는 변환·리모콘·프로젝트 저장 스키마는 그대로다.
- `static/gallery_image_tools.js/.css`가 사유 보기 옆 형식 체크박스, 실제 파일 헤더 배지, 우클릭 개별 변환과 현재 폴더 일괄 변환을 소유한다. 모달을 열 때 `static/index.js`의 `getGalleryWebpLocation()` 또는 Daki 제목으로 대상 폴더·경로·장수를 고정해 표시한다. 현재 필터에 표시된 이미지가 대상이며 하위 폴더는 제외한다. 표시 설정은 `naim_show_image_formats_v1`, 품질 기본값은 90이다.
- 폴더 변환의 태그 제외는 기존 `getGalleryTagState()`·`getGalleryImageTagId()`의 갤러리 지정 태그를 사용한다. 특정 태그 복수 선택 또는 태그가 있는 모든 그림 제외 후 남은 경로만 기존 변환 API로 보낸다. 전체·제외·변환 장수를 즉시 표시하고 시작 직전에 다시 계산하며, 실행 중에는 선택을 고정한다. 제외 선택은 모달을 새로 열 때 초기화하고 개별 변환에는 적용하지 않는다. 태그 저장 형식과 원본 태그는 변경하지 않는다.
- `naim/web/image_conversion.py`는 형식 조회 및 시작·상태·취소 HTTP 경계, `naim/jobs/image_conversion.py`는 단일 백그라운드 작업, `naim/images/gallery_conversion.py`는 기존 갤러리 경로·DB·태그 갱신 연결을 담당한다. `app.py`는 등록과 의존성 연결만 하며 `naim/web/lifecycle.py`의 기존 종료 흐름에 포함한다.
- `naim/images/webp_conversion.py`는 PNG/JPEG/BMP/정지 GIF를 검증 후 WebP로 교체한다. PNG는 `name.webp`, 그 외는 같은 이름의 PNG와 충돌하지 않도록 `name.jpg.webp` 형태를 사용한다. 원본 메타데이터와 투명도·파일 시각을 보존하며 JPG 등의 JSON/TXT 보조 파일은 새 이름으로 안전 복사한다. 기존 PNG 전용 API와 리모콘 무손실 기본값은 유지한다.
- Daki 시안·테스트·공유 그림체·태그 사전 읽기는 기존 PNG 모양 가상 ID를 유지하고 정확한 WebP 대체 파일을 해석한다. 프로젝트 내보내기는 `.png`·`.webp` 주소를 모두 허용한다. 명시적인 `.webp` 주소는 PNG로 대체하지 않으며, 두 파일이 모두 존재하면 요청한 확장자의 파일을 읽는다. 새 이미지의 저장 형식 선택은 각 생성 기능이 소유하며, 이 교체 기능은 선택한 기존 이미지만 처리한다.
- `tools/convert_daki_webp.py`는 명시한 저장 폴더를 오프라인으로 변환한다. `naim/storage/catalog_image_conversion.py`가 카탈로그 JSON, HTML 내 data JSON, CSV examples의 이미지 링크와 해당 image_sha256만 원자 갱신한다. 레시피와 job_sha256, 알 수 없는 필드는 보존한다. 편집·생성이 멈춘 상태에서 사용한다.
- 검증 경계: 격리 `test_*webp*.py`, `test_image_conversion_api.py`, 관련 Daki 읽기 테스트와 `tests/test_gallery_image_tools.js`. 실제 UI는 사용자 자료 없는 합성 서버에서 기존/새 화면, 1280×900·800×900으로 확인한다. 프로세스 강제 종료·전원 손실까지 원자성을 보장하는 다중 파일 트랜잭션은 기존 한계로 유지한다.

| 기능 | 시작 파일 | 유지한 계약 |
|---|---|---|
| 실행 경로와 경로 검증 | `naim/paths.py` | 소스는 저장소 루트, EXE는 실행 파일 폴더; 기존 경로 검증 규칙 |
| 설정 JSON | `naim/storage/json_files.py` | 기존 파일명·키; 부분 저장 시 알 수 없는 키 보존; `naim/paths.py`의 `path_identity_key`로 Windows 일반·확장 경로의 잠금 키 통일 |
| 이력·갤러리 인덱스·가상 폴더 | `naim/storage/history.py` | 기존 SQLite 테이블·컬럼·조회 결과와 `utils.HistoryDB` 호출 |
| 갤러리 검색 | `naim/gallery/query.py` | 정확/부분 일치, AND/OR, 기존 인덱스 의미 |
| 태그·캐릭터 판정 | `naim/tags.py`, `naim/images/characters.py` | 기존 정규화·중복 횟수·캐릭터 매칭 |
| 이미지 메타데이터 | `naim/images/prompt_metadata.py` | 기존 PNG/EXIF/sidecar 우선순위 및 공개 함수 |
| 캔버스 저장본 정규화 | `naim/images/canvas_setups.py` | 기존 저장 상태 구조 |
| 캔버스 공통 그림체 연결 | `static/canvas_style_link.js/.css`, `static/canvas_style_bridge.js` | 모달 갤러리 비교·영역 조정 후 지정, 원문 불변, 선택적 `styleLink`(갤러리 조정은 `style.selection`의 태그·등장차례, 직접 지정은 `library: custom`·`rangeStarts`), 공유·개인 목록의 선택적 `include_prompts=1` |
| 클립보드 I/O | `static/canvas_clipboard.js` | PNG/JPEG/WebP 입력과 내부 복사 유지 |
| 캔버스 참조·디테일 편집 | `static/canvas_reference.js` | 기존 화면·전역 함수·이벤트 계약 |
| 갤러리 인페인트·규칙·업스케일 | `static/gallery_inpaint.js`, `static/gallery_rules.js`, `static/gallery_upscale.js` | 기존 UI/URL/핸들러 유지 |
| EXE 업데이트 | `naim_updater.py` | 기존 manifest와 보호 파일 목록 |
| 업스케일 작업·취소 | `naim/jobs/upscale.py`, `naim/processes.py` | 갤러리 직렬 큐, 캔버스 동기 응답, 기존 엔진 인자 |
| 업스케일 HTTP·종료 | `naim/web/upscale.py`, `naim/web/lifecycle.py`, `naim/server_control.py` | 기존 공개 URL/응답; 자체 서버만 종료 전 취소 |
| 분류 규칙 판정·그림체 변환 | `naim/gallery/rules.py`, `naim/gallery/art_styles.py` | 기존 규칙 형식, 판정 함수명 및 가중치 해석 |
| 인페인트 합성·통신 | `naim/images/inpaint.py`, `naim/novelai.py` | 마스크/합성 방식과 기존 생성·인페인트 요청/응답 |
| 이미지·메타데이터 교체 | `naim/storage/image_files.py` | 기존 확장자·sidecar 형식, 실패 시 원본 복구 |
| 갤러리 관리·선택·날짜 보기 | `static/gallery_managers.js`, `static/gallery_selection.js`, `static/gallery_dates.js` | 기존 DOM 이벤트·공유 상태·저장 키 |
| 캔버스 저장본 UI | `static/canvas_setups.js`, `static/canvas_saved_gallery.css` | 저장본 갤러리·검색·확대·불러오기·이름 변경·삭제 및 브라우저 저장 호환 |
| 기존 프로그램 자료 가져오기 | `naim/storage/legacy_import.py`, `naim/legacy_import_ui.py` | 원본 보존, 현재 자료 백업, 실패 복구, 설정/DB 호환 |
| 캐릭터·copyright 관계 사전과 브랜드 동기화 | `naim/storage/character_copyrights.py`, `danbooru_sync.py` | 기존 브랜드·한글명 보존, 로컬 관계 우선 조회, 누락 시 기존 온라인 조회 |
| 갤러리 화면 배치 | `static/gallery_layout.js`, `static/gallery_modern.css` | modern 단일 화면, 동일 DOM·검색·선택 상태 유지; 이전 화면 선택 키는 사용하지 않음 |
| 이미지 표시용 프리뷰 | `naim/images/previews.py`, `app.py` | 원본 URL·픽셀 보존, OS 임시 디렉터리의 폐기 가능한 512MiB 캐시 |
| 종료한 제작소의 보존 자료 | `naim/storage/legacy_archive.py`, `legacy_generation.html`, `static/legacy_generation.js` | `output`·`daki_generated_temp` 읽기 전용; 기존 두 화면 URL도 자료 화면으로 연결 |

`app.py`, `utils.py`, `image_logic.py`의 기존 함수명은 호환성용 import로 유지한다.
화면 파일은 HTML에 명시된 순서로 로드하며 기존 전역 상태를 공유한다. 아직 ES module 전환이나
서버의 모든 라우트/작업 큐 분리는 하지 않았다. 새 기능은 해당 책임 모듈에서 구현한다.

## 캐릭터·copyright 관계 사전

- 브랜드 동기화는 원본 `danbooru_tags.db`를 읽기 전용으로 열어 캐릭터 태그의 작품명 접미사와 유일한 직접 태그 관계를 확인한다. 접미사 관계는 명시적 연결과 구분해 `tag_name` 출처로 저장하며, 직접 관계가 여러 작품을 가리키면 사전 등록을 보류한다. 원본에 모든 캐릭터의 출연 작품이 연결돼 있다는 뜻은 아니다.
- `naim/storage/character_copyrights.py`는 기존 `TOTAL_CLASSIFIED/naia_history.db`에 추가되는 `character_copyright_relations(character_tag, copyright_tag, source)`만 소유한다. 기존 이력·브랜드·한글명은 일괄 변경하지 않는다. 새 테이블은 기존 이력 DB의 업데이트 보호·자료 가져오기 경로를 함께 사용한다.
- `danbooru_sync.sync_copyrights()`는 저장된 관계를 먼저 조회하고, 누락된 캐릭터에만 기존 게시물 조회와 대표 브랜드 선택 규칙을 적용한다. 온라인에서 찾은 관계는 브랜드와 같은 트랜잭션으로 저장하며 이후 원본 사전 준비가 덮어쓰지 않는다. 조회 실패·미확정 결과는 관계 사전에 저장하지 않아 기존 재시도가 가능하다.
- 검증: `tests/test_character_copyrights.py`, `tests/test_danbooru_sync.py`. `tools/run_isolated_tests.py`로 합성 DB와 모의 온라인 응답을 사용하며 실제 사용자 자료와 외부 조회는 변경하지 않는다.

## 갤러리 최적화와 제작소 종료 (2026-09-05)

- 다키 제작소·그림체 연구소 전용 HTML/JS를 제거했다. `/api/generate`는 외부 통신 없이 HTTP 410과 보존 자료 주소를 반환한다. 캔버스·갤러리 인페인트와 공유 CSS·설정·태그 사전·Anlas·저장·업스케일은 유지한다. 사용자 이미지·설정·DB 변환은 없다.
- 갤러리는 modern 화면만 제공한다. `gallery_layout.js`는 초기화 때 기존 컨트롤·갤러리·Daki 노드를 한 번 이동하며 리스너·선택·필터·이미지 로딩을 보존한다. 이전 `naia_gallery_layout_v1` 값은 읽거나 쓰지 않고 그대로 둔다. 상단 이름·화면 선택 줄은 제거하고 잔액은 이동 버튼과 같은 줄 오른쪽에 둔다. 갤러리·캔버스의 이동 버튼과 캔버스 작업 버튼 모양은 `static/workspace_header.css`가 담당한다.
- 이미지 카드는 긴 변 768px 프리뷰를 쓴다. 확대·저장·캔버스 전달은 원본 URL을 유지한다. 캔버스 전달 시 크기 0은 기존 규칙에 따라 원본에서 EXIF 회전을 반영한 표시 크기를 읽게 한다.
- `static/index.js`의 이미지 렌더는 사용자 배치 크기를 유지하되 한 프레임에 최대 32장씩 추가한다. 화면 변경 때 남은 프레임을 취소하고, 가상 폴더 비동기 준비와 첫 배치가 끝난 뒤 스크롤을 복원한다.
- `HistoryDB.refresh_gallery_folder_summaries()`는 저장 전·후 폴더와 조상만 갱신한다. 전체 인덱스가 준비된 경우에만 사용하며 기존 전체 재계산은 복구·재색인용으로 유지한다.
- 검색 인덱스 의미 버전 갱신은 사용자 프로필의 이름·검색 범위·모드·식별자를 보존한다. 재생성 가능한 결과와 통계만 무효화하며 `tests/test_prompt_profile_migration.py`에서 구버전·버전 표시 누락·재색인 후 재시작을 검증한다.
- 검증 경계: `tests/test_gallery_layout.js`, `tests/test_gallery_rendering.js`, `tests/test_gallery_folder_summaries.py`, `tests/test_image_previews.py`, `tests/test_legacy_archive.py`, `tests/test_generation_transport.py`. 기존 캔버스·가져오기·업데이트 검증도 함께 실행한다.
- 남은 규모 한계: `/api/data`의 전체 목록 응답, 스크롤로 누적된 카드 DOM, 보존 자료의 목록 요청당 파일 탐색은 유지한다. 완전한 서버 페이지 조회·DOM 가상화는 별도 호환성 작업이다. 캐시 용량은 파일 잠금·다중 프로세스 상황에서 일시적으로 상한을 넘을 수 있다.

이번 변경의 검증 결과: 사용자 자료 없는 소스 복사본에서 Python 273개(17.4초), JavaScript 41개를 통과했다. Python 84파일·제품 JavaScript 15파일 구문 검사도 통과했다. 합성 이미지 180장으로 두 화면의 정렬·대표 선택 유지, 768px 프리뷰/원본 확대, 캔버스 원본 가져오기·선택 영역·클립·인페인트 프롬프트, 날짜/가상 폴더, 보존 자료 조회, 360px 도구 메뉴와 모달 겹침을 확인했다. 실제 좌표 클릭으로 중간 이미지의 화면 상단 좌표가 양방향 전환 후 동일하게 유지됨을 확인했다. 과금되는 실제 인페인트 호출과 EXE 재빌드·배포는 실행하지 않았다.

합성 인메모리 SQLite 100개 폴더에서 한 이미지의 수정 시각을 바꾼 후 요약 갱신 중앙값(3회): 1만 장은 전체 206.26ms/증분 0.44ms, 10만 장은 전체 1,368.54ms/증분 1.93ms였다. 결과는 갱신 시각을 제외하고 동일했다. 이 수치는 폴더 요약 연산만 측정한 것으로 앱 전체 성능 배수가 아니다.

## 재현하고 수정한 결함

### 사용성·리모콘·캔버스 재검토 (2026-09-05)

근거 논문, 측정 조건과 남은 과제는 `UX_PERFORMANCE_REVIEW_2026-09-05.md`에 정리한다.

- `main_executor.pyw`: `_launch_job/_finish_job`이 작업 상태·버튼 잠금을 소유한다. 설정은 UI에서 검증 후 워커에 전달한다. 로그는 큐·50ms 배치·최근 5,000줄로 제한한다. `tests/test_desktop_controller.py`가 경계 테스트이며 실제 Tk 테스트는 자식 프로세스로 격리한다.
- `static/canvas_setups.js`: 각 저장 요청 스냅샷과 최신 응답만 반영하여 대기 중 저장의 손실을 막는다. `tests/test_canvas_setups.js`가 연속·실패 응답을 검증한다.
- `static/canvas.js`: 저장 레이어 전체 1회 복제, 마스크 패널 리스너 정리와 프레임 단위 미리보기 병합. `tests/test_canvas_state.js`, `tests/test_canvas_mask_lifecycle.js`에서 저장 형식·추가 필드·입력 좌표·마지막 갱신을 보존한다.
- `static/canvas_dialogs.js`: `canvas.html`의 명시된 주요 모달 5개에만 포커스·Tab·Escape·배경 조작 차단을 추가한다. 실제 표시·저장은 기존 콜백이 소유한다. 번역·그룹 팝업의 전역 단축키 간섭은 `tests/test_canvas_dialogs.js`로 검증한다.
- 갤러리 이전 생성 자료 링크는 디자인 설정의 접힌 항목으로 옮겼다. 갤러리 색상은 중립색 중심으로 사용한다. 렌더링은 최대 32개 제한에 약 8ms 경과 기준을 추가했다.

### 기존 개선 기록

- 선택 영역의 Ctrl+V가 기본 이벤트를 취소하여 외부 이미지가 전달되지 않음: 실제 paste 이벤트의 이미지 파일/items를 우선 처리한다.
- 일반 PNG의 EXIF 조회 후 `verify()`가 실패함: 별도 디코더로 먼저 검증하고 방향·크기를 조회한다.
- 클립보드 한 이미지 표현의 읽기 실패가 나머지 표현도 막음: 다음 지원 표현을 확인한다.
- JSON 직접 덮어쓰기와 고정 임시 파일명: 같은 디렉터리의 고유 임시 파일, flush/fsync, 교체를 사용한다.
- 손상 설정을 빈 값으로 읽고 원본을 덮어씀: 사용자 결정에 따라 원본을 `파일명.corrupt-고유ID.bak`에 백업하고 기본 설정으로 복구한다. 백업 실패 시 원본을 교체하지 않는다.
- EXE 업데이트의 불완전한 백업 상태에서 롤백 정리가 원본까지 삭제함: 백업 단계와 교체 단계를 분리한다. 롤백 실패 시 백업을 보존한다.
- `/api/save` 이미지 sidecar에 인증 키를 복사함: 새 sidecar에는 인증 키를 기록하지 않는다. 기존 설정의 키와 기존 파일은 일괄 변경하지 않는다.
- 동시 시작 요청으로 업스케일 작업 스레드가 중복 생성됨: 시작과 작업 등록을 같은 lock으로 보호한다. 동시 요청 8개로 재현한 회귀 테스트가 있다.
- 출력 없는 외부 엔진에서 취소 확인이 `readline()`에 막힘: 제한 시간의 `communicate()`로 출력 수집과 취소 확인을 함께 처리하고 자식 프로세스·파이프를 정리한다.
- 종료 전에 갤러리 실행/대기 작업과 캔버스 동기 업스케일에 취소를 전달한다. 런처가 생성한 토큰과 PID로 자체 서버만 제어하며 최대 8초 정리를 기다린 뒤 기존 서버 종료 절차로 진행한다. 완료된 결과와 기존 사용자 데이터는 유지한다.
- 동시에 태그를 지정하면 읽기/수정/저장 사이에 다른 요청의 변경이 유실됨: 전체 단계를 같은 JSON lock으로 묶는다. 8개 요청 중 1개만 남는 실패를 재현했고 8개 보존을 확인했다.
- 인페인트 덮어쓰기가 이미지 교체 후 sidecar 저장에 실패하면 원본이 이미 사라짐: 고유 작업 폴더에서 이미지와 sidecar를 준비하고 백업 후 교체한다. 준비/교체 실패 시 원본을 유지·복구하며 복구 실패 시 백업을 남긴다.
- Windows 프로세스 종료 확인에 `os.kill(pid, 0)` 사용: 프로세스를 종료할 수 있는 호출 대신 Windows 프로세스 핸들을 기다린다. 실행 중인 합성 자식 프로세스가 그대로 유지되는 테스트가 있다.
- 다키 생성 자료를 서버 시작/종료 때 통째로 지움: 가져온 생성 자료도 사라지므로 자동 전체 삭제를 제거했다. 목록의 명시적 삭제 기능은 유지한다.

JSON lock은 한 프로세스의 스레드만 조정한다. 여러 프로그램에서 같은 데이터에 동시에 쓰는 경우나
여러 파일을 함께 바꾸는 작업의 트랜잭션까지 보장하지 않는다.

## 기존 사용자 데이터와 EXE

이번 변경은 설치 폴더·설정명·DB 스키마·기존 서버 주소를 바꾸지 않는다.
따라서 우선 전환 경로는 기존 EXE의 프로그램 파일 업데이트다. 설정/이미지/DB를 새로운 형식으로
이동하는 절차는 필요하지 않다. 브라우저 저장 데이터는 기존 브라우저와 주소에서 계속 사용한다.

PyInstaller spec의 `static` 전체 포함 및 정적 Python import로 신규 파일을 패키징한다.
자동 업데이트 보호 파일·이미지·DB가 바이트 단위로 보존되는 합성 설치 테스트가 있다.
새 파일을 기존 작업 폴더에 수동 반영할 때도 `naim/`과 새 `static/*.js`를 함께 전달해야 한다.
보관된 v1.1.0/v1.1.1/v1.2.0 EXE 설치 압축본을 임시 폴더에 풀고 최신 updater 코드로 새 빌드를
적용하여 합성 설정·이미지·TXT·JSON·DB의 바이트 보존을 확인했다. 전환 후 EXE 서버도 실행했다.
기존 updater UI에서 배포 서버를 통한 다운로드까지 수행한 검사는 아니다.
릴리스 버전·manifest·배포 서버는 변경하지 않았다.

### 기존 폴더 전체에서 가져오기

컨트롤러의 **기존 프로그램 자료 가져오기**를 누른다. 작업 중에는 사용할 수 없으며 컨트롤러와
서버를 종료한 뒤 별도 가져오기 창을 연다. **EXE가 있는 예전 프로그램 폴더 전체**를 선택하면
가져올 파일·폴더 목록이 표시된다. `data`만 선택하는 방식이 아니다.

- `TOTAL_CLASSIFIED`: 이미지, 분류 TXT/JSON, 분류/갤러리/가상 폴더 DB.
- 프로그램 폴더의 설정 JSON: 그림체·작가·태그·캔버스 저장본·생성 설정 등 기존 사용자 파일.
- `canvas_imports`, `output`, `daki_generated_temp`: 저장본이 참조하는 이미지와 생성 자료.
- `data/tag_categories_ko.json`: 사용자 태그 사전 보정. EXE와 배포 사전·엔진은 가져오지 않는다.

원본은 그대로 두고 복사한다. 현재 프로그램의 대응 자료는 `import-backup-고유ID`에 보존한 뒤
교체한다. SQLite backup API로 커밋된 WAL 기록을 포함하며, 가져온 복사본의 알려진 절대 경로
(휴지통 원래 위치·설정의 입력 경로 등)만 새 위치로 변경한다. 외부 폴더 경로는 유지한다.
가져오는 동안 두 프로그램의 서버를 꺼야 한다. 복사·교체 실패는 되돌리고 복구 자체에 실패하면
백업과 작업 폴더를 보존한다. 전원 차단 수준의 트랜잭션은 보장하지 않는다.
완료 후 **프로그램 열기**로 시작한다. 브라우저에만 있는 화면 상태는 같은 브라우저/주소가 필요하다.

### 갤러리 PNG의 WebP 압축

리모콘의 **WebP 압축**에서 전체 `TOTAL_CLASSIFIED`의 PNG(하위 폴더·휴지통·업스케일 포함)를 처리한다.
웹 서버를 중지한 상태에서 무손실 또는 손실 화질을 고른다. **예상 용량 계산**은 최대 8장의
분산 표본을 실제로 인코딩·검증하고 임시 출력만 지운다. 전체 PNG의 전후 예상 용량·절약률을
표시하며, 실제 실행 결과는 성공적으로 변환한 파일의 전후 용량·절약률을 따로 집계한다.

**새 분류 후 자동 WebP 변환**은 기본적으로 꺼져 있다. 분류 화면에서 사용 여부·무손실/손실·화질을
선택하고 분류 설정과 함께 저장한다(`classify_settings.auto_webp`, `webp_lossless`, `webp_quality`).
`image_logic.process`는 이번에 복사/이동에 성공한 PNG만 수집해 이력·갤러리 인덱스 저장 후
`compress_classified_pngs`에 넘긴다. 복사 모드의 입력 원본은 유지하며 코믹 중복 검사는 압축 전에 끝낸다.
재정렬에는 적용하지 않고, 자동 변환을 켠 새 분류는 웹 서버를 중지한 상태에서 실행한다.
검증은 `tests/test_webp_classification.py`, `tests/test_webp_jobs.py`, `tests/test_desktop_controller.py`.

- `naim/webp_compression_ui.py`: 선택·예상·실행·중지 UI. `main_executor.pyw`가 작업 충돌과 종료 대기를 연결한다.
- `naim/jobs/webp_compression.py`: 재귀 수집·표본 추정·진행 집계와 변환/참조 갱신 연결. CPU 수에 따라 최대 8개를 동시 처리한다. Windows 가용 메모리 절반을 픽셀당 96바이트로 추산해 동시 픽셀 한도를 정하고, 최대 64Mi 픽셀로 제한한다. 메모리 조회 실패 시 기존 4개/16Mi 픽셀 제한을 사용하며, 한도 초과 이미지는 단독 처리한다. 중지 시 새 작업을 시작하지 않고 진행 중 작업의 정리를 기다린다.
- `naim/images/webp_conversion.py`: 픽셀·알파·메타데이터 검증 후 선택한 방식에 따라 PNG를 유지하거나 삭제한다. EXIF/ICC/XMP와 전체 PNG 청크 정보를 WebP에 보관한다. PNG 고유 항목은 버전이 있는 `NAIM` 청크에 담고 `image_logic.py`의 공통 읽기 경로에서 복원한다. 외부 프로그램의 PNG 고유 항목 표시는 보장하지 않는다.
- `naim/storage/webp_conversion.py`: DB 행·태그·기존 해시 이력 보존과 실패 복구. 추가 테이블 `gallery_webp_conversions`가 변환된 PNG 주소를 WebP에 연결하여 `app.py`의 이미지 제공·캔버스 읽기 경로를 유지한다. 같은 이름의 JSON/TXT는 바꾸지 않는다.

속도 우선으로 무손실은 WebP method=1, 손실은 method=0을 사용하며 손실 화질 선택은 유지한다. 손실 인코딩에서 오류 6(제어 파티션 한도 초과)이 발생할 때만 같은 화질·크기의 method=4로 한 번 재시도한다. 최종 인코딩 오류는 건너뜀이 아닌 실패로 집계하고 원본을 보존한다.
인코딩·검증은 병렬로 실행하고, 게시·DB/태그 갱신·PNG 삭제·롤백은 공통 잠금 안에서 직렬 처리한다.
태그 JSON은 배치별 캐시로 반복 파싱을 줄이고 불필요한 공백 없이 직렬화하며 외부 변경을 감지한다.
값과 스키마는 유지하고 변경 사항은 매 이미지마다 저장한다.

기존 WebP와 이름이 겹치거나, 16비트·애니메이션·지원 크기 초과·손상 파일 등 보존 검증을
통과하지 못하면 PNG를 남기고 이유를 표시한다. 파일 게시에 하드 링크가 필요하며 미지원
파일시스템에서는 원본을 유지한다. 복구는 정상 실행 중 예외를 대상으로 하며 전원 차단을
포함한 다중 파일 트랜잭션을 보장하지 않는다. 회귀는 `test_webp*.py`와 `test_desktop_controller.py`.

## daki 프로젝트 (2026-10-12)

- 화면은 `index.html`의 `#dakiLibrary`, `static/daki.js`, `static/daki.css`. 갤러리 헤더·라이브러리·카드 스타일을 공유하며 `static/gallery_layout.js`가 modern 화면에 한 번 배치한다. `#daki`·`#project=...`에서 후보를 표시하고 `#gallery`로 기존 갤러리 DOM·선택 상태에 복귀한다. `/daki`도 공통 HTML을 제공한다. 우클릭·설정 연결은 `static/index.js`, 확대 보기 삭제 연결은 `static/gallery_zoom.js`에 있다.
- API는 `naim/web/daki.py`, 프로젝트·앞뒤 후보·사용 설정 저장은 `naim/storage/daki_projects.py`가 소유한다. `app.py`는 `/daki` 페이지, 원본의 정확한 갤러리 경로 해석, 기존 세 삭제 API의 확인 경고를 연결한다. 기존 등급 폴더의 동명 이미지로 대체하지 않으며 PNG→WebP 별칭만 유지한다.
- `daki_projects.json`은 원본 상대경로만 기록한다. 같은 면의 동일 원본은 중복 추가하지 않으며, 후보에서 제외해도 원본은 보존한다. 비활성화는 메뉴를 숨기고 데이터와 삭제 경고를 보존한다. 원본의 일반 이동·재분류·외부 삭제를 추적하지 않으므로 다음 조회에서 누락을 표시한다.
- `.gitignore`, `naim_updater.py`, `tools/build_exe_release.ps1`은 프로젝트 JSON을 사용자 자료로 보호한다. 기존 자료 가져오기는 updater 보호 파일 목록을 재사용한다.
- 검증: `python -B tools/run_isolated_tests.py 'test_daki*.py'`, `python -B tools/run_isolated_tests.py test_gallery_zoom_actions.py`, `python -B tools/run_isolated_tests.py test_naim_updater.py`, `python -B tools/run_isolated_tests.py test_legacy_import.py`. JS는 `node --test tests/test_daki.js tests/test_gallery_zoom.js tests/test_gallery_layout.js tests/test_gallery_rendering.js tests/test_gallery_script_loading.js`.

### 공유 그림체 비교 생성

- 공유 그림체 루트의 `공유 그림체 최신화`는 `static/daki_style_sync.js`의 기간 선택·Chrome 확장 연결 안내·진행/중지 UI와 `naim/web/daki_style_sync.py`의 `/api/daki/shared-styles/sync` GET/POST·stop POST·extension ZIP GET을 사용한다. `static/arca_session_bridge/` v1.1.1은 팝업을 열 때 NAI Image Manager(5000)와 NAImakeArtistGroup(5001)의 `/api/arca-styles/browser-session` GET으로 메모리 연결 상태만 조회한다. 실제 쿠키 전송은 사용자가 로그인 연결을 누를 때 `/api/arca-styles/browser-session/extension` POST로 수행하며 앱별 성공·오류·시간 초과를 표시한다. 상태 GET은 loopback과 브리지 마커가 필요하고 Origin이 있으면 Chrome 확장만 허용한다. 쿠키 POST·OPTIONS의 기존 Origin 검증은 유지한다. 한 앱의 실패는 다른 앱의 연결을 막지 않는다. 세션은 메모리에만 보관하며 NAIM은 새 세션 검증 성공 시에만 기존 세션을 교체한다. 도움말 제목·다운로드·설명은 `static/daki.css`의 전용 help-body/download 배치로 분리한다.
- `naim/arca_shared_styles.py`는 NAI·🔞 NAI에서 제목을 ‘그림체’로 검색한 뒤 제목에 ‘그림체’와 ‘공유’가 모두 있는 글만 받는다. 기간·분류를 다시 검사한 후 PNG/WebP를 최대 6개씩 병렬 다운로드하며 본문 순서대로 처리한다. 스레드별 HTTP 연결을 재사용하고 게시판/CDN 세션은 분리한다. `naim/shared_style_recipe.py`와 `_shared_style_*`는 기존 V2 규칙의 그림체 추출·가중치·fingerprint를 소유한다. 작가 이름 데이터는 `data/shared_style_artists.json`이다. 대상은 V5 Full과 Full Medium이며 원본 설정이 불완전하거나 실사·중복인 자료는 제외한다.
- 로그인 검증은 참고 프로그램처럼 최초 게시판의 NAI·🔞 NAI 분류 발견을 기준으로 한다. 같은 HTTPS 호스트의 게시판 주소 이동은 제한 횟수 안에서 허용하고, 정상 게시판에 포함된 CAPTCHA 스크립트만으로 차단 페이지라고 판정하지 않는다. 브리지 응답은 통제된 `ArcaSharedError`의 code/message(HTTP 거부·브라우저 확인·분류 없음·시간 초과·TLS·네트워크)를 표시하며 원시 requests 예외나 쿠키를 노출하지 않는다.
- 이미지 원본 요청은 `ac.namu.la`·`ac.arca.live`·`ac-o.arca.live` 사이의 HTTPS 주소 이동을 허용하고 모두 같은 이미지 식별자로 정규화한다. `ac-o.arca.live`는 실제 원본 다운로드의 이동 대상으로 확인되었다. 브라우저 쿠키는 `arca.live`와 허용된 Arca 하위 도메인에 도메인 범위가 맞을 때만 전달하고, 호스트 전용 쿠키는 정확히 일치할 때만 전달한다. `ac.namu.la`에는 Arca 쿠키를 보내지 않는다. 주소 이동마다 범위를 다시 검사하며 HTTP 거부·차단 오류에는 요청 단계·상태/사유·도메인만 표시한다. 실패 상태에는 수집 중단 안내를 표시하고 실행 중인 작업에만 창을 닫아도 계속된다고 안내한다.
- HTTP 세션은 참고 수집기의 `Retry(total=3, connect=3, read=3, status=3, backoff_factor=0.5)` 설정과 GET의 429·500·502·503·504 재시도를 사용하고 서버 `Retry-After`를 따른다. 재시도 소진 후 응답을 받아 통제된 오류로 표시하도록 `raise_on_status=False`만 다르며, 최종 429는 로그인 오류 대신 요청 제한으로 안내한다. 별도 요청 간격·공유 대기 정책은 추가하지 않는다.
- 참고 수집기처럼 `type=orig`는 `ac.namu.la`에만 지정하며 `ac.arca.live`·`ac-o.arca.live`의 게시된 URL/쿼리는 그대로 사용한다. 이미지의 `data-original`·`data-src`·`src`를 모두 후보로 검사하고 기존 식별자로 중복 제외한다. 이미지별 통제된 오류는 다음 이미지로 진행하되 `sync_job.json`의 `failed_images`·`last_image_error`로 기록하고 화면에 `수집 완료(일부 이미지 실패)`로 표시한다. 실패한 이미지는 성공 목록에 넣지 않아 같은 기간의 다음 실행에서 다시 시도한다. 예상 밖 내부 오류·게시글/목록 요청 실패는 계속 전체 작업 실패로 처리한다. 확장은 로그인 정보 전달을 담당하고 실제 검색·다운로드는 Python 수집기가 담당한다.
- 최신화 GET/POST 응답의 `defaults`는 활성 그림체의 최신 게시일(당일 포함)~오늘을 제공한다. `naim/storage/daki_style_dates.py`는 저장한 `source_posted_at`을 우선하고, 예전 그림체는 검증된 공개 seed DB의 URL·게시일만 담은 `data/shared_style_post_dates.json`으로 보완한다. 모달 최초 GET에서만 날짜를 채우며 사용자 입력·연결 재확인·폴링은 날짜를 덮어쓰지 않는다. 게시일이 없으면 오늘을 사용한다.
- `Hugging Face 새 그림체 추가`는 동일 POST에 `source: "huggingface"`와 선택적 `filters`를 보내며 로그인·기간을 요구하지 않는다. `naim/daki_style_archive.py`는 저장소의 `main` 리비전을 조회하고 그 리비전의 `archive_info.json`과 LFS 크기·SHA를 대조한 뒤 같은 리비전의 ZIP을 받는다. `sync/downloads/<sha256>/`에서 이어받고 ZIP 전체·개별 SHA와 매니페스트를 검증한다. 버전이 달라진 파일의 부분 다운로드는 섞이지 않는다.
- `naim/daki_style_filters.py`는 두 수집 경로에 공통으로 `exclude_realistic`(기본 true), 선택적 `include_query`(최대 20,000자·검색어 100개·각 200자), `exclude_tags`(최대 100개·각 200자)를 검증한다. 포함은 `naim/gallery/query.py`를 재사용해 쉼표/공백/줄바꿈 AND, `||` OR, `%문구%` 부분 일치를 원본 긍정 프롬프트에 적용한다. 제외는 정확한 태그를 우선 비교한다. 기존 `include_tags`/`include_mode` 호출·저장값은 유지하며 화면은 같은 의미의 검색식으로 복원한다. 두 경로의 필터 입력은 독립적이며 포함/제외 버튼은 표시만 전환하고 두 값을 함께 전송한다. 필터 제외 이미지는 아카라이브의 처리 완료 목록에 넣지 않아 조건을 바꿔 재시도할 수 있다.
- `DakiStyleSync._collect_huggingface`는 기존 V5(수동 제외 포함)와 팩 내부의 그림체·픽셀 중복을 건너뛰고 새 항목만 준비한다. 같은 게시물의 이미지도 각자 판정하며 상반신은 V5 중복 비교에서 제외한다. 모든 입력 검증 후 원자 반영하고 `updated`는 0을 유지한다. 기존 항목·이미지·제외 목록·알 수 없는 필드는 보존하며 직전 목록은 `sync_catalog.before-huggingface.json`으로 보관한다. 새 반영은 `huggingface.update_mode: "append"`를 기록하고 과거 `active_style_ids`를 제거하여 기존 V5를 다시 표시한다. 과거 활성 목록의 읽기 호환과 이전에 저장된 동일 V5 ID의 sync 항목 우선순위는 유지한다. `allow_realistic: true`는 실사 포함을 허용하며 직접 제외한 항목은 계속 숨긴다.
- `static/daki_style_sync_activity.js`는 모달이 닫힌 동안 상태를 조회해 기존 왼쪽 아래 작업 패널에 진행·완료·실패를 표시한다. 모달이 열리면 조회를 넘기고 오래된 응답을 무시한다. 시작 응답이 닫힌 뒤 도착해도 추적하며 페이지 재진입 시 진행 중 작업을 복원한다. `gallery_index_jobs.js`는 갤러리·프롬프트·공유 그림체 카드의 공통 패널 표시 여부를 조정한다. 검증: `test_daki_style_sync_activity.js`, `test_daki_style_sync.js`, `test_gallery_index_jobs.js`.
- HF 진행의 선택적 `phase`는 resolve/download/verify/recommendation_download/recommendation_verify/recommendations/inspect/publish/complete로 구분한다. 바이트 단계는 `phase_current`/`phase_total`, 검사 단계는 `processed_images`/`total_images`를 사용한다. `naim/daki_style_archive.py`는 실제 다운로드·해시 검증량과 팩의 전체 이미지 수를 제공하고 `DakiStyleSync`는 추가 준비·필터·중복·게시물 제한 처리가 끝난 이미지마다 검사 수를 증가시킨다. 목록 반영은 별도 단계이며 단계별 100%가 전체 작업 완료를 뜻하지 않는다. 모달과 진행 카드는 `DakiStyleSync.jobProgress`를 공유하고 전체 수 없는 이전 작업·아카라이브에는 진행률을 추정하지 않는다.
- 가져오기 중복 비교는 `naim/shared_style_recipe.py`의 `style_duplicate_key`가 소유한다. 긍정 프롬프트에서 작가 이름 전체를 정규화·중복 제거·정렬한 조합을 비교하며 순서·가중치·화풍 수식·품질·네거티브 차이를 무시한다. 작가가 없으면 품질·연도 태그를 제외한 식별 가능한 화풍 태그 조합을 비교하고, 품질 태그만 남는 등 식별 가능한 태그가 없으면 가져오지 않는다. `load_style_artist_names`는 가져오기당 한 번 번들 작가 사전과 앱 태그 DB의 작가(category=1)를 읽어 접두어 없는 작가도 식별한다. 선택적 DB가 없으면 번들 사전을 쓰며, 존재하는 DB를 읽지 못하면 반영 전에 오류로 끝낸다. 기존 V5의 수동 제외·과거 목록과 같은 실행의 신규 항목에도 적용하고 상반신은 새 조합 비교에서 제외한다. 기존 `recipe_fingerprint`, ID, 원문·가중치, 이미지·테스트 참조는 바꾸지 않고 비교용 조합을 메모리에서만 만든다. 회귀: `test_shared_style_recipe.py`, `test_daki_style_sync.py`.
- 선택적 `filters.low_recommendation_limit`은 null/생략이면 끄기, 0~9007199254740991의 정수이면 해당 추천수 이하 게시물당 V5 그림체 하나를 허용한다. 기존 V5 항목(수동 제외 포함)이 있는 게시물도 한도를 소비하며 상반신은 별도다. 새 게시물에서는 필터·중복·설정 검사를 통과해 실제 준비/저장한 첫 항목이 한도를 소비한다. 추천수 미확인은 제한하지 않고, 한도로 제외한 이미지 수는 `job.post_limited`로 보고한다. HF 기본 공급자는 이 옵션을 켰을 때만 `iter_archive_images(include_recommendations=True)`로 게시물 정보를 요청한다.
- 추천수 자료는 같은 리비전의 `archive_info.json.seed_sha256`과 LFS 크기·해시를 대조한 `arca_style_seed.sqlite`이다. 다운로드와 캐시 검증은 기존 제한된 HF 다운로드 경계를 재사용한다. DB는 읽기 전용으로 `arca_style_items`의 게시물 URL·추천수만 읽고 이미지에 연결한다. 요청한 추천수 자료의 다운로드·검증·읽기가 실패하면 반영 전에 실패하여 기존 목록을 보존한다. 원본 DB나 기존 그림체의 생성 설정은 수정하지 않는다.
- 작업의 `prepared`/`filtered`는 준비 진행률이고 `added`/`updated`는 최종 게시 후 집계한다. `published: false`인 실패·중지는 기존 일람을 유지한다. 재시작 때 중단된 작업의 게시 여부는 null로 표시한다. 두 가져오기는 같은 작업 슬롯·중지 기능을 쓰며 화면을 닫아도 작업은 계속된다. 실제 이미지팩 갱신은 사용자가 버튼을 눌러 실행한다.
- `naim/daki_style_sync.py`는 백그라운드 수집과 원자 게시를 담당한다. `daki_imported_styles/sync_catalog.json`, `sync_job.json`, `sync/images`, `sync/thumbs`는 기존 자료 보호·가져오기 폴더 안에 저장한다. `seen_images`에 성공적으로 가져온 이미지 식별자가 있으면 Arca 다운로드 전에 제외하며, 아직 가져오지 않은 자료의 규칙 판정은 재시도할 수 있다. 진행 문구는 분류·검색 페이지·이미지 다운로드/메타데이터 단계에 맞춰 갱신한다. `source_image_root: "."`는 설치 폴더 이동을 지원하며, 기존 카탈로그·삭제 목록·테스트 스냅샷은 재작성하지 않는다. 중단 전 게시한 자료는 보존하고 앱 재시작 후 중단된 작업은 명시 재실행한다.
- 검증: `tests/test_arca_shared_styles.py`, `tests/test_shared_style_recipe.py`, `tests/test_daki_style_sync.py`, `tests/test_daki_style_sync.js`, `tests/test_arca_session_bridge.js`, 기존 공유 카탈로그·테스트 API/JS 회귀. Python은 격리 실행기로 실행한다. 실제 로그인·사이트 응답과 확장 설치는 별도 확인 범위다.
- 최신 팩·필터·날짜 회귀: `tests/test_daki_style_archive.py`, `tests/test_daki_style_filters.py`, `tests/test_daki_shared_styles.py`, `tests/test_daki_style_dates.py` 및 `tests/test_daki_style_sync.py`/`.js`. 합성 ZIP·HTTP 응답과 이미지로 최신 버전 고정·이어받기·실패/중지 보존·필터 재평가·안전한 목록 교체를 확인한다. 공개 날짜 asset은 EXE spec과 격리 실행기에 함께 포함한다.
- 최신화 창은 Hugging Face/아카라이브를 두 열로 표시하며 입력 예시와 연결 도움말은 한 번에 하나씩 펼친다. 1280×900·800×800에서 기본·진행·완료·오류·빈 결과와 펼친 도움말의 가로/세로 넘침을 확인한다. 가상 폴더 생성·편집의 검색 문법 설명은 `index.html`과 `static/index.css`에 있으며 실제 검색 규칙은 기존 `naim/gallery/query.py`를 유지한다.

- NovelAI 키·잔액은 `naim/novelai_account.py`가 소유한다. `lab_config.json`의 기존 `key`만 원자적으로 병합하고 나머지 설정을 보존한다. `naim/web/novelai_account.py`의 `GET /api/novelai/account`는 마스킹된 키 상태·Anlas·남은 할당량만 반환하고, `PUT /api/novelai/key`로 키를 교체/삭제한다. 실제 키는 서버의 Authorization 헤더로만 전송한다. 조회는 60초 캐시·동시 요청 병합·키 변경 시 무효화를 적용하며 없는 잔액은 null이다. 기존 `/api/anlas` 응답 형식도 유지한다.
- `static/novelai_account.js`/`.css`는 갤러리 공통 상단 헤더와 기존 설정 창을 연결한다. 보이는 화면에서 1분 간격 조회·수동 갱신을 제공하고, 키 교체 이전 응답은 버린다. 실제 저장된 키를 입력창에 채우지 않으며 저장/닫기 후 초안을 지운다. 회귀: `python -B -m unittest tests.test_novelai_account`, `node --test tests/test_novelai_account.js`. 실제 계정 검증은 생성 없이 구독 조회만 수행한다.

- `static/daki_styles.js`는 공유 그림체 루트의 테스트 생성·기록, V5 원본 그림체 일람(`category=all`)·상반신 테스트 연결, 일람의 검색·다중 선택·삭제, 프롬프트·모델 입력, 한 장/남은 전체/중지, 생성 결과 증분 갱신을 담당한다. 일람과 상반신은 섞지 않으며 기존 `category=v5` 주소는 호환한다. `static/daki.js`의 `createGrid`, `folderCard`, `bindImage`가 실제 갤러리 카드·열 배치·확대·우클릭·태그를 재사용하며 `static/index.js`의 `getGalleryGridLayout`으로 배율과 고정 크기 설정을 공유한다.
- `naim/storage/daki_shared_styles.py`는 형제 `dakiMaker/research/style-catalog`의 `default_styles.json`, `source_generation_options.json`, `generation_manifest.json`을 읽는 독립 어댑터다. 원본은 수정·복사하지 않는다. 포지티브의 실사 태그만 제외하며 원본 옵션·미리보기 크기·시드를 보존한다. `app.py`의 `DAKI_SHARED_STYLES_DIR`이 연결 경계를 소유한다.
- `naim/daki_style_tests.py`는 불변 원본 설정 스냅샷, 순차 작업과 중지, 재시작 복구, PNG·WebP/미리보기 저장을 담당한다. `naim/web/daki_styles.py`가 HTTP를 연결하며 실제 텍스트 생성 통신은 `naim/novelai.py`의 별도 함수다. 기존 종료된 `/api/generate` 및 인페인팅 계약은 유지한다.
- 기존 `category=upper` 주소는 `POST /api/daki/style-tests/upper`로 상반신 결과를 한 번만 일반 테스트로 연결한다. `DakiSharedStyles.upper_test_source`가 현재 보이는 상반신의 원본 생성 요청·공통 설정을 읽고, `DakiStyleTests.ensure_upper_test`가 고정 ID와 `origin: shared_upper`로 완료 항목을 저장한다. `legacy_preview` 항목은 원본 미리보기를 참조하며 원본 파일을 수정·복사하거나 다시 생성하지 않는다. 이후 같은 주소는 저장된 테스트를 재사용하고 루트에는 테스트 폴더 하나만 표시한다. 새 그림체는 기존 중복 판정과 추가 API로 대기 목록에 넣고, 대기 항목의 모델·프롬프트를 수정한 뒤 별도 생성한다. 검증: 공유 카탈로그·테스트·API Python 테스트, `test_daki_styles.js`; 합성 화면은 1280×900과 800×800에서 확인한다.
- 테스트 설정의 `output_format`은 `png`/`webp`다. 새 화면 기본값은 WebP(손실 품질 90)이며 기존 배치·형식 없는 API 생성 요청은 PNG를 유지한다. 설정 수정은 대기 항목의 형식만 바꾸고, 생략하면 현재 형식을 유지한다. 완료·실패 항목은 원래 형식을 보존하며 추가 그림체는 현재 형식을 따른다. JPEG 미리보기와 PNG 모양 가상 참조는 유지한다.
- WebP는 PNG 저장 후 기존 `convert_png_to_webp`로 메타데이터를 보존·검증하고 변환한다. 서버 생성은 순차, 로컬 변환은 별도 1개 작업자로 병행하며 미완료 변환은 최대 2개다. 항목 `converting`과 응답의 동명 수량을 표시하고 중지·완료는 받은 이미지의 변환까지 기다린다. 변환 실패는 PNG와 `conversion_error`를 남긴 완료 결과로 처리하여 다시 생성하지 않는다. 재시작 시 변환 중이던 저장 이미지를 복구하고 PNG만 남으면 경고한다. 회귀: `tests/test_daki_style_test_webp.py`, 기존 `test_daki_style_tests.py`, `test_daki_styles_api.py`, `test_daki_webp.py`, `tests/test_daki_styles.js`.
- 기존 `/style-tests/<id>/run`의 `mode=retry_failed`는 실패 항목만 명시적으로 다시 생성한다. 저장된 항목별 payload와 새 시드·현재 저장된 키를 사용하고 완료·대기 항목은 건드리지 않는다. 실패 항목에도 Anlas 동의를 검증하며 재실패 시 즉시 중지한다. UI의 **실패한 그림 다시 생성** 버튼은 대기 항목이 0개여도 사용할 수 있다. 회귀는 기존 `test_daki_style_tests.py`, `test_daki_styles_api.py`, `test_daki_styles.js`에 둔다.
- 크기 프리셋·검증 한계는 `naim/daki_style_tests.py`의 `SIZE_PRESETS`/`SIZE_LIMITS`가 소유하고 `GET /api/daki/style-tests/options`로 제공한다. NAIA의 Small/Normal/Large/Wallpaper 30개와 Daki 5개(320×1024, 512×1664, 640×2048, 960×3072, 1024×3072)를 로컬에 보관하여 다른 앱 설치에 의존하지 않는다. 생성 크기는 최소 64·64배수, 총 3,145,728픽셀 이내다. `max=49152`는 총 면적÷최소 반대 변에서 도출한 입력 상한이다. 2026-10-12의 [NovelAI 공식 크기 모듈](https://novelai.net/_next/static/chunks/1601-acc34459bdce34e2.js)과 [생성 직전 검사](https://novelai.net/_next/static/chunks/2952-8caf894fb1bb5206.js)에서 확인한 화면 정책이며 유료 API 수락을 실험한 값은 아니다. `static/generation_settings.js`의 `formatGenerationSize`가 축약 비율과 소수점 두 자리의 `1:높이/너비`를 표시하며 960×3072는 정확한 5:16 최대, 1024×3072는 최대 면적으로 구분한다. 배치 `width`/`height`는 둘 다 null이면 원본 크기이며 이전 저장본도 같은 의미로 읽는다. `POST /api/daki/style-tests/<id>/settings`는 실행 중 수정을 거부하고 대기 항목만 원본 스냅샷에서 재구성한다. 완료·실패 항목의 요청·시드·이미지는 유지하고 응답의 항목별 `model`/크기는 실제 요청을 따른다. 검증: `tests/test_daki_style_tests.py`, `tests/test_daki_styles_api.py`, `tests/test_daki_styles.js`, `tests/test_generation_settings.js`, `tests/test_daki_draft_editor.js`.
- 공통 프롬프트·모델·출력 크기·저장 형식을 수정할 수 있고 나머지 원본 옵션을 요청에 반영한다. 원본 시드는 이미지 정보로만 보관하며, 실제 요청 직전에 새 무작위 시드를 배치에 저장하고 결과 PNG·WebP에도 기록한다. 과거에 준비한 대기 항목의 고정 시드도 요청 시 교체한다. V5 Full/V4.5 Full을 지원한다. 완료된 항목은 다시 생성하지 않으며 요청 중 종료/오류가 나면 자동 재요청 없이 다음 대기 항목만 진행한다. `daki_style_tests`의 배치 JSON·PNG·WebP·썸네일은 업데이트/가져오기 보호 대상이다.
- `tools/import_daki_v5_styles.py`는 그림체 생성 프로젝트의 V5 자료를 읽어 `daki_imported_styles/catalog.json`과 썸네일을 만든다. 원본 경로는 로컬 manifest에만 저장하고 원본 DB·이미지는 수정하지 않는다. 기존 추출 규칙과 실사 제외를 적용하고 스타일 지문·동일 픽셀로 중복을 검사한다. 기존 중복 ID는 목록에서 숨기되 저장된 테스트와 직접 조회의 호환성을 유지한다. 어댑터의 `imported_root_provider`로 연결하며 이 폴더도 업데이트/가져오기 보호 대상이다.
- 일람의 `POST /api/daki/shared-styles/remove`는 선택한 `style_ids`를 전부 검증한 후 `daki_imported_styles/excluded_styles.json`에 원자 저장한다. `DakiSharedStyles.list_styles()`에서 제외하므로 목록과 이후 준비하는 테스트에 함께 적용된다. `get_style`·미리보기·기존 배치 스냅샷은 유지한다. 가져오기 manifest와 분리하여 다시 가져와도 사용자 삭제를 유지한다. 관련 검증은 `test_daki_shared_styles.py`, `test_daki_styles_api.py`, `test_daki_styles.js`.
- `naim/daki_image_refs.py`는 `__daki_shared__/<id>.png`, `__daki_tests__/<batch>/<id>.png` 참조를 엄격하게 해석한다. `app.py`의 이미지 제공·프롬프트·탐색기·캔버스 읽기·프로젝트 후보에만 연결하며 일반 갤러리 삭제/덮어쓰기 경로를 확장하지 않는다. 인페인트·업스케일은 캔버스로 가져와 작업한다.
- 검증: 격리 `test_daki*.py`, `test_generation_transport.py`, `test_naim_updater.py`, `test_legacy_import.py`; JS `tests/test_daki_styles.js`와 기존 daki/갤러리 테스트. 테스트는 합성 이미지·모의 생성기를 사용하며 실제 NAI 사용량을 소모하지 않는다.

### 이름 있는 테스트·개인 그림체·태그 비교

- `naim/daki_style_tests.py`의 상세 응답 `missing_shared_style_ids`는 현재 활성 공유 그림체 중 기존 테스트에 없는 ID다. 개인 테스트는 빈 목록, 카탈로그 읽기 실패는 `null`이며 요약 목록은 이 필드와 추가 조회를 생략한다. `static/daki_styles.js`의 ‘새 공유 그림체 N개 추가’는 기존 styles POST로 해당 ID를 현재 설정의 대기 목록에 넣고 생성 관리를 펼친다. 생성은 ‘남은 그림체 모두 생성’으로 별도 실행하며 완료 결과는 보존한다. 검증: `test_daki_style_tests.py`, `test_daki_styles_api.py`, `test_daki_styles.js`.
- `static/daki_styles.js`는 테스트 이름과 완료 대표 그림으로 갤러리 폴더를 표시한다. 이전 이름 없는 배치는 생성 시각으로 표시하며 `library`가 없는 배치는 공유 그림체로 읽는다. `static/daki_test_library.js/.css`가 이름 변경과 공유·개인 그림체 선택 추가 대화상자를 소유한다. `PUT /api/daki/style-tests/<id>/name`, `POST /api/daki/style-tests/<id>/styles`는 기존 완료 결과를 유지하고, 추가 항목만 현재 테스트 설정의 대기 목록에 넣는다. 실행 중 추가는 거부하며 생성은 별도 버튼으로 시작한다. 목록은 독립 조회하여 한쪽이 없어도 다른 쪽 그림체를 추가할 수 있고, 모달에서 새 개인 그림체를 등록하면 목록을 갱신해 선택한다.
- `static/daki_test_targets.js/.css`는 새 테스트의 전체·태그·월드컵 순위·갤러리 대상 선택을 소유한다. 공유 폴더의 새 테스트는 `category=v5`인 공유 그림체 일람만 전달하며 상반신과 카테고리가 없는 기존 상반신은 제외한다. 전체 선택도 화면의 `style_ids`를 명시하여 서버의 통합 카탈로그로 범위가 넓어지지 않게 한다. `static/daki_test_target_gallery.js/.css`는 현재 대상 조건에 맞는 그림체의 포함·제외 태그 및 최소 추천수 필터, 기본·추천수·날짜·이름 정렬, 사각형 영역 추가 선택, 일괄 선택과 개별 해제, 선택 적용을 담당한다. 기존 테스트 태그를 기준으로 열면 해당 완료 결과 그림을 표시하며, 적용 후 다시 열어도 원래 대상 범위에서 재선택할 수 있다. 추천수·날짜 미상은 정렬에서 뒤로 보내고, 최소 추천수가 있으면 추천수 미상은 제외한다. 비저장 POST `/api/daki/style-tests/targets/filter`는 `naim/web/daki_styles.py`에서 기존 `normalize_style_filters`·`matches_style_filters`를 재사용하며 가져오기의 실사 제외·게시물당 추천수 제한은 적용하지 않는다. 최소 추천수 필터와 정렬은 전달받은 대상 메타데이터에 화면 안에서 적용한다. 태그 기준은 대표 그림 또는 선택한 기존 테스트의 완료 결과이며, 월드컵 기준은 사용자가 고른 기록의 N위 이하(공동 순위 포함)다. 현재 라이브러리의 활성 그림체 ID로 한정하고 중복은 제거한다. `static/daki_styles.js`는 대상 수를 표시하고 미선택·조회 실패·0개일 때 준비를 막으며, 선택된 `style_ids`만 생성 API에 보낸다. `naim/daki_style_tests.py`의 create는 ID 생략 시 기존 전체 동작을 유지하고, 명시한 목록은 입력 순서대로 검증해 선택 항목만 준비한다. 기존 테스트의 설정 수정에는 적용하지 않는다. 검증: `test_daki_test_targets.js`, `test_daki_test_target_gallery.js`, `test_daki_styles.js`, 격리 `test_daki_style_tests.py`, `test_daki_styles_api.py`.
- `naim/storage/daki_personal_styles.py`와 `naim/web/daki_personal_styles.py`는 `daki_personal_styles/catalog.json`의 개인 그림체 등록·조회·수정과 이미지에서 초안 가져오기를 담당한다. `static/daki_personal_styles.js/.css`는 직접 입력·Base/Nega 편집·우클릭 가져오기와 개인 갤러리를 담당한다. 대표 이미지는 선택한 원본의 상대 참조이며 복사하지 않는다. 원본이 없어져도 레시피는 유지된다. `__daki_personal__/personal_<id>.png`는 기존 읽기 전용 가상 참조 경계로 처리한다.
- 개인 그림체 저장 폴더는 Git 제외·업데이트 보호·기존 설치 가져오기 대상이다. 원본 삭제 시 개인 대표 그림 연결도 기존 daki 경고에 포함한다. 그림체에는 시드를 고정하지 않으며 가져온 PNG의 생성 옵션은 메타데이터 어댑터를 통해 보존한다.
- 개인 그림체 편집의 `시안 생성`은 `/api/daki/personal-styles/generate`에서 기존 생성 설정과 그림체 뒤에 붙인 일회용 Base·Nega로 생성한다. 시안 프롬프트·크기는 저장하지 않고 기존 `preview`는 읽기 호환을 위해 유지한다. 결과는 확인 후 `대표 그림으로 사용`을 선택하고 그림체를 저장할 때만 `representative_image`로 전달되어 기존 카탈로그 잠금 안에서 대표 PNG와 함께 저장된다. 검증: `tests/test_daki_personal_styles.py`, `tests/test_daki_personal_styles.js`.
- `Daki.createImageTools()`는 기존 갤러리 태그 상태·저장을 재사용한다. 확대 화면에서 태그 선택·적용 후 다음 이미지 이동이 가능하며 `getGalleryTagState()`와 `gallery-tags-updated`가 상태 경계다. `static/daki_gallery_filters.js/.css`가 태그 있는 그림·특정 태그 필터와 저장된 월드컵을 선택하는 순위 정렬을 소유한다. 태그 필터는 기존 갤러리의 아이콘 렌더러·`gallery-tag-filter-chip`을 재사용하고 정렬은 작은 `SORT` 도구줄로 표시한다. 공유·개인 그림체와 테스트 갤러리가 이를 연결하며, 화면 목록과 월드컵 참가 후보에는 같은 필터 결과를 적용한다. 이 화면들은 `shareTagAssignment:true`와 `createImageTools({tagChoices:false})`로 하나의 태그 행을 공유한다. 태그 모드에서는 적용할 태그 선택으로 전환하고 태그 필터만 잠시 해제하며, 모드를 끄면 이전 필터를 복원한다. 추천수·정렬은 유지하고 `tagOnly` 선택 화면은 기존 필터 동작을 유지한다. 기본 순서를 유지하다가 사용자가 기록을 선택하면 낮은 순위 숫자부터 정렬하고 동순위는 입력 순서, 미참가는 맨 뒤로 둔다. 기록 조회 실패·삭제 시 기본 순서로 복귀하며 태그 필터는 계속 사용할 수 있다.
- `static/daki_worldcup.js/.css`는 현재 갤러리에 보이는 이미지 중 사용자가 선택한 태그만 참가시킨다. 미완료 결과와 대표 그림 없는 개인 레시피는 제외하고, 홀수 참가자는 다음 라운드로 통과한다. 진행 중 선택 되돌리기와 확대 보기를 제공하고, 대회 완료 시 참가자·선택·태그·갤러리 정보를 자동 저장한다. 기록 화면은 전체 참가자의 공동 순위와 승수를 표시하며 같은 단계의 탈락자는 동순위다. 저장된 참가 그림으로 다시 진행하면 `replay_of`를 가진 새 기록을 만들고 이전 결과는 보존한다. 미완료 대회의 진행 상태는 창을 닫으면 종료한다.
- `naim/storage/daki_worldcups.py`가 `daki_worldcups/<id>.json`의 원자 저장과 선택 기록 재검증·순위 계산을, `naim/web/daki_worldcups.py`가 `GET/POST /api/daki/worldcups`와 `GET /api/daki/worldcups/<id>`를 소유한다. 같은 ID·같은 내용의 재저장은 기존 결과를 반환하며 다른 내용은 충돌로 거부한다. 목록은 안정된 `gallery_key`로 필터링하고 UI는 `daki-worldcups-updated`로 기록 선택지를 갱신한다. 저장 폴더는 Git 제외·업데이트 보호·기존 설치 가져오기 대상이며 원본 이미지가 없어도 기록과 순위는 유지된다.
- 검증: 격리 `test_daki*.py`(월드컵 저장·HTTP 계약은 `test_daki_worldcups.py`), `test_gallery_zoom_actions.py`, `test_gallery_tag_concurrency.py`, `test_naim_updater.py`, `test_legacy_import.py`; JS `test_daki_styles.js`, `test_daki_personal_styles.js`, `test_daki_test_library.js`, `test_daki_gallery_filters.js`, `test_daki_worldcup.js`, `test_daki_worldcup_ui.js`, `test_daki.js`, `test_gallery_zoom.js`.

## daki 그림체·시안 생성

- 가져오기 창의 캐릭터 부위 자동 분류는 `static/daki_image_import_classification.js` → 기존 `/api/daki/tag-catalog/classify`를 사용한다. `CanvasDakiPromptRules.inspect/filter/canonicalRegions`를 재사용해 가중치·중첩 문법을 보존하고, 사전에서 확인된 태그만 캐릭터·부위별 한 행으로 묶는다. 미분류 태그는 캐릭터 원문에 남긴다. 선택적 정수 `promptRegions[].characterIndex`는 원본 캐릭터 인덱스이며 Base에 재추가하지 않는 의미 주석이다. 이전 수동 부위 항목은 기존 Base 추가 동작을 유지한다. 캐릭터 수정은 600ms 후 다시 분류하고 오래된 응답·교체된 파일의 결과는 버린다. 캐릭터·부위 목록은 높이를 제한해 자체 스크롤하며 모달의 헤더·푸터는 본문 스크롤 밖에 둔다. 회귀: `test_daki_image_import_classification.js`, `test_canvas_daki_prompt_rules.js`, `test_daki_image_import.py`. 합성 브라우저 검증은 `.qa/verify_daki_image_import_auto.cjs`에서 수행한다.

- 프로젝트의 `시안 만들기` 옆 `그림 가져오기`는 `static/daki_image_import.js/.css`에서 파일 선택·드래그·Ctrl+V를 받아 앞면/뒷면 그림 후보를 추가한다. `POST /api/daki/image-import/inspect`는 파일을 저장하지 않고 PNG/JPEG/WebP·크기·NAI 프롬프트를 확인하고, `POST /api/daki/projects/<id>/image-import`는 기존 `save_project_candidate_image`로 `canvas_imports/project_exports/`에 영구 저장한다. 원본은 수정하지 않으며 EXIF 방향을 적용한 PNG로 보관한다. 한 장 64MB·8천만 픽셀 이하를 허용한다. 프롬프트가 없으면 입력/그림만 가져오기를 명시적으로 선택한다. 선택적 `promptRegions`는 `{region,label,prompt}` 목록으로 프롬프트의 의미 부위를 표시하며, 문구는 전체 Base에도 포함된다. `naim/images/prompt_metadata.py`가 PNG·sidecar의 정규화와 읽기 호환을, `static/index.js`가 기존 프롬프트 보기의 부위 표시를 담당한다. 좌표·부위 지도·캔버스 자동 필터 설정은 생성하지 않는다. 회귀: `test_daki_image_import.py`, `test_daki.js`, 기존 프로젝트 내보내기·이미지 참조 테스트. 합성 자료 브라우저 검증: `.qa/verify_daki_image_import.cjs`, 1280×900·800×800, 실제 Ctrl+V·드래그·파일 선택·양면 저장·프롬프트 보기.

- 공유 그림체·기존 테스트의 아카라이브 출처/추천수는 `naim/storage/daki_style_sources.py`에서 정규화한다. `tools/import_daki_source_posts.py --database <수집DB> --catalog-root <원본공유폴더> --imported-root <NAIM/daki_imported_styles> --apply`는 DB를 읽기 전용으로 열어 이미 수집된 URL·추천수·수집시각만 `daki_imported_styles/source_posts.json`에 원자 저장한다. 외부 통신과 이미지 처리는 없으며 기존 글 메타정보는 보존한다. 런타임은 외부 DB 경로에 의존하지 않는다.
- 공유 카탈로그와 테스트 상세 API는 `source_url`, `recommendation_count`, `recommendation_collected_at`을 제공한다. 저장된 그림체 스냅샷을 우선하고 누락 추천수만 URL 메타정보로 보완하며 기존 배치·완료 이미지는 재작성하지 않는다. 개인 그림체·없는 수치는 `null`이며 실제 0과 구분한다. 선택 삭제된 공유 그림체의 기존 테스트 출처도 유지한다. 검증: `tests/test_daki_style_sources.py`, `tests/test_daki_shared_styles.py`, `tests/test_daki_style_tests.py`, `tests/test_daki_styles_api.py`.
- 공유 그림체 일람·상반신과 모든 테스트의 최신순/오래된순은 API의 `sort_date`를 사용한다. `naim/storage/daki_style_dates.py`는 게시일(기존 공개 게시일 자료 포함)을 우선하고 기존 그림체는 저장된 추가일 또는 원본 이미지 생성일을 사용한다. `DakiSharedStyles.sort_dates_many`는 과거 테스트의 누락 날짜를 현재 원본 카탈로그로 보완하며 저장본은 재작성하지 않는다. `static/daki_gallery_filters.js`의 선택적 `dateOf`는 추천수·월드컵과 하나의 정렬 선택을 공유하고, 날짜 동률은 현재 순서 유지·미상은 양방향 모두 마지막으로 처리한다. 검증: 기존 날짜·카탈로그·테스트·API Python 테스트와 `tests/test_daki_gallery_filters.js`.
- `static/daki_styles.js`는 공유/테스트 카드에 원문 링크와 수집 당시 추천수를 표시한다. `static/daki_gallery_filters.js`의 선택적 `recommendationOf(item)`은 기존 태그 필터에 전체·10 이상부터 100 이상까지 10단위 추천수 선택과 양방향 정렬을 결합한다. 숫자 입력칸은 사용하지 않으며 setResultCount(visible,total)로 이름 검색·태그·추천수 적용 후 남은 장수를 전체 갤러리 장수와 함께 표시한다. 월드컵 순위와 추천수는 SORT에서 한 종류만 선택하며 추천수 없는 항목은 정렬 마지막, 추천수 기준을 선택하면 제외된다. 동점은 기존 순서를 유지하고 `tagOnly` 화면은 기존 UI를 유지한다. 검증: `tests/test_daki_styles.js`, `tests/test_daki_gallery_filters.js`.

- 각 프로젝트의 `시안 만들기`는 `#daki&library=drafts&project=<id>&new=1`에서 이름 있는 시안 폴더를 만든다. 프로젝트 화면에 그 프로젝트의 폴더만 표시하며 Daki 최상단에는 시안 카드를 추가하지 않는다. `&folder=<id>`는 결과 갤러리, `&edit=1`은 왼쪽 프롬프트·설정 / 가운데 원본 결과 / 오른쪽 생성 기록 화면이다. `static/daki.js`가 프로젝트 안의 폴더 카드, `static/daki_drafts.js/.css`가 폴더 생성·갤러리·편집·선택·명시 삭제를 담당한다. 설정은 같은 폴더에 저장하고 다시 열어 추가 생성한다. 프로젝트 후보 추가는 결과 선택과 별도 명시 동작이다. 기존 갤러리 도구·태그·월드컵은 폴더 갤러리에서 재사용한다.
- 그림체 선택은 공유/개인 카탈로그, 이름 있는 기존 테스트의 완성 그림, 저장 월드컵의 순위별 그림을 제공한다. `DakiGalleryFilters.create({tagOnly: true})`로 현재 표시하는 그림 경로의 태그를 이름 검색과 함께 필터링한다. 테스트·월드컵은 그림을 고르는 용도이며 경로의 원본 ID를 현재 활성 카탈로그와 대조한 뒤 원본 모델·옵션을 가져온다. 삭제되었거나 원본 연결이 없는 그림은 이유를 표시하고 선택을 막는다. 이전 그림체의 정확한 프롬프트 접두부만 교체하며 직접 입력한 나머지 내용·캐릭터·크기·시드는 유지한다. Medium은 기존 생성기의 고정 설정을 적용한다.
- 시안 편집기는 Euler Ancestral 호환·Brownian·동적 임계값·V3 확장 옵션을 화면에 표시하지 않으며 기존 그림체/저장 설정값은 내부에 보존한다. `create({tagBrowserEnabled:false})`는 태그 예시 생성에 편집기를 재사용할 때 사전의 중첩 재진입만 막는다.
- `static/daki_prompt_groups.js/.css`는 Base/Nega/캐릭터의 선택 구간을 이름 있는 임시 묶음으로 접고 편집한다. `static/daki_draft_editor.js`가 원문 textarea·태그 삽입·번역·모델 비활성 상태와 연결한다. 구간은 위치로 관리해 중복 태그·가중치·순서를 보존한다. 묶음 자체는 현재 편집기에만 존재하며 저장·전송은 합친 원문을 사용한다. 원문 전체를 바꾸면 오래된 묶음만 해제하며, 그림체의 정확한 접두 구간은 불러올 때 접힌다. 회귀: `tests/test_daki_prompt_groups.js`, `tests/test_daki_draft_editor.js`.
- `naim/daki_tag_catalog.py`, `naim/web/daki_tag_catalog.py`는 형제 `dakiMaker/research/tag-catalog`의 사전·설명·예시를 읽기 전용으로 제공한다. `static/daki_tag_browser.js/.css`가 검색·분류·예시 확대와 선택한 입력란에 영문 태그 삽입을 담당한다. 캐릭터가 없거나 입력란이 잠긴 상태에서도 사전을 열며 삽입 대상이 없으면 둘러보기로 표시한다. 한국어 미리 보기는 전송 프롬프트를 바꾸지 않는다. 원본 폴더 연결이 필요하며 사용자 설정이나 프로젝트는 가져오지 않는다.
- `naim/daki_drafts.py`, `naim/web/daki_drafts.py`가 `/api/daki/drafts` 목록·생성, `/<id>` 상세, `/<id>/retry` 명시 재시도, `/<id>/image` 프리뷰(`?full=1` 원본)를 제공한다. 기존 NovelAI 키·payload·통신을 사용하고 한 번에 한 장만 생성한다. 응답이 불명확하면 목록을 확인하기 전 추가 생성을 막는다.
- `daki_drafts/folders.json`은 폴더의 id/name/project_id/settings와 생성·수정 시각을 원자 저장한다. `/api/daki/draft-folders` GET/POST, `/<id>` GET/PUT가 읽기·생성·수정을 담당하며 앱에서는 실재 프로젝트가 있어야 새 폴더를 만든다. `/api/daki/drafts` 생성 요청의 선택적 folder_id/purpose와 개별 draft.json의 selected는 NovelAI payload와 분리한다. 선택은 `/<draft_id>/selection` PUT, 삭제는 `/api/daki/draft-folders/<id>/delete-drafts` POST에 명시 ID 목록을 전달한다. 삭제 전 전체 범위·생성 중 상태·원본 연결을 확인하고, preserve_selected는 서버 잠금 안에서 선택 결과를 보호한다. 부분 실패는 삭제/실패/건너뜀 ID로 보고한다.
- 시안 폴더를 만들 때 name을 생략하거나 비우면 프로젝트 안의 기존 `시안N` 이름 다음 번호를 사용한다(`시안1`, `시안2` 등). 번호 결정과 저장은 같은 잠금 안에서 처리하며 직접 입력한 이름과 기존 폴더 이름은 유지한다. 이름 수정의 빈 값 거부 규칙은 유지한다.
- 기존 `daki_drafts/<id>/draft.json,image.png,preview.jpg` 경로와 `__daki_drafts__/<id>.png` 참조는 유지한다. 폴더 없는 구 자료는 재작성하지 않고 직접 `&folder=legacy`에서 읽을 수 있으며 특정 프로젝트에 임의 배정하지 않는다. 재시작 시 중단 작업만 실패로 복구하며 자동 재생성·자동 삭제하지 않는다. 비율 사본은 원본 folder_id/purpose를 계승하고 선택 표시는 해제된 상태로 추가한다.
- 완성 시안의 크기·비율 맞추기는 `static/daki_draft_framing.js/.css`에서 시작한다. `GET /api/daki/drafts/framing-options`로 로컬 저장 한계를 읽고 `POST /api/daki/drafts/<id>/frame`에 `width/height/mode`를 보낸다. `naim/images/daki_framing.py`의 `pad`는 원본 픽셀을 중앙에 보존하고 투명 여백을 붙이며, `cover`는 비율을 유지한 중앙 영역을 Lanczos로 확대·축소한다. 별도 UUID 시안 폴더를 완성 후 원자 게시하며 원본 파일과 생성 설정은 유지한다. 추가 `framing` 필드에는 원본 ID·크기·배율·위치가 기록되며 응답 `width/height`만 실제 결과 크기를 따른다. PNG는 투명도를 보존하고 JPEG 미리보기는 흰 배경으로 합성한다. 로컬 저장 한계(한 변 16000, 총 8000만 픽셀)는 생성 API 한계와 분리된다. 검증: `tests/test_daki_framing.py`, `tests/test_daki_drafts.py`, `tests/test_daki_draft_framing.js`, `tests/test_daki_drafts.js`.
- 시안 생성·실패 재시도와 그림체 테스트 실행은 기존 `static/common_anlas_warning.js`의 확인 모달을 사용한다. 단일 요청 계약을 유지하고 선택적 `requests` 배열로 여러 장의 크기·스텝 범위·기존 추정식의 총 비용을 표시한다. Medium은 실제 14스텝 기준이며 승인된 요청에만 `allow_anlas=true`를 전달한다. 취소·페이지 이동 후 승인·중복 클릭은 추가 생성을 보내지 않는다. 로컬 여백·자르기는 이 모달을 사용하지 않는다. 검증: `tests/test_common_anlas_warning.js`, `tests/test_daki_drafts.js`, `tests/test_daki_styles.js`.
- 비율 맞추기는 결과 갤러리 또는 생성창의 `5:16 맞추기 (선택)`에서 연다. 두 방식의 미리보기 후 `별도 저장`을 눌러야 사본을 만들며 원본은 보존한다.
- `static/daki_tag_examples.js/.css`는 태그 상세의 기존 그림 선택·새 생성 모달을 담당한다. 새 생성은 purpose=tag_example으로 기록하며 일반 시안 폴더에서 제외한다. `생성 기록 불러오기`는 `/api/daki/drafts?purpose=tag_example`에서 별도 결과를 읽어 확인·재시도·명시 등록한다. 기존 등록 예시도 DAKI_TAG_EXAMPLES의 가상 참조를 조회해 시안 목록에서 제외하며 파일은 이동·수정하지 않는다. 공통 Anlas 모달의 parent/signal과 모달 종료·오래된 응답 방지는 유지한다. 검증: `tests/test_daki_tag_examples.js`, `tests/test_daki_draft_folders.py`, `tests/test_daki_drafts.js`.
- `naim/daki_tag_candidates.py`는 긍정 프롬프트의 정확한 태그 토큰을 검사한다. `app.py`는 일반 갤러리 인덱스의 누락·변경 파일과 sidecar/이미지 메타데이터를 보완하고, 시안·테스트의 읽기 전용 helper로 생성 당시 완료 설정을 조회한다. `/api/daki/tag-catalog/candidates?tag=...&page=N`은 `{items:[{path,name,src}],page,pages,total}`을 제공하며 첫 페이지 재조회 시 후보를 갱신한다. Nega만 일치하거나 일부 단어만 겹치는 그림은 제외한다.
- `naim/storage/daki_tag_examples.py`는 `daki_tag_examples/catalog.json`에 `{id,tag,path,added_at}` 원본 참조를 원자 저장한다. `POST /api/daki/tag-catalog/examples {tag,path}`로 등록하며 같은 태그·실제 경로는 중복 추가하지 않는다. 상세·목록·예시 필터에 합산하고 기존 example URL의 `id` 쿼리로 이미지를 제공한다. 외부 사전과 원본 픽셀은 수정하지 않으며 삭제 API는 기존 `confirm_daki` 확인 절차에 예시 참조를 포함한다. 저장 폴더는 Git 제외·업데이트 보호·기존 자료 가져오기 대상이다. 검증: `tests/test_daki_tag_candidates.py`, `tests/test_daki_tag_examples.py`, `tests/test_daki_tag_catalog.py`, `tests/test_gallery_zoom_actions.py`, updater/import 테스트.
- `naim/daki_image_refs.py`의 `__daki_drafts__/<id>.png`는 기존 확대·태그·프롬프트 조회·캔버스 가져오기·프로젝트 후보에 연결된다. 인페인트·업스케일은 캔버스에서 이어간다. 저장 폴더는 `.gitignore`, 업데이트 보호 및 기존 자료 가져오기 대상에 포함된다.
- 검증: 격리 `test_daki*.py`, `test_naim_updater.py`, `test_legacy_import.py`; JS `test_daki_drafts.js`, `test_daki_draft_editor.js`, `test_daki_tag_browser.js`, `test_daki.js`, `test_gallery_script_loading.js`. 실제 과금 요청은 사용하지 않고 합성 생성 응답으로 확인한다.

## 검증 명령

```text
python -B tools/run_isolated_tests.py
node --test tests/test_canvas_clipboard.js
node --check static/canvas.js
python -B tools/check_frozen_build.py
python -B tools/check_native_upscale.py
python -B tools/run_isolated_tests.py --serve 5127
```

기존 서버는 import 시 임시 디렉터리를 생성·정리하므로 전체 테스트는 격리 실행기를 사용한다.
격리 실행기는 코드만 임시 폴더에 복사한다. 실제 설정·이미지·DB·API 키를 복사하지 않는다.
EXE 검사는 두 실제 spec을 합성 사전 데이터로 빌드하여 서버 시작, 새 정적 파일, 기존 설정 읽기를 검증한다.
이 검사는 배포 산출물을 만들지 않으며 실제 AI 엔진·대용량 사전·과금 생성은 검증하지 않는다.

현재 확인: Python 회귀 테스트 207개(가져오기/WAL/복구/숨긴 실제 Tk 창의 선택·미리보기·실행 포함), JS 클립보드 동작 테스트 8개, Python/JS 구문 검사,
두 EXE 빌드 및 격리 서버 점검 통과. 브라우저에서 외부 PNG 붙여넣기/레이어 추가,
갤러리 초기화·폴더 규칙 편집기·그림체 연구소 진입을 확인했다.
추가로 갤러리 태그 관리 진입과 캔버스 저장본 생성·목록 표시를 브라우저에서 확인했다.
로컬 Lanczos/Real-CUGAN/Waifu2x의 합성 이미지 64×96 출력, 두 GPU 엔진의 실제 취소도 통과했다.

## daki 프로젝트의 편집 캔버스

- 앞면·뒷면 그림 카드의 `가로 × 세로 px`는 `naim/web/daki.py`가 실제 원본에서 읽은 `width/height`를 사용한다. `naim/images/previews.py`의 EXIF 표시 방향 규칙을 캔버스 업로드와 공유하며 파일 경로·수정 시각·용량을 키로 최대 512개를 메모리에 캐시한다. 전체 프로젝트 요약 목록에서는 크기를 읽지 않는다. 원본 누락·읽기 실패는 null/`크기 확인 불가`이며 후보 JSON에는 크기를 추가하지 않는다.
- 프로젝트의 인페인팅 참고 이미지 UI는 `static/daki_project_reference.js/.css`가 소유한다. 기존 `/api/canvas/upload_image`로 추가·교체하고 최신 `canvas-settings`를 읽어 revision 검증과 함께 `inpaintReference`만 변경한다. 기존 그림체·면별 프롬프트·생성 설정을 보존하며 충돌 시 새로고침을 안내한다. 프로젝트 공용 이미지 한 개를 미리보기·크게 보기로 확인하고 기존 캔버스의 `프로젝트에서 가져오기`로 불러온다. `static/canvas_inpaint_reference.js`의 검증을 재사용하고, 페이지 이동 시 요청·이벤트·뷰어를 정리한다. 회귀: `tests/test_daki_project_reference.js`, `tests/test_daki.js`, `tests/test_daki_api.py`, `tests/test_project_canvas_settings.py`, `tests/test_canvas_inpaint_reference_api.py`.
- 참고 이미지·크기 표시 검증: 관련 JavaScript 135개·격리 Python 46개 통과. `.qa/verify_project_reference.cjs`와 `.qa/project_reference_transport.py`의 합성 자료로 업로드·설정 보존·재열기·캔버스 가져오기·오류 재시도 등 12개 검사를 통과했다. 1280×900·800×800, 브라우저 배율 100%, deviceScaleFactor 1에서 긴 파일명·양면 카드·크게 보기의 실제 캡처와 조작 접근을 확인했다. 원본은 크게 보기를 열 때만 브라우저에 로드한다. 사용자 자료와 실제 생성 요청은 검증에 사용하지 않았다.

- 프로젝트 카드의 생성·수정일과 정렬은 `static/daki.js/.css`가 담당한다. 기본값은 기존 순서(면별 캔버스 다음 그림)이며 생성일·수정일의 최신순/오래된순을 선택하면 기존 카드 노드만 재배치한다. 정렬 선택은 페이지 메모리에만 유지하고 알 수 없는 날짜는 양방향 모두 마지막에 둔다. `naim/web/daki.py`는 실제 해석된 원본 파일의 생성일·수정일을 UTC `created_at/updated_at` 응답 필드로만 제공하며 후보 JSON에는 저장하지 않는다. 파일 날짜를 읽을 수 없으면 null이고 `added_at`으로 대체하지 않는다. 캔버스는 기존 생성·저장 날짜를 사용하며 화면에서는 브라우저 현지 시각으로 표시한다. 회귀: `tests/test_daki_api.py`, `tests/test_daki.js`.
- 캔버스의 `상세 정보`는 `static/daki_project_details.js/.css`가 소유한다. 기존 캔버스 GET으로 이름·면·크기·날짜와 레이어를 읽고, `static/daki_canvas_previews.js`의 `observeState`로 전체 합성 및 폴더/선택 영역별 합성을 보여준다. 각 그림의 작은 미리보기와 레이어 표시·숨김을 이용해 수정 내용을 비교하며, 조작은 별도의 최소 미리보기 상태에만 적용하고 저장하지 않는다. `저장 상태로`는 최초 표시 상태를 복원한다. 원본 클립·고정 참고 이미지의 합성 제외 규칙은 공용 합성기와 동일하다. 레이어 목록의 스크롤은 별도로 제한하고 실패 시 재시도하며 닫기·화면 이동·미리보기 변경 때 이전 요청과 합성을 취소한다. `index.html`이 모듈을 로드하고 `static/daki.js`가 진입·종료를 연결한다. 삭제 확인과 다른 연결의 추가 경고도 앱 테마 모달을 사용하며 기존 동기 확인을 쓰는 공용 `deleteRequest` 호출자도 유지한다. 회귀: `tests/test_daki_project_details.js`, `tests/test_daki_canvas_previews.js`, `tests/test_daki.js`, `tests/test_gallery_script_loading.js`.

- 프로젝트 카드의 캔버스 삭제는 `DELETE /api/daki/projects/<id>/canvases/<canvasId>`로 저장된 편집 상태만 제거하며 원본과 내보낸 그림은 유지한다. 그림 삭제는 `POST /api/daki/projects/<id>/candidates/<candidateId>/delete` → `naim/images/project_deletion.py`로 원본과 JSON/TXT 메타데이터, 선택한 후보를 함께 제거한다. 다른 연결은 기존 `daki_references` 확인을 거치며, `naim/storage/image_files.py`의 `staged_image_removal`이 프로젝트 저장 실패 시 파일을 복구한다. 원본 누락 후보도 제거할 수 있고 기존 후보 DELETE의 연결만 제외하는 계약은 유지한다. 두 종류의 삭제 버튼은 같은 스타일로 카드 하단 오른쪽에 배치하고, 캔버스 미리보기·열기 링크는 이름·면을 표시하는 앱 내 확인 모달을 거쳐 새 창을 연다. 모달의 취소·닫기·Esc·바깥 클릭은 열지 않고 초점을 돌려주며, 화면 이동 때 오래된 열기 대상을 해제한다. 갤러리 원본의 색인은 `app.py`의 `project_image_deleted`가 갱신한다. 회귀: `test_project_deletion.py`, `test_project_deletion_integration.py`, `test_daki_project_canvases.py`, `test_daki.js`.

- 프로젝트 목록의 그림에서 실행한 인페인팅·업스케일은 원본을 유지하고 같은 프로젝트·면에 새 후보를 자동 추가한다. `static/daki.js` → `static/index.js` → `static/gallery_inpaint.js`/`gallery_upscale.js`가 선택 시점의 `projectContext: {projectId, side, candidateId}`를 전달한다. `naim/images/project_results.py`는 원본 후보·경로·면을 검증하고, 기존 통합 내보내기와 공유하는 `naim/images/canvas_export.py`의 `save_project_candidate_image`로 영구 PNG·프롬프트를 저장한다. 생성 후에도 대상 유효성을 다시 확인하며 일반 갤러리 요청의 저장 방식은 유지한다. `static/daki.css`는 프로젝트의 캔버스·그림 카드와 미리보기 영역을 같은 표시 크기로 맞춘다. 실제 캔버스·이미지 해상도는 유지한다. 회귀: `tests/test_project_image_results.py`, `tests/test_project_image_actions.js`, `tests/test_daki.js`.
- 캔버스의 **인페인팅 설정**과 기존 클립 프롬프트의 생성 옵션은 `static/canvas_inpaint_settings.js/.css`의 공용 상태·모달을 사용한다. 모델·샘플러·단계·CFG·재조정·노이즈 스케줄·시드·강도·노이즈를 기존 `generation_settings.js`로 정규화하고, 클립의 프롬프트 본문·그룹은 유지한다. `static/canvas.js`/`canvas_setups.js`가 선택적 `inpaintSettings`를 기존 저장본·프로젝트·복구 상태에 보관하며, 통합 내보내기의 PNG·프롬프트 메타데이터에도 적용한다. 내보낸 이미지를 다시 가져오면 해당 설정을 복원하고, 필드가 없는 기존 저장본은 기존 레이어 메타데이터를 사용한다. 회귀: `tests/test_canvas_inpaint_settings.js`, `tests/test_canvas_export.js`, `tests/test_canvas_state.js`, `tests/test_canvas_setups.js`.
- 통합 내보내기는 프로젝트 연결 중 `static/canvas_project.js`의 선택 창에서 프로젝트/갤러리를 고른다. `static/canvas.js`는 취소·중복 실행·선택 중 연결 변경을 차단하며, `/api/canvas/export_merged`의 생략된 `destination`은 기존 갤러리 저장을 유지한다. `destination: project`와 `projectId/canvasId`는 `naim/images/canvas_export.py`로 전달되고 서버에서 확인한 캔버스 면에 기존 그림 후보 저장 함수로 추가한다. PNG·프롬프트는 `canvas_imports/project_exports/<projectId>/`에 보존하며 일반 갤러리 파일·인덱스를 만들지 않는다. `naim/daki_image_refs.py`가 `__daki_exports__/<projectId>/<exportId>.png`의 조회를 허용하고 기존 임시 이미지 정리는 이 폴더를 제외한다. 회귀: `tests/test_canvas_export.js`, `tests/test_canvas_project.js`, `tests/test_canvas_project_export.py`, `tests/test_daki_image_refs.py`.
- `static/canvas_project.js/.css`는 현재 캔버스의 기존/새 프로젝트 선택, 앞면·뒷면과 이름 지정, 연결 상태 및 재열기를 담당한다. `static/canvas_project_autosave.js`는 600ms 구간 저장, 순차 요청, 실패한 요청의 동일 내용 재시도, revision 충돌 차단을 소유한다.
- `naim/storage/daki_projects.py`는 기존 보호 파일 `daki_projects.json`에 선택적 `canvases.front/back` 배열을 저장한다. 각 캔버스의 전체 상태는 이 저장소 한 곳에서 관리하며 레이어·마스크·프롬프트를 보존한다. `naim/web/daki.py`의 프로젝트 생성 시 선택적 `canvas`, `POST /api/daki/projects/<id>/canvases`, 캔버스별 GET/PUT이 저장 경계다. 목록에는 상태 본문 없이 이름·크기·레이어 수만 제공하고 기존 이미지 후보 형식은 유지한다.
- `static/daki.js/.css`는 앞면·뒷면 캔버스 목록과 `/canvas?project=<id>&canvas=<id>` 재열기를 연결한다. 새 캔버스·저장본 불러오기·초기화 전에는 기존 연결의 저장 완료를 기다리며, 실패하면 현재 작업을 유지한다. 연결 종료는 서버의 저장본을 삭제하지 않는다. 연결 중인 브라우저 복구 상태에는 선택적 `projectLink`를 함께 기록한다.
- 프로젝트 내부는 앞면·뒷면마다 캔버스와 그림 후보를 하나의 공통 갤러리 격자에 표시하고, 카드의 `캔버스`·`그림` 배지로 종류를 구분한다. 면별 개수는 두 종류를 합산하며 그림 필터·정렬·월드컵은 후보에만 적용한다. 캔버스 카드는 통합 그림을 표시하며, 프로젝트 목록은 면별 첫 캔버스를 대표로 사용하고 캔버스가 없으면 기존 첫 후보를 표시한다. `static/daki_canvas_previews.js`가 기존 캔버스 GET과 `static/canvas_composite.js`의 공통 합성 함수를 사용해 긴 변 최대 768px의 표시 전용 이미지를 만든다. 화면 근처부터 최대 2개를 동시에 처리하고 같은 페이지의 동일 프로젝트·캔버스·revision은 재사용하며, 이동 시 요청과 이미지 로드를 취소한다. 원본·저장 상태·기존 내보내기 해상도는 바꾸지 않는다.
- `app.py`의 `project_canvas_import_refs()`가 프로젝트에서 사용하는 원본·마스크를 세 캔버스 정리 경로에서 보호한다. 갤러리 원본 삭제 경고도 프로젝트 캔버스의 `/image/` 참조를 포함한다.
- 반대쪽 참고 그림은 `static/canvas_opposite_reference.js/.css`가 소유한다. 연결된 프로젝트의 반대면 후보 또는 저장된 캔버스를 선택하며, 선택하지 않았거나 원본이 없으면 그림을 표시하지 않는다. 선택한 프로젝트/항목 ID·종류·표시 여부와 선택적 `view: {x,y,width,height}`를 캔버스 상태의 `oppositeReference`에 저장한다. 제목 드래그로 이동하고 모서리에서 비율을 유지해 크기를 조절하며, **높이 맞춤**은 현재 캔버스의 표시 높이에 맞춘다. 기존 선택 상태를 그대로 읽고 고정 레이어와 내보내기 대상은 유지한다. 저장 캔버스의 미리보기는 `renderMergedCanvasToDataUrl({state, maxDimension:1600})`로 복사본을 합성하고 편집 상태를 바꾸지 않는다. 선택·면·프로젝트 변경 시 이전 비동기 결과는 버리며, 원본 누락·읽기 실패 시 재시도를 제공한다.
- 프로젝트 연결 모달은 `프로젝트명_앞면_YYYY-MM-DD_HHmmss` 형식의 현지 시각 이름을 제안하고 직접 입력한 이름을 유지한다. `static/canvas_project.js`가 제안과 PNG 다운로드 이름을, `naim/storage/daki_projects.py`의 `project_canvas_result_name`/`add_candidate`가 서버 결과 이름과 순번을 소유한다. 새 결과 이름에는 캔버스명과 순번 대신 프로젝트·면·내보내기 시각을 사용한다. 캔버스의 선택적 `exportCount`와 후보의 `name/sourceCanvasId/resultIndex`는 기존 JSON 잠금 안에서 함께 기록하며, 후보를 제외해도 번호를 되돌리지 않는다. 실제 UUID 이미지 경로와 기존 후보 형식은 유지한다. `app.py`는 PNG 응답의 다운로드 이름에 후보 이름을 사용하고 `static/daki.js`는 이를 카드에 표시한다. `static/canvas_workspace.js`의 캔버스 추가 목록은 프로젝트 캔버스와 저장본에 픽셀 크기를 표시한다. 회귀: `test_canvas_project.js`, `test_canvas_project_export.py`, `test_canvas_workspace.js`.
- 통합 내보내기의 선택적 정리·저장 확인과 처리 단계·경과 시간·단계 완료율은 `static/canvas_export_feedback.js/.css`가 담당한다. `static/canvas.js`는 성공한 내보내기와 동일한 이미지·프롬프트를 `buildMergedOnlyCanvasStateSnapshot`에 재사용하고 해당 캔버스만 기존 프로젝트 자동 저장 또는 캔버스 저장 API로 보관한다. 대기 중 연결·작업 공간·레이어 변경이 있으면 정리를 중단하며, 내보내기 이후 저장 실패는 부분 성공으로 알린다. 회귀: `test_canvas_export.js`, `test_canvas_export_feedback.js`, `test_canvas_inpaint_settings.js`.
- 검증: `tests/test_daki_project_canvases.py`, `tests/test_canvas_project_assets.py`, `tests/test_canvas_project_autosave.js`, `tests/test_canvas_project.js`, `tests/test_canvas_state.js`, `tests/test_canvas_opposite_reference.js`, `tests/test_canvas_reference_render.js`, `tests/test_daki.js`, `tests/test_daki_canvas_previews.js`. 실제 화면은 합성 자료로 1280×900과 800×800에서 확인한다.

## 프로젝트 그림체·면별 프롬프트·공통 인페인트 연동

프로젝트의 **캔버스 연동 설정**은 `static/daki_project_settings.js/.css`가 편집하고 `naim/project_canvas_settings.py`가 검증한다. `naim/storage/daki_projects.py`의 기존 JSON 저장 경계에서 선택적 `canvasSettings`를 보관하며, `GET/PUT /api/daki/projects/<id>/canvas-settings`로만 설정을 노출한다. 그림체 스냅샷, 앞면·뒷면별 Base/Negative 그룹 프롬프트, 양면 공통 인페인트 설정과 별도 revision을 저장한다. 일반 프로젝트 목록은 프롬프트 설정을 포함하지 않고, 기존 자료는 쓰기 없는 기본값으로 읽는다. 동시 수정은 409로 막고 동일 요청 재시도는 중복 저장하지 않는다.

`static/daki_project_style_picker.js/.css`는 현재 프로젝트의 앞면·뒷면 그림 목록과 선택한 그림의 `/api/prompt_info`만 조회한다. Base/Negative 원문을 텍스트 편집창에 불러와 수정·삭제할 수 있으며, 같은 그림을 다시 열면 저장된 연동 텍스트를 복원한다. 원본 그림은 수정하지 않고 공백·줄바꿈을 포함한 편집 결과를 연동 설정에만 저장한다. `style.library: project`, `sourceProjectId`, `selection` 형식은 유지하며, 변경한 필드의 태그 발생 순번은 편집 결과에서 다시 계산하고 그대로인 필드의 기존 순번은 보존한다. 캐릭터 프롬프트는 편집 후 체크한 항목만 선택한 면의 기존 목록 뒤에 추가한다. 면별 22개 제한을 넘으면 일부만 추가하지 않고 적용을 거부한다. 그림의 생성 설정은 존재하는 필드만 미리보기로 표시하며, 가져오기 체크가 켜져 있으면 현재 공통 인페인트 설정에 병합하고 연동을 활성화한다. 없는 값은 현재 값을 유지하며 0도 보존한다. 공통 생성 설정 UI의 모델 제약과 저장 검증을 재사용한다. Base/Negative가 모두 비어도 캐릭터나 생성 설정만 가져올 수 있으며, 이때 기존 그림체 연결을 유지한다. 편집을 적용한 뒤 바깥 설정창에서 저장하며, 진행 중인 편집은 저장을 막고 취소하면 이전 설정을 유지한다. 면별 편집창은 나란히 두고 각각 Base/Negative를 전환한다. 각 면의 선택적 `charPrompts`는 최대 22개의 문자열 배열이며 빈 항목과 공백도 번호 보존을 위해 저장한다.

`static/canvas_project_settings.js`는 연결된 캔버스에 프로젝트 변경을 단방향으로 적용한다. `static/canvas_style_bridge.js`의 기존 그림체 그룹 처리를 재사용하며 해당 면과 일치하는 태그만 추가 그룹으로 표시한다. 원래 프롬프트·가중치·순서와 그림은 변경하지 않는다. 공통 인페인트 값은 프로젝트 값이 바뀌었을 때만 반영해 캔버스의 개별 수정을 보존한다. 열린 편집창의 입력을 덮지 않고 창을 닫은 뒤 반영한다. 같은 창 이벤트·BroadcastChannel·보이는 창의 5초 확인으로 갱신하고, 늦은 응답은 연결과 캔버스가 같을 때만 사용한다. 닫힌 캔버스는 다시 열 때 최신 설정을 받는다. 캔버스 저장본의 선택적 `projectSettingsLink`는 마지막 적용값과 그룹 펼침 상태를 보관하며, 연결을 종료해도 마지막 복사값은 유지한다.

캐릭터 그룹은 캔버스의 현재 캐릭터 행 순서에 맞춰 해당 면의 같은 번호 레시피를 사용한다. 임시 DOM ID와 저장된 번호를 구분하며, `projectSettingsLink.expanded.characters`는 번호별 펼침 상태만 저장한다. 캐릭터 프롬프트도 일치하는 태그만 그룹화하고 본문은 변경하지 않는다.

검증: `test_project_canvas_settings.py`, `test_canvas_project_settings.js`, `test_daki_project_settings.js`, `test_daki_project_style_picker.js`, `test_project_character_bridge.js`와 기존 프로젝트·캔버스 저장·그림체·인페인트 테스트. `.qa/project_prompt_text_check.cjs`는 텍스트 편집과 저장을, `.qa/project_character_import_check.cjs`는 합성 메타데이터의 캐릭터 22개 중 선택·편집·면별 추가와 생성 설정 병합·저장을 실제 브라우저에서 확인한다. 기존 `.qa/verify_project_image_settings.cjs`의 태그 선택 시나리오는 텍스트 편집 이전 흐름이다. 충돌·명시적 다시 불러오기 회귀는 설정 단위 테스트와 `.qa/verify_project_canvas_settings.cjs`에서 다룬다. 실제 화면 조건은 1280×900·800×800, 브라우저 배율 100%, deviceScaleFactor 1이다.

## 다키 캔버스의 부위 지도와 선택 영역

- 새 선택 영역은 `static/canvas.js`의 `getSelectionAreaCreationCenter`가 캔버스 표면·작업 영역의 스크롤 가능한 내부·브라우저 화면이 겹치는 부분의 중앙을 구해 배치한다. `getCanvasPointerPosition`으로 확대 배율을 반영하며 기본 크기·요청 크기 제한·저장은 기존 `addSelectionArea` 동작을 유지한다. 회귀: `tests/test_canvas_selection_position.js`.

- `static/canvas_daki_regions.js`는 기존 다키메이커의 기본 위치를 사용하는 앞면·뒷면 부위 지도, 겹침 판정과 부위 폴더 재사용을 담당한다. 이미지 AI 분석 없이 좌표로 판정하며 수동 선택을 우선한다. 지도 v1에 선택적 `customRegions` 정의(이름·기준 부위·포커스 문구·색)를 추가하며, 사용자 부위가 없으면 기존 저장 형태를 그대로 유지한다.
- `static/canvas_daki_map_editor.js/.css`는 기존 캔버스 위에서 선택한 부위의 사각형만 이동·크기 조절·추가·삭제하게 한다. 편집 중 오른쪽 레이어 패널을 지도 설정으로 교체하고 기존 캔버스의 확대·이동을 재사용한다. 직접 부위를 추가할 수 있으며, 취소하면 원본을 유지하고 적용할 때만 저장한다. 종료하면 레이어 패널을 복원한다. 인라인 오버레이는 캔버스 표면의 형제이며 재렌더·크기 변경에 맞춰 동기화한다.
- `static/canvas_daki_focus.js/.css`는 프로젝트 연결 시 작업 공간 위에 버튼 크기만큼 떠 있는 부위 표시를 제공한다. 접기·펼치기가 캔버스 높이를 바꾸지 않으며 버튼 사이 빈 공간은 캔버스 조작을 통과시킨다. 화살표로 좌우 위치를 바꾸고, 펼치면 부위 변경·지도 편집을 사용할 수 있다. 상세 설정은 기존 클립 프롬프트 창에서 표시한다. 지도는 캔버스 상태의 `dakiBodyMap`, 수동 부위·태그 복구·그룹 ON/OFF·포커스 문구는 선택 레이어의 `dakiFocus`에 저장한다. 기존 공용 원본 프롬프트와 제어 그룹은 유지한다.
- `POST /api/daki/tag-catalog/classify`와 `naim/daki_tag_catalog.py`는 기존 사전의 정확한 태그 일치로 부위 정보를 반환한다. `static/canvas_daki_prompt_rules.js`가 알려진 다른 부위 태그만 생성 요청에서 제외하며 가중치 괄호, 그림체, 미분류 태그와 네거티브를 보존한다. 여러 부위를 포함하면 어느 한 부위에라도 필요한 태그를 유지한다. 사용자 부위는 선택한 기본 부위의 태그 분류를 재사용하며, 기준이 `whole`이면 자동 제외하지 않는다. 생성 시작 시 사용자 부위 정의를 함께 보관해 지도 변경 후에도 결과 폴더 이름을 유지한다.
- `static/canvas.js`의 선택 영역 인페인팅은 부위가 바뀌어도 선택 영역 안의 첫 결과 폴더 하나를 재사용한다. 기존 인페인팅·부위 폴더와 이름을 바꾼 결과 폴더를 인식하며, 이미 여러 폴더가 있으면 기존 내용과 배치는 유지한다. 참조·업스케일·붙여넣기 결과도 같은 경계를 사용하고 각 생성 결과의 부위 기록은 유지한다. 레이어 목록은 `CanvasDakiFocus.selectionLabel`의 현재 부위와 기존 내부 항목 수를 표시하며, 프로젝트가 연결되지 않으면 `선택 영역` 문구를 유지한다.
- 검증: `tests/test_canvas_daki_regions.js`, `test_canvas_daki_map_editor.js`, `test_canvas_daki_prompt_rules.js`, `test_canvas_daki_focus.js`, `test_canvas_daki_hud.js`, `test_canvas_daki_integration.js`, `tests/test_daki_tag_catalog.py`. 브라우저 검증은 `.qa/canvas_body_focus_server.py`의 합성 자료와 실제 캔버스 화면으로 수행하며 외부 생성은 차단한다.

## 캔버스 전체 그림 보정

- `static/canvas_retouch.js`가 전체 합성본 준비, 미리보기·브러시·유동화 조작, 적용과 출력 요청을 소유한다. `canvas.html`의 **전체 그림 보정**으로 열며 기존 가운데 캔버스와 오른쪽 레이어 패널을 사용한다. `static/canvas_retouch_panel.js/.css`는 기존 NAIM 토큰으로 도구·레이어·마스크·비교·인쇄 규격을 표시한다.
- `static/canvas_retouch_state.js`는 9가지 보정의 기본값, 기존 8단계 프리셋, 기록 정규화와 최대 50회의 실행 취소를 담당한다. 8단계 목록은 `RECIPE_STEPS`로 제공하고 `recipe(makeId, selectedIds)`는 선택한 단계만 기존 순서로 만든다. 선택 생략은 종전 8단계 전체, 빈 목록은 추가 없음이며 저장 형식은 바뀌지 않는다. 패널의 **8단계 골라 추가**에서 전체 선택/해제와 적용 범위(전체/칠한 곳만)를 확인하고, 선택 묶음을 한 번에 추가·실행 취소한다. 최대 40개 보정 레이어·10만 점·160MP를 허용한다. 좌표가 없는 색감·강도 설정만 다른 캔버스로 복사할 수 있다.
- 보정 목록의 **보정 지우개** 또는 E는 선택한 보정의 마스크만 지운다. Shift+클릭은 개별 레이어의 선택 추가/해제, 일반 클릭은 단일 선택이다. 지우개는 획을 시작할 때 선택된 모든 레이어에 같은 부드러운 마스크 획을 독립적으로 기록하고 한 번에 실행 취소/다시 실행한다. 진행 중에도 선택한 보정 모두를 미리 보이며 취소하면 모두 폐기한다. 점 수 한도는 대상 레이어 수까지 합산해 초과 시 전체 획을 거부한다. 설정 변경·삭제·복제·**지운 곳 복원** 등 다른 조작은 현재 활성 레이어 한 개에만 적용한다. 복수 선택 상태는 세션 UI에만 보관하고 기존 `mask.strokes[].erase` 저장 형식을 유지한다. 첫 지우개는 경계 선명도 0%·강도 100%이며 크기·강도·선명도를 다른 브러시와 분리해 세션 동안 기억한다.
- 지우개 검증은 합성 자료로 1280×900·800×800, 브라우저 100%·DPR 1에서 선택 보정만 지우기·복원·실행 취소/다시 실행·적용 후 재편집을 확인한다. 단일 선택은 `.qa/retouch-performance-baseline/verify_eraser.cjs`, 복수 선택과 5000×16000 적용·재편집은 `.qa/retouch-multiselect-baseline/verify_multiselect.cjs`, 상태·조작 회귀는 `tests/test_canvas_retouch_state.js`, `test_canvas_retouch_panel.js`, `test_canvas_retouch_controller.js`를 사용한다.
- 전후 비교는 왼쪽 원본·오른쪽 보정본이며 가운데 원형 손잡이 또는 오른쪽 슬라이더로 경계를 옮긴다. 손잡이는 방향키(Shift: 10%), Home/End도 지원한다. 비교 위치는 세션 UI 상태로만 유지하고 보정 기록·저장을 바꾸지 않는다. 확대 영역의 원본은 필요할 때 한 번 요청하며 같은 영역의 비교 위치 변경은 이미 받은 결과만 다시 그린다. 입력·끝점·취소·브러시 간섭 회귀는 `test_canvas_retouch_controller.js`에서 확인한다.
- 비교 손잡이 검증: 보정 controller·panel·state JavaScript 36개와 문법 검사 통과. 합성 그림으로 1280×900·800×800에서 드래그, 원본/보정본 표시, 슬라이더 연동, 키보드·양 끝 클릭 유지·비교 끄기를 확인했다.
- 보정 프리셋은 전체 분위기 7종(내추럴·맑은 색감·따뜻한 색감·차분한 색감·깊은 명암·색감 생기·명암 또렷하게), 피부·혈색 4종, 음영·빛 3종을 제공한다. 부분 프리셋은 빈 paint 레이어를 만들며 직접 칠한 곳만 바뀐다. 혈색·온기는 색상 합성으로 원본 밝기와 음영을 유지한다. 머리·피부를 자동 판별하지 않는다. 기존 8단계의 밝기·대비·베이지 보정과 저장본은 유지하고 해당 프리셋을 접힌 구역에 둔다.
- 프리셋 목록·분류·설정의 소유자는 `static/canvas_retouch_state.js`다. `createPreset(id, makeId, strength)`는 기본 강도 1과 0.5/1.5를 지원하며 기존 `layer` 별칭과 `layers` 배열을 반환한다. 전체 프리셋의 tone 값 또는 color 불투명도, 부분 프리셋의 분사량에 강도를 반영한다. 패널은 분류·카드·강도 선택만으로 문서를 변경하지 않고 추가할 때 controller에 전달한다. 여러 레이어는 용량을 먼저 검사해 한 번에 추가·실행 취소하며 기존 v1 레이어 형식으로 저장한다.
- 프리셋 개편 검증: state·panel·controller JavaScript 53개와 Python 화면 정적 검사 19개 통과. `.qa/retouch_preset_validation.py`는 14개×3강도의 실제 엔진 출력을 합성 도형으로 비교해 알파·부분 영역 보존과 머리 음영 유지 기준을 확인한다. 1280×900·800×800에서 분류·선택·강도·추가·일괄 실행 취소/다시 실행·적용과 재편집을 확인했다. 스크린샷은 `.qa/canvas-retouch-presets-1280.png`와 `-800.png`다.
- `static/canvas_retouch_brush.js`는 에어브러시의 증분 실시간 미리보기만 담당한다. 저장·최종 처리는 기존 controller와 Python 엔진을 사용한다. `brush: 'airbrush'`와 `flow`를 가진 획은 일정 간격으로 분사하며 정지 중 100ms마다 누적되고 한 획으로 실행 취소된다. 기존 획은 종전 처리 경로를 유지한다. 색상·소프트 라이트·곱하기·스크린 합성, 마스크, 원본 알파를 지원한다. 종료·취소·포커스 상실 때 분사 타이머를 정리하고, 재편집 시 마지막 에어브러시 획의 붓 설정을 복원한다.
- `static/canvas_retouch_liquify.js`는 유동화 5개 모드의 실시간 미리보기를 담당한다. controller가 현재 미리보기와 보호 마스크를 한 번 읽고, 엔진은 새 이동 구간의 브러시 영역만 증분 계산해 화면 프레임당 한 번 표시한다. 놓는 순간 마지막 좌표까지 반영하고 서버 결과가 올 때까지 유지하며, 취소·닫기·실행 취소는 진행 중 미리보기를 폐기한다. 드래그 중에는 서버 미리보기를 요청하지 않는다. 화면 합성본 위의 임시 미리보기이므로 뒤에 놓인 보정 레이어가 있으면 최종 결과와 차이가 날 수 있으며, 기존 Python 엔진이 전체 레이어 순서·원본 해상도로 확정한다. v1 획·저장·적용 API는 유지한다. 회귀: `test_canvas_retouch_liquify.js`, `test_canvas_retouch_controller.js`.
- 피부 보정 검증: 관련 JavaScript 62개·격리 Python 52개 통과. `.qa/retouch_skin_validation.py`의 합성 도형 비교에서 모든 부분 프리셋은 칠하지 않은 머리 픽셀을 그대로 유지했고 혈색·온기의 밝기 오차는 255단계 중 0.5 미만이었다. `.qa/canvas_retouch_skin_server.py`로 1280×900·800×800에서 칠하기·정지 분사·실행 취소·다시 실행·프로젝트 저장 복원·적용 후 재편집과 붓 설정 복원을 확인했다. 실제 사용자 그림·인쇄물과 새 EXE 빌드는 검증 범위에 포함하지 않는다.
- 편집 중에는 선택적 `retouchDraft: {document, targetLayerId}`를 기존 캔버스 저장 경로로 보관한다. `document` v1은 불변 합성 원본 `source`, 원본 크기, 보정 레이어·마스크·획, 인쇄 규격·메모·체크를 포함한다. 적용하면 기존 레이어를 보존하고 전체 크기의 일반 이미지 레이어에 결과 `src`와 `retouch` 기록을 넣는다. 결과 레이어를 선택해 다시 열면 저장된 원본으로 재편집한다. `canvas.js`/`canvas_setups.js`가 저장·복원·초기화 경계를 연결한다.
- `naim/web/canvas_retouch.py`는 기존 이미지 읽기/저장 어댑터를 주입받아 `/api/canvas/retouch/{preview,viewport,mask,detail,apply,jobs/<id>,export-pair}`를 제공한다. 전체 미리보기는 긴 변 1600px, 실제 픽셀 검사는 최대 512×512px이다. 원본 적용은 하나의 작업만 실행하고 `running → done/error`, 진행률 0~1로 응답한다. 이미지 처리를 직렬화하며 바쁜 경우 재시도 가능한 409를 반환한다. 프런트는 취소·종료한 작업의 늦은 결과를 버린다.
- 반복 미리보기는 `naim/images/retouch_preview.py`의 단일 원본 캐시를 사용한다. 매번 원본을 읽어 내용 해시를 확인하되 같은 원본의 정규화·축소는 반복하지 않는다. 캐시는 1600px 이하 이미지 한 장만 소유하고 교체·원본 적용·양면 출력 때 닫는다. 활성 복제 도구는 원본 좌표 샘플링을 보존하기 위해 기존 전체 원본 경로를 사용한다. controller는 60ms 단위로 최신 설정을 모아 한 요청씩 처리하고, 완료된 중간 결과를 표시한 뒤 대기 중인 최신 설정을 보낸다. 일반 붓·마스크·지우개도 누른 상태의 임시 획을 미리 보이며 놓을 때만 저장·실행 취소 기록 한 개로 확정한다. 에어브러시·유동화의 기존 로컬 미리보기는 유지한다.
- `static/canvas_retouch_viewport.js`는 확대된 화면의 보이는 영역과 원본 비교 타일만 소유한다. 기본 미리보기보다 높은 해상도가 필요하면 원본 좌표 crop과 화면 배율을 `/viewport`로 보내고, 최대 4096px·4,194,304픽셀·원본 1:1 이내로 제한한다. 이동·확대·리사이즈 뒤 150ms에 갱신하며 설정 변경·닫기·늦은 응답을 취소하고 bitmap을 닫는다. 표시 중 해당 영역의 저해상도 canvas를 잘라 투명도가 이중 합성되지 않게 한다. 저장·적용은 기존 원본 크기 경로를 사용한다.
- 미리보기 검증은 `.qa/retouch-preview-baseline/`에 있다. 5000×16000 합성 PNG의 밝기 변경 5회 중앙값은 1158.51→83.32ms였고 이전 결과 픽셀과 같았다(첫 준비 1166.32ms). 1280×900·800×800, 브라우저 100%·DPR 1에서 8단계 부분 추가·실행 취소, 놓기 전 지우개 반영, 연속 불투명도 갱신, 확대·이동·전후 비교를 확인한다. 회귀는 `test_canvas_retouch_preview.py`와 `test_canvas_retouch_viewport.js` 및 기존 state·panel·controller 테스트로 검증한다. 실제 응답 시간은 원본과 보정 조합에 따라 달라진다.
- `naim/images/retouch.py`는 다키메이커의 로컬 보정 알고리즘을 이식한 순수 픽셀 처리 모듈이다. EXIF 방향·sRGB를 정규화하고 원본 알파를 유지한다. 출력은 sRGB와 가로 규격 기준 DPI가 포함된 PNG이며 재단 가이드는 그림에 합성하지 않는다. 양면 ZIP은 현재 면의 보정본과 선택한 반대면 후보/저장 캔버스를 포함한다. NovelAI나 외부 서비스를 호출하지 않는다.
- 큰 이미지 적용은 효과 없는 레이어와 마스크가 빈 타일을 건너뛰고, 원본 복제 도구가 없으면 전체 원본 사본을 유지하지 않는다. 전체 불투명 합성과 미사용 톤 계산을 단축하고 펄린 질감의 격자 계산을 재사용한다. 행별 진행률과 PNG 저장 단계를 표시한다. 5000×16000 합성 이미지·기본 8단계 기준 처리 185.36→69.68초, 최대 작업 메모리 996.9→640.5MiB, 결과 픽셀 SHA-256 동일을 확인했다. PNG 인코딩은 별도 2.68→2.00초이며 실제 자료·보정 조합에 따라 시간은 달라진다. 측정·원본 비교 자료는 `.qa/retouch-performance-baseline/`, 회귀는 `tests/test_canvas_retouch.py`에서 확인한다.
- 지우개가 누적된 보정은 렌더 크기의 L 마스크를 한 번 만들고 타일과 동일 마스크 레이어가 공유한다. 전체 적용은 한 장만 소유하며 실패·완료 때 닫는다. 미리보기는 `retouch_preview.MaskCache`에 최대 16MiB를 보관하고 마지막 획 이전의 결과를 재사용해 자라는 획만 다시 계산한다. 원본·크기·배율·영역·기록이 바뀌면 잘못된 결과를 재사용하지 않으며 원본 교체·전체 적용·양면 출력 때 비운다. 색 덧입히기의 독립 채널 모드는 기존 합성식으로 만든 256×256 표를 사용하고, 생기는 RGB 축약 및 범위를 벗어난 픽셀만의 계산으로 같은 결과를 유지한다.
- 누적 지우개 검증 자료는 `.qa/retouch-apply-stalls/`에 있다. 5000×16000 합성 PNG에 반경 606.5px·경계 선명도 0·강도 76%의 지우개 10획(각 1000점)을 적용한 따뜻한 색감 한 레이어의 렌더는 109.67→16.01초, PNG 저장은 2.52→2.12초였다. 같은 조건의 생기는 111.02→30.64초, PNG 저장은 1.81→2.47초였다. 두 보정을 함께 지우는 미리보기 API의 반복 요청 평균은 1079.63→484.18ms(첫 준비 제외)다. 이는 합성 입력 측정이며 즉시 처리나 실제 사용자 자료의 시간을 보장하지 않는다. 전체 마스크 기준으로 타일 경계를 일관되게 처리하므로 이전 타일별 GaussianBlur의 반올림과 미세 차이가 날 수 있다(1600²·25획 비교에서 마스크 최대 2/255). 회귀는 `test_canvas_retouch_mask_cache.py`, `test_canvas_retouch_mask_preview.py`, `test_canvas_retouch_color_table.py`, `test_canvas_retouch_vibrance.py`와 기존 보정 테스트로 확인한다.
- 원본과 결과는 기존 캔버스 가져오기 자산 저장소를 사용하며 결과 접두사 `canvas_import_retouch`는 기존 자산 정리 규칙을 따른다. 저장본과 프로젝트의 재귀 참조 검사로 보정 원본도 보호한다. `naim_setup.py`의 필수 패키지와 EXE spec에 NumPy를 포함한다.
- 검증 진입점: `tests/test_canvas_retouch.py`, `tests/test_canvas_retouch_state.js`, `tests/test_canvas_retouch_panel.js`, `tests/test_canvas_retouch_controller.js`. 합성 브라우저 서버 `.qa/canvas_retouch_server.py`는 실제 보정 라우트와 캔버스 UI를 사용하며 원본·결과·프로젝트는 메모리에서만 관리한다. 실제 사용자 데이터와 생성 API는 사용하지 않는다.
- 2026-10-17 확인: 관련 JavaScript 91개, 격리 Python 캔버스 검사 61개 통과. 1280×900·800×800에서 브러시·유동화·마스크·전후 비교·반대면 색 채취, 적용/재편집/프로젝트 저장 복원, 실제 512px 검사와 양면 ZIP 출력을 확인했다. 좁은 창에서는 보정 중인 동안 왼쪽 도구 모음을 접어 그림 공간을 확보한다. 대용량 인쇄 파일 성능과 새 EXE 빌드는 이 검사에 포함하지 않았다.

## 여러 캔버스 작업 공간

- `canvas.html`의 **여러 캔버스**는 페이지 이동이나 새 창 없이 현재 편집기를 그대로 연결한다. `static/canvas_workspace.js/.css`가 기존 창 안의 메인 한 개와 다른 캔버스의 그림 표시·숨김, 이동·크기 조절, 추가·닫기를 소유한다. 다른 그림이나 헤더의 **메인** 드롭다운을 선택하면 해당 캔버스와 메인이 자리를 바꾼다. **표시** 드롭다운의 체크박스로 참고 그림을 여러 개 선택하며, 메인은 항상 표시한다. **+ 추가**는 프로젝트·저장본·새 캔버스를 열고 **열린 작업 관리**는 저장 후 작업을 닫는다. 헤더 조작은 활성 편집기와 함께 이동한다. 1000px 이하에서는 헤더의 **편집·레이어** 버튼으로 기존 패널을 연다.
- 헤더의 **캔버스·도구** 메뉴는 `canvas.html`, `static/canvas.css`, `static/canvas_header.js`가 소유한다. 프로젝트 연결과 저장 상태는 메뉴 밖에 표시한다. 메뉴 이벤트는 현재 헤더에 위임하며 다른 문서에서 옮긴 표시 체크박스에도 적용한다. 체크박스는 메뉴를 유지하고 버튼 선택·바깥 클릭·Escape는 닫는다. 팝업은 화면 안에 배치하고 긴 이름은 목록에서 줄바꿈하며 메인 선택의 전체 이름은 title로 확인한다.
- 처음 열려 있던 편집기는 원래 문서에 남고, 추가한 `/canvas?workspace=<id>&pane=<id>` 문서는 비활성일 때 숨겨 둔다. 화면에는 메인 편집기 하나만 보이며 다른 문서는 최대 1024px 그림으로 합성해 표시한다. 선택 전환 시 편집기를 다시 만들지 않아 레이어·확대·보정 미리보기·실행 취소가 유지된다. `static/canvas_workspace_bridge.js`는 원본·송신 창·pane ID를 검증하며 생성·보정 적용 중이거나 저장에 실패하면 닫기와 갤러리 이동을 차단한다. 보정 미리보기 완료도 그림 갱신에 전달하고, 활성·숨김 그림은 중복 합성하지 않는다. 보정 설정 복사는 색·강도만 공유하며 좌표·획을 복사하지 않는다.
- `static/canvas_workspace_state.js`가 ID/목록 정규화, URL과 저장 키를 소유한다. 기존 `naia_canvas_state_v1`은 유지하며 작업 공간 목록은 `naia_canvas_workspace_v1:<id>`, 개별 복구 상태는 `naia_canvas_pane_v1:<workspace>:<pane>`에 저장한다. 닫아도 복구 상태를 삭제하지 않는다. 프로젝트 연결은 기존 revision API를 재사용하고 작업 공간의 레이어·마스크·보정 기록을 독립적으로 저장한다. 외부 이미지 정리 시 모든 개별 복구 상태의 참조를 함께 보호한다.
- 선택적 `pane.reference`는 `visible/x/y/width/height`를 보관한다. 이전 목록은 필드 없이 읽으며 기본 위치를 계산한다. 메인 교체 시 두 항목의 표시 위치를 교환하고 실제 레이어의 고정 속성은 바꾸지 않는다. 최초 연결 이후 자동 저장·초기화는 동적으로 해당 pane 저장 키를 사용하며 기존 단일 슬롯을 덮어쓰지 않는다. 주소만 `history.replaceState`로 갱신해 새로고침 시 기존 workspace URL로 복원한다.
- 이름 있는 저장본은 `/api/canvas/setups/patch`의 `upserts`/`removeIds`로 해당 항목만 잠금 안에서 병합한다. 이전 `/api/canvas/setups`의 `{setups: [...]}` 요청과 저장 형식은 호환한다. 별도 URL을 사용해 이전 서버가 부분 갱신 요청을 빈 전체 목록으로 해석하지 못하게 하며, 이전 서버에서는 재시작을 안내하고 현재 작업을 유지한다. 두 캔버스에서 저장해도 서로의 다른 저장본을 제거하지 않는다.
- **캔버스 관리**는 기존 이름 있는 저장본만 검색·썸네일·확대·불러오기·이름 변경·삭제하는 갤러리다. `static/canvas_saved_gallery.css`와 `canvas_setups.js`가 화면을, `static/daki_canvas_previews.js`의 `observeState`가 상세 요청 없는 저장본 합성을 담당한다. 공통 미리보기의 지연 로딩·동시 2개 제한·취소를 재사용하며 확대 창은 `canvas_dialogs.js`의 포털로 키보드와 초점을 유지한다.
- 여러 캔버스의 **+ 추가**는 현재 편집 프로젝트의 앞·뒷면을 먼저 보여 주고 다른 프로젝트·저장본을 갤러리에서 여러 개 선택해 추가한다. 검색 중 미리보기는 재사용하며 닫으면 요청을 취소한다. 참고 그림의 **높이 맞춤**은 원본 비율과 캔버스 표시 높이를 유지하며 선택적 `reference.fitHeight/fitRatio`를 보관한다. 큰 그림은 카드 내부에서 스크롤하고 이후 크기 조절에도 비율을 유지한다. 화면 격자와 중앙 보조선은 처음 열 때 모두 꺼진다. 회귀: `test_canvas_saved_gallery.js`, `test_daki_canvas_previews.js`, `test_canvas_workspace*.js`, `test_canvas_grid.js`; 합성 브라우저 검증은 `.qa/check_canvas_management.cjs`, `.qa/check_canvas_multi_gallery.cjs`에서 시작한다.
- 회귀는 `test_canvas_workspace*.js`, `test_canvas_state.js`, `test_canvas_setups.js`, `test_canvas_setup_merge.py`, `test_canvas_setup_routes.py`와 기존 프로젝트/보정/자동 저장 테스트다. `.qa/verify_inline_workspace.cjs`는 `.qa/workspace_browser_transport.py`를 통해 합성 Flask 응답을 브라우저에 공급한다. 1280×900·800×800에서 원래 편집기 유지, 그림 선택·교체·표시·숨김·이동·크기 조절, 보정 실행 취소·다시 실행, 닫기·복원·새로고침을 검증한다. 사용자 데이터와 NovelAI 생성은 사용하지 않는다.

## 남은 검증 및 다음 경계

2026-09-06 핵심 최적화: `naim/gallery/catalog.py`가 기존 인덱스의 폴더 요약·최대 512장 페이지/선택 경로 조회를 담당한다. `app.py`의 `catalog=1`과 `/api/gallery/images`를 `static/gallery_catalog.js`/`static/index.js`가 사용한다. 가상 폴더도 요약과 결과별 조회를 사용하며 기존 전체 응답 API는 호환 경로로 유지한다. 회귀는 `tests/test_gallery_catalog.py`, `tests/test_gallery_catalog.js`, `tests/test_gallery_virtual_loading.js`.

1.2 갤러리 업그레이드는 `HistoryDB.create_table()`에서 완료 표시를 유지하고 모델 정보가 없는 기존 행만 V5로 보완한다. 초기 1.3에서 완료 표시가 해제된 목록은 `has_usable_gallery_index()`로 먼저 제공하고 백그라운드에서 확인하며, 실제 전체 확인이 끝날 때까지 완료로 표시하지 않는다. 목록 갱신은 경로·수정 시각이 같은 모델 정보를 재사용하고, 폴더 페이지 조회는 `(folder_path, rel_path)` 인덱스를 사용한다. 회귀는 `tests/test_gallery_upgrade.py`, `tests/test_gallery_index_background.py`, `tests/test_gallery_page_performance.py`, `tests/test_gallery_index_jobs.js`.

카드 해제·복원은 `static/gallery_recycling.js`, 실제 카드 생성·논리 순서는 `static/index.js`가 소유한다. `static/index.css`는 재활용 카드의 실제 높이 측정을 보장한다. 회귀는 `tests/test_gallery_recycling.js`. 대용량 재현은 `tools/check_gallery_scale.py`, 완료 검증은 `REMAINING_SCOPE_COMPLETION_2026-09-06.md`를 확인한다.

- 작은 카드의 배치는 `static/index.css`, `static/gallery_modern.css`, `static/daki.css`가 담당한다. 일반 카드의 내부 폭 220px 이하, 프로젝트 카드 280px 이하에서는 28px 아이콘 버튼을 한 줄로 표시하고 `title`과 `aria-label`로 기능을 안내한다. 캔버스 상세·열기·삭제는 하단 조작부를 공유하며 큰 카드에서는 텍스트를 표시한다. 이름·날짜는 줄바꿈하고 프로젝트 카드 높이는 내용에 맞춰 늘어난다. `static/index.js`의 `getGalleryEffectiveColumnCount(grid)`는 저장된 크기 설정을 유지하면서 실제 사용 폭과 최소 카드 폭 120px로 열 수를 제한한다. `static/daki.js`도 같은 배치 계산을 재사용한다. 회귀: `tests/test_gallery_rendering.js`, `tests/test_daki.js`.
- 시안 폴더 전체 삭제는 `static/daki_draft_folder_actions.js/.css`의 공통 카드·확인 모달에서 시작하고 `static/daki.js`와 `static/daki_drafts.js`가 목록 갱신·화면 이동을 연결한다. `POST /api/daki/draft-folders/<id>/delete` → `naim/daki_drafts.py`의 `delete_folder`가 폴더와 내부 시안(선택·숨김 포함), 생성 설정을 삭제한다. 생성 중인 시안은 차단하고 다른 곳에서 참조 중인 시안은 추가 확인한다. 파일을 임시 위치로 옮긴 뒤 기존 원자 저장 API로 카탈로그를 갱신하며 저장 실패 시 복구한다. 기존 미분류 가상 폴더와 개별 시안 삭제 계약은 유지한다. 회귀: `tests/test_daki_draft_folders.py`, `tests/test_daki_draft_folder_actions.js`, `tests/test_daki_drafts.js`.

`static/canvas_autosave.js`는 기존 저장 형식의 200ms 저장 합치기·실패 상태·즉시 저장을 소유한다. `canvas.html`/`static/canvas.js`가 상태 UI와 종료 처리를 연결한다. 마스크 변경 영역 갱신은 `static/canvas.js`, 픽셀 동등성 검증은 `tests/test_canvas_mask_pixels.js`, 저장 회귀는 `tests/test_canvas_autosave.js`. 최신 측정과 검증 범위는 `UX_PERFORMANCE_REVIEW_2026-09-05.md`의 후속 핵심 수정을 확인한다.

- 구버전 updater UI에서 공개 배포 서버 다운로드를 포함하는 릴리스 전 검증.
- NovelAI 실제 과금 생성/인페인트 검증 범위 답변 대기. 현재는 합성 응답을 재현한다.
- 사용자 결정으로 파일 이동·휴지통 복구의 동일 이름 충돌 처리는 이번 범위에서 제외했다. 기존 코드의 일반 이미지/TXT/JSON 이동 누락 경로는 별도 작업으로 남아 있다.
- 여러 파일·태그·DB 변경의 프로세스 강제 종료/디스크 장애까지 견디는 복구는 미완료. 현재 이미지 교체 복구는 정상 실행 중 발생한 예외를 대상으로 한다.
- 서버 라우트/외부 API/작업 큐 분리와 남은 대형 UI 파일의 상태 의존성 축소.
- 다른 브라우저 및 실제 외부 사이트별 클립보드 형식 차이 검증. 이미지 주소/HTML만 복사한 경우는 이미지 바이트 복사와 다르다.

## 인페인팅 참고 이미지

- 캔버스 레이어 삭제 확인은 `static/canvas_layer_delete.js/.css`가 소유한다. 원본 클립(`type: clip`, `renderOnCanvas`가 꺼짐)이 포함된 레이어·선택 영역·폴더만 확인하며, 취소를 기본 포커스로 둔다. `static/canvas.js`는 확인한 객체와 하위 ID 집합을 다시 확인한 뒤 삭제하며, 목록 갱신으로 마우스 아래 버튼이 바뀌면 재지정 전 클릭을 차단한다. 삭제 후 기존 저장·실행 취소·자산 정리 경계를 재사용한다. `canvas_history.js`는 기록마다 자산 참조를 보관하고 `canvas_history_bridge.js`가 이를 조회해 삭제 때 모든 이력을 재파싱하지 않는다. 인페인팅 진행 표시는 기존 편집기를 유지하고 상태만 갱신하며, 완료 이미지에는 짧은 페이드와 동작 줄이기 설정을 적용한다. 회귀: `test_canvas_layer_delete.js`, `test_canvas_layer_actions.js`, `test_canvas_history.js`, `test_canvas_history_bridge.js`, 기존 mask lifecycle/inpaint reference bridge 테스트. 합성 UI 검증: `.qa/inpaint-layer-ui.cjs`; 삭제 성능 비교: `.qa/inpaint-layer-performance.cjs`. 저장 형식과 생성 API는 유지한다.

- `static/canvas_inpaint_reference.js/.css`가 참고 이미지 업로드·설정 영역의 폭 편집·전송 체크·프로젝트 설정 복사를 소유한다. `참조 영역 포함 표시`와 `참고 이미지 포함`은 함께 켜고 끄며 선택 영역 왼쪽에 이미지나 폭을 덧그리지 않는다. `static/canvas.js`의 `updateSelectionSizeTooltip`은 클립 생성 전 선택 영역 크기 조절 중 `request(width, height)`를 사용해 선택 크기·참고 폭·전체 요청 크기를 표시하고 전체 면적으로 Anlas 크기 범위를 판단한다. 일반 이미지 크기 안내는 기존 계산을 유지한다. 왼쪽 설정은 제목으로 접고 펼치며 페이지를 처음 열면 접힌다. 접기 상태는 참고 이미지 설정과 별개이며 저장하지 않는다. `canvas.html`은 로드와 설정 컨테이너만 제공한다. `requestClipInpainting`은 기존 작업 크기와 선택 영역을 유지하며 비용 확인에는 참조를 더한 크기를 사용한다.
- 캔버스 상태의 선택적 `inpaintReference`는 `{reference, showArea, include}`이며 `reference`는 `null` 또는 `{src, name, width, x, y, zoom}`이다. 두 체크 값이 다른 기존 저장본은 실제 전송 여부인 `include`를 기준으로 복원하고 두 키를 계속 저장한다. 폭은 기본 320px, 64~1024px의 64px 단위다. 기존 x/y(0~1)와 zoom(1~8)은 저장 호환을 위해 검증·보존하되 전송 이미지에는 적용하지 않는다. 기존 공개 `cropBox`/`fitBox`/`reference_crop_box`는 호환용으로 유지한다. `canvas_setups.js`가 기존 상태 복원을 재사용하며, 새 캔버스는 초기화하고 실행 취소·자동 저장·저장본의 자산 참조 보호에 포함한다.
- `naim/images/inpaint_reference.py`는 설정 검증, `reference_fit_box`의 전체 이미지 축소·흰 여백 배치, 왼쪽 이미지·검은 마스크 합성, 응답 크기 검사·참조 부분 제거와 요청용 `split screen` 추가를 담당한다. 확대 없는 최소 배율, 치수의 반올림, 중앙 위치의 내림을 사용한다. `app.py`의 `/api/canvas/inpaint`는 선택적 `reference`를 받고, 응답을 원본 크기로 자른 다음 기존 마스크 합성과 PNG 저장을 진행한다. 저장된 프롬프트에는 임시 배치 태그를 덧붙이지 않는다.
- 프로젝트 `canvasSettings.inpaintReference`는 기존 GET/PUT·revision·원자 저장을 재사용한다. 필드가 없는 기존 편집 요청은 저장된 참고 설정을 유지하고 명시적 null은 해제한다. 캔버스에는 버튼으로 한 번 복사하며 이후 자동 동기화하지 않는다. `project_canvas_import_refs`는 프로젝트 설정만 참조하는 업로드 이미지도 보호한다.
- 회귀: `test_inpaint_reference.py`, 격리 `test_canvas_inpaint_reference_api.py`, `test_project_canvas_settings.py`, JS `test_canvas_inpaint_reference.js`·`test_canvas_inpaint_reference_bridge.js`·`test_canvas_selection_size.js`. 합성 이미지와 모의 생성 응답을 사용하며 실제 유료 생성은 실행하지 않는다.

# 프로젝트 보관·삭제 및 조회

- `static/daki_project_removal.js/.css`가 프로젝트 상세 화면의 삭제 창을 소유한다. 기본 선택은 그림 보관이며, 그림까지 삭제할 때 다른 항목의 참조가 있으면 추가 확인을 요구한다. `naim/web/project_removal.py`의 POST `/api/daki/projects/<id>/delete`는 `action: archive|delete`, 선택적 `confirm_daki: boolean`을 받는다.
- `naim/images/project_removal.py`는 후보 그림과 연결된 시안 폴더의 미채택 결과까지 처리한다. 보관은 원본·JSON·TXT를 재압축 없이 갤러리 `No_Metadata/프로젝트 보관`으로 옮기며, 성인 분류 폴더는 유지한다. 공유·개인 그림체 라이브러리 원본은 유지한다. 프로젝트 설정과 편집 캔버스는 두 선택 모두 제거한다.
- 프로젝트 JSON과 시안 폴더는 각 저장 소유자의 `staged_project_removal`에서 오류 시 복구한다. `naim/storage/project_archives.py`는 기존 DB의 선택적 별칭 테이블을 통해 다른 프로젝트와 캔버스의 이전 그림 주소를 계속 읽는다. 보관한 그림만 인덱스에 추가하며 전체 갤러리를 다시 색인하지 않는다.
- 프로젝트 목록·상세는 `DakiProjectsStore`의 `summary=True` 조회로 캔버스 본문 복사를 생략한다. 개별 캔버스는 `get_canvas_with_project`로 JSON을 한 번 읽는다. 기존 저장 형식과 기본 전체 조회는 유지한다. `static/canvas_project.js/.css`의 교체 경고는 취소·Escape에서 현재 작업을 유지한다.
- 큰 프로젝트 조회는 저장소별 최신 JSON 스냅샷 하나를 재사용하며, 경로·파일 식별자·수정 시간·크기가 바뀌면 다시 읽는다. 저장·삭제는 기존 원자 저장 경로를 유지한다. 카드 미리보기의 GET 캔버스 요청만 `?preview=1`로 표시할 레이어·좌표·이미지 주소를 받고, 편집용 기본 응답은 전체 데이터를 유지한다. `static/daki_canvas_previews.js`는 같은 페이지에서 최대 8개 이미지 로드를 공유하고 페이지 종료 시 해제한다.
- `naim/images/dimensions.py`는 PNG/WebP 크기와 EXIF 회전을 픽셀 디코딩 없이 읽는다. 프로젝트 상세는 기존 크기 캐시를 유지하면서 이 함수를 사용한다. `test_image_dimensions.py`, `test_daki_read_cache.py`, `test_daki_preview_api.py`, `test_daki_canvas_previews.js`가 원본 보존·저장 후 갱신·기존 편집 응답·미리보기 호환성을 검증한다. 합성 대용량 측정과 화면 검증은 `.qa/measure_project_large_files.py`, `.qa/serve_project_speed.py`에서 수행한다.
- 회귀: `test_project_removal.py`, `test_project_removal_storage.py`, `test_daki_project_removal.js`, `test_daki_read_performance.py`, `test_daki_image_refs.py`, `test_canvas_project.js`. 격리 UI 검증은 `.qa/serve_project_removal.py`에서 합성 자료와 비삭제 응답으로 수행한다.

# Daki 태그사전 화면

- 예시 썸네일 클릭은 큰 그림 선택만 하고 큰 그림·확대 그림 클릭도 시안 창을 열지 않는다. 미리보기 작업 줄과 확대 그림의 명시적 `시안으로 가져오기` 버튼이 `static/daki_dictionary_drafts.js/.css`의 프로젝트 선택 창을 바로 연다. 사전 항목과 태그 분류는 독립적으로 접고 펼치며, 항목을 접으면 왼쪽 탐색 공간을 확보한다. 프로젝트를 선택하면 기존 시안 폴더 생성 API로 새 폴더를 만들고 첫 캐릭터에 선택한 태그를 넣어 편집 화면으로 이동한다. 선택적 폴더 설정 `dictionary_reference: {image_id, tag}`는 `naim/daki_drafts.py`에서 검증하며 `static/daki_drafts.js/.css`가 결과 옆 참고 그림과 저장·생성 시 보존을 담당한다. 자동 생성은 하지 않는다. 참고 그림은 기존 사전 이미지 ID를 사용하므로 원본 또는 연결 폴더가 사라지면 읽기 실패 안내를 표시한다. 회귀: `test_daki_dictionary_drafts.js`, `test_daki_drafts.js/.py`, `test_daki_draft_folders.py`; 합성 자료 화면 검증: `.qa/verify_dictionary_drafts.cjs`.
- 태그사전은 상단 버튼에서 `#daki&library=dictionary`로 이동하며 Daki 프로젝트 목록에는 별도 카드를 두지 않는다. `static/daki_dictionary.js/.css`가 `/daki/dictionary`의 작업대 요소를 기존 `dakiContent` 안에 직접 장착하고 남은 창 높이를 사용한다. 바깥 갤러리·Daki 메뉴와 기존 프롬프트 삽입 팝업 `DakiTagBrowser`는 유지한다.
- 상단 캔버스 옆의 `openDakiDictionary` 링크도 같은 사전 경로로 이동한다. 갤러리·태그 사전·캔버스 순서의 진입 버튼은 `gallery-workspace-entry` 공통 스타일로 크기·글꼴·여백과 선 아이콘을 맞추고, 청록·금색·파랑으로 구분한다. 현재 화면은 `aria-current="page"`와 밝은 배경·하단 선으로 표시한다. 기본·선택 상태 모두 hover 색 변화를 제공한다. 사전이 열린 동안에만 모던 화면의 기존 라이브러리 사이드바를 숨겨 탐색 공간을 대체하며, 이동하면 같은 DOM을 다시 표시한다.
- `dictionary-navigation`은 태그 찾기·그림 전환·상단 접기/펼치기를 제공하며 화면 안의 갤러리·프로젝트 복귀 링크는 생략한다. `mount(host, {onHeaderChange})`의 선택적 콜백이 부모의 작업 줄과 사전 도구 줄을 함께 접으며, 부모는 남은 창 높이를 다시 계산한다. 다른 화면으로 나가면 접힘 클래스와 현재 페이지 표시를 정리한다. 직접 연 `/daki/dictionary`에서도 접기/펼치기를 지원한다. 큰 그림은 너비 맞춤으로 크게 표시하고 세로로만 스크롤한다. `그림 크게 보기`는 원본 로딩 후 활성화되며 `pictureOverlay`를 기존 오른쪽 그림 영역의 가로 위치와 폭 그대로 유지하며 위쪽 상단 메뉴 위까지 겹쳐 띄운다. 다른 사전 패널은 계속 조작할 수 있고 전체 화면 이동은 하지 않는다. 5:16 비율을 유지하고 닫기·Esc·그림 바깥 클릭으로 원래 선택·스크롤·초점으로 돌아간다. 이전 맞춤 전환의 `dictionary-picture-expanded`와 `dictionary-large-preview-v1` 값은 건드리지 않으며 새 표시 방식에서는 사용하지 않는다.
- `static/daki_dictionary/index.html`, `app.js`, `styles.css`는 왼쪽 사전 탐색·선택 항목 설명, 중앙 그림 목록, 오른쪽 큰 그림·사용 태그를 소유한다. 큰 그림의 열 폭은 `clamp(240px, 28vw, 420px)`로 확보하고 가운데 목록은 남은 폭을 사용한다. 사용 태그는 그림 바로 옆에 배치하며 연결 설정은 접어 둔다. 목록 미리보기는 5:16 전체를 최대 360px 높이로 보여 준다. 사용 태그를 누르면 해당 항목을 가리던 검색·분류 조건을 해제하고 왼쪽 이름·뜻·선택 행을 표시한다. 현재 그림에 그 태그가 있으면 그림을 유지한다. 호스트 너비 1100px부터 3열, 800~1099px는 왼쪽 탐색과 그림 목록/큰 그림 전환, 그보다 좁으면 탐색 서랍과 그림 목록/큰 그림 전환을 사용한다. 스타일은 `.daki-dictionary-tool`에 한정하고 각 패널이 스크롤을 소유한다. `DakiDictionaryWorkbench.mount(host)`의 반환값 `dispose()`가 요청·타이머·리스너·관찰자·열린 창을 해제한다. 통계 비율의 분모는 실제 원본 조합 수와 프롬프트가 있는 이미지 수다.
- `naim/web/daki_dictionary.py`의 `register_daki_dictionary_routes`가 `/api/daki/dictionary/*`를 제공하며 첫 요청 때 상태를 준비한다. `naim/daki_dictionary.py`는 사전·조합·통계·사용자 편집, `naim/daki_dictionary_images.py`는 PNG/WebP 메타데이터·정확한 양성 태그 매칭·점진 색인·썸네일과 종료 정리를 담당한다. 기존 이미지 SQLite 형식과 ID를 유지한다.
- 배포용 원본은 `data/daki_dictionary/dictionary.json`과 `source_combinations.json`, 편집·이미지 연결·캐시는 Git에서 제외한 `daki_dictionary_user/`에 둔다. 사용자 편집은 기존 원자 JSON 저장을 재사용하고 알 수 없는 필드를 보존한다. 사용자 폴더는 updater 및 기존 설치 가져오기의 보호 대상이다. `tools/import_daki_dictionary.py --source <원본 사전 폴더>`는 비어 있는 대상에만 원본 자료와 SQLite 백업을 복사한다. 변환 때만 Parquet 지원이 필요하고 앱 실행에는 필요하지 않다. 이미지 원본은 연결된 폴더에 그대로 둔다.
- 한국어 이름·설명·별칭 3,205개와 분류명 533개를 재검토했다. `data/daki_dictionary/translation_review.json`에 수정 전후·근거와 원문 유지 항목을 기록한다. 의미를 확정하지 못한 희귀 태그는 추정 번역 없이 영문만 표시한다. 분류의 표시 이름은 번역해도 ID·소속·빈도는 유지하며 편집 화면에서도 표시 이름을 기존 ID로 되돌려 저장한다.
- 회귀: 격리 `test_daki_dictionary*.py`, `test_naim_updater.py`, `test_legacy_import.py`; JS `test_daki_dictionary_view.js`, `test_daki.js`, `test_daki_tag_browser.js`, `test_gallery_script_loading.js`. `.qa/verify_workspace_header.cjs`와 `.qa/dictionary_transport.py`는 합성 자료로 modern 단일 화면, 갤러리·사전·캔버스 이동 버튼과 잔액 배치, 작업 메뉴를 1280×900·800×800, 배율 100%·deviceScaleFactor 1에서 확인한다.


## 일반 프롬프트 자동완성

- `data/prompt_tags/`의 영문 CSV와 `ko.json`은 다키 사전과 독립된 읽기 전용 배포 자료다. `NAI_Image_Manager.spec`에 포함하며 사용자 저장 파일과 병합하지 않는다.
- `naim/prompt_suggestions.py`가 최초 요청 시 태그를 합치고 한영 검색을 수행한다. `naim/web/prompt_suggestions.py`의 `/api/prompt-tags/suggest`는 현재 입력 중인 태그만 받는다. 정확 일치·접두 일치·부분 일치 순서 안에서 빈도순으로 제안한다.
- `static/prompt_autocomplete.js/.css`는 `data-prompt-autocomplete`가 있는 입력란에 공통 후보 UI를 제공한다. 동적 캐릭터·그룹·프리셋·부위 편집도 같은 속성을 사용한다. 후보에는 영문과 한글명을 표시하고 영문을 삽입한다. 후보 목록은 현재 입력 커서 바로 아래·옆에 배치하며 줄바꿈·입력란 내부 스크롤을 반영하고 화면 가장자리에서는 위쪽 전환과 좌우 보정을 적용한다. 번역 없는 항목은 영문만 표시한다.
- 갤러리 프롬프트 검색 및 가상 폴더 검색은 해당 속성을 붙이지 않으며 기존 검색 인덱스 자동완성을 유지한다. 읽기 전용 프롬프트와 이름·경로·설명 입력은 대상이 아니다.
- 검증 진입점: `tests/test_prompt_suggestions.py`, `tests/test_prompt_autocomplete.js`. 화면 검증은 `.qa/prompt-autocomplete/`의 합성 데이터로 1280×900·800×800, 배율 100%에서 수행한다.


### 그림체 관리의 공통 설정과 자동 목록 갱신

`naim/web/style_shared_settings.py`가 기존 `lab_config.json`의 NAI 키와 공통 생성 기본값(model, width, height, steps, scale, cfg_rescale, sampler, noise_schedule)의 단일 저장 경계를 제공합니다. `style_workspace.py`는 실행마다 만든 인증 토큰을 연결 프로세스의 환경으로 전달합니다. 연결 앱의 `naim_shared_settings.py`는 키 읽기/변경/삭제를 이 API로 연결하며 기존 독립 실행 설정 파일은 보존합니다. 브라우저용 응답에는 키를 포함하지 않습니다. 프롬프트·평가·생성 기록은 공유 대상이 아닙니다.

`static/daki_styles.js`와 연결 앱의 `static/naim_shared_library.js`는 표시 중인 공유 목록을 2초마다 조회합니다. 추가·제외를 반영하고 검색과 남은 선택을 유지하며, NAIM에서는 기존 카드 DOM을 재사용하고 화면 이탈 시 예약을 해제합니다. 연결 앱의 `static/naim_shared_settings.js`는 공통 생성 필드만 부분 저장하고 편집 중인 필드는 원격 조회로 덮지 않습니다. 연결 변경 후 서버 재시작이 필요합니다. 검증: `tests/test_style_shared_settings.py`, `tests/test_daki_styles.js`.

### 확정 그림체 복사와 개인 그림체·프로젝트 삭제

naim/web/confirmed_style_import.py는 연결된 작가 앱의 확정 목록·대표 그림을 로컬 HTTP로 읽고 기존 개인 저장소의 create_snapshot을 호출합니다. 아티스트 프롬프트·네거티브·지원 생성 설정과 대표 이미지 원본 바이트를 독립 복사하며 원본 앱을 수정하지 않습니다. 개인 저장소 내부 images 폴더만 소유하고 기존 외부 이미지 링크는 유지합니다. DELETE /api/daki/personal-styles/<id>는 등록 항목과 복사한 자체 이미지만 정리하며 저장 실패 시 복구합니다.

static/daki_personal_styles.js/.css는 확정 그림체 검색·60개씩 더 보기·복사와 취소 우선 삭제 모달을 담당합니다. static/daki.js의 프로젝트 목록 카드는 링크와 별도 삭제 조작을 두고 기존 DakiProjectRemoval 모달의 그림 보관/영구 삭제 선택을 재사용합니다. 검증: test_confirmed_style_import.py, test_daki_personal_styles.py/.js, test_project_removal.py, test_daki_project_removal.js, test_daki.js; 합성 브라우저 QA .qa/check_personal_project_actions.py (1280×900, 800×800).



### 리모콘에서 기존 그림체 프로그램 연결

`naim/desktop_ui.py`의 그림체 프로그램 연결 버튼 → `main_executor.pyw`의 `open_style_connection` → `naim/style_connection_ui.py`의 폴더 선택·미리보기·키 충돌 선택 → `naim/style_connection.py`의 읽기 전용 확인과 원자 저장 순서다. 실행 중인 서버·작업이 있으면 연결 저장을 막고, 서버를 정지한 뒤 저장하고 다음 서버 시작부터 적용한다.

프로그램 폴더, 소스 저장소의 `artist_rater/`, 데이터 폴더에서 `artist_rater.sqlite`를 찾는다. 여러 후보가 있으면 직접 선택한다. 선택한 데이터 폴더를 `style_workspace.local.json`의 `data_dir`로 기록하며, 기존 호환 실행 소스와 Python 연결을 재사용한다. 원본 DB·이미지·설정 파일은 복사하거나 초기화하지 않는다. 이후 그림체 관리의 편집은 연결된 데이터 폴더에 저장된다.

그림체 `settings.json`에 `novelai_app_key`가 저장돼 있고 NAIM `lab_config.json`의 키와 다르면 저장 전에 어느 쪽을 사용할지 반드시 선택한다. 키 값은 화면이나 로그에 표시하지 않는다. 그림체 쪽 키를 선택하면 NAIM 공통 키만 변경하고 기존 그림체 프로그램 설정은 보존한다. 공통 생성 기본값은 기존 NAIM 설정 경계를 유지하며, 브라우저에만 저장된 프롬프트·화면 배치·생성 입력값은 폴더 연결로 가져오지 않는다.

미리보기 이후 파일이 변경되면 다시 선택하도록 안내한다. 손상된 JSON은 자동 초기화하지 않는다. `style_workspace.local.json`은 업데이트 보호 대상이며, 기존 자료 가져오기에도 포함한다. 검증: `tests/test_style_connection.py`, `tests/test_style_connection_ui.py`, `tests/test_desktop_controller.py`, `tests/test_naim_updater.py`; Tk 배치 캡처는 `.qa/style-connection/`.

### 프로젝트 확대 그림 비교

프로젝트 확대 보기에서 고정을 켜면 `static/project_zoom_compare.js/.css`가 같은 너비의 비교 열과 프로젝트 그림 선택기를 관리한다. `static/gallery_zoom.js`의 `prepareGalleryProjectZoom`은 현재 프로젝트 앞면·뒷면의 기존 `galleryZoomImages`를 모으고, 선택된 그림을 단일 확대 화면과 동기화한다. `static/gallery_zoom_view.js`는 고정 전환을 전달하며 일반 갤러리의 단일 그림 드래그·확대는 유지한다.

그림은 기본 위쪽 정렬이며 개별 모드에서는 클릭한 그림만, 동시 모드에서는 선택한 그림의 표시 높이를 기준으로 전체를 확대·축소한다. 높이 맞춤도 선택한 그림의 표시 높이를 사용한다. 각 그림은 독립적으로 드래그 이동하며, 비교에서 제외해도 원본은 삭제하지 않는다. ‘현재 프로젝트 그림’은 큰 선택 모달에서 페이지 단위로 표시한다. 프로젝트 카드의 기존 축소 미리보기를 재사용하고, 없는 경우 기존 이미지 API의 `preview=256`을 사용하며 실제 비교에 추가한 그림만 원본을 불러온다. 상태는 확대 화면 메모리에만 있고 저장 형식·API·이미지 파일은 바꾸지 않는다. 비교 중 기존 화살표 이동·삭제는 중지하며 Esc는 열린 선택기를 먼저 닫는다. 검증: `tests/test_project_zoom_compare.js`, `tests/test_gallery_zoom.js`, `tests/test_gallery_zoom_view.js`, `tests/test_gallery_script_loading.js`; 브라우저 확인: `.qa/check_project_zoom_compare.cjs`.

### 태그 사전의 WebP 품질 90 복사본 전환

tools/copy_dictionary_webp.py는 기본 읽기 전용 점검, --apply로 별도 images_webp_q90 폴더 생성·검증·사전 연결 전환을 수행합니다. 서버가 중지된 상태에서만 실행하며 외부 PNG는 수정하지 않습니다. 기존 convert_png_to_webp를 복사본에 적용해 품질 90 손실 압축과 PNG 메타데이터 보관을 재사용합니다. 모든 원본 해시·해상도·프롬프트를 비교한 뒤 SQLite 백업을 만들고, 이미지 ID와 태그·프롬프트를 유지한 채 path/mtime/size 및 연결 폴더만 단일 트랜잭션으로 변경합니다. 기존 대상 폴더나 작업 도중 원본·DB 변경이 발견되면 전환하지 않습니다. daki_dictionary_images.extract_prompt는 WebP에 보관된 PNG 메타데이터를 먼저 복원해 재색인에서도 태그를 유지합니다. 회귀: test_dictionary_webp_copy.py, test_daki_dictionary_images.py.

### 태그 사전 예시 이미지의 Hugging Face 배포와 설치

공유 그림체와 같은 okawaritsuika/nai-shared-styles 저장소의 dictionary-image-pack.json과 dictionary-images-webp-q90-v1.zip을 사용합니다. 현재 게시 리비전은 829c06e55f06516bf581697138cca83dcd015764이며 WebP 품질90 이미지 1,093장, ZIP 139,530,777바이트입니다. 이미지 SHA-256과 크기를 담은 휴대용 index.json에는 ID 기반 상대 파일명만 들어가고 사용자 SQLite·편집 내용·절대 경로는 포함하지 않습니다.

naim/daki_dictionary_pack_format.py가 공개 형식·수량·용량·경로 계약을 소유하고 tools/export_dictionary_image_pack.py가 원본 WebP 바이트를 재압축 없이 내보냅니다. naim/daki_dictionary_download.py는 기존 공개 HF 다운로드와 이어받기·해시 검증을 재사용하며 최신 커밋에 고정된 주소에서 받아 ZIP 항목·개별 해시·실제 이미지·프롬프트까지 검증합니다. 관리 폴더에 게시한 뒤 ImageCatalog.install_image_pack이 이미지 없는 색인을 원자적으로 연결하며 기존 사용자 편집과 사용 가능한 연결은 유지합니다. 실행 중 폴더 변경·중지·프로세스 종료는 기존 연결을 덮지 않습니다.

naim/web/daki_dictionary.py의 image-pack GET은 로컬 작업 상태만 조회하며, POST가 명시 다운로드를 시작하고 image-pack/stop POST가 중지합니다. static/daki_dictionary_download.js와 두 HTML 진입점이 버튼·진행 상태·중지·재시도·복귀 조회를 연결합니다. 상태 행은 헤더 아래에 있어 접힌 폴더 상세나 그림 탭에 가려지지 않습니다. 검증: test_daki_dictionary*.py, test_dictionary_image_export.py, test_daki_dictionary_download.js, test_daki_dictionary_view.js. 실제 공개 저장소 다운로드를 빈 임시 사전에 설치해 이미지1093장·태그 연결16241개·원본 바이트·ID·프롬프트·편집 보존을 확인했으며 화면1280×900/800×800을 확인했습니다.
