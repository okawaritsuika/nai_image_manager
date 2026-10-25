import base64
import io
import json
import os
import tempfile
import types
import unittest
import zipfile
from unittest import mock

from PIL import Image

import app


class CanvasInpaintReferenceApiTests(unittest.TestCase):
    @staticmethod
    def _png_bytes(image):
        output = io.BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()

    @classmethod
    def _data_url(cls, image):
        return "data:image/png;base64," + base64.b64encode(cls._png_bytes(image)).decode("ascii")

    @staticmethod
    def _archive_response(image):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("result.png", CanvasInpaintReferenceApiTests._png_bytes(image))
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = archive.getvalue()
        return response

    @staticmethod
    def _request(source, mask, *, prompt_info=None, persist_result=False, reference=None,
                 width=64, height=64):
        payload = {
            "key": "synthetic-key",
            "image": CanvasInpaintReferenceApiTests._data_url(source),
            "mask": CanvasInpaintReferenceApiTests._data_url(mask),
            "width": width,
            "height": height,
            "promptInfo": prompt_info or {
                "basePrompt": "synthetic scene",
                "charPrompts": ["synthetic character"],
            },
            "persistResult": persist_result,
        }
        if reference is not None:
            payload["reference"] = reference
        return payload

    @staticmethod
    def _reference(**overrides):
        reference = {
            "src": "/canvas-imports/synthetic.png",
            "name": "Synthetic",
            "width": 320,
            "x": 0.5,
            "y": 0.5,
            "zoom": 1,
        }
        reference.update(overrides)
        return reference

    @staticmethod
    def _generated_with_reference_strip():
        generated = Image.new("RGB", (384, 64), (255, 255, 0))
        generated.paste(Image.new("RGB", (64, 64), (0, 255, 0)), (320, 0))
        return generated

    @staticmethod
    def _mask_halves():
        mask = Image.new("RGB", (64, 64), (0, 0, 0))
        for y in range(64):
            for x in range(32):
                mask.putpixel((x, y), (255, 255, 255))
        return mask

    def _post_with_reference(self, payload, generated, reference_image):
        with tempfile.TemporaryDirectory(prefix="canvas-inpaint-reference-") as directory:
            reference_path = os.path.join(directory, "synthetic.png")
            reference_image.save(reference_path, format="PNG")
            client = app.app.test_client()
            with mock.patch.object(app, "CANVAS_IMPORT_DIR", directory), \
                    mock.patch("naim.novelai.urllib.request.urlopen",
                               return_value=self._archive_response(generated)) as send:
                result = client.post("/api/canvas/inpaint", json=payload)
        return result, send

    def test_reference_request_expands_payload_then_crops_before_mask_blend(self):
        source = Image.new("RGB", (64, 64), (255, 0, 0))
        reference_image = Image.new("RGB", (64, 64), (0, 0, 255))
        request_data = self._request(
            source,
            self._mask_halves(),
            prompt_info={"basePrompt": "synthetic scene", "charPrompts": ["synthetic character"]},
            reference=self._reference(x=0, y=1, zoom=8),
        )

        result, send = self._post_with_reference(
            request_data, self._generated_with_reference_strip(), reference_image
        )

        self.assertEqual(result.status_code, 200, result.json)
        request = send.call_args.args[0]
        payload = json.loads(send.call_args.kwargs["data"])
        params = payload["parameters"]
        self.assertEqual((request_data["width"], request_data["height"]), (64, 64))
        self.assertEqual((params["width"], params["height"]), (384, 64))
        self.assertEqual(payload["input"], "split screen, synthetic scene")
        self.assertEqual(
            params["v4_prompt"]["caption"]["base_caption"],
            "split screen, synthetic scene",
        )
        self.assertEqual(
            params["v4_prompt"]["caption"]["char_captions"][0]["char_caption"],
            "synthetic character",
        )

        with Image.open(io.BytesIO(base64.b64decode(params["image"]))) as request_image:
            self.assertEqual(request_image.size, (384, 64))
            self.assertEqual(request_image.getpixel((0, 0)), (255, 255, 255))
            self.assertEqual(request_image.getpixel((127, 32)), (255, 255, 255))
            self.assertEqual(request_image.getpixel((128, 0)), (0, 0, 255))
            self.assertEqual(request_image.getpixel((191, 63)), (0, 0, 255))
            self.assertEqual(request_image.getpixel((192, 32)), (255, 255, 255))
            self.assertEqual(request_image.getpixel((320, 0)), (255, 0, 0))
        with Image.open(io.BytesIO(base64.b64decode(params["mask"]))) as request_mask:
            self.assertEqual(request_mask.size, (384, 64))
            self.assertEqual(request_mask.getpixel((0, 0)), (0, 0, 0))
            self.assertEqual(request_mask.getpixel((319, 63)), (0, 0, 0))
            self.assertEqual(request_mask.getpixel((320, 0)), (255, 255, 255))
            self.assertEqual(request_mask.getpixel((351, 63)), (255, 255, 255))
            self.assertEqual(request_mask.getpixel((352, 0)), (0, 0, 0))

        self.assertEqual(result.json["promptInfo"]["basePrompt"], "synthetic scene")
        self.assertEqual(result.json["promptInfo"]["charPrompts"], ["synthetic character"])
        with Image.open(io.BytesIO(base64.b64decode(result.json["image"].split(",", 1)[1]))) as output:
            self.assertEqual(output.size, (64, 64))
            self.assertEqual(output.getpixel((0, 32)), (0, 255, 0))
            self.assertEqual(output.getpixel((63, 32)), (255, 0, 0))

    def test_invalid_reference_and_input_dimension_mismatch_fail_before_network(self):
        source = Image.new("RGB", (64, 64), (255, 0, 0))
        mask = self._mask_halves()
        cases = (
            (self._request(source, mask, reference={}), "missing src"),
            (self._request(source, mask, reference=self._reference(src="/canvas-imports/../secret.png")), "traversal"),
            (self._request(source, mask, reference=self._reference(), width=63), "width mismatch"),
        )
        for request_data, label in cases:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as directory:
                reference_path = os.path.join(directory, "synthetic.png")
                Image.new("RGB", (64, 64), (0, 0, 255)).save(reference_path, format="PNG")
                with mock.patch.object(app, "CANVAS_IMPORT_DIR", directory), \
                        mock.patch("naim.novelai.urllib.request.urlopen") as send:
                    result = app.app.test_client().post("/api/canvas/inpaint", json=request_data)
                self.assertEqual(result.status_code, 400, result.json)
                send.assert_not_called()

    def test_wrong_api_result_size_fails_without_saving(self):
        source = Image.new("RGB", (64, 64), (255, 0, 0))
        request_data = self._request(
            source,
            self._mask_halves(),
            persist_result=True,
            reference=self._reference(),
        )
        wrong_size = Image.new("RGB", (383, 64), (0, 255, 0))
        with tempfile.TemporaryDirectory() as directory:
            reference_path = os.path.join(directory, "synthetic.png")
            Image.new("RGB", (64, 64), (0, 0, 255)).save(reference_path, format="PNG")
            with mock.patch.object(app, "CANVAS_IMPORT_DIR", directory), \
                    mock.patch("naim.novelai.urllib.request.urlopen",
                               return_value=self._archive_response(wrong_size)), \
                    mock.patch.object(app, "save_canvas_generated_image") as save:
                result = app.app.test_client().post("/api/canvas/inpaint", json=request_data)
        self.assertEqual(result.status_code, 500, result.json)
        save.assert_not_called()

    def test_persistent_save_receives_cropped_composited_png(self):
        source = Image.new("RGB", (64, 64), (255, 0, 0))
        request_data = self._request(
            source,
            self._mask_halves(),
            persist_result=True,
            reference=self._reference(),
        )
        with tempfile.TemporaryDirectory() as directory:
            reference_path = os.path.join(directory, "synthetic.png")
            Image.new("RGB", (64, 64), (0, 0, 255)).save(reference_path, format="PNG")
            with mock.patch.object(app, "CANVAS_IMPORT_DIR", directory), \
                    mock.patch("naim.novelai.urllib.request.urlopen",
                               return_value=self._archive_response(self._generated_with_reference_strip())), \
                    mock.patch.object(app, "save_canvas_generated_image",
                                      return_value=("/canvas-imports/saved.png", "saved.png")) as save:
                result = app.app.test_client().post("/api/canvas/inpaint", json=request_data)

        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(result.json["promptInfo"]["basePrompt"], "synthetic scene")
        saved_bytes = save.call_args.args[0]
        with Image.open(io.BytesIO(saved_bytes)) as saved:
            self.assertEqual(saved.size, (64, 64))
            self.assertEqual(saved.getpixel((0, 32)), (0, 255, 0))
            self.assertEqual(saved.getpixel((63, 32)), (255, 0, 0))
        saved_prompt = app.extract_prompt_info_from_image_filelike(
            types.SimpleNamespace(stream=io.BytesIO(saved_bytes))
        )
        self.assertEqual(saved_prompt["basePrompt"], "synthetic scene")

    def test_project_canvas_reference_is_kept_as_an_import_asset_reference(self):
        projects = types.SimpleNamespace(
            canvas_states=mock.Mock(return_value=[]),
            list_projects=mock.Mock(return_value=[{
                "canvasSettings": {"inpaintReference": self._reference()}
            }]),
        )
        with mock.patch.object(app, "DAKI_PROJECTS", projects):
            refs = app.project_canvas_import_refs()
        self.assertIn("synthetic.png", refs)


if __name__ == "__main__":
    unittest.main()
