import copy
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from naim.storage.daki_projects import DakiNotFoundError, DakiProjectsStore
from naim.storage.json_files import write_json


def _canvas(state=None):
    return {
        'id': 'a' * 32,
        'name': 'Front',
        'side': 'front',
        'revision': 1,
        'created_at': '2026-10-01T00:00:00+00:00',
        'updated_at': '2026-10-01T00:00:00+00:00',
        'state': state or {'width': 640, 'height': 800, 'layers': []},
    }


def _project(project_id='project-id', *, name='Project', canvas=None):
    return {
        'id': project_id,
        'name': name,
        'created_at': '2026-10-01T00:00:00+00:00',
        'updated_at': '2026-10-01T00:00:00+00:00',
        'candidates': {'front': [], 'back': []},
        'canvases': {'front': [canvas] if canvas else [], 'back': []},
    }


class DakiReadCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / 'daki_projects.json'
        self.store = DakiProjectsStore(lambda: self.path)

    def save(self, data, path=None):
        write_json(path or self.path, data, indent=2)

    def test_repeated_read_endpoints_parse_one_unchanged_store(self):
        project = _project(canvas=_canvas())
        self.save({'enabled': True, 'projects': [project]})

        with mock.patch.object(self.store, '_load', wraps=self.store._load) as load:
            self.assertEqual(self.store.settings(), {'enabled': True})
            self.assertEqual(self.store.list_projects()[0]['id'], project['id'])
            self.assertEqual(self.store.list_projects(summary=True)[0]['id'], project['id'])
            self.assertEqual(self.store.get_project(project['id'])['name'], 'Project')
            self.assertEqual(self.store.get_project(project['id'], summary=True)['name'], 'Project')
            self.assertEqual(self.store.get_canvas_settings(project['id'])['revision'], 0)
            self.store.get_canvas_with_project(project['id'], 'a' * 32)
            self.store.get_canvas_with_project(project['id'], 'a' * 32, preview=True)

        self.assertEqual(load.call_count, 1)

    def test_returned_full_and_preview_records_cannot_mutate_the_snapshot(self):
        project = _project(canvas=_canvas({
            'width': 640,
            'height': 800,
            'layers': [{
                'type': 'image', 'visible': True, 'src': 'data:image/png;base64,abc',
                'x': 12, 'y': 34, 'layerWidth': 100, 'layerHeight': 200,
            }],
            'maskData': {'large': [1, 2, 3]},
        }))
        self.save({'enabled': True, 'projects': [project]})

        _, full = self.store.get_canvas_with_project(project['id'], 'a' * 32)
        self.assertEqual(full, project['canvases']['front'][0])
        full['state']['layers'][0]['x'] = 999
        full['state']['maskData']['large'].append(4)
        _, preview = self.store.get_canvas_with_project(
            project['id'], 'a' * 32, preview=True,
        )
        self.assertEqual(preview['state']['layers'][0]['x'], 12)
        self.assertEqual(preview['state']['layers'][0]['src'], 'data:image/png;base64,abc')
        preview['state']['layers'][0]['x'] = 888
        _, second_preview = self.store.get_canvas_with_project(
            project['id'], 'a' * 32, preview=True,
        )
        self.assertEqual(second_preview['state']['layers'][0]['x'], 12)

    def test_owned_create_update_delete_and_staged_removal_bypass_snapshot(self):
        first = _project(canvas=_canvas())
        self.save({'enabled': True, 'projects': [first]})
        self.assertEqual(self.store.get_project(first['id'])['name'], 'Project')

        created = self.store.create_project('Created')
        self.assertEqual(self.store.get_project(created['id'])['name'], 'Created')

        canvas = self.store.create_canvas(first['id'], {
            'id': 'b' * 32,
            'name': 'Second',
            'side': 'front',
            'state': {'width': 10, 'height': 20, 'layers': []},
        })
        changed = self.store.update_canvas(
            first['id'], canvas['id'], {'width': 20, 'height': 30, 'layers': []}, 1,
        )
        self.assertEqual(changed['state']['width'], 20)
        self.assertEqual(self.store.get_canvas(first['id'], canvas['id'])['revision'], 2)
        self.store.remove_canvas(first['id'], canvas['id'])
        with self.assertRaises(DakiNotFoundError):
            self.store.get_canvas(first['id'], canvas['id'])

        with self.store.staged_project_removal(first['id']):
            with self.assertRaises(DakiNotFoundError):
                self.store.get_project(first['id'])
        with self.assertRaises(DakiNotFoundError):
            self.store.get_project(first['id'])

        restored = self.store.create_project('Rollback target')
        with self.assertRaisesRegex(RuntimeError, 'rollback'):
            with self.store.staged_project_removal(restored['id']):
                raise RuntimeError('rollback')
        self.assertEqual(self.store.get_project(restored['id'])['name'], 'Rollback target')

    def test_external_atomic_same_size_replace_with_restored_mtime_invalidates(self):
        original = _project(name='Old')
        self.save({'enabled': True, 'projects': [original]})
        self.assertEqual(self.store.get_project(original['id'])['name'], 'Old')
        before_stat = self.path.stat()
        updated = copy.deepcopy(original)
        updated['name'] = 'New'
        self.save({'enabled': True, 'projects': [updated]})
        os.utime(self.path, ns=(before_stat.st_atime_ns, before_stat.st_mtime_ns))

        after_stat = self.path.stat()
        self.assertEqual(after_stat.st_size, before_stat.st_size)
        self.assertEqual(after_stat.st_mtime_ns, before_stat.st_mtime_ns)
        self.assertEqual(self.store.get_project(original['id'])['name'], 'New')

    def test_path_switch_and_missing_file_do_not_reuse_previous_snapshot(self):
        selected_path = [self.path]
        store = DakiProjectsStore(lambda: selected_path[0])
        self.save({'enabled': True, 'projects': [_project(name='First')]}, self.path)
        second_path = self.root / 'other.json'
        self.save({'enabled': False, 'projects': [_project('other-id', name='Second')]}, second_path)

        self.assertEqual(store.get_project('project-id')['name'], 'First')
        selected_path[0] = second_path
        self.assertEqual(store.settings(), {'enabled': False})
        self.assertEqual(store.get_project('other-id')['name'], 'Second')

        second_path.unlink()
        self.assertEqual(store.settings(), {'enabled': True})
        self.save({'enabled': False, 'projects': []}, second_path)
        self.assertEqual(store.settings(), {'enabled': False})

    def test_corrupt_file_recovers_and_is_cached_only_after_recovery(self):
        self.path.write_text('{not json', encoding='utf-8')
        with mock.patch.object(self.store, '_load', wraps=self.store._load) as load:
            self.assertEqual(self.store.list_projects(), [])
            self.assertEqual(self.store.list_projects(), [])
            self.assertEqual(self.store.list_projects(), [])
        self.assertEqual(load.call_count, 2)
        self.assertTrue(list(self.root.glob('daki_projects.json.corrupt-*.bak')))
        self.assertEqual(json.loads(self.path.read_text(encoding='utf-8')),
                         {'enabled': True, 'projects': []})

    def test_concurrent_reads_collapse_to_one_parse(self):
        self.save({'enabled': True, 'projects': [_project()]})
        barrier = threading.Barrier(8)
        original_load = self.store._load

        def slow_load(path):
            time.sleep(0.05)
            return original_load(path)

        def read(_):
            barrier.wait(timeout=2)
            return self.store.list_projects()[0]['id']

        with mock.patch.object(self.store, '_load', side_effect=slow_load) as load:
            with ThreadPoolExecutor(max_workers=8) as pool:
                self.assertEqual(list(pool.map(read, range(8))), ['project-id'] * 8)
        self.assertEqual(load.call_count, 1)

    def test_canvas_state_and_reference_scans_continue_to_use_fresh_loads(self):
        project = _project(canvas=_canvas({
            'width': 10,
            'height': 20,
            'layers': [],
        }))
        self.save({'enabled': True, 'projects': [project]})
        self.store.list_projects()  # Warm the read-only snapshot.

        with mock.patch.object(self.store, '_load', wraps=self.store._load) as load:
            self.assertEqual(len(list(self.store.canvas_states())), 1)
            self.assertEqual(self.store.references(paths=['missing.png']), [])
        self.assertEqual(load.call_count, 2)

    def test_preview_keeps_drawable_fields_and_drops_large_editor_payload(self):
        layers = [
            {'type': 'canvas', 'visible': True, 'x': 0, 'y': 0, 'promptInfo': 'x' * 200_000},
            {'type': 'folder', 'visible': True, 'name': 'editor name', 'children': [
                {'type': 'image', 'visible': True, 'src': 'data:image/png;base64,legacy',
                 'x': -12, 'y': 34, 'layerWidth': 123, 'layerHeight': 456,
                 'imageWidth': 640, 'imageHeight': 800, 'maskData': 'm' * 300_000,
                 'promptInfo': {'text': 'p' * 300_000}},
                {'type': 'image', 'visible': True, 'pinnedReference': True,
                 'src': '/reference.png'},
                {'type': 'image', 'visible': False, 'src': '/hidden.png'},
                {'type': 'clip', 'visible': True, 'renderOnCanvas': False,
                 'src': '/source-clip.png'},
                {'type': 'clip', 'visible': True, 'renderOnCanvas': True,
                 'src': '/rendered-clip.png', 'x': 2, 'y': 3,
                 'maskData': 'c' * 300_000},
                {'type': 'brush', 'visible': True, 'maskData': 'b' * 300_000},
                {'type': 'selection', 'visible': True, 'children': [
                    {'type': 'image', 'visible': True, 'src': '/nested.png', 'x': 7},
                ]},
                {'type': 'selection', 'visible': False, 'children': [
                    {'type': 'image', 'visible': True, 'src': '/hidden-parent.png'},
                ]},
            ]},
        ]
        project = _project(canvas=_canvas({
            'width': 640,
            'height': 800,
            'layers': layers,
            'maskData': {'points': 'z' * 400_000},
            'promptInfo': {'prompt': 'q' * 400_000},
        }))
        self.save({'enabled': True, 'projects': [project]})

        _, full = self.store.get_canvas_with_project(project['id'], 'a' * 32)
        _, preview = self.store.get_canvas_with_project(
            project['id'], 'a' * 32, preview=True,
        )
        projected = preview['state']['layers']
        self.assertEqual([layer['type'] for layer in projected], ['canvas', 'folder'])
        children = projected[1]['children']
        self.assertEqual([layer['type'] for layer in children], [
            'image', 'clip', 'selection',
        ])
        self.assertEqual(children[0]['src'], 'data:image/png;base64,legacy')
        self.assertEqual((children[0]['x'], children[0]['y']), (-12, 34))
        self.assertEqual((children[0]['layerWidth'], children[0]['layerHeight']), (123, 456))
        self.assertEqual(children[1]['src'], '/rendered-clip.png')
        self.assertEqual(children[2]['children'][0]['src'], '/nested.png')
        preview_json = json.dumps(preview, ensure_ascii=False)
        self.assertNotIn('maskData', preview_json)
        self.assertNotIn('promptInfo', preview_json)
        self.assertLess(len(preview_json), len(json.dumps(full, ensure_ascii=False)) * 0.05)
        self.assertEqual(full, project['canvases']['front'][0])

    def test_preview_normalizes_json_truthy_layer_flags_like_javascript(self):
        layers = [
            {'type': 'image', 'visible': [], 'pinnedReference': False, 'src': '/visible.png'},
            {'type': 'image', 'visible': {}, 'pinnedReference': [], 'src': '/pinned.png'},
            {'type': 'clip', 'visible': {}, 'renderOnCanvas': {}, 'src': '/clip-object.png'},
            {'type': 'clip', 'visible': [], 'renderOnCanvas': [], 'src': '/clip-array.png'},
            {'type': 'image', 'visible': 0, 'src': '/hidden.png'},
        ]
        project = _project(canvas=_canvas({
            'width': 10, 'height': 20, 'layers': layers,
        }))
        self.save({'enabled': True, 'projects': [project]})

        _, preview = self.store.get_canvas_with_project(
            project['id'], 'a' * 32, preview=True,
        )
        projected = preview['state']['layers']
        self.assertEqual([layer['src'] for layer in projected], [
            '/visible.png', '/clip-object.png', '/clip-array.png',
        ])
        self.assertTrue(all(layer['visible'] is True for layer in projected))
        self.assertIs(projected[0]['pinnedReference'], False)
        self.assertTrue(all(layer['renderOnCanvas'] is True for layer in projected[1:]))


if __name__ == '__main__':
    unittest.main()
