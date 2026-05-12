let isGalleryInpaintProcessing = false;
let galleryInpaintLoadingMessage = '인페인팅 처리 중...';
const galleryImageVersionMap = new Map();
let revealExplorerBusy = false;
let lastRevealExplorerPath = '';
let lastRevealExplorerAt = 0;
let galleryInpaintSession = null;
let galleryInpaintTool = 'brush';
let galleryInpaintBrushSize = 96;
let galleryInpaintMaskCanvas = null;
let galleryInpaintMaskCtx = null;
let galleryInpaintPainting = false;
let galleryInpaintLastPoint = null;
let galleryUpscaleSession = null;
let galleryUpscaleLastEditedAxis = 'width';
let galleryUpscalePollTimer = null;
let galleryUpscaleKnownDoneJobs = new Set();
let galleryUpscaleKnownTerminalJobs = new Set();
let galleryUpscalePollingInitialized = false;
let rootTree = null;
let currentPath = [];
let baseDir = "";
let selDeletes = new Map();
let selThumbs = new Map();
let searchText = '';
let dakiFilter = 'all';
let currentSelectedGalleryArtStyle = 'ALL';
let galleryTagDefs = [];
let galleryImageTags = {};
let currentGalleryTagFilter = 'ALL';
let pendingGalleryTagImageDataUrl = '';
let galleryImageFilterMeta = {};
let galleryImageFilterMetaLoading = false;
let galleryImageFilterMetaRequestKey = '';
let galleryPromptFilterMetaLoading = false;
let galleryPromptFilterMetaRequestKey = '';
let galleryPromptFilterMetaLoadSeq = 0;
const GALLERY_PROMPT_META_CHUNK_SIZE = 120;
const topBtn = document.getElementById('topBtn');

let globalBrandMap = {};
let globalBrandVisibility = {}; // 🌟 노출 스위치 변수 추가
let currentSelectedBrand = 'ALL';
let currentSelectedChar = 'ALL';
let windowBrandsData = {};
let activeImageContext = null;
let galleryInpaintLastPointerEvent = null;
let galleryInpaintMaskVisible = true;
const GALLERY_INPAINT_TEMP_CATEGORY = 'gallery_inpaint';
const GALLERY_PERSISTENT_UI_KEY = 'naia_gallery_persistent_ui_v1';
const GALLERY_SESSION_STATE_KEY = 'naia_gallery_session_state_v1';
const GALLERY_HEADER_TOOLS_COLLAPSED_KEY = 'naia_gallery_header_tools_collapsed_v1';

let galleryServerSessionId = '';
let galleryPendingScrollY = null;

function getGalleryRadioValue(name, fallback) {
    return document.querySelector(`input[name="${name}"]:checked`)?.value || fallback;
}

function setGalleryRadioValue(name, value) {
    const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
}

function loadGalleryPersistentUi() {
    try {
        const raw = localStorage.getItem(GALLERY_PERSISTENT_UI_KEY);
        const data = raw ? JSON.parse(raw) : {};

        dakiFilter = data.dakiFilter || dakiFilter || 'all';
        setGalleryRadioValue('dakiFilter', dakiFilter);
        setGalleryRadioValue('sortMode', data.sortMode || 'name');
        setGalleryRadioValue('viewMode', data.viewMode || 'general');
    } catch (error) {
        console.warn('Gallery persistent UI restore failed:', error);
    }
}

function saveGalleryPersistentUi() {
    try {
        localStorage.setItem(GALLERY_PERSISTENT_UI_KEY, JSON.stringify({
            dakiFilter,
            sortMode: getGalleryRadioValue('sortMode', 'name'),
            viewMode: getGalleryRadioValue('viewMode', 'general')
        }));
    } catch (error) {
        console.warn('Gallery persistent UI save failed:', error);
    }
}

function readGallerySessionState() {
    try {
        const raw = sessionStorage.getItem(GALLERY_SESSION_STATE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        console.warn('Gallery session state read failed:', error);
        return null;
    }
}

function getGalleryNodeKey(node) {
    if (!node) return '';
    return String(node.path || node.name || '');
}

function findGalleryChildByKey(parent, key) {
    if (!parent || !Array.isArray(parent.folders)) return null;

    return parent.folders.find((folder) => {
        return getGalleryNodeKey(folder) === key || String(folder.name || '') === key;
    }) || null;
}

function restoreGalleryPathFromKeys(pathKeys) {
    const keys = Array.isArray(pathKeys) ? pathKeys : [];
    const newPath = [rootTree];
    let currentLevel = rootTree;

    for (let i = 1; i < keys.length; i++) {
        const match = findGalleryChildByKey(currentLevel, keys[i]);
        if (!match) break;

        newPath.push(match);
        currentLevel = match;
    }

    return newPath;
}

function getDefaultGalleryPath() {
    if (!rootTree || !Array.isArray(rootTree.folders) || !rootTree.folders.length) {
        return [rootTree].filter(Boolean);
    }

    const defaultFolder = rootTree.folders.find(f => String(f.name || '').includes('Solo')) || rootTree.folders[0];
    return [rootTree, defaultFolder];
}

function getGalleryCollapsedState() {
    const state = {};

    document.querySelectorAll('.section-header[id]').forEach((header) => {
        state[header.id] = header.classList.contains('closed');
    });

    return state;
}

function applyGalleryCollapsedState() {
    const sessionState = readGallerySessionState();
    const collapsedState = sessionState?.collapsedState;

    if (!collapsedState || typeof collapsedState !== 'object') return;

    Object.keys(collapsedState).forEach((headerId) => {
        const header = document.getElementById(headerId);
        if (!header) return;

        const contentId = headerId.replace(/^header-/, 'content-');
        const content = document.getElementById(contentId);
        if (!content) return;

        const isClosed = Boolean(collapsedState[headerId]);
        header.classList.toggle('closed', isClosed);
        content.classList.toggle('closed', isClosed);
    });
}

function saveGallerySessionState() {
    if (!galleryServerSessionId || !rootTree || !currentPath.length) return;

    try {
        sessionStorage.setItem(GALLERY_SESSION_STATE_KEY, JSON.stringify({
            serverSessionId: galleryServerSessionId,
            pathKeys: currentPath.map(getGalleryNodeKey),
            searchText,
            currentSelectedBrand,
            currentSelectedChar,
            currentSelectedGalleryArtStyle,
            currentGalleryTagFilter,
            collapsedState: getGalleryCollapsedState(),
            scrollY: window.scrollY || document.documentElement.scrollTop || 0
        }));
    } catch (error) {
        console.warn('Gallery session state save failed:', error);
    }
}

function clearGallerySessionState() {
    try {
        sessionStorage.removeItem(GALLERY_SESSION_STATE_KEY);
    } catch (error) {
        console.warn('Gallery session state clear failed:', error);
    }
}

const GALLERY_LOGO_RELATED_TAGS = [
    'logo',
    'twitter logo',
    'twitter username',
    'x logo',
    'x username',
    'patreon logo',
    'patreon username',
    'pixiv logo',
    'pixiv username',
    'fanbox logo',
    'fanbox username',
    'fantia logo',
    'fantia username',
    'watermark',
    'sample watermark',
    'signature',
    'artist name',
    'artist_name',
    'username',
    'text',
    'english text',
    'japanese text',
    'chinese text',
    'korean text',
    'translated',
    'caption',
    'speech bubble',
    'sound effects'
];

const GALLERY_LOGO_REMOVAL_BLOCK =
    '-3::logo, twitter logo, x logo, patreon logo, pixiv logo, fanbox logo, fantia logo, twitter username, x username, patreon username, pixiv username, fanbox username, fantia username, watermark, sample watermark, signature, artist name, username, text, english text, japanese text, chinese text, korean text, translated, caption, speech bubble, sound effects::';

function normalizeGalleryLogoTagKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/^[-+]?\d+(?:\.\d+)?::\s*/, '')
        .replace(/\s*::$/, '')
        .replace(/[{}()[\]]/g, '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseGalleryPromptTokens(promptText) {
    return String(promptText || '')
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean);
}

function joinGalleryPromptTokens(tokens) {
    return tokens
        .map((token) => String(token || '').trim())
        .filter(Boolean)
        .join(', ');
}

function isGalleryLogoRelatedToken(token) {
    const key = normalizeGalleryLogoTagKey(token);
    if (!key) return false;

    const exactTags = GALLERY_LOGO_RELATED_TAGS.map(normalizeGalleryLogoTagKey);
    if (exactTags.includes(key)) return true;

    if (/\b(logo|watermark|username|signature)\b/.test(key)) return true;
    if (/\bartist name\b/.test(key)) return true;
    if (/\b(english|japanese|chinese|korean)\s+text\b/.test(key)) return true;
    if (key === 'text' || key === 'caption' || key === 'translated' || key === 'speech bubble' || key === 'sound effects') return true;

    return false;
}

function removeGalleryLogoRelatedTokens(promptText) {
    const tokens = parseGalleryPromptTokens(promptText);

    return joinGalleryPromptTokens(
        tokens.filter((token) => !isGalleryLogoRelatedToken(token))
    );
}

function buildGalleryLogoRemovalBasePrompt(basePrompt, enabled) {
    const raw = String(basePrompt || '').trim();

    if (!enabled) {
        return raw;
    }

    const cleaned = removeGalleryLogoRelatedTokens(raw);

    return joinGalleryPromptTokens([
        cleaned,
        GALLERY_LOGO_REMOVAL_BLOCK
    ]);
}

function applyGalleryHeaderToolsCollapsedState() {
    const tools = document.getElementById('galleryHeaderTools');
    const toggle = document.getElementById('galleryHeaderToolsToggle');

    if (!tools || !toggle) return;

    const collapsed = localStorage.getItem(GALLERY_HEADER_TOOLS_COLLAPSED_KEY) !== '0';

    tools.classList.toggle('collapsed', collapsed);
    toggle.innerText = collapsed ? '도구 펼치기 ▼' : '도구 접기 ▲';
}

function toggleGalleryHeaderTools() {
    const tools = document.getElementById('galleryHeaderTools');
    if (!tools) return;

    const nextCollapsed = !tools.classList.contains('collapsed');

    localStorage.setItem(GALLERY_HEADER_TOOLS_COLLAPSED_KEY, nextCollapsed ? '1' : '0');
    applyGalleryHeaderToolsCollapsedState();
}

function toggleReasons() {
    if (document.getElementById('toggle-reasons').checked) document.body.classList.remove('hide-reasons');
    else document.body.classList.add('hide-reasons');
}

function setDakiFilter(val) {
    dakiFilter = val || 'all';
    setGalleryRadioValue('dakiFilter', dakiFilter);
    saveGalleryPersistentUi();
    renderView();
}

function isGalleryDakimakuraItem(item) {
    const text = [
        item?.name,
        item?.path,
        item?.folder,
        item?.src
    ].filter(Boolean).join('/').toLowerCase();

    return item?.is_dakimakura === true ||
        item?.isDakimakura === true ||
        text.includes('dakimakura') ||
        text.includes('body_pillow') ||
        text.includes('body pillow');
}

function isGalleryDakimakuraFolder(folder) {
    const text = [
        folder?.name,
        folder?.path,
        ...(Array.isArray(folder?.char_names) ? folder.char_names : [])
    ].filter(Boolean).join('/').toLowerCase();

    return folder?.is_dakimakura === true ||
        folder?.isDakimakura === true ||
        text.includes('dakimakura') ||
        text.includes('body_pillow') ||
        text.includes('body pillow');
}

function passesGalleryDakiFilter(item, isFolder = false) {
    if (dakiFilter === 'all') return true;

    const isDaki = isFolder
        ? isGalleryDakimakuraFolder(item)
        : isGalleryDakimakuraItem(item);

    if (dakiFilter === 'only') return isDaki;
    if (dakiFilter === 'hide') return !isDaki;

    return true;
}

function isFinalImageFolder(node) {
    return Boolean(
        node &&
        Array.isArray(node.images) &&
        node.images.length > 0 &&
        Array.isArray(node.folders) &&
        node.folders.length === 0
    );
}

function normalizeGalleryFilterText(value) {
    return String(value || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
}

function splitGalleryPromptTerms(value) {
    return normalizeGalleryFilterText(value)
        .split(/[,\n]+/)
        .map(term => term.trim())
        .filter(Boolean);
}

function getGalleryImageMeta(path) {
    const cleanPath = normalizeGalleryPathKey(path);
    return galleryImageFilterMeta[cleanPath] || galleryImageFilterMeta[path] || {};
}

function getGalleryUpscaleBadgeInfo(path) {
    const meta = getGalleryImageMeta(path);
    const upscale = meta && meta.upscale ? meta.upscale : null;

    if (upscale && upscale.is_upscaled) {
        return upscale;
    }

    // 메타 로드 전 또는 예전 파일 fallback
    const name = String(path || '').split('/').pop().toLowerCase();
    const match = name.match(/_upscale_(\d+)x(\d+)_([^.]*)/);

    if (match) {
        return {
            is_upscaled: true,
            target_width: Number(match[1] || 0),
            target_height: Number(match[2] || 0),
            engine: match[3] || ''
        };
    }

    return {
        is_upscaled: false
    };
}

function getGalleryUpscaleEngineLabel(engine) {
    engine = String(engine || '').toLowerCase();

    if (engine.includes('realcugan')) return 'Real-CUGAN';
    if (engine.includes('lanczos')) return 'Lanczos';

    return engine ? engine.toUpperCase() : 'UPSCALE';
}

function renderGalleryUpscaleBadge(imagePath) {
    const info = getGalleryUpscaleBadgeInfo(imagePath);

    if (!info || !info.is_upscaled) {
        return '';
    }

    const width = Number(info.target_width || 0);
    const height = Number(info.target_height || 0);
    const sizeText = width && height ? `${width}×${height}` : '';
    const engineText = getGalleryUpscaleEngineLabel(info.engine);

    return `
        <div class="gallery-upscale-badge" title="업스케일 이미지">
            <div class="gallery-upscale-badge-main">⬆ UPSCALE</div>
            <div class="gallery-upscale-badge-sub">${escapeHtml(sizeText || engineText)}</div>
        </div>
    `;
}

function getGalleryTagDef(tagId) {
    return galleryTagDefs.find(tag => String(tag.id) === String(tagId)) || null;
}

function getGalleryImageTagId(path) {
    const cleanPath = normalizeGalleryPathKey(path);
    return galleryImageTags[cleanPath] || galleryImageTags[path] || '';
}

function setLocalGalleryImageTag(path, tagId) {
    const cleanPath = normalizeGalleryPathKey(path);
    if (!cleanPath) return;

    if (tagId) {
        galleryImageTags[cleanPath] = tagId;
    } else {
        delete galleryImageTags[cleanPath];
    }

    const currentNode = currentPath[currentPath.length - 1];
    if (currentNode && Array.isArray(currentNode.images)) {
        const target = currentNode.images.find(item => normalizeGalleryPathKey(item.path) === cleanPath);
        if (target) target.gallery_tag = tagId || '';
    }
}

function renderGalleryTagIcon(tag) {
    if (!tag || !tag.value) return '+';

    if (tag.type === 'text') {
        const textColor = tag.textColor || '#ffffff';
        const bgColor = tag.bgColor || '#2563eb';

        return `
            <span class="gallery-tag-text-badge"
                    style="--gallery-tag-text-color:${escapeHtml(textColor)}; --gallery-tag-bg-color:${escapeHtml(bgColor)};">
                ${escapeHtml(tag.value)}
            </span>
        `;
    }

    return `<img class="gallery-tag-icon-img" src="${escapeHtml(tag.value)}" alt="">`;
}

function imageMatchesGalleryTagFilter(item) {
    if (currentGalleryTagFilter === 'ALL') return true;

    const tagId = item.gallery_tag || getGalleryImageTagId(item.path);

    if (currentGalleryTagFilter === 'NONE') {
        return !tagId;
    }

    return String(tagId) === String(currentGalleryTagFilter);
}

function renderGalleryTagFilterBar() {
    const bar = document.getElementById('galleryTagFilterBar');
    if (!bar) return;

    bar.innerHTML = '';

    const makeChip = (value, label, iconHtml = '') => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `gallery-tag-filter-chip ${currentGalleryTagFilter === value ? 'active' : ''}`;
        btn.title = label;
        btn.innerHTML = iconHtml || '<span class="gallery-tag-filter-all-dot">ALL</span>';
        btn.onclick = () => {
            currentGalleryTagFilter = value;
            renderView();
            saveGallerySessionState();
        };
        bar.appendChild(btn);
    };

    makeChip('ALL', '전체', '<span class="gallery-tag-filter-all-dot">ALL</span>');
    makeChip('NONE', '태그 없음', '<span class="gallery-tag-filter-empty-dot">○</span>');

    galleryTagDefs.forEach((tag, index) => {
        const label = tag.type === 'text'
            ? `태그: ${tag.value}`
            : `태그 ${index + 1}`;
        makeChip(tag.id, label, renderGalleryTagIcon(tag));
    });
}

function closeGalleryTagPicker() {
    const picker = document.getElementById('galleryTagPicker');
    if (picker) {
        picker.classList.remove('open');
        picker.innerHTML = '';
    }
}

function openGalleryImageTagPicker(event, imagePath) {
    event.preventDefault();
    event.stopPropagation();

    const picker = document.getElementById('galleryTagPicker');
    if (!picker) return;

    const currentTagId = getGalleryImageTagId(imagePath);

    picker.innerHTML = '';

    if (currentTagId) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'gallery-tag-picker-item remove';
        removeBtn.title = '태그 제거';
        removeBtn.innerHTML = '<span class="gallery-tag-picker-remove-icon">×</span>';
        removeBtn.onclick = () => updateGalleryImageTag(imagePath, '');
        picker.appendChild(removeBtn);
    }

    galleryTagDefs.forEach((tag, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gallery-tag-picker-item icon-only';
        btn.title = tag.type === 'text' ? `태그: ${tag.value}` : `태그 ${index + 1}`;
        btn.innerHTML = renderGalleryTagIcon(tag);
        btn.onclick = () => updateGalleryImageTag(imagePath, tag.id);
        picker.appendChild(btn);
    });

    const margin = 10;
    picker.classList.add('open');

    const width = picker.offsetWidth || 190;
    const height = picker.offsetHeight || 260;
    const left = Math.min(event.clientX, window.innerWidth - width - margin);
    const top = Math.min(event.clientY, window.innerHeight - height - margin);

    picker.style.left = `${Math.max(margin, left)}px`;
    picker.style.top = `${Math.max(margin, top)}px`;
}

async function updateGalleryImageTag(imagePath, tagId) {
    try {
        const res = await fetch('/api/gallery/image_tag', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                path: imagePath,
                tag_id: tagId || ''
            })
        });

        const json = await res.json();

        if (!res.ok || json.status !== 'success') {
            throw new Error(json.message || '태그 저장 실패');
        }

        galleryImageTags = json.image_tags || galleryImageTags;
        setLocalGalleryImageTag(imagePath, json.tag_id || '');
        closeGalleryTagPicker();
        renderView();
        showToast(json.tag_id ? '태그를 지정했습니다.' : '태그를 제거했습니다.');
    } catch (error) {
        alert(`태그 변경 실패: ${error.message || error}`);
    }
}

function renderGalleryImageTagButton(imagePath, tagId) {
    const tag = getGalleryTagDef(tagId);

    if (!tag) {
        return `
            <button class="gallery-image-tag-btn empty-tag"
                    title="태그 추가"
                    onclick="openGalleryImageTagPicker(event, ${JSON.stringify(imagePath).replace(/"/g, '&quot;')})">
                +
            </button>
        `;
    }

    return `
        <button class="gallery-image-tag-btn has-tag"
                title="태그 변경"
                onclick="openGalleryImageTagPicker(event, ${JSON.stringify(imagePath).replace(/"/g, '&quot;')})">
            ${renderGalleryTagIcon(tag)}
        </button>
    `;
}

function imageMatchesGalleryPromptFilter(item, terms) {
    if (!terms.length) return true;

    const meta = getGalleryImageMeta(item.path);

    // 프롬프트 메타를 아직 읽는 중이면 일단 숨기지 않는다.
    // chunk 로드가 진행되면서 renderView()가 다시 호출되고, 읽힌 항목부터 정확히 필터링된다.
    if (meta.prompt_text_loaded !== true) {
        return true;
    }

    const haystack = normalizeGalleryFilterText([
        item.name,
        item.path,
        meta.prompt_text || ''
    ].join(' '));

    return terms.every(term => haystack.includes(term));
}

function imageMatchesGalleryArtStyleFilter(item) {
    if (currentSelectedGalleryArtStyle === 'ALL') return true;

    const meta = getGalleryImageMeta(item.path);
    const styles = Array.isArray(meta.art_styles) ? meta.art_styles : [];

    return styles.some(style => String(style.key || style.prompt || '') === currentSelectedGalleryArtStyle);
}

function buildGalleryArtStyleLabel(style, fallbackIndex) {
    const customName = String(style.name_kr || '').trim();
    if (customName) return customName;

    const prompt = String(style.prompt || style.key || '').trim();
    const artistNames = [...prompt.matchAll(/artist:([^:,]+(?:\([^)]*\))?)/g)]
        .map(match => match[1].replace(/_/g, ' ').trim())
        .filter(Boolean);

    if (!artistNames.length) {
        return `그림체 ${fallbackIndex}`;
    }

    const head = artistNames.slice(0, 2).join(' + ');
    const tail = artistNames.length > 2 ? ` 외 ${artistNames.length - 2}` : '';
    return `그림체 ${fallbackIndex} · ${head}${tail}`;
}

function updateGalleryArtStyleOptions(images) {
    const select = document.getElementById('galleryArtStyleSelect');
    if (!select) return;

    const styleMap = new Map();

    images.forEach(item => {
        const meta = getGalleryImageMeta(item.path);
        const styles = Array.isArray(meta.art_styles) ? meta.art_styles : [];

        styles.forEach(style => {
            const key = String(style.key || style.prompt || '').trim();
            if (!key) return;

            if (!styleMap.has(key)) {
                styleMap.set(key, {
                    key,
                    prompt: style.prompt || key,
                    name_kr: style.name_kr || '',
                    count: 0
                });
            }

            styleMap.get(key).count += 1;
        });
    });

    const previousValue = currentSelectedGalleryArtStyle;
    select.innerHTML = '<option value="ALL">전체 그림체</option>';

    [...styleMap.values()]
        .sort((a, b) => b.count - a.count || String(a.name_kr || a.prompt).localeCompare(String(b.name_kr || b.prompt)))
        .forEach((style, index) => {
            const option = document.createElement('option');
            option.value = style.key;
            option.textContent = `${buildGalleryArtStyleLabel(style, index + 1)} (${style.count})`;
            option.title = style.prompt;
            select.appendChild(option);
        });

    if (previousValue !== 'ALL' && styleMap.has(previousValue)) {
        select.value = previousValue;
    } else {
        currentSelectedGalleryArtStyle = 'ALL';
        select.value = 'ALL';
    }
}

function updateGalleryFilterUi(currentNode) {
    const isFinal = isFinalImageFolder(currentNode);
    const label = document.getElementById('main-filter-label');
    const brandSelect = document.getElementById('brandSelect');
    const charChipContainer = document.getElementById('char-chip-container');
    const artStyleSelect = document.getElementById('galleryArtStyleSelect');
    const searchInput = document.getElementById('folder-search');
    const clearBtn = document.getElementById('clear-search');
    const loading = document.getElementById('galleryFilterLoading');

    if (label) {
        label.textContent = isFinal ? '🎨 그림체 필터' : '👑 BRAND FILTER';
        label.style.color = isFinal ? '#f1c40f' : '#ff007c';
    }

    if (brandSelect) brandSelect.style.display = isFinal ? 'none' : '';

    if (charChipContainer) {
        // 최종 이미지 폴더에서는 캐릭터 칩을 숨긴다.
        // 단, currentSelectedBrand/currentSelectedChar 값은 유지해서
        // Duo/Group 상위로 돌아왔을 때 선택 상태가 복원되게 한다.
        if (isFinal) {
            charChipContainer.style.display = 'none';
        } else if (currentSelectedBrand !== 'ALL') {
            charChipContainer.style.display = 'flex';
        }
    }

    if (artStyleSelect) artStyleSelect.style.display = isFinal ? '' : 'none';
    if (loading) {
        loading.style.display = (galleryImageFilterMetaLoading || galleryPromptFilterMetaLoading) && isFinal ? '' : 'none';
    }

    if (searchInput) {
        searchInput.placeholder = isFinal
            ? '📝 프롬프트 필터... 여러 단어/태그는 줄바꿈 또는 쉼표로 입력'
            : '🔍 폴더 이름 실시간 검색...';

        searchInput.rows = isFinal ? 3 : 1;
        searchInput.classList.toggle('prompt-filter-mode', isFinal);
    }

    if (clearBtn) clearBtn.style.display = searchText ? 'block' : 'none';

    if (!isFinal) {
        currentSelectedGalleryArtStyle = 'ALL';
    } else {
        updateGalleryArtStyleOptions(currentNode.images || []);

        const promptTerms = splitGalleryPromptTerms(searchText);
        if (promptTerms.length) {
            ensureGalleryPromptFilterMeta(currentNode);
        }
    }

    renderGalleryTagFilterBar();
}

function onGalleryArtStyleChange() {
    currentSelectedGalleryArtStyle = document.getElementById('galleryArtStyleSelect')?.value || 'ALL';
    renderView();
    saveGallerySessionState();
}

async function ensureGalleryImageFilterMeta(currentNode) {
    if (!isFinalImageFolder(currentNode)) return;

    const missingPaths = (currentNode.images || [])
        .map(item => normalizeGalleryPathKey(item.path))
        .filter(path => path && !galleryImageFilterMeta[path]);

    if (!missingPaths.length) {
        updateGalleryFilterUi(currentNode);
        return;
    }

    const requestKey = `${getGalleryNodeKey(currentNode)}|style|${missingPaths.length}`;
    if (galleryImageFilterMetaLoading && galleryImageFilterMetaRequestKey === requestKey) return;

    galleryImageFilterMetaLoading = true;
    galleryImageFilterMetaRequestKey = requestKey;
    updateGalleryFilterUi(currentNode);

    try {
        const res = await fetch('/api/gallery/image_filter_meta', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                paths: missingPaths,
                include_prompt: false
            })
        });

        const json = await res.json();
        if (json.status !== 'success') throw new Error(json.message || '필터 메타를 읽을 수 없습니다.');

        const items = json.items || {};
        Object.keys(items).forEach(path => {
            const cleanPath = normalizeGalleryPathKey(path);
            const previous = galleryImageFilterMeta[cleanPath] || {};

            galleryImageFilterMeta[cleanPath] = {
                ...previous,
                ...items[path],
                prompt_text: previous.prompt_text || items[path].prompt_text || '',
                prompt_text_loaded: Boolean(previous.prompt_text_loaded || items[path].prompt_text_loaded)
            };
        });
    } catch (e) {
        console.warn('Gallery filter meta load failed:', e);
        showToast(`필터 정보 로드 실패: ${e.message || e}`);
    } finally {
        galleryImageFilterMetaLoading = false;
        galleryImageFilterMetaRequestKey = '';

        if (currentPath[currentPath.length - 1] === currentNode) {
            renderView();
        }
    }
}

async function ensureGalleryPromptFilterMeta(currentNode) {
    if (!isFinalImageFolder(currentNode)) return;

    const terms = splitGalleryPromptTerms(searchText);
    if (!terms.length) return;

    const missingPaths = (currentNode.images || [])
        .map(item => normalizeGalleryPathKey(item.path))
        .filter(path => {
            if (!path) return false;
            const meta = galleryImageFilterMeta[path] || {};
            return meta.prompt_text_loaded !== true;
        });

    if (!missingPaths.length) return;

    const requestKey = `${getGalleryNodeKey(currentNode)}|prompt|${terms.join(',')}|${missingPaths.length}`;

    if (
        galleryPromptFilterMetaLoading &&
        galleryPromptFilterMetaRequestKey === requestKey
    ) {
        return;
    }

    const loadSeq = ++galleryPromptFilterMetaLoadSeq;

    galleryPromptFilterMetaLoading = true;
    galleryPromptFilterMetaRequestKey = requestKey;
    updateGalleryFilterUi(currentNode);

    try {
        for (let i = 0; i < missingPaths.length; i += GALLERY_PROMPT_META_CHUNK_SIZE) {
            if (loadSeq !== galleryPromptFilterMetaLoadSeq) return;
            if (currentPath[currentPath.length - 1] !== currentNode) return;
            if (!splitGalleryPromptTerms(searchText).length) return;

            const chunk = missingPaths.slice(i, i + GALLERY_PROMPT_META_CHUNK_SIZE);

            const res = await fetch('/api/gallery/image_filter_meta', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    paths: chunk,
                    include_prompt: true
                })
            });

            const json = await res.json();
            if (json.status !== 'success') {
                throw new Error(json.message || '프롬프트 필터 메타를 읽을 수 없습니다.');
            }

            const items = json.items || {};
            Object.keys(items).forEach(path => {
                const cleanPath = normalizeGalleryPathKey(path);
                const previous = galleryImageFilterMeta[cleanPath] || {};

                galleryImageFilterMeta[cleanPath] = {
                    ...previous,
                    ...items[path],
                    prompt_text_loaded: true
                };
            });

            if (currentPath[currentPath.length - 1] === currentNode) {
                renderView();
            }

            await new Promise(resolve => setTimeout(resolve, 0));
        }

    } catch (e) {
        console.warn('Gallery prompt filter meta load failed:', e);
        showToast(`프롬프트 필터 정보 로드 실패: ${e.message || e}`);

    } finally {
        if (loadSeq === galleryPromptFilterMetaLoadSeq) {
            galleryPromptFilterMetaLoading = false;
            galleryPromptFilterMetaRequestKey = '';
        }

        if (currentPath[currentPath.length - 1] === currentNode) {
            updateGalleryFilterUi(currentNode);
        }
    }
}

async function loadData() {
    try {
        const sessionState = readGallerySessionState();

        document.getElementById('content').innerHTML = '<div class="loading-text">데이터 동기화 중...</div>';

        const mode = getGalleryRadioValue('viewMode', 'general');
        const sort = getGalleryRadioValue('sortMode', 'name');

        saveGalleryPersistentUi();

        const res = await fetch(`/api/data?mode=${encodeURIComponent(mode)}&sort=${encodeURIComponent(sort)}`);
        const json = await res.json();

        if (json.error) {
            document.getElementById('content').innerHTML = `<div class="loading-text" style="color:red;">${json.error}</div>`;
            return;
        }

        rootTree = json.tree;
        baseDir = json.baseDir;
        globalBrandMap = json.brand_map || {};
        globalBrandVisibility = json.brand_visibility || {};
        galleryServerSessionId = String(json.server_session_id || '');

        const galleryTagsPayload = json.gallery_tags || {};
        galleryTagDefs = Array.isArray(galleryTagsPayload.tags) ? galleryTagsPayload.tags : [];
        galleryImageTags = galleryTagsPayload.image_tags || {};

        const canRestoreSession =
            sessionState &&
            galleryServerSessionId &&
            sessionState.serverSessionId === galleryServerSessionId;

        if (canRestoreSession) {
            const restoredPath = restoreGalleryPathFromKeys(sessionState.pathKeys);
            currentPath = restoredPath.length > 1 ? restoredPath : getDefaultGalleryPath();

            searchText = String(sessionState.searchText || '').toLowerCase().trim();
            currentSelectedBrand = sessionState.currentSelectedBrand || 'ALL';
            currentSelectedChar = sessionState.currentSelectedChar || 'ALL';
            currentSelectedGalleryArtStyle = sessionState.currentSelectedGalleryArtStyle || 'ALL';
            currentGalleryTagFilter = sessionState.currentGalleryTagFilter || 'ALL';
            galleryPendingScrollY = Number(sessionState.scrollY || 0);
        } else {
            clearGallerySessionState();
            currentPath = getDefaultGalleryPath();

            searchText = '';
            currentSelectedBrand = 'ALL';
            currentSelectedChar = 'ALL';
            currentSelectedGalleryArtStyle = 'ALL';
            currentGalleryTagFilter = 'ALL';
            galleryPendingScrollY = null;
        }

        const searchInput = document.getElementById('folder-search');
        if (searchInput) searchInput.value = searchText;

        buildFilterDropdowns(currentPath[currentPath.length - 1]);
        renderView();

        if (galleryPendingScrollY !== null) {
            const scrollY = galleryPendingScrollY;
            galleryPendingScrollY = null;
            requestAnimationFrame(() => window.scrollTo(0, scrollY));
        }
    } catch (e) {
        console.error(e);
        document.getElementById('content').innerHTML = '<div class="loading-text" style="color:red;">연결 실패!</div>';
    }
}

window.onload = () => {
    applyGalleryHeaderToolsCollapsedState();
    loadGalleryPersistentUi();
    loadData();
};
window.onscroll = function() { topBtn.style.display = document.documentElement.scrollTop > 500 ? "block" : "none"; };
function scrollToTop() { window.scrollTo({ top: 0, behavior: 'smooth' }); }

document.addEventListener('click', (event) => {
    const menu = document.getElementById('imageContextMenu');
    if (menu.style.display === 'block' && !menu.contains(event.target)) closeImageContextMenu();

    const tagPicker = document.getElementById('galleryTagPicker');
    if (tagPicker && tagPicker.classList.contains('open') && !tagPicker.contains(event.target)) {
        closeGalleryTagPicker();
    }
});
document.addEventListener('scroll', () => closeImageContextMenu(), true);
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        closeImageContextMenu();
    }
});
window.addEventListener('pagehide', () => {
    saveGalleryPersistentUi();
    saveGallerySessionState();
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        saveGalleryPersistentUi();
        saveGallerySessionState();
    }
});

function getImageFileName(imagePath) {
    return decodeURIComponent(String(imagePath || '').split('/').pop() || 'image.png');
}

function normalizeGalleryPathKey(path) {
    return decodeURIComponent(String(path || ''))
        .replace(/\\/g, '/')
        .replace(/^\/image\//, '')
        .replace(/^image\//, '')
        .replace(/^TOTAL_CLASSIFIED\//, '')
        .split('?')[0];
}

function getGalleryImageSrc(path) {
    const cleanPath = normalizeGalleryPathKey(path);
    const version = galleryImageVersionMap.get(cleanPath);

    const baseSrc = `/image/${encodeURIComponent(cleanPath).replace(/%2F/g, '/')}`;
    return version ? `${baseSrc}?t=${version}` : baseSrc;
}

function markGalleryImageUpdated(path) {
    const cleanPath = normalizeGalleryPathKey(path);
    galleryImageVersionMap.set(cleanPath, Date.now());
    return getGalleryImageSrc(cleanPath);
}

function closeImageContextMenu() {
    document.getElementById('imageContextMenu').style.display = 'none';
}

function openImageContextMenu(event, imagePath, imgSrc) {
    event.preventDefault();
    event.stopPropagation();

    activeImageContext = { path: imagePath, imgSrc: imgSrc };
    const menu = document.getElementById('imageContextMenu');
    menu.style.display = 'block';

    const margin = 12;
    const menuWidth = menu.offsetWidth || 220;
    const menuHeight = menu.offsetHeight || 220;
    const left = Math.min(event.clientX, window.innerWidth - menuWidth - margin);
    const top = Math.min(event.clientY, window.innerHeight - menuHeight - margin);

    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
}

async function copyContextImage() {
    closeImageContextMenu();
    if (!activeImageContext) return;

    try {
        if (!navigator.clipboard || !window.ClipboardItem) {
            throw new Error('현재 브라우저가 이미지 복사를 지원하지 않습니다.');
        }

        const response = await fetch(activeImageContext.imgSrc);
        const blob = await response.blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
        alert("이미지를 클립보드에 복사했습니다.");
    } catch (e) {
        alert(`이미지 복사 실패: ${e.message || e}`);
    }
}

function saveContextImage() {
    closeImageContextMenu();
    if (!activeImageContext) return;

    const link = document.createElement('a');
    link.href = activeImageContext.imgSrc;
    link.download = getImageFileName(activeImageContext.path);
    document.body.appendChild(link);
    link.click();
    link.remove();
}

async function sendContextImageToCanvas() {
    closeImageContextMenu();
    if (!activeImageContext) return;

    let promptInfo = activeImageContext.prompt || null;

    if ((!promptInfo || typeof promptInfo !== 'object') && activeImageContext.path) {
        try {
            const response = await fetch('/api/prompt_info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: activeImageContext.path })
            });

            const json = await response.json();

            if (json.status === 'success' && json.data) {
                const data = json.data;

                const charText =
                    Array.isArray(data.charPrompts) ? data.charPrompts.join('\n') :
                    Array.isArray(data.characterPrompts) ? data.characterPrompts.join('\n') :
                    String(data.charPrompt || data.characterPrompt || '');

                promptInfo = {
                    basePrompt: data.basePrompt || data.prompt || '',
                    charPrompt: charText,
                    negativePrompt:
                        data.negativePrompt ||
                        data.negative_prompt ||
                        data.uc ||
                        '',
                    model: data.model,
                    sampler: data.sampler,
                    steps: data.steps,
                    cfg: data.cfg,
                    seed: data.seed,
                    strength: data.strength,
                    noise: data.noise,
                    uc: data.uc,
                    negative_prompt: data.negative_prompt
                };
            }
        } catch (error) {
            console.warn('캔버스 전송용 프롬프트 읽기 실패:', error);
        }
    }

    const payload = {
        src: activeImageContext.imgSrc,
        path: activeImageContext.path || '',
        name: getImageFileName(activeImageContext.path || activeImageContext.imgSrc),
        promptInfo: promptInfo || null,
        importedAt: Date.now()
    };

    localStorage.setItem('naia_canvas_pending_import', JSON.stringify(payload));
    location.href = '/canvas';
}

function loadImageElement(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('이미지를 불러올 수 없습니다.'));
        img.src = src;
    });
}

let galleryInpaintCharPromptSeq = 1;

function normalizeCharPromptList(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item || '').trim())
            .filter(Boolean);
    }

    if (value && typeof value === 'object') {
        const arrayValue =
            value.charPrompts ||
            value.char_prompts ||
            value.characterPrompts;

        if (Array.isArray(arrayValue)) {
            return arrayValue
                .map((item) => String(item || '').trim())
                .filter(Boolean);
        }

        const singleValue =
            value.charPrompt ||
            value.char_prompt ||
            value.characterPrompt ||
            '';

        if (String(singleValue || '').trim()) {
            return [String(singleValue).trim()];
        }

        return [];
    }

    const text = String(value || '').trim();
    return text ? [text] : [];
}

function buildLegacyCharPromptText(list) {
    return normalizeCharPromptList(list).join(', ');
}

function getGalleryInpaintCharPromptValues() {
    return [...document.querySelectorAll('#galleryInpaintCharPromptList textarea')]
        .map((textarea) => String(textarea.value || '').trim())
        .filter(Boolean);
}

function setGalleryInpaintCharPromptValues(values) {
    const container = document.getElementById('galleryInpaintCharPromptList');
    if (!container) return;

    const list = normalizeCharPromptList(values);
    container.innerHTML = '';

    if (!list.length) {
        addGalleryInpaintCharPromptEditor('');
        return;
    }

    list.forEach((value) => addGalleryInpaintCharPromptEditor(value));
}

function addGalleryInpaintCharPromptEditor(initialValue = '') {
    const container = document.getElementById('galleryInpaintCharPromptList');
    if (!container) return;

    const id = `gicp${galleryInpaintCharPromptSeq++}`;
    const index = container.querySelectorAll('.gallery-inpaint-char-prompt-item').length + 1;

    const item = document.createElement('div');
    item.className = 'gallery-inpaint-char-prompt-item';
    item.dataset.charPromptId = id;
    item.style.cssText = `
        border:1px solid #333;
        border-radius:10px;
        padding:10px;
        margin-bottom:10px;
        background:#0a0a10;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
        display:flex;
        justify-content:space-between;
        align-items:center;
        gap:8px;
        margin-bottom:6px;
    `;

    const title = document.createElement('div');
    title.className = 'gallery-inpaint-char-prompt-title';
    title.style.cssText = 'font-size:12px; font-weight:900; color:#00f2ff;';
    title.innerText = `Character Prompt ${index}`;

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'gallery-inpaint-tool-btn danger';
    deleteBtn.style.cssText = 'padding:4px 8px; font-size:12px;';
    deleteBtn.innerText = '삭제';
    deleteBtn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeGalleryInpaintCharPromptEditor(id);
    };

    const textarea = document.createElement('textarea');
    textarea.id = `galleryInpaintCharPrompt-${id}`;
    textarea.rows = 4;
    textarea.value = initialValue || '';

    header.appendChild(title);
    header.appendChild(deleteBtn);
    item.appendChild(header);
    item.appendChild(textarea);
    container.appendChild(item);

    refreshGalleryInpaintCharPromptIndexes();
}

function removeGalleryInpaintCharPromptEditor(id) {
    const container = document.getElementById('galleryInpaintCharPromptList');
    if (!container) return;

    const item = container.querySelector(`.gallery-inpaint-char-prompt-item[data-char-prompt-id="${id}"]`);
    if (item) item.remove();

    if (!container.querySelector('.gallery-inpaint-char-prompt-item')) {
        addGalleryInpaintCharPromptEditor('');
        return;
    }

    refreshGalleryInpaintCharPromptIndexes();
}

function refreshGalleryInpaintCharPromptIndexes() {
    document.querySelectorAll('#galleryInpaintCharPromptList .gallery-inpaint-char-prompt-title')
        .forEach((title, index) => {
            title.innerText = `Character Prompt ${index + 1}`;
        });
}

function normalizeGalleryPromptInfo(data) {
    data = data || {};

    const rawCharPrompts =
        Array.isArray(data.charPrompts) && data.charPrompts.length
            ? data.charPrompts
            : Array.isArray(data.char_prompts) && data.char_prompts.length
                ? data.char_prompts
                : data.charPrompt || data.char_prompt || data.characterPrompt || '';

    const charPrompts = normalizeCharPromptList(rawCharPrompts);

    const baseCaption = String(
        data.baseCaption ||
        data.base_caption ||
        ''
    ).trim();

    const basePrompt = String(
        data.basePrompt ||
        data.prompt ||
        data.base_prompt ||
        baseCaption ||
        ''
    ).trim();

    return {
        basePrompt,
        baseCaption: baseCaption || basePrompt,
        charPrompts,
        charPrompt: buildLegacyCharPromptText(charPrompts),
        negativePrompt: data.negativePrompt || data.negative_prompt || data.uc || '',
        strength: Number(data.strength ?? 0.65),
        noise: Number(data.noise ?? 0.2),
        sampler: data.sampler || 'k_euler_ancestral',
        steps: Number(data.steps || 28),
        cfg: Number(data.cfg || data.scale || 6),
        seed: Number(data.seed ?? -1),
        logoRemoval: Boolean(data.logoRemoval || data.removeLogo || data.logo_removal)
    };
}

async function fetchPromptInfoForGalleryPath(path) {
    if (!path) return normalizeGalleryPromptInfo({});

    try {
        const res = await fetch('/api/prompt_info', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ path })
        });

        const json = await res.json();
        if (json.status !== 'success') {
            throw new Error(json.message || '프롬프트를 읽을 수 없습니다.');
        }

        return normalizeGalleryPromptInfo(json.data || {});
    } catch (e) {
        console.warn('Prompt info load failed:', e);
        return normalizeGalleryPromptInfo({});
    }
}

async function openGalleryInpaintFromContext() {
    closeImageContextMenu();

    if (!activeImageContext || !activeImageContext.imgSrc) {
        alert('인페인팅할 이미지가 없습니다.');
        return;
    }

    try {
        const img = await loadImageElement(activeImageContext.imgSrc);
        const promptInfo = await fetchPromptInfoForGalleryPath(activeImageContext.path || '');

        galleryInpaintSession = {
            originalPath: activeImageContext.path || '',
            originalSrc: activeImageContext.imgSrc,
            currentSrc: activeImageContext.imgSrc,
            tempSessionId: createGalleryInpaintTempSessionId(),
            name: getImageFileName(activeImageContext.path || activeImageContext.imgSrc),
            imageWidth: img.naturalWidth || img.width,
            imageHeight: img.naturalHeight || img.height,
            promptInfo,
            resultSrc: '',
            maskDataUrl: '',
            saved: false
        };

        openGalleryInpaint();
    } catch (e) {
        alert(`인페인팅 창 열기 실패: ${e.message || e}`);
    }
}

function createGalleryInpaintTempSessionId() {
    return `gallery_inpaint_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function cleanupGalleryInpaintTempSession(session) {
    const sessionId = session?.tempSessionId;
    if (!sessionId) return;

    try {
        await fetch('/api/canvas/cleanup_import_session', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                category: GALLERY_INPAINT_TEMP_CATEGORY,
                sessionId
            })
        });
    } catch (error) {
        console.warn('Gallery inpaint temp cleanup failed:', error);
    }
}

function openGalleryInpaint() {
    if (!galleryInpaintSession) return;

    const layer = document.getElementById('galleryInpaintLayer');
    const img = document.getElementById('galleryInpaintImage');
    const meta = document.getElementById('galleryInpaintMeta');

    layer.style.display = 'flex';
    img.src = galleryInpaintSession.currentSrc;
    meta.innerText = `${galleryInpaintSession.name} · ${galleryInpaintSession.imageWidth} × ${galleryInpaintSession.imageHeight}px`;

    const promptInfo = normalizeGalleryPromptInfo(galleryInpaintSession.promptInfo || {});
    galleryInpaintSession.promptInfo = promptInfo;

    const logoCheck = document.getElementById('galleryInpaintLogoRemovalCheck');
    if (logoCheck) {
        logoCheck.checked = Boolean(promptInfo.logoRemoval);
    }

    galleryInpaintMaskVisible = true;

    resetGalleryInpaintMask();
    bindGalleryInpaintEditor();
    applyGalleryInpaintMaskVisibility();
}

function closeGalleryInpaint() {
    if (
        galleryInpaintSession?.resultSrc &&
        !galleryInpaintSession.saved
    ) {
        const ok = confirm('저장하지 않은 인페인팅 결과가 있습니다. 닫으면 결과가 폐기됩니다. 닫을까요?');
        if (!ok) return;
    }

    const layer = document.getElementById('galleryInpaintLayer');
    if (layer) layer.style.display = 'none';

    hideGalleryInpaintBrushCursor();

    const sessionToCleanup = galleryInpaintSession;
    galleryInpaintSession = null;
    galleryInpaintMaskCanvas = null;
    galleryInpaintMaskCtx = null;
    galleryInpaintPainting = false;
    galleryInpaintLastPoint = null;
    cleanupGalleryInpaintTempSession(sessionToCleanup);
}

function resetGalleryInpaintMask() {
    if (!galleryInpaintSession) return;

    galleryInpaintMaskCanvas = document.createElement('canvas');
    galleryInpaintMaskCanvas.width = galleryInpaintSession.imageWidth;
    galleryInpaintMaskCanvas.height = galleryInpaintSession.imageHeight;
    galleryInpaintMaskCtx = galleryInpaintMaskCanvas.getContext('2d');
    galleryInpaintMaskCtx.clearRect(0, 0, galleryInpaintMaskCanvas.width, galleryInpaintMaskCanvas.height);

    galleryInpaintSession.maskDataUrl = '';
}

function bindGalleryInpaintEditor() {
    const wrap = document.getElementById('galleryInpaintImageWrap');
    const img = document.getElementById('galleryInpaintImage');
    const overlay = document.getElementById('galleryInpaintOverlay');

    if (!wrap || !img || !overlay || !galleryInpaintMaskCanvas) return;

    const syncOverlay = () => {
        const imgRect = img.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();

        overlay.style.left = `${imgRect.left - wrapRect.left + wrap.scrollLeft}px`;
        overlay.style.top = `${imgRect.top - wrapRect.top + wrap.scrollTop}px`;
        overlay.style.width = `${imgRect.width}px`;
        overlay.style.height = `${imgRect.height}px`;

        overlay.width = galleryInpaintMaskCanvas.width;
        overlay.height = galleryInpaintMaskCanvas.height;

        redrawGalleryInpaintOverlay();
    };

    img.onload = syncOverlay;
    requestAnimationFrame(syncOverlay);
    window.addEventListener('resize', syncOverlay);

    overlay.onpointerdown = (event) => {
        event.preventDefault();
        event.stopPropagation();

        updateGalleryInpaintBrushCursor(event, overlay);

        galleryInpaintPainting = true;
        overlay.setPointerCapture(event.pointerId);

        galleryInpaintLastPoint = getGalleryInpaintPoint(event, overlay);
        drawGalleryInpaintPoint(galleryInpaintLastPoint.x, galleryInpaintLastPoint.y);
        redrawGalleryInpaintOverlay();
    };

    overlay.onpointermove = (event) => {
        updateGalleryInpaintBrushCursor(event, overlay);

        if (!galleryInpaintPainting) return;

        const point = getGalleryInpaintPoint(event, overlay);

        if (galleryInpaintLastPoint) {
            drawGalleryInpaintLine(galleryInpaintLastPoint, point);
        } else {
            drawGalleryInpaintPoint(point.x, point.y);
        }

        galleryInpaintLastPoint = point;
        redrawGalleryInpaintOverlay();
    };

    overlay.onmouseenter = (event) => {
        updateGalleryInpaintBrushCursor(event, overlay);
    };

    overlay.onmouseleave = () => {
        if (!galleryInpaintPainting) {
            hideGalleryInpaintBrushCursor();
        }
    };

    overlay.onpointerup = (event) => {
        galleryInpaintPainting = false;
        galleryInpaintLastPoint = null;
        try { overlay.releasePointerCapture(event.pointerId); } catch (e) {}

        galleryInpaintSession.maskDataUrl = galleryInpaintMaskCanvas.toDataURL('image/png');
    };

    overlay.onpointercancel = () => {
        galleryInpaintPainting = false;
        galleryInpaintLastPoint = null;
        galleryInpaintSession.maskDataUrl = galleryInpaintMaskCanvas.toDataURL('image/png');
        hideGalleryInpaintBrushCursor();
    };
}

function getGalleryInpaintPoint(event, overlay) {
    const rect = overlay.getBoundingClientRect();
    const scaleX = overlay.width / rect.width;
    const scaleY = overlay.height / rect.height;

    return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY
    };
}

function drawGalleryInpaintPoint(x, y) {
    if (!galleryInpaintMaskCtx) return;

    galleryInpaintMaskCtx.save();

    if (galleryInpaintTool === 'eraser') {
        galleryInpaintMaskCtx.globalCompositeOperation = 'destination-out';
        galleryInpaintMaskCtx.fillStyle = 'rgba(0,0,0,1)';
    } else {
        galleryInpaintMaskCtx.globalCompositeOperation = 'source-over';
        galleryInpaintMaskCtx.fillStyle = 'rgba(0, 128, 255, 1)';
    }

    galleryInpaintMaskCtx.beginPath();
    galleryInpaintMaskCtx.arc(x, y, galleryInpaintBrushSize / 2, 0, Math.PI * 2);
    galleryInpaintMaskCtx.fill();
    galleryInpaintMaskCtx.restore();
}

function drawGalleryInpaintLine(from, to) {
    if (!galleryInpaintMaskCtx) return;

    galleryInpaintMaskCtx.save();

    if (galleryInpaintTool === 'eraser') {
        galleryInpaintMaskCtx.globalCompositeOperation = 'destination-out';
        galleryInpaintMaskCtx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
        galleryInpaintMaskCtx.globalCompositeOperation = 'source-over';
        galleryInpaintMaskCtx.strokeStyle = 'rgba(0, 128, 255, 1)';
    }

    galleryInpaintMaskCtx.lineWidth = galleryInpaintBrushSize;
    galleryInpaintMaskCtx.lineCap = 'round';
    galleryInpaintMaskCtx.lineJoin = 'round';
    galleryInpaintMaskCtx.beginPath();
    galleryInpaintMaskCtx.moveTo(from.x, from.y);
    galleryInpaintMaskCtx.lineTo(to.x, to.y);
    galleryInpaintMaskCtx.stroke();
    galleryInpaintMaskCtx.restore();
}

function updateGalleryInpaintBrushCursor(event, overlay) {
    if (!galleryInpaintMaskVisible) {
        hideGalleryInpaintBrushCursor();
        return;
    }
    galleryInpaintLastPointerEvent = event;
    const cursor = document.getElementById('galleryInpaintBrushCursor');
    if (!cursor || !overlay) return;

    const rect = overlay.getBoundingClientRect();

    if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
    ) {
        cursor.style.display = 'none';
        return;
    }

    const displayScale = rect.width / Math.max(1, overlay.width);
    const displaySize = Math.max(4, galleryInpaintBrushSize * displayScale);

    cursor.style.display = 'block';
    cursor.style.width = `${displaySize}px`;
    cursor.style.height = `${displaySize}px`;
    cursor.style.left = `${event.clientX}px`;
    cursor.style.top = `${event.clientY}px`;
    cursor.classList.toggle('eraser', galleryInpaintTool === 'eraser');
}

function hideGalleryInpaintBrushCursor() {
    const cursor = document.getElementById('galleryInpaintBrushCursor');
    if (cursor) cursor.style.display = 'none';
}

function redrawGalleryInpaintOverlay() {
    const overlay = document.getElementById('galleryInpaintOverlay');
    if (!overlay || !galleryInpaintMaskCanvas) return;

    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.globalAlpha = 0.45;
    ctx.drawImage(galleryInpaintMaskCanvas, 0, 0);
    ctx.globalAlpha = 1;

    applyGalleryInpaintMaskVisibility();
}

function toggleGalleryInpaintMaskVisible() {
    galleryInpaintMaskVisible = !galleryInpaintMaskVisible;
    applyGalleryInpaintMaskVisibility();
}

function applyGalleryInpaintMaskVisibility() {
    const overlay = document.getElementById('galleryInpaintOverlay');
    const btn = document.getElementById('galleryInpaintMaskToggleBtn');
    const cursor = document.getElementById('galleryInpaintBrushCursor');

    if (overlay) {
        overlay.style.opacity = galleryInpaintMaskVisible ? '1' : '0';
    }

    if (cursor) {
        cursor.style.display = galleryInpaintMaskVisible ? cursor.style.display : 'none';
    }

    if (btn) {
        btn.innerText = galleryInpaintMaskVisible ? '선택범위 숨김' : '선택범위 표시';
        btn.classList.toggle('active', !galleryInpaintMaskVisible);
    }
}

function setGalleryInpaintTool(tool, button) {
    galleryInpaintTool = tool === 'eraser' ? 'eraser' : 'brush';

    document.querySelectorAll('.gallery-inpaint-tool-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    document.querySelectorAll('.gallery-inpaint-tool-wrap').forEach(wrap => {
        wrap.classList.remove('open');
    });

    if (button) {
        button.classList.add('active');
        const wrap = button.closest('.gallery-inpaint-tool-wrap');
        if (wrap) wrap.classList.add('open');
    }
    const overlay = document.getElementById('galleryInpaintOverlay');
    if (overlay && galleryInpaintLastPointerEvent) {
        updateGalleryInpaintBrushCursor(galleryInpaintLastPointerEvent, overlay);
    }
}

function setGalleryInpaintBrushSize(value) {
    galleryInpaintBrushSize = Math.max(8, Math.min(320, parseInt(value, 10) || 96));

    document.querySelectorAll('.gallery-inpaint-size-popover input[type="range"]').forEach(input => {
        input.value = String(galleryInpaintBrushSize);
    });

    document.querySelectorAll('.gallery-inpaint-size-readout').forEach(node => {
        node.innerText = `${galleryInpaintBrushSize}px`;
    });
    const overlay = document.getElementById('galleryInpaintOverlay');
    if (overlay && galleryInpaintLastPointerEvent) {
        updateGalleryInpaintBrushCursor(galleryInpaintLastPointerEvent, overlay);
    }
}

function isGalleryLogoRemovalEnabled() {
    const check = document.getElementById('galleryInpaintLogoRemovalCheck');

    if (check) {
        return Boolean(check.checked);
    }

    return Boolean(galleryInpaintSession?.promptInfo?.logoRemoval);
}

function getEffectiveGalleryInpaintPromptInfo() {
    const baseInfo = normalizeGalleryPromptInfo(galleryInpaintSession?.promptInfo || {});
    const logoRemovalEnabled = isGalleryLogoRemovalEnabled();

    return normalizeGalleryPromptInfo({
        ...baseInfo,
        basePrompt: buildGalleryLogoRemovalBasePrompt(
            baseInfo.basePrompt || baseInfo.baseCaption || '',
            logoRemovalEnabled
        ),
        logoRemoval: logoRemovalEnabled
    });
}

function openGalleryInpaintPrompt() {
    if (!galleryInpaintSession) return;

    const p = normalizeGalleryPromptInfo(galleryInpaintSession.promptInfo || {});

    document.getElementById('galleryInpaintBasePrompt').value = p.basePrompt || '';
    setGalleryInpaintCharPromptValues(
        p.charPrompts && p.charPrompts.length
            ? p.charPrompts
            : p.charPrompt || ''
    );
    document.getElementById('galleryInpaintNegativePrompt').value = p.negativePrompt || '';
    document.getElementById('galleryInpaintStrength').value = p.strength ?? 0.65;
    document.getElementById('galleryInpaintNoise').value = p.noise ?? 0.2;

    document.getElementById('galleryInpaintPromptLayer').style.display = 'flex';
}

function closeGalleryInpaintPrompt() {
    const layer = document.getElementById('galleryInpaintPromptLayer');
    if (layer) layer.style.display = 'none';
}

function saveGalleryInpaintPrompt() {
    if (!galleryInpaintSession) return;

    const previousPromptInfo = normalizeGalleryPromptInfo(galleryInpaintSession.promptInfo || {});
    const charPrompts = getGalleryInpaintCharPromptValues();

    const basePromptInput = String(document.getElementById('galleryInpaintBasePrompt').value || '').trim();

    const basePrompt =
        basePromptInput ||
        previousPromptInfo.basePrompt ||
        previousPromptInfo.baseCaption ||
        '';
    const logoRemovalEnabled = isGalleryLogoRemovalEnabled();

    galleryInpaintSession.promptInfo = normalizeGalleryPromptInfo({
        ...(galleryInpaintSession.promptInfo || {}),
        basePrompt,
        baseCaption: previousPromptInfo.baseCaption || basePrompt,
        charPrompts,
        charPrompt: buildLegacyCharPromptText(charPrompts),
        negativePrompt: document.getElementById('galleryInpaintNegativePrompt').value || previousPromptInfo.negativePrompt || '',
        strength: parseFloat(document.getElementById('galleryInpaintStrength').value || previousPromptInfo.strength || '0.65'),
        noise: parseFloat(document.getElementById('galleryInpaintNoise').value || previousPromptInfo.noise || '0.2'),
        logoRemoval: logoRemovalEnabled
    });

    closeGalleryInpaintPrompt();
}

async function requestGalleryInpaint() {
    if (!galleryInpaintSession) return;

    const mask = galleryInpaintSession.maskDataUrl || '';
    if (!mask) {
        alert('인페인팅할 영역을 먼저 칠해 주세요.');
        return;
    }

    const safePromptInfo = getEffectiveGalleryInpaintPromptInfo();
    galleryInpaintSession.promptInfo = safePromptInfo;

    setGalleryInpaintProcessing(true, '인페인팅 처리 중...');

    try {
        const response = await fetch('/api/canvas/inpaint', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                image: galleryInpaintSession.currentSrc,
                mask,
                width: galleryInpaintSession.imageWidth,
                height: galleryInpaintSession.imageHeight,
                promptInfo: safePromptInfo,
                tempCategory: GALLERY_INPAINT_TEMP_CATEGORY,
                tempSessionId: galleryInpaintSession.tempSessionId
            })
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '인페인팅 요청에 실패했습니다.');
        }

        galleryInpaintSession.resultSrc = `${data.src}?t=${Date.now()}`;
        galleryInpaintSession.currentSrc = galleryInpaintSession.resultSrc;
        galleryInpaintSession.saved = false;

        const img = document.getElementById('galleryInpaintImage');
        if (img) {
            img.src = galleryInpaintSession.currentSrc;
        }

        // 완료 후에는 선택범위를 숨긴 상태로 전환
        galleryInpaintMaskVisible = false;
        applyGalleryInpaintMaskVisibility();

        showToast('인페인팅 결과를 받았습니다.');
    } catch (e) {
        alert(`인페인팅 실패: ${e.message || e}`);
    } finally {
        setGalleryInpaintProcessing(false);
    }
}

async function overwriteGalleryInpaintResult() {
    if (!galleryInpaintSession || !galleryInpaintSession.resultSrc) {
        alert('먼저 인페인팅 결과를 만들어 주세요.');
        return;
    }

    if (!galleryInpaintSession.originalPath) {
        alert('원본 경로가 없어 덮어쓸 수 없습니다.');
        return;
    }

    if (!confirm('현재 인페인팅 결과로 원본 이미지를 덮어쓸까요?')) return;

    try {
        const sessionToCleanup = { ...galleryInpaintSession };
        const safePromptInfo = getEffectiveGalleryInpaintPromptInfo();
        galleryInpaintSession.promptInfo = safePromptInfo;

        const response = await fetch('/api/gallery/overwrite_image', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                source_image: galleryInpaintSession.resultSrc,
                target_path: galleryInpaintSession.originalPath,
                promptInfo: safePromptInfo
            })
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '덮어쓰기 실패');
        }

        const refreshedPath = data.path || galleryInpaintSession.originalPath;
        const refreshedSrc = markGalleryImageUpdated(refreshedPath);

        galleryInpaintSession.originalPath = refreshedPath;
        galleryInpaintSession.currentSrc = refreshedSrc;
        galleryInpaintSession.resultSrc = refreshedSrc;
        galleryInpaintSession.saved = true;
        galleryInpaintSession.savedPath = refreshedPath;
        galleryInpaintSession.tempSessionId = '';

        const inpaintImg = document.getElementById('galleryInpaintImage');
        if (inpaintImg) {
            inpaintImg.src = refreshedSrc;
        }

        if (activeImageContext) {
            activeImageContext.path = refreshedPath;
            activeImageContext.imgSrc = refreshedSrc;
        }

        updateGalleryImageDomAfterOverwrite(refreshedPath, refreshedSrc);

        showToast('원본 이미지를 덮어썼습니다.');
        await loadData();

        // loadData가 전체를 다시 그린 뒤에도 한 번 더 적용
        updateGalleryImageDomAfterOverwrite(refreshedPath, refreshedSrc);
        await cleanupGalleryInpaintTempSession(sessionToCleanup);
        closeGalleryInpaint();
    } catch (e) {
        alert(`덮어쓰기 실패: ${e.message || e}`);
    }
}

async function saveGalleryInpaintResultAsNew() {
    if (!galleryInpaintSession || !galleryInpaintSession.resultSrc) {
        alert('먼저 인페인팅 결과를 만들어 주세요.');
        return;
    }

    try {
        const sessionToCleanup = { ...galleryInpaintSession };
        const safePromptInfo = getEffectiveGalleryInpaintPromptInfo();
        galleryInpaintSession.promptInfo = safePromptInfo;
        
        const response = await fetch('/api/gallery/save_inpaint_as_new', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                source_image: galleryInpaintSession.resultSrc,
                source_path: galleryInpaintSession.originalPath || '',
                promptInfo: safePromptInfo
            })
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '새로 저장 실패');
        }

        galleryInpaintSession.saved = true;
        galleryInpaintSession.savedPath = data.path || '';
        galleryInpaintSession.tempSessionId = '';

        showToast('인페인팅 결과를 새 파일로 저장했습니다.');
        await loadData();
        await cleanupGalleryInpaintTempSession(sessionToCleanup);
        closeGalleryInpaint();
    } catch (e) {
        alert(`새로 저장 실패: ${e.message || e}`);
    }
}

async function revealContextImage() {
    closeImageContextMenu();

    if (!activeImageContext || !activeImageContext.path) {
        alert('이미지 경로가 없습니다.');
        return;
    }

    const now = Date.now();
    const path = activeImageContext.path;

    // 같은 이미지 연속 클릭 방지
    if (revealExplorerBusy) return;

    if (lastRevealExplorerPath === path && now - lastRevealExplorerAt < 1200) {
        showToast('이미 경로 탐색을 요청했습니다.');
        return;
    }

    revealExplorerBusy = true;
    lastRevealExplorerPath = path;
    lastRevealExplorerAt = now;

    try {
        const res = await fetch('/api/reveal_in_explorer', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                path,
                mode: 'select'
            })
        });

        const json = await res.json();

        if (json.status !== 'success') {
            throw new Error(json.message || '경로를 열 수 없습니다.');
        }

        // 서버가 실제 찾은 경로를 돌려주면 현재 context도 보정
        if (json.path) {
            activeImageContext.path = json.path;
        }

        if (json.message) {
            showToast(json.message);
        }
    } catch (e) {
        alert(`경로 탐색 실패: ${e.message || e}`);
    } finally {
        setTimeout(() => {
            revealExplorerBusy = false;
        }, 800);
    }
}

function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderPromptText(text) {
    const safeText = String(text || '').trim();
    return safeText ? escapeHtml(safeText).replace(/\n/g, '<br>') : '<div class="prompt-empty">없음</div>';
}

function closePromptViewer() {
    document.getElementById('promptLayer').style.display = 'none';
}

function renderPromptViewer(data) {
    data = data || {};

    const charPrompts = normalizeCharPromptList(
        Array.isArray(data.charPrompts) && data.charPrompts.length
            ? data.charPrompts
            : Array.isArray(data.char_prompts) && data.char_prompts.length
                ? data.char_prompts
                : data.charPrompt || data.char_prompt || ''
    );

    const charPromptBlocks = charPrompts.length
        ? charPrompts.map((prompt, idx) => `
            <div class="prompt-section">
                <div class="prompt-title">Char Prompt ${idx + 1}</div>
                <div class="prompt-text">${renderPromptText(prompt)}</div>
            </div>
        `).join('')
        : `
            <div class="prompt-section">
                <div class="prompt-title">Char Prompt</div>
                <div class="prompt-text">${renderPromptText('')}</div>
            </div>
        `;

    document.getElementById('promptTitle').textContent = `📝 Prompt Viewer - ${data.fileName || ''}`;
    document.getElementById('promptBodyContent').innerHTML = `
        <div class="prompt-section">
            <div class="prompt-title">Base Prompt</div>
            <div class="prompt-text">${renderPromptText(data.basePrompt)}</div>
        </div>
        <div class="prompt-section">
            <div class="prompt-title">Base Caption</div>
            <div class="prompt-text">${renderPromptText(data.baseCaption)}</div>
        </div>
        <div class="prompt-section">
            <div class="prompt-title">Negative Prompt</div>
            <div class="prompt-text">${renderPromptText(data.negativePrompt)}</div>
        </div>
        ${charPromptBlocks}
    `;
}

async function openPromptViewer() {
    closeImageContextMenu();
    if (!activeImageContext) return;

    const layer = document.getElementById('promptLayer');
    layer.style.display = 'flex';
    document.getElementById('promptTitle').textContent = `📝 Prompt Viewer - ${getImageFileName(activeImageContext.path)}`;
    document.getElementById('promptBodyContent').innerHTML = '<div class="loading-text" style="padding:40px;">프롬프트를 불러오는 중...</div>';

    try {
        const res = await fetch('/api/prompt_info', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ path: activeImageContext.path })
        });
        const json = await res.json();
        if (json.status !== 'success') throw new Error(json.message || '프롬프트를 읽을 수 없습니다.');
        renderPromptViewer(json.data || {});
    } catch (e) {
        document.getElementById('promptBodyContent').innerHTML = `<div class="loading-text" style="padding:40px; color:#ff6b6b;">${escapeHtml(e.message || String(e))}</div>`;
    }
}

function goToRoot() {
    currentPath = getDefaultGalleryPath();

    currentSelectedBrand = 'ALL';
    currentSelectedChar = 'ALL';
    currentSelectedGalleryArtStyle = 'ALL';
    searchText = '';

    const searchInput = document.getElementById('folder-search');
    if (searchInput) searchInput.value = '';

    buildFilterDropdowns(currentPath[currentPath.length - 1]);
    renderView();
    window.scrollTo(0, 0);
    saveGallerySessionState();
}

function handleSearch(val) {
    searchText = val.toLowerCase().trim();
    document.getElementById('clear-search').style.display = searchText ? 'block' : 'none';
    renderView();
    saveGallerySessionState();
}

function clearSearch() {
    searchText = '';
    document.getElementById('folder-search').value = '';
    document.getElementById('clear-search').style.display = 'none';

    renderView();
    saveGallerySessionState();
}

function toggleSection(headerId, contentId) {
    const header = document.getElementById(headerId);
    const content = document.getElementById(contentId);
    if (!header || !content) return;

    header.classList.toggle('closed');
    content.classList.toggle('closed');
    saveGallerySessionState();
}

function normalizeGalleryCharacterName(value) {
    return String(value || '')
        .replace(/_\d+pcs$/i, '')
        .replace(/\s+\d+pcs$/i, '')
        .replace(/_dakimakura$/i, '')
        .replace(/\s+dakimakura$/i, '')
        .replace(/_/g, ' ')
        .replace(/[()[\]{}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getGalleryCharacterLookupKeys(value) {
    const raw = String(value || '').trim();
    const keys = new Set();

    const addKey = (text) => {
        const key = normalizeGalleryCharacterName(text).toLowerCase();
        if (key) keys.add(key);
    };

    addKey(raw);

    const outsideParen = raw.replace(/\([^)]*\)/g, ' ');
    addKey(outsideParen);

    const parenMatches = [...raw.matchAll(/\(([^)]+)\)/g)];
    parenMatches.forEach((match) => {
        if (match[1]) addKey(match[1]);
    });

    addKey(raw.replace(/_/g, ' '));

    return [...keys].filter(Boolean);
}
function getGalleryBrandForCharacterName(value) {
    const keys = getGalleryCharacterLookupKeys(value);

    for (const key of keys) {
        if (globalBrandMap[key]) {
            return globalBrandMap[key];
        }
    }

    return "기타 (미분류)";
}

function getGalleryFolderCharacterNames(folder) {
    const rawNames = Array.isArray(folder?.char_names) && folder.char_names.length
        ? folder.char_names
        : [folder?.name || ''];

    const names = [];

    rawNames.forEach((name) => {
        String(name || '')
            .split(/_and_|\s+and\s+/i)
            .map(normalizeGalleryCharacterName)
            .filter(Boolean)
            .forEach((part) => {
                if (!names.includes(part)) names.push(part);
            });
    });

    return names;
}

function getGalleryFolderImageCount(folder) {
    return Number(folder?.total_images || 0);
}

function buildFilterDropdowns(currentNode) {
    const folders = Array.isArray(currentNode?.folders) ? currentNode.folders : [];

    // 최종 이미지 폴더는 브랜드 필터를 다시 만들 대상이 아니다.
    // 여기서 브랜드 데이터를 비워버리면, 폴더 안에 들어가는 순간
    // currentSelectedBrand/currentSelectedChar가 ALL로 초기화되어
    // 다시 Duo/Group으로 돌아올 때 선택 상태가 사라진다.
    if (!folders.length) {
        updateCharChips();
        return;
    }

    let brandsData = {};

    folders.forEach(f => {
        let names = getGalleryFolderCharacterNames(f);
        let folderImages = getGalleryFolderImageCount(f);

        names.forEach(n => {
            let brand = getGalleryBrandForCharacterName(n);

            if (!brandsData[brand]) {
                brandsData[brand] = { maxImages: 0, chars: {} };
            }

            let charName = normalizeGalleryCharacterName(n);

            if (!charName) return;

            // Duo / Group에서는 같은 캐릭터가 여러 폴더에 나뉘어 있으므로 최대값이 아니라 합산해야 한다.
            const nextCharCount = Number(brandsData[brand].chars[charName] || 0) + folderImages;
            brandsData[brand].chars[charName] = nextCharCount;

            // 브랜드 노출 기준도 해당 브랜드 안의 캐릭터 누적 보유량 기준으로 잡는다.
            if (nextCharCount > brandsData[brand].maxImages) {
                brandsData[brand].maxImages = nextCharCount;
            }
        });
    });

    const brandSelect = document.getElementById('brandSelect');
    if (!brandSelect) return;

    brandSelect.innerHTML = '<option value="ALL">전체 브랜드</option>';

    let sortedBrands = Object.keys(brandsData).sort((a, b) => {
        if (a === "기타 (미분류)") return 1;
        if (b === "기타 (미분류)") return -1;
        return brandsData[b].maxImages - brandsData[a].maxImages || a.localeCompare(b);
    });

    sortedBrands.forEach(brand => {
        let isVis = globalBrandVisibility[brand];
        let shouldShow = false;

        if (isVis === 0) {
            shouldShow = false;
        } else if (isVis === 1) {
            shouldShow = true;
        } else {
            shouldShow = (brandsData[brand].maxImages >= 10 || brand === "기타 (미분류)");
        }

        if (shouldShow) {
            let opt = document.createElement('option');
            opt.value = brand;
            opt.textContent = brand;
            brandSelect.appendChild(opt);
        }
    });

    const previousBrand = currentSelectedBrand || 'ALL';
    const previousChar = currentSelectedChar || 'ALL';

    windowBrandsData = brandsData;

    if (previousBrand !== 'ALL' && brandSelect.querySelector(`option[value="${CSS.escape(previousBrand)}"]`)) {
        currentSelectedBrand = previousBrand;
        brandSelect.value = previousBrand;
    } else {
        currentSelectedBrand = 'ALL';
        brandSelect.value = 'ALL';
    }

    if (
        currentSelectedBrand !== 'ALL' &&
        previousChar !== 'ALL' &&
        windowBrandsData[currentSelectedBrand]?.chars?.[previousChar]
    ) {
        currentSelectedChar = previousChar;
    } else {
        currentSelectedChar = 'ALL';
    }

    updateCharChips();
}

function updateCharChips() {
    const container = document.getElementById('char-chip-container');
    if (!container) return;

    container.innerHTML = '';

    if (currentSelectedBrand === 'ALL') {
        container.style.display = 'none';
        return;
    }

    const brandData = windowBrandsData[currentSelectedBrand];

    if (!brandData || !brandData.chars || !Object.keys(brandData.chars).length) {
        container.style.display = 'none';
        currentSelectedChar = 'ALL';
        return;
    }

    container.style.display = 'flex';

    const allBtn = document.createElement('button');
    allBtn.className = `char-chip ${currentSelectedChar === 'ALL' ? 'active' : ''}`;
    allBtn.textContent = 'ALL';
    allBtn.onclick = () => selectChar('ALL');
    container.appendChild(allBtn);

    const sortedChars = Object.keys(brandData.chars)
        .map((name) => ({
            name,
            count: Number(brandData.chars[name] || 0)
        }))
        .filter((item) => item.count >= 10)
        .sort((a, b) => {
            const countDiff = b.count - a.count;
            if (countDiff !== 0) return countDiff;
            return a.name.localeCompare(b.name);
        });

    sortedChars.forEach((item) => {
        const btn = document.createElement('button');
        btn.className = `char-chip ${currentSelectedChar === item.name ? 'active' : ''}`;
        btn.textContent = `${item.name} (${item.count})`;
        btn.onclick = () => selectChar(item.name);
        container.appendChild(btn);
    });
}

function onBrandChange() {
    currentSelectedBrand = document.getElementById('brandSelect').value;
    currentSelectedChar = 'ALL';

    updateCharChips();
    renderView();
    saveGallerySessionState();
}

function selectChar(charName) {
    currentSelectedChar = charName;

    updateCharChips();
    renderView();
    saveGallerySessionState();
}

function renderView() {
    const currentNode = currentPath[currentPath.length - 1];
    const cont = document.getElementById('content');
    cont.innerHTML = '';

    const isFinalFolder = isFinalImageFolder(currentNode);
    updateGalleryFilterUi(currentNode);
    ensureGalleryImageFilterMeta(currentNode);

    const navTabs = document.getElementById('nav-tabs');
    navTabs.innerHTML = '';

    rootTree.folders.forEach(catNode => {
        const btn = document.createElement('button');
        const isActive = (currentPath[1] && currentPath[1].name === catNode.name);
        btn.className = `nav-btn ${isActive ? 'active' : ''}`;
        btn.innerText = catNode.name.replace(/^\d+_/, '');
        btn.onclick = () => {
            const previousTopNode = currentPath[1] || null;
            const isSameTopCategory = previousTopNode && previousTopNode.name === catNode.name;

            currentPath = [rootTree, catNode];

            // 같은 최상위 카테고리로 돌아오는 경우에는 브랜드/캐릭터 선택을 유지한다.
            // 예: Duo에서 폴더 안으로 들어갔다가 상단 Duo를 다시 누르는 경우.
            if (!isSameTopCategory) {
                currentSelectedBrand = 'ALL';
                currentSelectedChar = 'ALL';
                searchText = '';

                const searchInput = document.getElementById('folder-search');
                if (searchInput) searchInput.value = '';
            }

            currentSelectedGalleryArtStyle = 'ALL';

            buildFilterDropdowns(catNode);
            renderView();
            saveGallerySessionState();
            window.scrollTo(0, 0);
        };
        navTabs.appendChild(btn);
    });

    const bcPath = document.getElementById('breadcrumb-path');
    bcPath.innerHTML = '<span style="cursor:pointer;" onclick="goToRoot()">🏠 HOME</span>';

    currentPath.forEach((node, idx) => {
        if (idx === 0) return;

        const span = document.createElement('span');
        let displayName = (idx === 1)
            ? node.name.replace(/^\d+_/, '')
            : node.name.replace(/_\d+pcs$/i, '').replace(/_/g, ' ');

        span.innerHTML = ` <span style="color:var(--accent)">❯</span> <span style="cursor:pointer; color:${idx === currentPath.length - 1 ? '#fff' : '#888'}">${displayName}</span>`;
        span.onclick = () => {
            const previousTopNode = currentPath[1] || null;
            const nextPath = currentPath.slice(0, idx + 1);
            const nextTopNode = nextPath[1] || null;
            const isReturningToSameTopCategory =
                idx === 1 &&
                previousTopNode &&
                nextTopNode &&
                previousTopNode.name === nextTopNode.name;

            currentPath = nextPath;

            // 같은 최상위 카테고리로 돌아가는 breadcrumb 클릭이면 브랜드/캐릭터 선택을 유지한다.
            // 다른 계층으로 이동하는 경우에는 기존처럼 초기화한다.
            if (!isReturningToSameTopCategory) {
                currentSelectedBrand = 'ALL';
                currentSelectedChar = 'ALL';
                searchText = '';

                const searchInput = document.getElementById('folder-search');
                if (searchInput) searchInput.value = '';
            }

            currentSelectedGalleryArtStyle = 'ALL';

            buildFilterDropdowns(currentPath[currentPath.length - 1]);
            renderView();
            saveGallerySessionState();
        };

        bcPath.appendChild(span);
    });

    let displayFolders = currentNode.folders.filter(f => {
        if (!passesGalleryDakiFilter(f, true)) return false;

        const folderNameText = String(f.name || '').replace(/_/g, ' ').toLowerCase();
        const charNameText = getGalleryFolderCharacterNames(f)
            .map(name => name.toLowerCase())
            .join(' ');

        const matchesSearch = !searchText ||
            folderNameText.includes(searchText) ||
            charNameText.includes(searchText);

        if (!matchesSearch) return false;

        if (currentSelectedBrand === 'ALL') return true;

        const names = getGalleryFolderCharacterNames(f);

        const hasSelectedBrand = names.some(n => {
            const brand = getGalleryBrandForCharacterName(n);
            return brand === currentSelectedBrand;
        });

        if (!hasSelectedBrand) return false;

        if (currentSelectedChar !== 'ALL') {
            const normalizedNames = names.map(normalizeGalleryCharacterName);
            if (!normalizedNames.includes(currentSelectedChar)) return false;
        }

        return true;
    });

    let displayImages = (currentNode.images || []).filter(item => {
        return passesGalleryDakiFilter(item, false);
    });

    if (isFinalFolder) {
        const promptTerms = splitGalleryPromptTerms(searchText);
        displayImages = displayImages.filter(item => {
            return imageMatchesGalleryPromptFilter(item, promptTerms) &&
                imageMatchesGalleryArtStyleFilter(item) &&
                imageMatchesGalleryTagFilter(item);
        });
    } else if (currentGalleryTagFilter !== 'ALL') {
        displayImages = displayImages.filter(item => imageMatchesGalleryTagFilter(item));
    }

    const isSearchFiltering = isFinalFolder
        ? (currentSelectedGalleryArtStyle !== 'ALL' || currentGalleryTagFilter !== 'ALL' || searchText !== '')
        : (currentSelectedBrand !== 'ALL' || currentGalleryTagFilter !== 'ALL' || searchText !== '');

    const majorFolders = displayFolders.filter(f => f.total_images >= 10);
    const minorFolders = displayFolders.filter(f => f.total_images < 10);
    const hasImages = displayImages.length > 0;

    const defaultState = (hasImages && !isSearchFiltering && !isFinalFolder) ? 'closed' : '';

    if (majorFolders.length > 0) {
        renderCollapsibleGrid(cont, "major", "👑 메이저 그룹", majorFolders, "#00ff88", defaultState);
    }

    if (minorFolders.length > 0) {
        renderCollapsibleGrid(cont, "minor", "🌱 마이너 그룹", minorFolders, "#888", defaultState);
    }

    if (hasImages && (!isSearchFiltering || isFinalFolder)) {
        const imageTitle = (
            displayImages.length !== (currentNode.images || []).length ||
            isFinalFolder && isSearchFiltering
        )
            ? `🖼️ 이미지 (${displayImages.length} / ${(currentNode.images || []).length})`
            : `🖼️ 이미지 (${displayImages.length})`;    

        renderImageGrid(cont, imageTitle, displayImages, currentNode);
    }

    const finalSpacer = document.createElement('div');
    finalSpacer.style.height = '400px';
    finalSpacer.style.width = '100%';
    cont.appendChild(finalSpacer);

    applyGalleryCollapsedState();
    saveGallerySessionState();
}

function renderCollapsibleGrid(container, id, title, folders, borderColor, defaultState) {
    const wrapper = document.createElement('div');
    wrapper.className = 'collapsible-wrapper';
    const hId = `header-${id}`; const cId = `content-${id}`;
    wrapper.innerHTML = `
        <div class="section-header ${defaultState}" id="${hId}" onclick="toggleSection('${hId}', '${cId}')" style="border-left-color:${borderColor}">
            <span style="font-size:20px; font-weight:900; color:${borderColor}">${title} (${folders.length})</span>
            <span class="arrow">▼</span>
        </div>
        <div class="section-content ${defaultState}" id="${cId}"><div class="flex-masonry" id="grid-${id}"></div></div>`;
    container.appendChild(wrapper);

    const grid = document.getElementById(`grid-${id}`);
    const colCount = window.innerWidth <= 1400 ? 3 : 4;
    const cols = Array.from({length: colCount}, () => {
        const col = document.createElement('div'); col.className = 'flex-masonry-col';
        grid.appendChild(col); return col;
    });

    folders.forEach((child, idx) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.onclick = () => {
            currentPath.push(child);

            // 폴더 안으로 들어갈 때는 현재 선택한 브랜드/캐릭터를 유지한다.
            // 최종 이미지 폴더에서는 브랜드 필터 UI가 숨겨지므로 드롭다운 재구성이 필요 없다.
            currentSelectedGalleryArtStyle = 'ALL';

            // 폴더 내부에서는 검색어가 프롬프트 필터로 바뀔 수 있으므로 검색어만 비운다.
            searchText = '';

            const searchInput = document.getElementById('folder-search');
            if (searchInput) searchInput.value = '';

            if (Array.isArray(child.folders) && child.folders.length > 0) {
                buildFilterDropdowns(child);
            }

            renderView();
            saveGallerySessionState();
            window.scrollTo(0, 0);
        };

        const isDaki = isGalleryDakimakuraFolder(child);
        const imgSrc = child.thumb ? `/image/${encodeURIComponent(child.thumb)}` : '';
        // 🌟 사람 아이콘 원상 복구 및 정확한 줄바꿈 분리
        const nameRows = (child.char_names || [child.name])
            .flatMap(n => n.split(/ and | _and_ /i))
            .map(n => `<div class="char-row"><span class="user-icon">👤</span><span class="char-name">${n.trim().replace(/_/g, ' ')}</span></div>`)
            .join('');

        card.innerHTML = `
            <div class="card-body">
                ${imgSrc ? `<img src="${imgSrc}" class="card-main-img" loading="lazy">` : '<div style="height:150px;background:#222;"></div>'}
                ${isDaki ? `<div class="daki-badge-neon">DAKIMAKURA</div>` : ''}
                <div class="count-badge"><span class="count-num">${child.total_images}</span><span>FILES</span></div>
            </div>
            <div class="card-header">${nameRows}</div>`;
        cols[idx % colCount].appendChild(card);
    });
}

function renderImageGrid(container, title, images, parentNode) {
    const modeInput = document.querySelector('input[name="viewMode"]:checked');
    const isTrashMode = modeInput && modeInput.value === 'trash';
    const folderId = parentNode.name;

    const sec = document.createElement('div');
    sec.className = 'section-title';
    sec.style.borderLeftColor = 'var(--thumb)';
    sec.style.color = 'var(--thumb)';
    sec.style.display = 'flex';
    sec.style.justifyContent = 'space-between';
    sec.style.alignItems = 'center';

    let titleHtml = `<span>${title}</span>`;
    if (isTrashMode) {
        titleHtml += `<button onclick="emptyTrashFolder('${folderId}')" style="background:#f44; color:#fff; border:none; padding:8px 15px; border-radius:5px; font-weight:bold; cursor:pointer; font-size:13px; box-shadow: 0 0 10px rgba(255,68,68,0.4); transition: 0.2s;">🔥 이 폴더 영구 비우기</button>`;
    }
    sec.innerHTML = titleHtml;
    container.appendChild(sec);

    const g = document.createElement('div'); g.className = 'flex-masonry';
    const colCount = window.innerWidth <= 1400 ? 3 : 4;
    const cols = Array.from({length: colCount}, () => {
        const col = document.createElement('div'); col.className = 'flex-masonry-col';
        g.appendChild(col); return col;
    });

    const fk = parentNode.path;

    images.forEach((item, idx) => {
        const p = item.path;
        const imgSrc = getGalleryImageSrc(p);
        const galleryTagId = item.gallery_tag || getGalleryImageTagId(p);
        const galleryUpscaleBadgeHtml = renderGalleryUpscaleBadge(p);
        const galleryTagButtonHtml = renderGalleryImageTagButton(p, galleryTagId);
        const isNsfw = p.includes('_R-18') || p.includes('_R-15');
        const tLbl = isNsfw ? '일반' : 'R-19';
        const tIcon = isNsfw ? '🟢' : '🔞';
        const tCol = isNsfw ? '#39ff14' : '#ff007c';
        const tBg  = isNsfw ? '#122a15' : '#2a1215';

        const isSafeFolder = !item.path.includes('_R-18') && !item.path.includes('_R-15');
        const reasonClass = isSafeFolder ? 'reason-safe' : 'reason-nsfw';

        let warningHtml = '';
        if (item.warning || item.reason) {
            warningHtml = `<div class="nsfw-reason-box">`;
            if (item.warning) warningHtml += `<div class="${reasonClass}">${item.warning}</div>`;
            if (item.reason) warningHtml += `<div class="${reasonClass}">${item.reason}</div>`;
            warningHtml += `</div>`;
        }

        // 🌟 [핵심 수정] 파일명이 000_MAIN_으로 시작하면 UI에 자동으로 대표(Thumb) 표시를 유지합니다.
        // 🌟 [핵심] 파일명이 000_MAIN_으로 시작하면 UI에 자동으로 대표 표시 유지
        const isCurrentThumb = item.name.startsWith("000_MAIN_");
        const thumbLabel = isCurrentThumb ? "현재 대표" : "대표 지정";
        const thumbIcon = isCurrentThumb ? "👑" : "🖼️";
        const thumbBorder = isCurrentThumb ? "var(--thumb)" : "#4ff";

        let buttonsHtml = '';
        if (isTrashMode) {
            buttonsHtml = `
                <button onclick="restoreItem('${p}', 'box-${idx}')" style="flex:1; display:flex; align-items:center; justify-content:center; gap:5px; padding:8px 0; background:#122; color:#4ff; border:1px solid #4ff; cursor:pointer; border-radius:6px; font-weight:bold;"><span>⏪</span> <span style="font-size:11px;">복구</span></button>
                <button onclick="toggleSelect('${p}','${folderId}','${fk}','${item.name}','box-${idx}')" style="flex:1; display:flex; align-items:center; justify-content:center; gap:5px; padding:8px 0; background:#211; color:#f44; border:1px solid #f44; cursor:pointer; border-radius:6px; font-weight:bold;"><span>🔥</span> <span style="font-size:11px;">영구 삭제 대기</span></button>
            `;
        } else {
            buttonsHtml = `
                <button onclick="toggleSelect('${p}','${folderId}','${fk}','${item.name}','box-${idx}')" style="flex:1; display:flex; align-items:center; justify-content:center; gap:5px; padding:8px 0; background:#211; color:#f44; border:1px solid #f44; cursor:pointer; border-radius:6px; font-weight:bold;"><span>🗑️</span> <span style="font-size:11px;">삭제</span></button>
                <button onclick="toggleThumb('${fk}','${p}','${folderId}','${item.name}','box-${idx}')" style="flex:1; display:flex; align-items:center; justify-content:center; gap:5px; padding:8px 0; background:#122; color:${thumbBorder}; border:1px solid ${thumbBorder}; cursor:pointer; border-radius:6px; font-weight:bold;"><span>${thumbIcon}</span> <span style="font-size:11px;">${thumbLabel}</span></button>
                <button onclick="instantToggleNsfw('${p}', this, 'box-${idx}')" style="flex:1; display:flex; align-items:center; justify-content:center; gap:5px; padding:8px 0; background:${tBg}; color:${tCol}; border:1px solid ${tCol}; cursor:pointer; border-radius:6px; font-weight:bold;"><span>${tIcon}</span> <span style="font-size:11px;">${tLbl}</span></button>
            `;
        }

        const imgRatio = (item.w && item.h) ? `${item.w} / ${item.h}` : 'auto';

        // 🌟 isCurrentThumb 조건 추가!
        const boxClass = `item-box ${selDeletes.has(p)?'selected':''} ${(selThumbs.get(fk)?.path===p || isCurrentThumb)?'is-thumb':''}`;
        // 🌟 [수정 1] 따옴표 충돌을 막기 위해 HTML 안전 문자로 변환합니다.
        const safeImgSrc = JSON.stringify(imgSrc).replace(/"/g, '&quot;');
        const safeP = JSON.stringify(p).replace(/"/g, '&quot;');

        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <div class="${boxClass}" id="box-${idx}" data-path="${p}" data-fk="${fk}">
                <img src="${imgSrc}" loading="lazy" class="zoomable"
                        onclick="openZoom(${safeImgSrc})"
                        oncontextmenu="openImageContextMenu(event, ${safeP}, ${safeImgSrc})"
                        style="cursor:zoom-in; width:100%; height:auto; aspect-ratio: ${imgRatio}; display:block; background:#111; object-fit:contain;">
                ${galleryUpscaleBadgeHtml}
                ${galleryTagButtonHtml}
                ${warningHtml}
                <div style="display:flex; justify-content:space-between; gap:8px; padding:10px; background:#0c0c10; border-top:1px solid #333; margin-top:auto;">
                    ${buttonsHtml}
                </div>
            </div>`;
        cols[idx % colCount].appendChild(wrapper.firstElementChild);
    });
    container.appendChild(g);
}

function openZoom(src) { document.getElementById('zoomImg').src = src; document.getElementById('zoomLayer').style.display = 'flex'; }

// 🌟 [추가] 이미지 확대 모달 닫기 함수 (클릭 시 정상 축소되도록 복구)
function closeZoom() {
    document.getElementById('zoomLayer').style.display = 'none';
    document.getElementById('zoomImg').src = '';
}

// 🌟 [추가] 화면 하단에 잠시 나타났다 사라지는 알림 메시지 함수
function showToast(msg) {
    const toast = document.createElement('div');
    toast.innerText = msg;
    toast.style.cssText = `
        position: fixed; bottom: 50px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.85); color: #39ff14; padding: 12px 25px;
        border-radius: 30px; border: 1px solid #39ff14; z-index: 10000;
        font-weight: bold; font-size: 14px; box-shadow: 0 0 15px rgba(57,255,20,0.3);
        pointer-events: none; transition: opacity 0.3s;
    `;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2000);
}

function updateCounter() {
    document.getElementById('count-thm').innerText = selThumbs.size;
    document.getElementById('count-del').innerText = selDeletes.size;
    updateReview();
}

function toggleRv() {
    const b = document.getElementById('reviewBoard');
    b.style.display = (b.style.display === 'flex') ? 'none' : 'flex';
    updateReview();
}

function updateReview() {
    const body = document.getElementById('rvBody');
    const grouped = {};
    selThumbs.forEach((v, fk) => { if(!grouped[fk]) grouped[fk] = {name: v.folderId, thumb: null, dels: []}; grouped[fk].thumb = v; });
    selDeletes.forEach((v, path) => { const fk = v.folderKey; if(!grouped[fk]) grouped[fk] = {name: v.folderId, thumb: null, dels: []}; grouped[fk].dels.push({path, fileName: v.fileName}); });

    const keys = Object.keys(grouped);
    if(keys.length === 0) { body.innerHTML = '<div style="text-align:center; padding-top:50px; color:#444;">데이터가 없습니다.</div>'; return; }

    body.innerHTML = keys.map(fk => {
        const g = grouped[fk];
        return `<div class="rv-group"><div class="rv-group-title">📁 ${g.name}</div><div class="rv-grid">
            ${g.thumb ? `<div class="rv-item" style="border-color:var(--thumb)" onclick="unthumb('${fk}')"><img src="/image/${encodeURIComponent(g.thumb.path)}"></div>` : ''}
            ${g.dels.map(d => `<div class="rv-item" style="border-color:var(--accent)" onclick="undelete('${d.path}')"><img src="/image/${encodeURIComponent(d.path)}"></div>`).join('')}
        </div></div>`;
    }).join('');
}

function unthumb(fk) { selThumbs.delete(fk); updateCounter(); refreshGrid(); }
function undelete(p) { selDeletes.delete(p); updateCounter(); refreshGrid(); }

function refreshGrid() {
    document.querySelectorAll('.item-box').forEach(box => {
        const p = box.getAttribute('data-path');
        const fk = box.getAttribute('data-fk');
        const isOriginalThumb = p.split('/').pop().startsWith('000_MAIN_');

        box.classList.toggle('selected', selDeletes.has(p));

        if (selThumbs.has(fk)) {
            box.classList.toggle('is-thumb', selThumbs.get(fk).path === p);
        } else {
            box.classList.toggle('is-thumb', isOriginalThumb);
        }
    });
}

function normalizeGalleryRelPathForCompare(path) {
    return decodeURIComponent(String(path || ''))
        .replace(/\\/g, '/')
        .replace(/^\/image\//, '')
        .replace(/^TOTAL_CLASSIFIED\//, '')
        .split('?')[0];
}

function updateGalleryImageDomAfterOverwrite(relPath, refreshedSrc) {
    const target = normalizeGalleryPathKey(relPath);

    document.querySelectorAll('.item-box').forEach((box) => {
        const boxPath = normalizeGalleryPathKey(box.getAttribute('data-path'));
        if (boxPath !== target) return;

        const img = box.querySelector('img');
        if (!img) return;

        img.src = refreshedSrc;
        img.onclick = () => openZoom(refreshedSrc);
        img.oncontextmenu = (event) => {
            openImageContextMenu(event, target, refreshedSrc);
        };
    });

    document.querySelectorAll('#reviewBoard img').forEach((img) => {
        const srcPath = normalizeGalleryPathKey(img.getAttribute('src'));
        if (srcPath === target) {
            img.src = refreshedSrc;
        }
    });
}
function toggleThumb(fk, p, folderId, fileName, id) {
    const el = document.getElementById(id);
    if (selThumbs.get(fk)?.path === p) {
        selThumbs.delete(fk);
        el.classList.remove('is-thumb');
    } else {
        document.querySelectorAll('.item-box').forEach(b => {
            if (b.getAttribute('data-fk') === fk) b.classList.remove('is-thumb');
        });
        selThumbs.set(fk, {path: p, fileName, folderId});
        el.classList.add('is-thumb');
    }
    updateCounter();
}

function toggleSelect(p, folderId, folderKey, fileName, id) {
    const el = document.getElementById(id);
    if(selDeletes.has(p)) {
        selDeletes.delete(p);
        el.classList.remove('selected');
    } else {
        selDeletes.set(p, {folderId, folderKey, fileName});
        el.classList.add('selected');
    }
    updateCounter();
}

async function applyChanges() {
    if (selThumbs.size === 0 && selDeletes.size === 0) { alert("적용할 변경사항이 없습니다."); return; }

    const btn = document.getElementById('applyBtn');
    const originalText = "🚀 서버에 즉시 반영하기";

    btn.innerText = "⏳ 반영 중...";
    btn.disabled = true;

    try {
        const res = await fetch('/api/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                "thumbs": Array.from(selThumbs.values()).map(v => ({"new_thumb": v.path})),
                "deletes": Array.from(selDeletes.keys())
            })
        });
        const result = await res.json();

        if (result.status === 'success') {
            selThumbs.clear();
            selDeletes.clear();
            updateCounter();
            await loadData();

            btn.innerText = "✅ 반영 완료!";
            btn.style.background = "#39ff14";
            btn.style.color = "#000";

            setTimeout(() => {
                btn.innerText = originalText;
                btn.style.background = "#fff";
                btn.style.color = "#000";
                btn.disabled = false;
            }, 2000);

        } else {
            alert("오류: " + result.message);
            btn.innerText = originalText;
            btn.disabled = false;
        }
    } catch (e) {
        alert("통신 실패!");
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

async function instantToggleNsfw(currentPath, btnElement, boxId) {
    const box = document.getElementById(boxId);
    const mode = document.querySelector('input[name="viewMode"]:checked').value;
    btnElement.innerHTML = "<span>⏳</span>";
    btnElement.disabled = true;
    try {
        const res = await fetch('/api/toggle_nsfw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentPath })
        });
        const data = await res.json();
        if (data.status === 'success') {
            if (mode !== 'all') {
                box.style.opacity = "0";
                box.style.transform = "scale(0.9)";
                setTimeout(() => box.style.display = 'none', 200);
            } else {
                const isNowR19 = data.new_path.includes('_R-18');
                const tLbl = isNowR19 ? '일반' : 'R-19';
                const tIcon = isNowR19 ? '🟢' : '🔞';
                const tCol = isNowR19 ? '#39ff14' : '#ff007c';
                const tBg  = isNowR19 ? '#122a15' : '#2a1215';
                btnElement.innerHTML = `<span>${tIcon}</span> <span style="font-size:11px;">${tLbl}</span>`;
                btnElement.style.background = tBg;
                btnElement.style.color = tCol;
                btnElement.style.borderColor = tCol;
                btnElement.disabled = false;
                btnElement.setAttribute('onclick', `instantToggleNsfw('${data.new_path}', this, '${boxId}')`);
            }
        }
    } catch(e) {
        console.error(e);
        btnElement.disabled = false;
        btnElement.innerHTML = "<span>❌</span>";
    }
}

async function restoreItem(path, boxId) {
    if(!confirm("이 파일을 원래 있던 폴더로 복구하시겠습니까?")) return;
    const box = document.getElementById(boxId);
    box.style.opacity = "0.5";

    try {
        const res = await fetch('/api/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: path })
        });
        const data = await res.json();

        if(data.status === 'success') {
            box.style.opacity = "0";
            box.style.transform = "scale(0.9)";
            setTimeout(() => box.style.display = 'none', 200);
        } else {
            alert("복구 실패: " + data.message);
            box.style.opacity = "1";
        }
    } catch(e) {
        alert("통신 오류가 발생했습니다.");
        box.style.opacity = "1";
    }
}

async function emptyTrashFolder(folderName) {
    if(!confirm(`[${folderName}] 폴더의 모든 이미지를 디스크에서 영구 삭제하시겠습니까?\n이 작업은 절대 되돌릴 수 없습니다!`)) return;

    try {
        const res = await fetch('/api/empty_trash_folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: folderName })
        });
        const data = await res.json();

        if(data.status === 'success') {
            alert(data.message);
            loadData();
        } else {
            alert("삭제 실패: " + data.message);
        }
    } catch(e) {
        alert("통신 오류가 발생했습니다.");
    }
}

let statsThreshold = 10;
let includeDaki = true;

async function toggleStats() {
    const layer = document.getElementById('statsLayer');
    if (!layer) return;

    if (layer.style.display === 'flex') {
        layer.style.display = 'none';
    } else {
        layer.style.display = 'flex';
        await loadStats();
    }
}

async function loadStats() {
    const body = document.getElementById('statsBody');
    if (!body) return;

    body.innerHTML = '<div style="text-align:center; padding:50px; color:#6f42c1;">📊 아카이브 데이터 정밀 분석 중...</div>';

    try {
        const res = await fetch(`/api/stats?threshold=${statsThreshold}&include_daki=${includeDaki}`);
        const data = await res.json();

        let html = `
            <div style="margin-bottom:20px; display:flex; flex-wrap:wrap; align-items:center; gap:20px; background:#1a1a24; padding:15px; border-radius:10px; border:1px solid #333;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <span style="font-size:13px; color:#888;">최소 보유량:</span>
                    <input type="number" value="${statsThreshold}" onchange="statsThreshold=parseInt(this.value)||0; loadStats();"
                            style="background:#000; border:1px solid #444; color:#fff; padding:5px 10px; border-radius:5px; width:70px;">
                </div>
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; color:#eee;">
                    <input type="checkbox" ${includeDaki ? 'checked' : ''} onchange="includeDaki=this.checked; loadStats();"
                            style="accent-color:#39ff14; width:16px; height:16px;">
                    다키마쿠라 데이터 포함
                </label>
            </div>

            <div class="stats-grid">
                <div class="stat-box"><span>총 파일 수</span><span class="stat-val">${data.summary.total_count.toLocaleString()}</span></div>
                <div class="stat-box"><span>전체 야짤 비율</span><span class="stat-val" style="color:#ff007c;">${data.summary.nsfw_ratio}%</span></div>
                <div class="stat-box"><span>수집 캐릭터 수</span><span class="stat-val" style="color:#39ff14;">${data.summary.char_count}</span></div>
            </div>

            <table class="stats-table">
                <thead>
                    <tr>
                        <th style="width:50px;">순위</th>
                        <th>캐릭터</th>
                        <th style="width:70px;">전체</th>
                        <th style="width:70px; color:#39ff14;">일반</th>
                        <th style="width:70px; color:#ff007c;">R-19</th>
                        <th style="width:160px;">분포도</th>
                    </tr>
                </thead>
                <tbody>`;

        data.list.forEach((s, i) => {
            const safePer = s.total > 0 ? Math.round((s.safe / s.total) * 100) : 0;
            const nsfwPer = 100 - safePer;
            const isDaki = s.name.includes('(다키)');

            html += `
                <tr>
                    <td style="color:#666;">${i+1}</td>
                    <td style="font-weight:bold; color:${isDaki ? '#39ff14' : '#eee'}">${s.name}</td>
                    <td style="font-weight:900;">${s.total}</td>
                    <td style="color:#39ff14;">${s.safe}</td>
                    <td style="color:#ff007c;">${s.nsfw}</td>
                    <td>
                        <div class="bar-wrap">
                            <div class="bar-fill" style="width:${safePer}%; background:#39ff14; float:left;"></div>
                            <div class="bar-fill" style="width:${nsfwPer}%; background:#ff007c; float:left;"></div>
                        </div>
                        <span style="font-size:11px; color:#888;">${safePer}%</span>
                    </td>
                </tr>`;
        });

        html += `</tbody></table>`;
        body.innerHTML = html;
    } catch(e) {
        console.error("Stats loading error:", e);
        body.innerHTML = '<div style="color:#ff4d4d; padding:20px;">데이터를 불러오지 못했습니다. 서버가 실행 중인지 확인하세요.</div>';
    }
}

async function toggleBrandManager() {
    const layer = document.getElementById('brandLayer');
    if (layer.style.display === 'flex') {
        layer.style.display = 'none';
    } else {
        layer.style.display = 'flex';
        await loadBrandMgrData();
    }
}

async function loadBrandMgrData() {
    const container = document.getElementById('brandMgrTableContainer');
    container.innerHTML = '<div style="text-align:center; padding:50px; color:#ff007c;">📊 브랜드 데이터를 집계 중입니다...</div>';

    try {
        const res = await fetch('/api/brand_stats');
        const text = await res.text();

        let brandData = null;
        try {
            brandData = text ? JSON.parse(text) : null;
        } catch (parseError) {
            throw new Error(`브랜드 API가 JSON이 아닌 응답을 보냈습니다. HTTP ${res.status}`);
        }

        if (!res.ok || (brandData && brandData.status === 'error')) {
            throw new Error(brandData?.message || `HTTP ${res.status}`);
        }

        renderBrandMgrTable(brandData);
    } catch(e) {
        container.innerHTML = `<div style="color:red; padding:20px;">브랜드 데이터 로드 실패: ${escapeHtml(e.message || e)}</div>`;
    }
}

// index.html 내 renderBrandMgrTable 함수 수정
function renderBrandMgrTable(data) {
    const container = document.getElementById('brandMgrTableContainer');
    let html = `<table class="stats-table">
        <thead>
            <tr>
                <th style="text-align:center; width:60px;">노출</th>
                <th>브랜드 (English)</th>
                <th style="width:280px;">한국어 명칭</th>
                <th style="width:80px;">파일 수</th>
                <th style="width:80px;">R-19</th>
            </tr>
        </thead>
        <tbody>`;

    data.forEach(b => {
        if(b.name === "Unknown") return;
        const safeId = b.raw_name.replace(/[^a-zA-Z0-9]/g, '_');

        // 🌟 [수정] 10장 미만은 무조건 체크 해제 상태로 보이게 로직 강화
        // 사용자가 명시적으로 켠 것(is_visible=1)이 아니라면, 10장 미만은 false 처리
        let isChecked = false;
        if (b.is_visible === 1) {
            isChecked = true;
        } else if (b.is_visible === 0) {
            isChecked = false;
        } else {
            // 아직 설정값이 없는 신규 데이터만 10장 법칙 적용
            isChecked = b.total >= 10;
        }

        // 만약 '설정은 1인데 짤은 10장 미만'인 모순된 경우에도
        // 일단 사용자님이 한번 저장하기 전까지는 10장 법칙을 우선 적용하고 싶다면 아래 주석 해제:
        if (b.total < 10 && b.is_visible !== 1) isChecked = false;

        html += `
            <tr class="brand-row" data-raw="${b.raw_name}" data-name="${(b.name || '').toLowerCase()}" data-kr="${(b.name_kr || '').toLowerCase()}">
                <td style="text-align:center;">
                    <input type="checkbox" class="brand-vis-check" ${isChecked ? 'checked' : ''}
                            style="width:18px; height:18px; accent-color:#39ff14; cursor:pointer;">
                </td>
                <td style="color:#aaa; font-size:13px;">${b.name}</td>
                <td>
                    <input type="text" value="${b.name_kr || ''}" class="brand-kr-input" placeholder="비워두면 영어 이름 사용"
                            style="background:#1a1a24; border:1px solid #333; color:#fff; width:95%; padding:8px; border-radius:5px;">
                </td>
                <td style="font-weight:bold;">${b.total.toLocaleString()}</td>
                <td style="color:#ff007c;">${Math.round((b.nsfw/b.total)*100 || 0)}%</td>
            </tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}

function filterBrandMgrTable() {
    const term = document.getElementById('brand-mgr-search').value.toLowerCase();
    document.querySelectorAll('.brand-row').forEach(row => {
        const en = (row.getAttribute('data-name') || '').toLowerCase();
        const krInput = row.querySelector('.brand-kr-input');
        const kr = ((krInput && krInput.value) || row.getAttribute('data-kr') || '').toLowerCase();
        row.style.display = (en.includes(term) || kr.includes(term)) ? '' : 'none';
    });
}

async function saveAllBrandChanges() {
    const btn = document.getElementById('bulkSaveBtn');
    const rows = document.querySelectorAll('.brand-row');
    const updateData = [];

    rows.forEach(row => {
        const rawName = row.getAttribute('data-raw');
        const krName = row.querySelector('.brand-kr-input').value.trim();
        const isVisible = row.querySelector('.brand-vis-check').checked ? 1 : 0;
        updateData.push({ raw_name: rawName, brand_kr: krName, is_visible: isVisible });
    });

    btn.innerText = "⏳ 서버에 기록 중...";
    btn.disabled = true;

    try {
        const res = await fetch('/api/bulk_update_brands', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(updateData)
        });
        const result = await res.json();

        if (result.status === 'success') {
            btn.innerText = "✅ 저장 완료!";
            btn.style.background = "#fff";

            // 메인 화면 필터 갱신을 위해 데이터 재로드
            loadData();

            setTimeout(() => {
                btn.innerText = "🚀 모든 변경사항 일괄 저장";
                btn.style.background = "#39ff14";
                btn.disabled = false;
            }, 2000);
        }
    } catch(e) {
        alert("일괄 저장 실패!");
        btn.disabled = false;
    }
}
// 🌟 현재 화면(검색 결과 포함)에 보이는 모든 체크박스 조작
function setAllBrandCheck(status) {
    const rows = document.querySelectorAll('.brand-row');
    rows.forEach(row => {
        if (row.style.display !== 'none') {
            row.querySelector('.brand-vis-check').checked = status;
        }
    });
}

function openGalleryTagManager() {
    const layer = document.getElementById('galleryTagManagerLayer');
    if (!layer) return;

    pendingGalleryTagImageDataUrl = '';
    syncGalleryTagTypeInput();
    renderGalleryTagManagerList();
    updateGalleryTextTagPreview();
    layer.style.display = 'flex';
}

function closeGalleryTagManager() {
    const layer = document.getElementById('galleryTagManagerLayer');
    if (layer) layer.style.display = 'none';
}

function syncGalleryTagTypeInput() {
    const preview = document.getElementById('galleryTagImagePreview');
    if (preview) {
        preview.innerHTML = pendingGalleryTagImageDataUrl
            ? `<img src="${escapeHtml(pendingGalleryTagImageDataUrl)}" alt="">`
            : '';
    }

    updateGalleryTextTagPreview();
}

function updateGalleryTextTagPreview() {
    const input = document.getElementById('galleryTagTextInput');
    const textColorInput = document.getElementById('galleryTagTextColorInput');
    const bgColorInput = document.getElementById('galleryTagBgColorInput');
    const preview = document.getElementById('galleryTagTextPreview');

    if (!preview) return;

    const text = String(input?.value || '').trim() || '확인';
    const textColor = textColorInput?.value || '#ffffff';
    const bgColor = bgColorInput?.value || '#2563eb';

    preview.textContent = text;
    preview.style.color = textColor;
    preview.style.background = bgColor;
}

document.addEventListener('change', (event) => {
    if (event.target && event.target.id === 'galleryTagImageInput') {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            pendingGalleryTagImageDataUrl = String(reader.result || '');
            syncGalleryTagTypeInput();
            addGalleryImageTagFromManager();
        };
        reader.readAsDataURL(file);
    }
});

document.addEventListener('input', (event) => {
    if (
        event.target &&
        ['galleryTagTextInput', 'galleryTagTextColorInput', 'galleryTagBgColorInput'].includes(event.target.id)
    ) {
        updateGalleryTextTagPreview();
    }
});

function makeGalleryTagId(name) {
    const base = String(name || 'tag')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^\w가-힣ㄱ-ㅎㅏ-ㅣ-]+/g, '_')
        .replace(/^_+|_+$/g, '') || `tag_${Date.now()}`;

    let id = base;
    let seq = 2;
    const used = new Set(galleryTagDefs.map(tag => String(tag.id)));

    while (used.has(id)) {
        id = `${base}_${seq++}`;
    }

    return id;
}

function addGalleryImageTagFromManager() {
    if (!pendingGalleryTagImageDataUrl) {
        alert('추가할 태그 그림을 선택하세요.');
        return;
    }

    galleryTagDefs.push({
        id: makeGalleryTagId(`image_tag_${Date.now()}`),
        type: 'image',
        value: pendingGalleryTagImageDataUrl
    });

    pendingGalleryTagImageDataUrl = '';

    const fileInput = document.getElementById('galleryTagImageInput');
    if (fileInput) fileInput.value = '';

    const preview = document.getElementById('galleryTagImagePreview');
    if (preview) preview.innerHTML = '';

    renderGalleryTagManagerList();
}

function addGalleryTextTagFromManager() {
    const textInput = document.getElementById('galleryTagTextInput');
    const textColorInput = document.getElementById('galleryTagTextColorInput');
    const bgColorInput = document.getElementById('galleryTagBgColorInput');

    const value = String(textInput?.value || '').trim();

    if (!value) {
        alert('글자 태그 내용을 입력하세요.');
        return;
    }

    galleryTagDefs.push({
        id: makeGalleryTagId(value),
        type: 'text',
        value: value.slice(0, 12),
        textColor: textColorInput?.value || '#ffffff',
        bgColor: bgColorInput?.value || '#2563eb'
    });

    if (textInput) textInput.value = '';

    updateGalleryTextTagPreview();
    renderGalleryTagManagerList();
}

function deleteGalleryTagFromManager(tagId) {
    const tag = getGalleryTagDef(tagId);
    if (!tag) return;

    const usedCount = Object.values(galleryImageTags || {}).filter(id => String(id) === String(tagId)).length;

    const label = tag.type === 'text' ? `'${tag.value}'` : '이 그림';
    const ok = confirm(
        usedCount > 0
            ? `${label} 태그를 삭제할까요?\n이 태그가 붙은 이미지 ${usedCount}개의 태그도 함께 제거됩니다.`
            : `${label} 태그를 삭제할까요?`
    );

    if (!ok) return;

    galleryTagDefs = galleryTagDefs.filter(item => String(item.id) !== String(tagId));

    Object.keys(galleryImageTags || {}).forEach(path => {
        if (String(galleryImageTags[path]) === String(tagId)) {
            delete galleryImageTags[path];
        }
    });

    const currentNode = currentPath[currentPath.length - 1];
    if (currentNode && Array.isArray(currentNode.images)) {
        currentNode.images.forEach(item => {
            if (String(item.gallery_tag || '') === String(tagId)) {
                item.gallery_tag = '';
            }
        });
    }

    if (currentGalleryTagFilter === tagId) {
        currentGalleryTagFilter = 'ALL';
    }

    renderGalleryTagManagerList();
    renderGalleryTagFilterBar();
    renderView();
}

function renderGalleryTagManagerList() {
    const list = document.getElementById('galleryTagManagerList');
    if (!list) return;

    if (!galleryTagDefs.length) {
        list.innerHTML = '<div style="color:#888; padding:20px; text-align:center;">등록된 태그가 없습니다.</div>';
        return;
    }

    list.innerHTML = galleryTagDefs.map((tag, index) => {
        const usedCount = Object.values(galleryImageTags || {}).filter(id => String(id) === String(tag.id)).length;
        const iconHtml = renderGalleryTagIcon(tag);
        const typeLabel = tag.type === 'text' ? '글자' : '그림';

        return `
            <div class="gallery-tag-manager-row simple">
                <div class="gallery-tag-manager-icon">${iconHtml}</div>
                <div class="gallery-tag-manager-count">${typeLabel} · 사용 ${usedCount}개</div>
                <button type="button" class="gallery-tag-delete-btn" onclick="deleteGalleryTagFromManager('${escapeHtml(tag.id)}')">삭제</button>
            </div>
        `;
    }).join('');
}

async function saveGalleryTagsFromManager() {
    try {
        const res = await fetch('/api/gallery/tags', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ tags: galleryTagDefs })
        });

        const json = await res.json();

        if (!res.ok || json.status !== 'success') {
            throw new Error(json.message || '태그 저장 실패');
        }

        galleryTagDefs = json.tags || galleryTagDefs;
        galleryImageTags = json.image_tags || galleryImageTags;

        renderGalleryTagFilterBar();
        renderView();
        closeGalleryTagManager();
        showToast('태그 설정을 저장했습니다.');
    } catch (error) {
        alert(`태그 저장 실패: ${error.message || error}`);
    }
}

// 🌟 [추가] 그림체(아티스트) 관리 스크립트
async function toggleArtStyleManager() {
    const layer = document.getElementById('artStyleLayer');
    if (layer.style.display === 'flex') {
        layer.style.display = 'none';
    } else {
        layer.style.display = 'flex';
        await loadArtStyleData();
    }
}

// [수정] 그림체 데이터 로드 및 필터 상태 강제 적용
async function loadArtStyleData() {
    const container = document.getElementById('artStyleTableContainer');
    container.innerHTML = '<div style="text-align:center; padding:50px; color:#f1c40f;">📊 그림체 데이터를 집계 중입니다...</div>';

    try {
        const res = await fetch('/api/art_style_stats');
        const text = await res.text();

        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (parseError) {
            throw new Error(`그림체 API가 JSON이 아닌 응답을 보냈습니다. HTTP ${res.status}`);
        }

        if (!res.ok || (data && data.status === 'error')) {
            throw new Error(data?.message || `HTTP ${res.status}`);
        }

        renderArtStyleTable(data);
        filterArtStyleTable();

    } catch(e) {
        container.innerHTML = `<div style="color:red; padding:20px;">그림체 데이터 로드 실패: ${escapeHtml(e.message || e)}</div>`;
    }
}

function renderArtStyleTable(data) {
    const container = document.getElementById('artStyleTableContainer');

    // 🌟 [추가] 서버에서 에러 응답 시 화면 멈춤 현상(무한 로딩) 해결
    if (data && data.status === 'error') {
        container.innerHTML = `<div style="text-align:center; padding:50px; color:#ff4d4d; font-weight:bold;">오류 발생: ${escapeHtml(data.message)}</div>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:50px; color:#888;">수집된 그림체(아티스트)가 없습니다. 스캔 버튼을 눌러주세요.</div>';
        return;
    }

    let html = `<table class="stats-table" style="width:100%; border-collapse:collapse; table-layout: fixed;">
        <thead>
            <tr>
                <th style="width:200px;">그림체 (아티스트)</th>
                <th style="width:100px; text-align:center;">연구소</th>
                <th style="width:200px;">한국어 명칭</th>
                <th style="width:80px; text-align:center;">보유 수</th>
                <th style="width:300px;">미리보기 샘플 (클릭시 확대)</th>
            </tr>
        </thead>
        <tbody>`;

    data.forEach((a, i) => {
        const safeId = a.artist_name.replace(/[^a-zA-Z0-9]/g, '') + '_' + i;

        let samplesHtml = a.samples.map(p => {
            const encP = encodeURIComponent(p);
            const zoomP = JSON.stringify(`/image/${p}`).replace(/"/g, '&quot;');
            return `<img src="/image/${encP}" loading="lazy" style="height:65px; width:65px; object-fit:cover; border-radius:5px; border:1px solid #444; cursor:pointer; transition:0.2s;" onmouseover="this.style.borderColor='#f1c40f'" onmouseout="this.style.borderColor='#444'" onclick="openZoom(${zoomP})">`
        }).join('');

        const safeArtistName = JSON.stringify(a.artist_name).replace(/"/g, '&quot;');

        html += `
            <tr class="art-row" data-name="${a.artist_name.toLowerCase()}">
                <td>
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:5px;">
                        <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color:#f1c40f; font-weight:bold; font-size:13px;" title="${a.artist_name}">
                            ${a.artist_name}
                        </div>
                        <button onclick="openArtStyleDetail(${safeArtistName})" style="background:#f1c40f; color:#000; border:none; border-radius:3px; padding:3px 6px; cursor:pointer; font-size:11px; font-weight:bold; flex-shrink:0;">🔍확대</button>
                    </div>
                </td>
                <td style="text-align:center;">
                    <button type="button"
                            onclick="addArtStyleToLabFromRow(this, ${safeArtistName})"
                            style="background:#6c5ce7; color:#fff; border:none; border-radius:5px; padding:6px 9px; cursor:pointer; font-size:11px; font-weight:bold; white-space:nowrap;">
                        연구소 추가
                    </button>
                </td>
                <td>
                    <input type="text" value="${a.name_kr || ''}" class="art-kr-input" placeholder="커스텀 이름 입력"
                            style="background:#1a1a24; border:1px solid #333; color:#fff; width:90%; padding:8px; border-radius:5px;">
                </td>
                <td style="font-weight:bold; color:#fff; text-align:center;">${(a.count || 0).toLocaleString()}</td>
                <td>
                    <div style="display:flex; gap:15px; align-items:center;">
                        <button onclick="refreshRandomArtist(${safeArtistName}, 'samples_${safeId}')" style="background:#222; border:1px solid #444; color:#fff; padding:6px 12px; font-weight:bold; border-radius:5px; cursor:pointer; flex-shrink:0;">🔄 변경</button>
                        <div id="samples_${safeId}" style="display:flex; gap:8px; overflow:hidden;">${samplesHtml}</div>
                    </div>
                </td>
            </tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
}

async function refreshRandomArtist(artistName, containerId) {
    try {
        const res = await fetch(`/api/random_artist_images?artist=${encodeURIComponent(artistName)}`);
        const data = await res.json();
        if(data.samples) {
            const html = data.samples.map(p =>
                `<img src="/image/${encodeURIComponent(p)}" style="height:65px; width:65px; object-fit:cover; border-radius:5px; border:1px solid #444; cursor:pointer; transition:0.2s;" onmouseover="this.style.borderColor='#f1c40f'" onmouseout="this.style.borderColor='#444'" onclick="openZoom('/image/${encodeURIComponent(p)}')">`
            ).join('');
            document.getElementById(containerId).innerHTML = html;
        }
    } catch(e) { console.error(e); }
}

// 🌟 [추가] 현재 선택된 필터 상태를 저장하는 전역 변수
let currentArtStyleFilter = 'all';

// 🌟 [추가] 그림체 필터 변경 및 버튼 스타일 업데이트 함수
function setArtStyleFilter(type) {
    currentArtStyleFilter = type;

    document.getElementById('btnFilterAll').style.background = (type === 'all') ? '#f1c40f' : 'transparent';
    document.getElementById('btnFilterAll').style.color = (type === 'all') ? '#000' : '#fff';

    document.getElementById('btnFilterStd').style.background = (type === 'std') ? '#f1c40f' : 'transparent';
    document.getElementById('btnFilterStd').style.color = (type === 'std') ? '#000' : '#fff';

    document.getElementById('btnFilterWeight').style.background = (type === 'weight') ? '#f1c40f' : 'transparent';
    document.getElementById('btnFilterWeight').style.color = (type === 'weight') ? '#000' : '#fff';

    filterArtStyleTable();
}

// 🌟 [수정] 검색어와 필터 타입(조합형 vs 가중치)을 동시에 검사하는 필터링 로직
function filterArtStyleTable() {
    const searchInput = document.getElementById('art-style-search');
    if(!searchInput) return;
    const query = searchInput.value.toLowerCase();
    const rows = document.querySelectorAll('.art-row');

    rows.forEach(row => {
        const name = row.getAttribute('data-name');
        if(!name) return;
        const krInput = row.querySelector('.art-kr-input');
        const krName = krInput ? krInput.value.toLowerCase() : '';

        const isWeight = name.startsWith('[가중치]');

        let typeMatch = true;
        if (currentArtStyleFilter === 'std' && isWeight) typeMatch = false;
        if (currentArtStyleFilter === 'weight' && !isWeight) typeMatch = false;

        if (typeMatch && (name.includes(query) || krName.includes(query))) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

// 🌟 [추가] 그림체 상세 보기 팝업 제어 스크립트
// 🌟 [수정] 텍스트 내의 이중 이스케이프된 줄바꿈까지 완벽하게 처리하여 깨끗하게 표시
function openArtStyleDetail(fullText) {
    let formattedText = String(fullText || '')
        .replace(/\\\\n/g, '\n')  // 이중 역슬래시 처리
        .replace(/\\n/g, '\n');   // 단일 역슬래시 처리

    // 가중치 태그가 없는 일반 조합형일 경우에만 쉼표를 줄바꿈으로 변환
    if (!formattedText.startsWith('[가중치]') && formattedText.includes(', ')) {
        formattedText = formattedText.split(', ').join('\n');
    }

    document.getElementById('artStyleDetailArea').value = formattedText;
    document.getElementById('artStyleDetailLayer').style.display = 'flex';
}

function closeArtStyleDetail() {
    document.getElementById('artStyleDetailLayer').style.display = 'none';
}

function copyArtStyleDetail() {
    const area = document.getElementById('artStyleDetailArea');
    area.select();
    document.execCommand('copy');
    showToast("📋 클립보드에 복사되었습니다.");
}

async function addArtStyleToLabFromRow(button, artistName) {
    const row = button.closest('.art-row');
    const krInput = row ? row.querySelector('.art-kr-input') : null;
    const nameKr = krInput ? krInput.value.trim() : '';

    const originalText = button.innerText;
    button.disabled = true;
    button.innerText = '추가 중...';

    try {
        const res = await fetch('/api/art_style_to_lab', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                artist_name: artistName,
                name_kr: nameKr
            })
        });

        const data = await res.json();

        if (!res.ok || data.status !== 'success') {
            throw new Error(data.message || '연구소 추가 실패');
        }

        button.innerText = '추가됨';
        button.style.background = '#00b894';

        showToast(`🧪 [${data.style_name}] 연구소에 추가했습니다.`);

        setTimeout(() => {
            button.innerText = originalText;
            button.style.background = '#6c5ce7';
            button.disabled = false;
        }, 1800);

    } catch (error) {
        alert(`연구소 추가 실패: ${error.message || error}`);
        button.innerText = originalText;
        button.disabled = false;
    }
}

async function saveAllArtStyleChanges() {
    const btn = document.getElementById('bulkSaveArtBtn');
    const rows = document.querySelectorAll('.art-row');
    const updateData = [];

    rows.forEach(row => {
        // 🌟 [수정] 구조 변경에 맞게 제목 텍스트 추출 방식 변경
        const enName = row.querySelector('td div div').getAttribute('title');
        const krName = row.querySelector('.art-kr-input').value.trim();
        updateData.push({ artist_name: enName, name_kr: krName });
    });

    btn.innerText = "⏳ 서버에 기록 중...";
    btn.disabled = true;

    try {
        const res = await fetch('/api/bulk_update_art_styles', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(updateData)
        });
        const result = await res.json();
        if (result.status === 'success') {
            btn.innerText = "✅ 저장 완료!";
            btn.style.background = "#fff";
            setTimeout(() => {
                btn.innerText = "🚀 일괄 저장";
                btn.style.background = "#39ff14";
                btn.disabled = false;
            }, 2000);
        }
    } catch(e) {
        alert("일괄 저장에 실패했습니다!");
        btn.disabled = false;
    }
}

// 🌟 커스텀 폴더 규칙 관리 스크립트
// 🌟 커스텀 폴더 + 기본 분류 통합 라우팅 스크립트
// 🌟 커스텀 폴더 규칙 관리 스크립트
// 🌟 커스텀 폴더 + 기본 분류 통합 라우팅 스크립트
let customRules = [];

function escapeRouteHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function parseRouteTags(value) {
    return String(value || '')
        .split(/[,\n]+/)
        .map(t => t.trim().toLowerCase())
        .filter(Boolean);
}

function normalizeRouteRule(rule) {
    if (!rule || typeof rule !== 'object') {
        return null;
    }

    if (rule.type === 'default') {
        return {
            type: 'default',
            folder: rule.folder || 'Solo / Duo / Group'
        };
    }

    const folder = String(rule.folder || '').trim();

    const tags = Array.isArray(rule.tags)
        ? rule.tags.map(t => String(t || '').trim().toLowerCase()).filter(Boolean)
        : parseRouteTags(rule.tags || '');

    const condition = rule.condition === 'all' ? 'all' : 'any';
    const matchCount = Math.max(1, parseInt(rule.match_count || 1, 10) || 1);

    const children = Array.isArray(rule.children)
        ? rule.children.map(normalizeRouteRule).filter(Boolean).filter(r => r.type !== 'default')
        : [];

    if (!folder || !tags.length) {
        return null;
    }

    return {
        type: 'custom',
        folder,
        tags,
        condition,
        match_count: matchCount,
        children
    };
}

function normalizeRouteRuleList(rules) {
    const normalized = (Array.isArray(rules) ? rules : [])
        .map(normalizeRouteRule)
        .filter(Boolean);

    if (!normalized.find(r => r.type === 'default')) {
        normalized.push({
            type: 'default',
            folder: 'Solo / Duo / Group'
        });
    }

    return normalized;
}

function getRouteRuleContainer(path) {
    let container = customRules;

    for (let i = 0; i < path.length - 1; i++) {
        const rule = container[path[i]];
        if (!rule || rule.type === 'default') {
            return null;
        }

        if (!Array.isArray(rule.children)) {
            rule.children = [];
        }

        container = rule.children;
    }

    return container;
}

function getRouteRuleByPath(path) {
    const container = getRouteRuleContainer(path);
    if (!container) return null;
    return container[path[path.length - 1]] || null;
}

function openFolderMgr() {
    document.getElementById('folderLayer').style.display = 'flex';
    fetch('/api/custom_rules')
        .then(res => res.json())
        .then(data => {
            customRules = normalizeRouteRuleList(data.rules || []);
            renderFolderMgrTable();
        });
}

function closeFolderMgr() {
    document.getElementById('folderLayer').style.display = 'none';
}

// 조건 선택 변경 시 개수 입력창 활성/비활성 처리
function toggleMatchCount() {
    const cond = document.getElementById('ruleCondition').value;
    const wrap = document.getElementById('matchCountWrapper');
    const input = document.getElementById('ruleMatchCount');

    if (cond === 'all') {
        wrap.style.opacity = '0.3';
        input.disabled = true;
    } else {
        wrap.style.opacity = '1';
        input.disabled = false;
    }
}

let activeRouteTagEditPath = null;

function openRouteRuleTagsExpanded(path) {
    activeRouteTagEditPath = Array.isArray(path) ? path : null;

    const rule = activeRouteTagEditPath ? getRouteRuleByPath(activeRouteTagEditPath) : null;
    if (!rule || rule.type === 'default') return;

    const layer = document.getElementById('ruleTagsExpandedLayer');
    const textarea = document.getElementById('ruleTagsExpandedText');

    if (!layer || !textarea) return;

    textarea.value = Array.isArray(rule.tags) ? rule.tags.join('\n') : '';
    layer.style.display = 'flex';
}

function applyRouteRuleTagsExpanded() {
    const raw = document.getElementById('ruleTagsExpandedText')?.value || '';
    const tags = parseRouteTags(raw);

    if (activeRouteTagEditPath) {
        const rule = getRouteRuleByPath(activeRouteTagEditPath);
        if (rule && rule.type !== 'default') {
            rule.tags = tags;
            activeRouteTagEditPath = null;
            closeTagsExpanded();
            renderFolderMgrTable();
            return;
        }
    }

    const cleaned = tags.join(', ');
    document.getElementById('ruleTags').value = cleaned;
    closeTagsExpanded();
}

function openTagsExpanded() {
    document.getElementById('ruleTagsExpandedLayer').style.display = 'flex';
    document.getElementById('ruleTagsExpandedText').value = document.getElementById('ruleTags').value.replace(/, /g, '\n');
}

function closeTagsExpanded() {
    document.getElementById('ruleTagsExpandedLayer').style.display = 'none';
}

function applyTagsExpanded() {
    applyRouteRuleTagsExpanded();
}

function renderFolderMgrTable() {
    const container = document.getElementById('folderMgrTableContainer');

    let html = `<table style="width:100%; text-align:left; border-collapse:collapse;">
        <thead>
            <tr style="border-bottom:2px solid #3b3b4f; color:#888; font-size:13px;">
                <th style="padding:12px 10px; width:230px;">이동할 폴더명</th>
                <th style="padding:12px 10px;">감지 프롬프트 / 태그</th>
                <th style="padding:12px 10px; width:160px;">일치 조건</th>
                <th style="padding:12px 10px; text-align:center; width:230px;">우선순위 / 관리</th>
            </tr>
        </thead>
        <tbody>`;

    html += renderFolderRuleRows(customRules, [], 0);
    html += `</tbody></table>`;

    container.innerHTML = html;
}

function renderRouteTagEditor(pathJson, tagsText, depth = 0) {
    return `
        <div style="
            display:flex;
            align-items:stretch;
            background:#222230;
            border:1px solid #3b3b4f;
            border-radius:8px;
            overflow:hidden;
            min-height:40px;
        ">
            <input type="text"
                   value="${escapeRouteHtml(tagsText)}"
                   placeholder="감지할 프롬프트/태그 입력..."
                   onchange='updateRouteRuleTags(${pathJson}, this.value)'
                   style="
                       flex:1;
                       min-width:0;
                       padding:10px 12px;
                       background:none;
                       border:none;
                       color:#fff;
                       outline:none;
                       font-family:'Malgun Gothic';
                       font-size:${depth ? '12px' : '13px'};
                   ">
            <button type="button"
                    onclick='openRouteRuleTagsExpanded(${pathJson})'
                    style="
                        background:#3b3b4f;
                        color:#fff;
                        border:none;
                        border-left:1px solid #2a2a35;
                        padding:0 12px;
                        cursor:pointer;
                        font-weight:bold;
                        white-space:nowrap;
                        font-size:12px;
                    ">
                ⤢ 크게
            </button>
        </div>
    `;
}

function renderFolderRuleRows(rules, parentPath, depth) {
    let html = '';

    rules.forEach((rule, index) => {
        const path = [...parentPath, index];
        const pathJson = JSON.stringify(path);
        const container = getRouteRuleContainer(path) || rules;
        const isFirst = index === 0;
        const isLast = index === container.length - 1;
        const indent = depth * 26;

        let upBtn = `<button onclick='moveRule(${pathJson}, -1)' style="background:#3b3b4f; color:#fff; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; margin-right:4px;">▲</button>`;
        let downBtn = `<button onclick='moveRule(${pathJson}, 1)' style="background:#3b3b4f; color:#fff; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; margin-right:6px;">▼</button>`;

        if (isFirst) upBtn = `<span style="display:inline-block; width:32px; margin-right:4px;"></span>`;
        if (isLast) downBtn = `<span style="display:inline-block; width:32px; margin-right:6px;"></span>`;

        if (rule.type === 'default') {
            html += `<tr style="border-bottom:1px solid #2a2a35; background: rgba(0, 184, 148, 0.05);">
                <td style="padding:15px 10px; color:#00b894; font-weight:bold; font-size:15px;">📁 기본 분류 (Solo / Duo / Group)</td>
                <td style="padding:15px 10px; color:#666; font-size:13px;">위 규칙에 매칭되지 않으면 인원 수 기준으로 분리합니다.</td>
                <td style="padding:15px 10px; font-size:13px; color:#00b894; font-weight:bold;">종결</td>
                <td style="padding:15px 10px; text-align:center;">
                    ${upBtn}${downBtn}
                    <button disabled style="background:#222; color:#555; border:1px solid #333; padding:6px 12px; border-radius:6px; font-size:12px; font-weight:bold;">기본값</button>
                </td>
            </tr>`;
            return;
        }

        const tagsText = Array.isArray(rule.tags) ? rule.tags.join(', ') : '';
        const condition = rule.condition === 'all' ? 'all' : 'any';
        const matchCount = Math.max(1, parseInt(rule.match_count || 1, 10) || 1);
        const childCount = Array.isArray(rule.children) ? rule.children.length : 0;

        html += `<tr style="border-bottom:1px solid #2a2a35; background:${depth ? '#151522' : '#1a1a24'};">
            <td style="padding:10px;">
                <div style="padding-left:${indent}px; display:flex; align-items:center; gap:6px;">
                    <span style="color:${depth ? '#74b9ff' : '#a29bfe'}; font-weight:bold;">${depth ? '↳' : '📁'}</span>
                    <input value="${escapeRouteHtml(rule.folder)}"
                           onchange='updateRouteRuleField(${pathJson}, "folder", this.value)'
                           style="width:100%; background:#222230; border:1px solid #3b3b4f; color:#fff; padding:8px; border-radius:6px; font-weight:bold;">
                </div>
            </td>
            <td style="padding:10px;">
                ${renderRouteTagEditor(pathJson, tagsText, depth)}
                ${childCount ? `<div style="margin-top:6px; color:#74b9ff; font-size:11px; font-weight:bold;">하위 규칙 ${childCount}개</div>` : ''}
            </td>
            <td style="padding:10px;">
                <select onchange='updateRouteRuleField(${pathJson}, "condition", this.value)'
                        style="width:100%; background:#222230; border:1px solid #3b3b4f; color:#fff; padding:7px; border-radius:6px; margin-bottom:6px;">
                    <option value="any" ${condition === 'any' ? 'selected' : ''}>지정 개수 이상</option>
                    <option value="all" ${condition === 'all' ? 'selected' : ''}>전체 일치</option>
                </select>
                <input type="number"
                       min="1"
                       value="${matchCount}"
                       onchange='updateRouteRuleField(${pathJson}, "match_count", this.value)'
                       ${condition === 'all' ? 'disabled' : ''}
                       style="width:100%; background:#222230; border:1px solid #3b3b4f; color:#00f2ff; padding:7px; border-radius:6px; text-align:center; font-weight:bold;">
            </td>
            <td style="padding:10px; text-align:center;">
                <div style="display:flex; flex-wrap:wrap; gap:5px; justify-content:center;">
                    ${upBtn}${downBtn}
                    <button onclick='addChildFolderRule(${pathJson})'
                            style="background:#0984e3; color:#fff; border:none; padding:6px 9px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:bold;">+하위</button>
                    <button onclick='deleteFolderRule(${pathJson})'
                            style="background:#d63031; color:#fff; border:none; padding:6px 9px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:bold;">삭제</button>
                </div>
            </td>
        </tr>`;

        if (Array.isArray(rule.children) && rule.children.length) {
            html += renderFolderRuleRows(rule.children, path, depth + 1);
        }
    });

    return html;
}

function updateRouteRuleField(path, field, value) {
    const rule = getRouteRuleByPath(path);
    if (!rule || rule.type === 'default') return;

    if (field === 'match_count') {
        rule.match_count = Math.max(1, parseInt(value || 1, 10) || 1);
    } else if (field === 'condition') {
        rule.condition = value === 'all' ? 'all' : 'any';
        renderFolderMgrTable();
    } else if (field === 'folder') {
        rule.folder = String(value || '').trim();
    }
}

function updateRouteRuleTags(path, value) {
    const rule = getRouteRuleByPath(path);
    if (!rule || rule.type === 'default') return;

    rule.tags = parseRouteTags(value);
}

function moveRule(path, dir) {
    const container = getRouteRuleContainer(path);
    if (!container) return;

    const index = path[path.length - 1];
    const next = index + dir;

    if (next < 0 || next >= container.length) return;

    const temp = container[index];
    container[index] = container[next];
    container[next] = temp;

    renderFolderMgrTable();
}

function addFolderRule() {
    const folderInput = document.getElementById('ruleFolderName');
    const tagsInput = document.getElementById('ruleTags');
    const condInput = document.getElementById('ruleCondition');
    const countInput = document.getElementById('ruleMatchCount');

    const folder = folderInput.value.trim();
    const tags = parseRouteTags(tagsInput.value);
    const condition = condInput.value === 'all' ? 'all' : 'any';
    const matchCount = Math.max(1, parseInt(countInput.value || 1, 10) || 1);

    if (!folder || !tags.length) {
        return alert("이동할 폴더 이름과 태그를 모두 입력해주세요!");
    }

    const newRule = {
        type: 'custom',
        folder,
        tags,
        condition,
        match_count: matchCount,
        children: []
    };

    const defaultIndex = customRules.findIndex(r => r.type === 'default');

    if (defaultIndex > -1) customRules.splice(defaultIndex, 0, newRule);
    else customRules.push(newRule);

    folderInput.value = '';
    tagsInput.value = '';
    countInput.value = '1';
    condInput.value = 'any';
    toggleMatchCount();
    renderFolderMgrTable();
}

function addChildFolderRule(parentPath) {
    const parentRule = getRouteRuleByPath(parentPath);
    if (!parentRule || parentRule.type === 'default') return;

    if (!Array.isArray(parentRule.children)) {
        parentRule.children = [];
    }

    parentRule.children.push({
        type: 'custom',
        folder: '새 하위 폴더',
        tags: [],
        condition: 'any',
        match_count: 1,
        children: []
    });

    renderFolderMgrTable();

    setTimeout(() => {
        const rows = document.querySelectorAll('#folderMgrTableContainer input');
        const lastInput = rows[rows.length - 1];
        if (lastInput) {
            lastInput.focus();
            lastInput.select();
        }
    }, 0);
}

function deleteFolderRule(path) {
    const container = getRouteRuleContainer(path);
    if (!container) return;

    const index = path[path.length - 1];
    const rule = container[index];

    if (!rule || rule.type === 'default') return;

    const childCount = Array.isArray(rule.children) ? rule.children.length : 0;
    const ok = childCount
        ? confirm(`'${rule.folder}' 규칙과 하위 규칙 ${childCount}개를 삭제할까요?`)
        : confirm(`'${rule.folder}' 규칙을 삭제할까요?`);

    if (!ok) return;

    container.splice(index, 1);
    renderFolderMgrTable();
}

function showFolderRuleNotice(title, message, type = 'success', onClose = null) {
    const old = document.getElementById('folderRuleNoticeLayer');
    if (old) old.remove();

    const color = type === 'error' ? '#ff6b6b' : '#0984e3';
    const icon = type === 'error' ? '⚠️' : '✅';

    const layer = document.createElement('div');
    layer.id = 'folderRuleNoticeLayer';
    layer.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 9000;
        background: rgba(0,0,0,0.72);
        display: flex;
        align-items: center;
        justify-content: center;
    `;

    layer.innerHTML = `
        <div style="
            width: 420px;
            max-width: calc(100vw - 40px);
            background: #1a1a24;
            border: 1px solid ${color};
            border-radius: 16px;
            box-shadow: 0 18px 60px rgba(0,0,0,0.75), 0 0 24px ${color}33;
            overflow: hidden;
        ">
            <div style="
                padding: 18px 22px;
                background: #121218;
                border-bottom: 1px solid #2a2a35;
                display: flex;
                align-items: center;
                gap: 10px;
            ">
                <span style="font-size:22px;">${icon}</span>
                <div style="font-size:17px; font-weight:900; color:${color};">${escapeRouteHtml(title)}</div>
            </div>

            <div style="
                padding: 22px;
                color: #ddd;
                font-size: 14px;
                line-height: 1.7;
                white-space: pre-line;
            ">${escapeRouteHtml(message)}</div>

            <div style="
                padding: 14px 22px 20px;
                display: flex;
                justify-content: flex-end;
                background: #161625;
            ">
                <button id="folderRuleNoticeOkBtn"
                        style="
                            background:${color};
                            color:#fff;
                            border:none;
                            padding:10px 24px;
                            border-radius:999px;
                            font-weight:900;
                            cursor:pointer;
                            box-shadow:0 6px 18px ${color}55;
                        ">
                    확인
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(layer);

    const close = () => {
        layer.remove();
        if (typeof onClose === 'function') onClose();
    };

    layer.querySelector('#folderRuleNoticeOkBtn').onclick = close;
}

function findInvalidRouteRules(rules, pathLabel = '') {
    const invalid = [];

    (Array.isArray(rules) ? rules : []).forEach((rule, index) => {
        if (!rule || rule.type === 'default') return;

        const label = pathLabel
            ? `${pathLabel} > ${rule.folder || '(폴더명 없음)'}`
            : `${rule.folder || '(폴더명 없음)'}`;

        if (!String(rule.folder || '').trim()) {
            invalid.push(`${label}: 폴더명이 비어 있습니다.`);
        }

        if (!Array.isArray(rule.tags) || !rule.tags.filter(Boolean).length) {
            invalid.push(`${label}: 감지 프롬프트 / 태그가 비어 있습니다.`);
        }

        if (Array.isArray(rule.children) && rule.children.length) {
            invalid.push(...findInvalidRouteRules(rule.children, label));
        }
    });

    return invalid;
}

async function saveFolderRules() {
    try {
        const invalidMessages = findInvalidRouteRules(customRules);

        if (invalidMessages.length) {
            showFolderRuleNotice(
                '저장할 수 없습니다',
                invalidMessages.slice(0, 8).join('\n') +
                    (invalidMessages.length > 8 ? `\n외 ${invalidMessages.length - 8}건` : ''),
                'error'
            );
            return;
        }

        customRules = normalizeRouteRuleList(customRules);

        const res = await fetch('/api/save_custom_rules', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ rules: customRules })
        });

        const data = await res.json();

        if (data.status === 'success') {
            showFolderRuleNotice(
                '저장 완료',
                '폴더 우선순위 및 정밀 라우팅 규칙이 저장되었습니다.\n기존 규칙 구조는 유지되고, 하위 규칙은 children 안에 저장됩니다.',
                'success',
                closeFolderMgr
            );
        } else {
            showFolderRuleNotice(
                '저장 실패',
                data.message || '서버에서 저장 실패 응답을 받았습니다.',
                'error'
            );
        }
    } catch (e) {
        showFolderRuleNotice(
            '서버 오류',
            e.message || '규칙 저장 중 서버 오류가 발생했습니다.',
            'error'
        );
    }
}

function setGalleryInpaintProcessing(isLoading, message = '인페인팅 처리 중...') {
    isGalleryInpaintProcessing = Boolean(isLoading);
    galleryInpaintLoadingMessage = message || '인페인팅 처리 중...';

    const layer = document.getElementById('galleryInpaintLoading');
    const text = document.getElementById('galleryInpaintLoadingText');

    if (text) {
        text.innerText = galleryInpaintLoadingMessage;
    }

    if (layer) {
        layer.classList.toggle('show', isGalleryInpaintProcessing);
    }

    const toolbarButtons = document.querySelectorAll('#galleryInpaintLayer .gallery-inpaint-tool-btn');
    toolbarButtons.forEach((btn) => {
        btn.disabled = isGalleryInpaintProcessing;
    });
}


/* ==========================================================
   갤러리 업스케일
   - 우클릭 메뉴에 업스케일 버튼 추가
   - 목표 해상도 기반 업스케일
   - 서버 백그라운드 작업 큐 진행상황 표시
========================================================== */

window.addEventListener('load', () => {
    ensureGalleryUpscaleContextButton();
    pollGalleryUpscaleJobsOnce();
});

function ensureGalleryUpscaleContextButton() {
    const menu = document.getElementById('imageContextMenu');
    if (!menu || menu.dataset.upscaleButtonReady === '1') return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'image-context-item';
    button.innerText = '업스케일';
    button.onclick = openGalleryUpscaleFromContext;

    const inpaintButton = [...menu.querySelectorAll('button')]
        .find(btn => String(btn.getAttribute('onclick') || '').includes('openGalleryInpaintFromContext'));

    if (inpaintButton && inpaintButton.parentNode === menu) {
        inpaintButton.insertAdjacentElement('afterend', button);
    } else {
        menu.appendChild(button);
    }

    menu.dataset.upscaleButtonReady = '1';
}

function getSelectedGalleryUpscaleQuality() {
    return document.querySelector('input[name="galleryUpscaleQuality"]:checked')?.value || 'standard';
}

function getGalleryUpscaleInputSize() {
    const width = Math.max(64, Math.min(20000, parseInt(document.getElementById('galleryUpscaleWidthInput')?.value, 10) || 2500));
    const height = Math.max(64, Math.min(20000, parseInt(document.getElementById('galleryUpscaleHeightInput')?.value, 10) || 8000));

    return { width, height };
}

function applyGalleryUpscalePreset(width, height) {
    const widthInput = document.getElementById('galleryUpscaleWidthInput');
    const heightInput = document.getElementById('galleryUpscaleHeightInput');

    if (widthInput) widthInput.value = width;
    if (heightInput) heightInput.value = height;

    galleryUpscaleLastEditedAxis = 'width';
    updateGalleryUpscaleRatioInfo();
}

function handleGalleryUpscaleWidthInput() {
    galleryUpscaleLastEditedAxis = 'width';

    if (document.getElementById('galleryUpscaleRatioLock')?.checked && galleryUpscaleSession?.imageWidth && galleryUpscaleSession?.imageHeight) {
        const width = parseInt(document.getElementById('galleryUpscaleWidthInput')?.value, 10) || 2500;
        const ratio = galleryUpscaleSession.imageHeight / Math.max(1, galleryUpscaleSession.imageWidth);
        document.getElementById('galleryUpscaleHeightInput').value = Math.round(width * ratio);
    }

    updateGalleryUpscaleRatioInfo();
}

function handleGalleryUpscaleHeightInput() {
    galleryUpscaleLastEditedAxis = 'height';

    if (document.getElementById('galleryUpscaleRatioLock')?.checked && galleryUpscaleSession?.imageWidth && galleryUpscaleSession?.imageHeight) {
        const height = parseInt(document.getElementById('galleryUpscaleHeightInput')?.value, 10) || 8000;
        const ratio = galleryUpscaleSession.imageWidth / Math.max(1, galleryUpscaleSession.imageHeight);
        document.getElementById('galleryUpscaleWidthInput').value = Math.round(height * ratio);
    }

    updateGalleryUpscaleRatioInfo();
}

function updateGalleryUpscaleRatioInfo() {
    const info = document.getElementById('galleryUpscaleRatioInfo');
    if (!info) return;

    const size = getGalleryUpscaleInputSize();
    const mp = (size.width * size.height / 1000000).toFixed(1);

    if (!galleryUpscaleSession?.imageWidth || !galleryUpscaleSession?.imageHeight) {
        info.innerText = `목표 해상도 ${size.width} × ${size.height}px · 약 ${mp}MP`;
        return;
    }

    const sx = size.width / Math.max(1, galleryUpscaleSession.imageWidth);
    const sy = size.height / Math.max(1, galleryUpscaleSession.imageHeight);

    info.innerText = `목표 해상도 ${size.width} × ${size.height}px · 약 ${mp}MP · 원본 대비 ${sx.toFixed(2)}x / ${sy.toFixed(2)}x`;
}

async function openGalleryUpscaleFromContext() {
    closeImageContextMenu();

    if (!activeImageContext || !activeImageContext.imgSrc || !activeImageContext.path) {
        alert('업스케일할 이미지 경로가 없습니다.');
        return;
    }

    try {
        const img = await loadImageElement(activeImageContext.imgSrc);

        galleryUpscaleSession = {
            originalPath: activeImageContext.path || '',
            originalSrc: activeImageContext.imgSrc || '',
            name: getImageFileName(activeImageContext.path || activeImageContext.imgSrc),
            imageWidth: img.naturalWidth || img.width || 0,
            imageHeight: img.naturalHeight || img.height || 0
        };

        const meta = document.getElementById('galleryUpscaleMeta');
        if (meta) {
            meta.innerText = `${galleryUpscaleSession.name} · 원본 ${galleryUpscaleSession.imageWidth} × ${galleryUpscaleSession.imageHeight}px`;
        }

        applyGalleryUpscalePreset(2500, 8000);

        const layer = document.getElementById('galleryUpscaleLayer');
        if (layer) layer.style.display = 'flex';

    } catch (error) {
        alert(`업스케일 창 열기 실패: ${error.message || error}`);
    }
}

function closeGalleryUpscaleModal() {
    const layer = document.getElementById('galleryUpscaleLayer');
    if (layer) layer.style.display = 'none';
}

async function startGalleryUpscale() {
    if (!galleryUpscaleSession?.originalPath) {
        alert('업스케일할 이미지가 없습니다.');
        return;
    }

    const size = getGalleryUpscaleInputSize();
    const engine = document.getElementById('galleryUpscaleEngine')?.value || 'realcugan';
    const quality = getSelectedGalleryUpscaleQuality();

    if (size.width * size.height > 130000000) {
        alert('목표 해상도가 너무 큽니다. 130MP 이하로 설정해 주세요.');
        return;
    }

    try {
        const response = await fetch('/api/gallery/upscale/start', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                source_path: galleryUpscaleSession.originalPath,
                target_width: size.width,
                target_height: size.height,
                engine,
                quality
            })
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'started') {
            throw new Error(data.message || '업스케일 작업 시작 실패');
        }

        showToast('업스케일 작업을 시작했습니다. 다른 작업을 계속할 수 있습니다.');
        closeGalleryUpscaleModal();
        showGalleryUpscaleJobsPanel();
        startGalleryUpscalePolling();

    } catch (error) {
        alert(`업스케일 시작 실패: ${error.message || error}`);
    }
}

function showGalleryUpscaleJobsPanel() {
    const panel = document.getElementById('galleryUpscaleJobPanel');
    if (panel) panel.classList.add('show');
}

function hideGalleryUpscaleJobsPanel() {
    const panel = document.getElementById('galleryUpscaleJobPanel');
    if (panel) panel.classList.remove('show');
}

function startGalleryUpscalePolling() {
    if (galleryUpscalePollTimer) return;

    pollGalleryUpscaleJobsOnce();

    galleryUpscalePollTimer = setInterval(() => {
        pollGalleryUpscaleJobsOnce();
    }, 1600);
}

function isGalleryUpscaleActiveJob(job) {
    return job && ['queued', 'running'].includes(job.status);
}

function isGalleryUpscaleTerminalJob(job) {
    return job && ['done', 'error', 'cancelled'].includes(job.status);
}

function stopGalleryUpscalePollingIfIdle(jobs) {
    const hasActive = jobs.some(job => ['queued', 'running'].includes(job.status));

    if (!hasActive && galleryUpscalePollTimer) {
        clearInterval(galleryUpscalePollTimer);
        galleryUpscalePollTimer = null;
    }
}

async function pollGalleryUpscaleJobsOnce() {
    try {
        const response = await fetch('/api/gallery/upscale/jobs');
        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '업스케일 작업 목록을 읽지 못했습니다.');
        }

        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        const hasActiveJobs = jobs.some(isGalleryUpscaleActiveJob);
        const isFirstPoll = !galleryUpscalePollingInitialized;

        // 갤러리에 다시 들어왔을 때 이미 끝나 있던 작업은
        // 새 완료 알림/자동 갱신/패널 자동 표시 대상으로 보지 않는다.
        if (isFirstPoll) {
            jobs.forEach((job) => {
                if (job.status === 'done') {
                    galleryUpscaleKnownDoneJobs.add(job.id);
                }

                if (isGalleryUpscaleTerminalJob(job)) {
                    galleryUpscaleKnownTerminalJobs.add(job.id);
                }
            });

            galleryUpscalePollingInitialized = true;
        }

        renderGalleryUpscaleJobs(jobs);

        if (!isFirstPoll) {
            for (const job of jobs) {
                const isDone = job.status === 'done';
                const isTerminal = isGalleryUpscaleTerminalJob(job);

                if (isDone && !galleryUpscaleKnownDoneJobs.has(job.id)) {
                    galleryUpscaleKnownDoneJobs.add(job.id);
                    showToast('업스케일이 완료되었습니다.');
                    await loadData();
                }

                if (isTerminal) {
                    galleryUpscaleKnownTerminalJobs.add(job.id);
                }
            }
        }

        // 자동으로 패널을 여는 건 진행 중인 작업이 있을 때만.
        // 완료/실패/취소만 남아 있으면 갤러리 재진입 시 패널을 띄우지 않는다.
        if (hasActiveJobs) {
            showGalleryUpscaleJobsPanel();
            startGalleryUpscalePolling();
        }

        stopGalleryUpscalePollingIfIdle(jobs);

    } catch (error) {
        console.warn('Upscale job polling failed:', error);
    }
}


function renderGalleryUpscaleJobs(jobs) {
    const list = document.getElementById('galleryUpscaleJobList');
    if (!list) return;

    if (!jobs.length) {
        list.innerHTML = '<div class="gallery-upscale-job-empty">업스케일 작업이 없습니다.</div>';
        return;
    }

    const activeJobs = jobs.filter(isGalleryUpscaleActiveJob);
    const freshTerminalJobs = jobs.filter((job) => {
        return isGalleryUpscaleTerminalJob(job) && !galleryUpscaleKnownTerminalJobs.has(job.id);
    });

    const visibleJobs = [...activeJobs, ...freshTerminalJobs].slice(0, 8);

    if (!visibleJobs.length) {
        list.innerHTML = '<div class="gallery-upscale-job-empty">진행 중인 업스케일 작업이 없습니다.</div>';
        return;
    }

    list.innerHTML = visibleJobs.map((job) => {
        const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
        const statusLabel = getGalleryUpscaleStatusLabel(job.status);
        const canCancel = ['queued', 'running'].includes(job.status);

        return `
            <div class="gallery-upscale-job-item">
                <div class="gallery-upscale-job-title">
                    <span>${escapeHtml(job.source_name || getImageFileName(job.source_path || 'image.png'))}</span>
                    <strong>${escapeHtml(statusLabel)}</strong>
                </div>

                <div class="gallery-upscale-job-meta">
                    ${escapeHtml(String(job.target_width || '?'))} × ${escapeHtml(String(job.target_height || '?'))}
                    · ${escapeHtml(getGalleryUpscaleQualityLabel(job.quality))}
                </div>

                <div class="gallery-upscale-progress">
                    <div class="gallery-upscale-progress-bar" style="width:${progress}%"></div>
                </div>

                <div class="gallery-upscale-job-message">
                    ${escapeHtml(job.error || job.message || '')}
                </div>

                <div class="gallery-upscale-job-actions">
                    ${
                        job.result_src
                            ? `<button onclick="openZoom('${escapeHtml(job.result_src)}')">보기</button>`
                            : ''
                    }
                    ${
                        canCancel
                            ? `<button onclick="cancelGalleryUpscaleJob('${escapeHtml(job.id)}')">취소</button>`
                            : ''
                    }
                </div>
            </div>
        `;
    }).join('');
}

function getGalleryUpscaleStatusLabel(status) {
    if (status === 'queued') return '대기';
    if (status === 'running') return '처리 중';
    if (status === 'done') return '완료';
    if (status === 'error') return '실패';
    if (status === 'cancelled') return '취소됨';
    return status || '';
}

function getGalleryUpscaleQualityLabel(quality) {
    if (quality === 'fast') return '빠른 처리';
    if (quality === 'high') return '최종본 고품질';
    return '균형 처리';
}

async function cancelGalleryUpscaleJob(jobId) {
    try {
        const response = await fetch(`/api/gallery/upscale/cancel/${encodeURIComponent(jobId)}`, {
            method: 'POST'
        });

        const data = await response.json();

        if (!response.ok || data.status !== 'success') {
            throw new Error(data.message || '취소 실패');
        }

        showToast('업스케일 취소를 요청했습니다.');
        await pollGalleryUpscaleJobsOnce();

    } catch (error) {
        alert(`업스케일 취소 실패: ${error.message || error}`);
    }
}
