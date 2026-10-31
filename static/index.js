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
let galleryCatalogLoader = null;
let galleryDataRequestGeneration = 0;
let currentPath = [];
let baseDir = "";
let selDeletes = new Map();
let selThumbs = new Map();
let searchText = '';
let dakiFilter = 'all';
let modelFamily = 'all';
let currentSelectedGalleryArtStyle = 'ALL';
let galleryTagDefs = [];
let galleryImageTags = {};
let galleryViewMode = 'character';
let galleryDateGrouping = 'month';
let galleryVirtualGrouping = 'character';
let galleryVirtualUncategorized = 'only';
let galleryVirtualFolders = [];
let galleryVirtualFolderMap = new Map();
let galleryVirtualRootNode = null;
let galleryVirtualLoading = false;
let galleryVirtualManagerOpen = false;
let galleryVirtualFolderEditingId = '';
const galleryVirtualFolderAutocompleteState = {
    create: {timer: null, items: [], activeIndex: -1, version: 0},
    editor: {timer: null, items: [], activeIndex: -1, version: 0}
};
let currentGalleryTagFilter = 'ALL';
let isGalleryTagAssignmentMode = false;
let selectedGalleryAssignmentTagId = '';
let galleryTagAssignmentBusy = false;
let pendingGalleryTagImageDataUrl = '';
let galleryRadialTagGesture = null;
let galleryRadialTagSuppressClickElement = null;
let galleryRadialTagSuppressClickUntil = 0;
const GALLERY_RADIAL_TAG_LONG_PRESS_MS = 250;
const GALLERY_RADIAL_TAG_MOVE_THRESHOLD = 10;
const GALLERY_RADIAL_TAG_DEAD_ZONE = 28;
let galleryImageFilterMeta = {};
let galleryImageFilterMetaLoading = false;
let galleryImageFilterMetaRequestKey = '';
let galleryPromptFilterMetaLoading = false;
let galleryPromptFilterMetaRequestKey = '';
let galleryPromptFilterMetaLoadSeq = 0;
const GALLERY_PROMPT_META_CHUNK_SIZE = 120;
let galleryPromptSearchOpen = false;
let galleryPromptSearchText = '';
let galleryPromptSearchActive = false;
let galleryPromptSearchRun = null;
let galleryPromptAutocompleteTimer = null;
let galleryPromptIndexStatusTimer = null;
let galleryPromptIndexStatusSnapshot = null;
let galleryPromptAutocompleteItems = [];
let galleryPromptAutocompleteActiveIndex = -1;
let galleryPromptSearchResult = {
    imagePaths: new Set(),
    folderCounts: new Map(),
    totalMatches: 0,
    indexed: false
};
let galleryImageOrder = 'newest';
let galleryFolderSort = 'name';
let galleryImageRenderSessions = new Set();
let galleryVirtualSummaryObservers = new Set();
let galleryVirtualRenderGeneration = 0;
const topBtn = document.getElementById('topBtn');
const galleryScrollNavigation = document.getElementById('galleryScrollNavigation');
const galleryScrollbarDestinationGuide = document.getElementById('galleryScrollbarDestinationGuide');
let galleryScrollNavigationFrame = 0;
let galleryScrollNavigationResizeObserver = null;
let galleryScrollNavigationInitialized = false;
let galleryScrollNavigationHoveredIndex = null;
let galleryScrollNavigationFocusedIndex = null;
let galleryScrollbarDragState = null;
const GALLERY_SCROLL_NAV_MIN_SCROLL = 480;
const GALLERY_SCROLL_NAV_MIN_SCROLL_RATIO = 0.75;
const GALLERY_SCROLL_NAV_MIN_DOTS = 7;
const GALLERY_SCROLL_NAV_MAX_DOTS = 12;
const GALLERY_SCROLLBAR_MIN_THUMB = 44;
const GALLERY_SCROLLBAR_TRACK_INSET = 8;

let globalBrandMap = {};
let globalBrandVisibility = {}; // 🌟 노출 스위치 변수 추가
let currentSelectedBrand = 'ALL';
let currentSelectedChar = 'ALL';
let windowBrandsData = {};
let activeImageContext = null;
let galleryInpaintLastPointerEvent = null;
let galleryInpaintMaskVisible = true;
let galleryDesignRenderTimer = null;
let isGalleryBulkDeleteMode = false;
let galleryBulkDeleteFolders = new Map();
let galleryBulkDeleteSelectionBoxState = null;
let galleryBulkDeleteSuppressNextClick = false;
let galleryMultiFolderSelection = new Map();
let galleryMultiFolderSelectionBoxState = null;
let galleryMultiFolderSuppressNextClick = false;
let galleryFolderOpenTimer = null;

const GALLERY_INPAINT_TEMP_CATEGORY = 'gallery_inpaint';
const GALLERY_PERSISTENT_UI_KEY = 'naia_gallery_persistent_ui_v1';
const GALLERY_SESSION_STATE_KEY = 'naia_gallery_session_state_v1';
const GALLERY_HEADER_TOOLS_COLLAPSED_KEY = 'naia_gallery_header_tools_collapsed_v1';
const GALLERY_VIEW_MODE_VALUES = new Set(['character', 'date', 'virtual']);
const GALLERY_DATE_GROUPING_VALUES = new Set(['month', 'week', 'day']);
const GALLERY_VIRTUAL_GROUPING_VALUES = new Set(['character', 'combined']);
const GALLERY_VIRTUAL_UNCATEGORIZED_VALUES = new Set(['only', 'include']);
const GALLERY_MODEL_FAMILY_VALUES = new Set(['all', 'v5', 'v4_5', 'other']);

const GALLERY_DESIGN_SETTINGS_KEY = 'naia_gallery_design_settings_v1';
const GALLERY_CHARACTER_NAME_OVERRIDES_KEY = 'naia_gallery_character_name_overrides_v1';

let galleryDesignSettings = {
    imageScalePercent: 100,
    fixedSizeMode: false,
    fixedWidth: 260,
    fixedHeight: 360,
    navTabRows: 1,
    characterFilterRows: 4,
    characterKoreanNames: true,
    multiFolderSelectionEnabled: true,
    radialTagMenuEnabled: true,
    imageRenderBatchSize: 1000
};
let galleryCharacterNameOverrides = {};
let galleryCharacterNameManagerSort = 'count';
let galleryCharacterNameManagerHideSaved = false;

let galleryServerSessionId = '';
let galleryPendingScrollY = null;
let galleryNavTabsDragState = null;
const GALLERY_NAV_TABS_DRAG_THRESHOLD = 5;

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
        modelFamily = GALLERY_MODEL_FAMILY_VALUES.has(data.modelFamily)
            ? data.modelFamily
            : 'all';
        galleryViewMode = GALLERY_VIEW_MODE_VALUES.has(data.galleryViewMode)
            ? data.galleryViewMode
            : 'character';
        galleryDateGrouping = GALLERY_DATE_GROUPING_VALUES.has(data.galleryDateGrouping)
            ? data.galleryDateGrouping
            : 'month';
        galleryVirtualGrouping = GALLERY_VIRTUAL_GROUPING_VALUES.has(data.galleryVirtualGrouping)
            ? data.galleryVirtualGrouping
            : 'character';
        galleryVirtualUncategorized = GALLERY_VIRTUAL_UNCATEGORIZED_VALUES.has(data.galleryVirtualUncategorized)
            ? data.galleryVirtualUncategorized
            : 'only';
        const storedSortMode = ['name', 'count', 'newest', 'oldest'].includes(data.sortMode)
            ? data.sortMode
            : null;
        galleryFolderSort = data.folderSort === 'count' ||
            (data.folderSort !== 'name' && storedSortMode === 'count')
            ? 'count'
            : 'name';
        galleryImageOrder = storedSortMode === 'oldest' || data.galleryImageOrder === 'oldest'
            ? 'oldest'
            : 'newest';
        setGalleryRadioValue('dakiFilter', dakiFilter);
        setGalleryRadioValue('modelFamily', modelFamily);
        setGalleryRadioValue('sortMode', galleryFolderSort);
        setGalleryRadioValue('viewMode', data.viewMode || 'general');

        syncGalleryViewModeControls();
    } catch (error) {
        console.warn('Gallery persistent UI restore failed:', error);
    }
}

function saveGalleryPersistentUi() {
    try {
        localStorage.setItem(GALLERY_PERSISTENT_UI_KEY, JSON.stringify({
            dakiFilter,
            modelFamily: GALLERY_MODEL_FAMILY_VALUES.has(modelFamily) ? modelFamily : 'all',
            // folderSort와 galleryImageOrder를 분리 저장한다. sortMode는
            // 구버전 설정을 위한 legacy mirror로 유지한다.
            folderSort: galleryFolderSort,
            sortMode: galleryFolderSort,
            viewMode: getGalleryRadioValue('viewMode', 'general'),
            galleryViewMode,
            galleryDateGrouping,
            galleryVirtualGrouping,
            galleryVirtualUncategorized,
            galleryImageOrder
        }));
    } catch (error) {
        console.warn('Gallery persistent UI save failed:', error);
    }
}

function clampGalleryNumber(value, fallback, min, max) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return Math.max(min, Math.min(max, number));
}

function normalizeGalleryDesignSettings(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};

    return {
        imageScalePercent: clampGalleryNumber(data.imageScalePercent, 100, 40, 140),
        fixedSizeMode: Boolean(data.fixedSizeMode),
        fixedWidth: clampGalleryNumber(data.fixedWidth, 260, 120, 800),
        fixedHeight: clampGalleryNumber(data.fixedHeight, 360, 120, 1000),
        navTabRows: clampGalleryNumber(data.navTabRows, 1, 1, 3),
        characterFilterRows: clampGalleryNumber(data.characterFilterRows, 4, 1, 8),
        characterKoreanNames: data.characterKoreanNames !== false,
        multiFolderSelectionEnabled: data.multiFolderSelectionEnabled !== false,
        radialTagMenuEnabled: data.radialTagMenuEnabled !== false,
        imageRenderBatchSize: clampGalleryNumber(data.imageRenderBatchSize, 1000, 100, 10000)
    };
}

function getGalleryBaseColumnCount() {
    return window.innerWidth <= 1400 ? 3 : 4;
}

function getGalleryColumnCountForScale(scalePercent) {
    const baseColCount = getGalleryBaseColumnCount();
    const imageScale = clampGalleryNumber(scalePercent, 100, 40, 140) / 100;

    return Math.max(1, Math.min(12, Math.round(baseColCount / imageScale)));
}

function getGalleryEffectiveColumnCount(grid = null) {
    const requested = getGalleryColumnCountForScale(galleryDesignSettings.imageScalePercent);
    if (!grid || !(grid.clientWidth > 0) || typeof window.getComputedStyle !== 'function') return requested;
    const style = window.getComputedStyle(grid);
    const width = grid.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const gap = parseFloat(style.columnGap) || 0;
    // Match the smallest supported fixed card width so controls remain readable.
    return Math.max(1, Math.min(requested, Math.floor((Math.max(0, width) + gap) / (120 + gap))));
}

function getGalleryGridLayout(grid = null) {
    return {columns: getGalleryEffectiveColumnCount(grid), fixed: galleryDesignSettings.fixedSizeMode};
}

function loadGalleryDesignSettings() {
    try {
        const raw = localStorage.getItem(GALLERY_DESIGN_SETTINGS_KEY);
        galleryDesignSettings = normalizeGalleryDesignSettings(raw ? JSON.parse(raw) : {});
    } catch (error) {
        console.warn('Gallery design settings restore failed:', error);
        galleryDesignSettings = normalizeGalleryDesignSettings({});
    }

    applyGalleryDesignSettingsToDocument();
}

function saveGalleryDesignSettings() {
    galleryDesignSettings = normalizeGalleryDesignSettings(galleryDesignSettings);

    try {
        localStorage.setItem(GALLERY_DESIGN_SETTINGS_KEY, JSON.stringify(galleryDesignSettings));
    } catch (error) {
        console.warn('Gallery design settings save failed:', error);
    }
}

function applyGalleryDesignSettingsToDocument() {
    galleryDesignSettings = normalizeGalleryDesignSettings(galleryDesignSettings);
    const characterFilterRows = galleryDesignSettings.characterFilterRows;
    const characterChipRowHeight = 38;
    const characterChipRowGap = 10;
    const characterFilterMaxHeight =
        (characterChipRowHeight * characterFilterRows) +
        (characterChipRowGap * Math.max(0, characterFilterRows - 1));

    document.documentElement.style.setProperty(
        '--gallery-image-scale',
        String(galleryDesignSettings.imageScalePercent / 100)
    );
    document.documentElement.style.setProperty(
        '--gallery-fixed-image-width',
        `${galleryDesignSettings.fixedWidth}px`
    );
    document.documentElement.style.setProperty(
        '--gallery-fixed-image-height',
        `${galleryDesignSettings.fixedHeight}px`
    );
    document.documentElement.style.setProperty(
        '--gallery-nav-tab-rows',
        String(galleryDesignSettings.navTabRows)
    );
    document.documentElement.style.setProperty(
        '--gallery-character-filter-rows',
        String(characterFilterRows)
    );
    document.documentElement.style.setProperty(
        '--gallery-character-filter-max-height',
        `${characterFilterMaxHeight}px`
    );

    document.body.classList.toggle(
        'gallery-nav-tabs-multiline',
        galleryDesignSettings.navTabRows > 1
    );

    syncGalleryDesignSettingsInputs();
    window.Daki?.relayout();
}

function syncGalleryDesignSettingsInputs() {
    const scaleRange = document.getElementById('galleryImageScaleRange');
    const scaleInput = document.getElementById('galleryImageScaleInput');
    const fixedModeInput = document.getElementById('galleryFixedSizeModeInput');
    const fixedWidthInput = document.getElementById('galleryFixedWidthInput');
    const fixedHeightInput = document.getElementById('galleryFixedHeightInput');
    const characterKoreanNamesInput = document.getElementById('galleryCharacterKoreanNamesInput');
    const multiFolderSelectionInput = document.getElementById('galleryMultiFolderSelectionInput');
    const radialTagMenuInput = document.getElementById('galleryRadialTagMenuInput');
    const imageRenderBatchSizeInput = document.getElementById('galleryImageRenderBatchSizeInput');
    const characterFilterRowsRange = document.getElementById('galleryCharacterFilterRowsRange');
    const characterFilterRowsInput = document.getElementById('galleryCharacterFilterRowsInput');

    if (scaleRange) scaleRange.value = galleryDesignSettings.imageScalePercent;
    if (scaleInput) scaleInput.value = galleryDesignSettings.imageScalePercent;
    if (fixedModeInput) fixedModeInput.checked = galleryDesignSettings.fixedSizeMode;
    if (fixedWidthInput) fixedWidthInput.value = galleryDesignSettings.fixedWidth;
    if (fixedHeightInput) fixedHeightInput.value = galleryDesignSettings.fixedHeight;
    if (characterKoreanNamesInput) characterKoreanNamesInput.checked = galleryDesignSettings.characterKoreanNames;
    if (multiFolderSelectionInput) multiFolderSelectionInput.checked = galleryDesignSettings.multiFolderSelectionEnabled;
    if (radialTagMenuInput) radialTagMenuInput.checked = galleryDesignSettings.radialTagMenuEnabled;
    if (imageRenderBatchSizeInput) imageRenderBatchSizeInput.value = galleryDesignSettings.imageRenderBatchSize;
    if (characterFilterRowsRange) characterFilterRowsRange.value = galleryDesignSettings.characterFilterRows;
    if (characterFilterRowsInput) characterFilterRowsInput.value = galleryDesignSettings.characterFilterRows;
    document.querySelectorAll('.gallery-design-nav-row-control button, .gallery-design-header-row-control button').forEach((button) => {
        button.classList.remove('active');
    });

    const navRowsBtn = document.getElementById(`galleryNavTabRows${galleryDesignSettings.navTabRows}Btn`);
    if (navRowsBtn) {
        navRowsBtn.classList.add('active');
    }
}

function openGalleryDesignSettings() {
    const layer = document.getElementById('galleryDesignSettingsLayer');
    if (!layer) return;

    syncGalleryDesignSettingsInputs();
    layer.style.display = 'flex';
    window.Daki?.loadSettings();
    window.NovelAIAccount?.refresh();
}

function closeGalleryDesignSettings() {
    window.NovelAIAccount?.clearDraft();
    const layer = document.getElementById('galleryDesignSettingsLayer');
    if (layer) layer.style.display = 'none';
}

function setGalleryImageScale(value) {
    galleryDesignSettings.imageScalePercent = clampGalleryNumber(value, 100, 40, 140);
    saveGalleryDesignSettings();
    applyGalleryDesignSettingsToDocument();

    if (galleryDesignRenderTimer) {
        clearTimeout(galleryDesignRenderTimer);
    }

    galleryDesignRenderTimer = setTimeout(() => {
        galleryDesignRenderTimer = null;
        renderView();
    }, 80);
}

function setGalleryFixedSizeMode(enabled) {
    galleryDesignSettings.fixedSizeMode = Boolean(enabled);
    saveGalleryDesignSettings();
    applyGalleryDesignSettingsToDocument();
    renderView();
}

function setGalleryCharacterKoreanNames(enabled) {
    galleryDesignSettings.characterKoreanNames = Boolean(enabled);
    saveGalleryDesignSettings();
    applyGalleryDesignSettingsToDocument();
    buildFilterDropdowns(currentPath[currentPath.length - 1]);
    renderView();
}

function setGalleryImageRenderBatchSize(value) {
    galleryDesignSettings.imageRenderBatchSize = clampGalleryNumber(value, 1000, 100, 10000);
    saveGalleryDesignSettings();
    applyGalleryDesignSettingsToDocument();
    renderView();
}

function setGalleryImageOrder(value) {
    galleryImageOrder = value === 'oldest' ? 'oldest' : 'newest';
    saveGalleryPersistentUi();
    renderView();
}

function syncGallerySortControls(context = 'folder') {
    const imageContext = context === 'image';
    const visibleValues = imageContext ? ['newest', 'oldest'] : ['name', 'count'];
    document.querySelectorAll('input[name="sortMode"]').forEach((input) => {
        const label = input.closest('label');
        if (label) label.hidden = !visibleValues.includes(input.value);
    });
    setGalleryRadioValue('sortMode', imageContext ? galleryImageOrder : galleryFolderSort);
}

function onGallerySortChange() {
    const sortMode = getGalleryRadioValue('sortMode', 'name');
    if (sortMode === 'newest' || sortMode === 'oldest') {
        setGalleryImageOrder(sortMode);
        return;
    }

    galleryFolderSort = sortMode === 'count' ? 'count' : 'name';
    saveGalleryPersistentUi();
    loadData();
}

function getGalleryViewMode() {
    return GALLERY_VIEW_MODE_VALUES.has(galleryViewMode) ? galleryViewMode : 'character';
}

function getGalleryDateGrouping() {
    return GALLERY_DATE_GROUPING_VALUES.has(galleryDateGrouping) ? galleryDateGrouping : 'month';
}

function syncGalleryViewModeControls() {
    setGalleryRadioValue('galleryViewMode', getGalleryViewMode());
    setGalleryRadioValue('galleryDateGrouping', getGalleryDateGrouping());
    setGalleryRadioValue('galleryVirtualGrouping', galleryVirtualGrouping);
    setGalleryRadioValue('galleryVirtualUncategorized', galleryVirtualUncategorized);
    const controls = document.getElementById('galleryVirtualControls');
    if (controls) {
        const isVirtual = getGalleryViewMode() === 'virtual';
        controls.classList.toggle('gallery-virtual-controls-is-hidden', !isVirtual);
        controls.hidden = !isVirtual;
        controls.setAttribute('aria-hidden', String(!isVirtual));
        controls.querySelectorAll('input').forEach(input => { input.tabIndex = isVirtual ? 0 : -1; });
    }
}

function onGalleryViewModeChange() {
    const nextMode = getGalleryRadioValue('galleryViewMode', 'character');
    galleryViewMode = GALLERY_VIEW_MODE_VALUES.has(nextMode) ? nextMode : 'character';
    syncGalleryViewModeControls();

    if (getGalleryViewMode() === 'virtual' && getGalleryRadioValue('viewMode', 'general') === 'trash') {
        setGalleryRadioValue('viewMode', 'all');
        saveGalleryPersistentUi();
        loadData();
        return;
    }

    if (!rootTree) {
        saveGalleryPersistentUi();
        return;
    }

    if (getGalleryViewMode() === 'virtual') {
        currentPath = [rootTree];
        searchText = '';
        const searchInput = document.getElementById('folder-search');
        if (searchInput) searchInput.value = '';
        loadGalleryVirtualFolders().then(() => {
            currentPath = [rootTree, galleryVirtualRootNode].filter(Boolean);
            renderView();
            saveGallerySessionState();
        });
        saveGalleryPersistentUi();
        saveGallerySessionState();
        return;
    }

    // 날짜 그룹은 실제 트리에 존재하지 않으므로 모드 전환 시 최상위 카테고리만 유지한다.
    clearGalleryMultiFolderSelection(false);
    const topCategory = currentPath[1] && !currentPath[1].isGalleryVirtualRoot
        ? currentPath[1]
        : getDefaultGalleryPath()[1];
    currentPath = topCategory ? [rootTree, topCategory] : getDefaultGalleryPath();
    searchText = '';
    const searchInput = document.getElementById('folder-search');
    if (searchInput) searchInput.value = '';

    buildFilterDropdowns(currentPath[currentPath.length - 1]);
    renderView();
    saveGalleryPersistentUi();
    saveGallerySessionState();
    window.scrollTo(0, 0);
}

function onGalleryDateGroupingChange() {
    const nextGrouping = getGalleryRadioValue('galleryDateGrouping', 'month');
    galleryDateGrouping = GALLERY_DATE_GROUPING_VALUES.has(nextGrouping) ? nextGrouping : 'month';
    syncGalleryViewModeControls();
    if (!rootTree) {
        saveGalleryPersistentUi();
        return;
    }
    if (getGalleryViewMode() === 'date') {
        const topCategory = currentPath[1] || getDefaultGalleryPath()[1];
        currentPath = topCategory ? [rootTree, topCategory] : getDefaultGalleryPath();
        searchText = '';
        const searchInput = document.getElementById('folder-search');
        if (searchInput) searchInput.value = '';
        renderView();
    }
    saveGalleryPersistentUi();
    saveGallerySessionState();
}

function setGalleryMultiFolderSelectionEnabled(enabled) {
    galleryDesignSettings.multiFolderSelectionEnabled = Boolean(enabled);
    saveGalleryDesignSettings();
    applyGalleryDesignSettingsToDocument();

    if (!galleryDesignSettings.multiFolderSelectionEnabled) {
        clearGalleryMultiFolderSelection();
        closeGalleryMultiFolderContextMenu();
    }
}

function setGalleryRadialTagMenuEnabled(enabled) {
    galleryDesignSettings.radialTagMenuEnabled = Boolean(enabled);
    saveGalleryDesignSettings();
    applyGalleryDesignSettingsToDocument();

    if (!galleryDesignSettings.radialTagMenuEnabled) {
        cancelGalleryRadialTagGesture();
    }
}

function setGalleryCharacterFilterRows(value) {
    galleryDesignSettings.characterFilterRows = clampGalleryNumber(value, 4, 1, 8);
    saveGalleryDesignSettings();
    applyGalleryDesignSettingsToDocument();
}

function setGalleryFixedSizeValue() {
    const widthInput = document.getElementById('galleryFixedWidthInput');
    const heightInput = document.getElementById('galleryFixedHeightInput');

    galleryDesignSettings.fixedWidth = clampGalleryNumber(widthInput?.value, 260, 120, 800);
    galleryDesignSettings.fixedHeight = clampGalleryNumber(heightInput?.value, 360, 120, 1000);

    saveGalleryDesignSettings();
    applyGalleryDesignSettingsToDocument();
}

function setGalleryNavTabRows(rows) {
    galleryDesignSettings.navTabRows = clampGalleryNumber(rows, 1, 1, 3);
    saveGalleryDesignSettings();
    applyGalleryDesignSettingsToDocument();
}

function resetGalleryDesignSettings() {
    galleryDesignSettings = normalizeGalleryDesignSettings({});
    saveGalleryDesignSettings();
    applyGalleryDesignSettingsToDocument();
    renderView();
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
    if (node.isGalleryVirtualRoot) return '__gallery_virtual_root__';
    if (node.isGalleryVirtualFolder || node.isGalleryVirtualUnassigned || node.isGalleryVirtualCharacterGroup) {
        return `__gallery_virtual__/${node.virtualFolderId || node.virtualParentId || node.name || ''}`;
    }
    return String(node.path || node.name || '');
}

function getGalleryWebpLocation() {
    const node = currentPath[currentPath.length - 1];
    const names = currentPath.slice(1).map((item, index) => index === 0
        ? String(item.name || '').replace(/^\d+_/, '')
        : getGalleryFolderKoreanDisplayName(item.name || ''));
    const virtual = getGalleryViewMode() === 'virtual';
    const grouped = isGalleryDateGroupNode(node) || isCombinedGalleryNode(node);
    return {
        kind: virtual ? '가상 폴더' : isGalleryDateGroupNode(node) ? '날짜별 보기' : grouped ? '모아보기' : '현재 폴더',
        name: names[names.length - 1] || '갤러리 홈',
        path: virtual || grouped ? ['갤러리', ...names].join(' / ') : getCurrentGalleryScopePath() || '갤러리 홈',
        breadcrumb: ['갤러리', ...names].join(' / '),
    };
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

function getGallerySessionPathKeys() {
    if (getGalleryViewMode() === 'virtual') {
        return currentPath.slice(1).map(getGalleryNodeKey);
    }
    const dateGroupIndex = currentPath.findIndex(isGalleryDateGroupNode);
    const sessionPath = dateGroupIndex >= 0 ? currentPath.slice(0, dateGroupIndex) : currentPath;
    return sessionPath.map(getGalleryNodeKey);
}

function getGalleryVirtualGrouping() {
    return GALLERY_VIRTUAL_GROUPING_VALUES.has(galleryVirtualGrouping) ? galleryVirtualGrouping : 'character';
}

function getGalleryVirtualUncategorizedMode() {
    return GALLERY_VIRTUAL_UNCATEGORIZED_VALUES.has(galleryVirtualUncategorized)
        ? galleryVirtualUncategorized
        : 'only';
}

function getGalleryVirtualPromptMode() {
    const mode = getGalleryPromptSearchMode();
    return ['general', 'r18', 'all'].includes(mode) ? mode : 'all';
}

function normalizeGalleryVirtualFolderRecord(raw = {}) {
    return {
        ...raw,
        id: String(raw.id || ''),
        parent_id: raw.parent_id ? String(raw.parent_id) : null,
        name: String(raw.name || '가상 폴더'),
        query: String(raw.query || ''),
        scope_paths: Array.isArray(raw.scope_paths) ? raw.scope_paths.map(normalizeGalleryPathKey).filter(Boolean) : [],
        mode: ['general', 'r18', 'all'].includes(String(raw.mode || 'all')) ? String(raw.mode || 'all') : 'all',
        folders: [],
        images: [],
        total_images: 0,
        isGalleryVirtualFolder: true,
        virtualFolder: raw
    };
}

function rebuildGalleryVirtualFolderTree(records = []) {
    const nodes = records.map(normalizeGalleryVirtualFolderRecord).filter(folder => folder.id);
    const map = new Map(nodes.map(folder => [folder.id, folder]));
    nodes.forEach(folder => {
        const parent = folder.parent_id ? map.get(folder.parent_id) : null;
        (parent ? parent.folders : []).push(folder);
    });
    const roots = nodes.filter(folder => !folder.parent_id || !map.has(folder.parent_id));
    const rootImages = [];
    collectGalleryFolderImages(rootTree, rootImages, new Set());
    galleryVirtualFolderMap = map;
    galleryVirtualFolders = nodes;
    galleryVirtualRootNode = {
        id: '__gallery_virtual_root__',
        name: '가상 폴더',
        path: '__gallery_virtual_root__',
        folders: roots,
        images: [],
        total_images: 0,
        isGalleryVirtualRoot: true,
        virtualRootImages: rootImages
    };
    return galleryVirtualRootNode;
}

async function loadGalleryVirtualFolders() {
    galleryVirtualLoading = true;
    try {
        const res = await fetch('/api/gallery/virtual_folders?parent_id=__all__', {cache: 'no-store'});
        const json = await res.json();
        if (!res.ok || json.status === 'error') throw new Error(json.message || '가상 폴더 목록을 불러오지 못했습니다.');
        rebuildGalleryVirtualFolderTree(Array.isArray(json.folders) ? json.folders : []);
        return galleryVirtualRootNode;
    } finally {
        galleryVirtualLoading = false;
    }
}

function getGalleryVirtualAllImages() {
    if (!galleryCatalogLoader && galleryVirtualRootNode?.virtualRootImages) return galleryVirtualRootNode.virtualRootImages.slice();
    const images = [];
    if (rootTree) collectGalleryFolderImages(rootTree, images, new Set());
    return images;
}

function galleryVirtualImageMatchesMode(item, mode) {
    if (mode === 'all') return true;
    const isR18 = String(item?.path || '').includes('_R-18') || String(item?.path || '').includes('_R-15');
    return mode === 'r18' ? isR18 : !isR18;
}

function galleryVirtualImageInScopes(item, scopePaths = [], mode = 'all') {
    if (!galleryVirtualImageMatchesMode(item, mode)) return false;
    const path = normalizeGalleryPathKey(item?.path || '');
    const scopes = Array.isArray(scopePaths) ? scopePaths.map(normalizeGalleryPathKey).filter(Boolean) : [];
    return !scopes.length || scopes.some(scope => path === scope || path.startsWith(`${scope.replace(/\/$/, '')}/`));
}

async function getGalleryVirtualSourceImages(paths) {
    const images = await galleryCatalogLoader.loadPaths(paths);
    const folders = new Map();
    const visit = node => {
        for (const path of node._image_sources || [node.path]) folders.set(normalizeGalleryPathKey(path), node);
        for (const child of node.folders || []) visit(child);
    };
    visit(rootTree);
    const grouped = new Map();
    for (const item of images) {
        const path = normalizeGalleryPathKey(item.path).split('/').slice(0, -1).join('/');
        if (!grouped.has(path)) grouped.set(path, []);
        grouped.get(path).push(item);
    }
    const output = [], seen = new Set();
    for (const [path, items] of grouped) {
        collectGalleryFolderImages({...folders.get(path), path, images: items, folders: []}, output, seen);
    }
    return output;
}

async function galleryVirtualFindImagesByPaths(paths = []) {
    const existingByPath = new Map();
    const sourceImages = galleryCatalogLoader
        ? await getGalleryVirtualSourceImages(paths)
        : getGalleryVirtualAllImages();
    sourceImages.forEach(item => {
        const key = normalizeGalleryPathKey(item?.path || '');
        if (key && !existingByPath.has(key)) existingByPath.set(key, item);
    });

    const seen = new Set();
    return paths.map(rawPath => {
        const path = normalizeGalleryPathKey(rawPath);
        if (!path || seen.has(path)) return null;
        seen.add(path);

        const existing = existingByPath.get(path);
        if (existing) return existing;

        const parentPath = path.split('/').slice(0, -1).join('/');
        return {
            path,
            name: getImageFileName(path),
            galleryParentPath: parentPath,
            galleryParentName: parentPath.split('/').pop() || '',
            isGalleryVirtualFallback: true
        };
    }).filter(Boolean);
}

function createGalleryVirtualResolveState() {
    return {
        completed: new Map(),
        errors: new Map(),
        inflight: new Map(),
        summaryCompleted: new Map(),
        summaryInflight: new Map(),
        summaryQueue: [],
        summaryActive: 0,
        summaryLimit: 5,
        resolveQueue: [],
        resolveActive: 0,
        resolveLimit: 5
    };
}

function beginGalleryVirtualLoading(container, title, message = '') {
    if (!container) return () => {};
    const state = document.createElement('div');
    state.className = 'gallery-load-state gallery-virtual-load-state';
    state.innerHTML = `
        <div class="gallery-load-spinner"></div>
        <div class="gallery-load-title">${escapeHtml(title || '가상 폴더를 불러오는 중...')}</div>
        ${message ? `<div class="gallery-load-message">${escapeHtml(message)}</div>` : ''}
    `;
    container.appendChild(state);
    return () => state.remove();
}

function enqueueGalleryVirtualSummaryRequest(resolveState, task) {
    return new Promise((resolve, reject) => {
        resolveState.summaryQueue.push({task, resolve, reject});
        const drain = () => {
            while (resolveState.summaryActive < resolveState.summaryLimit && resolveState.summaryQueue.length) {
                const entry = resolveState.summaryQueue.shift();
                resolveState.summaryActive += 1;
                Promise.resolve()
                    .then(entry.task)
                    .then(entry.resolve, entry.reject)
                    .finally(() => {
                        resolveState.summaryActive -= 1;
                        drain();
                    });
            }
        };
        drain();
    });
}

function enqueueGalleryVirtualResolveRequest(resolveState, task) {
    return new Promise((resolve, reject) => {
        resolveState.resolveQueue.push({task, resolve, reject});
        const drain = () => {
            while (resolveState.resolveActive < resolveState.resolveLimit && resolveState.resolveQueue.length) {
                const entry = resolveState.resolveQueue.shift();
                resolveState.resolveActive += 1;
                Promise.resolve()
                    .then(entry.task)
                    .then(entry.resolve, entry.reject)
                    .finally(() => {
                        resolveState.resolveActive -= 1;
                        drain();
                    });
            }
        };
        drain();
    });
}

function isGalleryVirtualContainerNode(node) {
    return Boolean(node?.isGalleryVirtualFolder && Array.isArray(node.folders) && node.folders.length);
}

async function resolveGalleryVirtualFolderNode(node, resolveState = null) {
    if (!node?.isGalleryVirtualFolder || !node.id) return [];
    const state = resolveState || createGalleryVirtualResolveState();
    const id = String(node.id);
    if (state.completed.has(id)) return state.completed.get(id);
    if (state.errors.has(id)) throw state.errors.get(id);
    if (state.inflight.has(id)) return state.inflight.get(id);

    const request = (async () => enqueueGalleryVirtualResolveRequest(state, async () => {
        const res = await fetch(`/api/gallery/virtual_folders/${encodeURIComponent(node.id)}/resolve?ts=${Date.now()}`, {cache: 'no-store'});
        const json = await res.json();
        if (!res.ok || json.status === 'error') throw new Error(json.message || '가상 폴더 검색 결과를 불러오지 못했습니다.');
        const images = await galleryVirtualFindImagesByPaths(json.image_paths || []);
        node.images = images;
        node.total_images = images.length;
        node.thumb = images[0]?.path || null;
        node.virtualResolved = true;
        node.virtualResolvePayload = json;
        return images;
    }))();
    state.inflight.set(id, request);
    try {
        const images = await request;
        state.completed.set(id, images);
        return images;
    } catch (error) {
        state.errors.set(id, error);
        throw error;
    } finally {
        state.inflight.delete(id);
    }
}

async function getGalleryVirtualBaseImages(node, resolveState = null) {
    if (node?.isGalleryVirtualFolder && node.query) {
        return resolveGalleryVirtualFolderNode(node, resolveState);
    }
    const folder = node?.virtualFolder || {};
    if (galleryCatalogLoader) {
        const visit = async current => {
            if ((current._image_sources || []).some(path => galleryVirtualImageInScopes(
                {path: `${path}/_scope_`}, folder.scope_paths || [], folder.mode || getGalleryVirtualPromptMode()))) {
                await galleryCatalogLoader.load(current);
            }
            for (const child of current.folders || []) await visit(child);
        };
        await visit(rootTree);
    }
    return getGalleryVirtualAllImages().filter(item => galleryVirtualImageInScopes(item, folder.scope_paths || [], folder.mode || getGalleryVirtualPromptMode()));
}

async function collectGalleryVirtualDescendantImages(node, output = new Map(), resolveState = null) {
    await Promise.all((node?.folders || []).map(async child => {
        try {
            if (child.isGalleryVirtualFolder && child.query) {
                const images = await resolveGalleryVirtualFolderNode(child, resolveState);
                images.forEach(item => output.set(normalizeGalleryPathKey(item.path), item));
            }
            await collectGalleryVirtualDescendantImages(child, output, resolveState);
        } catch (error) {
            child.images = [];
            child.total_images = 0;
            child.thumb = null;
            child.virtualSummaryError = error?.message || String(error || '');
        }
    }));
    return output;
}

async function buildGalleryVirtualUncategorizedNode(node, baseImages, descendantRootNode = node, resolveState = null) {
    if (getGalleryVirtualUncategorizedMode() !== 'include') return null;
    const assigned = await collectGalleryVirtualDescendantImages(descendantRootNode, new Map(), resolveState);
    const images = baseImages.filter(item => !assigned.has(normalizeGalleryPathKey(item?.path || '')));
    if (!images.length) return null;
    return {
        id: `__gallery_virtual_unassigned__/${node?.id || 'root'}`,
        name: '미구분',
        path: `__gallery_virtual_unassigned__/${node?.id || 'root'}`,
        images,
        total_images: images.length,
        thumb: images[0]?.path || null,
        folders: [],
        isGalleryVirtualUnassigned: true,
        virtualParentId: node?.isGalleryVirtualFolder ? node.id : null,
        virtualBaseImages: images
    };
}

async function loadGalleryVirtualUncategorizedImages(ownerNode, descendantRootNode, resolveState) {
    if (galleryCatalogLoader) {
        const owner = ownerNode?.isGalleryVirtualRoot ? 'root' : ownerNode.id;
        const response = await fetch(`/api/gallery/virtual_folders/uncategorized_summary?owner_id=${encodeURIComponent(owner)}&include_paths=1`, {cache: 'no-store'});
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.message || '미구분 목록 조회 실패');
        if (payload.indexed) {
            const images = await getGalleryVirtualSourceImages(payload.image_paths || []);
            return {images, total_images: images.length, thumb: images[0]?.path || null};
        }
    }
    const ownerImages = await getGalleryVirtualBaseImages(ownerNode, resolveState);
    return buildGalleryVirtualUncategorizedNode(ownerNode?.isGalleryVirtualRoot ? null : ownerNode,
        ownerImages, descendantRootNode || ownerNode, resolveState);
}

function getGalleryVirtualUncategorizedSummaryUrl(ownerNode) {
    const ownerId = ownerNode?.isGalleryVirtualRoot
        ? 'root'
        : (ownerNode?.id || 'root');
    return `/api/gallery/virtual_folders/uncategorized_summary?owner_id=${encodeURIComponent(ownerId)}&ts=${Date.now()}`;
}

function normalizeGalleryVirtualUncategorizedSummary(payload = {}) {
    const summary = payload?.summary && typeof payload.summary === 'object'
        ? payload.summary
        : payload;
    const total = Number(
        summary?.total_matches ??
        summary?.total_images ??
        summary?.count ??
        0
    );
    return {
        total_images: Number.isFinite(total) ? Math.max(0, total) : 0,
        thumb: normalizeGalleryPathKey(summary?.thumb || summary?.thumbnail || '') || null,
        indexed: Boolean(summary?.indexed),
        source: summary?.source || 'index'
    };
}

async function hydrateGalleryVirtualUncategorizedSummary(ownerNode, descendantRootNode, resolveState) {
    if (!ownerNode || getGalleryVirtualUncategorizedMode() !== 'include') return null;
    resolveState = resolveState || createGalleryVirtualResolveState();
    const cached = ownerNode.galleryVirtualUncategorizedSummary;
    if (cached?.resolved) {
        return cached.total_images > 0
            ? ownerNode.galleryVirtualUncategorizedNode || buildGalleryVirtualUncategorizedPlaceholderNode(ownerNode, descendantRootNode)
            : null;
    }
    if (ownerNode.galleryVirtualUncategorizedSummaryInflight) {
        return ownerNode.galleryVirtualUncategorizedSummaryInflight;
    }

    const request = (async () => {
        let summary = null;
        try {
            const response = await enqueueGalleryVirtualSummaryRequest(resolveState, async () => {
                const res = await fetch(getGalleryVirtualUncategorizedSummaryUrl(ownerNode), {cache: 'no-store'});
                const payload = await res.json();
                if (!res.ok || payload.status === 'error') {
                    throw new Error(payload.message || '미구분 요약을 불러오지 못했습니다.');
                }
                return payload;
            });
            summary = normalizeGalleryVirtualUncategorizedSummary(response);
            // HTTP 200이어도 prompt index를 사용할 수 없다는 응답이면
            // 0장으로 캐시하지 말고 기존 전체 계산 경로를 사용한다.
            if (!summary.indexed) {
                throw new Error('미구분 요약 인덱스를 사용할 수 없습니다.');
            }
        } catch (error) {
            // 구버전 서버나 인덱스가 없는 경우에도 기존 동작을 유지한다.
            // 이 경로만 전체 결과를 계산하며, 정상 서버에서는 인덱스 요약으로 끝난다.
            try {
                const baseImages = await getGalleryVirtualBaseImages(ownerNode, resolveState);
                const resolved = await buildGalleryVirtualUncategorizedNode(
                    ownerNode.isGalleryVirtualRoot ? null : ownerNode,
                    baseImages,
                    descendantRootNode || ownerNode,
                    resolveState
                );
                summary = {
                    total_images: Number(resolved?.total_images || 0),
                    thumb: resolved?.thumb || null,
                    indexed: false,
                    source: 'fallback',
                    fallbackNode: resolved
                };
            } catch (fallbackError) {
                throw fallbackError || error;
            }
        }

        ownerNode.galleryVirtualUncategorizedSummary = {...summary, resolved: true};
        if (summary.total_images <= 0) {
            ownerNode.galleryVirtualUncategorizedNode = null;
            return null;
        }

        const node = summary.fallbackNode || buildGalleryVirtualUncategorizedPlaceholderNode(ownerNode, descendantRootNode);
        if (!node) return null;
        node.total_images = summary.total_images;
        node.thumb = summary.thumb || node.thumb || null;
        // 인덱스 요약은 카드에 먼저 표시하고, 클릭 시에만 전체 결과를 조회한다.
        // fallback은 이미 images를 갖고 있으므로 다시 조회하지 않는다.
        node.virtualUncategorizedPending = !summary.fallbackNode;
        node.virtualUncategorizedSummaryResolved = true;
        ownerNode.galleryVirtualUncategorizedNode = node;
        return node;
    })();
    ownerNode.galleryVirtualUncategorizedSummaryInflight = request;
    try {
        return await request;
    } finally {
        delete ownerNode.galleryVirtualUncategorizedSummaryInflight;
    }
}

function buildGalleryVirtualUncategorizedPlaceholderNode(ownerNode, descendantRootNode) {
    if (getGalleryVirtualUncategorizedMode() !== 'include') return null;
    if (ownerNode?.galleryVirtualUncategorizedSummary?.resolved &&
        Number(ownerNode.galleryVirtualUncategorizedSummary.total_images || 0) <= 0) {
        return null;
    }
    if (ownerNode?.galleryVirtualUncategorizedNode) return ownerNode.galleryVirtualUncategorizedNode;
    const ownerId = ownerNode?.isGalleryVirtualRoot ? 'root' : (ownerNode?.id || 'root');
    const placeholder = {
        id: `__gallery_virtual_unassigned__/${ownerId}`,
        name: '미구분',
        path: `__gallery_virtual_unassigned__/${ownerId}`,
        images: [],
        total_images: 0,
        thumb: null,
        folders: [],
        isGalleryVirtualUnassigned: true,
        virtualParentId: ownerNode?.isGalleryVirtualFolder ? ownerNode.id : null,
        virtualUncategorizedPending: true,
        virtualUncategorizedOwnerNode: ownerNode,
        virtualUncategorizedDescendantRootNode: descendantRootNode
    };
    if (ownerNode) ownerNode.galleryVirtualUncategorizedNode = placeholder;
    return placeholder;
}

async function hydrateGalleryVirtualFolderSummary(node, resolveState) {
    if (!node?.isGalleryVirtualFolder || !resolveState) return node;
    const id = String(node.id || '');
    if (!id) return node;
    if (resolveState.summaryCompleted.has(id)) return resolveState.summaryCompleted.get(id);
    if (resolveState.summaryInflight.has(id)) return resolveState.summaryInflight.get(id);

    const task = (async () => {
        try {
            if (isGalleryVirtualContainerNode(node)) {
                for (const child of (node.folders || [])) {
                    await hydrateGalleryVirtualFolderSummary(child, resolveState);
                }
                node.total_images = (node.folders || []).reduce((sum, child) => sum + Number(child.total_images || 0), 0);
                node.thumb = (node.folders || []).find(child => child.thumb)?.thumb || null;
            } else {
                const json = await enqueueGalleryVirtualSummaryRequest(resolveState, async () => {
                    const res = await fetch(`/api/gallery/virtual_folders/${encodeURIComponent(id)}/resolve?summary=1&ts=${Date.now()}`, {cache: 'no-store'});
                    const payload = await res.json();
                    if (!res.ok || payload.status === 'error') throw new Error(payload.message || '가상 폴더 요약을 불러오지 못했습니다.');
                    return payload;
                });
                node.total_images = Number(json.total_matches ?? (Array.isArray(json.image_paths) ? json.image_paths.length : 0));
                node.thumb = normalizeGalleryPathKey(json.thumb || '') || null;
                node.virtualSummaryPayload = json;
            }
            node.virtualSummaryResolved = true;
            node.virtualSummaryError = '';
        } catch (error) {
            node.images = [];
            node.total_images = 0;
            node.thumb = null;
            node.virtualSummaryError = error?.message || String(error || '');
        }
        resolveState.summaryCompleted.set(id, node);
        return node;
    })();
    resolveState.summaryInflight.set(id, task);
    try {
        return await task;
    } finally {
        resolveState.summaryInflight.delete(id);
    }
}

async function hydrateGalleryVirtualFolderSummaries(folders, resolveState) {
    const queue = (folders || []).slice();
    const worker = async () => {
        while (queue.length) await hydrateGalleryVirtualFolderSummary(queue.shift(), resolveState);
    };
    await Promise.all(Array.from({length: Math.min(5, queue.length)}, () => worker()));
    return folders;
}

function buildGalleryVirtualCharacterNodes(images, parentId) {
    const groups = new Map();
    images.forEach(item => {
        const parent = getGalleryImageParentInfo(item);
        const key = parent.path || parent.name || '기타';
        const sourceNames = (Array.isArray(item?.galleryParentCharNames) && item.galleryParentCharNames.length
            ? item.galleryParentCharNames
            : [parent.name || '기타'])
            .flatMap(splitGalleryCharacterNameParts)
            .filter(Boolean);
        if (!groups.has(key)) {
            groups.set(key, {
                id: `__gallery_virtual_character__/${parentId || 'root'}/${key}`,
                name: getGalleryFolderKoreanDisplayName(sourceNames.join(' and ') || parent.name || '기타'),
                char_names: sourceNames.length ? sourceNames : [parent.name || '기타'],
                path: `__gallery_virtual_character__/${parentId || 'root'}/${key}`,
                folders: [],
                images: [],
                total_images: 0,
                thumb: null,
                is_dakimakura: Boolean(item?.galleryParentIsDakimakura),
                isGalleryVirtualCharacterGroup: true,
                virtualParentId: parentId || null
            });
        }
        const group = groups.get(key);
        group.images.push(item);
        group.total_images += 1;
        group.is_dakimakura = group.is_dakimakura || Boolean(item?.galleryParentIsDakimakura);
        if (!group.thumb) group.thumb = item.path;
    });
    return [...groups.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function getGalleryVirtualDisplayImages(images) {
    let result = (images || []).filter(item => passesGalleryDakiFilter(item, false));
    if (galleryPromptSearchActive) result = result.filter(galleryPromptSearchMatchesImage);
    if (currentGalleryTagFilter !== 'ALL') result = result.filter(imageMatchesGalleryTagFilter);
    return result;
}

function renderGalleryVirtualBreadcrumb() {
    const bcPath = document.getElementById('breadcrumb-path');
    if (!bcPath) return;
    bcPath.innerHTML = '<span style="cursor:pointer; color:#d7c7ff" onclick="goToGalleryVirtualRoot()">🗂️ 가상 폴더</span>';
    currentPath.slice(2).forEach((node, index) => {
        const pathIndex = index + 2;
        const span = document.createElement('span');
        span.innerHTML = ` <span style="color:var(--accent)">❯</span> <span style="cursor:pointer;color:${pathIndex === currentPath.length - 1 ? '#fff' : '#888'}">${escapeHtml(node.name || '')}</span>`;
        span.onclick = () => {
            currentPath = currentPath.slice(0, pathIndex + 1);
            renderView();
            saveGallerySessionState();
        };
        bcPath.appendChild(span);
    });
}

function goToGalleryVirtualRoot() {
    if (!galleryVirtualRootNode) return;
    currentPath = [rootTree, galleryVirtualRootNode];
    renderView();
    saveGallerySessionState();
}

function sortGalleryVirtualFolderCards(folders) {
    const sortMode = galleryFolderSort;
    return folders.slice().sort((a, b) => {
        if (sortMode === 'count') {
            const countDiff = Number(b.total_images || 0) - Number(a.total_images || 0);
            if (countDiff) return countDiff;
        }
        // 가상 폴더 화면에는 폴더 단위의 공통 mtime 계약이 없으므로
        // 최신/오래된순은 카드 순서를 바꾸지 않고 이름순으로 안정화한다.
        // 실제 이미지가 있는 leaf 화면은 renderImageGrid에서 시간 정렬한다.
        return String(a.name || '').localeCompare(String(b.name || ''));
    });
}

function updateGalleryVirtualFolderCardSummary(card, child) {
    if (!card?.isConnected) return;
    const count = card.querySelector('.count-num');
    if (count) count.textContent = Number(child.total_images || 0).toLocaleString();
    const body = card.querySelector('.card-body');
    if (!body || !child.thumb || body.querySelector('.card-main-img')) return;
    const placeholder = body.querySelector('.gallery-virtual-folder-card-placeholder');
    const image = document.createElement('img');
    image.src = getGalleryThumbnailSrc(child.thumb);
    image.decoding = 'async';
    image.className = 'card-main-img';
    image.loading = 'lazy';
    image.draggable = false;
    if (placeholder) placeholder.replaceWith(image);
    else body.prepend(image);
}

async function renderGalleryVirtualFolderCards(container, folders, title = '🗂️ 가상 폴더', resolveState = null, generation = galleryVirtualRenderGeneration) {
    if (!folders.length) return;
    const state = resolveState || createGalleryVirtualResolveState();
    const sortedFolders = sortGalleryVirtualFolderCards(folders);
    let stopLoading = () => {};
    if (galleryFolderSort === 'count') {
        stopLoading = beginGalleryVirtualLoading(
            container,
            '가상 폴더 개수 정렬 중...',
            `${sortedFolders.length.toLocaleString()}개 폴더의 인덱스 요약을 확인하고 있습니다.`
        );
        try {
            await hydrateGalleryVirtualFolderSummaries(sortedFolders, state);
            sortedFolders.splice(0, sortedFolders.length, ...sortGalleryVirtualFolderCards(sortedFolders));
        } finally {
            stopLoading();
        }
        if (generation !== galleryVirtualRenderGeneration) return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'collapsible-wrapper';
    wrapper.innerHTML = `<div class="section-header" style="border-left-color:#a78bfa"><span style="font-size:20px;font-weight:900;color:#a78bfa">${escapeHtml(title)} (${folders.length})</span><span class="arrow">▼</span></div><div class="section-content"><div class="flex-masonry"></div></div>`;
    container.appendChild(wrapper);
    const grid = wrapper.querySelector('.flex-masonry');
    const cols = Array.from({length: getGalleryEffectiveColumnCount(grid)}, () => {
        const col = document.createElement('div'); col.className = 'flex-masonry-col'; grid.appendChild(col); return col;
    });
    let observer = null;
    if (typeof IntersectionObserver !== 'undefined') {
        observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const card = entry.target;
                observer.unobserve(card);
                card._galleryVirtualSummaryLoad?.();
            });
        }, {rootMargin: '240px'});
        galleryVirtualSummaryObservers.add(observer);
    }
    sortedFolders.forEach((child, idx) => {
        const card = document.createElement('div');
        card.className = 'card gallery-virtual-folder-card-item';
        const icon = child.isGalleryVirtualUnassigned ? '🟠' : child.isGalleryVirtualCharacterGroup ? '👤' : '🗂️';
        const isVirtualCharacterGroup = Boolean(child.isGalleryVirtualCharacterGroup);
        const isDaki = isVirtualCharacterGroup && isGalleryDakimakuraFolder(child);
        const characterNames = isVirtualCharacterGroup
            ? (Array.isArray(child.char_names) && child.char_names.length ? child.char_names : [child.name])
                .flatMap(splitGalleryCharacterNameParts)
            : [];
        const nameRows = isVirtualCharacterGroup
            ? characterNames.map(n => {
                const rawName = normalizeGalleryCharacterName(n);
                const displayName = getGalleryCharacterKoreanDisplayName(rawName);
                const title = rawName && rawName !== displayName ? ` title="${escapeHtml(rawName)}"` : '';
                return `<div class="char-row"${title}><span class="user-icon">👤</span><span class="char-name">${escapeHtml(displayName)}</span></div>`;
            }).join('')
            : `<div class="char-row"><span class="user-icon">${icon}</span><span class="char-name">${escapeHtml(child.name || '')}</span></div>`;
        const cardMeta = child.isGalleryVirtualFolder && child.query
            ? `검색: ${escapeHtml(child.query)}`
            : child.folders?.length
                ? `${child.folders.length}개 하위 폴더`
            : '';
        const cardMetaHtml = cardMeta ? `<div class="gallery-virtual-folder-card-meta">${cardMeta}</div>` : '';
        const isSummaryPending = child.isGalleryVirtualFolder && !child.virtualSummaryResolved;
        const isUncategorizedPending = Boolean(child.virtualUncategorizedPending && !child.virtualUncategorizedSummaryResolved);
        card.innerHTML = `<div class="card-body">${child.thumb ? `<img src="${getGalleryImageSrc(child.thumb)}" class="card-main-img" loading="lazy" draggable="false">` : '<div class="gallery-virtual-folder-card-placeholder" style="height:150px;background:#222;display:flex;align-items:center;justify-content:center;font-size:48px">🗂️</div>'}${isDaki ? '<div class="daki-badge-neon">DAKIMAKURA</div>' : ''}<div class="count-badge"><span class="count-num">${isSummaryPending || isUncategorizedPending ? '…' : Number(child.total_images || 0).toLocaleString()}</span><span>FILES</span></div></div><div class="card-header">${nameRows}${cardMetaHtml}</div>`;
        card.onclick = () => {
            currentPath.push(child);
            currentSelectedGalleryArtStyle = 'ALL';
            searchText = '';
            const input = document.getElementById('folder-search'); if (input) input.value = '';
            renderView();
            saveGallerySessionState();
            window.scrollTo(0, 0);
        };
        cols[idx % cols.length].appendChild(card);
        if (observer && isSummaryPending && child.isGalleryVirtualFolder) {
            card._galleryVirtualSummaryLoad = async () => {
                try {
                    await hydrateGalleryVirtualFolderSummary(child, state);
                    if (generation === galleryVirtualRenderGeneration && card.isConnected) updateGalleryVirtualFolderCardSummary(card, child);
                } catch (error) {
                    child.virtualSummaryError = error?.message || String(error || '');
                }
            };
            observer.observe(card);
        } else if (!observer && isSummaryPending && child.isGalleryVirtualFolder) {
            child.virtualSummaryResolved = false;
            hydrateGalleryVirtualFolderSummary(child, state).then(() => {
                if (generation === galleryVirtualRenderGeneration && card.isConnected) updateGalleryVirtualFolderCardSummary(card, child);
            });
        }
    });
}

async function renderGalleryVirtualView(container) {
    const generation = ++galleryVirtualRenderGeneration;
    galleryVirtualSummaryObservers.forEach(observer => observer.disconnect());
    galleryVirtualSummaryObservers.clear();
    if (!rootTree) return;
    if (!galleryVirtualRootNode) {
        container.innerHTML = '<div class="gallery-load-state"><div class="gallery-load-title">가상 폴더 목록을 불러오는 중...</div></div>';
        try { await loadGalleryVirtualFolders(); } catch (error) { if (generation !== galleryVirtualRenderGeneration) return; container.innerHTML = `<div class="gallery-load-state error"><div class="gallery-load-title">가상 폴더 로드 실패</div><div class="gallery-load-message">${escapeHtml(error.message || error)}</div></div>`; return; }
        if (generation !== galleryVirtualRenderGeneration) return;
    }
    renderGalleryVirtualBreadcrumb();
    const currentNode = currentPath[currentPath.length - 1] || galleryVirtualRootNode;
    const resolveState = createGalleryVirtualResolveState();
    const isVirtualContainer = isGalleryVirtualContainerNode(currentNode);
    if (currentNode.isGalleryVirtualUnassigned && currentNode.virtualUncategorizedPending) {
        const stopLoading = beginGalleryVirtualLoading(
            container,
            '미구분 이미지를 계산하는 중...',
            '가상 폴더 검색 결과에서 이미 구분된 이미지를 제외하고 있습니다.'
        );
        const ownerNode = currentNode.virtualUncategorizedOwnerNode;
        try {
            const resolved = await loadGalleryVirtualUncategorizedImages(
                ownerNode,
                currentNode.virtualUncategorizedDescendantRootNode || ownerNode,
                resolveState
            );
            if (generation !== galleryVirtualRenderGeneration) return;
            if (resolved) Object.assign(currentNode, resolved, {virtualUncategorizedPending: false, virtualUncategorizedResolved: true});
            else {
                currentNode.images = [];
                currentNode.total_images = 0;
                currentNode.thumb = null;
                currentNode.virtualUncategorizedPending = false;
                currentNode.virtualUncategorizedResolved = true;
            }
        } catch (error) {
            if (generation !== galleryVirtualRenderGeneration) return;
            container.innerHTML = `<div class="gallery-load-state error"><div class="gallery-load-title">미구분 이미지 계산 실패</div><div class="gallery-load-message">${escapeHtml(error.message || error)}</div></div>`;
            showToast(`미구분 이미지 계산 실패: ${error.message || error}`);
            return;
        } finally {
            stopLoading();
        }
    }
    if (currentNode.isGalleryVirtualFolder && currentNode.query && !isVirtualContainer) {
        const stopLoading = beginGalleryVirtualLoading(
            container,
            '가상 폴더 검색 중...',
            `“${currentNode.name || currentNode.query}” 검색 결과를 준비하고 있습니다.`
        );
        try {
            await resolveGalleryVirtualFolderNode(currentNode, resolveState);
        } catch (error) {
            if (generation !== galleryVirtualRenderGeneration) return;
            container.innerHTML = `<div class="gallery-load-state error"><div class="gallery-load-title">가상 폴더 검색 실패</div><div class="gallery-load-message">${escapeHtml(error.message || error)}</div></div>`;
            showToast(`가상 폴더 검색 실패: ${error.message || error}`);
            return;
        } finally {
            stopLoading();
        }
    }
    let baseImages = currentNode.isGalleryVirtualRoot
        ? []
        : isVirtualContainer || (currentNode.isGalleryVirtualFolder && !currentNode.query)
            ? []
        : currentNode.isGalleryVirtualCharacterGroup || currentNode.isGalleryVirtualUnassigned
            ? currentNode.images || []
            : await getGalleryVirtualBaseImages(currentNode, resolveState);
    baseImages = getGalleryVirtualDisplayImages(baseImages);
    const isQuerylessVirtualContainer = currentNode.isGalleryVirtualRoot ||
        isVirtualContainer ||
        (currentNode.isGalleryVirtualFolder && !currentNode.query);
    const renderImages = isQuerylessVirtualContainer ? [] : baseImages;
    let childFolders = currentNode.isGalleryVirtualFolder || currentNode.isGalleryVirtualRoot ? (currentNode.folders || []).slice() : [];
    if (searchText) {
        childFolders = childFolders.filter(folder => {
            const text = `${folder.name || ''} ${folder.query || ''}`.toLowerCase();
            return text.includes(searchText);
        });
    }
    if (currentNode.isGalleryVirtualRoot || currentNode.isGalleryVirtualFolder) {
        const stopLoading = beginGalleryVirtualLoading(
            container,
            '미구분 개수 확인 중...',
            '인덱스에서 미구분 이미지 수와 대표 썸네일을 확인하고 있습니다.'
        );
        let unassigned = null;
        try {
            unassigned = await hydrateGalleryVirtualUncategorizedSummary(
                currentNode,
                currentNode.isGalleryVirtualRoot ? galleryVirtualRootNode : currentNode,
                resolveState
            );
        } catch (error) {
            // 미구분 요약 실패는 가상 폴더 전체 화면을 막지 않는다.
            console.warn('Gallery virtual uncategorized summary failed:', error);
        } finally {
            stopLoading();
        }
        if (unassigned) childFolders.push(unassigned);
    }
    if (generation !== galleryVirtualRenderGeneration) return;
    const shouldGroup = getGalleryVirtualGrouping() === 'character' && !isQuerylessVirtualContainer && !currentNode.isGalleryVirtualCharacterGroup;
    const groupedImages = shouldGroup ? buildGalleryVirtualCharacterNodes(renderImages, currentNode.id) : [];
    if (currentNode.isGalleryVirtualRoot) await renderGalleryVirtualFolderCards(container, childFolders, '🗂️ 가상 폴더', resolveState, generation);
    else {
        await renderGalleryVirtualFolderCards(container, childFolders, '🗂️ 가상 폴더', resolveState, generation);
        if (shouldGroup && groupedImages.length) await renderGalleryVirtualFolderCards(container, groupedImages, '👤 캐릭터별', resolveState, generation);
    }
    if (generation !== galleryVirtualRenderGeneration) return;
    if (renderImages.length && (getGalleryVirtualGrouping() === 'combined' || currentNode.isGalleryVirtualCharacterGroup)) {
        renderImageGrid(container, `🖼️ 이미지 (${renderImages.length})`, renderImages, currentNode);
    }
    if (!childFolders.length && !renderImages.length && !groupedImages.length) {
        container.innerHTML += '<div class="gallery-load-state"><div class="gallery-load-title">비어 있는 가상 폴더</div><div class="gallery-load-message">관리 버튼에서 하위 가상 폴더를 추가할 수 있습니다.</div></div>';
    }
    const spacer = document.createElement('div'); spacer.style.height = '400px'; spacer.style.width = '100%'; container.appendChild(spacer);
    scheduleGalleryScrollNavigationUpdate();
}

function getGalleryVirtualManagerStatus() {
    return document.getElementById('galleryVirtualFolderManagerStatus');
}

function setGalleryVirtualManagerStatus(message, isError = false) {
    const box = getGalleryVirtualManagerStatus();
    if (box) {
        box.textContent = message || '';
        box.style.color = isError ? '#ff8a9a' : '';
    }
}

function getGalleryVirtualFolderEditorStatus() {
    return document.getElementById('galleryVirtualFolderEditorStatus');
}

function setGalleryVirtualFolderEditorStatus(message, isError = true) {
    const box = getGalleryVirtualFolderEditorStatus();
    if (box) {
        box.textContent = message || '';
        box.style.color = isError ? '#ff8a9a' : '#a7f3d0';
    }
}

function getGalleryVirtualDescendantIds(folderId) {
    const result = new Set([String(folderId || '')]);
    const visit = id => galleryVirtualFolders.filter(folder => folder.parent_id === id).forEach(child => { result.add(child.id); visit(child.id); });
    visit(String(folderId || ''));
    return result;
}

function getGalleryVirtualManagerParentOptions(excludeId = '') {
    const excluded = getGalleryVirtualDescendantIds(excludeId);
    return [{id: '', name: '루트'}].concat(galleryVirtualFolders
        .filter(folder => !excluded.has(folder.id))
        .map(folder => ({id: folder.id, name: folder.name})));
}

function renderGalleryVirtualFolderManager() {
    const tree = document.getElementById('galleryVirtualFolderManagerTree');
    const parentSelect = document.getElementById('galleryVirtualFolderParentInput');
    if (!tree) return;
    if (parentSelect) {
        parentSelect.innerHTML = getGalleryVirtualManagerParentOptions().map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name)}</option>`).join('');
    }
    tree.innerHTML = '';
    const roots = galleryVirtualFolders.filter(folder => !folder.parent_id);
    const rootRow = document.createElement('div');
    rootRow.className = 'gallery-virtual-folder-manager-root';
    rootRow.innerHTML = `<div class="gallery-virtual-folder-manager-root-main"><div class="gallery-virtual-folder-manager-root-name">⌂ 루트</div><div class="gallery-virtual-folder-manager-root-meta">${roots.length.toLocaleString()}개 루트 폴더</div></div><button type="button" onclick="prepareGalleryVirtualFolderRoot()">루트에 추가</button>`;
    tree.appendChild(rootRow);
    const rows = [];
    const flatten = (folders, depth) => folders.forEach(folder => { rows.push({folder, depth}); flatten(galleryVirtualFolders.filter(child => child.parent_id === folder.id), depth + 1); });
    flatten(roots, 0);
    if (!rows.length) {
        const emptyState = document.createElement('div');
        emptyState.className = 'gallery-virtual-folder-fields-help';
        emptyState.textContent = '아직 가상 폴더가 없습니다.';
        tree.appendChild(emptyState);
        return;
    }
    rows.forEach(({folder, depth}) => {
        const row = document.createElement('div');
        row.className = 'gallery-virtual-folder-manager-row';
        row.dataset.depth = String(depth);
        row.style.setProperty('--gallery-virtual-depth', String(depth));
        row.style.setProperty('--gallery-virtual-branch-opacity', depth > 0 ? '1' : '0');
        const parentOptions = getGalleryVirtualManagerParentOptions(folder.id);
        const managerMeta = [folder.query ? `검색: ${escapeHtml(folder.query)}` : '', escapeHtml(folder.mode || 'all'), `${folder.scope_paths?.length || 0}개 범위`].filter(Boolean).join(' · ');
        row.innerHTML = `<div class="gallery-virtual-folder-manager-main"><div class="gallery-virtual-folder-manager-name">${escapeHtml(folder.name)}</div><div class="gallery-virtual-folder-manager-meta">${managerMeta}</div></div><div class="gallery-virtual-folder-manager-actions"><button type="button" onclick="prepareGalleryVirtualFolderChild('${folder.id}')">하위 추가</button><select title="상위 폴더 이동" onchange="reparentGalleryVirtualFolder('${folder.id}', this.value)">${parentOptions.map(option => `<option value="${escapeHtml(option.id)}" ${String(option.id || '') === String(folder.parent_id || '') ? 'selected' : ''}>${escapeHtml(option.name)}</option>`).join('')}</select><button type="button" onclick="editGalleryVirtualFolder('${folder.id}')">편집</button><button type="button" class="danger" onclick="deleteGalleryVirtualFolder('${folder.id}')">삭제</button></div>`;
        tree.appendChild(row);
    });
}

async function openGalleryVirtualFolderManager() {
    const layer = document.getElementById('galleryVirtualFolderLayer');
    if (!layer) return;
    galleryVirtualManagerOpen = true;
    layer.style.display = 'flex';
    layer.setAttribute('aria-hidden', 'false');
    setGalleryVirtualManagerStatus('가상 폴더 목록을 불러오는 중...');
    try {
        await loadGalleryVirtualFolders();
        renderGalleryVirtualFolderManager();
        const modeInput = document.getElementById('galleryVirtualFolderModeInput');
        if (modeInput) modeInput.value = getGalleryVirtualPromptMode();
        setGalleryVirtualManagerStatus(`${galleryVirtualFolders.length.toLocaleString()}개 가상 폴더`);
    } catch (error) {
        setGalleryVirtualManagerStatus(error.message || error, true);
        showToast(`가상 폴더 목록 로드 실패: ${error.message || error}`);
    }
}

function closeGalleryVirtualFolderManager() {
    closeGalleryVirtualFolderEditor();
    clearGalleryVirtualFolderAutocomplete('create');
    const layer = document.getElementById('galleryVirtualFolderLayer');
    if (layer) { layer.style.display = 'none'; layer.setAttribute('aria-hidden', 'true'); }
    galleryVirtualManagerOpen = false;
}

function closeGalleryVirtualFolderEditor() {
    clearGalleryVirtualFolderAutocomplete('editor');
    const layer = document.getElementById('galleryVirtualFolderEditorLayer');
    if (layer) { layer.style.display = 'none'; layer.setAttribute('aria-hidden', 'true'); }
    galleryVirtualFolderEditingId = '';
    setGalleryVirtualFolderEditorStatus('');
}

function prepareGalleryVirtualFolderChild(parentId) {
    const parentInput = document.getElementById('galleryVirtualFolderParentInput');
    if (parentInput) parentInput.value = String(parentId || '');
    document.getElementById('galleryVirtualFolderNameInput')?.focus();
}

function prepareGalleryVirtualFolderRoot() {
    const parentInput = document.getElementById('galleryVirtualFolderParentInput');
    if (parentInput) parentInput.value = '';
    document.getElementById('galleryVirtualFolderNameInput')?.focus();
}

function getGalleryVirtualCreateScopePaths() {
    const scopePaths = getGalleryPromptSearchScopePaths();
    return scopePaths.length ? scopePaths : [];
}

function getGalleryVirtualFolderAutocompleteConfig(target) {
    const key = target === 'editor' ? 'editor' : 'create';
    if (key === 'editor') {
        return {
            key,
            input: document.getElementById('galleryVirtualFolderEditorQueryInput'),
            box: document.getElementById('galleryVirtualFolderEditorAutocomplete')
        };
    }
    return {
        key,
        input: document.getElementById('galleryVirtualFolderQueryInput'),
        box: document.getElementById('galleryVirtualFolderAutocomplete')
    };
}

function getGalleryVirtualFolderAutocompleteScopePath(target) {
    if (target === 'editor') {
        const scopeInput = document.getElementById('galleryVirtualFolderEditorScopeInput');
        const text = String(scopeInput?.value || '').trim();
        if (!text) return '';
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) return String(parsed.find(Boolean) || '');
            return String(parsed || '');
        } catch {
            return text;
        }
    }
    return String(getGalleryVirtualCreateScopePaths()[0] || '');
}

function getGalleryVirtualFolderAutocompleteMode(target) {
    const id = target === 'editor'
        ? 'galleryVirtualFolderEditorModeInput'
        : 'galleryVirtualFolderModeInput';
    return String(document.getElementById(id)?.value || getGalleryVirtualPromptMode() || 'all');
}

function getGalleryVirtualPromptAutocompleteToken(value) {
    const text = String(value || '');
    const match = text.match(/(?:^|[\s,\n|])([^,\s\n|]*)$/);
    return match ? String(match[1] || '').trim() : '';
}

function clearGalleryVirtualFolderAutocomplete(target) {
    const config = getGalleryVirtualFolderAutocompleteConfig(target);
    const state = galleryVirtualFolderAutocompleteState[config.key];
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.version += 1;
    state.items = [];
    state.activeIndex = -1;
    if (config.box) config.box.innerHTML = '';
}

function clearAllGalleryVirtualFolderAutocomplete() {
    clearGalleryVirtualFolderAutocomplete('create');
    clearGalleryVirtualFolderAutocomplete('editor');
}

function applyGalleryVirtualFolderAutocompleteValue(target, value) {
    const config = getGalleryVirtualFolderAutocompleteConfig(target);
    const input = config.input;
    if (!input) return;
    const current = String(input.value || '');
    const next = current.replace(/[^,\s\n|]*$/, String(value || ''));
    input.value = next;
    clearGalleryVirtualFolderAutocomplete(target);
    input.focus();
}

function renderGalleryVirtualFolderAutocompleteItems(target) {
    const config = getGalleryVirtualFolderAutocompleteConfig(target);
    const state = galleryVirtualFolderAutocompleteState[config.key];
    if (!config.box) return;
    config.box.innerHTML = '';
    state.items.forEach((item, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.role = 'option';
        button.textContent = item;
        button.classList.toggle('active', index === state.activeIndex);
        button.setAttribute('aria-selected', String(index === state.activeIndex));
        button.onclick = () => applyGalleryVirtualFolderAutocompleteValue(target, item);
        config.box.appendChild(button);
    });
}

function moveGalleryVirtualFolderAutocompleteSelection(target, delta) {
    const config = getGalleryVirtualFolderAutocompleteConfig(target);
    const state = galleryVirtualFolderAutocompleteState[config.key];
    if (!state.items.length) return;
    if (state.activeIndex < 0) state.activeIndex = delta >= 0 ? 0 : state.items.length - 1;
    else state.activeIndex = (state.activeIndex + delta + state.items.length) % state.items.length;
    renderGalleryVirtualFolderAutocompleteItems(target);
}

function handleGalleryVirtualFolderAutocompleteKeydown(event, target) {
    const config = getGalleryVirtualFolderAutocompleteConfig(target);
    const state = galleryVirtualFolderAutocompleteState[config.key];
    if (event.key === 'Escape') {
        if (state.items.length) {
            event.preventDefault();
            clearGalleryVirtualFolderAutocomplete(target);
        }
        return;
    }
    if (!state.items.length) return;
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveGalleryVirtualFolderAutocompleteSelection(target, 1);
    } else if (event.key === 'ArrowLeft' && state.activeIndex >= 0) {
        event.preventDefault();
        moveGalleryVirtualFolderAutocompleteSelection(target, -1);
    } else if (event.key === 'ArrowRight' && state.activeIndex >= 0) {
        event.preventDefault();
        moveGalleryVirtualFolderAutocompleteSelection(target, 1);
    } else if (event.key === 'Enter' && state.activeIndex >= 0) {
        event.preventDefault();
        applyGalleryVirtualFolderAutocompleteValue(target, state.items[state.activeIndex]);
    }
}

function updateGalleryVirtualFolderAutocomplete(target) {
    const config = getGalleryVirtualFolderAutocompleteConfig(target);
    const state = galleryVirtualFolderAutocompleteState[config.key];
    clearGalleryVirtualFolderAutocomplete(target);
    if (!config.input || !config.box) return;
    const requestValue = String(config.input.value || '');
    const token = getGalleryVirtualPromptAutocompleteToken(requestValue);
    if (token.length < 2) return;
    const requestVersion = state.version;
    state.timer = setTimeout(async () => {
        try {
            if (state.version !== requestVersion) return;
            const scopePath = getGalleryVirtualFolderAutocompleteScopePath(target);
            const mode = getGalleryVirtualFolderAutocompleteMode(target);
            const res = await fetch(`/api/gallery/prompt_index/autocomplete?q=${encodeURIComponent(token)}&scope_path=${encodeURIComponent(scopePath)}&mode=${encodeURIComponent(mode)}&source=virtual_folder`);
            const json = await res.json();
            if (state.version !== requestVersion) return;
            if (String(config.input.value || '') !== requestValue) return;
            state.items = Array.isArray(json.items) ? json.items : [];
            state.activeIndex = -1;
            renderGalleryVirtualFolderAutocompleteItems(target);
        } catch (error) {
            if (state.version !== requestVersion) return;
            console.warn('Virtual folder prompt autocomplete failed:', error);
            clearGalleryVirtualFolderAutocomplete(target);
        }
    }, 180);
}

async function createGalleryVirtualFolderFromManager() {
    const nameInput = document.getElementById('galleryVirtualFolderNameInput');
    const queryInput = document.getElementById('galleryVirtualFolderQueryInput');
    const parentInput = document.getElementById('galleryVirtualFolderParentInput');
    const modeInput = document.getElementById('galleryVirtualFolderModeInput');
    const name = String(nameInput?.value || '').trim();
    if (!name) { setGalleryVirtualManagerStatus('폴더 이름을 입력하세요.', true); return; }
    const query = String(queryInput?.value || '').trim();
    try {
        const res = await fetch('/api/gallery/virtual_folders', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name, query, scope_paths: getGalleryVirtualCreateScopePaths(), mode: modeInput?.value || getGalleryVirtualPromptMode(), parent_id: parentInput?.value || null})});
        const json = await res.json();
        if (!res.ok || json.status === 'error') throw new Error(json.message || '가상 폴더 추가 실패');
        if (nameInput) nameInput.value = '';
        if (queryInput) queryInput.value = '';
        clearGalleryVirtualFolderAutocomplete('create');
        await loadGalleryVirtualFolders();
        renderGalleryVirtualFolderManager();
        setGalleryVirtualManagerStatus('가상 폴더를 추가했습니다.');
        showToast('가상 폴더를 추가했습니다.');
        if (getGalleryViewMode() === 'virtual') { currentPath = [rootTree, galleryVirtualRootNode]; renderView(); }
    } catch (error) {
        setGalleryVirtualManagerStatus(error.message || error, true);
        showToast(`가상 폴더 추가 실패: ${error.message || error}`);
    }
}

async function editGalleryVirtualFolder(folderId) {
    const folder = galleryVirtualFolderMap.get(String(folderId));
    if (!folder) return;
    const layer = document.getElementById('galleryVirtualFolderEditorLayer');
    const nameInput = document.getElementById('galleryVirtualFolderEditorNameInput');
    const queryInput = document.getElementById('galleryVirtualFolderEditorQueryInput');
    const scopeInput = document.getElementById('galleryVirtualFolderEditorScopeInput');
    const modeInput = document.getElementById('galleryVirtualFolderEditorModeInput');
    const folderLabel = document.getElementById('galleryVirtualFolderEditorFolderLabel');
    if (!layer || !nameInput || !queryInput || !scopeInput || !modeInput) return;
    galleryVirtualFolderEditingId = String(folderId);
    nameInput.value = folder.name || '';
    queryInput.value = folder.query || '';
    scopeInput.value = JSON.stringify(Array.isArray(folder.scope_paths) ? folder.scope_paths : []);
    modeInput.value = ['all', 'general', 'r18'].includes(folder.mode) ? folder.mode : 'all';
    if (folderLabel) folderLabel.textContent = `현재 폴더: ${folder.name || '(이름 없음)'}`;
    clearGalleryVirtualFolderAutocomplete('editor');
    setGalleryVirtualFolderEditorStatus('');
    layer.style.display = 'flex';
    layer.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => nameInput.focus());
}

async function saveGalleryVirtualFolderEdit() {
    const folderId = galleryVirtualFolderEditingId;
    const folder = galleryVirtualFolderMap.get(String(folderId));
    const nameInput = document.getElementById('galleryVirtualFolderEditorNameInput');
    const queryInput = document.getElementById('galleryVirtualFolderEditorQueryInput');
    const scopeInput = document.getElementById('galleryVirtualFolderEditorScopeInput');
    const modeInput = document.getElementById('galleryVirtualFolderEditorModeInput');
    if (!folderId || !folder || !nameInput || !queryInput || !scopeInput || !modeInput) return;
    const name = String(nameInput.value || '').trim();
    if (!name) { setGalleryVirtualFolderEditorStatus('폴더 이름을 입력하세요.'); nameInput.focus(); return; }
    const query = String(queryInput.value || '').trim();
    const scopeText = String(scopeInput.value || '').trim();
    const mode = String(modeInput.value || '').trim();
    if (!['all', 'general', 'r18'].includes(mode)) { setGalleryVirtualFolderEditorStatus('VIEW mode는 all, general, r18 중 하나여야 합니다.'); modeInput.focus(); return; }
    let scopePaths = [];
    if (scopeText) {
        try { scopePaths = JSON.parse(scopeText); } catch { scopePaths = [scopeText]; }
        if (!Array.isArray(scopePaths)) scopePaths = [String(scopePaths)];
    }
    try {
        const res = await fetch(`/api/gallery/virtual_folders/${encodeURIComponent(folderId)}`, {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: name.trim(), query: query.trim(), scope_paths: scopePaths, mode: ['all', 'general', 'r18'].includes(mode.trim()) ? mode.trim() : folder.mode})});
        const json = await res.json();
        if (!res.ok || json.status === 'error') throw new Error(json.message || '가상 폴더 편집 실패');
        await loadGalleryVirtualFolders(); renderGalleryVirtualFolderManager();
        closeGalleryVirtualFolderEditor();
        setGalleryVirtualManagerStatus('가상 폴더를 수정했습니다.');
        showToast('가상 폴더를 수정했습니다.');
        if (getGalleryViewMode() === 'virtual') renderView();
    } catch (error) {
        setGalleryVirtualFolderEditorStatus(error.message || error);
        setGalleryVirtualManagerStatus(error.message || error, true);
        showToast(`가상 폴더 편집 실패: ${error.message || error}`);
    }
}

async function reparentGalleryVirtualFolder(folderId, parentId) {
    try {
        const res = await fetch(`/api/gallery/virtual_folders/${encodeURIComponent(folderId)}/reparent`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({parent_id: parentId || null})});
        const json = await res.json();
        if (!res.ok || json.status === 'error') throw new Error(json.message || '가상 폴더 이동 실패');
        await loadGalleryVirtualFolders(); renderGalleryVirtualFolderManager();
        setGalleryVirtualManagerStatus('가상 폴더를 이동했습니다.');
        if (getGalleryViewMode() === 'virtual') renderView();
    } catch (error) { setGalleryVirtualManagerStatus(error.message || error, true); showToast(`가상 폴더 이동 실패: ${error.message || error}`); renderGalleryVirtualFolderManager(); }
}

async function deleteGalleryVirtualFolder(folderId) {
    const folder = galleryVirtualFolderMap.get(String(folderId));
    if (!folder || !confirm(`가상 폴더 "${folder.name}"을 삭제할까요?`)) return;
    try {
        const res = await fetch(`/api/gallery/virtual_folders/${encodeURIComponent(folderId)}`, {method: 'DELETE'});
        const json = await res.json();
        if (!res.ok || json.status === 'error') throw new Error(json.message || '가상 폴더 삭제 실패');
        await loadGalleryVirtualFolders(); renderGalleryVirtualFolderManager();
        setGalleryVirtualManagerStatus('가상 폴더를 삭제했습니다.');
        if (getGalleryViewMode() === 'virtual') { currentPath = [rootTree, galleryVirtualRootNode]; renderView(); }
    } catch (error) { setGalleryVirtualManagerStatus(error.message || error, true); showToast(`가상 폴더 삭제 실패: ${error.message || error}`); }
}

async function openGalleryVirtualFolderCreateFromPrompt() {
    const input = document.getElementById('galleryPromptSearchInput');
    const query = String(input?.value || '').trim();
    await openGalleryVirtualFolderManager();
    const queryInput = document.getElementById('galleryVirtualFolderQueryInput');
    const nameInput = document.getElementById('galleryVirtualFolderNameInput');
    const parentInput = document.getElementById('galleryVirtualFolderParentInput');
    const modeInput = document.getElementById('galleryVirtualFolderModeInput');
    if (queryInput) queryInput.value = query;
    if (nameInput && !nameInput.value) nameInput.value = query ? query.slice(0, 40) : '';
    const currentNode = currentPath[currentPath.length - 1];
    const parentId = currentNode?.isGalleryVirtualFolder
        ? currentNode.id
        : (currentNode?.isGalleryVirtualUnassigned || currentNode?.isGalleryVirtualCharacterGroup)
            ? currentNode.virtualParentId
            : '';
    if (parentInput) parentInput.value = parentId || '';
    if (modeInput) modeInput.value = getGalleryVirtualPromptMode();
    nameInput?.focus();
}

function onGalleryVirtualGroupingChange() {
    galleryVirtualGrouping = getGalleryRadioValue('galleryVirtualGrouping', 'character');
    if (!GALLERY_VIRTUAL_GROUPING_VALUES.has(galleryVirtualGrouping)) galleryVirtualGrouping = 'character';
    saveGalleryPersistentUi();
    if (getGalleryViewMode() === 'virtual') renderView();
}

function onGalleryVirtualUncategorizedChange() {
    galleryVirtualUncategorized = getGalleryRadioValue('galleryVirtualUncategorized', 'only');
    if (!GALLERY_VIRTUAL_UNCATEGORIZED_VALUES.has(galleryVirtualUncategorized)) galleryVirtualUncategorized = 'only';
    saveGalleryPersistentUi();
    if (getGalleryViewMode() === 'virtual') renderView();
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
    if (window.Daki?.isActive()) return;
    if (!galleryServerSessionId || !rootTree || !currentPath.length) return;

    try {
        sessionStorage.setItem(GALLERY_SESSION_STATE_KEY, JSON.stringify({
            serverSessionId: galleryServerSessionId,
            pathKeys: getGallerySessionPathKeys(),
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
    toggle.innerText = collapsed ? '도구 ▼' : '도구 ▲';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function toggleGalleryHeaderTools(event) {
    if (event) event.stopPropagation();

    const tools = document.getElementById('galleryHeaderTools');
    if (!tools) return;

    const nextCollapsed = !tools.classList.contains('collapsed');

    localStorage.setItem(GALLERY_HEADER_TOOLS_COLLAPSED_KEY, nextCollapsed ? '1' : '0');
    applyGalleryHeaderToolsCollapsedState();
}

function syncReasonVisibility() {
    const reasonToggle = document.getElementById('toggle-reasons');
    const shouldShow = !reasonToggle || reasonToggle.checked;

    document.body.classList.toggle('hide-reasons', !shouldShow);
}

function toggleReasons() {
    syncReasonVisibility();
}

function setDakiFilter(val) {
    dakiFilter = val || 'all';
    setGalleryRadioValue('dakiFilter', dakiFilter);
    saveGalleryPersistentUi();
    renderView();
}

function onGalleryModelFamilyChange() {
    const nextFamily = getGalleryRadioValue('modelFamily', 'all');
    modelFamily = GALLERY_MODEL_FAMILY_VALUES.has(nextFamily) ? nextFamily : 'all';
    setGalleryRadioValue('modelFamily', modelFamily);
    saveGalleryPersistentUi();
    loadData();
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
    if (engine.includes('waifu2x')) return 'Waifu2x';
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

function getGalleryTagState() {
    return {enabled: isGalleryTagAssignmentMode, zoomEnabled: galleryZoomTagEnabled,
        selectedTagId: selectedGalleryAssignmentTagId, definitions: galleryTagDefs.map(tag => ({...tag}))};
}

function notifyGalleryTagsUpdated() {
    window.Daki?.refreshImageTools();
    if (typeof window.CustomEvent === 'function') window.dispatchEvent(new window.CustomEvent('gallery-tags-updated'));
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

function getGalleryTagAssignmentLabel(tagId) {
    if (tagId === 'NONE') return '태그 제거';

    const tag = getGalleryTagDef(tagId);
    if (!tag) return '선택 없음';

    return tag.type === 'text'
        ? `태그: ${tag.value}`
        : '그림 태그';
}

function updateGalleryTagAssignmentModeUi() {
    document.body.classList.toggle('gallery-tag-assignment-mode', isGalleryTagAssignmentMode);

    const btn = document.getElementById('galleryTagAssignmentModeBtn');
    if (btn) {
        btn.classList.toggle('active', isGalleryTagAssignmentMode);
        btn.innerText = isGalleryTagAssignmentMode ? '태그 모드 ON' : '태그 모드';
    }

    const status = document.getElementById('galleryTagAssignmentModeStatus');
    if (status) {
        status.style.display = 'none';
        status.innerText = '';
    }

    updateGalleryTagAssignmentBar();
    renderGalleryTagFilterBar();
    updateGalleryZoomModeUi();
}

function updateGalleryTagAssignmentBar() {
    const text = document.getElementById('galleryTagAssignmentModeBarText');
    if (!text) return;

    text.innerText = selectedGalleryAssignmentTagId
        ? `${getGalleryTagAssignmentLabel(selectedGalleryAssignmentTagId)} 선택됨. ${galleryZoomDeleteEnabled || galleryZoomTagEnabled ? '그림을 클릭하면 확대됩니다.' : '그림을 클릭하면 적용됩니다.'}`
        : '태그를 선택하세요. 확대 화면에서도 선택할 수 있습니다.';
}

function clearGalleryTagAssignmentSelection() {
    selectedGalleryAssignmentTagId = '';
    updateGalleryTagAssignmentModeUi();
}

function toggleGalleryTagAssignmentMode() {
    isGalleryTagAssignmentMode = !isGalleryTagAssignmentMode;

    if (isGalleryTagAssignmentMode) {
        clearGalleryMultiFolderSelection();
    }

    if (!isGalleryTagAssignmentMode) {
        selectedGalleryAssignmentTagId = '';
        galleryZoomTagEnabled = false;
    }

    if (isGalleryTagAssignmentMode && isGalleryBulkDeleteMode && !galleryZoomDeleteEnabled) {
        isGalleryBulkDeleteMode = false;
        clearGalleryBulkDeleteSelection(false);
        updateGalleryBulkDeleteModeUi();
    }

    closeGalleryTagPicker();
    updateGalleryTagAssignmentModeUi();
}

function selectGalleryTagForAssignment(tagId) {
    selectedGalleryAssignmentTagId = tagId || '';
    updateGalleryTagAssignmentModeUi();
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
    notifyGalleryTagsUpdated();
    const bar = document.getElementById('galleryTagFilterBar');
    if (!bar) return;

    bar.innerHTML = '';

    const makeChip = (value, label, iconHtml = '') => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = [
            'gallery-tag-filter-chip',
            currentGalleryTagFilter === value ? 'active' : '',
            isGalleryTagAssignmentMode && selectedGalleryAssignmentTagId === value ? 'gallery-tag-assignment-selected' : ''
        ].filter(Boolean).join(' ');
        btn.title = isGalleryTagAssignmentMode ? `${label} 선택` : label;
        btn.innerHTML = iconHtml || '<span class="gallery-tag-filter-all-dot">ALL</span>';
        btn.onclick = () => {
            if (isGalleryTagAssignmentMode) {
                selectGalleryTagForAssignment(value === 'ALL' ? '' : value);
                return;
            }

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

function closeGalleryRadialTagMenu() {
    const menu = document.getElementById('galleryRadialTagMenu');
    if (!menu) return;

    menu.classList.remove('open');
    menu.setAttribute('aria-hidden', 'true');
    menu.innerHTML = '';
}

function getGalleryRadialTagItems() {
    const items = [{
        tagId: '',
        label: '태그 없음',
        iconHtml: '<span class="gallery-radial-tag-remove-icon" aria-hidden="true">×</span>'
    }];

    galleryTagDefs.forEach((tag, index) => {
        const tagId = String(tag?.id ?? '');
        if (!tagId) return;

        items.push({
            tagId,
            label: tag.type === 'text' ? `태그: ${tag.value}` : `그림 태그 ${index + 1}`,
            iconHtml: renderGalleryTagIcon(tag)
        });
    });

    return items;
}

function updateGalleryRadialTagHighlight(index) {
    const menu = document.getElementById('galleryRadialTagMenu');
    if (!menu) return;

    menu.querySelectorAll('.gallery-radial-tag-item, .gallery-radial-tag-sector').forEach((item) => {
        item.classList.toggle('selected', Number(item.dataset.radialIndex) === index);
    });

    const hint = menu.querySelector('.gallery-radial-tag-menu-hint');
    if (hint) {
        const selected = menu.querySelector(`.gallery-radial-tag-item[data-radial-index="${index}"]`);
        hint.textContent = selected?.getAttribute('aria-label') || '방향을 선택하세요';
    }
}

function getGalleryRadialTagSectorPath(cx, cy, innerRadius, outerRadius, startAngle, endAngle) {
    const point = (radius, angle) => ({
        x: cx + (Math.cos(angle) * radius),
        y: cy + (Math.sin(angle) * radius)
    });
    const outerStart = point(outerRadius, startAngle);
    const outerEnd = point(outerRadius, endAngle);
    const innerEnd = point(innerRadius, endAngle);
    const innerStart = point(innerRadius, startAngle);
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

    return [
        `M ${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
        `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
        `L ${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)}`,
        `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
        'Z'
    ].join(' ');
}

function showGalleryRadialTagMenu(state) {
    const menu = document.getElementById('galleryRadialTagMenu');
    if (!menu) return false;

    const items = getGalleryRadialTagItems();
    if (!items.length) return false;

    const viewportWidth = Math.max(window.innerWidth || 0, 1);
    const viewportHeight = Math.max(window.innerHeight || 0, 1);
    const dialSize = 200;
    const dialCenter = 100;
    const outerRadius = 96;
    const innerRadius = 34;
    const labelRadius = 72;
    const margin = (dialSize / 2) + 8;
    const centerX = Math.max(margin, Math.min(viewportWidth - margin, state.startX));
    const centerY = Math.max(margin, Math.min(viewportHeight - margin, state.startY));
    const step = (Math.PI * 2) / items.length;
    const sectorGap = Math.min(0.035, step * 0.16);

    menu.innerHTML = `
        <div class="gallery-radial-tag-menu-dial" aria-hidden="true">
            <svg class="gallery-radial-tag-dial-svg" viewBox="0 0 ${dialSize} ${dialSize}" focusable="false">
                <circle class="gallery-radial-tag-dial-track" cx="${dialCenter}" cy="${dialCenter}" r="${outerRadius}"></circle>
            </svg>
            <div class="gallery-radial-tag-menu-center">🏷️</div>
        </div>
        <div class="gallery-radial-tag-menu-hint">방향을 선택하세요</div>
    `;

    items.forEach((item, index) => {
        const angle = (-Math.PI / 2) + (step * index);
        const startAngle = angle - (step / 2) + sectorGap;
        const endAngle = angle + (step / 2) - sectorGap;
        const sector = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        sector.classList.add('gallery-radial-tag-sector');
        sector.dataset.radialIndex = String(index);
        sector.setAttribute('d', getGalleryRadialTagSectorPath(
            dialCenter,
            dialCenter,
            innerRadius,
            outerRadius,
            startAngle,
            endAngle
        ));
        sector.setAttribute('aria-hidden', 'true');
        menu.querySelector('.gallery-radial-tag-dial-svg')?.appendChild(sector);

        const button = document.createElement('div');
        button.className = 'gallery-radial-tag-item';
        button.dataset.radialIndex = String(index);
        button.setAttribute('aria-label', item.label);
        button.title = item.label;
        button.innerHTML = item.iconHtml;
        // 라벨은 다이얼과 달리 메뉴 직계 자식이므로 메뉴 중심을 원점으로 둔다.
        button.style.left = `${Math.cos(angle) * labelRadius}px`;
        button.style.top = `${Math.sin(angle) * labelRadius}px`;
        menu.appendChild(button);
    });

    menu.style.left = `${centerX}px`;
    menu.style.top = `${centerY}px`;
    menu.classList.add('open');
    menu.setAttribute('aria-hidden', 'false');

    state.centerX = centerX;
    state.centerY = centerY;
    state.items = items;
    state.opened = true;
    state.selectedIndex = -1;
    updateGalleryRadialTagHighlight(-1);
    return true;
}

function updateGalleryRadialTagSelection(event, state) {
    // 메뉴는 화면 가장자리에서 안쪽으로 보정될 수 있지만, 방향의 원점은
    // 사용자가 실제로 누른 위치여야 한다.
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    const distance = Math.hypot(dx, dy);

    if (distance < GALLERY_RADIAL_TAG_DEAD_ZONE) {
        state.selectedIndex = -1;
        updateGalleryRadialTagHighlight(-1);
        return;
    }

    const step = (Math.PI * 2) / state.items.length;
    const angle = Math.atan2(dy, dx);
    const normalized = (angle + (Math.PI / 2) + (Math.PI * 2)) % (Math.PI * 2);
    state.selectedIndex = Math.round(normalized / step) % state.items.length;
    updateGalleryRadialTagHighlight(state.selectedIndex);
}

function markGalleryRadialTagClickSuppressed(image) {
    galleryRadialTagSuppressClickElement = image || null;
    galleryRadialTagSuppressClickUntil = Date.now() + 800;
    if (image) {
        image.dataset.galleryRadialTagSuppressClickUntil = String(galleryRadialTagSuppressClickUntil);
    }
}

function consumeGalleryRadialTagClick(event) {
    const image = event.target?.closest?.('.zoomable');
    const imageUntil = Number(image?.dataset?.galleryRadialTagSuppressClickUntil || 0);
    const globalMatch = image && galleryRadialTagSuppressClickElement === image;
    const suppressed = image && Date.now() <= Math.max(imageUntil, globalMatch ? galleryRadialTagSuppressClickUntil : 0);

    if (!suppressed) {
        if (image && imageUntil) delete image.dataset.galleryRadialTagSuppressClickUntil;
        return false;
    }

    delete image.dataset.galleryRadialTagSuppressClickUntil;
    if (globalMatch) {
        galleryRadialTagSuppressClickElement = null;
        galleryRadialTagSuppressClickUntil = 0;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
}

function releaseGalleryRadialTagPointer(state) {
    try {
        if (state?.image?.hasPointerCapture?.(state.pointerId)) {
            state.image.releasePointerCapture(state.pointerId);
        }
    } catch (error) {
        // The pointer may already have been released by the browser.
    }
}

function cancelGalleryRadialTagGesture() {
    const state = galleryRadialTagGesture;
    if (!state) {
        closeGalleryRadialTagMenu();
        return;
    }

    galleryRadialTagGesture = null;
    if (state.opened) {
        markGalleryRadialTagClickSuppressed(state.image);
    }
    clearTimeout(state.timer);
    closeGalleryRadialTagMenu();
    releaseGalleryRadialTagPointer(state);
}

function isGalleryRadialTagPointerTarget(event) {
    if (window.Daki?.isProjectView?.()) return null;
    if (!galleryDesignSettings.radialTagMenuEnabled) return null;
    if (event.pointerType !== 'mouse' || event.button !== 0) return null;
    if (isGalleryBulkDeleteMode || isGalleryTagAssignmentMode || galleryMultiFolderSelection.size > 0) return null;

    const target = event.target?.closest?.('.zoomable');
    if (!target || target.tagName !== 'IMG') return null;
    if (event.target.closest?.('button, a, input, select, textarea, .gallery-card-actions')) return null;

    return target;
}

function beginGalleryRadialTagGesture(event) {
    const image = isGalleryRadialTagPointerTarget(event);
    if (!image) return;

    cancelGalleryRadialTagGesture();
    const card = image.closest('.item-box');
    const imagePath = normalizeGalleryPathKey(card?.dataset.path || image.getAttribute('src') || '');
    if (!imagePath) return;

    const state = {
        image,
        imagePath,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        centerX: event.clientX,
        centerY: event.clientY,
        moved: false,
        opened: false,
        selectedIndex: -1,
        items: [],
        timer: null
    };
    galleryRadialTagGesture = state;

    try {
        image.setPointerCapture(event.pointerId);
    } catch (error) {
        // Pointer capture is a convenience; document listeners still handle cancellation.
    }

    state.timer = setTimeout(() => {
        if (galleryRadialTagGesture !== state || state.moved || !galleryDesignSettings.radialTagMenuEnabled) return;
        showGalleryRadialTagMenu(state);
    }, GALLERY_RADIAL_TAG_LONG_PRESS_MS);
}

function updateGalleryRadialTagGesture(event) {
    const state = galleryRadialTagGesture;
    if (!state || state.pointerId !== event.pointerId) return;

    const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
    if (!state.opened) {
        if (distance > GALLERY_RADIAL_TAG_MOVE_THRESHOLD) {
            state.moved = true;
            cancelGalleryRadialTagGesture();
        }
        return;
    }

    event.preventDefault();
    updateGalleryRadialTagSelection(event, state);
}

function finishGalleryRadialTagGesture(event) {
    const state = galleryRadialTagGesture;
    if (!state || state.pointerId !== event.pointerId) return;

    clearTimeout(state.timer);
    galleryRadialTagGesture = null;
    releaseGalleryRadialTagPointer(state);

    if (!state.opened) return;

    event.preventDefault();
    event.stopPropagation();
    updateGalleryRadialTagSelection(event, state);
    markGalleryRadialTagClickSuppressed(state.image);
    const selected = state.items[state.selectedIndex];
    closeGalleryRadialTagMenu();
    if (selected) {
        updateGalleryImageTag(state.imagePath, selected.tagId);
    }
}

function cancelGalleryRadialTagOnLostCapture(event) {
    if (galleryRadialTagGesture?.image === event.target) {
        cancelGalleryRadialTagGesture();
    }
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
        notifyGalleryTagsUpdated();

        closeGalleryTagPicker();

        if (currentGalleryTagFilter === 'ALL' || window.Daki?.isActive()) {
            updateGalleryImageTagButtonDom(imagePath);
        } else {
            renderView();
        }

        showToast(json.tag_id ? '태그를 지정했습니다.' : '태그를 제거했습니다.');
        return true;
    } catch (error) {
        alert(`태그 변경 실패: ${error.message || error}`);
        return false;
    }
}

async function applySelectedGalleryTagToImage(imagePath) {
    if (!isGalleryTagAssignmentMode) return false;

    if (!selectedGalleryAssignmentTagId) {
        showToast('먼저 아래 태그를 선택하세요.');
        return true;
    }

    if (galleryTagAssignmentBusy) {
        return true;
    }

    galleryTagAssignmentBusy = true;

    try {
        await updateGalleryImageTag(
            imagePath,
            selectedGalleryAssignmentTagId === 'NONE' ? '' : selectedGalleryAssignmentTagId
        );
    } finally {
        galleryTagAssignmentBusy = false;
    }

    return true;
}

function renderGalleryImageTagButton(imagePath, tagId) {
    const tag = getGalleryTagDef(tagId);
    const cleanPath = normalizeGalleryPathKey(imagePath);
    const safeDataPath = escapeHtml(cleanPath);
    const safeOnclickPath = JSON.stringify(imagePath).replace(/"/g, '&quot;');

    if (!tag) {
        return `
            <button class="gallery-image-tag-btn empty-tag"
                    data-gallery-tag-path="${safeDataPath}"
                    title="태그 추가"
                    onclick="openGalleryImageTagPicker(event, ${safeOnclickPath})">
                +
            </button>
        `;
    }

    return `
        <button class="gallery-image-tag-btn has-tag"
                data-gallery-tag-path="${safeDataPath}"
                title="태그 변경"
                onclick="openGalleryImageTagPicker(event, ${safeOnclickPath})">
            ${renderGalleryTagIcon(tag)}
        </button>
    `;
}

function updateGalleryImageTagButtonDom(imagePath) {
    const cleanPath = normalizeGalleryPathKey(imagePath);
    if (!cleanPath) return;

    const tagId = getGalleryImageTagId(cleanPath);

    document.querySelectorAll('.gallery-image-tag-btn[data-gallery-tag-path]').forEach((button) => {
        const buttonPath = normalizeGalleryPathKey(button.dataset.galleryTagPath || '');
        if (buttonPath !== cleanPath) return;

        button.outerHTML = renderGalleryImageTagButton(cleanPath, tagId);
    });
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
    const isDateMode = getGalleryViewMode() === 'date';
    const label = document.getElementById('main-filter-label');
    const brandSelect = document.getElementById('brandSelect');
    const charChipContainer = document.getElementById('char-chip-container');
    const artStyleSelect = document.getElementById('galleryArtStyleSelect');
    const searchInput = document.getElementById('folder-search');
    const clearBtn = document.getElementById('clear-search');
    const loading = document.getElementById('galleryFilterLoading');

    if (label) {
        label.textContent = isFinal ? '🎨 그림체 필터' : (isDateMode ? '📅 날짜별 보기' : '👑 BRAND FILTER');
        label.style.color = isFinal ? '#f1c40f' : (isDateMode ? '#00f2ff' : '#ff007c');
    }

    if (brandSelect) brandSelect.style.display = isFinal || isDateMode ? 'none' : '';

    if (charChipContainer) {
        // 최종 이미지 폴더에서는 캐릭터 칩을 숨긴다.
        // 단, currentSelectedBrand/currentSelectedChar 값은 유지해서
        // Duo/Group 상위로 돌아왔을 때 선택 상태가 복원되게 한다.
        if (isFinal || isDateMode) {
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
            : (isDateMode ? '🔍 날짜 그룹 이름 검색...' : '🔍 폴더 이름 실시간 검색...');

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

let galleryDataStatusTimer = null;

function stopGalleryDataStatusPolling() {
    if (galleryDataStatusTimer) {
        clearInterval(galleryDataStatusTimer);
        galleryDataStatusTimer = null;
    }
}

function formatGalleryElapsed(seconds) {
    const value = Number(seconds || 0);

    if (!Number.isFinite(value) || value <= 0) {
        return '0.0초';
    }

    const minutes = Math.floor(value / 60);
    const remain = value - minutes * 60;

    if (minutes > 0) {
        return `${minutes}분 ${remain.toFixed(1)}초`;
    }

    return `${remain.toFixed(1)}초`;
}

function renderGalleryDataLoadingState(statusPayload = {}) {
    const content = document.getElementById('content');
    if (!content) return;

    if (typeof statusPayload === 'string') {
        statusPayload = { message: statusPayload };
    }

    const phase = statusPayload.phase || 'request';
    const message = statusPayload.message || '갤러리 데이터를 불러오는 중입니다.';
    const elapsed = formatGalleryElapsed(statusPayload.elapsed);
    const folders = Number(statusPayload.folders || 0);
    const images = Number(statusPayload.images || 0);
    const indexMode = statusPayload.index_mode || '';
    const isSlow = Number(statusPayload.elapsed || 0) >= 30;

    content.innerHTML = `
        <div class="gallery-load-state">
            <div class="gallery-load-spinner"></div>
            <div class="gallery-load-title">데이터 동기화 중...</div>
            <div class="gallery-load-message">${escapeHtml(message)}</div>
            <div class="gallery-load-detail">
                <span>단계: ${escapeHtml(phase)}</span>
                <span>경과: ${elapsed}</span>
                <span>폴더: ${folders.toLocaleString()}개</span>
                <span>이미지: ${images.toLocaleString()}장</span>
                ${indexMode ? `<span>모드: ${escapeHtml(indexMode)}</span>` : ''}
            </div>
            <div class="gallery-load-hint">
                ${isSlow
                    ? '이미지가 많거나 기존 스캔 방식이면 시간이 걸릴 수 있습니다. 서버가 계속 진행 중이면 기다려 주세요.'
                    : '이미지가 많으면 첫 로딩에 시간이 걸릴 수 있습니다.'}
            </div>
            <div class="gallery-load-actions">
                <button type="button" onclick="loadData()">다시 시도</button>
                <button type="button" class="secondary" onclick="location.reload()">페이지 새로고침</button>
            </div>
        </div>
    `;
}

function renderGalleryDataErrorState(message) {
    const content = document.getElementById('content');
    if (!content) return;
    content.innerHTML = `
        <div class="gallery-load-state error">
            <div class="gallery-load-title">갤러리 로딩 실패</div>
            <div class="gallery-load-message">${escapeHtml(message || '연결 실패 또는 서버 오류가 발생했습니다.')}</div>
            <div class="gallery-load-hint">서버 로그를 확인한 뒤 다시 시도하거나 페이지를 새로고침해 주세요.</div>
            <div id="galleryIndexProgress" class="gallery-index-progress"></div>
            <div class="gallery-load-actions">
                <button type="button" onclick="loadData()">다시 시도</button>
                <button type="button" class="secondary" onclick="location.reload()">페이지 새로고침</button>
            </div>
        </div>
    `;
}

function renderGalleryIndexNeededState(payload = {}) {
    stopGalleryDataStatusPolling();

    const content = document.getElementById('content');
    if (!content) return;

    const message = payload.message || '빠른 갤러리 인덱스가 아직 없습니다.';
    const isAutoRunning = Boolean(payload.auto_rebuild_started || payload.rebuild_running);

    content.innerHTML = `
        <div class="gallery-load-state index-needed">
            <div class="gallery-load-title">${isAutoRunning ? '⚡ 갤러리 인덱스 자동 생성 중' : '⚡ 갤러리 인덱스가 필요합니다'}</div>
            <div class="gallery-load-message">${escapeHtml(message)}</div>
            <div class="gallery-load-hint">
                기존 분류 결과는 그대로 유지됩니다. 이미지나 폴더를 변경하지 않고,
                현재 TOTAL_CLASSIFIED 구조를 DB 인덱스로 기록해서 다음 로딩부터 빠르게 엽니다.
                ${isAutoRunning ? '<br>자동 생성이 진행 중입니다. 완료되면 갤러리를 다시 불러옵니다.' : ''}
            </div>
            <div id="galleryIndexProgress" class="gallery-index-progress"></div>
            <div class="gallery-load-actions">
                <button type="button" onclick="startGalleryIndexRebuild()">${isAutoRunning ? '인덱스 생성 다시 확인' : '갤러리 인덱스 만들기/복구'}</button>
                <button type="button" class="secondary" onclick="loadData({ allowScan: true })">기존 방식으로 느리게 열기</button>
                <button type="button" class="secondary" onclick="location.reload()">페이지 새로고침</button>
            </div>
        </div>
    `;
}

async function pollGalleryDataStatusOnce() {
    try {
        const res = await fetch(`/api/data/status?ts=${Date.now()}`, { cache: 'no-store' });
        const status = await res.json();

        if (!status || status.status === 'error') {
            return;
        }

        if (!galleryDataStatusTimer) {
            return;
        }

        if (status.running || status.phase !== 'idle') {
            renderGalleryDataLoadingState(status);
        }
    } catch (e) {
        console.warn('Gallery data status polling failed:', e);
    }
}

function startGalleryDataStatusPolling() {
    stopGalleryDataStatusPolling();

    renderGalleryDataLoadingState({
        phase: 'request',
        message: '갤러리 데이터 요청을 보내는 중입니다.',
        elapsed: 0,
        folders: 0,
        images: 0
    });

    galleryDataStatusTimer = setInterval(pollGalleryDataStatusOnce, 1000);
    pollGalleryDataStatusOnce();
}

async function loadData(options = {}) {
    const dataGeneration = ++galleryDataRequestGeneration;
    galleryVirtualRenderGeneration += 1;
    galleryCatalogLoader?.cancel();
    try {
        clearGalleryMultiFolderSelection(false);
        const sessionState = readGallerySessionState();

        startGalleryDataStatusPolling();

        let mode = getGalleryRadioValue('viewMode', 'general');
        if (getGalleryViewMode() === 'virtual' && mode === 'trash') {
            mode = 'all';
            setGalleryRadioValue('viewMode', 'all');
        }
        const selectedSort = galleryFolderSort;
        // 서버 폴더 정렬 계약은 이름/개수만 사용한다. 이미지 시간 정렬은
        // 현재 로드된 이미지 목록에서 renderImageGrid가 처리한다.
        const sort = selectedSort === 'count' ? 'count' : 'name';
        const selectedModelFamily = getGalleryRadioValue('modelFamily', modelFamily);
        modelFamily = GALLERY_MODEL_FAMILY_VALUES.has(selectedModelFamily)
            ? selectedModelFamily
            : 'all';

        saveGalleryPersistentUi();

        const allowScan = Boolean(options.allowScan);
        const url = `/api/data?mode=${encodeURIComponent(mode)}&sort=${encodeURIComponent(sort)}&model_family=${encodeURIComponent(modelFamily)}${allowScan ? '&allow_scan=1' : ''}&catalog=1`;

        const res = await fetch(url, {
            cache: 'no-store'
        });
        const json = await res.json();
        if (dataGeneration !== galleryDataRequestGeneration) return;

        if (!res.ok || json.status === 'error') {
            throw new Error(json.error || json.message || `HTTP ${res.status}`);
        }

        if (json.needs_index || json.index_mode === 'needs_index') {
            renderGalleryIndexNeededState(json);

            if (json.auto_rebuild_started || json.rebuild_running) {
                pollGalleryIndexStatus();
            }

            return;
        }

        stopGalleryDataStatusPolling();

        if (json.index_mode === 'scan_fallback') {
            console.info('Gallery index unavailable; using scan fallback.');
        }

        rootTree = json.tree;
        galleryCatalogLoader = json.catalog_mode ? createGalleryCatalogLoader(async page => {
            const response = await fetch('/api/gallery/images', {
                method: 'POST', headers: {'Content-Type': 'application/json'}, cache: 'no-store',
                body: JSON.stringify({...page, mode, model_family: selectedModelFamily})
            });
            const data = await response.json();
            if (!response.ok || data.status === 'error') throw new Error(data.message || '이미지 목록을 불러오지 못했습니다.');
            return data;
        }) : null;
        baseDir = json.baseDir;
        globalBrandMap = json.brand_map || {};
        globalBrandVisibility = json.brand_visibility || {};
        galleryServerSessionId = String(json.server_session_id || '');

        const galleryTagsPayload = json.gallery_tags || {};
        galleryTagDefs = Array.isArray(galleryTagsPayload.tags) ? galleryTagsPayload.tags : [];
        galleryImageTags = galleryTagsPayload.image_tags || {};
        window.Daki?.refreshTags();
        notifyGalleryTagsUpdated();

        if (getGalleryViewMode() === 'virtual') {
            try {
                await loadGalleryVirtualFolders();
            } catch (error) {
                showToast(`가상 폴더 목록 로드 실패: ${error.message || error}`);
            }
        }

        const canRestoreSession =
            sessionState &&
            galleryServerSessionId &&
            sessionState.serverSessionId === galleryServerSessionId;

        if (canRestoreSession) {
            if (getGalleryViewMode() === 'virtual' && galleryVirtualRootNode) {
                const virtualKeys = Array.isArray(sessionState.pathKeys) ? sessionState.pathKeys : [];
                const virtualPath = [rootTree, galleryVirtualRootNode];
                virtualKeys.slice(1).forEach(key => {
                    const id = String(key || '').replace(/^__gallery_virtual__\//, '');
                    const match = galleryVirtualFolderMap.get(id);
                    if (match) virtualPath.push(match);
                });
                currentPath = virtualPath;
            } else {
                const restoredPath = restoreGalleryPathFromKeys(sessionState.pathKeys);
                currentPath = restoredPath.length > 1 ? restoredPath : getDefaultGalleryPath();
            }
            if (getGalleryViewMode() === 'date') {
                currentPath = currentPath[1] ? [rootTree, currentPath[1]] : getDefaultGalleryPath();
            }

            searchText = String(sessionState.searchText || '').toLowerCase().trim();
            if (getGalleryViewMode() === 'date') searchText = '';
            currentSelectedBrand = sessionState.currentSelectedBrand || 'ALL';
            currentSelectedChar = sessionState.currentSelectedChar || 'ALL';
            currentSelectedGalleryArtStyle = sessionState.currentSelectedGalleryArtStyle || 'ALL';
            currentGalleryTagFilter = sessionState.currentGalleryTagFilter || 'ALL';
            galleryPendingScrollY = Number(sessionState.scrollY || 0);
        } else {
            clearGallerySessionState();
            currentPath = getGalleryViewMode() === 'virtual' && galleryVirtualRootNode
                ? [rootTree, galleryVirtualRootNode]
                : getDefaultGalleryPath();

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
        const rendering = renderView();
        if (json.auto_rebuild_started || json.rebuild_running) {
            pollGalleryIndexStatus();
        }
        refreshGalleryPromptIndexStatus().catch(() => {});

        if (galleryPendingScrollY !== null) {
            const scrollY = galleryPendingScrollY;
            galleryPendingScrollY = null;
            const generation = galleryVirtualRenderGeneration;
            Promise.resolve(rendering).then(() => {
                if (generation !== galleryVirtualRenderGeneration) return;
                return Promise.all([...galleryImageRenderSessions].map(session => session.firstBatchReady));
            }).then(() => requestAnimationFrame(() => {
                if (generation === galleryVirtualRenderGeneration && !window.Daki?.isActive()) window.scrollTo(0, scrollY);
            }));
        }
    } catch (e) {
        if (dataGeneration !== galleryDataRequestGeneration) return;
        console.error(e);
        stopGalleryDataStatusPolling();
        renderGalleryDataErrorState(e.message || e);
    } finally {
        if (dataGeneration === galleryDataRequestGeneration) stopGalleryDataStatusPolling();
    }
}

window.onload = () => {
    applyGalleryHeaderToolsCollapsedState();
    loadGalleryPersistentUi();
    loadGalleryDesignSettings();
    loadGalleryCharacterNameOverrides();
    syncReasonVisibility();
    bindGalleryNavTabsScroller();
    bindGallerySelectionEvents();
    initializeGalleryScrollNavigation();
    pollGalleryIndexStatus();
    loadData();
};
window.onscroll = function() {
    topBtn.style.display = document.documentElement.scrollTop > 500 ? "block" : "none";
    scheduleGalleryScrollNavigationUpdate();
};
function scrollToTop() { window.scrollTo({ top: 0, behavior: 'smooth' }); }

function getGalleryScrollNavigationDotCount(maxScroll) {
    const viewportHeight = Math.max(window.innerHeight || 0, 1);
    return Math.max(
        GALLERY_SCROLL_NAV_MIN_DOTS,
        Math.min(
            GALLERY_SCROLL_NAV_MAX_DOTS,
            Math.ceil(maxScroll / Math.max(viewportHeight * 0.8, 1)) + 1
        )
    );
}

function scheduleGalleryScrollNavigationUpdate() {
    if (galleryScrollNavigationFrame) return;

    galleryScrollNavigationFrame = requestAnimationFrame(() => {
        galleryScrollNavigationFrame = 0;
        updateGalleryScrollNavigation();
    });
}

function getGalleryScrollNavigationElements() {
    if (!galleryScrollNavigation) return null;

    const dots = galleryScrollNavigation.querySelector('.gallery-scroll-nav-dots');
    const scrollbarGuide = galleryScrollbarDestinationGuide;
    const scrollbarTrack = scrollbarGuide?.querySelector('.gallery-scrollbar-track');
    const scrollbarThumb = scrollbarGuide?.querySelector('.gallery-scrollbar-thumb');
    const scrollbarMarks = scrollbarGuide?.querySelector('.gallery-scrollbar-marks');

    if (!dots || !scrollbarGuide || !scrollbarTrack || !scrollbarThumb || !scrollbarMarks) return null;
    return { dots, scrollbarGuide, scrollbarTrack, scrollbarThumb, scrollbarMarks };
}

function syncGalleryScrollNavigationGuideHighlight() {
    const elements = getGalleryScrollNavigationElements();
    if (!elements) return;

    const highlightedIndex = galleryScrollNavigationFocusedIndex !== null
        ? galleryScrollNavigationFocusedIndex
        : galleryScrollNavigationHoveredIndex;
    if (highlightedIndex === null) {
        delete elements.scrollbarGuide.dataset.highlightedIndex;
    } else {
        elements.scrollbarGuide.dataset.highlightedIndex = String(highlightedIndex);
    }

    elements.scrollbarMarks
        .querySelectorAll('.gallery-scrollbar-destination-guide-marker')
        .forEach((marker, index) => {
            marker.classList.toggle('is-highlighted', index === highlightedIndex);
        });
}

function resetGalleryScrollNavigationGuideHighlight() {
    galleryScrollNavigationHoveredIndex = null;
    galleryScrollNavigationFocusedIndex = null;
    syncGalleryScrollNavigationGuideHighlight();
}

function getGalleryScrollNavigationBehavior() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
        ? 'auto'
        : 'smooth';
}

function scrollGalleryScrollNavigationToRatio(ratio, behavior = getGalleryScrollNavigationBehavior()) {
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const boundedRatio = Math.min(1, Math.max(0, Number(ratio) || 0));
    window.scrollTo({ top: maxScroll * boundedRatio, behavior });
}

function getGalleryScrollbarMetrics(elements) {
    const trackHeight = elements.scrollbarTrack.clientHeight
        || elements.scrollbarTrack.getBoundingClientRect().height
        || Math.max(window.innerHeight || 0, 1);
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const documentHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight || 0, 1);
    const thumbHeight = Math.min(
        trackHeight,
        Math.max(GALLERY_SCROLLBAR_MIN_THUMB, trackHeight * Math.min(1, window.innerHeight / documentHeight))
    );
    return {
        trackHeight,
        thumbHeight,
        maxThumbOffset: Math.max(trackHeight - thumbHeight, 0),
        maxScroll
    };
}

function stopGalleryScrollNavigationDrag() {
    if (!galleryScrollbarDragState) return;

    const { thumb, pointerId } = galleryScrollbarDragState;
    try {
        if (thumb.hasPointerCapture(pointerId)) thumb.releasePointerCapture(pointerId);
    } catch (error) {
        // Pointer capture can already be released when the browser cancels a touch.
    }
    thumb.classList.remove('is-dragging');
    galleryScrollbarDragState = null;
}

function bindGalleryScrollbarInteractions(elements) {
    if (!elements || elements.scrollbarTrack.dataset.interactionsBound === '1') return;

    const { scrollbarTrack: track, scrollbarThumb: thumb } = elements;
    track.dataset.interactionsBound = '1';

    thumb.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;

        const metrics = getGalleryScrollbarMetrics(elements);
        if (metrics.maxThumbOffset <= 0) return;

        event.preventDefault();
        galleryScrollbarDragState = {
            pointerId: event.pointerId,
            startY: event.clientY,
            startScrollY: window.scrollY || document.documentElement.scrollTop || 0,
            metrics
        };
        thumb.classList.add('is-dragging');
        thumb.setPointerCapture(event.pointerId);
    });

    thumb.addEventListener('pointermove', (event) => {
        if (!galleryScrollbarDragState || galleryScrollbarDragState.pointerId !== event.pointerId) return;

        const { startY, startScrollY, metrics } = galleryScrollbarDragState;
        const ratio = metrics.maxThumbOffset > 0
            ? (startScrollY / Math.max(metrics.maxScroll, 1))
                + ((event.clientY - startY) / metrics.maxThumbOffset)
            : 0;
        scrollGalleryScrollNavigationToRatio(ratio, 'auto');
    });

    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((eventName) => {
        thumb.addEventListener(eventName, () => {
            if (!galleryScrollbarDragState) return;
            stopGalleryScrollNavigationDrag();
            scheduleGalleryScrollNavigationUpdate();
        });
    });

    track.addEventListener('click', (event) => {
        if (event.target === thumb || galleryScrollbarDragState) return;

        const metrics = getGalleryScrollbarMetrics(elements);
        if (metrics.maxThumbOffset <= 0) return;

        const trackRect = track.getBoundingClientRect();
        const clickOffset = event.clientY - trackRect.top - (metrics.thumbHeight / 2);
        scrollGalleryScrollNavigationToRatio(clickOffset / metrics.maxThumbOffset, 'auto');
    });

    track.addEventListener('keydown', (event) => {
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        if (maxScroll <= 0) return;

        const currentScroll = window.scrollY || document.documentElement.scrollTop || 0;
        const pageStep = Math.max(window.innerHeight || 0, 1);
        let nextScroll = null;
        switch (event.key) {
            case 'Home':
                nextScroll = 0;
                break;
            case 'End':
                nextScroll = maxScroll;
                break;
            case 'PageUp':
                nextScroll = currentScroll - pageStep;
                break;
            case 'PageDown':
                nextScroll = currentScroll + pageStep;
                break;
            case 'ArrowUp':
                nextScroll = currentScroll - 80;
                break;
            case 'ArrowDown':
                nextScroll = currentScroll + 80;
                break;
            default:
                return;
        }

        event.preventDefault();
        scrollGalleryScrollNavigationToRatio(nextScroll / maxScroll);
    });
}

function updateGalleryScrollNavigation() {
    if (!galleryScrollNavigation) return;

    const elements = getGalleryScrollNavigationElements();
    if (!elements) return;

    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const minScroll = Math.max(
        GALLERY_SCROLL_NAV_MIN_SCROLL,
        Math.round(window.innerHeight * GALLERY_SCROLL_NAV_MIN_SCROLL_RATIO)
    );

    if (maxScroll < minScroll) {
        document.documentElement.classList.remove('gallery-scrollbar-custom');
        stopGalleryScrollNavigationDrag();
        galleryScrollNavigation.classList.remove('is-visible');
        elements.dots.replaceChildren();
        elements.scrollbarGuide.classList.remove('is-visible');
        elements.scrollbarMarks.replaceChildren();
        elements.scrollbarThumb.style.height = '0px';
        elements.scrollbarThumb.style.top = '0px';
        elements.scrollbarTrack.setAttribute('aria-valuenow', '0');
        elements.scrollbarTrack.setAttribute('aria-valuetext', '0%');
        delete galleryScrollNavigation.dataset.dotCount;
        delete elements.scrollbarGuide.dataset.dotCount;
        resetGalleryScrollNavigationGuideHighlight();
        return;
    }

    document.documentElement.classList.add('gallery-scrollbar-custom');
    const dotCount = getGalleryScrollNavigationDotCount(maxScroll);
    if (galleryScrollNavigation.dataset.dotCount !== String(dotCount)) {
        resetGalleryScrollNavigationGuideHighlight();
        elements.dots.replaceChildren();
        elements.scrollbarMarks.replaceChildren();
        galleryScrollNavigation.dataset.dotCount = String(dotCount);
        elements.scrollbarGuide.dataset.dotCount = String(dotCount);

        for (let index = 0; index < dotCount; index += 1) {
            const dot = document.createElement('button');
            dot.type = 'button';
            dot.className = 'gallery-scroll-nav-dot';
            dot.title = `페이지 ${index + 1}/${dotCount}로 이동`;
            dot.setAttribute('aria-label', `페이지 ${index + 1}/${dotCount}로 이동`);
            dot.addEventListener('mouseenter', () => {
                galleryScrollNavigationHoveredIndex = index;
                syncGalleryScrollNavigationGuideHighlight();
            });
            dot.addEventListener('mouseleave', () => {
                if (galleryScrollNavigationHoveredIndex === index) {
                    galleryScrollNavigationHoveredIndex = null;
                    syncGalleryScrollNavigationGuideHighlight();
                }
            });
            dot.addEventListener('focus', () => {
                galleryScrollNavigationFocusedIndex = index;
                syncGalleryScrollNavigationGuideHighlight();
            });
            dot.addEventListener('blur', () => {
                if (galleryScrollNavigationFocusedIndex === index) {
                    galleryScrollNavigationFocusedIndex = null;
                    syncGalleryScrollNavigationGuideHighlight();
                }
            });
            dot.addEventListener('click', (event) => {
                scrollGalleryScrollNavigationToRatio(index / Math.max(dotCount - 1, 1));
                if (event.detail > 0) dot.blur();
            });
            elements.dots.appendChild(dot);

            const guideMarker = document.createElement('span');
            guideMarker.className = 'gallery-scrollbar-destination-guide-marker';
            guideMarker.dataset.index = String(index);
            guideMarker.setAttribute('aria-hidden', 'true');
            elements.scrollbarMarks.appendChild(guideMarker);
        }
    }

    galleryScrollNavigation.classList.add('is-visible');
    elements.scrollbarGuide.classList.add('is-visible');
    const scrollRatio = maxScroll > 0
        ? Math.min(1, Math.max(0, (window.scrollY || document.documentElement.scrollTop || 0) / maxScroll))
        : 0;
    const navRect = galleryScrollNavigation.getBoundingClientRect();
    const dots = elements.dots.querySelectorAll('.gallery-scroll-nav-dot');
    const guideMarkers = elements.scrollbarMarks.querySelectorAll('.gallery-scrollbar-destination-guide-marker');
    const activeIndex = Math.round(scrollRatio * (dotCount - 1));
    const dotRailHeight = Math.max((navRect.height || window.innerHeight || 0) - (GALLERY_SCROLLBAR_TRACK_INSET * 2), 1);
    const scrollbarMarkHeight = Math.max(
        elements.scrollbarMarks.clientHeight || window.innerHeight - (GALLERY_SCROLLBAR_TRACK_INSET * 2),
        1
    );
    const highlightedIndex = galleryScrollNavigationFocusedIndex !== null
        ? galleryScrollNavigationFocusedIndex
        : galleryScrollNavigationHoveredIndex;

    dots.forEach((dot, index) => {
        const dotRatio = index / Math.max(dotCount - 1, 1);
        dot.style.top = `${GALLERY_SCROLLBAR_TRACK_INSET + dotRatio * dotRailHeight}px`;
        const isActive = index === activeIndex;
        dot.classList.toggle('is-active', isActive);
        if (isActive) {
            dot.setAttribute('aria-current', 'true');
        } else {
            dot.removeAttribute('aria-current');
        }
    });

    guideMarkers.forEach((marker, index) => {
        const dotRatio = index / Math.max(dotCount - 1, 1);
        marker.style.top = `${dotRatio * scrollbarMarkHeight}px`;
        marker.classList.toggle('is-highlighted', index === highlightedIndex);
    });

    const scrollbarMetrics = getGalleryScrollbarMetrics(elements);
    elements.scrollbarThumb.style.height = `${scrollbarMetrics.thumbHeight}px`;
    elements.scrollbarThumb.style.top = `${scrollRatio * scrollbarMetrics.maxThumbOffset}px`;
    elements.scrollbarTrack.setAttribute('aria-valuenow', String(Math.round(scrollRatio * 100)));
    elements.scrollbarTrack.setAttribute('aria-valuetext', `${Math.round(scrollRatio * 100)}%`);
}

function initializeGalleryScrollNavigation() {
    if (galleryScrollNavigationInitialized || !galleryScrollNavigation) return;

    const elements = getGalleryScrollNavigationElements();
    if (!elements) return;

    galleryScrollNavigationInitialized = true;
    document.documentElement.classList.add('gallery-scrollbar-custom');
    bindGalleryScrollbarInteractions(elements);
    window.addEventListener('resize', scheduleGalleryScrollNavigationUpdate, { passive: true });

    if (typeof ResizeObserver === 'function') {
        galleryScrollNavigationResizeObserver = new ResizeObserver(scheduleGalleryScrollNavigationUpdate);
        galleryScrollNavigationResizeObserver.observe(document.documentElement);

        const content = document.getElementById('content');
        if (content) galleryScrollNavigationResizeObserver.observe(content);
    }

    scheduleGalleryScrollNavigationUpdate();
}

function bindGalleryNavTabsScroller() {
    const navTabs = document.getElementById('nav-tabs');
    if (!navTabs || navTabs.dataset.scrollUxBound === '1') return;

    navTabs.dataset.scrollUxBound = '1';

    navTabs.addEventListener('wheel', (event) => {
        if (navTabs.scrollWidth <= navTabs.clientWidth) return;

        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY;

        navTabs.scrollLeft += delta;
        event.preventDefault();
    }, { passive: false });

    navTabs.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        if (navTabs.scrollWidth <= navTabs.clientWidth) return;

        galleryNavTabsDragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startScrollLeft: navTabs.scrollLeft,
            moved: false,
            captured: false
        };
    });

    navTabs.addEventListener('pointermove', (event) => {
        if (!galleryNavTabsDragState) return;
        if (galleryNavTabsDragState.pointerId !== event.pointerId) return;

        const dx = event.clientX - galleryNavTabsDragState.startX;

        if (Math.abs(dx) > GALLERY_NAV_TABS_DRAG_THRESHOLD) {
            galleryNavTabsDragState.moved = true;

            if (!galleryNavTabsDragState.captured) {
                galleryNavTabsDragState.captured = true;
                navTabs.classList.add('dragging-nav-tabs');

                try {
                    navTabs.setPointerCapture(event.pointerId);
                } catch (error) {
                    // Pointer capture may fail if pointer is already released.
                }
            }
        }

        if (!galleryNavTabsDragState.moved) return;

        navTabs.scrollLeft = galleryNavTabsDragState.startScrollLeft - dx;
        event.preventDefault();
    });

    const finishDrag = (event) => {
        if (!galleryNavTabsDragState) return;
        if (galleryNavTabsDragState.pointerId !== event.pointerId) return;

        const wasMoved = galleryNavTabsDragState.moved;
        const wasCaptured = galleryNavTabsDragState.captured;

        galleryNavTabsDragState = null;
        navTabs.classList.remove('dragging-nav-tabs');

        if (wasCaptured) {
            try {
                navTabs.releasePointerCapture(event.pointerId);
            } catch (error) {
                // Already released.
            }
        }

        if (wasMoved) {
            navTabs.dataset.suppressNextClick = '1';
            setTimeout(() => {
                if (navTabs.dataset.suppressNextClick === '1') {
                    delete navTabs.dataset.suppressNextClick;
                }
            }, 0);
        }
    };

    navTabs.addEventListener('pointerup', finishDrag);
    navTabs.addEventListener('pointercancel', finishDrag);
    navTabs.addEventListener('lostpointercapture', () => {
        galleryNavTabsDragState = null;
        navTabs.classList.remove('dragging-nav-tabs');
    });

    navTabs.addEventListener('click', (event) => {
        if (navTabs.dataset.suppressNextClick === '1') {
            delete navTabs.dataset.suppressNextClick;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
        }
    }, true);
}

document.addEventListener('pointerdown', beginGalleryRadialTagGesture, true);
document.addEventListener('pointermove', updateGalleryRadialTagGesture, true);
document.addEventListener('pointerup', finishGalleryRadialTagGesture, true);
document.addEventListener('pointercancel', cancelGalleryRadialTagGesture, true);
document.addEventListener('lostpointercapture', cancelGalleryRadialTagOnLostCapture, true);
document.addEventListener('click', (event) => {
    if (
        galleryRadialTagSuppressClickElement &&
        Date.now() <= galleryRadialTagSuppressClickUntil &&
        event.target?.closest?.('.zoomable') === galleryRadialTagSuppressClickElement
    ) {
        galleryRadialTagSuppressClickElement = null;
        galleryRadialTagSuppressClickUntil = 0;
        closeGalleryRadialTagMenu();
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
    }

    if (Date.now() > galleryRadialTagSuppressClickUntil) {
        galleryRadialTagSuppressClickElement = null;
    }

    const menu = document.getElementById('imageContextMenu');
    if (menu.style.display === 'block' && !menu.contains(event.target)) closeImageContextMenu();

    const folderMenu = document.getElementById('galleryMultiFolderContextMenu');
    if (folderMenu?.style.display === 'block' && !folderMenu.contains(event.target)) {
        closeGalleryMultiFolderContextMenu();
    }

    const tagPicker = document.getElementById('galleryTagPicker');
    if (tagPicker && tagPicker.classList.contains('open') && !tagPicker.contains(event.target)) {
        closeGalleryTagPicker();
    }

    const headerTools = document.getElementById('galleryHeaderTools');
    const headerToolsToggle = document.getElementById('galleryHeaderToolsToggle');

    if (
        headerTools &&
        headerToolsToggle &&
        !headerTools.classList.contains('collapsed') &&
        !headerTools.contains(event.target) &&
        !headerToolsToggle.contains(event.target)
    ) {
        localStorage.setItem(GALLERY_HEADER_TOOLS_COLLAPSED_KEY, '1');
        applyGalleryHeaderToolsCollapsedState();
    }
});
function bindGallerySelectionEvents() {
    // gallery_selection.js is loaded after this script; bind after page load.
    document.addEventListener('pointerdown', beginGalleryBulkDeleteBoxSelection);
    document.addEventListener('pointermove', updateGalleryBulkDeleteBoxSelection);
    document.addEventListener('pointerup', finishGalleryBulkDeleteBoxSelection);
    document.addEventListener('pointercancel', cancelGalleryBulkDeleteBoxSelection);
    document.addEventListener('pointerdown', beginGalleryMultiFolderBoxSelection);
    document.addEventListener('pointermove', updateGalleryMultiFolderBoxSelection);
    document.addEventListener('pointerup', finishGalleryMultiFolderBoxSelection);
    document.addEventListener('pointercancel', cancelGalleryMultiFolderBoxSelection);
}
document.addEventListener('dragstart', (event) => {
    if (!isGalleryBulkDeleteMode && galleryMultiFolderSelection.size === 0) return;

    if (
        event.target.closest?.('.gallery-bulk-delete-selectable') ||
        event.target.closest?.('.zoomable') ||
        event.target.tagName === 'IMG'
    ) {
        event.preventDefault();
    }
});
document.addEventListener('scroll', () => {
    cancelGalleryRadialTagGesture();
    closeImageContextMenu();
    closeGalleryMultiFolderContextMenu();
}, true);
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        cancelGalleryRadialTagGesture();
        closeGalleryRadialTagMenu();
        closeImageContextMenu();
        closeGalleryMultiFolderContextMenu();
        clearGalleryMultiFolderSelection();
        closeRouteTestImagePreview();
        closeGalleryBulkDeleteConfirm();
        closeGalleryVirtualFolderEditor();
        localStorage.setItem(GALLERY_HEADER_TOOLS_COLLAPSED_KEY, '1');
        applyGalleryHeaderToolsCollapsedState();
    }
});
window.addEventListener('blur', cancelGalleryRadialTagGesture);
window.addEventListener('pagehide', () => {
    saveGalleryPersistentUi();
    saveGallerySessionState();
});

window.addEventListener('beforeunload', (event) => {
    if (hasUnsavedFolderRuleChanges()) {
        event.preventDefault();
        event.returnValue = '';
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        cancelGalleryRadialTagGesture();
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

function getCurrentGalleryScopePath() {
    const node = currentPath[currentPath.length - 1];
    return normalizeGalleryPathKey(node?.path || '');
}

function getGalleryPromptSearchMode() {
    return getGalleryRadioValue('viewMode', 'general');
}

function getGalleryPromptSearchScopePaths() {
    const currentNode = currentPath[currentPath.length - 1];
    if (currentNode?.isGalleryVirtualRoot) return [];
    if (currentNode?.isGalleryVirtualFolder) {
        return Array.isArray(currentNode.virtualFolder?.scope_paths)
            ? currentNode.virtualFolder.scope_paths.slice()
            : [];
    }
    if (currentNode?.isGalleryVirtualUnassigned || currentNode?.isGalleryVirtualCharacterGroup) {
        const parent = galleryVirtualFolderMap.get(String(currentNode.virtualParentId || ''));
        return Array.isArray(parent?.scope_paths) ? parent.scope_paths.slice() : [];
    }
    const baseScope = getCurrentGalleryScopePath();

    if (isGalleryDateGroupNode(currentNode)) {
        const scoped = [...new Set((currentNode.images || [])
            .map((item) => getGalleryImageParentInfo(item, currentNode).path)
            .filter(Boolean))];
        return scoped.length ? scoped : (baseScope ? [baseScope] : []);
    }

    if (isCombinedGalleryNode(currentNode)) {
        return currentNode.sourcePaths.slice();
    }

    if (!currentNode || isFinalImageFolder(currentNode) || currentSelectedBrand === 'ALL') {
        return baseScope ? [baseScope] : [];
    }

    const folders = Array.isArray(currentNode.folders) ? currentNode.folders : [];
    const scoped = folders
        .filter(folder => {
            if (!passesGalleryDakiFilter(folder, true)) return false;

            const names = getGalleryFolderCharacterNames(folder);
            const hasSelectedBrand = names.some(name => getGalleryBrandForCharacterName(name) === currentSelectedBrand);

            if (!hasSelectedBrand) return false;

            if (currentSelectedChar !== 'ALL') {
                const normalizedNames = names.map(normalizeGalleryCharacterName);
                if (!normalizedNames.includes(currentSelectedChar)) return false;
            }

            return true;
        })
        .map(folder => normalizeGalleryPathKey(folder.path || getGalleryBulkDeleteFolderKey(folder)))
        .filter(Boolean);

    return scoped.length ? scoped : (baseScope ? [baseScope] : []);
}

function resetGalleryPromptSearchResult() {
    galleryPromptSearchActive = false;
    galleryPromptSearchResult = {
        imagePaths: new Set(),
        folderCounts: new Map(),
        totalMatches: 0,
        indexed: false
    };
}

function clearGalleryPromptSearch() {
    if (galleryPromptSearchRun) {
        galleryPromptSearchRun.discardResults = true;
        cancelGalleryPromptSearch();
    }
    const input = document.getElementById('galleryPromptSearchInput');
    const autocomplete = document.getElementById('galleryPromptAutocomplete');
    const status = document.getElementById('galleryPromptSearchStatus');

    galleryPromptSearchText = '';
    galleryPromptAutocompleteItems = [];
    galleryPromptAutocompleteActiveIndex = -1;
    resetGalleryPromptSearchResult();

    if (input) input.value = '';
    if (autocomplete) autocomplete.innerHTML = '';
    if (status) status.textContent = '프롬프트 검색 대기 중';

    renderView();
    saveGallerySessionState();
}

function getGalleryPromptMatchedFolderCount(folder) {
    if (isGalleryDateGroupNode(folder)) return Number(folder?.total_images || 0);
    if (!galleryPromptSearchActive) return Number(folder?.total_images || 0);

    const key = normalizeGalleryPathKey(folder?.path || getGalleryBulkDeleteFolderKey(folder));
    return Number(galleryPromptSearchResult.folderCounts.get(key) || 0);
}

function galleryPromptSearchMatchesFolder(folder) {
    if (!galleryPromptSearchActive) return true;
    return getGalleryPromptMatchedFolderCount(folder) > 0;
}

function galleryPromptSearchMatchesImage(item) {
    if (!galleryPromptSearchActive) return true;
    return galleryPromptSearchResult.imagePaths.has(normalizeGalleryPathKey(item?.path || ''));
}

function formatGalleryPromptIndexBytes(bytes) {
    const value = Number(bytes || 0);

    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;

    return `${value} B`;
}

function toggleGalleryPromptSearchPanel() {
    galleryPromptSearchOpen = !galleryPromptSearchOpen;

    const panel = document.getElementById('galleryPromptSearchPanel');
    const icon = document.getElementById('galleryPromptSearchToggleIcon');

    if (panel) panel.classList.toggle('collapsed', !galleryPromptSearchOpen);
    if (icon) icon.textContent = galleryPromptSearchOpen ? '▲' : '▼';
}

function handleGalleryPromptSearchInput() {
    galleryPromptSearchText = document.getElementById('galleryPromptSearchInput')?.value || '';
    updateGalleryPromptAutocomplete();
}

async function runGalleryPromptSearch() {
    if (galleryPromptSearchRun) return;
    const input = document.getElementById('galleryPromptSearchInput');
    const status = document.getElementById('galleryPromptSearchStatus');
    const query = String(input?.value || '').trim();

    galleryPromptSearchText = query;

    if (!query) {
        resetGalleryPromptSearchResult();
        if (status) status.textContent = '프롬프트 검색 대기 중';
        renderView();
        saveGallerySessionState();
        return;
    }

    const run = {jobId: '', cancelRequested: false, cancelPromise: null, discardResults: false};
    galleryPromptSearchRun = run;
    updateGalleryPromptSearchControls();
    try {
        const scopePaths = getGalleryPromptSearchScopePaths();
        const scopeLabel = scopePaths.length
            ? ` · 범위 ${scopePaths.length.toLocaleString()}개 폴더`
            : ' · 전체 범위';

        if (status) status.textContent = `프롬프트 검색 준비 중${scopeLabel}`;

        const res = await fetch('/api/gallery/prompt_search/start', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                query,
                scope_paths: scopePaths,
                mode: getGalleryPromptSearchMode()
            })
        });
        const json = await res.json();

        if (!res.ok || json.status === 'error') {
            throw new Error(json.message || '프롬프트 검색 시작 실패');
        }

        run.jobId = json.job?.id;
        if (run.cancelRequested) await requestGalleryPromptSearchCancel(run);
        await pollGalleryPromptSearchJob(run.jobId, scopeLabel, run);
    } catch (e) {
        if (!run.discardResults) {
            if (status) status.textContent = `프롬프트 검색 실패: ${e.message || e}`;
            showToast(`프롬프트 검색 실패: ${e.message || e}`);
        }
    } finally {
        if (galleryPromptSearchRun === run) {
            galleryPromptSearchRun = null;
            updateGalleryPromptSearchControls();
        }
    }
}

function updateGalleryPromptSearchControls() {
    const run = galleryPromptSearchRun;
    const search = document.getElementById('galleryPromptSearchRunBtn');
    const cancel = document.getElementById('galleryPromptSearchCancelBtn');
    if (search) search.disabled = Boolean(run);
    if (cancel) {
        cancel.hidden = !run;
        cancel.disabled = Boolean(run?.cancelRequested);
        cancel.textContent = run?.cancelRequested ? '취소 중…' : '검색 취소';
    }
}

async function requestGalleryPromptSearchCancel(run) {
    if (!run.jobId) return;
    if (run.cancelPromise) return run.cancelPromise;
    run.cancelPromise = (async () => {
        try {
            const res = await fetch(`/api/gallery/prompt_search/cancel/${encodeURIComponent(run.jobId)}`, {method: 'POST'});
            const json = await res.json();
            if (!res.ok || json.status === 'error') throw new Error(json.message || '검색 취소 실패');
            return json.job;
        } catch (error) {
            run.cancelRequested = false;
            showToast(`검색 취소 실패: ${error.message || error}. 다시 취소할 수 있습니다.`);
            return null;
        } finally {
            if (galleryPromptSearchRun === run) updateGalleryPromptSearchControls();
        }
    })();
    const job = await run.cancelPromise;
    if (!run.cancelRequested) run.cancelPromise = null;
    return job;
}

async function cancelGalleryPromptSearch() {
    const run = galleryPromptSearchRun;
    if (!run || run.cancelRequested) return;
    run.cancelRequested = true;
    updateGalleryPromptSearchControls();
    const status = document.getElementById('galleryPromptSearchStatus');
    if (status && !run.discardResults) status.textContent = '검색을 취소하고 지금까지 찾은 결과를 정리하고 있습니다…';
    await requestGalleryPromptSearchCancel(run);
}

async function pollGalleryPromptSearchJob(jobId, scopeLabel = '', run = galleryPromptSearchRun) {
    if (!jobId) throw new Error('검색 작업 ID가 없습니다.');

    const status = document.getElementById('galleryPromptSearchStatus');

    while (galleryPromptSearchRun === run) {
        let json;
        try {
            const res = await fetch(`/api/gallery/prompt_search/status/${encodeURIComponent(jobId)}?ts=${Date.now()}`, {
                cache: 'no-store'
            });
            json = await res.json();
            if (!res.ok || json.status === 'error') {
                const error = new Error(json.message || '프롬프트 검색 상태 조회 실패');
                error.jobUnavailable = res.status >= 400 && res.status < 500;
                throw error;
            }
        } catch (error) {
            if (error.jobUnavailable) throw error;
            if (status && !run.discardResults) status.textContent = '검색 상태 연결을 다시 확인하고 있습니다. 검색 취소는 계속 사용할 수 있습니다.';
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
        }
        if (galleryPromptSearchRun !== run) return;

        const job = json.job || {};
        const total = Number(job.total || 0);
        const processed = Number(job.processed || 0);
        const percent = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;

        if (status && !run.discardResults) {
            const progressText = total
                ? `${processed.toLocaleString()} / ${total.toLocaleString()} (${percent}%)`
                : '대상 계산 중';
            status.textContent = `${run.cancelRequested ? '검색 취소 중...' : job.message || '프롬프트 검색 중...'} · ${progressText}${scopeLabel}`;
        }

        if (job.done || !job.running) {
            // A completed poll may have been sent before the cancellation request.
            if (run.cancelRequested && !job.cancelled && run.cancelPromise) {
                const cancellation = await run.cancelPromise;
                if (cancellation?.cancel_requested) {
                    await new Promise(resolve => setTimeout(resolve, 250));
                    continue;
                }
            }
            if (run.discardResults) return;
            if (job.error) throw new Error(job.error);

            const result = job.result || {};
            galleryPromptSearchActive = true;
            galleryPromptSearchResult = {
                imagePaths: new Set((result.image_paths || []).map(normalizeGalleryPathKey)),
                folderCounts: new Map(
                    Object.entries(result.folder_counts || {})
                        .map(([key, value]) => [normalizeGalleryPathKey(key), Number(value || 0)])
                ),
                totalMatches: Number(result.total_matches || 0),
                indexed: Boolean(result.indexed)
            };

            if (status) {
                const sourceText = galleryPromptSearchResult.indexed ? '인덱스 검색' : '인덱스 없는 직접 검색';
                status.textContent = job.cancelled
                    ? `검색 취소 · 확인한 ${processed.toLocaleString()} / ${total.toLocaleString()}장 · 찾은 이미지 ${galleryPromptSearchResult.totalMatches.toLocaleString()}장 (일부 결과)${scopeLabel}`
                    : `${sourceText} 완료 · 매칭 이미지 ${galleryPromptSearchResult.totalMatches.toLocaleString()}장${scopeLabel}`;
            }

            renderView();
            saveGallerySessionState();
            return;
        }

        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

async function refreshGalleryPromptIndexStatus(jobOnly = false) {
    const scopeLabel = 'TOTAL_CLASSIFIED 전체';
    const mode = 'all';
    const params = new URLSearchParams();
    params.set('mode', mode);
    const useSnapshot = jobOnly && galleryPromptIndexStatusSnapshot;
    if (useSnapshot) params.set('job_only', '1');

    const res = await fetch(`/api/gallery/prompt_index/status?${params.toString()}`);
    const response = await res.json();

    if (!res.ok || response.status === 'error') {
        throw new Error(response.message || '프롬프트 인덱스 상태 조회 실패');
    }
    if (useSnapshot && !response.job?.running) return refreshGalleryPromptIndexStatus();
    const json = useSnapshot ? {...galleryPromptIndexStatusSnapshot, ...response} : response;
    if (!useSnapshot) galleryPromptIndexStatusSnapshot = json;

    const body = document.getElementById('galleryPromptIndexModalBody');
    const job = json.job || {};
    const total = Number(job.total || 0);
    const processed = Number(job.processed || 0);
    const percent = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    const targetImages = Number(json.target_images || 0);
    const missingImages = Number(json.missing_images || 0);
    const indexedImages = Number(json.indexed_images || 0);
    const jobStateText = job.running
        ? `${processed.toLocaleString()} / ${total.toLocaleString()} (${percent}%)`
        : job.error
            ? '실패'
            : job.done
                ? (job.message || '완료')
                : '대기 중';

    if (body) {
        body.innerHTML = `
            <div class="gallery-index-summary"><strong>검색 준비 현황</strong><span class="gallery-index-status ${job.error ? 'error' : job.running ? 'running' : job.done ? 'done' : ''}">${escapeHtml(jobStateText)}</span></div>
            <div class="gallery-index-stats">
                <div class="gallery-index-stat"><span>전체 이미지</span><strong>${targetImages.toLocaleString()}<small>장</small></strong></div>
                <div class="gallery-index-stat"><span>검색 준비 완료</span><strong>${indexedImages.toLocaleString()}<small>장</small></strong></div>
                <div class="gallery-index-stat"><span>새로 추가할 이미지</span><strong>${missingImages.toLocaleString()}<small>장</small></strong></div>
            </div>
            ${job.running || job.total ? renderGalleryIndexMeter(job, '프롬프트 검색 인덱스 진행률') : ''}
            ${job.message ? `<p class="gallery-index-job-message" role="status">${escapeHtml(job.message)}</p>` : ''}
            ${job.error ? `<p class="gallery-index-job-message error" role="alert">${escapeHtml(job.error)}</p>` : ''}
            <div class="gallery-index-detail-list">
                <div class="gallery-index-detail-row"><span>대상 범위</span><b>${escapeHtml(scopeLabel)}</b></div>
                <div class="gallery-index-detail-row"><span>포함 이미지</span><b>일반 + 성인 등급 · 휴지통 제외</b></div>
                <div class="gallery-index-detail-row"><span>텍스트 크기</span><b>${formatGalleryPromptIndexBytes(json.text_bytes)}</b></div>
                <div class="gallery-index-detail-row"><span>마지막 갱신</span><b>${json.updated_at ? new Date(json.updated_at * 1000).toLocaleString() : '아직 없음'}</b></div>
            </div>
            <p class="gallery-index-note">처음 준비할 때는 ‘새 파일만 추가’를 실행하세요. ‘검색 인덱스 갱신’은 새 이미지와 변경된 파일을 읽고, ‘전체 재생성’은 모든 프롬프트를 다시 읽습니다.</p>
        `;
    }
    renderGalleryIndexActivity('prompt', job);
    ['galleryPromptIndexBuildBtn', 'galleryPromptIndexRebuildBtn', 'galleryPromptIndexDeleteBtn'].forEach(id => {
        const button = document.getElementById(id);
        if (button) button.disabled = Boolean(job.running);
    });

    const missingBtn = document.getElementById('galleryPromptIndexMissingBtn');
    if (missingBtn) {
        missingBtn.textContent = missingImages > 0
            ? `새 파일만 추가 (${missingImages.toLocaleString()}장)`
            : '새 파일 없음';
        missingBtn.disabled = missingImages <= 0 || Boolean(job.running);
        missingBtn.title = missingImages > 0
            ? '아직 프롬프트 인덱스에 없는 새 이미지 파일만 추가합니다.'
            : '현재 프롬프트 인덱스에 추가할 새 이미지가 없습니다.';
    }

    const status = document.getElementById('galleryPromptSearchStatus');

    if (status && !galleryPromptSearchRun && !galleryPromptSearchActive) {
        if (job.running) {
            const progressText = total
                ? `${processed.toLocaleString()} / ${total.toLocaleString()} (${percent}%)`
                : '대상 계산 중';
            status.textContent = `프롬프트 검색 인덱스 생성 중 · ${progressText}`;
        } else if (!galleryPromptSearchActive) {
            status.textContent = Number(json.indexed_images || 0) > 0
                ? `프롬프트 검색 인덱스 ${Number(json.indexed_images || 0).toLocaleString()}장 · ${formatGalleryPromptIndexBytes(json.text_bytes)}`
                : '자동완성을 쓰려면 ‘프롬프트 검색 인덱스’에서 ‘새 파일만 추가’를 실행하세요. 인덱스 없이도 검색할 수 있지만 느릴 수 있습니다.';
        }
    }

    if (galleryPromptIndexStatusTimer) {
        clearTimeout(galleryPromptIndexStatusTimer);
        galleryPromptIndexStatusTimer = null;
    }

    if (job.running) {
        galleryPromptIndexStatusTimer = setTimeout(pollGalleryPromptIndexStatus, 500);
    }
}

async function pollGalleryPromptIndexStatus() {
    try {
        await refreshGalleryPromptIndexStatus(true);
    } catch (error) {
        console.warn('Prompt index status refresh failed:', error);
        galleryPromptIndexStatusTimer = setTimeout(pollGalleryPromptIndexStatus, 2000);
    }
}

function openGalleryPromptIndexModal() {
    const layer = document.getElementById('galleryPromptIndexModal');
    showGalleryIndexDialog(layer);
    const body = document.getElementById('galleryPromptIndexModalBody');
    if (body && !body.innerHTML) body.innerHTML = '<p class="gallery-index-note" role="status">검색 인덱스 현황을 확인하고 있습니다…</p>';
    refreshGalleryPromptIndexStatus().catch(e => showToast(e.message || String(e)));
}

async function deleteGalleryPromptIndex() {
    if (!confirm('프롬프트 검색 인덱스를 삭제할까요? 이미지 파일과 갤러리 표시용 인덱스는 삭제하지 않습니다.')) {
        return;
    }

    try {
        const res = await fetch('/api/gallery/prompt_index', { method: 'DELETE' });
        const json = await res.json();

        if (!res.ok || json.status === 'error') {
            throw new Error(json.message || '프롬프트 인덱스 삭제 실패');
        }

        resetGalleryPromptSearchResult();
        const status = document.getElementById('galleryPromptSearchStatus');
        if (status) {
            status.textContent = '프롬프트 검색 인덱스를 삭제해 자동완성을 사용할 수 없습니다. 인덱스 없이도 검색할 수 있지만 느릴 수 있습니다.';
        }
        refreshGalleryPromptIndexStatus().catch(e => showToast(e.message || String(e)));
    } catch (e) {
        showToast(`프롬프트 인덱스 삭제 실패: ${e.message || e}`);
    }
}

function closeGalleryPromptIndexModal() {
    const layer = document.getElementById('galleryPromptIndexModal');
    hideGalleryIndexDialog(layer);
}

async function startGalleryPromptIndexBuild(rebuild) {
    try {
        const missingOnly = rebuild === 'missing';
        const rebuildAll = rebuild === true;
        const scopePaths = [];
        const status = document.getElementById('galleryPromptSearchStatus');
        if (status && !galleryPromptSearchRun && !galleryPromptSearchActive) {
            status.textContent = rebuildAll
                ? '전체 프롬프트 인덱스 재생성 준비 중...'
                : (missingOnly ? '새 파일만 프롬프트 인덱스에 추가 준비 중...' : '전체 프롬프트 인덱스 갱신 준비 중...');
        }
        const res = await fetch('/api/gallery/prompt_index/rebuild', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                scope_paths: scopePaths,
                mode: 'all',
                rebuild: rebuildAll,
                missing_only: missingOnly
            })
        });
        const json = await res.json();

        if (!res.ok || json.status === 'error') {
            throw new Error(json.message || '프롬프트 인덱스 생성 시작 실패');
        }

        renderGalleryIndexActivity('prompt', {...json, running: true});
        closeGalleryPromptIndexModal();
        await refreshGalleryPromptIndexStatus();
    } catch (e) {
        showToast(`프롬프트 인덱스 생성 실패: ${e.message || e}`);
    }
}

function applyGalleryPromptAutocompleteValue(value) {
    const input = document.getElementById('galleryPromptSearchInput');
    const box = document.getElementById('galleryPromptAutocomplete');

    if (!input) return;

    const current = String(input.value || '');
    const next = current.match(/[^\s,\n]+$/)
        ? current.replace(/[^\s,\n]+$/, value)
        : `${current}${value}`;

    input.value = next;
    galleryPromptSearchText = next;
    galleryPromptAutocompleteItems = [];
    galleryPromptAutocompleteActiveIndex = -1;
    if (box) box.innerHTML = '';
    input.focus();
}

function renderGalleryPromptAutocompleteItems() {
    const box = document.getElementById('galleryPromptAutocomplete');
    if (!box) return;

    box.innerHTML = '';

    galleryPromptAutocompleteItems.forEach((item, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = item;
        button.classList.toggle('active', index === galleryPromptAutocompleteActiveIndex);
        button.onclick = () => applyGalleryPromptAutocompleteValue(item);
        box.appendChild(button);
    });
}

function moveGalleryPromptAutocompleteSelection(delta) {
    if (!galleryPromptAutocompleteItems.length) return;

    if (galleryPromptAutocompleteActiveIndex < 0) {
        galleryPromptAutocompleteActiveIndex = delta >= 0 ? 0 : galleryPromptAutocompleteItems.length - 1;
    } else {
        galleryPromptAutocompleteActiveIndex =
            (galleryPromptAutocompleteActiveIndex + delta + galleryPromptAutocompleteItems.length) %
            galleryPromptAutocompleteItems.length;
    }

    renderGalleryPromptAutocompleteItems();
}

function handleGalleryPromptSearchKeydown(event) {
    if (event.key === 'Enter' && galleryPromptAutocompleteActiveIndex < 0) {
        event.preventDefault();
        runGalleryPromptSearch();
        return;
    }

    if (!galleryPromptAutocompleteItems.length) return;

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (galleryPromptAutocompleteActiveIndex < 0) {
            galleryPromptAutocompleteActiveIndex = 0;
        }
        renderGalleryPromptAutocompleteItems();
        return;
    }

    if (event.key === 'ArrowLeft' && galleryPromptAutocompleteActiveIndex >= 0) {
        event.preventDefault();
        moveGalleryPromptAutocompleteSelection(-1);
        return;
    }

    if (event.key === 'ArrowRight' && galleryPromptAutocompleteActiveIndex >= 0) {
        event.preventDefault();
        moveGalleryPromptAutocompleteSelection(1);
        return;
    }

    if (event.key === 'Enter' && galleryPromptAutocompleteActiveIndex >= 0) {
        event.preventDefault();
        applyGalleryPromptAutocompleteValue(galleryPromptAutocompleteItems[galleryPromptAutocompleteActiveIndex]);
    }
}

function updateGalleryPromptAutocomplete() {
    clearTimeout(galleryPromptAutocompleteTimer);

    galleryPromptAutocompleteTimer = setTimeout(async () => {
        const input = document.getElementById('galleryPromptSearchInput');
        const box = document.getElementById('galleryPromptAutocomplete');

        if (!input || !box) return;

        const token = String(input.value || '').split(/[\s,\n]+/).pop().trim();

        if (token.length < 2) {
            galleryPromptAutocompleteItems = [];
            galleryPromptAutocompleteActiveIndex = -1;
            box.innerHTML = '';
            return;
        }

        try {
            const scope = getCurrentGalleryScopePath();
            const mode = getGalleryPromptSearchMode();
            const res = await fetch(`/api/gallery/prompt_index/autocomplete?q=${encodeURIComponent(token)}&scope_path=${encodeURIComponent(scope)}&mode=${encodeURIComponent(mode)}`);
            const json = await res.json();
            const items = Array.isArray(json.items) ? json.items : [];

            galleryPromptAutocompleteItems = items;
            galleryPromptAutocompleteActiveIndex = -1;
            renderGalleryPromptAutocompleteItems();
        } catch (e) {
            console.warn('Prompt autocomplete failed:', e);
            galleryPromptAutocompleteItems = [];
            galleryPromptAutocompleteActiveIndex = -1;
            box.innerHTML = '';
        }
    }, 180);
}

function getGalleryImageSrc(path) {
    const cleanPath = normalizeGalleryPathKey(path);
    const version = galleryImageVersionMap.get(cleanPath);

    const baseSrc = `/image/${encodeURIComponent(cleanPath).replace(/%2F/g, '/')}`;
    return version ? `${baseSrc}?t=${version}` : baseSrc;
}

function getGalleryThumbnailSrc(path) {
    const original = getGalleryImageSrc(path);
    return `${original}${original.includes('?') ? '&' : '?'}preview=768`;
}

function markGalleryImageUpdated(path) {
    const cleanPath = normalizeGalleryPathKey(path);
    galleryImageVersionMap.set(cleanPath, Date.now());
    return getGalleryImageSrc(cleanPath);
}

function openGalleryContextWebpDialog() {
    const path = activeImageContext?.path;
    if (path) window.GalleryImageTools?.openContext(path, normalizeDakiProjectContext(activeImageContext?.projectContext));
}

function closeImageContextMenu() {
    const menu = document.getElementById('imageContextMenu');
    if (menu) menu.style.display = 'none';
}

function normalizeDakiProjectContext(context) {
    if (!context || typeof context !== 'object' || !context.projectId ||
        !['front', 'back'].includes(context.side) || !context.candidateId) return null;
    return {
        projectId: context.projectId,
        side: context.side,
        candidateId: context.candidateId
    };
}

function openImageContextMenu(event, imagePath, imgSrc, projectContext = null) {
    event.preventDefault();
    event.stopPropagation();

    activeImageContext = {
        path: imagePath,
        imgSrc: imgSrc,
        projectContext: normalizeDakiProjectContext(projectContext),
        // Canvas resolves the original's displayed dimensions, including EXIF
        // rotation. Thumbnail pixels and raw indexed dimensions can differ.
        width: 0,
        height: 0
    };
    const menu = document.getElementById('imageContextMenu');
    const catalogImageWithoutProject = !activeImageContext.projectContext && /^__daki_(shared|tests|personal|drafts)__\//.test(imagePath);
    document.getElementById('galleryContextInpaint').textContent = catalogImageWithoutProject
        ? '인페인팅 · 캔버스로 가져오기' : '인페인팅';
    const upscale = document.getElementById('galleryContextUpscale');
    if (upscale) upscale.textContent = catalogImageWithoutProject
        ? '업스케일 · 캔버스로 가져오기' : '업스케일';
    menu.style.display = 'block';

    const margin = 12;
    const menuWidth = menu.offsetWidth || 220;
    const menuHeight = menu.offsetHeight || 220;
    const left = Math.min(event.clientX, window.innerWidth - menuWidth - margin);
    const top = Math.min(event.clientY, window.innerHeight - menuHeight - margin);

    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
}

function openContextImageInpaint() {
    // Referenced catalog originals stay intact; edits use the canvas's copies.
    if (!activeImageContext?.projectContext && /^__daki_(shared|tests|personal|drafts)__\//.test(activeImageContext?.path || '')) return sendContextImageToCanvas();
    return openGalleryInpaintFromContext();
}

async function copyContextImage() {
    closeImageContextMenu();
    if (!activeImageContext) return;

    try {
        if (!navigator.clipboard || !window.ClipboardItem) {
            throw new Error('현재 브라우저가 이미지 복사를 지원하지 않습니다.');
        }

        const response = await fetch(activeImageContext.imgSrc);
        if (!response.ok) throw new Error(`이미지를 불러올 수 없습니다. (HTTP ${response.status})`);
        let blob = await response.blob();
        // Clipboard writes need PNG even when the browser can display WebP/JPEG.
        if (blob.type !== 'image/png') {
            const objectUrl = URL.createObjectURL(blob);
            try {
                const img = await loadImageElement(objectUrl);
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
                blob = await new Promise((resolve, reject) => {
                    canvas.toBlob(result => {
                        if (result) resolve(result);
                        else reject(new Error('이미지를 PNG로 변환할 수 없습니다.'));
                    }, 'image/png');
                });
            } finally {
                URL.revokeObjectURL(objectUrl);
            }
        }
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showToast('✓ 복사했습니다.');
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
    const imageContext = {...activeImageContext};

    let promptInfo = imageContext.prompt || null;

    if ((!promptInfo || typeof promptInfo !== 'object') && imageContext.path) {
        try {
            const response = await fetch('/api/prompt_info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: imageContext.path })
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
                    cfg_rescale: data.cfg_rescale,
                    noise_schedule: data.noise_schedule,
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
        src: imageContext.imgSrc,
        path: imageContext.path || '',
        width: imageContext.width,
        height: imageContext.height,
        name: getImageFileName(imageContext.path || imageContext.imgSrc),
        promptInfo: promptInfo || null,
        projectContext: imageContext.projectContext || null,
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

function getPromptViewerDetailValue(...values) {
    for (const value of values) {
        if (value !== null && value !== undefined && String(value).trim() !== '') {
            return String(value);
        }
    }
    return '정보 없음';
}

function closePromptViewer() {
    document.getElementById('promptLayer').style.display = 'none';
}

function renderPromptViewer(data) {
    data = data || {};

    const modelName = getPromptViewerDetailValue(data.modelName, data.model_name, data.model);
    const sampler = getPromptViewerDetailValue(data.sampler);
    const steps = getPromptViewerDetailValue(data.steps);

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

    const regionBlocks = (Array.isArray(data.promptRegions) ? data.promptRegions : [])
        .filter(item => item && typeof item.prompt === 'string' && typeof item.region === 'string')
        .map(item => `<div class="prompt-section"><div class="prompt-title">부위 · ${escapeHtml(item.label || item.region)}${Number.isInteger(item.characterIndex) ? ` · 캐릭터 ${item.characterIndex + 1}` : ''}</div>
            <div class="prompt-text">${renderPromptText(item.prompt)}</div></div>`).join('');
    document.getElementById('promptTitle').textContent = `📝 Prompt Viewer - ${data.fileName || ''}`;
    document.getElementById('promptBodyContent').innerHTML = `
        <div class="prompt-section prompt-generation-details">
            <div class="prompt-title">Generation Details</div>
            <div class="prompt-text">
                모델: ${escapeHtml(modelName)}<br>
                샘플러: ${escapeHtml(sampler)}<br>
                Steps: ${escapeHtml(steps)}
            </div>
        </div>
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
        ${regionBlocks}
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
    clearGalleryMultiFolderSelection(false);
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

const GALLERY_CHARACTER_KR_NAME_OVERRIDES = {
    'katsuragi lilja': '카츠라기 릴리야',
    'sakuragi mano': '사쿠라기 마노',
    'kuramoto china': '쿠라모토 치나',
    'rice shower': '라이스 샤워'
};

const GALLERY_CHARACTER_TITLE_SUFFIXES = [
    'blue archive',
    'umamusume'
];

const GALLERY_ROMAJI_KR_CHUNKS = [
    ['kya', '캬'], ['kyu', '큐'], ['kyo', '쿄'],
    ['gya', '갸'], ['gyu', '규'], ['gyo', '교'],
    ['sha', '샤'], ['shu', '슈'], ['sho', '쇼'],
    ['ja', '자'], ['ju', '주'], ['jo', '조'],
    ['cha', '차'], ['chu', '추'], ['cho', '초'],
    ['nya', '냐'], ['nyu', '뉴'], ['nyo', '뇨'],
    ['hya', '햐'], ['hyu', '휴'], ['hyo', '효'],
    ['bya', '뱌'], ['byu', '뷰'], ['byo', '뵤'],
    ['pya', '퍄'], ['pyu', '퓨'], ['pyo', '표'],
    ['mya', '먀'], ['myu', '뮤'], ['myo', '묘'],
    ['rya', '랴'], ['ryu', '류'], ['ryo', '료'],
    ['lya', '랴'], ['lyu', '류'], ['lyo', '료'],
    ['shi', '시'], ['chi', '치'], ['tsu', '츠'],
    ['ka', '카'], ['ki', '키'], ['ku', '쿠'], ['ke', '케'], ['ko', '코'],
    ['ga', '가'], ['gi', '기'], ['gu', '구'], ['ge', '게'], ['go', '고'],
    ['sa', '사'], ['su', '스'], ['se', '세'], ['so', '소'],
    ['za', '자'], ['ji', '지'], ['zu', '즈'], ['ze', '제'], ['zo', '조'],
    ['ta', '타'], ['te', '테'], ['to', '토'],
    ['da', '다'], ['de', '데'], ['do', '도'],
    ['na', '나'], ['ni', '니'], ['nu', '누'], ['ne', '네'], ['no', '노'],
    ['ha', '하'], ['hi', '히'], ['fu', '후'], ['he', '헤'], ['ho', '호'],
    ['ba', '바'], ['bi', '비'], ['bu', '부'], ['be', '베'], ['bo', '보'],
    ['pa', '파'], ['pi', '피'], ['pu', '푸'], ['pe', '페'], ['po', '포'],
    ['ma', '마'], ['mi', '미'], ['mu', '무'], ['me', '메'], ['mo', '모'],
    ['ya', '야'], ['yu', '유'], ['yo', '요'],
    ['ra', '라'], ['ri', '리'], ['ru', '루'], ['re', '레'], ['ro', '로'],
    ['la', '라'], ['li', '리'], ['lu', '루'], ['le', '레'], ['lo', '로'],
    ['wa', '와'], ['wo', '오'],
    ['a', '아'], ['i', '이'], ['u', '우'], ['e', '에'], ['o', '오'],
    ['n', 'ン']
];

function appendGalleryHangulFinalConsonant(text, jongIndex) {
    const S_BASE = 0xAC00;
    const L_COUNT = 19;
    const V_COUNT = 21;
    const T_COUNT = 28;
    const N_COUNT = V_COUNT * T_COUNT;
    const S_COUNT = L_COUNT * N_COUNT;

    if (!text) return text;

    const last = text.charCodeAt(text.length - 1);
    const offset = last - S_BASE;

    if (offset < 0 || offset >= S_COUNT || offset % T_COUNT !== 0) {
        return text;
    }

    return `${text.slice(0, -1)}${String.fromCharCode(last + jongIndex)}`;
}

function transliterateGalleryRomajiWordToKorean(word) {
    let text = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!text) return '';

    let output = '';

    while (text) {
        if (/^([bcdfghjklmnpqrstvwxyz])\1/.test(text)) {
            text = text.slice(1);
            continue;
        }

        if (text.startsWith('n') && !/^[aeiouy]/.test(text.slice(1, 2))) {
            const combined = appendGalleryHangulFinalConsonant(output, 4);
            output = combined === output ? `${output}ㄴ` : combined;
            text = text.slice(1);
            continue;
        }

        const chunk = GALLERY_ROMAJI_KR_CHUNKS.find(([roman]) => text.startsWith(roman));
        if (chunk) {
            output += chunk[1] === 'ン' ? 'ㄴ' : chunk[1];
            text = text.slice(chunk[0].length);
        } else {
            text = text.slice(1);
        }
    }

    return output;
}

function getGalleryCharacterKoreanDisplayName(value) {
    const raw = String(value || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    const suffixMatches = [...raw.matchAll(/\s*(\([^)]*\))\s*/g)]
        .map(match => match[1])
        .filter(Boolean);

    let baseText = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    const lowerBaseText = baseText.toLowerCase();
    const titleSuffix = GALLERY_CHARACTER_TITLE_SUFFIXES.find((suffix) => (
        lowerBaseText === suffix || lowerBaseText.endsWith(` ${suffix}`)
    ));

    if (titleSuffix && lowerBaseText !== titleSuffix) {
        const suffixStart = lowerBaseText.lastIndexOf(titleSuffix);
        const originalTitle = baseText.slice(suffixStart).trim();
        baseText = baseText.slice(0, suffixStart).trim();
        if (originalTitle) suffixMatches.push(`(${originalTitle})`);
    }

    const normalized = normalizeGalleryCharacterName(baseText);
    if (!normalized) return suffixMatches.join(' ').trim();

    if (!galleryDesignSettings.characterKoreanNames) {
        return `${normalized}${suffixMatches.length ? ` ${suffixMatches.join(' ')}` : ''}`.trim();
    }

    const key = normalized.toLowerCase();
    if (galleryCharacterNameOverrides[key]) {
        return `${galleryCharacterNameOverrides[key]}${suffixMatches.length ? ` ${suffixMatches.join(' ')}` : ''}`;
    }

    if (GALLERY_CHARACTER_KR_NAME_OVERRIDES[key]) {
        return `${GALLERY_CHARACTER_KR_NAME_OVERRIDES[key]}${suffixMatches.length ? ` ${suffixMatches.join(' ')}` : ''}`;
    }

    const words = normalized
        .split(/\s+/)
        .map(word => word.trim())
        .filter(Boolean);

    if (!words.length || words.some(word => !/^[a-zA-Z'-]+$/.test(word))) {
        return `${normalized}${suffixMatches.length ? ` ${suffixMatches.join(' ')}` : ''}`.trim();
    }

    const translated = words
        .map(transliterateGalleryRomajiWordToKorean)
        .filter(Boolean)
        .join(' ');

    return `${translated || normalized}${suffixMatches.length ? ` ${suffixMatches.join(' ')}` : ''}`.trim();
}

function getGalleryCharacterBaseKey(value) {
    const raw = String(value || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    let baseText = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    const lowerBaseText = baseText.toLowerCase();
    const titleSuffix = GALLERY_CHARACTER_TITLE_SUFFIXES.find((suffix) => (
        lowerBaseText === suffix || lowerBaseText.endsWith(` ${suffix}`)
    ));

    if (titleSuffix && lowerBaseText !== titleSuffix) {
        const suffixStart = lowerBaseText.lastIndexOf(titleSuffix);
        baseText = baseText.slice(0, suffixStart).trim();
    }

    return normalizeGalleryCharacterName(baseText).toLowerCase();
}

function getGalleryCharacterAutoKoreanDisplayName(value) {
    const key = getGalleryCharacterBaseKey(value);
    const previous = galleryCharacterNameOverrides[key];
    delete galleryCharacterNameOverrides[key];

    const result = getGalleryCharacterKoreanDisplayName(value);

    if (previous) {
        galleryCharacterNameOverrides[key] = previous;
    }

    return result;
}

function splitGalleryCharacterNameParts(value) {
    return String(value || '')
        .split(/_and_|\s+and\s+/i)
        .map(normalizeGalleryCharacterName)
        .filter(Boolean);
}

function loadGalleryCharacterNameOverrides() {
    try {
        const raw = localStorage.getItem(GALLERY_CHARACTER_NAME_OVERRIDES_KEY);
        const data = raw ? JSON.parse(raw) : {};
        galleryCharacterNameOverrides = data && typeof data === 'object' && !Array.isArray(data)
            ? Object.fromEntries(
                Object.entries(data)
                    .map(([key, value]) => [String(key).toLowerCase().trim(), String(value || '').trim()])
                    .filter(([key, value]) => key && value)
            )
            : {};
    } catch (error) {
        console.warn('Gallery character name overrides restore failed:', error);
        galleryCharacterNameOverrides = {};
    }
}

function saveGalleryCharacterNameOverrides() {
    try {
        localStorage.setItem(
            GALLERY_CHARACTER_NAME_OVERRIDES_KEY,
            JSON.stringify(galleryCharacterNameOverrides)
        );
    } catch (error) {
        console.warn('Gallery character name overrides save failed:', error);
    }
}

function addGalleryCharacterManagerEntry(names, name, fileCount) {
    const normalized = normalizeGalleryCharacterName(name);
    const key = getGalleryCharacterBaseKey(normalized);
    if (!key || !normalized) return;

    if (!names.has(key)) {
        names.set(key, {
            rawName: normalized,
            totalImages: 0,
            brand: getGalleryBrandForCharacterName(normalized)
        });
    }

    const entry = names.get(key);
    const count = Math.max(0, Number(fileCount) || 0);

    entry.totalImages += count;
    entry.brand = entry.brand || getGalleryBrandForCharacterName(normalized);
}

function collectGalleryCharacterNamesForManager(node, names = new Map()) {
    if (!node || typeof node !== 'object') return names;

    const namesFromNode = Array.isArray(node.char_names)
        ? node.char_names
        : (node.path && !/^(1_Solo|2_Duo|3_Group|No_Metadata)$/i.test(String(node.name || '')))
            ? getGalleryFolderCharacterNames(node)
            : [];

    const fileCount = Number(node.total_images || 0);
    namesFromNode.forEach((name) => {
        addGalleryCharacterManagerEntry(names, name, fileCount);
    });

    (Array.isArray(node.folders) ? node.folders : []).forEach((child) => {
        collectGalleryCharacterNamesForManager(child, names);
    });

    return names;
}

function getGalleryCharacterNameManagerRows() {
    if (!rootTree) return [];

    const rows = [...collectGalleryCharacterNamesForManager(rootTree).entries()]
        .map(([key, entry]) => ({
            key,
            rawName: entry.rawName,
            autoName: getGalleryCharacterAutoKoreanDisplayName(entry.rawName),
            customName: galleryCharacterNameOverrides[key] || '',
            totalImages: entry.totalImages,
            brandLabel: entry.brand || '기타 (미분류)'
        }));

    if (galleryCharacterNameManagerSort === 'name') {
        return rows.sort((a, b) => a.rawName.localeCompare(b.rawName));
    }

    return rows.sort((a, b) => b.totalImages - a.totalImages || a.rawName.localeCompare(b.rawName));
}

function openGalleryCharacterNameManager() {
    renderGalleryCharacterNameManager();
    const layer = document.getElementById('galleryCharacterNameManagerLayer');
    if (layer) layer.style.display = 'flex';
}

function closeGalleryCharacterNameManager() {
    const layer = document.getElementById('galleryCharacterNameManagerLayer');
    if (layer) layer.style.display = 'none';
}

function renderGalleryCharacterNameManager() {
    const container = document.getElementById('galleryCharacterNameManagerTable');
    if (!container) return;

    const query = String(document.getElementById('galleryCharacterNameSearch')?.value || '').toLowerCase().trim();
    const sortSelect = document.getElementById('galleryCharacterNameSort');
    const hideSavedInput = document.getElementById('galleryCharacterNameHideSaved');

    if (sortSelect) galleryCharacterNameManagerSort = sortSelect.value || 'count';
    if (hideSavedInput) galleryCharacterNameManagerHideSaved = Boolean(hideSavedInput.checked);

    const rows = getGalleryCharacterNameManagerRows()
        .filter((row) => {
            if (galleryCharacterNameManagerHideSaved && row.customName) return false;
            if (!query) return true;
            return [row.rawName, row.autoName, row.customName, row.brandLabel]
                .join(' ')
                .toLowerCase()
                .includes(query);
        });

    if (!rows.length) {
        container.innerHTML = '<div class="gallery-character-name-empty">조건에 맞는 캐릭터 이름이 없습니다.</div>';
        return;
    }

    container.innerHTML = `
        <table class="gallery-character-name-table">
            <thead>
                <tr>
                    <th>영어 이름</th>
                    <th>파일 수</th>
                    <th>브랜드</th>
                    <th>한글 자동 번역</th>
                    <th>사용자 수정명</th>
                    <th>관리</th>
                </tr>
            </thead>
            <tbody>
                ${rows.map((row) => `
                    <tr data-character-key="${escapeHtml(row.key)}">
                        <td>
                            <strong>${escapeHtml(row.rawName)}</strong>
                        </td>
                        <td>${escapeHtml(String(row.totalImages || 0))}</td>
                        <td>${escapeHtml(row.brandLabel || '기타 (미분류)')}</td>
                        <td>${escapeHtml(row.autoName)}</td>
                        <td>
                            <input type="text"
                                   class="gallery-character-name-input"
                                   value="${escapeHtml(row.customName)}"
                                   placeholder="${escapeHtml(row.autoName)}"
                                   onkeydown="handleGalleryCharacterNameInputKey(event)">
                        </td>
                        <td>
                            <button type="button" class="secondary" onclick="resetGalleryCharacterNameRow(${JSON.stringify(row.key).replace(/"/g, '&quot;')})">초기화</button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function saveGalleryCharacterNameManager() {
    const next = {...galleryCharacterNameOverrides};

    document.querySelectorAll('#galleryCharacterNameManagerTable tr[data-character-key]').forEach((row) => {
        const key = row.dataset.characterKey || '';
        const value = row.querySelector('.gallery-character-name-input')?.value.trim() || '';
        if (!key) return;
        if (value) {
            next[key] = value;
        } else {
            delete next[key];
        }
    });

    galleryCharacterNameOverrides = next;
    saveGalleryCharacterNameOverrides();
    buildFilterDropdowns(currentPath[currentPath.length - 1]);
    renderView();
    renderGalleryCharacterNameManager();
    flashGalleryCharacterNameManagerMessage('저장했습니다.');
    showToast('캐릭터 이름 수정값을 저장했습니다.');
}

function resetGalleryCharacterNameRow(key) {
    const row = document.querySelector(`#galleryCharacterNameManagerTable tr[data-character-key="${CSS.escape(key)}"]`);
    const input = row?.querySelector('.gallery-character-name-input');
    if (input) input.value = '';
}

function closeGalleryCharacterNameQuickEditor() {
    const popup = document.getElementById('galleryCharacterNameQuickEditor');
    if (popup) popup.remove();
}

function openGalleryCharacterNameQuickEditor(event, names) {
    const normalizedNames = [...new Set((Array.isArray(names) ? names : [names])
        .flatMap(splitGalleryCharacterNameParts)
        .filter(Boolean))];

    if (!normalizedNames.length) return;

    event.preventDefault();
    event.stopPropagation();
    closeGalleryCharacterNameQuickEditor();

    const popup = document.createElement('div');
    popup.id = 'galleryCharacterNameQuickEditor';
    popup.className = 'gallery-character-quick-editor';
    popup.innerHTML = `
        <div class="gallery-character-quick-title">캐릭터 이름 수정</div>
        <div class="gallery-character-quick-list">
            ${normalizedNames.map((name) => {
                const key = getGalleryCharacterBaseKey(name);
                const autoName = getGalleryCharacterAutoKoreanDisplayName(name);
                const customName = galleryCharacterNameOverrides[key] || '';
                return `
                    <label class="gallery-character-quick-row" data-character-key="${escapeHtml(key)}">
                        <span>
                            <b>${escapeHtml(name)}</b>
                            <small>${escapeHtml(autoName)}</small>
                        </span>
                        <div class="gallery-character-quick-input-actions">
                            <input type="text"
                                   value="${escapeHtml(customName)}"
                                   placeholder="${escapeHtml(autoName)}"
                                   onkeydown="handleGalleryCharacterQuickInputKey(event)">
                            <button type="button"
                                    class="secondary gallery-character-quick-filter-button"
                                    data-character-name="${escapeHtml(name)}"
                                    onclick="filterGalleryCharacterFromQuickEditor(event)">필터</button>
                        </div>
                    </label>
                `;
            }).join('')}
        </div>
        <div class="gallery-character-quick-actions">
            <button type="button" class="secondary" onclick="closeGalleryCharacterNameQuickEditor()">닫기</button>
            <button type="button" onclick="saveGalleryCharacterNameQuickEditor()">저장</button>
        </div>
    `;

    document.body.appendChild(popup);

    const margin = 12;
    const rect = popup.getBoundingClientRect();
    const left = Math.min(event.clientX, window.innerWidth - rect.width - margin);
    const top = Math.min(event.clientY, window.innerHeight - rect.height - margin);

    popup.style.left = `${Math.max(margin, left)}px`;
    popup.style.top = `${Math.max(margin, top)}px`;

    const firstInput = popup.querySelector('input');
    if (firstInput) {
        firstInput.focus();
        firstInput.select();
    }

    setTimeout(() => {
        document.addEventListener('mousedown', closeGalleryCharacterQuickEditorOnOutside, {once: true});
    }, 0);
}

function filterGalleryCharacterFromQuickEditor(event) {
    event.preventDefault();
    event.stopPropagation();

    const name = event.currentTarget?.dataset?.characterName || '';
    if (!name) return;

    currentSelectedBrand = 'ALL';
    currentSelectedChar = 'ALL';
    const brandSelect = document.getElementById('brandSelect');
    if (brandSelect) brandSelect.value = 'ALL';
    updateCharChips();

    const searchInput = document.getElementById('folder-search');
    if (searchInput) searchInput.value = name;
    handleSearch(name);
    closeGalleryCharacterNameQuickEditor();
}

function closeGalleryCharacterQuickEditorOnOutside(event) {
    const popup = document.getElementById('galleryCharacterNameQuickEditor');
    if (!popup) return;

    if (popup.contains(event.target)) {
        document.addEventListener('mousedown', closeGalleryCharacterQuickEditorOnOutside, {once: true});
        return;
    }

    closeGalleryCharacterNameQuickEditor();
}

function saveGalleryCharacterNameQuickEditor() {
    const popup = document.getElementById('galleryCharacterNameQuickEditor');
    if (!popup) return;

    popup.querySelectorAll('.gallery-character-quick-row[data-character-key]').forEach((row) => {
        const key = row.dataset.characterKey || '';
        const value = row.querySelector('input')?.value.trim() || '';
        if (!key) return;

        if (value) {
            galleryCharacterNameOverrides[key] = value;
        } else {
            delete galleryCharacterNameOverrides[key];
        }
    });

    saveGalleryCharacterNameOverrides();
    closeGalleryCharacterNameQuickEditor();
    buildFilterDropdowns(currentPath[currentPath.length - 1]);
    renderView();
    showToast('캐릭터 이름 수정값을 저장했습니다.');
}

function handleGalleryCharacterQuickInputKey(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        saveGalleryCharacterNameQuickEditor();
        return;
    }

    if (event.key === 'Escape') {
        event.preventDefault();
        closeGalleryCharacterNameQuickEditor();
        return;
    }

    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;

    const inputs = [...document.querySelectorAll('#galleryCharacterNameQuickEditor input')];
    const index = inputs.indexOf(event.target);
    if (index < 0) return;

    const nextIndex = event.key === 'ArrowUp'
        ? Math.max(0, index - 1)
        : Math.min(inputs.length - 1, index + 1);

    if (nextIndex === index) return;

    event.preventDefault();
    inputs[nextIndex].focus();
    inputs[nextIndex].select();
}

function handleGalleryCharacterNameInputKey(event) {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;

    const inputs = [...document.querySelectorAll('#galleryCharacterNameManagerTable .gallery-character-name-input')];
    const index = inputs.indexOf(event.target);
    if (index < 0) return;

    const nextIndex = event.key === 'ArrowUp'
        ? Math.max(0, index - 1)
        : Math.min(inputs.length - 1, index + 1);

    if (nextIndex === index) return;

    event.preventDefault();
    inputs[nextIndex].focus();
    inputs[nextIndex].select();
}

function flashGalleryCharacterNameManagerMessage(message) {
    const box = document.getElementById('galleryCharacterNameSaveFlash');
    if (!box) return;

    box.innerText = message;
    box.classList.add('show');

    clearTimeout(box._hideTimer);
    box._hideTimer = setTimeout(() => {
        box.classList.remove('show');
    }, 1800);
}

function getGalleryFolderKoreanDisplayName(value) {
    const normalized = normalizeGalleryCharacterName(value);
    if (!normalized) return '';

    const parts = normalized
        ? splitGalleryCharacterNameParts(normalized)
        : [];

    if (parts.length <= 1) {
        return getGalleryCharacterKoreanDisplayName(normalized);
    }

    return parts.map(getGalleryCharacterKoreanDisplayName).join(' & ');
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
    if (folder?.is_comic || folder?.is_comic_group) {
        return (Array.isArray(folder.char_names) ? folder.char_names : [])
            .map(normalizeGalleryCharacterName).filter(Boolean);
    }
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
        btn.textContent = `${getGalleryCharacterKoreanDisplayName(item.name)} (${item.count})`;
        btn.title = item.name;
        btn.onclick = () => selectChar(item.name);
        btn.oncontextmenu = (event) => openGalleryCharacterNameQuickEditor(event, [item.name]);
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

function isCombinedGalleryNode(node) {
    return Boolean(node?.isCombinedGalleryNode);
}

function getGalleryImageParentInfo(item, fallbackNode = null) {
    const imagePath = normalizeGalleryPathKey(item?.path || '');
    const parentPath = normalizeGalleryPathKey(
        item?.galleryParentPath || imagePath.split('/').slice(0, -1).join('/') || fallbackNode?.path || ''
    );
    const parentName = item?.galleryParentName || parentPath.split('/').pop() || fallbackNode?.name || '';

    return { path: parentPath, name: parentName };
}

function collectGalleryFolderImages(folder, output, seenPaths) {
    if (!folder) return;

    (folder.images || []).forEach((item) => {
        const imagePath = normalizeGalleryPathKey(item?.path || '');
        if (!imagePath || seenPaths.has(imagePath)) return;

        seenPaths.add(imagePath);
        const parent = getGalleryImageParentInfo(item, folder);
        output.push({
            ...item,
            galleryParentPath: parent.path,
            galleryParentName: parent.name,
            // 가상 폴더에서 캐릭터별 카드를 만들 때도 원본 Duo/Group의
            // 줄바꿈 이름과 다키 여부를 그대로 재사용한다.
            galleryParentCharNames: Array.isArray(folder.char_names) && folder.char_names.length
                ? folder.char_names.slice()
                : [parent.name],
            galleryParentIsDakimakura: isGalleryDakimakuraFolder(folder)
        });
    });

    (folder.folders || []).forEach((child) => collectGalleryFolderImages(child, output, seenPaths));
}

function buildCombinedGalleryNode(folders) {
    const images = [];
    const seenPaths = new Set();

    folders.forEach((folder) => collectGalleryFolderImages(folder, images, seenPaths));

    return {
        name: `통합 보기 (${folders.length}개 폴더)`,
        path: '',
        folders: [],
        images,
        total_images: images.length,
        sourcePaths: [...new Set(
            folders
                .flatMap((folder) => {
                    if (!isGalleryDateGroupNode(folder)) {
                        return [getGalleryBulkDeleteFolderKey(folder)];
                    }

                    return (folder.images || [])
                        .map((item) => getGalleryImageParentInfo(item, folder).path);
                })
                .filter(Boolean)
        )],
        isCombinedGalleryNode: true
    };
}

function enterGalleryFolder(child) {
    if (window.Daki?.isActive()) return;
    clearGalleryMultiFolderSelection(false);
    currentPath.push(child);

    // 폴더 안으로 들어갈 때는 현재 선택한 브랜드/캐릭터를 유지한다.
    currentSelectedGalleryArtStyle = 'ALL';
    searchText = '';

    const searchInput = document.getElementById('folder-search');
    if (searchInput) searchInput.value = '';

    if (Array.isArray(child.folders) && child.folders.length > 0) {
        buildFilterDropdowns(child);
    }

    renderView();
    saveGallerySessionState();
    window.scrollTo(0, 0);
}

async function openSelectedGalleryFolders() {
    const folders = [...galleryMultiFolderSelection.values()];
    if (!folders.length) return;

    const sourceNode = currentPath[currentPath.length - 1];
    const sourceRoot = rootTree;
    try {
        for (const folder of folders) await galleryCatalogLoader?.load(folder, true);
    } catch (error) {
        showToast(error.message);
        return;
    }
    if (window.Daki?.isActive() || sourceRoot !== rootTree || sourceNode !== currentPath[currentPath.length - 1]) return;
    const combinedNode = buildCombinedGalleryNode(folders);
    const originPath = currentPath.slice();

    closeGalleryMultiFolderContextMenu();
    clearGalleryMultiFolderSelection(false);
    currentPath = [...originPath, combinedNode];
    currentSelectedGalleryArtStyle = 'ALL';
    currentGalleryTagFilter = 'ALL';
    searchText = '';

    const searchInput = document.getElementById('folder-search');
    if (searchInput) searchInput.value = '';

    renderView();
    saveGallerySessionState();
    window.scrollTo(0, 0);
}

async function renderView() {
    galleryVirtualRenderGeneration += 1;
    galleryVirtualSummaryObservers.forEach(observer => observer.disconnect());
    galleryVirtualSummaryObservers.clear();
    galleryImageRenderSessions.forEach(session => session.cleanup?.());
    galleryImageRenderSessions.clear();
    const currentNode = currentPath[currentPath.length - 1];
    const cont = document.getElementById('content');
    cont.innerHTML = '';
    const generation = galleryVirtualRenderGeneration;
    const recursiveImages = getGalleryViewMode() === 'date';
    if (galleryCatalogLoader?.pending(currentNode, recursiveImages)) {
        cont.textContent = '이 화면에 필요한 이미지 정보를 불러오는 중…';
        try {
            await galleryCatalogLoader.load(currentNode, recursiveImages);
        } catch (error) {
            if (generation === galleryVirtualRenderGeneration) renderGalleryDataErrorState(error.message);
            return;
        }
        if (generation !== galleryVirtualRenderGeneration || currentNode !== currentPath[currentPath.length - 1]) return;
        cont.innerHTML = '';
    }

    // renderImageGrid가 실제 이미지 화면임을 확정하기 전에는
    // 폴더 정렬 옵션을 보여 준다. 혼합 화면도 폴더 정렬을 우선한다.
    syncGallerySortControls('folder');

    if (getGalleryViewMode() === 'virtual') {
        const navTabs = document.getElementById('nav-tabs');
        if (navTabs) navTabs.innerHTML = '';
        window.Daki?.mountNavigation(navTabs);
        const brandBar = document.getElementById('brand-filter-bar');
        if (brandBar) brandBar.style.display = 'none';
        const chips = document.getElementById('char-chip-container');
        if (chips) chips.style.display = 'none';
        const artStyle = document.getElementById('galleryArtStyleSelect');
        if (artStyle) artStyle.style.display = 'none';
        const tagBar = document.getElementById('galleryTagFilterBar');
        if (tagBar) tagBar.style.display = 'none';
        const loading = document.getElementById('galleryFilterLoading');
        if (loading) loading.style.display = 'none';
        const label = document.getElementById('main-filter-label');
        if (label) { label.textContent = '🗂️ 가상 폴더'; label.style.color = '#a78bfa'; }
        return renderGalleryVirtualView(cont);
    }
    const brandBar = document.getElementById('brand-filter-bar');
    if (brandBar) brandBar.style.display = '';
    const tagBar = document.getElementById('galleryTagFilterBar');
    if (tagBar) tagBar.style.display = '';

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
            clearGalleryMultiFolderSelection(false);
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

    window.Daki?.mountNavigation(navTabs);

    const bcPath = document.getElementById('breadcrumb-path');
    bcPath.innerHTML = '<span style="cursor:pointer;" onclick="goToRoot()">🏠 HOME</span>';

    currentPath.forEach((node, idx) => {
        if (idx === 0) return;

        const span = document.createElement('span');
        let displayName = (idx === 1)
            ? node.name.replace(/^\d+_/, '')
            : getGalleryFolderKoreanDisplayName(node.name);

        span.innerHTML = ` <span style="color:var(--accent)">❯</span> <span style="cursor:pointer; color:${idx === currentPath.length - 1 ? '#fff' : '#888'}">${displayName}</span>`;
        span.onclick = () => {
            clearGalleryMultiFolderSelection(false);
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

    const isDateMode = getGalleryViewMode() === 'date';
    const isDateOverview = isDateMode &&
        currentPath.length <= 2 &&
        Boolean(currentPath[1]) &&
        !isGalleryDateGroupNode(currentNode);

    let displayFolders = [];
    let displayImages = [];

    if (isDateOverview) {
        displayFolders = buildGalleryDateDisplayGroups(currentPath[1], getGalleryDateGrouping())
            .filter((group) => {
                if (!searchText) return true;
                return String(group.name || '').toLowerCase().includes(searchText);
            });
    } else {
        displayFolders = (currentNode.folders || []).filter(f => {
            if (!passesGalleryDakiFilter(f, true)) return false;
            if (!galleryPromptSearchMatchesFolder(f)) return false;

            const folderNameText = String(f.name || '').replace(/_/g, ' ').toLowerCase();
            const charNameText = getGalleryFolderCharacterNames(f)
                .map(name => name.toLowerCase())
                .join(' ');
            const charNameKrText = getGalleryFolderCharacterNames(f)
                .map(getGalleryCharacterKoreanDisplayName)
                .join(' ')
                .toLowerCase();

            const matchesSearch = !searchText ||
                folderNameText.includes(searchText) ||
                charNameText.includes(searchText) ||
                charNameKrText.includes(searchText);

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

        displayImages = (currentNode.images || []).filter(item => {
            return passesGalleryDakiFilter(item, false) && galleryPromptSearchMatchesImage(item);
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
    }

    const isSearchFiltering = isDateOverview
        ? (currentGalleryTagFilter !== 'ALL' || searchText !== '' || galleryPromptSearchActive || dakiFilter !== 'all')
        : isFinalFolder
        ? (currentSelectedGalleryArtStyle !== 'ALL' || currentGalleryTagFilter !== 'ALL' || searchText !== '' || galleryPromptSearchActive)
        : (currentSelectedBrand !== 'ALL' || currentGalleryTagFilter !== 'ALL' || searchText !== '' || galleryPromptSearchActive);

    const majorFolders = displayFolders.filter(f => f.total_images >= 10);
    const minorFolders = displayFolders.filter(f => f.total_images < 10);
    const hasImages = displayImages.length > 0;

    const defaultState = (hasImages && !isSearchFiltering && !isFinalFolder) ? 'closed' : '';

    if (isDateOverview && displayFolders.length > 0) {
        renderCollapsibleGrid(cont, "date-groups", "📅 날짜별 그룹", displayFolders, "#00f2ff", defaultState);
    } else if (majorFolders.length > 0) {
        renderCollapsibleGrid(cont, "major", "👑 메이저 그룹", majorFolders, "#00ff88", defaultState);
    }

    if (!isDateOverview && minorFolders.length > 0) {
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
    syncReasonVisibility();
    saveGallerySessionState();
    scheduleGalleryScrollNavigationUpdate();
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

    const colCount = getGalleryEffectiveColumnCount(grid);

    const cols = Array.from({length: colCount}, () => {
        const col = document.createElement('div');
        col.className = 'flex-masonry-col';
        grid.appendChild(col);
        return col;
    });
    folders.forEach((child, idx) => {
        const card = document.createElement('div');
        const isDateGroup = isGalleryDateGroupNode(child);
        const bulkFolderKey = isDateGroup ? '' : getGalleryBulkDeleteFolderKey(child);
        const multiFolderKey = getGalleryMultiFolderKey(child);
        const visibleCount = getGalleryPromptMatchedFolderCount(child);

        card.className = `card ${isDateGroup ? 'gallery-multi-folder-selectable' : 'gallery-bulk-delete-selectable gallery-multi-folder-selectable'} ${!isDateGroup && galleryBulkDeleteFolders.has(bulkFolderKey) ? 'bulk-delete-selected' : ''} ${galleryMultiFolderSelection.has(multiFolderKey) ? 'multi-folder-selected' : ''}`;
        if (!isDateGroup) {
            card.dataset.bulkDeleteType = 'folder';
            card.dataset.bulkDeletePath = bulkFolderKey;
            card.dataset.bulkDeleteName = child.name || bulkFolderKey;
        }
        card.dataset.multiFolderPath = multiFolderKey;
        card.galleryMultiFolderNode = child;
        card.oncontextmenu = (event) => {
            if (isGalleryBulkDeleteMode) {
                if (isDateGroup) event.preventDefault();
                return;
            }

            if (galleryMultiFolderSelection.has(multiFolderKey)) {
                openGalleryMultiFolderContextMenu(event);
                return;
            }

            if (isDateGroup) {
                event.preventDefault();
                return;
            }

            openGalleryCharacterNameQuickEditor(event, getGalleryFolderCharacterNames(child));
        };

        card.onclick = (event) => {
            if (galleryZoomDeleteEnabled || galleryZoomTagEnabled) {
                event.preventDefault();
                event.stopPropagation();
                enterGalleryFolder(child);
                return;
            }
            if (isDateGroup) {
                if (isGalleryBulkDeleteMode || !galleryDesignSettings.multiFolderSelectionEnabled) {
                    enterGalleryFolder(child);
                    return;
                }

                if (galleryMultiFolderSuppressNextClick) return;

                if (galleryMultiFolderSelection.size > 0) {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleGalleryMultiFolder(child, card);
                    return;
                }

                if (galleryFolderOpenTimer) clearTimeout(galleryFolderOpenTimer);
                galleryFolderOpenTimer = setTimeout(() => {
                    galleryFolderOpenTimer = null;
                    enterGalleryFolder(child);
                }, 220);
                return;
            }

            if (isGalleryBulkDeleteMode) {
                event.preventDefault();
                event.stopPropagation();

                if (galleryBulkDeleteSuppressNextClick) {
                    return;
                }

                toggleGalleryBulkDeleteFolder(child, card);
                return;
            }

            if (!galleryDesignSettings.multiFolderSelectionEnabled) {
                enterGalleryFolder(child);
                return;
            }

            if (galleryMultiFolderSuppressNextClick) return;

            if (galleryMultiFolderSelection.size > 0) {
                event.preventDefault();
                event.stopPropagation();
                toggleGalleryMultiFolder(child, card);
                return;
            }

            if (galleryFolderOpenTimer) clearTimeout(galleryFolderOpenTimer);
            galleryFolderOpenTimer = setTimeout(() => {
                galleryFolderOpenTimer = null;
                enterGalleryFolder(child);
            }, 220);
        };

        card.ondblclick = (event) => {
            if (!galleryDesignSettings.multiFolderSelectionEnabled || isGalleryBulkDeleteMode) return;

            event.preventDefault();
            event.stopPropagation();

            if (galleryFolderOpenTimer) {
                clearTimeout(galleryFolderOpenTimer);
                galleryFolderOpenTimer = null;
            }

            toggleGalleryMultiFolder(child, card);
        };

        const isDaki = isGalleryDakimakuraFolder(child);
        const imgSrc = child.thumb ? getGalleryThumbnailSrc(child.thumb) : '';
        // 🌟 사람 아이콘 원상 복구 및 정확한 줄바꿈 분리
        const nameRows = (child.is_comic || child.is_comic_group)
            ? `<div class="char-row"><span class="user-icon">📚</span><span class="char-name">${escapeHtml(child.name || '')}</span></div>` +
                getGalleryFolderCharacterNames(child).map(name =>
                    `<div class="char-row"><span class="user-icon">👤</span><span class="char-name">${escapeHtml(getGalleryCharacterKoreanDisplayName(name))}</span></div>`
                ).join('')
            : isDateGroup
            ? `<div class="char-row"><span class="user-icon">📅</span><span class="char-name">${escapeHtml(child.name || '')}</span></div>`
            : (child.char_names || [child.name])
            .flatMap(splitGalleryCharacterNameParts)
            .map(n => {
                const rawName = normalizeGalleryCharacterName(n);
                const displayName = getGalleryCharacterKoreanDisplayName(rawName);
                const title = rawName && rawName !== displayName ? ` title="${escapeHtml(rawName)}"` : '';
                return `<div class="char-row"${title}><span class="user-icon">👤</span><span class="char-name">${escapeHtml(displayName)}</span></div>`;
            })
            .join('');

        card.innerHTML = `
            <div class="card-body">
                ${imgSrc ? `<img src="${imgSrc}" class="card-main-img" loading="lazy" decoding="async" draggable="false">` : '<div style="height:150px;background:#222;"></div>'}
                ${isDaki ? `<div class="daki-badge-neon">DAKIMAKURA</div>` : ''}
                <div class="count-badge"><span class="count-num">${visibleCount}</span><span>FILES</span></div>
            </div>
            <div class="card-header">${nameRows}</div>`;
        cols[idx % colCount].appendChild(card);
    });
}

// Preserve the user's batch size while yielding between small DOM additions.
// The time budget leaves room for layout/paint on slower machines; one card
// cannot be preempted, so it is a target rather than a hard frame guarantee.
// A cancelled view cannot append cards into its replacement.
function createGalleryRenderBatcher({total, batchSize, append, onProgress, onComplete, onBatchComplete}) {
    let count = 0;
    let target = 0;
    let frame = null;
    let cancelled = false;
    let resolveReady;
    const firstBatchReady = new Promise(resolve => { resolveReady = resolve; });
    const step = () => {
        frame = null;
        if (cancelled) return;
        const end = Math.min(target, count + 32);
        const startedAt = performance.now();
        do {
            append(count, count + 1);
            count += 1;
        } while (count < end && performance.now() - startedAt < 8);
        onProgress(count);
        if (count < target) {
            frame = requestAnimationFrame(step);
        } else {
            resolveReady();
            if (count >= total) onComplete();
            else onBatchComplete?.();
        }
    };
    return {
        firstBatchReady,
        get count() { return count; },
        next() {
            if (cancelled || frame !== null || count < target) return;
            if (count >= total) {
                resolveReady();
                if (total === 0) onComplete();
                return;
            }
            target = Math.min(total, count + batchSize);
            step();
        },
        cancel() {
            cancelled = true;
            if (frame !== null) cancelAnimationFrame(frame);
            frame = null;
            resolveReady();
        }
    };
}

function preserveGalleryImageAspectRatio(image, item) {
    if (item.galleryPreviewAspectRatio) image.style.aspectRatio = item.galleryPreviewAspectRatio;
    const remember = () => {
        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
            // Keep display geometry across recycling without replacing original dimensions
            // with the smaller preview's dimensions in the logical image record.
            item.galleryPreviewAspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
            image.style.aspectRatio = item.galleryPreviewAspectRatio;
        }
    };
    image.addEventListener('load', remember, {once: true});
    if (image.complete) remember();
}

function renderImageGrid(container, title, images, parentNode) {
    const hasFolderCards = Boolean(container?.querySelector(
        '.gallery-multi-folder-selectable, .gallery-virtual-folder-card-item'
    ));
    syncGallerySortControls(hasFolderCards ? 'folder' : 'image');
    const modeInput = document.querySelector('input[name="viewMode"]:checked');
    const isTrashMode = getGalleryViewMode() !== 'virtual' && modeInput && modeInput.value === 'trash';
    const isCombinedView = isCombinedGalleryNode(parentNode);

    const sec = document.createElement('div');
    sec.className = 'section-title';
    sec.style.borderLeftColor = 'var(--thumb)';
    sec.style.color = 'var(--thumb)';
    sec.style.display = 'flex';
    sec.style.justifyContent = 'space-between';
    sec.style.alignItems = 'center';

    let titleHtml = `<span>${title}</span>`;
    if (isTrashMode && !isCombinedView) {
        if (!isGalleryDateGroupNode(parentNode)) {
            titleHtml += `<button onclick="emptyTrashFolder('${parentNode.name}')" style="background:#f44; color:#fff; border:none; padding:8px 15px; border-radius:5px; font-weight:bold; cursor:pointer; font-size:13px; box-shadow: 0 0 10px rgba(255,68,68,0.4); transition: 0.2s;">🔥 이 폴더 영구 비우기</button>`;
        }
    }
    const titleLabel = document.createElement('div');
    titleLabel.innerHTML = titleHtml;
    sec.appendChild(titleLabel);
    container.appendChild(sec);

    const useFixedSizeGrid = Boolean(galleryDesignSettings.fixedSizeMode);

    const g = document.createElement('div');
    g.className = useFixedSizeGrid ? 'flex-masonry gallery-fixed-size-grid' : 'flex-masonry';
    container.appendChild(g);

    const colCount = useFixedSizeGrid
    ? 0
    : getGalleryEffectiveColumnCount(g);

    const cols = useFixedSizeGrid
        ? []
        : Array.from({length: colCount}, () => {
            const col = document.createElement('div');
            col.className = 'flex-masonry-col';
            g.appendChild(col);
            return col;
        });

    const orderedImages = [...(images || [])].sort((a, b) => {
        if (parentNode?.is_comic) {
            return String(a?.name || '').localeCompare(String(b?.name || ''), undefined, {numeric: true});
        }
        const creationDiff = galleryImageOrder === 'oldest'
            ? (Number(a?.ctime ?? a?.mtime) || 0) - (Number(b?.ctime ?? b?.mtime) || 0)
            : (Number(b?.ctime ?? b?.mtime) || 0) - (Number(a?.ctime ?? a?.mtime) || 0);
        return creationDiff || String(a?.path || a?.name || '').localeCompare(String(b?.path || b?.name || ''));
    });
    // Keep logical order, including images not yet appended by lazy rendering.
    g.galleryZoomImages = orderedImages;
    let recycler = null;
    const appendImageBatch = (startIndex, endIndex, remountTarget = null) => {
        orderedImages.slice(startIndex, endIndex).forEach((item, offset) => {
        const idx = startIndex + offset;
        const imageParent = getGalleryImageParentInfo(item, parentNode);
        const folderId = imageParent.name;
        const fk = imageParent.path;
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

        const hasReason = Boolean(item.warning || item.reason);

        let warningHtml = '';
        if (hasReason) {
            warningHtml = `<div class="nsfw-reason-box">`;
            if (item.warning) warningHtml += `<div class="${reasonClass}">${escapeHtml(item.warning)}</div>`;
            if (item.reason) warningHtml += `<div class="${reasonClass}">${escapeHtml(item.reason)}</div>`;
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
                <button class="gallery-card-action-btn" title="복구" aria-label="복구"
                        onclick="restoreItem('${p}', 'box-${idx}')"
                        style="background:#122; color:#4ff; border:1px solid #4ff;">
                    <span class="gallery-action-icon">⏪</span>
                    <span class="gallery-action-label">복구</span>
                </button>
                <button class="gallery-card-action-btn" title="영구 삭제" aria-label="영구 삭제"
                        onclick="toggleSelect('${p}','${folderId}','${fk}','${item.name}','box-${idx}')"
                        style="background:#211; color:#f44; border:1px solid #f44;">
                    <span class="gallery-action-icon">🔥</span>
                    <span class="gallery-action-label">영구 삭제</span>
                </button>
            `;
        } else {
            buttonsHtml = `
                <button class="gallery-card-action-btn" title="삭제" aria-label="삭제"
                        onclick="toggleSelect('${p}','${folderId}','${fk}','${item.name}','box-${idx}')"
                        style="background:#211; color:#f44; border:1px solid #f44;">
                    <span class="gallery-action-icon">🗑️</span>
                    <span class="gallery-action-label">삭제</span>
                </button>
                <button class="gallery-card-action-btn" title="${escapeHtml(thumbLabel)}" aria-label="${escapeHtml(thumbLabel)}"
                        onclick="toggleThumb('${fk}','${p}','${folderId}','${item.name}','box-${idx}')"
                        style="background:#122; color:${thumbBorder}; border:1px solid ${thumbBorder};">
                    <span class="gallery-action-icon">${thumbIcon}</span>
                    <span class="gallery-action-label">${thumbLabel}</span>
                </button>
                <button class="gallery-card-action-btn" title="${escapeHtml(tLbl)}" aria-label="${escapeHtml(tLbl)}"
                        onclick="instantToggleNsfw('${p}', this, 'box-${idx}')"
                        style="background:${tBg}; color:${tCol}; border:1px solid ${tCol};">
                    <span class="gallery-action-icon">${tIcon}</span>
                    <span class="gallery-action-label">${tLbl}</span>
                </button>
            `;
        }

        const imgRatio = (item.w && item.h) ? `${item.w} / ${item.h}` : 'auto';

        // 🌟 isCurrentThumb 조건 추가!
        const boxClass = `item-box ${hasReason ? 'has-reason' : ''} ${selDeletes.has(p)?'selected':''} ${(selThumbs.has(fk) ? selThumbs.get(fk).path===p : isCurrentThumb)?'is-thumb':''}`;        const safeImgSrc = JSON.stringify(imgSrc).replace(/"/g, '&quot;');
        const safeP = JSON.stringify(p).replace(/"/g, '&quot;');
        const safeFolderId = JSON.stringify(folderId || '').replace(/"/g, '&quot;');
        const safeFk = JSON.stringify(fk || '').replace(/"/g, '&quot;');
        const safeFileName = JSON.stringify(item.name || '').replace(/"/g, '&quot;');
        const cleanBulkImagePath = normalizeGalleryPathKey(p);

        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <div class="${boxClass} gallery-bulk-delete-selectable ${selDeletes.has(cleanBulkImagePath) ? 'bulk-delete-selected' : ''}"
                id="box-${idx}"
                data-path="${escapeHtml(p)}"
                data-fk="${escapeHtml(fk)}"
                data-bulk-delete-type="image"
                data-bulk-delete-path="${escapeHtml(cleanBulkImagePath)}"
                data-bulk-delete-folder-id="${escapeHtml(folderId)}"
                data-bulk-delete-folder-key="${escapeHtml(fk)}"
                data-bulk-delete-file-name="${escapeHtml(item.name || '')}">
                <img src="${getGalleryThumbnailSrc(p)}" loading="lazy" decoding="async" class="zoomable" draggable="false"
                        onclick="handleGalleryImageCardClick(event, ${safeP}, ${safeFolderId}, ${safeFk}, ${safeFileName}, 'box-${idx}', ${safeImgSrc})"
                        oncontextmenu="openImageContextMenu(event, ${safeP}, ${safeImgSrc})"
                        style="cursor:zoom-in; width:100%; height:auto; aspect-ratio: ${imgRatio}; display:block; background:#111; object-fit:contain;">                ${galleryUpscaleBadgeHtml}
                ${galleryTagButtonHtml}
                ${warningHtml}
                <div class="gallery-card-actions">
                    ${buttonsHtml}
                </div>
            </div>`;
        preserveGalleryImageAspectRatio(wrapper.querySelector('img.zoomable'), item);
        const card = wrapper.firstElementChild;
        if (remountTarget) {
            remountTarget.appendChild(card);
        } else if (recycler) {
            recycler.append(idx, card, useFixedSizeGrid ? g : cols[idx % colCount]);
        } else if (useFixedSizeGrid) {
            g.appendChild(card);
        } else {
            cols[idx % colCount].appendChild(card);
        }
        window.GalleryImageTools?.decorate(card, p);
        });
    };
    const totalImages = orderedImages.length;
    if (totalImages > 256 && typeof IntersectionObserver !== 'undefined') {
        recycler = createGalleryCardRecycler({fixed: useFixedSizeGrid,
            render: (index, target) => appendImageBatch(index, index + 1, target)});
    }
    const batchSize = clampGalleryNumber(galleryDesignSettings.imageRenderBatchSize, 1000, 100, 10000);
    let session = null;
    const progress = document.createElement('div');
    progress.className = 'gallery-image-render-progress';
    progress.textContent = `표시 0 / 전체 ${totalImages.toLocaleString()}`;
    const sentinel = document.createElement('div');
    sentinel.className = 'gallery-image-render-sentinel';
    const finish = () => {
        if (!session) return;
        session.observer?.disconnect();
        session.observer = null;
        sentinel.remove();
        session.fallback?.remove();
        recycler?.finish();
        if (!recycler) galleryImageRenderSessions.delete(session);
        progress.textContent = `전체 ${totalImages.toLocaleString()}장 표시 완료`;
    };
    const batcher = createGalleryRenderBatcher({
        total: totalImages,
        batchSize,
        append: appendImageBatch,
        onProgress: renderedCount => {
            progress.textContent = renderedCount >= totalImages
                ? `전체 ${totalImages.toLocaleString()}장 표시 완료`
                : `표시 ${renderedCount.toLocaleString()} / 전체 ${totalImages.toLocaleString()}`;
        },
        onComplete: finish,
        onBatchComplete: () => {
            // An intersection during a running batch is ignored. Recheck after
            // it finishes so short/dense grids can keep filling the viewport.
            if (session?.observer) {
                session.observer.disconnect();
                session.observer.observe(sentinel);
            }
        }
    });
    const appendNextBatch = () => batcher.next();
    session = {
        observer: null,
        fallback: null,
        firstBatchReady: batcher.firstBatchReady,
        cleanup: () => {
            batcher.cancel();
            recycler?.cleanup();
            session.observer?.disconnect();
            sentinel.remove();
            session.fallback?.remove();
            progress.remove();
        }
    };
    galleryImageRenderSessions.add(session);
    container.appendChild(progress);
    appendNextBatch();
    if (batcher.count < totalImages) {
        if (typeof IntersectionObserver !== 'undefined') {
            session.observer = new IntersectionObserver(entries => {
                if (entries.some(entry => entry.isIntersecting)) appendNextBatch();
            }, {rootMargin: '600px'});
            session.observer.observe(sentinel);
        } else {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'gallery-image-render-more';
            button.textContent = '다음 이미지 표시';
            button.onclick = appendNextBatch;
            session.fallback = button;
            container.appendChild(button);
        }
        container.appendChild(sentinel);
    }
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

    const folderDeleteCount = galleryBulkDeleteFolders ? galleryBulkDeleteFolders.size : 0;
    document.getElementById('count-del').innerText = selDeletes.size + folderDeleteCount;

    updateGalleryBulkDeleteBar();
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
    document.querySelectorAll('#content .item-box').forEach(box => {
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

    refreshGalleryBulkDeleteSelectionStyles();
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

        img.src = getGalleryThumbnailSrc(target);
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
    if (selThumbs.size === 0 && selDeletes.size === 0 && galleryBulkDeleteFolders.size === 0) {
        alert("적용할 변경사항이 없습니다.");
        return;
    }

    const btn = document.getElementById('applyBtn');
    const originalText = "선택한 변경 적용";

    btn.innerText = "⏳ 반영 중...";
    btn.disabled = true;

    try {
        const {result, cancelled} = await Daki.deleteRequest('/api/apply', {
                "thumbs": Array.from(selThumbs.values()).map(v => ({"new_thumb": v.path})),
                "deletes": Array.from(selDeletes.keys()),
                "delete_folders": Array.from(galleryBulkDeleteFolders.keys())
        });
        if (cancelled) {
            btn.innerText = originalText;
            btn.disabled = false;
            return;
        }

        if (result.status === 'success') {
            selThumbs.clear();
            selDeletes.clear();
            galleryBulkDeleteFolders.clear();
            updateGalleryBulkDeleteBar();
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
    const originalHtml = btnElement.innerHTML;

    btnElement.innerHTML = "<span>⏳</span>";
    btnElement.disabled = true;

    try {
        const res = await fetch('/api/toggle_nsfw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentPath })
        });

        const data = await res.json();

        if (!res.ok || data.status !== 'success') {
            throw new Error(data.message || 'R-18 전환 실패');
        }

        // Rebuild logical image data too: recycled cards must use the moved path.
        await loadData();

    } catch(e) {
        console.error(e);
        alert(e.message || 'R-18 전환 실패');
        btnElement.disabled = false;
        btnElement.innerHTML = originalHtml;
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
            // A restored item must not reappear when an offscreen group remounts.
            await loadData();
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
        const {result: data, cancelled} = await Daki.deleteRequest('/api/empty_trash_folder', {folder: folderName});
        if (cancelled) return;

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
