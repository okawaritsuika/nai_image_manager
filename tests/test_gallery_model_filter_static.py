from tests.frontend_sources import read_page_scripts
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class GalleryModelFilterStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js = read_page_scripts(ROOT, "index.html")
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")

    def test_model_filter_options_and_all_default_are_present(self):
        self.assertIn('name="modelFamily" value="v5"', self.html)
        self.assertIn('name="modelFamily" value="v4_5"', self.html)
        self.assertIn('name="modelFamily" value="other"', self.html)
        self.assertIn('name="modelFamily" value="all" class="view-radio" checked', self.html)
        self.assertIn('>V5</label>', self.html)
        self.assertIn('>V4.5</label>', self.html)
        self.assertIn('>그 외</label>', self.html)
        self.assertIn('>모두</label>', self.html)

    def test_model_family_is_validated_persisted_and_restored(self):
        self.assertIn("const GALLERY_MODEL_FAMILY_VALUES = new Set(['all', 'v5', 'v4_5', 'other']);", self.js)
        self.assertIn("modelFamily = GALLERY_MODEL_FAMILY_VALUES.has(data.modelFamily)", self.js)
        self.assertIn("setGalleryRadioValue('modelFamily', modelFamily);", self.js)
        self.assertIn("modelFamily: GALLERY_MODEL_FAMILY_VALUES.has(modelFamily) ? modelFamily : 'all'", self.js)
        self.assertIn("function onGalleryModelFamilyChange()", self.js)
        self.assertIn("saveGalleryPersistentUi();\n    loadData();", self.js)

    def test_load_data_passes_encoded_model_family_query(self):
        self.assertIn("const selectedModelFamily = getGalleryRadioValue('modelFamily', modelFamily);", self.js)
        self.assertIn("&model_family=${encodeURIComponent(modelFamily)}", self.js)


if __name__ == "__main__":
    unittest.main()
