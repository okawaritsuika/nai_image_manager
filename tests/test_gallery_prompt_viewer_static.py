from tests.frontend_sources import read_page_scripts
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class GalleryPromptViewerStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.js = read_page_scripts(ROOT, "index.html")
        cls.viewer = cls.js[cls.js.index("function renderPromptViewer"):]

    def test_generation_details_are_rendered_before_base_prompt(self):
        details = self.viewer.index('prompt-generation-details')
        base_prompt = self.viewer.index('>Base Prompt</div>')
        self.assertLess(details, base_prompt)
        self.assertIn('모델:', self.viewer)
        self.assertIn('샘플러:', self.viewer)
        self.assertIn('Steps:', self.viewer)

    def test_model_key_fallback_and_missing_value_are_explicit(self):
        self.assertIn('data.modelName, data.model_name, data.model', self.js)
        self.assertIn("return '정보 없음';", self.js)

    def test_generation_values_are_escaped_before_html_rendering(self):
        self.assertIn('escapeHtml(modelName)', self.viewer)
        self.assertIn('escapeHtml(sampler)', self.viewer)
        self.assertIn('escapeHtml(steps)', self.viewer)

    def test_existing_prompt_sections_remain_present(self):
        self.assertIn('>Base Prompt</div>', self.viewer)
        self.assertIn('>Base Caption</div>', self.viewer)
        self.assertIn('>Negative Prompt</div>', self.viewer)
        self.assertIn('Char Prompt', self.viewer)


if __name__ == "__main__":
    unittest.main()
