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


class GalleryRadialTagStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js = read_page_scripts(ROOT, "index.html")
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")
        cls.css = (ROOT / "static" / "index.css").read_text(encoding="utf-8")

    def test_setting_defaults_to_enabled_and_can_cancel_gesture(self):
        normalize = extract_js_function(self.js, "normalizeGalleryDesignSettings")
        setter = extract_js_function(self.js, "setGalleryRadialTagMenuEnabled")

        self.assertIn("radialTagMenuEnabled: data.radialTagMenuEnabled !== false", normalize)
        self.assertIn('id="galleryRadialTagMenuInput"', self.html)
        self.assertIn("saveGalleryDesignSettings()", setter)
        self.assertIn("cancelGalleryRadialTagGesture()", setter)

    def test_mouse_long_press_uses_existing_tag_api_and_supports_removal(self):
        begin = extract_js_function(self.js, "beginGalleryRadialTagGesture")
        target = extract_js_function(self.js, "isGalleryRadialTagPointerTarget")
        finish = extract_js_function(self.js, "finishGalleryRadialTagGesture")
        items = extract_js_function(self.js, "getGalleryRadialTagItems")

        self.assertIn("event.pointerType !== 'mouse'", target)
        self.assertIn("const GALLERY_RADIAL_TAG_LONG_PRESS_MS = 250", self.js)
        self.assertIn("GALLERY_RADIAL_TAG_LONG_PRESS_MS", begin)
        self.assertIn("galleryTagDefs", items)
        self.assertIn("tagId: ''", items)
        self.assertIn("updateGalleryImageTag(state.imagePath, selected.tagId)", finish)
        self.assertIn("document.addEventListener('pointermove', updateGalleryRadialTagGesture, true)", self.js)
        self.assertIn("document.addEventListener('pointerup', finishGalleryRadialTagGesture, true)", self.js)

    def test_compact_dial_uses_dynamic_svg_sectors(self):
        show = extract_js_function(self.js, "showGalleryRadialTagMenu")

        self.assertIn("gallery-radial-tag-dial-svg", show)
        self.assertIn("gallery-radial-tag-sector", show)
        self.assertIn("createElementNS('http://www.w3.org/2000/svg', 'path')", show)
        self.assertIn("getGalleryRadialTagSectorPath", show)
        self.assertIn("button.style.left = `${Math.cos(angle) * labelRadius}px`", show)
        self.assertIn("button.style.top = `${Math.sin(angle) * labelRadius}px`", show)
        self.assertNotIn("dialCenter + (Math.cos(angle) * labelRadius)", show)
        self.assertNotIn("dialCenter + (Math.sin(angle) * labelRadius)", show)
        self.assertIn("const dialSize = 200", show)
        self.assertIn("const outerRadius = 96", show)
        self.assertIn("const innerRadius = 34", show)
        self.assertIn("const labelRadius = 72", show)
        self.assertIn("width: 200px", self.css)
        self.assertIn("fill: #2563eb", self.css)
        self.assertIn("stroke: #eff6ff", self.css)
        self.assertIn(".gallery-radial-tag-sector.selected", self.css)
        self.assertNotIn("width: 66px", self.css)

    def test_image_click_handler_consumes_radial_suppression(self):
        mark = extract_js_function(self.js, "markGalleryRadialTagClickSuppressed")
        consume = extract_js_function(self.js, "consumeGalleryRadialTagClick")
        handler = extract_js_function(self.js, "handleGalleryImageCardClick")

        self.assertIn("galleryRadialTagSuppressClickUntil", mark)
        self.assertIn("dataset.galleryRadialTagSuppressClickUntil", mark)
        self.assertIn("event.preventDefault()", consume)
        self.assertIn("event.stopPropagation()", consume)
        self.assertIn("event.defaultPrevented || consumeGalleryRadialTagClick(event)", handler)
        self.assertIn("openZoom(imgSrc)", handler)

    def test_overlay_and_collision_guards_are_present(self):
        target = extract_js_function(self.js, "isGalleryRadialTagPointerTarget")

        self.assertIn('id="galleryRadialTagMenu"', self.html)
        self.assertIn('role="menu"', self.html)
        self.assertIn("isGalleryBulkDeleteMode || isGalleryTagAssignmentMode", target)
        self.assertIn("event.target.closest?.('button, a, input, select, textarea, .gallery-card-actions')", target)
        self.assertIn(".gallery-radial-tag-menu.open", self.css)
        self.assertIn(".gallery-radial-tag-item.selected", self.css)


if __name__ == "__main__":
    unittest.main()
