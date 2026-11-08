"""Single-source, bounded in-memory cache for prepared retouch previews."""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from os import cpu_count

PREVIEW_EDGE = 1600
WORKING_EDGE = 800
NATIVE_RESULT_MAX_PIXELS = 80_000_000
_VIEWPORT_RENDER_KEY = 'viewport'
_PARALLEL_PROJECTION_PIXELS = 32_000_000


def project_native_preview(image, size):
    """Project finished native pixels using the same LANCZOS filter for the whole view."""
    from PIL import Image

    width, height = size
    workers = min(4, cpu_count() or 1, height)
    resample = Image.Resampling.LANCZOS
    # Whole-pixel strip boundaries keep the sample centers identical to one resize.
    if (image.mode != 'RGBA' or image.width * image.height < _PARALLEL_PROJECTION_PIXELS
            or image.height <= height or image.height % height or image.height > (1 << 24)
            or workers < 2):
        return image.resize(size, resample)

    ratio = image.height // height
    strip_height = (height + workers - 1) // workers
    starts = range(0, height, strip_height)
    try:
        # Each worker reads the same premultiplied source so filter taps cross strip edges.
        with closing(image.convert('RGBa')) as source, closing(Image.new('RGBa', size)) as projection:
            def resize_strip(top):
                bottom = min(top + strip_height, height)
                box = (0, top * ratio, source.width, bottom * ratio)
                return source.resize((width, bottom - top), resample, box=box)

            with ThreadPoolExecutor(max_workers=workers) as executor:
                for top, strip in zip(starts, executor.map(resize_strip, starts)):
                    with closing(strip):
                        projection.paste(strip, (0, top))
            return projection.convert('RGBA')
    except RuntimeError:
        return image.resize(size, resample)


class MaskCache:
    """Own cached L masks under a byte-per-pixel memory budget."""

    def __init__(self, max_pixels=16 * 1024 * 1024):
        if isinstance(max_pixels, bool) or not isinstance(max_pixels, int) or max_pixels < 0:
            raise ValueError('마스크 캐시 크기는 0 이상의 정수여야 합니다.')
        self.max_pixels = max_pixels
        self._images = OrderedDict()
        self._pixels = 0

    def get(self, key):
        image = self._images.get(key)
        if image is not None:
            self._images.move_to_end(key)
        return image

    def store(self, key, image):
        previous = self._images.pop(key, None)
        if previous is not None:
            self._pixels -= previous.width * previous.height
            previous.close()

        pixels = image.width * image.height
        if pixels > self.max_pixels:
            image.close()
            return

        self._images[key] = image
        self._pixels += pixels
        while self._pixels > self.max_pixels:
            _old_key, oldest = self._images.popitem(last=False)
            self._pixels -= oldest.width * oldest.height
            oldest.close()

    def clear(self):
        images = tuple(self._images.values())
        self._images.clear()
        self._pixels = 0
        for image in images:
            image.close()


class PreviewCache:
    """Own two resolutions and up to two layer checkpoints per resolution."""

    def __init__(self):
        self._key = None
        self._image = None
        self._size = None
        self._working = None
        self._renders = {}
        self.masks = MaskCache()
        self._viewport_key = None
        self._viewport_image = None
        self._viewport_origin = None
        self._viewport_crop = None
        self._viewport_source_key = None
        self._viewport_size = None
        self._native_preview_key = None
        self._native_preview_layers = None
        self._native_preview_edge = None
        self._native_preview_image = None
        self._native_result = None
        self._native_source_key = None
        self._native_source = None

    @staticmethod
    def _viewport_cache_key(source_key, region, scale, halo):
        return source_key, tuple(region), scale, halo

    def source_size(self, key):
        """Return dimensions verified for these exact source bytes, if known."""
        if self._key == key and self._image is not None:
            return self._size
        if self._viewport_source_key == key:
            return self._viewport_size
        return None

    def remember_viewport_source_size(self, key, size):
        """Remember dimensions by content hash and release a different source crop."""
        if self._viewport_source_key != key:
            self.clear_viewport()
            self._viewport_source_key = key
            self._viewport_size = tuple(size)
            if self._native_preview_key != key:
                self.clear_native_preview()
        elif self._viewport_size is None:
            self._viewport_size = tuple(size)

    def can_store_viewport(self, image_size):
        return image_size[0] * image_size[1] <= 4_194_304

    def get_viewport(self, source_key, region, scale, halo):
        key = self._viewport_cache_key(source_key, region, scale, halo)
        if self._viewport_key != key or self._viewport_image is None:
            self.clear_viewport_image()
            return None
        return self._viewport_image, self._viewport_origin, self._viewport_crop

    def store_viewport(self, source_key, region, scale, halo, origin, crop, image):
        """Take ownership of one padded, resized, unmodified RGBA context."""
        self.clear_viewport_image()
        if not self.can_store_viewport(image.size):
            image.close()
            return
        self._viewport_key = self._viewport_cache_key(source_key, region, scale, halo)
        self._viewport_image = image
        self._viewport_origin = tuple(origin)
        self._viewport_crop = tuple(crop)

    def clear_viewport_image(self):
        image, self._viewport_image = self._viewport_image, None
        self._viewport_key = None
        self._viewport_origin = None
        self._viewport_crop = None
        if image is not None:
            image.close()
        _, images = self._renders.pop(_VIEWPORT_RENDER_KEY, ((), {}))
        for checkpoint in images.values():
            checkpoint.close()

    def clear_viewport(self):
        self.clear_viewport_image()
        self._viewport_source_key = None
        self._viewport_size = None
        self.clear_native_source()

    def get_native_source(self, source_key):
        """Borrow the normalized native source for these exact source bytes."""
        if self._native_source_key != source_key:
            return None
        return self._native_source

    def store_native_source(self, source_key, image):
        """Take ownership of one decoded source when it fits the native cache budget."""
        self.clear_native_source()
        if image.width * image.height > NATIVE_RESULT_MAX_PIXELS:
            image.close()
            return None
        self._native_source_key = source_key
        self._native_source = image
        return image

    def clear_native_source(self):
        image, self._native_source = self._native_source, None
        self._native_source_key = None
        if image is not None:
            image.close()

    def get_native_preview(self, source_key, layers, edge=None):
        if (self._native_preview_image is None or self._native_preview_key != source_key or
                self._native_preview_layers != layers or
                (edge is not None and self._native_preview_edge != edge)):
            return None
        return self._native_preview_image

    def store_native_preview(self, source_key, layers, edge, image, native_result=None):
        self.clear_native_preview()
        if native_result is not None:
            self.clear_native_source()
        self._native_preview_key = source_key
        self._native_preview_layers = layers
        self._native_preview_edge = edge
        self._native_preview_image = image
        self._native_result = native_result

    def get_native_result(self, source_key, layers):
        """Borrow exact source-size pixels for matching native preview layers."""
        if self.get_native_preview(source_key, layers) is None:
            return None
        return self._native_result

    def take_native_result(self, source_key, layers):
        """Transfer an already rendered source-size result to the save job."""
        image = self.get_native_result(source_key, layers)
        if image is None:
            return None
        self._native_result = None
        return image

    def clear_native_preview(self):
        image, self._native_preview_image = self._native_preview_image, None
        self._native_preview_key = None
        self._native_preview_layers = None
        self._native_preview_edge = None
        if image is not None:
            image.close()
        if self._native_result is not None:
            self._native_result.close()
            self._native_result = None

    def get(self, key):
        if self._key != key or self._image is None:
            return None
        return self._image, self._size

    def store(self, key, image, size):
        self.clear()
        self._key = key
        self._image = image
        self._size = tuple(size)

    def working_image(self):
        if max(self._image.size) <= WORKING_EDGE:
            return self._image
        if self._working is None:
            from PIL import Image

            scale = WORKING_EDGE / max(self._size)
            size = tuple(max(1, round(length * scale)) for length in self._size)
            self._working = self._image.resize(size, Image.Resampling.LANCZOS)
        return self._working

    def render_layers(self, prepared, layers, render, *, cache_key=None):
        """Borrow the result and reuse the closest checkpoint before a changed layer."""
        if not layers:
            return prepared
        render_key = prepared.size if cache_key is None else cache_key
        old_layers, old_images = self._renders.get(render_key, ((), {}))
        common = 0
        for previous, current in zip(old_layers, layers):
            if previous != current:
                break
            common += 1
        start = max((index for index in old_images if index <= common), default=0)
        base = old_images.get(start, prepared)
        if start == len(layers):
            return base

        # The common prefix indicates which layer the user is editing. On the
        # first render keep the stage just before the last layer (usually selected).
        split = max(start, min(common if old_layers else len(layers) - 1, len(layers) - 1))
        checkpoint = render(base, layers[start:split]) if split > start else base
        try:
            result = render(checkpoint, layers[split:])
        except BaseException:
            if split > start:
                checkpoint.close()
            raise
        images = {len(layers): result}
        if split:
            images[split] = checkpoint
        for image in old_images.values():
            if image is not checkpoint:
                image.close()
        self._renders[render_key] = (layers, images)
        return result

    def render_viewport_layers(self, prepared, layers, render):
        """Reuse layer checkpoints only for the exact currently cached viewport."""
        return self.render_layers(prepared, layers, render, cache_key=_VIEWPORT_RENDER_KEY)

    def full_size_result(self, key, layers):
        """Borrow exact pixels only when the preview ran at the original size."""
        cached = self.get(key)
        if cached is None or cached[0].size != cached[1]:
            return None
        if not layers:
            return cached[0]
        old_layers, images = self._renders.get(cached[1], ((), {}))
        count = len(layers)
        return images.get(count) if old_layers[:count] == layers else None

    def clear(self):
        image, self._image = self._image, None
        self._key = None
        self._size = None
        if image is not None:
            image.close()
        if self._working is not None:
            self._working.close()
            self._working = None
        for _, images in self._renders.values():
            for checkpoint in images.values():
                checkpoint.close()
        self._renders.clear()
        self.masks.clear()
        self.clear_viewport()
        self.clear_native_preview()
