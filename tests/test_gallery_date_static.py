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


class GalleryDateStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js = read_page_scripts(ROOT, "index.html")
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")

    def test_date_controls_and_character_default_are_present(self):
        self.assertIn('name="galleryViewMode" value="character"', self.html)
        self.assertIn('name="galleryViewMode" value="date"', self.html)
        self.assertIn('name="galleryDateGrouping" value="month"', self.html)
        self.assertIn('name="galleryDateGrouping" value="week"', self.html)
        self.assertIn('name="galleryDateGrouping" value="day"', self.html)
        brand_bar = self.html.split('<div id="brand-filter-bar">', 1)[1].split('</div>', 1)[0]
        self.assertNotIn('galleryViewModeSelect', brand_bar)
        self.assertNotIn('galleryDateGroupingSelect', brand_bar)
        self.assertNotIn('galleryViewModeSelect', self.html)
        self.assertNotIn('galleryDateGroupingSelect', self.html)
        self.assertIn('class="gallery-header-control-stack"', self.html)
        self.assertIn('class="gallery-header-control-row gallery-header-top-row"', self.html)
        self.assertIn('class="gallery-header-control-row gallery-header-bottom-row"', self.html)
        self.assertIn('class="gallery-date-controls"', self.html)
        self.assertIn("let galleryViewMode = 'character'", self.js)
        self.assertIn("let galleryDateGrouping = 'month'", self.js)
        self.assertIn("setGalleryRadioValue('galleryViewMode', getGalleryViewMode())", self.js)
        self.assertIn("setGalleryRadioValue('galleryDateGrouping', getGalleryDateGrouping())", self.js)

    def test_date_groups_collect_recursively_and_preserve_real_parent(self):
        collector = extract_js_function(self.js, "collectGalleryFolderImages")
        builder = extract_js_function(self.js, "buildGalleryDateGroups")

        self.assertIn("(folder.folders || []).forEach((child) => collectGalleryFolderImages(child, output, seenPaths))", collector)
        self.assertIn("galleryParentPath: parent.path", collector)
        self.assertIn("collectGalleryFolderImages(sourceNode, images, seenPaths)", builder)
        self.assertIn("item?.mtime", builder)
        self.assertIn("galleryParentName", collector)

    def test_date_grouping_supports_local_month_day_and_iso_week(self):
        descriptor = extract_js_function(self.js, "getGalleryDateGroupDescriptor")
        iso = extract_js_function(self.js, "getGalleryIsoWeekInfo")

        self.assertIn("new Date(timestamp * 1000)", descriptor)
        self.assertIn("${year}년 ${date.getMonth() + 1}월", descriptor)
        self.assertIn("${year}-${month}-${day}", descriptor)
        self.assertIn("getGalleryIsoWeekInfo(date)", descriptor)
        self.assertIn("Date.UTC", iso)
        self.assertIn("isoYear", iso)
        self.assertIn("week", iso)

    def test_groups_are_latest_first_and_virtual_nodes_reuse_image_grid(self):
        builder = extract_js_function(self.js, "buildGalleryDateGroups")
        mode_handler = extract_js_function(self.js, "onGalleryViewModeChange")
        renderer = extract_js_function(self.js, "renderView")
        opener = extract_js_function(self.js, "renderCollapsibleGrid")

        self.assertIn("latestMtime", builder)
        self.assertIn("latestDiff", builder)
        self.assertIn(".sort((a, b)", builder)
        self.assertIn("isGalleryDateGroup: true", builder)
        self.assertIn("currentPath = topCategory ? [rootTree, topCategory]", mode_handler)
        self.assertIn("buildGalleryDateDisplayGroups(currentPath[1]", renderer)
        self.assertIn("enterGalleryFolder(child)", opener)
        self.assertIn("renderImageGrid(cont, imageTitle, displayImages, currentNode)", renderer)

    def test_virtual_date_nodes_are_not_saved_in_session_path(self):
        session_keys = extract_js_function(self.js, "getGallerySessionPathKeys")
        saver = extract_js_function(self.js, "saveGallerySessionState")

        self.assertIn("findIndex(isGalleryDateGroupNode)", session_keys)
        self.assertIn("getGallerySessionPathKeys()", saver)
        self.assertIn("galleryViewMode", self.js)
        self.assertIn("galleryDateGrouping", self.js)

    def test_date_groups_support_multi_selection_without_bulk_delete(self):
        renderer = extract_js_function(self.js, "renderCollapsibleGrid")
        selector = extract_js_function(self.js, "selectGalleryMultiFolderElement")

        self.assertIn("gallery-multi-folder-selectable", renderer)
        self.assertIn("const multiFolderKey = getGalleryMultiFolderKey(child)", renderer)
        self.assertIn("card.galleryMultiFolderNode = child", renderer)
        self.assertIn("card.ondblclick", renderer)
        self.assertIn("toggleGalleryMultiFolder(child, card)", renderer)
        self.assertIn("if (!isDateGroup)", renderer)
        self.assertIn("if (isGalleryBulkDeleteMode) {\n                if (isDateGroup) event.preventDefault();\n                return;\n            }", renderer)
        self.assertIn("node?.galleryMultiFolderNode", selector)

    def test_combined_date_groups_use_real_image_parent_paths(self):
        builder = extract_js_function(self.js, "buildCombinedGalleryNode")
        prompt_scope = extract_js_function(self.js, "getGalleryPromptSearchScopePaths")

        self.assertIn("isGalleryDateGroupNode(folder)", builder)
        self.assertIn("getGalleryImageParentInfo(item, folder).path", builder)
        self.assertIn("currentNode.sourcePaths.slice()", prompt_scope)


if __name__ == "__main__":
    unittest.main()
