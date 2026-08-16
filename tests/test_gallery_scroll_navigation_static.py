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


class GalleryScrollNavigationStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.css = (ROOT / "static" / "index.css").read_text(encoding="utf-8")
        cls.js = (ROOT / "static" / "index.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")

    def test_gallery_only_native_scrollbar_hide_and_custom_structure(self):
        self.assertIn("html.gallery-scrollbar-custom", self.css)
        self.assertIn("html.gallery-scrollbar-custom::-webkit-scrollbar", self.css)
        self.assertIn("document.documentElement.classList.add('gallery-scrollbar-custom')", self.js)
        self.assertIn("document.documentElement.classList.remove('gallery-scrollbar-custom')", self.js)
        self.assertIn("html.gallery-scrollbar-custom #char-chip-container", self.css)
        self.assertIn("html.gallery-scrollbar-custom #nav-tabs", self.css)
        self.assertIn('id="galleryScrollNavigation"', self.html)
        self.assertIn('aria-label="갤러리 페이지 내비게이션"', self.html)
        self.assertIn('id="galleryScrollbarDestinationGuide"', self.html)
        self.assertIn('class="gallery-scrollbar-track"', self.html)
        self.assertIn('class="gallery-scrollbar-thumb"', self.html)
        self.assertIn('class="gallery-scrollbar-marks"', self.html)
        self.assertIn('role="scrollbar"', self.html)

    def test_gallery_rail_has_only_large_circular_dots(self):
        self.assertIn("top: 50%; right: 28px", self.css)
        self.assertIn("height: min(320px, 42vh)", self.css)
        self.assertNotIn("gallery-scroll-nav-guide", self.html)
        self.assertNotIn("gallery-scroll-nav-guide-fill", self.html)
        self.assertNotIn(".gallery-scroll-nav-guide", self.css)
        self.assertIn(".gallery-scroll-nav-dot { position: absolute; left: 50%;", self.css)
        self.assertIn("width: 30px; height: 30px;", self.css)
        self.assertIn("width: 8px; height: 8px;", self.css)
        self.assertIn("border: 2px solid var(--thumb)", self.css)
        self.assertIn(".gallery-scroll-nav-dot.is-active::before { width: 12px; height: 12px;", self.css)
        self.assertIn("scale(1.35)", self.css)
        self.assertNotIn("guideFill", self.js)

    def test_dot_count_and_short_page_cleanup(self):
        count = extract_js_function(self.js, "getGalleryScrollNavigationDotCount")
        update = extract_js_function(self.js, "updateGalleryScrollNavigation")

        self.assertIn("GALLERY_SCROLL_NAV_MIN_DOTS", count)
        self.assertIn("GALLERY_SCROLL_NAV_MAX_DOTS", count)
        self.assertIn("const GALLERY_SCROLL_NAV_MIN_DOTS = 7;", self.js)
        self.assertIn("const GALLERY_SCROLL_NAV_MAX_DOTS = 12;", self.js)
        self.assertIn("Math.ceil(maxScroll / Math.max(viewportHeight * 0.8, 1)) + 1", count)
        self.assertIn("elements.scrollbarThumb.style.height", update)
        self.assertIn("elements.scrollbarThumb.style.top", update)
        self.assertIn("elements.scrollbarMarks.replaceChildren()", update)
        self.assertIn("if (maxScroll < minScroll)", update)
        self.assertIn("galleryScrollNavigation.classList.remove('is-visible')", update)
        self.assertIn("elements.scrollbarGuide.classList.remove('is-visible')", update)
        self.assertIn("elements.scrollbarThumb.style.height = '0px'", update)
        self.assertIn("stopGalleryScrollNavigationDrag()", update)

    def test_scrollbar_marks_are_inside_track_and_non_interactive(self):
        self.assertIn(".gallery-scrollbar-track {", self.css)
        self.assertIn(".gallery-scrollbar-marks {", self.css)
        self.assertIn(".gallery-scrollbar-destination-guide-marker", self.css)
        self.assertIn("pointer-events: none;", self.css)
        self.assertIn("elements.scrollbarMarks.appendChild(guideMarker)", self.js)
        self.assertIn("elements.scrollbarMarks.querySelectorAll", self.js)
        self.assertIn("marker.classList.toggle('is-highlighted'", self.js)
        self.assertNotIn("left: 0; z-index: 5800", self.css)

    def test_hover_focus_and_custom_scrollbar_interactions(self):
        scroll_to_ratio = extract_js_function(self.js, "scrollGalleryScrollNavigationToRatio")
        initialize = extract_js_function(self.js, "initializeGalleryScrollNavigation")
        bind = extract_js_function(self.js, "bindGalleryScrollbarInteractions")

        self.assertIn("window.scrollTo({ top: maxScroll * boundedRatio, behavior });", scroll_to_ratio)
        self.assertIn("prefers-reduced-motion", self.js)
        self.assertIn("dot.addEventListener('mouseenter'", self.js)
        self.assertIn("dot.addEventListener('mouseleave'", self.js)
        self.assertIn("dot.addEventListener('focus'", self.js)
        self.assertIn("dot.addEventListener('blur'", self.js)
        self.assertIn("dot.addEventListener('click', (event) =>", self.js)
        self.assertIn("if (event.detail > 0) dot.blur();", self.js)
        self.assertIn("syncGalleryScrollNavigationGuideHighlight", self.js)
        self.assertIn("thumb.setPointerCapture(event.pointerId)", bind)
        self.assertIn("thumb.releasePointerCapture(pointerId)", self.js)
        self.assertIn("track.addEventListener('click'", bind)
        self.assertIn("track.addEventListener('keydown'", bind)
        for key in ("Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown"):
            self.assertIn(f"case '{key}'", bind)
        self.assertIn("bindGalleryScrollbarInteractions(elements)", initialize)
        self.assertIn("requestAnimationFrame", self.js)
        self.assertIn("new ResizeObserver(scheduleGalleryScrollNavigationUpdate)", initialize)


if __name__ == "__main__":
    unittest.main()
