from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
CANVAS_JS = ROOT / "static" / "canvas.js"
CANVAS_CSS = ROOT / "static" / "canvas.css"


def read_canvas_js():
    return CANVAS_JS.read_text(encoding="utf-8")


def read_canvas_css():
    return CANVAS_CSS.read_text(encoding="utf-8")


class CanvasClipClipboardTests(unittest.TestCase):
    def test_clip_output_clipboard_context_menu_is_wired(self):
        source = read_canvas_js()

        self.assertIn("openClipOutputClipboardContextMenu", source)
        self.assertIn("copyClipOutputToInternalClipboard", source)
        self.assertIn("pasteInternalClipboardToClipInpaintResults", source)
        self.assertIn("clip-output-clipboard-context-menu", source)

    def test_clip_output_keyboard_shortcuts_are_scoped_to_selected_clip_output(self):
        source = read_canvas_js()

        self.assertIn("handleClipOutputClipboardShortcut", source)
        self.assertIn("isClipOutputKeyboardTargetActive()", source)
        self.assertIn("event.key.toLowerCase() === 'c'", source)
        self.assertIn("event.key.toLowerCase() === 'v'", source)

    def test_pasted_clip_output_is_added_as_inpaint_result_layer(self):
        source = read_canvas_js()

        self.assertIn("getOrCreateSelectionInpaintFolder(selection)", source)
        self.assertIn("renderOnCanvas: true", source)
        self.assertIn("sourceInternalClipboardClipId", source)

    def test_copy_writes_clip_output_to_system_clipboard(self):
        source = read_canvas_js()

        self.assertIn("writeClipOutputToSystemClipboard", source)
        self.assertIn("navigator.clipboard.write", source)
        self.assertIn("new ClipboardItem", source)

    def test_internal_clipboard_paste_only_reads_system_clipboard_when_requested(self):
        source = read_canvas_js()
        paste_fn_index = source.index("async function pasteInternalClipboardToClipInpaintResults")
        paste_source = source[paste_fn_index:source.index("const pastedSrc", paste_fn_index)]

        self.assertIn("let clipboard = clipOutputInternalClipboard", paste_source)
        self.assertIn("if (!clipboard?.src && options.preferCurrentOutput)", paste_source)
        self.assertIn("clipboard = buildClipboardPayloadFromClipOutputState(state)", paste_source)
        self.assertIn("if (options.preferSystemClipboard)", paste_source)
        self.assertIn("readExternalCanvasImageDataUrlFromSystemClipboard()", paste_source)
        self.assertNotIn("readImageDataUrlFromSystemClipboard", paste_source)

    def test_clip_output_import_button_uses_system_clipboard_then_current_output(self):
        source = read_canvas_js()

        self.assertIn("buildClipboardPayloadFromClipOutputState", source)
        self.assertIn("pasteInternalClipboardToClipInpaintResults({ preferSystemClipboard: true, preferCurrentOutput: true })", source)

    def test_paste_event_image_file_is_not_routed_to_clip_output_before_canvas_import(self):
        source = read_canvas_js()

        paste_handler_index = source.index("document.addEventListener('paste'")
        paste_source = source[paste_handler_index:source.index("async function consumePendingCanvasImport", paste_handler_index)]

        self.assertNotIn("handleClipOutputClipboardPasteEvent", paste_source)
        self.assertNotIn("pasteImageDataUrlToClipInpaintResults", source)
        self.assertIn("await importExternalCanvasImageFile(file)", paste_source)

    def test_external_copied_image_can_be_read_from_system_clipboard_for_canvas_import(self):
        source = read_canvas_js()

        self.assertIn("async function readExternalCanvasImageFileFromSystemClipboard()", source)
        self.assertIn("navigator.clipboard.read", source)
        self.assertIn("item.getType(type)", source)
        self.assertIn("new File([blob]", source)

        paste_handler_index = source.index("document.addEventListener('paste'")
        paste_source = source[paste_handler_index:source.index("async function consumePendingCanvasImport", paste_handler_index)]

        self.assertIn("let file = getFirstSupportedImageFileFromList(event.clipboardData?.files)", paste_source)
        self.assertIn("file = await readExternalCanvasImageFileFromSystemClipboard()", paste_source)
        self.assertIn("await importExternalCanvasImageFile(file)", paste_source)

    def test_pasted_clip_output_uses_current_selection_geometry(self):
        source = read_canvas_js()
        paste_fn_index = source.index("async function pasteInternalClipboardToClipInpaintResults")
        result_clip_index = source.index("const resultClip = {", paste_fn_index)
        result_clip_end = source.index("};", result_clip_index)
        result_clip_source = source[result_clip_index:result_clip_end]

        self.assertIn("normalizeSelectionAreaGeometry(selection)", source[paste_fn_index:result_clip_index])
        self.assertIn("x: pasteX", result_clip_source)
        self.assertIn("y: pasteY", result_clip_source)
        self.assertIn("layerWidth: pasteWidth", result_clip_source)
        self.assertIn("layerHeight: pasteHeight", result_clip_source)

    def test_pasted_clip_output_uses_base_clip_render_box(self):
        source = read_canvas_js()
        paste_fn_index = source.index("async function pasteInternalClipboardToClipInpaintResults")
        result_clip_index = source.index("const resultClip = {", paste_fn_index)
        result_clip_end = source.index("};", result_clip_index)
        paste_source = source[paste_fn_index:result_clip_end]

        self.assertIn("Number.isFinite(Number(clipboard.x))", paste_source)
        self.assertIn("? Number(clipboard.x)", paste_source)
        self.assertIn("Number.isFinite(Number(clipboard.y))", paste_source)
        self.assertIn("? Number(clipboard.y)", paste_source)
        self.assertIn("Number.isFinite(Number(clipboard.layerWidth))", paste_source)
        self.assertIn("? Number(clipboard.layerWidth)", paste_source)
        self.assertIn("Number.isFinite(Number(clipboard.layerHeight))", paste_source)
        self.assertIn("? Number(clipboard.layerHeight)", paste_source)
        self.assertIn("sourceSelectionX: pasteX", paste_source)
        self.assertIn("sourceSelectionY: pasteY", paste_source)
        self.assertIn("const cropX = Math.round(selection.x)", source)
        self.assertIn("const cropY = Math.round(selection.y)", source)

    def test_clip_output_clipboard_payload_preserves_source_clip_position(self):
        source = read_canvas_js()
        payload_index = source.index("function buildClipboardPayloadFromClipOutputState")
        payload_source = source[payload_index:source.index("async function imageSourceToBlob", payload_index)]

        self.assertIn("x: sourceClip.x ?? state.baseClip.x ?? sourceClip.sourceSelectionX", payload_source)
        self.assertIn("y: sourceClip.y ?? state.baseClip.y ?? sourceClip.sourceSelectionY", payload_source)

    def test_canvas_layer_render_diagnostics_are_available_for_pixel_drift_debugging(self):
        source = read_canvas_js()

        self.assertIn("function getCanvasLayerRenderDiagnostics", source)
        self.assertIn("window.debugCanvasLayerRenderDiagnostics", source)
        self.assertIn("(layer.type === 'clip' || layer.type === 'image')", source)
        self.assertIn("sourceSelectionX", source)
        self.assertIn("sourceSelectionY", source)
        self.assertIn("surfaceRelativeLeft", source)
        self.assertIn("naturalWidth", source)

    def test_clip_output_import_accepts_external_clipboard_image_with_current_render_box(self):
        source = read_canvas_js()
        paste_fn_index = source.index("async function pasteInternalClipboardToClipInpaintResults")
        paste_source = source[paste_fn_index:source.index("const pastedSrc", paste_fn_index)]

        self.assertIn("function buildExternalClipboardPayloadForClipOutput(imageDataUrl, state)", source)
        self.assertIn("externalImageDataUrl = await readExternalCanvasImageDataUrlFromSystemClipboard()", paste_source)
        self.assertIn("clipboard = buildExternalClipboardPayloadForClipOutput(externalImageDataUrl, state)", paste_source)
        self.assertIn("x: sourceClip.x ?? state.baseClip.x ?? state.selection.x", source)
        self.assertIn("layerWidth: sourceClip.layerWidth || state.baseClip.layerWidth || state.selection.layerWidth", source)
        self.assertIn("isExternalClipboard: true", source)

    def test_canvas_surface_uses_display_size_without_self_scaling_transform(self):
        source = read_canvas_js()
        render_index = source.index("function renderCanvas(width, height)")
        render_source = source[render_index:source.index("updateCanvasReadout", render_index)]

        self.assertIn("surface.style.width = `${displayWidth}px`", render_source)
        self.assertIn("surface.style.height = `${displayHeight}px`", render_source)
        self.assertIn("surface.style.transform = ''", render_source)
        self.assertNotIn("surface.style.transform = `scale(${scale})`", render_source)
        self.assertNotIn("surface.style.width = `${width}px`", render_source)

    def test_clip_output_toolbar_can_toggle_selection_overlay_without_changing_selection(self):
        source = read_canvas_js()

        self.assertIn("toggleClipOutputSelectionOverlayVisibility", source)
        self.assertIn("isSelectionOverlayHidden ? '선택 OFF' : '선택 ON'", source)
        self.assertIn("onclick=\"toggleClipOutputSelectionOverlayVisibility()\"", source)
        toggle_index = source.index("function toggleClipOutputSelectionOverlayVisibility")
        toggle_source = source[toggle_index:source.index("}", toggle_index)]
        self.assertIn("isSelectionOverlayHidden = !isSelectionOverlayHidden", toggle_source)
        self.assertIn("checkedSelectionId", source)

    def test_clip_output_panel_is_draggable_and_initially_positioned_by_selection(self):
        source = read_canvas_js()

        self.assertIn("let clipOutputPanelPosition = null", source)
        self.assertIn("let activeClipOutputPanelDrag = null", source)
        self.assertIn("positionClipOutputPanel(panel, target.selection, target.clip)", source)
        self.assertIn("bindClipOutputPanelDrag(panel)", source)
        self.assertIn("startClipOutputPanelDrag", source)
        self.assertIn("canvasLeft: selection.x + selection.layerWidth", source)
        self.assertIn("clipOutputPanelPosition = null", source[source.index("async function createClipFromSelection"):])

    def test_clip_output_panel_position_scales_with_canvas_zoom(self):
        source = read_canvas_js()

        self.assertIn("const displayScale = getCanvasDisplayScale()", source)
        self.assertIn("panel.style.left = `${Math.round(clipOutputPanelPosition.canvasLeft * displayScale + gap)}px`", source)
        self.assertIn("panel.style.top = `${Math.round(clipOutputPanelPosition.canvasTop * displayScale)}px`", source)
        self.assertIn("canvasLeft: Math.max(0, (nextLeft - gap) / displayScale)", source)
        self.assertIn("canvasTop: nextTop / displayScale", source)
        self.assertIn("const nextTop = Math.round(drag.startTop + event.clientY - drag.startClientY)", source)
        self.assertNotIn("const nextTop = Math.max(0, Math.round(drag.startTop + event.clientY - drag.startClientY))", source)

    def test_rendered_clip_layer_can_start_parent_selection_move(self):
        source = read_canvas_js()

        self.assertIn("function startSelectionMoveFromCanvasEvent(event, layer)", source)
        self.assertIn("renderCanvasLayerStack(layer.children, surface, displayScale, layer)", source)
        self.assertIn("renderCanvasLayerStack(layer.children, surface, displayScale, parentSelection)", source)
        self.assertIn("startSelectionMoveFromCanvasEvent(event, parentSelection)", source)
        self.assertIn("childStarts: buildSelectionChildMoveStarts([layer])", source)
        self.assertIn("checkedSelectionId = layer.id", source)

    def test_clip_output_can_restore_selection_and_children_to_source_position(self):
        source = read_canvas_js()

        self.assertIn("sourceSelectionX: cropX", source)
        self.assertIn("sourceSelectionY: cropY", source)
        self.assertIn("function restoreSelectionPositionToClipOutput()", source)
        self.assertIn("onclick=\"restoreSelectionPositionToClipOutput()\"", source)
        self.assertIn("const dx = sourcePosition.x - Number(selection.x || 0)", source)
        self.assertIn("const childStarts = buildSelectionChildMoveStarts([selection])", source)
        self.assertIn("selection.x = snapCanvasMovePosition(sourcePosition.x)", source)
        self.assertIn("selection.y = snapCanvasMovePosition(sourcePosition.y)", source)
        self.assertIn("child.x = snapCanvasMovePosition(start.x + dx)", source)
        self.assertIn("clipOutputPanelPosition = null", source)

    def test_selection_move_mouseup_snaps_selection_and_children_together(self):
        source = read_canvas_js()
        mouseup_index = source.index("function handleSelectionMouseUp")
        mouseup_source = source[mouseup_index:source.index("function getSelectionSizeTooltip", mouseup_index)]

        self.assertIn("selectionSnapDx = layer.x - oldX", mouseup_source)
        self.assertIn("selectionSnapDy = layer.y - oldY", mouseup_source)
        self.assertIn("layer.x = Math.round(oldX)", mouseup_source)
        self.assertIn("layer.y = Math.round(oldY)", mouseup_source)
        self.assertIn("child.x = Math.round(Number(child.x || 0) + selectionSnapDx)", mouseup_source)
        self.assertIn("child.y = Math.round(Number(child.y || 0) + selectionSnapDy)", mouseup_source)

    def test_canvas_move_drags_snap_positions_to_whole_pixels_during_mousemove(self):
        source = read_canvas_js()
        layer_move_index = source.index("function handleLayerMoveMouseMove")
        layer_move_source = source[layer_move_index:source.index("function handleMultiLayerMoveMouseMove", layer_move_index)]
        multi_move_index = source.index("function handleMultiLayerMoveMouseMove")
        multi_move_source = source[multi_move_index:source.index("function handleLayerMoveMouseUp", multi_move_index)]
        selection_move_index = source.index("function handleSelectionMove")
        selection_move_source = source[selection_move_index:source.index("function handleSelectionResize", selection_move_index)]

        self.assertIn("function snapCanvasMovePosition(value)", source)
        self.assertIn("layer.x = snapCanvasMovePosition(resolvedX.value)", layer_move_source)
        self.assertIn("layer.y = snapCanvasMovePosition(resolvedY.value)", layer_move_source)
        self.assertIn("const finalDx = snapCanvasMovePosition(resolvedX.value) - drag.startBoundsX", multi_move_source)
        self.assertIn("layer.x = snapCanvasMovePosition(start.x + finalDx)", multi_move_source)
        self.assertIn("layer.y = snapCanvasMovePosition(start.y + finalDy)", multi_move_source)
        self.assertIn("layer.x = snapCanvasMovePosition(resolvedX.value)", selection_move_source)
        self.assertIn("child.x = snapCanvasMovePosition(start.x + dx)", selection_move_source)

    def test_selection_geometry_normalization_snaps_existing_saved_coordinates(self):
        source = read_canvas_js()
        normalize_index = source.index("function normalizeSelectionAreaGeometry")
        normalize_source = source[normalize_index:source.index("function clearLayerDropMarkers", normalize_index)]

        self.assertIn("layer.x = Math.round(Number(layer.x || 0))", normalize_source)
        self.assertIn("layer.y = Math.round(Number(layer.y || 0))", normalize_source)

    def test_canvas_render_layers_do_not_keep_conflicting_inset_constraints(self):
        css_source = read_canvas_css()
        layer_rule_start = css_source.index(".canvas-render-layer {")
        layer_rule = css_source[layer_rule_start:css_source.index("}", layer_rule_start)]

        self.assertIn("position: absolute", layer_rule)
        self.assertNotIn("inset:", layer_rule)

    def test_canvas_image_layers_fill_their_render_box_like_canvas_export(self):
        css_source = read_canvas_css()
        img_rule_start = css_source.index(".canvas-render-layer.image-layer img {")
        img_rule = css_source[img_rule_start:css_source.index("}", img_rule_start)]

        self.assertIn("width: 100%", img_rule)
        self.assertIn("height: 100%", img_rule)
        self.assertIn("object-fit: fill", img_rule)

    def test_canvas_dom_image_layers_keep_visual_images_without_composite_flicker(self):
        source = read_canvas_js()
        render_index = source.index("function renderCanvasLayerStack")
        render_source = source[render_index:source.index("function addCanvasBaseLayer", render_index)]

        self.assertIn("img.src = layer.src", render_source)
        self.assertIn("layerEl.appendChild(img)", render_source)
        self.assertNotIn("renderCanvasCompositePreview", source)

    def test_clip_output_toolbar_does_not_clip_brush_size_popover(self):
        js_source = read_canvas_js()
        css_source = read_canvas_css()
        toolbar_rule_start = css_source.index(".canvas-clip-output-toolbar {")
        toolbar_rule = css_source[toolbar_rule_start:css_source.index("}", toolbar_rule_start)]
        popover_rule_start = css_source.index(".clip-brush-size-popover {")
        popover_rule = css_source[popover_rule_start:css_source.index("}", popover_rule_start)]

        self.assertIn("min-width: min(420px, calc(100vw - 32px))", css_source)
        self.assertIn("max-width: min(560px, calc(100vw - 32px))", css_source)
        self.assertIn("flex-wrap: wrap", toolbar_rule)
        self.assertIn("overflow: visible", toolbar_rule)
        self.assertIn("z-index: 120", popover_rule)
        self.assertIn("max-width: min(520px, calc(100vw - 80px))", css_source)
        self.assertIn("Math.min(520, Math.max(320, window.innerWidth * 0.34))", js_source)
        self.assertIn("const fitScale = maxViewportWidth / naturalWidth", js_source)
        self.assertIn("wrap.style.maxWidth = 'min(520px, calc(100vw - 80px))'", js_source)

    def test_clip_output_gray_background_can_drag_scroll_vertically(self):
        js_source = read_canvas_js()
        css_source = read_canvas_css()

        self.assertIn("background: #2a2a32", css_source)
        self.assertIn("bindClipOutputBackgroundScrollDrag(wrap)", js_source)
        self.assertIn("function bindClipOutputBackgroundScrollDrag(wrap)", js_source)
        self.assertIn("wrap.startClipOutputBackgroundScrollDrag", js_source)
        self.assertIn("function bindClipOutputBackgroundScrollDrag(wrap)", js_source)
        self.assertIn("wrap.scrollTop = drag.startScrollTop - (event.clientY - drag.startClientY)", js_source)
        self.assertIn("refreshClipAlphaSampler", js_source)
        self.assertIn("isTransparentClipPoint(point)", js_source)
        self.assertIn("clipAlphaSampler.getImageData(x, y, 1, 1).data[3] < 8", js_source)
        self.assertIn("wrap.startClipOutputBackgroundScrollDrag?.(event)", js_source)

    def test_clip_output_wheel_zooms_only_over_image_not_gray_background(self):
        js_source = read_canvas_js()

        self.assertIn("wrap.addEventListener('wheel', (event) => {", js_source)
        self.assertIn("if (event.target === wrap) return", js_source)
        self.assertIn("handleClipPreviewWheelZoom(event, wrap, img, clip, afterZoom)", js_source)
        self.assertIn("event.preventDefault()", js_source)

    def test_canvas_workspace_can_pan_by_dragging_empty_area(self):
        js_source = read_canvas_js()
        css_source = read_canvas_css()

        self.assertIn("let activeCanvasPanDrag = null", js_source)
        self.assertIn("let canvasPanOffsetX = 0", js_source)
        self.assertIn("let canvasPanOffsetY = 0", js_source)
        self.assertIn("bindCanvasWorkspacePanDrag()", js_source)
        self.assertIn("applyCanvasWorkspacePanOffset()", js_source)
        self.assertIn("function isCanvasWorkspacePanTarget(event)", js_source)
        self.assertIn("workspace.addEventListener('pointerdown', startCanvasWorkspacePanDrag)", js_source)
        self.assertIn("stage.style.transform = `translate(${Math.round(canvasPanOffsetX)}px, ${Math.round(canvasPanOffsetY)}px)`", js_source)
        self.assertIn("canvasPanOffsetX = activeCanvasPanDrag.startOffsetX + event.clientX - activeCanvasPanDrag.startClientX", js_source)
        self.assertIn("canvasPanOffsetY = activeCanvasPanDrag.startOffsetY + event.clientY - activeCanvasPanDrag.startClientY", js_source)
        self.assertIn(".canvas-workspace.canvas-pan-dragging", css_source)
        self.assertIn(".canvas-render-layer.image-layer", js_source)
        self.assertIn(".selection-area-layer", js_source)


if __name__ == "__main__":
    unittest.main()
