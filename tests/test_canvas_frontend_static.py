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


class CanvasFrontendStaticTests(unittest.TestCase):
    def test_reference_gen_mask_overlay_uses_fixed_alpha_helpers(self):
        source = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")

        self.assertIn("const REFERENCE_GEN_MASK_OVERLAY_ALPHA = 0.34;", source)
        self.assertIn("function clearReferenceGenOverlayPath", source)
        self.assertGreaterEqual(source.count("REFERENCE_GEN_MASK_OVERLAY_ALPHA"), 3)

    def test_reference_gen_detail_keeps_original_layer_unchanged(self):
        source = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")

        self.assertIn("mode: 'original-detail'", source)
        self.assertIn("referenceGenSession.currentSrc = pastedSrc;", source)
        self.assertNotIn("sourceLayer.src = data.src;", source)
        self.assertNotIn("sourceLayer.src = pastedSrc;", source)

    def test_reference_gen_detail_can_open_image_or_clip_layers(self):
        source = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")

        self.assertIn("function canUseLayerAsDetailSource(layer)", source)
        self.assertIn("return Boolean(layer && (layer.type === 'image' || layer.type === 'clip') && layer.src);", source)
        self.assertIn("if (isImageLike) {", source)
        self.assertIn("sourceLayerType: layer.type", source)

    def test_reference_gen_clipboard_import_resizes_to_original_session_size(self):
        source = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")
        body = extract_js_function(source, "pasteClipboardToReferenceGenImage")
        resize_body = extract_js_function(source, "resizeReferenceGenImageToSessionSize")

        self.assertIn("function resizeReferenceGenImageToSessionSize", source)
        self.assertIn("const targetWidth = Math.max(1, Math.round(Number(referenceGenSession.width)", body)
        self.assertIn("const fittedImage = await resizeReferenceGenImageToSessionSize", body)
        self.assertIn("referenceGenSession.width = targetWidth", body)
        self.assertIn("referenceGenSession.height = targetHeight", body)
        self.assertNotIn("referenceGenSession.width = Math.max(1, Math.round(Number(clipboard.width)", body)
        self.assertNotIn("referenceGenSession.height = Math.max(1, Math.round(Number(clipboard.height)", body)
        self.assertIn("const scale = Math.max(width / sourceWidth, height / sourceHeight);", resize_body)
        self.assertIn("const drawX = (width - drawWidth) / 2;", resize_body)
        self.assertIn("const drawY = (height - drawHeight) / 2;", resize_body)
        self.assertIn("ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);", resize_body)
        self.assertNotIn("ctx.drawImage(image, 0, 0, width, height);", resize_body)

    def test_inpaint_clip_layers_can_use_image_resize_controls(self):
        source = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")
        render_body = extract_js_function(source, "renderCanvasLayerStack")
        start_body = extract_js_function(source, "startImageResizeDrag")

        self.assertIn("function isResizableCanvasLayer(layer)", source)
        self.assertIn("layer.type === 'clip'", extract_js_function(source, "isResizableCanvasLayer"))
        self.assertIn("appendImageResizeHandles(layerEl, layer.id);", render_body)
        self.assertIn("isResizableCanvasLayer(layer)", start_body)

    def test_gpt_detail_prompt_prioritizes_source_aspect_ratio(self):
        source = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")
        body = extract_js_function(source, "buildGptDetailPrompt")

        self.assertIn("function formatCanvasAspectRatio", source)
        self.assertIn("const aspectRatio = formatCanvasAspectRatio(width, height);", body)
        self.assertIn("nearest supported resolution", body)
        self.assertIn("aspect ratio exactly", body)

    def test_reference_gen_upscale_keeps_clip_results_in_selection(self):
        source = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")
        app = (ROOT / "app.py").read_text(encoding="utf-8")
        html = (ROOT / "canvas.html").read_text(encoding="utf-8")

        self.assertIn("function isReferenceGenSourceClipSession()", source)
        self.assertIn("function addReferenceGenClipToSourceSelection", source)
        self.assertIn("await addReferenceGenResultToCanvas", source)
        self.assertIn("sourceSelectionId: selection.id", source)
        self.assertIn("layerWidth: sourceClip.layerWidth", source)
        self.assertIn("tempCategory: isReferenceGenSourceClipSession() ? 'canvas_inpaint' : 'canvas'", source)
        self.assertIn('save_category = data.get("tempCategory") or data.get("temp_category") or "canvas"', app)
        self.assertIn("category=save_category", app)
        self.assertIn('value="waifu2x"', html)
        self.assertNotIn('value="comfyui', html.lower())

    def test_reference_gen_detail_export_keeps_clip_results_in_selection(self):
        source = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")
        body = extract_js_function(source, "exportReferenceGenToCanvas")

        self.assertIn("await addReferenceGenResultToCanvas", body)
        self.assertNotIn("addReferenceGenImageLayerCoverCanvas", body)
        self.assertIn("function addReferenceGenClipToSourceSelection", source)
        self.assertIn("sourceReferenceGenClipId: sourceClip.id", source)

    def test_reference_gen_detail_uses_gpt_prompt_only(self):
        js = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")
        html = (ROOT / "canvas.html").read_text(encoding="utf-8")
        app = (ROOT / "app.py").read_text(encoding="utf-8")

        self.assertIn("function toggleReferenceGenDetailChoice(mode = 'face', anchor = null)", js)
        self.assertIn("strength: 'gpt-prompt'", js)
        self.assertIn("strength: 'gpt-reference-prompt'", js)
        self.assertNotIn("strength: 'standard'", js)
        self.assertNotIn("strength: 'strong'", js)
        self.assertNotIn("strength: 'ultra'", js)
        self.assertNotIn("strength: 'repair'", js)
        self.assertNotIn("requestReferenceGenDetail", js)
        self.assertNotIn("getReferenceGenDetailAutoUnload", js)
        self.assertNotIn("getReferenceGenDetailBackend", js)
        self.assertIn("function getReferenceGenMaskBounds", js)
        self.assertIn("function buildGptDetailPrompt", js)
        self.assertIn("function openGptDetailPrompt", js)
        self.assertIn("function copyGptDetailPrompt", js)
        self.assertIn("option.strength === 'gpt-reference-prompt'", js)
        self.assertIn("navigator.clipboard.writeText", js)
        self.assertIn("Request an output of exactly", js)
        self.assertIn("top, bottom, left, and right", js)
        self.assertIn("The second attached image is the character reference", js)
        self.assertIn("Change the iris color", js)
        self.assertIn("all visible eyes and irises", js)
        self.assertIn('id="gptDetailPromptLayer"', html)
        self.assertIn('id="gptDetailPromptText"', html)
        self.assertIn("얼굴 디테일 · GPT", html)
        self.assertIn("눈 디테일 · GPT", html)
        self.assertNotIn("/api/canvas/detail_region", app)
        self.assertIn("toggleReferenceGenDetailChoice('face', this)", html)
        self.assertIn("toggleReferenceGenDetailChoice('eye', this)", html)

    def test_reference_gen_detail_choice_menu_has_opaque_background(self):
        js = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")

        self.assertIn("background: var(--card-bg, #181824);", js)
        self.assertIn("color: var(--text-main, #f5f5f7);", js)
        self.assertIn("color:var(--text-muted, #a7a7b5);", js)
        self.assertNotIn("background: var(--panel-bg);", js)

    def test_canvas_drag_hot_paths_do_not_rerender_entire_surface(self):
        source = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")
        hot_paths = [
            "handleLayerMoveMouseMove",
            "handleMultiLayerMoveMouseMove",
            "handleSelectionMove",
            "handleSelectionResize",
            "handleImageResizeMouseMove",
            "handleMultiImageResizeMouseMove",
        ]

        self.assertIn("function updateCanvasHotLayerGeometry", source)
        for function_name in hot_paths:
            body = extract_js_function(source, function_name)
            self.assertNotIn("renderCanvasLayersOnSurface()", body, function_name)
            self.assertIn("updateCanvasHotLayerGeometry", body, function_name)

    def test_closing_clip_mask_size_popover_keeps_live_mask_editor(self):
        source = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")
        body = extract_js_function(source, "closeClipMaskSizePopover")

        self.assertIn("openClipMaskSizeTool = null;", body)
        self.assertIn(".clip-mask-tool-control.open", body)
        self.assertNotIn("renderClipOutputPanel()", body)

    def test_clip_mask_persistence_keeps_latest_stroke_while_saving(self):
        source = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")
        body = extract_js_function(source, "persistClipMask")

        self.assertIn("const clipMaskPersistRevisions = new WeakMap();", source)
        self.assertLess(
            body.index("clip.maskDataUrl = maskDataUrl;"),
            body.index("await saveClipDataUrlToServer(maskDataUrl)"),
        )
        self.assertGreaterEqual(
            body.count("clipMaskPersistRevisions.get(clip) !== revision"),
            2,
        )
        self.assertGreaterEqual(source.count("clip.maskDataUrl || clip.maskSrc"), 2)

    def test_large_canvas_layers_use_bounded_display_previews(self):
        source = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")
        app = (ROOT / "app.py").read_text(encoding="utf-8")
        render_body = extract_js_function(source, "renderCanvasLayerStack")
        merge_body = extract_js_function(source, "renderMergedCanvasToDataUrl")

        self.assertIn("const CANVAS_DISPLAY_PREVIEW_MAX_SIDE = 4096;", source)
        self.assertIn("function getCanvasLayerDisplaySrc", source)
        self.assertGreaterEqual(render_body.count("getCanvasLayerDisplaySrc(layer)"), 2)
        self.assertGreaterEqual(
            source.count("getCanvasDisplayImageSrc(item.src, item.width, item.height)"),
            2,
        )
        self.assertIn("loadImageElementForClip(layer.src)", merge_body)
        self.assertIn('request.args.get("preview")', app)
        self.assertIn("def serve_image_preview", app)
        self.assertIn("preview.thumbnail(", app)
        self.assertIn("CANVAS_DISPLAY_PREVIEW_BUILD_LOCK", app)
        self.assertIn("response.set_etag", app)

    def test_canvas_hot_geometry_updates_are_frame_coalesced_and_composited(self):
        source = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")
        body = extract_js_function(source, "updateCanvasHotLayerGeometry")
        position_body = extract_js_function(source, "setCanvasLayerNodePosition")

        self.assertIn("requestAnimationFrame", body)
        self.assertIn("pendingCanvasHotLayerIds", body)
        self.assertIn("translate3d", position_body)

    def test_canvas_geometry_drag_keeps_cached_pointer_space_stable(self):
        source = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")
        refresh_body = extract_js_function(source, "refreshActiveCanvasDragCoordinateCache")
        wheel_body = extract_js_function(source, "handleCanvasWheelZoom")
        pan_body = extract_js_function(source, "startCanvasWorkspacePanDrag")

        self.assertIn("surface.getBoundingClientRect()", refresh_body)
        self.assertIn("drag.surfaceLeft = rect.left", refresh_body)
        self.assertIn("hasActiveCanvasGeometryDrag()", wheel_body)
        self.assertIn("hasActiveCanvasGeometryDrag()", pan_body)

    def test_image_import_preserves_ratio_and_centers_with_contain_fit(self):
        js = (ROOT / "static" / "canvas.js").read_text(encoding="utf-8")
        geometry = extract_js_function(js, "getInitialImageLayerGeometry")
        importer = extract_js_function(js, "importImageLayer")
        result_importer = extract_js_function(js, "addReferenceGenImageLayerFitCanvas")

        self.assertIn("const containScale = Math.min(", geometry)
        self.assertIn("allowUpscale ? containScale : Math.min(containScale, 1)", geometry)
        self.assertIn("x: Math.round((canvasWidth - width) / 2)", geometry)
        self.assertIn("y: Math.round((canvasHeight - height) / 2)", geometry)
        self.assertIn("allowUpscale: true", importer)
        self.assertIn("getInitialImageLayerGeometry", result_importer)
        self.assertIn("allowUpscale: true", result_importer)
        self.assertNotIn("Math.max(", result_importer)

    def test_comfyui_code_paths_are_removed(self):
        paths = [
            ROOT / "app.py",
            ROOT / "upscale_logic.py",
            ROOT / "main_executor.pyw",
            ROOT / "index.html",
            ROOT / "canvas.html",
            ROOT / "static" / "index.js",
            ROOT / "static" / "canvas.js",
            ROOT / "static" / "canvas.css",
        ]

        for path in paths:
            self.assertNotIn("comfyui", path.read_text(encoding="utf-8").lower(), str(path))


if __name__ == "__main__":
    unittest.main()
