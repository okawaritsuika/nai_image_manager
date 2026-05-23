import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_text(path):
    return (ROOT / path).read_text(encoding="utf-8")


class LiveClassifierStage2StaticTests(unittest.TestCase):
    def test_live_rules_api_exists_and_does_not_save_custom_rules(self):
        app_py = read_text("app.py")

        self.assertIn("@app.route('/api/live_classifier/rules', methods=['GET'])", app_py)
        self.assertIn("def live_classifier_rules():", app_py)
        rules_route = app_py.split("def live_classifier_rules():", 1)[1].split("@app.route", 1)[0]

        self.assertIn('request.args.get("mode", "existing")', rules_route)
        self.assertIn('if mode == "new":', rules_route)
        self.assertIn("rules = []", rules_route)
        self.assertIn('config.get("custom_rules", [])', rules_route)
        self.assertIn("normalize_custom_route_rules(rules)", rules_route)
        self.assertNotIn('config["custom_rules"]', rules_route)
        self.assertNotIn("save_config", rules_route)

        self.assertIn('("group", "single", "all", "base", "char")', app_py)

    def test_live_rule_editor_markup_is_present(self):
        html = read_text("static/live_classifier.html")

        for token in (
            "live-rule-panel",
            "reloadLiveRules()",
            "addCandidateAsTopRule()",
            "addCandidateAsChildRule()",
            "liveTopRuleList",
            "selectedTopRuleName",
            "liveChildRuleList",
            "rule-candidate-panel",
            "candidateFolderInput",
            "candidateScopeSelect",
            "candidateConditionSelect",
            "candidateMatchCountInput",
            "candidateTagList",
        ):
            self.assertIn(token, html)

    def test_live_classifier_js_uses_temp_rules_only_for_preview_and_reclassify(self):
        js = read_text("static/live_classifier.js")

        for token in (
            "let liveTempRules = [];",
            "let selectedTopRuleIndex = -1;",
            "let candidateTags = [];",
            "async function reloadLiveRules()",
            "function addCandidateTag(",
            "function renderClickablePromptTags(",
            "function addCandidateAsTopRule()",
            "function addCandidateAsChildRule()",
            "function renderLiveRuleEditor()",
            "function editTopRule(",
            "function editChildRule(",
        ):
            self.assertIn(token, js)

        self.assertIn("rules: liveTempRules", js)
        self.assertIn("let useCharId = liveParams.get('char_id') === '1';", js)
        self.assertNotIn("/api/save_custom_rules", js)
        self.assertNotIn("/api/custom_rules", js)

    def test_live_classifier_css_has_rule_editor_layout(self):
        css = read_text("static/live_classifier.css")

        self.assertIn("grid-template-columns: 390px minmax(0, 1fr) 430px;", css)
        for token in (
            ".live-rule-panel",
            ".live-rule-card",
            ".rule-candidate-panel",
            ".candidate-tag-list",
            ".prompt-token-box",
        ):
            self.assertIn(token, css)

    def test_live_apply_uses_common_image_logic_engine(self):
        app_py = read_text("app.py")
        image_py = read_text("image_logic.py")
        workspace_py = read_text("workspace_logic.py")
        js = read_text("static/live_classifier.js")

        self.assertIn("normalize_custom_route_rules_for_runtime", app_py)
        self.assertIn('"live_direct_tags"', app_py)
        self.assertIn("image_logic.process_file_list", app_py)

        worker = app_py.split("def run_live_apply_to_gallery_worker(job_options):", 1)[1].split("@app.route", 1)[0]
        self.assertNotIn("live_apply_fetch_preview_rows", worker)
        self.assertNotIn("shutil.move", worker)
        self.assertIn("override_custom_rules=runtime_rules", worker)

        route = app_py.split("def live_classifier_apply_to_gallery():", 1)[1].split("@app.route", 1)[0]
        self.assertIn("with LIVE_APPLY_JOB_LOCK:", route)
        self.assertIn("LIVE_APPLY_JOB.clear()", route)
        self.assertNotIn("reset_live_apply_job", route)

        self.assertIn("def process_file_list(", image_py)
        self.assertIn("def resolve_custom_route_category(", image_py)
        self.assertIn("override_custom_rules=None", image_py)
        self.assertIn("resolve_custom_route_category(custom_rules", image_py)

        self.assertIn('rule.get("live_direct_tags")', workspace_py)
        self.assertIn('condition_mode == "count"', workspace_py)

        self.assertIn("let liveApplyRunning = false;", js)
        self.assertIn("function setLiveApplyControlsDisabled(disabled)", js)
        self.assertIn("if (liveApplyRunning)", js)
        self.assertIn("already_running", js)


if __name__ == "__main__":
    unittest.main()
