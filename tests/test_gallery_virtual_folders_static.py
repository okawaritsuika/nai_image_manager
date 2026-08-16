import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class GalleryVirtualFolderStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js = (ROOT / "static" / "index.js").read_text(encoding="utf-8")
        cls.css = (ROOT / "static" / "index.css").read_text(encoding="utf-8")
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")

    def test_gallery_has_virtual_entry_points_and_persistent_options(self):
        self.assertIn('name="galleryViewMode" value="virtual"', self.html)
        self.assertIn('id="galleryVirtualControls"', self.html)
        self.assertIn('name="galleryVirtualGrouping" value="character"', self.html)
        self.assertIn('name="galleryVirtualGrouping" value="combined"', self.html)
        self.assertIn('name="galleryVirtualUncategorized" value="include"', self.html)
        self.assertIn('onclick="openGalleryVirtualFolderManager()"', self.html)
        self.assertIn('onclick="openGalleryVirtualFolderCreateFromPrompt()"', self.html)
        self.assertIn("galleryVirtualGrouping", self.js)
        self.assertIn("galleryVirtualUncategorized", self.js)
        self.assertIn("galleryVirtualFolders", self.js)

    def test_virtual_folder_api_contract_and_dynamic_resolve_are_used(self):
        self.assertIn("/api/gallery/virtual_folders?parent_id=__all__", self.js)
        self.assertIn("/api/gallery/virtual_folders", self.js)
        self.assertIn("/resolve?ts=", self.js)
        self.assertIn("method: 'PATCH'", self.js)
        self.assertIn("/reparent", self.js)
        self.assertIn("method: 'DELETE'", self.js)
        self.assertIn("scope_paths", self.js)
        self.assertIn("virtualFolder", self.js)

    def test_virtual_results_reuse_existing_image_grid_and_keep_real_parent(self):
        self.assertIn("renderImageGrid(container, `🖼️ 이미지 (${renderImages.length})`, renderImages, currentNode)", self.js)
        self.assertIn("getGalleryImageParentInfo(item)", self.js)
        self.assertIn("isGalleryVirtualCharacterGroup", self.js)
        self.assertIn("isGalleryVirtualUnassigned", self.js)
        self.assertIn("collectGalleryVirtualDescendantImages", self.js)

    def test_virtual_ui_has_no_placeholder_management_wording(self):
        self.assertNotIn("정리용 폴더", self.html)
        self.assertNotIn("정리용 폴더", self.js)
        self.assertIn("const cardMetaHtml = cardMeta ?", self.js)

    def test_character_groups_are_not_grouped_again(self):
        self.assertIn("!currentNode.isGalleryVirtualCharacterGroup", self.js)
        self.assertIn("const groupedImages = shouldGroup ? buildGalleryVirtualCharacterNodes(renderImages, currentNode.id) : [];", self.js)
        self.assertIn("getGalleryVirtualGrouping() === 'combined' || currentNode.isGalleryVirtualCharacterGroup", self.js)

    def test_uncategorized_character_mode_groups_once_and_uses_saved_aliases(self):
        self.assertIn("const shouldGroup = getGalleryVirtualGrouping() === 'character' && !isQuerylessVirtualContainer && !currentNode.isGalleryVirtualCharacterGroup;", self.js)
        self.assertIn("name: getGalleryFolderKoreanDisplayName(sourceNames.join(' and ') || parent.name || '기타')", self.js)
        self.assertIn("isGalleryVirtualUnassigned: true", self.js)
        self.assertIn("galleryCharacterNameOverrides[key]", self.js)

    def test_virtual_manager_has_root_row_and_arbitrary_depth_styles(self):
        self.assertIn("gallery-virtual-folder-manager-root", self.js)
        self.assertIn("루트에 추가", self.js)
        self.assertIn("prepareGalleryVirtualFolderRoot", self.js)
        self.assertIn("row.style.setProperty('--gallery-virtual-depth', String(depth))", self.js)
        self.assertIn("tree.appendChild(emptyState)", self.js)
        self.assertNotIn("tree.innerHTML = '<div class=\"gallery-virtual-folder-fields-help\">아직 가상 폴더가 없습니다.", self.js)
        self.assertIn("--gallery-virtual-depth", (ROOT / "static" / "index.css").read_text(encoding="utf-8"))
        self.assertNotIn('data-depth="3"', (ROOT / "static" / "index.css").read_text(encoding="utf-8"))

    def test_root_uncategorized_subtracts_all_virtual_descendants(self):
        self.assertIn(
            "async function buildGalleryVirtualUncategorizedNode(node, baseImages, descendantRootNode = node, resolveState = null)",
            self.js,
        )
        self.assertIn("collectGalleryVirtualDescendantImages(descendantRootNode, new Map(), resolveState)", self.js)
        self.assertIn("virtualParentId: node?.isGalleryVirtualFolder ? node.id : null", self.js)
        self.assertIn("function buildGalleryVirtualUncategorizedPlaceholderNode(ownerNode, descendantRootNode)", self.js)
        self.assertIn("virtualUncategorizedPending: true", self.js)
        self.assertIn("ownerNode?.galleryVirtualUncategorizedNode", self.js)
        self.assertIn("ownerNode.galleryVirtualUncategorizedNode = placeholder", self.js)
        self.assertIn("currentNode.isGalleryVirtualUnassigned && currentNode.virtualUncategorizedPending", self.js)
        self.assertIn("if (currentNode.isGalleryVirtualRoot || currentNode.isGalleryVirtualFolder) {", self.js)
        self.assertIn("await buildGalleryVirtualUncategorizedNode(", self.js)

    def test_virtual_summary_requests_use_shared_max_five_limiter(self):
        self.assertIn("summaryQueue: []", self.js)
        self.assertIn("summaryActive: 0", self.js)
        self.assertIn("summaryLimit: 5", self.js)
        self.assertIn("resolveQueue: []", self.js)
        self.assertIn("resolveActive: 0", self.js)
        self.assertIn("resolveLimit: 5", self.js)
        self.assertIn("function enqueueGalleryVirtualSummaryRequest(resolveState, task)", self.js)
        self.assertIn("function enqueueGalleryVirtualResolveRequest(resolveState, task)", self.js)
        self.assertIn("resolveState.summaryActive < resolveState.summaryLimit", self.js)
        self.assertIn("resolveState.resolveActive < resolveState.resolveLimit", self.js)
        self.assertIn("enqueueGalleryVirtualResolveRequest(state, async () =>", self.js)
        self.assertIn("for (const child of (node.folders || []))", self.js)
        self.assertNotIn("Promise.all((node.folders || []).map(child => hydrateGalleryVirtualFolderSummary(child, resolveState)))", self.js)

    def test_missing_resolve_paths_get_ordered_minimal_fallback_items(self):
        self.assertIn("const existingByPath = new Map();", self.js)
        self.assertIn("const existing = existingByPath.get(path);", self.js)
        self.assertIn("isGalleryVirtualFallback: true", self.js)
        self.assertIn("galleryParentPath: parentPath", self.js)
        self.assertIn("galleryParentName: parentPath.split('/').pop() || ''", self.js)
        self.assertIn("return paths.map(rawPath =>", self.js)

    def test_virtual_mode_normalizes_trash_view_to_all(self):
        self.assertIn(
            "if (getGalleryViewMode() === 'virtual' && getGalleryRadioValue('viewMode', 'general') === 'trash')",
            self.js,
        )
        self.assertIn("setGalleryRadioValue('viewMode', 'all');", self.js)
        self.assertIn("if (getGalleryViewMode() === 'virtual' && mode === 'trash')", self.js)
        self.assertIn(
            "const isTrashMode = getGalleryViewMode() !== 'virtual' && modeInput && modeInput.value === 'trash';",
            self.js,
        )

    def test_virtual_controls_do_not_reserve_header_width_and_keep_keyboard_access_in_sync(self):
        self.assertIn('class="gallery-date-control-group gallery-virtual-controls-is-hidden"', self.html)
        self.assertIn('aria-hidden="true"', self.html)
        self.assertIn('aria-hidden="true" hidden>', self.html)
        self.assertIn('class="gallery-header-control-stack"', self.html)
        self.assertIn('class="gallery-header-control-row gallery-header-top-row"', self.html)
        self.assertIn('class="gallery-header-control-row gallery-header-bottom-row"', self.html)
        self.assertIn("gallery-virtual-controls-is-hidden', !isVirtual", self.js)
        self.assertIn("controls.hidden = !isVirtual", self.js)
        self.assertIn("controls.setAttribute('aria-hidden', String(!isVirtual))", self.js)
        self.assertIn("input.tabIndex = isVirtual ? 0 : -1", self.js)
        self.assertIn("#galleryVirtualControls.gallery-virtual-controls-is-hidden, #galleryVirtualControls[hidden] { display: none", self.css)
        self.assertNotIn("visibility: hidden; pointer-events: none", self.css)

    def test_virtual_folder_editor_uses_centered_custom_modal_and_patch_flow(self):
        self.assertIn('id="galleryVirtualFolderEditorLayer"', self.html)
        self.assertIn('id="galleryVirtualFolderEditorNameInput"', self.html)
        self.assertIn('id="galleryVirtualFolderEditorQueryInput"', self.html)
        self.assertIn('id="galleryVirtualFolderEditorScopeInput"', self.html)
        self.assertIn('id="galleryVirtualFolderEditorModeInput"', self.html)
        self.assertIn('onclick="saveGalleryVirtualFolderEdit()"', self.html)
        self.assertIn(".gallery-virtual-folder-editor-layer { position: fixed", self.css)
        self.assertIn("galleryVirtualFolderEditingId = String(folderId)", self.js)
        self.assertIn("layer.style.display = 'flex'", self.js)
        self.assertIn("async function saveGalleryVirtualFolderEdit()", self.js)
        self.assertIn("method: 'PATCH'", self.js)
        self.assertIn("setGalleryVirtualFolderEditorStatus(error.message || error)", self.js)
        self.assertNotIn("const name = prompt('가상 폴더 이름'", self.js)

    def test_virtual_folder_manager_prompt_inputs_have_autocomplete(self):
        self.assertIn('id="galleryVirtualFolderAutocomplete"', self.html)
        self.assertIn('id="galleryVirtualFolderEditorAutocomplete"', self.html)
        self.assertIn("updateGalleryVirtualFolderAutocomplete('create')", self.html)
        self.assertIn("updateGalleryVirtualFolderAutocomplete('editor')", self.html)
        self.assertIn("handleGalleryVirtualFolderAutocompleteKeydown(event, 'create')", self.html)
        self.assertIn("handleGalleryVirtualFolderAutocompleteKeydown(event, 'editor')", self.html)
        self.assertIn("/api/gallery/prompt_index/autocomplete?q=", self.js)
        self.assertIn("getGalleryVirtualFolderAutocompleteScopePath", self.js)
        self.assertIn("getGalleryVirtualFolderAutocompleteMode", self.js)
        self.assertIn("setTimeout(async () =>", self.js)
        self.assertIn("}, 180);", self.js)
        self.assertIn("clearGalleryVirtualFolderAutocomplete('create')", self.js)
        self.assertIn("clearGalleryVirtualFolderAutocomplete('editor')", self.js)
        self.assertIn("version: 0", self.js)
        self.assertIn("state.version += 1", self.js)
        self.assertIn("const requestVersion = state.version", self.js)
        self.assertIn("if (state.version !== requestVersion) return;", self.js)
        self.assertIn("current.replace(/[^,\\s\\n|]*$/, String(value || ''))", self.js)

    def test_virtual_cards_use_lazy_summary_and_leaf_only_resolution(self):
        self.assertIn("function createGalleryVirtualResolveState()", self.js)
        self.assertIn("summaryCompleted: new Map()", self.js)
        self.assertIn("async function hydrateGalleryVirtualFolderSummary(node, resolveState)", self.js)
        self.assertIn("function isGalleryVirtualContainerNode(node)", self.js)
        self.assertIn("resolve?summary=1&ts=", self.js)
        self.assertIn("if (currentNode.isGalleryVirtualFolder && currentNode.query && !isVirtualContainer)", self.js)
        self.assertIn(": isVirtualContainer\n            ? []", self.js)
        self.assertIn("&& !isVirtualContainer) {", self.js)
        self.assertIn("new IntersectionObserver", self.js)
        self.assertIn("galleryVirtualSummaryObservers.add(observer)", self.js)
        self.assertIn("galleryVirtualRenderGeneration", self.js)
        self.assertIn("generation !== galleryVirtualRenderGeneration", self.js)
        self.assertIn("galleryVirtualSummaryObservers.forEach(observer => observer.disconnect())", self.js)
        self.assertIn("await hydrateGalleryVirtualFolderSummaries(sortedFolders, state)", self.js)
        self.assertIn("sortGalleryVirtualFolderCards(folders)", self.js)
        self.assertIn("child.total_images = 0;", self.js)

    def test_virtual_image_batch_settings_and_order_are_applied_before_dom_render(self):
        self.assertIn("imageRenderBatchSize: 1000", self.js)
        self.assertIn("clampGalleryNumber(data.imageRenderBatchSize, 1000, 100, 10000)", self.js)
        self.assertIn('id="galleryImageRenderBatchSizeInput"', self.html)
        self.assertIn("min=\"100\" max=\"10000\" step=\"100\"", self.html)
        self.assertIn("const orderedImages = [...(images || [])].sort", self.js)
        self.assertIn("galleryImageOrder === 'oldest'", self.js)
        self.assertIn("const appendImageBatch = (startIndex, endIndex)", self.js)
        self.assertIn("typeof IntersectionObserver !== 'undefined'", self.js)
        self.assertIn("galleryImageRenderSessions.forEach(session => session.cleanup?.())", self.js)
        self.assertNotIn("gallery-image-order-control", self.js)
        self.assertIn('name="sortMode" value="newest"', self.html)
        self.assertIn('name="sortMode" value="oldest"', self.html)
        self.assertIn("function onGallerySortChange()", self.js)

    def test_virtual_search_and_uncategorized_summary_show_progress_and_hide_zero(self):
        self.assertIn("function beginGalleryVirtualLoading(container, title, message = '')", self.js)
        self.assertIn("gallery-virtual-load-state", self.js)
        self.assertIn("getGalleryVirtualUncategorizedSummaryUrl(ownerNode)", self.js)
        self.assertIn("uncategorized_summary?owner_id=", self.js)
        self.assertIn("hydrateGalleryVirtualUncategorizedSummary(", self.js)
        self.assertIn("if (!summary.indexed)", self.js)
        self.assertIn("source: 'fallback'", self.js)
        self.assertIn("ownerNode.galleryVirtualUncategorizedNode = null", self.js)
        self.assertIn("if (unassigned) childFolders.push(unassigned)", self.js)

    def test_sort_controls_follow_folder_or_image_context_and_keep_separate_state(self):
        self.assertIn("let galleryFolderSort = 'name';", self.js)
        self.assertIn("folderSort: galleryFolderSort", self.js)
        self.assertIn("function syncGallerySortControls(context = 'folder')", self.js)
        self.assertIn("visibleValues = imageContext ? ['newest', 'oldest'] : ['name', 'count']", self.js)
        self.assertIn("label.hidden = !visibleValues.includes(input.value)", self.js)
        self.assertIn("syncGallerySortControls('folder');", self.js)
        self.assertIn("syncGallerySortControls(hasFolderCards ? 'folder' : 'image');", self.js)
        self.assertIn("const sortMode = galleryFolderSort;", self.js)
        self.assertIn("galleryFolderSort = data.folderSort === 'count'", self.js)

    def test_virtual_character_cards_keep_duo_group_names_and_dakimakura_badge(self):
        self.assertIn("galleryParentCharNames", self.js)
        self.assertIn("galleryParentIsDakimakura", self.js)
        self.assertIn("isVirtualCharacterGroup", self.js)
        self.assertIn("isGalleryDakimakuraFolder(child)", self.js)
        self.assertIn("<div class=\"daki-badge-neon\">DAKIMAKURA</div>", self.js)
        self.assertIn("flatMap(splitGalleryCharacterNameParts)", self.js)

    def test_virtual_manager_reparent_select_and_prompt_syntax_are_visible(self):
        self.assertIn('select title="상위 폴더 이동"', self.js)
        self.assertIn(".gallery-virtual-folder-manager-actions select", self.css)
        self.assertIn(".gallery-virtual-folder-manager-actions select option", self.css)
        self.assertIn("%문구%=부분 일치", self.html)
        self.assertIn("||=OR", self.html)


if __name__ == "__main__":
    unittest.main()
