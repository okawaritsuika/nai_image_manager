"""Native cumulative pixel state for the canvas retouch editor.

The cache owns one normalized source and keeps local edits in native RGBA tiles
until a full-frame operation or export needs the complete result. Update may
lend that full result to its caller; the route must serialize it under the
render lock without closing or mutating it.
"""

from copy import deepcopy
import math

from PIL import Image, ImageChops

MAX_TRANSITION_PIXELS = 4_194_304
MAX_CHECKPOINT_PIXELS = 80_000_000
MAX_VIEWPORT_PIXELS = 3_145_728
FILTER_TILE_SIZE = 768
SPARSE_TILE_SIZE = 512
MAX_SPARSE_BYTES = 64 * 1024 * 1024
ADJUSTMENT_KINDS = {'color', 'tone', 'blur', 'sharpen', 'line', 'texture'}


def _effective(engine, layers):
    return [layer for layer in layers if engine._has_effect(layer)]


def _common_prefix_size(left, right):
    index = 0
    limit = min(len(left), len(right))
    while index < limit and left[index] == right[index]:
        index += 1
    return index


def _changed_records(old, new):
    """Return the changed middle slices after retaining equal prefix/suffix."""
    prefix = _common_prefix_size(old, new)
    suffix = 0
    max_suffix = min(len(old) - prefix, len(new) - prefix)
    while suffix < max_suffix and old[len(old) - suffix - 1] == new[len(new) - suffix - 1]:
        suffix += 1
    old_end = len(old) - suffix if suffix else len(old)
    new_end = len(new) - suffix if suffix else len(new)
    return old[prefix:old_end], new[prefix:new_end]


def _stroke_bounds(strokes, size, extension):
    points = []
    padding = 0
    for stroke in strokes:
        stroke_points = stroke.get('points', [])
        if not stroke_points:
            continue
        points.extend(stroke_points)
        radius = stroke.get('radius', 80)
        if isinstance(radius, bool) or not isinstance(radius, (int, float)) or not math.isfinite(radius):
            radius = 80
        radius = max(1, min(800, radius))
        padding = max(padding, extension(radius, stroke))
    if not points:
        return None
    left = max(0, math.floor(min(point[0] for point in points) - padding))
    top = max(0, math.floor(min(point[1] for point in points) - padding))
    right = min(size[0], math.ceil(max(point[0] for point in points) + padding + 1))
    bottom = min(size[1], math.ceil(max(point[1] for point in points) + padding + 1))
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def _paint_extent(radius, stroke, *, mask=False):
    if not mask and stroke.get('brush') == 'airbrush':
        return radius + 2
    hardness = stroke.get('hardness', .3)
    if not isinstance(hardness, (int, float)) or not math.isfinite(hardness):
        return 2 * radius + 8
    hardness = max(0, min(1, hardness))
    # stroke_patch filters the inner ellipse in this bounded feather buffer.
    # Keep an extra raster pixel for the integer ellipse and exclusive edge.
    return max(.5, radius * (.45 + .55 * hardness)) + math.ceil(radius * (1 - hardness)) + 5


def _union_boxes(boxes):
    boxes = [box for box in boxes if box is not None]
    if not boxes:
        return None
    return (
        min(box[0] for box in boxes), min(box[1] for box in boxes),
        max(box[2] for box in boxes), max(box[3] for box in boxes),
    )


def _padded_box(box, padding, size):
    return (max(0, math.floor(box[0] - padding)), max(0, math.floor(box[1] - padding)),
            min(size[0], math.ceil(box[2] + padding + 1)), min(size[1], math.ceil(box[3] + padding + 1)))


def _images_equal(left, right, box=None):
    """Compare RGBA pixels with bounded temporary memory, including full frames."""
    box = box or (0, 0, left.width, left.height)
    x0, y0, x1, y1 = box
    for top in range(y0, y1, 256):
        band = (x0, top, x1, min(y1, top + 256))
        with left.crop(band) as a, right.crop(band) as b:
            if a.tobytes() != b.tobytes():
                return False
    return True


def _layer_without(layer, field):
    return {key: value for key, value in layer.items() if key != field}


def _mask_without_strokes(layer):
    mask = layer.get('mask', {})
    return {key: value for key, value in mask.items() if key != 'strokes'}


def _stroke_tail(old_records, new_records):
    """Find the affected tail of an extended stroke without changing its render inputs."""
    if len(old_records) != 1 or len(new_records) != 1:
        return old_records, new_records
    before, after = old_records[0], new_records[0]
    if _layer_without(before, 'points') != _layer_without(after, 'points'):
        return old_records, new_records
    old_points, new_points = before.get('points', []), after.get('points', [])
    common = _common_prefix_size(old_points, new_points)
    if common and common == min(len(old_points), len(new_points)):
        if len(new_points) > len(old_points):
            return [], [{**after, 'points': new_points[common - 1:]}]
        if len(old_points) > len(new_points):
            return [{**before, 'points': old_points[common - 1:]}], []
    return old_records, new_records


class WorkingImage:
    """Own one exact-source native render and advance it transactionally."""

    def __init__(self, working_id, source_key, source_image, checkpoint_pixels=MAX_CHECKPOINT_PIXELS):
        if not isinstance(source_image, Image.Image) or source_image.mode != 'RGBA':
            raise ValueError('정규화된 RGBA 원본이 필요합니다.')
        self.working_id = working_id
        self.source_key = source_key
        self.original = source_image
        self.result = None
        self._sparse_tiles = {}
        self._sparse_bytes = 0
        self.layers = []
        self.revision = 0
        self._closed = False
        self._last_transition = None
        self._adjustment_checkpoint = None
        self._checkpoint_pixels = checkpoint_pixels
        self._viewport_checkpoint = None

    @property
    def size(self):
        return self.original.size

    @property
    def current(self):
        if self.result is not None:
            return self.result
        return self._materialize_sparse()

    def _tile_box(self, tile):
        x, y = tile[0] * SPARSE_TILE_SIZE, tile[1] * SPARSE_TILE_SIZE
        return (x, y, min(self.size[0], x + SPARSE_TILE_SIZE),
                min(self.size[1], y + SPARSE_TILE_SIZE))

    def _tiles_for_box(self, box):
        x0, y0, x1, y1 = box
        if x1 <= x0 or y1 <= y0:
            return
        for tile_y in range(y0 // SPARSE_TILE_SIZE, (y1 - 1) // SPARSE_TILE_SIZE + 1):
            for tile_x in range(x0 // SPARSE_TILE_SIZE, (x1 - 1) // SPARSE_TILE_SIZE + 1):
                yield tile_x, tile_y

    def _crop_region(self, box):
        """Return the exact composite pixels in a native document rectangle."""
        if self.result is not None:
            return self.result.crop(box)
        image = self.original.crop(box)
        if not self._sparse_tiles:
            return image
        x0, y0, x1, y1 = box
        try:
            for tile, pixels in self._sparse_tiles.items():
                tx0, ty0, tx1, ty1 = self._tile_box(tile)
                ix0, iy0 = max(x0, tx0), max(y0, ty0)
                ix1, iy1 = min(x1, tx1), min(y1, ty1)
                if ix1 <= ix0 or iy1 <= iy0:
                    continue
                with pixels.crop((ix0 - tx0, iy0 - ty0, ix1 - tx0, iy1 - ty0)) as overlap:
                    image.paste(overlap, (ix0 - x0, iy0 - y0))
            return image
        except BaseException:
            image.close()
            raise

    def _materialize_sparse(self):
        """Promote sparse native tiles to the existing full-frame result."""
        if self.result is not None:
            return self.result
        if not self._sparse_tiles:
            return self.original
        candidate = self.original.copy()
        try:
            for tile, pixels in self._sparse_tiles.items():
                box = self._tile_box(tile)
                candidate.paste(pixels, box[:2])
        except BaseException:
            candidate.close()
            raise
        old_tiles, self._sparse_tiles = self._sparse_tiles, {}
        self._sparse_bytes = 0
        self.result = candidate
        for pixels in old_tiles.values():
            pixels.close()
        return candidate

    def _paste_region(self, box, patch):
        """Atomically replace a native rectangle in the current composite."""
        x0, y0, x1, y1 = box
        if (patch.mode != 'RGBA' or patch.size != (x1 - x0, y1 - y0) or
                x0 < 0 or y0 < 0 or x1 > self.size[0] or y1 > self.size[1]):
            raise ValueError('Invalid native working-image patch.')
        if x1 <= x0 or y1 <= y0:
            return

        if self.result is not None:
            rollback = self.result.crop(box)
            try:
                try:
                    self.result.paste(patch, box[:2])
                except BaseException:
                    self.result.paste(rollback, box[:2])
                    raise
            finally:
                rollback.close()
            return

        tiles = tuple(self._tiles_for_box(box))
        added_bytes = sum(
            (self._tile_box(tile)[2] - self._tile_box(tile)[0]) *
            (self._tile_box(tile)[3] - self._tile_box(tile)[1]) * 4
            for tile in tiles if tile not in self._sparse_tiles
        )
        if self._sparse_bytes + added_bytes > MAX_SPARSE_BYTES:
            candidate = self.original.copy()
            try:
                for tile, pixels in self._sparse_tiles.items():
                    candidate.paste(pixels, self._tile_box(tile)[:2])
                candidate.paste(patch, box[:2])
            except BaseException:
                candidate.close()
                raise
            old_tiles, self._sparse_tiles = self._sparse_tiles, {}
            self._sparse_bytes = 0
            self.result = candidate
            for pixels in old_tiles.values():
                pixels.close()
            return

        staged = {}
        try:
            for tile in tiles:
                tx0, ty0, tx1, ty1 = self._tile_box(tile)
                ix0, iy0 = max(x0, tx0), max(y0, ty0)
                ix1, iy1 = min(x1, tx1), min(y1, ty1)
                source = self._sparse_tiles.get(tile)
                candidate = source.copy() if source is not None else self.original.crop((tx0, ty0, tx1, ty1))
                try:
                    with patch.crop((ix0 - x0, iy0 - y0, ix1 - x0, iy1 - y0)) as overlap:
                        candidate.paste(overlap, (ix0 - tx0, iy0 - ty0))
                except BaseException:
                    candidate.close()
                    raise
                staged[tile] = candidate
            published = self._sparse_tiles.copy()
            published.update(staged)
        except BaseException:
            for pixels in staged.values():
                pixels.close()
            raise

        old_tiles = self._sparse_tiles
        self._sparse_tiles = published
        self._sparse_bytes += added_bytes
        for tile in staged:
            previous = old_tiles.get(tile)
            if previous is not None:
                previous.close()

    def matches(self, working_id, source_key, engine, layers):
        return (
            not self._closed and self.working_id == working_id and
            self.source_key == source_key and
            _effective(engine, self.layers) == _effective(engine, layers)
        )

    def copy_result_if_matches(self, working_id, source_key, engine, layers):
        if not self.matches(working_id, source_key, engine, layers):
            return None
        return self.current.copy()

    def _top_stroke_append(self, new_layers, engine):
        old_layers = self.layers
        if len(new_layers) == len(old_layers) and old_layers:
            if old_layers[:-1] != new_layers[:-1]:
                return None
            old_layer, new_layer = old_layers[-1], new_layers[-1]
            kind = new_layer.get('type')
            if (kind not in {'paint', 'clone', 'liquify'} or
                    _layer_without(old_layer, 'strokes') != _layer_without(new_layer, 'strokes')):
                return None
            old_strokes = old_layer.get('strokes', [])
            new_strokes = new_layer.get('strokes', [])
            if len(new_strokes) <= len(old_strokes) or new_strokes[:len(old_strokes)] != old_strokes:
                return None
            if not engine._has_effect(new_layer):
                return None
            return new_layer, new_strokes[len(old_strokes):]

        if len(new_layers) == len(old_layers) + 1 and old_layers == new_layers[:-1]:
            new_layer = new_layers[-1]
            if (new_layer.get('type') not in {'paint', 'clone', 'liquify'} or
                    not new_layer.get('strokes') or not engine._has_effect(new_layer)):
                return None
            return new_layer, new_layer['strokes']
        return None

    def _local_stroke_change(self, new_layers, engine):
        """Collect stroke and mask-stroke edits that can be region-rendered."""
        if len(new_layers) != len(self.layers):
            if len(new_layers) == len(self.layers) + 1 and self.layers == new_layers[:-1]:
                mask = new_layers[-1].get('mask', {})
                if new_layers[-1]['type'] in ADJUSTMENT_KINDS and not mask.get('base', 1):
                    return _stroke_bounds(mask.get('strokes', []), self.size,
                                          lambda radius, stroke: _paint_extent(radius, stroke, mask=True))
            return None
        changes = []
        for index, (old_layer, new_layer) in enumerate(zip(self.layers, new_layers)):
            if old_layer == new_layer:
                continue

            current = None
            if _layer_without(old_layer, 'strokes') == _layer_without(new_layer, 'strokes'):
                old_strokes = old_layer.get('strokes', [])
                new_strokes = new_layer.get('strokes', [])
                if old_strokes != new_strokes:
                    old_changed, new_changed = _changed_records(old_strokes, new_strokes)
                    kind = new_layer.get('type')
                    if kind not in {'paint', 'clone', 'liquify'}:
                        # Other layer kinds do not consume their top-level strokes.
                        continue
                    if kind == 'liquify':
                        tail = (len(old_strokes) == len(new_strokes) and old_strokes[:-1] == new_strokes[:-1]
                                and not _stroke_tail(old_changed, new_changed)[0])
                        if not tail and new_strokes[:len(old_strokes)] != old_strokes:
                            # Earlier dabs can influence later strokes anywhere in this layer.
                            return None
                    current = ('strokes', index, kind, old_changed, new_changed)
            elif _layer_without(old_layer, 'mask') == _layer_without(new_layer, 'mask'):
                old_mask_strokes = old_layer.get('mask', {}).get('strokes', [])
                new_mask_strokes = new_layer.get('mask', {}).get('strokes', [])
                if (_mask_without_strokes(old_layer) == _mask_without_strokes(new_layer) and
                        old_mask_strokes != new_mask_strokes):
                    old_changed, new_changed = _changed_records(old_mask_strokes, new_mask_strokes)
                    kind = new_layer.get('type')
                    if kind == 'liquify':
                        return None
                    current = ('mask', index, kind, old_changed, new_changed)
                elif old_layer.get('type') in ADJUSTMENT_KINDS:
                    old_mask, new_mask = old_layer.get('mask', {}), new_layer.get('mask', {})
                    if (_layer_without(old_mask, 'shape') == _layer_without(new_mask, 'shape') and
                            old_mask.get('shape') and new_mask.get('shape')):
                        shapes = (old_mask['shape']['box'], new_mask['shape']['box'])
                        current = ('shape', index, old_layer['type'], shapes, ())

            if current is None:
                return None
            changes.append(current)

        if not changes:
            return None
        boxes = []
        for field, index, kind, old_changed, new_changed in changes:
            following = new_layers[index + 1:]
            if any(layer.get('type') == 'liquify' and engine._has_effect(layer) for layer in following):
                return None
            halo = engine.context_halo(following) - 8
            if field == 'shape':
                boxes.extend(_padded_box(box, halo, self.size) for box in old_changed)
            else:
                old_changed, new_changed = _stroke_tail(old_changed, new_changed)
                def extension(radius, stroke):
                    if kind == 'liquify':
                        return 2 * radius + 8 + halo
                    return _paint_extent(radius, stroke, mask=field == 'mask') + halo
                for records in (old_changed, new_changed):
                    boxes.append(_stroke_bounds(records, self.size, extension))
        return _union_boxes(boxes)

    def _bounded_adjustment_change(self, layers, engine):
        """Parameter, order, or visibility changes to masked adjustment regions."""
        old, new = _changed_records(self.layers, layers)
        prefix = _common_prefix_size(self.layers, layers)
        affected = (*self.layers[prefix:], *layers[prefix:])
        if any(layer['type'] == 'liquify' and engine._has_effect(layer) for layer in affected):
            return None
        halo = max(engine.context_halo(self.layers[prefix:]), engine.context_halo(layers[prefix:]))
        boxes = []
        for layer in (*old, *new):
            if not engine._has_effect(layer):
                continue
            if layer['type'] not in ADJUSTMENT_KINDS:
                return None
            mask = layer.get('mask', {})
            if mask.get('shape'):
                boxes.append(_padded_box(mask['shape']['box'], halo, self.size))
            elif not mask.get('base', 1):
                strokes = (stroke for stroke in mask.get('strokes', []) if not stroke.get('erase'))
                boxes.append(_stroke_bounds(strokes, self.size, lambda radius, stroke: 2 * radius + 8 + halo))
            else:
                return None
        bounds = _union_boxes(boxes)
        if bounds and (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]) <= MAX_VIEWPORT_PIXELS:
            return bounds
        return None

    def _liquify_tail(self, layers):
        if not layers or not self.layers or layers[:-1] != self.layers[:-1]:
            return None
        before, after = self.layers[-1], layers[-1]
        if after['type'] != 'liquify' or _layer_without(before, 'strokes') != _layer_without(after, 'strokes'):
            return None
        old, new = before.get('strokes', []), after.get('strokes', [])
        if not old or len(old) != len(new) or old[:-1] != new[:-1]:
            return None
        previous, current = _stroke_tail(old[-1:], new[-1:])
        if previous or len(current) != 1 or current[0] is new[-1]:
            return None
        return after, current

    def _commit_region(self, before, after, box, trim):
        if trim:
            with ImageChops.difference(before, after) as difference:
                bounds = difference.getbbox(alpha_only=False)
            if bounds is None:
                return None
            x, y = box[:2]
            dirty = (x + bounds[0], y + bounds[1], x + bounds[2], y + bounds[3])
            if dirty != box:
                with after.crop(bounds) as cropped:
                    self._paste_region(dirty, cropped)
                return dirty
        elif _images_equal(before, after):
            return None
        self._paste_region(box, after)
        return box

    def _paint_append(self, layer, strokes, engine, box, before, *, skip_initial=False, trim=False):
        layer_only = deepcopy(layer)
        layer_only['strokes'] = deepcopy(strokes)
        if layer_only['type'] == 'liquify':
            extent = _padded_box(box, engine.context_halo([layer_only]), self.size)
            x, y = extent[:2]
            with self._crop_region(extent) as candidate:
                engine.apply_liquify(candidate, layer_only, 1, (x, y), native_crop=True,
                                     skip_initial=skip_initial)
                local = (box[0] - x, box[1] - y, box[2] - x, box[3] - y)
                with candidate.crop(local) as patch:
                    return self._commit_region(before, patch, box, trim)

        x0, y0, x1, y1 = box
        with before.copy() as patch:
            engine.apply_paint(patch, layer_only, 1, (x0, y0), self.original)
            return self._commit_region(before, patch, box, trim)

    def _render_region(self, engine, layers, box, progress=None, compact_tiles=False):
        x, y, right, bottom = box
        return engine.render(
            None,
            {'layers': layers},
            region=(x, y, right - x, bottom - y),
            region_scale=1,
            prepared_source=self.original,
            progress=progress,
            compact_tiles=compact_tiles,
        )

    def _adjustment_base(self, old, new):
        if not new or new[-1]['type'] not in ADJUSTMENT_KINDS:
            return None
        prefix = new[:-1]
        if not prefix:
            return self.original
        if prefix == old:
            return self.current
        checkpoint = self._adjustment_checkpoint
        if checkpoint is not None and prefix == checkpoint[0]:
            return checkpoint[1]
        return None

    def _clear_adjustment_checkpoint(self):
        checkpoint, self._adjustment_checkpoint = self._adjustment_checkpoint, None
        if checkpoint is not None:
            checkpoint[1].close()

    def _render_prefix_region(self, engine, prefix, suffix, box, halo):
        x, y, right, bottom = box
        extent = (max(0, x - halo), max(0, y - halo),
                  min(self.size[0], right + halo), min(self.size[1], bottom + halo))
        context = (extent[0] // 256 * 256, extent[1] // 256 * 256,
                   min(self.size[0], (extent[2] + 255) // 256 * 256),
                   min(self.size[1], (extent[3] + 255) // 256 * 256))
        if (context[2] - context[0]) * (context[3] - context[1]) > MAX_VIEWPORT_PIXELS:
            context = extent
        checkpoint = self._viewport_checkpoint
        if checkpoint is not None and checkpoint[0][0] == prefix:
            cached = checkpoint[0][1]
            if cached[0] <= extent[0] and cached[1] <= extent[1] and cached[2] >= extent[2] and cached[3] >= extent[3]:
                context = cached
        key = (prefix, context)
        if checkpoint is None or checkpoint[0] != key:
            pixels = self._render_region(engine, prefix, context, compact_tiles=True)
            if checkpoint is not None:
                checkpoint[1].close()
            checkpoint = self._viewport_checkpoint = (key, pixels)
        left, top = extent[:2]
        offset_x, offset_y = context[:2]
        crop = (left - offset_x, top - offset_y, extent[2] - offset_x, extent[3] - offset_y)
        with checkpoint[1].crop(crop) as pixels:
            engine._apply_layers(pixels, suffix, 1, (left, top), self.original, compact_tiles=True)
            return pixels.crop((x - left, y - top, right - left, bottom - top))

    def _render_full_adjustment(self, engine, old, new, box, progress, cooperative):
        if cooperative:
            local_start = len(new)
            while local_start > 0 and new[local_start - 1]['type'] in {'paint', 'clone'}:
                local_start -= 1
            if 0 < local_start < len(new) and all(layer['type'] in ADJUSTMENT_KINDS for layer in new[:local_start]):
                # Keep the source separate through the filter prefix. Applying
                # trailing strokes to that result avoids an extra full copy for
                # the filter when a stroke supersedes an in-flight render.
                candidate, _ = yield from self._render_full_adjustment(
                    engine, old, new[:local_start], box, None, cooperative,
                )
                try:
                    yield from engine.iter_layers(candidate, new[local_start:], 1, (0, 0), self.original, progress)
                except BaseException:
                    candidate.close()
                    raise
                return candidate, None
        base = self._adjustment_base(old, new)
        if base is None:
            checkpoint = self._adjustment_checkpoint
            if checkpoint is not None and new == checkpoint[0]:
                return checkpoint[1].copy(), None
            if not new:
                return self.original.copy(), None
            mask = new[-1].get('mask', {})
            if cooperative and new[-1]['type'] in ADJUSTMENT_KINDS and not (mask.get('strokes') or mask.get('shape')):
                tone_table = engine.tone_prefix_table(new[:-1])
                if tone_table is not None:
                    candidate = Image.new('RGBA', self.size, None)
                    try:
                        yield from engine.iter_adjustment(candidate, new[-1], 1, (0, 0),
                                                          source_image=self.original, source_lut=tone_table)
                    except BaseException:
                        candidate.close()
                        raise
                    return candidate, None
            if (cooperative and (FILTER_TILE_SIZE + 2 * engine.context_halo(new)) ** 2 <= MAX_VIEWPORT_PIXELS
                    and all(layer['type'] in ADJUSTMENT_KINDS and not layer.get('mask', {}).get('shape')
                            for layer in new)):
                # Keep neighborhood copies local to a tile, even for long stacks.
                # The combined halo includes all layers that read adjacent pixels.
                candidate = Image.new('RGBA', self.size, None)
                try:
                    for y in range(0, self.size[1], FILTER_TILE_SIZE):
                        for x in range(0, self.size[0], FILTER_TILE_SIZE):
                            tile = (x, y, min(x + FILTER_TILE_SIZE, self.size[0]),
                                    min(y + FILTER_TILE_SIZE, self.size[1]))
                            with self._render_region(engine, new, tile, compact_tiles=True) as pixels:
                                candidate.paste(pixels, tile)
                            yield
                except BaseException:
                    candidate.close()
                    raise
                return candidate, None
            if cooperative:
                candidate = self.original.copy()
                try:
                    yield from engine.iter_layers(candidate, new, 1, (0, 0), self.original, progress)
                except BaseException:
                    candidate.close()
                    raise
                return candidate, None
            return self._render_region(engine, new, box, progress), None
        candidate = Image.new('RGBA', self.size, None)
        try:
            yield from engine.iter_layers(candidate, new[-1:], 1, (0, 0), self.original, progress,
                                          first_source=base, chunked=cooperative)
        except BaseException:
            candidate.close()
            raise
        return candidate, base

    def viewport_update(self, engine, layers, box):
        """Render a native viewport ahead of an expensive document-wide update."""
        old, new = _effective(engine, self.layers), _effective(engine, layers)
        if old == new or self._top_stroke_append(layers, engine) is not None or self._liquify_tail(layers):
            return None
        if self._local_stroke_change(layers, engine) is not None or self._bounded_adjustment_change(layers, engine) is not None:
            return None
        base = self._adjustment_base(old, new)
        prefix_size = _common_prefix_size(old, new) if base is None else 0
        if base is None:
            # A brush can arrive before the full filter commits. Its exact
            # viewport reuses the unchanged adjustment pixels across samples.
            local_start = len(new)
            while local_start > 0 and new[local_start - 1]['type'] in {'paint', 'clone'}:
                local_start -= 1
            if 0 < local_start < len(new):
                prefix_size = max(prefix_size, local_start)
        suffix = new[prefix_size:]
        reuse_prefix = bool(suffix) and prefix_size > 0 and all(
            layer['type'] in ADJUSTMENT_KINDS for layer in new[:prefix_size]
        ) and all(layer['type'] != 'liquify' and not layer.get('mask', {}).get('shape') for layer in new)
        visible_layers = new[-1:] if base is not None else suffix if reuse_prefix else new
        halo = engine.context_halo(visible_layers)
        width, height = box[2] - box[0], box[3] - box[1]
        if (width + 2 * halo) * (height + 2 * halo) > MAX_VIEWPORT_PIXELS:
            return None
        if reuse_prefix:
            return self._render_prefix_region(engine, new[:prefix_size], suffix, box, halo)
        return engine.render(None, {'layers': visible_layers}, region=(*box[:2], width, height),
                             region_scale=1, prepared_source=base if base is not None else self.original,
                             compact_tiles=True)

    def _clear_transition(self):
        transition, self._last_transition = self._last_transition, None
        if transition is not None:
            transition['before'].close()
            transition['after'].close()

    def _matching_transition(self, new_layers):
        transition = self._last_transition
        if transition is None:
            return None
        if self.layers == transition['after_layers'] and new_layers == transition['before_layers']:
            return transition, 'before'
        if self.layers == transition['before_layers'] and new_layers == transition['after_layers']:
            return transition, 'after'
        return None

    def _apply_transition(self, transition, side):
        box = transition['box']
        patch = transition[side]
        self._paste_region(box, patch)

    def _replace_transition(self, old_layers, new_layers, box, before):
        self._clear_transition()
        if before is None or box is None:
            if before is not None:
                before.close()
            return
        try:
            after = self._crop_region(box)
        except Exception:
            before.close()
            return
        self._last_transition = {
            'before_layers': deepcopy(old_layers),
            'after_layers': deepcopy(new_layers),
            'box': tuple(box),
            'before': before,
            'after': after,
        }

    def _response(self, base_revision, old_revision, changed, dirty):
        if base_revision != old_revision:
            return (
                self.current,
                (0, 0, self.size[0], self.size[1]),
                self.revision,
                True,
            )
        if changed and dirty is not None:
            full_document = dirty == (0, 0, self.size[0], self.size[1])
            image = self.current if full_document else self._crop_region(dirty)
            return image, dirty, self.revision, full_document
        return None, None, self.revision, False

    def update(self, engine, layers, base_revision, progress=None):
        """Update pixels and return (image, box, revision, borrowed-from-cache)."""
        work = self.iter_update(engine, layers, base_revision, progress, cooperative=False)
        try:
            while True:
                next(work)
        except StopIteration as done:
            return done.value

    def iter_update(self, engine, layers, base_revision, progress=None, *, cooperative=True):
        """Yield between full-frame tiles while keeping confirmed state transactional."""
        if self._closed:
            raise RuntimeError('작업 이미지가 닫혔습니다.')
        new_layers = deepcopy(layers)
        old_revision = self.revision
        missed_base = base_revision != old_revision
        old_layers = self.layers
        matched = self._matching_transition(new_layers)
        if matched is not None:
            transition, side = matched
            dirty = transition['box']
            self._apply_transition(transition, side)
            self.layers = new_layers
            self.revision += 1
            return self._response(base_revision, old_revision, True, dirty)

        old_effective = _effective(engine, self.layers)
        new_effective = _effective(engine, new_layers)
        changed = False
        dirty = None
        transition_before = None
        transition_box = None

        try:
            if old_effective == new_effective:
                # Keep metadata current while leaving pixels and revision untouched.
                self.layers = new_layers
            else:
                tail = self._liquify_tail(new_layers)
                append = tail or self._top_stroke_append(new_layers, engine)
                if append is not None:
                    layer, strokes = append
                    extension = (lambda radius, stroke: radius + 4) if layer['type'] == 'liquify' else _paint_extent
                    dirty = _stroke_bounds(strokes, self.size, extension)
                    if dirty is not None:
                        if ((dirty[2] - dirty[0]) * (dirty[3] - dirty[1]) <=
                                MAX_TRANSITION_PIXELS):
                            transition_before = self._crop_region(dirty)
                            transition_box = dirty
                        before = transition_before if transition_before is not None else self._crop_region(dirty)
                        try:
                            dirty = self._paint_append(layer, strokes, engine, dirty, before,
                                                       skip_initial=bool(tail), trim=cooperative)
                            changed = dirty is not None
                        finally:
                            if before is not transition_before:
                                before.close()
                    self.layers = new_layers
                else:
                    dirty = self._local_stroke_change(new_layers, engine)
                    if dirty is None and cooperative:
                        dirty = self._bounded_adjustment_change(new_layers, engine)
                    if dirty is None:
                        dirty = (0, 0, self.size[0], self.size[1])
                    if dirty[2] > dirty[0] and dirty[3] > dirty[1]:
                        if ((dirty[2] - dirty[0]) * (dirty[3] - dirty[1]) <=
                                MAX_TRANSITION_PIXELS):
                            transition_before = self._crop_region(dirty)
                            transition_box = dirty
                        full_document = dirty == (0, 0, self.size[0], self.size[1])
                        adjustment_base = None
                        if full_document:
                            patch, adjustment_base = yield from self._render_full_adjustment(
                                engine, old_effective, new_effective, dirty, progress, cooperative,
                            )
                        else:
                            prefix = _common_prefix_size(old_effective, new_effective) if cooperative else 0
                            suffix = new_effective[prefix:]
                            halo = engine.context_halo(suffix) if prefix else 0
                            extent = (dirty[2] - dirty[0] + 2 * halo) * (dirty[3] - dirty[1] + 2 * halo)
                            if prefix and extent <= MAX_VIEWPORT_PIXELS and all(
                                    not layer.get('mask', {}).get('shape') and layer['type'] != 'liquify'
                                    for layer in new_effective):
                                patch = self._render_prefix_region(engine, new_effective[:prefix], suffix, dirty, halo)
                            else:
                                patch = self._render_region(engine, new_effective, dirty, progress,
                                                            compact_tiles=cooperative)
                        try:
                            if full_document:
                                changed = not _images_equal(self.current, patch)
                                if changed:
                                    previous, self.result = self.result, patch
                                    patch = None
                                    if (previous is not None and previous is adjustment_base and
                                            self.size[0] * self.size[1] <= self._checkpoint_pixels):
                                        self._clear_adjustment_checkpoint()
                                        self._adjustment_checkpoint = (new_effective[:-1], previous)
                                    elif previous is not None:
                                        previous.close()
                            else:
                                before = transition_before if transition_before is not None else self._crop_region(dirty)
                                try:
                                    dirty = self._commit_region(before, patch, dirty, cooperative)
                                    changed = dirty is not None
                                finally:
                                    if before is not transition_before:
                                        before.close()
                        finally:
                            if patch is not None:
                                patch.close()
                    self.layers = new_layers
        except BaseException:
            if transition_before is not None:
                transition_before.close()
            raise

        if changed:
            self.revision += 1
            if transition_before is not None and transition_box != dirty:
                x, y = transition_box[:2]
                before = transition_before
                try:
                    transition_before = before.crop((dirty[0] - x, dirty[1] - y, dirty[2] - x, dirty[3] - y))
                except Exception:
                    transition_before = None
                finally:
                    before.close()
            self._replace_transition(old_layers, new_layers, dirty, transition_before)
            transition_before = None
        elif old_layers != new_layers:
            if transition_before is not None:
                transition_before.close()
                transition_before = None
            self._clear_transition()
        if transition_before is not None:
            transition_before.close()
        return self._response(base_revision, old_revision, changed, dirty)

    def close(self):
        if self._closed:
            return
        self._closed = True
        if self.result is not None:
            self.result.close()
            self.result = None
        for pixels in self._sparse_tiles.values():
            pixels.close()
        self._sparse_tiles = {}
        self._sparse_bytes = 0
        self.original.close()
        self._clear_transition()
        self._clear_adjustment_checkpoint()
        if self._viewport_checkpoint is not None:
            self._viewport_checkpoint[1].close()
            self._viewport_checkpoint = None

