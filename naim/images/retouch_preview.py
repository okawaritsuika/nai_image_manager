"""Single-source, bounded in-memory cache for prepared retouch previews."""
from collections import OrderedDict


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
    """Own at most one prepared Pillow image; callers only borrow cache hits."""

    def __init__(self):
        self._key = None
        self._image = None
        self._size = None
        self.masks = MaskCache()

    def get(self, key):
        if self._key != key or self._image is None:
            return None
        return self._image, self._size

    def store(self, key, image, size):
        self.clear()
        self._key = key
        self._image = image
        self._size = tuple(size)

    def clear(self):
        image, self._image = self._image, None
        self._key = None
        self._size = None
        if image is not None:
            image.close()
        self.masks.clear()
