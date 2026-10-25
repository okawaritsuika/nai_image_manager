from tests.frontend_sources import read_page_scripts
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def extract_js_function(source, name):
    marker = f"function {name}"
    start = source.index(marker)
    brace = source.index("{", start)
    depth = 0
    for index in range(brace, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(f"Function not closed: {name}")


class GalleryMultiFolderStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js = read_page_scripts(ROOT, "index.html")
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")

    def test_setting_can_enable_or_disable_multi_folder_selection(self):
        normalize = extract_js_function(self.js, "normalizeGalleryDesignSettings")
        setter = extract_js_function(self.js, "setGalleryMultiFolderSelectionEnabled")

        self.assertIn("multiFolderSelectionEnabled: data.multiFolderSelectionEnabled !== false", normalize)
        self.assertIn('id="galleryMultiFolderSelectionInput"', self.html)
        self.assertIn("saveGalleryDesignSettings()", setter)
        self.assertIn("clearGalleryMultiFolderSelection()", setter)

    def test_folder_cards_support_drag_double_click_and_safe_selection_mode(self):
        renderer = extract_js_function(self.js, "renderCollapsibleGrid")

        self.assertIn("gallery-multi-folder-selectable", renderer)
        self.assertIn("card.ondblclick", renderer)
        self.assertIn("galleryMultiFolderSelection.size > 0", renderer)
        self.assertIn("toggleGalleryMultiFolder(child, card)", renderer)
        self.assertIn("beginGalleryMultiFolderBoxSelection", self.js)
        self.assertIn('id="galleryMultiFolderSelectionBar"', self.html)

    def test_combined_view_recurses_and_keeps_real_parent_folder(self):
        collector = extract_js_function(self.js, "collectGalleryFolderImages")
        builder = extract_js_function(self.js, "buildCombinedGalleryNode")
        image_grid = extract_js_function(self.js, "renderImageGrid")

        self.assertIn("collectGalleryFolderImages(child, output, seenPaths)", collector)
        self.assertIn("galleryParentPath: parent.path", collector)
        self.assertIn("seenPaths", builder)
        self.assertIn("sourcePaths", builder)
        self.assertIn("getGalleryImageParentInfo(item, parentNode)", image_grid)
        self.assertIn("if (isTrashMode && !isCombinedView)", image_grid)

    def test_selected_folder_context_menu_opens_the_combined_view(self):
        renderer = extract_js_function(self.js, "renderCollapsibleGrid")
        opener = extract_js_function(self.js, "openSelectedGalleryFolders")

        self.assertIn("openGalleryMultiFolderContextMenu(event)", renderer)
        self.assertIn('id="galleryMultiFolderContextMenu"', self.html)
        self.assertIn("buildCombinedGalleryNode(folders)", opener)
        self.assertIn("currentPath = [...originPath, combinedNode]", opener)

    def test_selection_lookup_accepts_rendered_date_group_cards(self):
        selector = extract_js_function(self.js, "selectGalleryMultiFolderElement")

        self.assertIn("node?.galleryMultiFolderNode", selector)
        self.assertIn("getGalleryMultiFolderKey(item)", selector)

    def test_selection_bar_includes_safe_total_image_count(self):
        updater = extract_js_function(self.js, "updateGalleryMultiFolderSelectionUi")

        self.assertIn("galleryMultiFolderSelection.values()", updater)
        self.assertIn("Number(folder?.total_images)", updater)
        self.assertIn("Number.isFinite(value)", updater)
        self.assertIn("그림 ${imageCount}장", updater)

    def test_quick_character_editor_can_filter_by_original_name(self):
        editor = extract_js_function(self.js, "openGalleryCharacterNameQuickEditor")
        filterer = extract_js_function(self.js, "filterGalleryCharacterFromQuickEditor")

        self.assertIn("gallery-character-quick-filter-button", editor)
        self.assertIn('data-character-name="${escapeHtml(name)}"', editor)
        self.assertIn("filterGalleryCharacterFromQuickEditor(event)", editor)
        self.assertIn("currentSelectedBrand = 'ALL'", filterer)
        self.assertIn("currentSelectedChar = 'ALL'", filterer)
        self.assertIn("brandSelect.value = 'ALL'", filterer)
        self.assertIn("updateCharChips()", filterer)
        self.assertIn("searchInput.value = name", filterer)
        self.assertIn("handleSearch(name)", filterer)
        self.assertIn("closeGalleryCharacterNameQuickEditor()", filterer)

    def test_selection_bar_can_select_all_rendered_cards_once(self):
        selector = extract_js_function(self.js, "selectAllGalleryMultiFolderElements")

        self.assertIn("galleryDesignSettings.multiFolderSelectionEnabled", selector)
        self.assertIn("isGalleryBulkDeleteMode", selector)
        self.assertIn("isGalleryTagAssignmentMode", selector)
        self.assertIn("querySelectorAll('.gallery-multi-folder-selectable')", selector)
        self.assertIn("selectGalleryMultiFolderElement(node)", selector)
        self.assertIn("updateGalleryMultiFolderSelectionUi()", selector)
        self.assertIn('onclick="selectAllGalleryMultiFolderElements()"', self.html)
        self.assertIn(">모두 선택</button>", self.html)


if __name__ == "__main__":
    unittest.main()
