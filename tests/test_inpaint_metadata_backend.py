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
from PIL.PngImagePlugin import PngInfo

from tests.test_model_family_backend import GalleryModelFamilyMigrationTests
import image_logic


class InpaintMetadataBackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = GalleryModelFamilyMigrationTests._load_app_without_flask()

    @staticmethod
    def _data_url(image):
        output = io.BytesIO()
        image.save(output, format="PNG")
        encoded = base64.b64encode(output.getvalue()).decode("ascii")
        return f"data:image/png;base64,{encoded}"

    def test_inpainting_model_id_and_family(self):
        self.assertEqual(self.app.NAI_INPAINT_MODEL, "nai-diffusion-5-full-inpainting")
        self.assertEqual(
            image_logic.classify_model_family("nai-diffusion-5-full-inpainting"),
            "v5",
        )
        self.assertEqual(
            image_logic.classify_model_family("nai-diffusion-4-5-full-inpainting"),
            "v4_5",
        )

    def test_canvas_inpaint_payload_and_response_carry_generation_metadata(self, model='nai-diffusion-5-full'):
        source = Image.new("RGB", (2, 2), "white")
        mask = Image.new("RGBA", (2, 2), (255, 255, 255, 255))
        generated = Image.new("RGB", (2, 2), "black")
        generated_bytes = io.BytesIO()
        generated.save(generated_bytes, format="PNG")
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("result.png", generated_bytes.getvalue())

        request_data = {
            "key": "test-key",
            "image": self._data_url(source),
            "mask": self._data_url(mask),
            "promptInfo": {"model": model, "sampler": "k_dpmpp_2m", "steps": 41,
                           "cfg": 7.5, "cfg_rescale": 0, "noise_schedule": "karras",
                           "seed": 0, "noise": 0, "strength": 0.3},
            "persistResult": False,
        }
        captured = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return archive.getvalue()

        def fake_urlopen(request, data=None):
            captured["payload"] = json.loads(data.decode("utf-8"))
            return FakeResponse()

        previous_request = self.app.request
        self.app.request = types.SimpleNamespace(json=request_data)
        try:
            with mock.patch.object(self.app.urllib.request, "urlopen", side_effect=fake_urlopen):
                result = self.app.canvas_inpaint()
        finally:
            self.app.request = previous_request

        self.assertEqual(captured["payload"]["model"], model + '-inpainting')
        self.assertEqual(captured["payload"]["parameters"]["sampler"], "k_dpmpp_2m")
        self.assertEqual(captured["payload"]["parameters"]["steps"], 41)
        self.assertEqual(result["promptInfo"]["model"], model + '-inpainting')
        self.assertEqual(result["promptInfo"]["sampler"], "k_dpmpp_2m")
        self.assertEqual(result["promptInfo"]["steps"], 41)
        params = captured['payload']['parameters']
        for key, expected in {'scale': 7.5, 'cfg_rescale': 0, 'noise_schedule': 'karras',
                              'seed': 0, 'noise': 0, 'inpaintImg2ImgStrength': 0.3}.items():
            self.assertEqual(params[key], expected)
        png = base64.b64decode(result['image'].split(',', 1)[1])
        uploaded = self.app.extract_prompt_info_from_image_filelike(types.SimpleNamespace(stream=io.BytesIO(png)))
        for key in ('model', 'sampler', 'steps', 'cfg', 'cfg_rescale', 'noise_schedule', 'seed', 'strength', 'noise'):
            self.assertEqual(uploaded[key], result['promptInfo'][key], key)

    def test_all_selected_models_reach_the_inpaint_request(self):
        for model in ('nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'):
            with self.subTest(model=model):
                self.test_canvas_inpaint_payload_and_response_carry_generation_metadata(model)

    def test_invalid_settings_are_rejected_before_network_or_image_access(self):
        from naim.generation_settings import normalize_inpaint_settings
        for key, value in (('model', 'unsupported'), ('sampler', 'unsupported'), ('noise_schedule', 'unsupported'),
                           ('steps', 0), ('steps', 50.5), ('cfg_rescale', 1.1), ('cfg', float('nan')),
                           ('seed', 4294967296), ('strength', 0), ('noise', -1)):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                normalize_inpaint_settings({key: value})

    def test_medium_settings_normalize_both_model_ids_without_mutating_input(self):
        from naim.generation_settings import normalize_inpaint_settings
        for model in ('nai-diffusion-5-full-medium', 'nai-diffusion-5-full-medium-inpainting'):
            with self.subTest(model=model):
                info = {'model': model, 'steps': 41, 'sampler': 'k_dpmpp_2m',
                        'cfg': 7.5, 'cfg_rescale': 0.8, 'seed': 0}
                original = dict(info)
                normalized = normalize_inpaint_settings(info)
                self.assertEqual(normalized['model'], 'nai-diffusion-5-full-medium-inpainting')
                self.assertEqual(normalized['steps'], 14)
                self.assertEqual(normalized['sampler'], 'k_euler_ancestral')
                self.assertEqual(normalized['noise_schedule'], 'karras')
                self.assertEqual(normalized['cfg_rescale'], '')
                self.assertEqual(normalized['cfg'], 7.5)
                self.assertEqual(normalized['seed'], 0)
                self.assertEqual(info, original)

    def test_medium_request_and_saved_metadata_use_effective_settings(self):
        source = Image.new('RGB', (2, 2), 'white')
        png_bytes = io.BytesIO()
        source.save(png_bytes, 'PNG')
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('result.png', png_bytes.getvalue())
        expected_uc = ('lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, '
                       'jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, '
                       'screentone, multiple views, logo, too many watermarks, negative space, blank page')
        for base, prefix in (('synthetic scene', 'nsfw, '), ('NSFW synthetic scene', '')):
            with self.subTest(base=base):
                request_data = {
                    'key': 'synthetic-key', 'image': self._data_url(source), 'mask': self._data_url(source),
                    'persistResult': False,
                    'promptInfo': {'model': 'nai-diffusion-5-full-medium', 'basePrompt': base,
                                   'charPrompts': ['nsfw synthetic character'], 'negativePrompt': 'custom negative',
                                   'steps': 41, 'sampler': 'k_dpmpp_2m', 'cfg_rescale': 0.8,
                                   'noise_schedule': 'native', 'cfg': 7.5, 'seed': 0},
                }
                response = mock.MagicMock()
                response.__enter__.return_value.read.return_value = archive.getvalue()
                with mock.patch.object(self.app, 'request', types.SimpleNamespace(json=request_data)), \
                        mock.patch.object(self.app.urllib.request, 'urlopen', return_value=response) as send:
                    result = self.app.canvas_inpaint()
                payload = json.loads(send.call_args.kwargs['data'])
                params = payload['parameters']
                self.assertEqual(payload['model'], 'nai-diffusion-5-full-medium-inpainting')
                self.assertEqual(params['steps'], 14)
                self.assertEqual(params['sampler'], 'k_euler_ancestral')
                self.assertEqual(params['noise_schedule'], 'karras')
                self.assertNotIn('cfg_rescale', params)
                self.assertEqual(params['params_version'], 4)
                self.assertEqual(params['scale'], 7.5)
                self.assertEqual(params['tag_hint_uc_preset'], 2)
                self.assertEqual(params['negative_prompt'], prefix + expected_uc)
                self.assertEqual(params['v4_negative_prompt']['caption'], {
                    'base_caption': prefix + expected_uc,
                    'char_captions': [{'char_caption': '', 'centers': [{'x': 0.5, 'y': 0.5}]}],
                })
                info = result['promptInfo']
                self.assertEqual(info['negativePrompt'], prefix + expected_uc)
                self.assertEqual(info['cfg_rescale'], '')
                self.assertEqual(request_data['promptInfo']['negativePrompt'], 'custom negative')
                generated = base64.b64decode(result['image'].split(',', 1)[1])
                uploaded = self.app.extract_prompt_info_from_image_filelike(types.SimpleNamespace(stream=io.BytesIO(generated)))
                with tempfile.TemporaryDirectory() as directory:
                    path = os.path.join(directory, 'medium.png')
                    self.assertTrue(self.app.save_prompt_sidecar(path, info))
                    saved = self.app.load_prompt_sidecar(path)
                    for key in ('model', 'steps', 'sampler', 'cfg', 'cfg_rescale', 'noise_schedule', 'negativePrompt'):
                        self.assertEqual(uploaded[key], info[key], key)
                        self.assertEqual(saved[key], info[key], key)

    def test_png_and_sidecar_roundtrip_generation_metadata_without_prompt(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "metadata.png")
            prompt_info = {
                "model": self.app.NAI_INPAINT_MODEL,
                "sampler": "k_dpmpp_2m",
                "steps": 37,
                "cfg": 5.5, "cfg_rescale": 0, "noise_schedule": "exponential",
                "seed": 0, "strength": 0.4, "noise": 0,
            }
            image = Image.new("RGBA", (2, 2), "white")
            self.assertTrue(self.app.save_png_with_prompt_metadata(image, path, prompt_info))
            self.assertTrue(self.app.save_prompt_sidecar(path, prompt_info))

            extracted = self.app.extract_prompt_info_from_image(path)
            self.assertEqual(extracted["model"], self.app.NAI_INPAINT_MODEL)
            self.assertEqual(extracted["modelName"], self.app.NAI_INPAINT_MODEL)
            self.assertEqual(extracted["sampler"], "k_dpmpp_2m")
            self.assertEqual(extracted["steps"], 37)

            with open(path, "rb") as image_file:
                filelike = types.SimpleNamespace(stream=io.BytesIO(image_file.read()))
            uploaded = self.app.extract_prompt_info_from_image_filelike(filelike)
            self.assertEqual(uploaded["model"], self.app.NAI_INPAINT_MODEL)
            self.assertEqual(uploaded["sampler"], "k_dpmpp_2m")
            self.assertEqual(uploaded["steps"], 37)

            loaded = self.app.load_prompt_sidecar(path)
            self.assertEqual(loaded["model"], self.app.NAI_INPAINT_MODEL)
            self.assertEqual(loaded["sampler"], "k_dpmpp_2m")
            self.assertEqual(loaded["steps"], 37)
            for key, value in prompt_info.items():
                self.assertEqual(loaded[key], value, key)
                self.assertEqual(uploaded[key], value, key)

    def test_source_and_nested_comment_model_are_extracted(self):
        with tempfile.TemporaryDirectory() as directory:
            source_path = os.path.join(directory, "source.png")
            source_info = PngInfo()
            source_info.add_text("Source", "NovelAI Diffusion V5 1229B44")
            Image.new("RGB", (1, 1)).save(source_path, "PNG", pnginfo=source_info)
            self.assertEqual(
                self.app.extract_prompt_info_from_image(source_path)["modelName"],
                "NovelAI Diffusion V5 1229B44",
            )

            nested_path = os.path.join(directory, "nested.png")
            nested_comment = {"Comment": json.dumps({"model_name": "NovelAI Diffusion V4.5"})}
            nested_info = PngInfo()
            nested_info.add_text("Comment", json.dumps(nested_comment))
            Image.new("RGB", (1, 1)).save(nested_path, "PNG", pnginfo=nested_info)
            self.assertEqual(
                self.app.extract_prompt_info_from_image(nested_path)["modelName"],
                "NovelAI Diffusion V4.5",
            )

    def test_comment_json_complements_parameters_text_and_sidecar_fills_missing_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "comment_and_parameters.png")
            png_info = PngInfo()
            png_info.add_text("parameters", "a prompt\nNegative prompt: bad")
            png_info.add_text(
                "Comment",
                json.dumps({
                    "model": self.app.NAI_INPAINT_MODEL,
                    "sampler": "k_euler_a",
                    "steps": 29,
                }),
            )
            Image.new("RGB", (1, 1)).save(path, "PNG", pnginfo=png_info)
            embedded = self.app.extract_prompt_info_from_image(path)
            self.assertEqual(embedded["model"], self.app.NAI_INPAINT_MODEL)
            self.assertEqual(embedded["sampler"], "k_euler_a")
            self.assertEqual(embedded["steps"], 29)

            sidecar = {
                "basePrompt": "edited prompt",
                "negativePrompt": "",
                "model": "",
                "sampler": "",
                "steps": "",
            }
            self.assertTrue(self.app.save_prompt_sidecar(path, sidecar))
            merged = self.app.merge_prompt_info_with_fallback(
                self.app.load_prompt_sidecar(path),
                embedded,
            )
            self.assertEqual(merged["basePrompt"], "edited prompt")
            self.assertEqual(merged["model"], self.app.NAI_INPAINT_MODEL)
            self.assertEqual(merged["sampler"], "k_euler_a")
            self.assertEqual(merged["steps"], 29)


if __name__ == "__main__":
    unittest.main()
