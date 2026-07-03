import os
import unittest


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_repo_file(*parts):
    with open(os.path.join(ROOT_DIR, *parts), "r", encoding="utf-8") as handle:
        return handle.read()


class GalleryTagAssignmentModeStaticTests(unittest.TestCase):
    def test_gallery_tag_assignment_mode_frontend_hooks_exist(self):
        index_html = read_repo_file("index.html")
        index_js = read_repo_file("static", "index.js")
        index_css = read_repo_file("static", "index.css")

        self.assertIn("galleryTagAssignmentModeBtn", index_html)
        self.assertIn("galleryTagAssignmentModeStatus", index_html)
        self.assertIn("galleryTagAssignmentModeBar", index_html)
        self.assertIn("galleryTagAssignmentModeBarText", index_html)
        self.assertIn("function toggleGalleryTagAssignmentMode()", index_js)
        self.assertIn("function selectGalleryTagForAssignment(", index_js)
        self.assertIn("async function applySelectedGalleryTagToImage(", index_js)
        self.assertIn("function updateGalleryTagAssignmentBar()", index_js)
        self.assertIn("gallery-tag-assignment-mode", index_css)
        self.assertIn("gallery-tag-assignment-bar", index_css)
        self.assertIn("gallery-tag-assignment-selected", index_css)


if __name__ == "__main__":
    unittest.main()
