import ast
import os
from pathlib import Path
import random
import threading
import time
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock
from urllib.parse import unquote, urlsplit

import utils
from naim.jobs.batches import iter_completed


class GalleryPromptCancellationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Load the actual search functions without starting unrelated app services.
        source = Path(__file__).resolve().parents[1] / 'app.py'
        names = {
            'clean_gallery_rel_path', 'normalize_gallery_prompt_scope_paths',
            'split_gallery_prompt_search_terms', 'iter_gallery_prompt_index_files',
            'should_skip_gallery_index_directory', 'should_skip_gallery_index_child_directory',
            'build_gallery_prompt_index_record', 'search_gallery_prompts_without_index',
            'public_gallery_prompt_search_job', 'update_gallery_prompt_search_job',
            'gallery_prompt_search_worker', 'gallery_prompt_search_start',
            'gallery_prompt_search_status', 'gallery_prompt_search_cancel',
            'build_gallery_prompt_search_payload',
        }
        functions = [node for node in ast.parse(source.read_text(encoding='utf-8')).body
                     if isinstance(node, ast.FunctionDef) and node.name in names]
        for function in functions:
            function.decorator_list = []
        cls.app = types.ModuleType('prompt_cancel_test_app')
        cls.app.__dict__.update({
            'os': os, 'random': random, 'threading': threading, 'time': time, 'utils': utils,
            'unquote': unquote, 'urlsplit': urlsplit,
            'ThreadPoolExecutor': ThreadPoolExecutor, 'iter_completed': iter_completed,
            'request': types.SimpleNamespace(json={}), 'jsonify': lambda value: value,
            'GALLERY_PROMPT_SEARCH_LOCK': threading.Lock(), 'GALLERY_PROMPT_SEARCH_JOBS': {},
            'GALLERY_PROMPT_INDEX_WORKERS': 2, 'CLASSIFIED_DIR': os.path.abspath('synthetic-gallery'),
            'UPSCALE_OUTPUT_FOLDER_NAME': 'upscale',
        })
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), cls.app.__dict__)

    def setUp(self):
        self.app.GALLERY_PROMPT_SEARCH_JOBS.clear()

    def start_job(self):
        self.app.request.json = {'query': 'hero', 'scope_paths': [], 'mode': 'all'}
        with mock.patch.object(self.app.threading, 'Thread') as thread:
            response = self.app.gallery_prompt_search_start()
        thread.return_value.start.assert_called_once()
        self.assertNotIn('_cancel_event', response['job'])
        return response['job']['id']

    def database(self, indexed_images=0):
        database = mock.MagicMock()
        database.get_gallery_prompt_index_status.return_value = {'indexed_images': indexed_images}
        database.search_gallery_prompt_index.return_value = []
        return database

    def assert_cancelled(self, job_id):
        job = self.app.gallery_prompt_search_status(job_id)['job']
        self.assertFalse(job['running'])
        self.assertTrue(job['done'])
        self.assertTrue(job['cancel_requested'])
        self.assertTrue(job['cancelled'])
        self.assertTrue(job['result']['partial'])
        self.assertEqual(job['error'], '')

    def test_cancellation_before_worker_skips_database_and_file_scan(self):
        job_id = self.start_job()
        response = self.app.gallery_prompt_search_cancel(job_id)
        self.assertTrue(response['job']['running'])
        self.assertTrue(response['job']['cancel_requested'])
        self.assertFalse(response['job']['cancelled'])
        with mock.patch.object(self.app.utils, 'HistoryDB') as database, \
                mock.patch.object(self.app, 'iter_gallery_prompt_index_files') as scan:
            self.app.gallery_prompt_search_worker(job_id, 'hero', [], 'all')
        database.assert_not_called()
        scan.assert_not_called()
        self.assert_cancelled(job_id)
        self.assertEqual(self.app.gallery_prompt_search_status(job_id)['job']['result'], {
            'image_paths': [], 'folder_counts': {}, 'total_matches': 0, 'indexed': False, 'partial': True,
        })

    def test_cancel_during_directory_scan_stops_before_next_directory(self):
        cancelled = threading.Event()
        visited = []

        def filenames():
            yield 'first.png'
            cancelled.set()
            yield 'second.png'
            self.fail('scan continued after cancellation')

        def walk(_root):
            visited.append('first')
            yield self.app.CLASSIFIED_DIR, [], filenames()
            visited.append('second')
            yield self.app.CLASSIFIED_DIR, [], ['third.png']

        with mock.patch.object(self.app.os.path, 'isdir', return_value=True), \
                mock.patch.object(self.app.os, 'walk', side_effect=walk), \
                mock.patch.object(self.app, 'should_skip_gallery_index_directory', return_value=False):
            paths = self.app.iter_gallery_prompt_index_files([], 'all', stop_check=cancelled.is_set)
        self.assertEqual(paths, [])
        self.assertEqual(visited, ['first'])

    def test_cancel_running_fallback_skips_queued_reads_and_remaining_files(self):
        paths = [os.path.join(self.app.CLASSIFIED_DIR, f'synthetic-{index}.png') for index in range(1000)]
        cancelled = threading.Event()
        both_started = threading.Event()
        release_reads = threading.Event()
        read_lock = threading.Lock()
        read_paths = []
        output = []
        failures = []

        def read(path):
            with read_lock:
                read_paths.append(path)
                if len(read_paths) == 2:
                    both_started.set()
            if not release_reads.wait(5):
                raise RuntimeError('test did not release file reads')
            return {'prompt_text': 'hero', 'normalized_text': 'hero'}

        def search():
            try:
                output.append(self.app.search_gallery_prompts_without_index('hero', cancel_event=cancelled))
            except Exception as error:
                failures.append(error)

        with mock.patch.object(self.app, 'GALLERY_PROMPT_INDEX_WORKERS', 2), \
                mock.patch.object(self.app, 'iter_gallery_prompt_index_files', return_value=paths), \
                mock.patch.object(self.app, 'build_gallery_prompt_index_record', side_effect=read):
            worker = threading.Thread(target=search)
            worker.start()
            try:
                self.assertTrue(both_started.wait(5))
                cancelled.set()
            finally:
                release_reads.set()
                worker.join(5)
            self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(output, [[]])
        self.assertEqual(len(read_paths), 2)

    def test_fallback_without_cancellation_preserves_positive_only_matching(self):
        paths = [os.path.join(self.app.CLASSIFIED_DIR, f'synthetic-{index}.png') for index in range(2)]
        records = {
            paths[0]: {'prompt_text': 'hero villain', 'positive_prompt_text': 'hero'},
            paths[1]: {'prompt_text': 'villain', 'positive_prompt_text': 'villain'},
        }
        with mock.patch.object(self.app, 'iter_gallery_prompt_index_files', return_value=paths), \
                mock.patch.object(self.app, 'build_gallery_prompt_index_record', side_effect=records.__getitem__):
            general = self.app.search_gallery_prompts_without_index('villain')
            positive = self.app.search_gallery_prompts_without_index('villain', positive_only=True)
        self.assertEqual(len(general), 2)
        self.assertEqual([row['file_name'] for row in positive], ['synthetic-1.png'])

    def test_fallback_cancellation_keeps_matches_already_collected(self):
        cancelled = threading.Event()
        paths = [os.path.join(self.app.CLASSIFIED_DIR, f'synthetic-{index}.png') for index in range(20)]

        def progress(total, processed, message):
            if processed:
                cancelled.set()

        with mock.patch.object(self.app, 'iter_gallery_prompt_index_files', return_value=paths), \
                mock.patch.object(self.app, 'build_gallery_prompt_index_record', return_value={'prompt_text': 'hero'}):
            rows = self.app.search_gallery_prompts_without_index('hero', progress=progress, cancel_event=cancelled)
        self.assertEqual(len(rows), 1)

    def test_uncancelled_worker_keeps_complete_results_and_progress(self):
        job_id = self.start_job()
        database = self.database()
        paths = [os.path.join(self.app.CLASSIFIED_DIR, f'synthetic-{index}.png') for index in range(3)]
        with mock.patch.object(self.app.utils, 'HistoryDB', return_value=database), \
                mock.patch.object(self.app, 'iter_gallery_prompt_index_files', return_value=paths), \
                mock.patch.object(self.app, 'build_gallery_prompt_index_record', return_value={'prompt_text': 'hero'}):
            self.app.gallery_prompt_search_worker(job_id, 'hero', [], 'all')
        job = self.app.gallery_prompt_search_status(job_id)['job']
        self.assertTrue(job['done'])
        self.assertFalse(job['running'])
        self.assertFalse(job['cancelled'])
        self.assertFalse(job['cancel_requested'])
        self.assertEqual((job['total'], job['processed'], job['result']['total_matches']), (3, 3, 3))
        self.assertFalse(job['result'].get('partial'))
        database.close.assert_called_once()

    def test_cancelled_worker_reports_processed_count_after_throttled_progress(self):
        job_id = self.start_job()
        database = self.database()
        paths = [os.path.join(self.app.CLASSIFIED_DIR, f'synthetic-{index}.png') for index in range(160)]
        matches = 0
        reported_before_cancel = []

        def match(*_args):
            nonlocal matches
            matches += 1
            if matches == 5:
                reported_before_cancel.append(self.app.gallery_prompt_search_status(job_id)['job']['processed'])
                self.app.gallery_prompt_search_cancel(job_id)
            return True

        with mock.patch.object(self.app.utils, 'HistoryDB', return_value=database), \
                mock.patch.object(self.app, 'iter_gallery_prompt_index_files', return_value=paths), \
                mock.patch.object(self.app, 'build_gallery_prompt_index_record', return_value={'prompt_text': 'hero'}), \
                mock.patch.object(self.app.utils, 'gallery_prompt_search_matches', side_effect=match), \
                mock.patch.object(self.app.time, 'time', return_value=10):
            self.app.gallery_prompt_search_worker(job_id, 'hero', [], 'all')

        self.assertEqual(reported_before_cancel, [1])
        self.assert_cancelled(job_id)
        job = self.app.gallery_prompt_search_status(job_id)['job']
        self.assertEqual((job['total'], job['processed'], job['result']['total_matches']), (160, 5, 5))

    def test_cancel_after_database_query_does_not_start_fallback(self):
        job_id = self.start_job()
        database = self.database()

        def query(*_args):
            self.app.gallery_prompt_search_cancel(job_id)
            return []

        database.search_gallery_prompt_index.side_effect = query
        with mock.patch.object(self.app.utils, 'HistoryDB', return_value=database), \
                mock.patch.object(self.app, 'search_gallery_prompts_without_index') as fallback:
            self.app.gallery_prompt_search_worker(job_id, 'hero', [], 'all')
        fallback.assert_not_called()
        database.close.assert_called_once()
        self.assert_cancelled(job_id)

    def test_cancelled_fallback_publishes_collected_results_as_partial(self):
        job_id = self.start_job()
        database = self.database()

        def fallback(*_args, progress, cancel_event):
            progress(total=100, processed=25)
            self.app.gallery_prompt_search_cancel(job_id)
            self.assertTrue(cancel_event.is_set())
            self.app.update_gallery_prompt_search_job(job_id, message='late progress')
            return [{'rel_path': 'synthetic.png'}]

        with mock.patch.object(self.app.utils, 'HistoryDB', return_value=database), \
                mock.patch.object(self.app, 'search_gallery_prompts_without_index', side_effect=fallback):
            self.app.gallery_prompt_search_worker(job_id, 'hero', [], 'all')
        self.assert_cancelled(job_id)
        job = self.app.gallery_prompt_search_status(job_id)['job']
        self.assertEqual(job['processed'], 25)
        self.assertEqual(job['result']['image_paths'], ['synthetic.png'])
        self.assertEqual(job['result']['total_matches'], 1)
        self.assertFalse(job['result']['indexed'])

    def test_cancel_while_building_final_payload_wins_over_completion(self):
        job_id = self.start_job()
        database = self.database(indexed_images=1)

        def payload(_rows):
            self.app.gallery_prompt_search_cancel(job_id)
            return {'image_paths': ['synthetic.png'], 'total_matches': 1}

        with mock.patch.object(self.app.utils, 'HistoryDB', return_value=database), \
                mock.patch.object(self.app, 'build_gallery_prompt_search_payload', side_effect=payload):
            self.app.gallery_prompt_search_worker(job_id, 'hero', [], 'all')
        self.assert_cancelled(job_id)
        self.assertEqual(self.app.gallery_prompt_search_status(job_id)['job']['result']['image_paths'], ['synthetic.png'])

    def test_cancelled_exception_is_not_reported_as_failure(self):
        job_id = self.start_job()
        database = self.database()

        def query(*_args):
            self.app.gallery_prompt_search_cancel(job_id)
            raise RuntimeError('synthetic failure after cancel')

        database.search_gallery_prompt_index.side_effect = query
        with mock.patch.object(self.app.utils, 'HistoryDB', return_value=database):
            self.app.gallery_prompt_search_worker(job_id, 'hero', [], 'all')
        self.assert_cancelled(job_id)

    def test_completed_job_is_unchanged_by_cancel_or_late_updates(self):
        job_id = self.start_job()
        self.app.update_gallery_prompt_search_job(
            job_id, done=True, running=False, result={'total_matches': 1}, message='complete'
        )
        before = self.app.gallery_prompt_search_status(job_id)
        self.assertEqual(self.app.gallery_prompt_search_cancel(job_id), before)
        self.app.update_gallery_prompt_search_job(job_id, message='late progress')
        self.assertEqual(self.app.gallery_prompt_search_status(job_id), before)

    def test_repeated_cancel_and_missing_job(self):
        job_id = self.start_job()
        self.app.gallery_prompt_search_cancel(job_id)
        self.app.gallery_prompt_search_cancel(job_id)
        self.app.update_gallery_prompt_search_job(job_id, done=True)
        self.assert_cancelled(job_id)
        self.assertEqual(self.app.gallery_prompt_search_cancel('missing')[1], 404)
        self.assertEqual(self.app.gallery_prompt_search_status('missing')[1], 404)

    def test_public_snapshots_are_built_under_job_lock(self):
        job_id = self.start_job()
        original = self.app.public_gallery_prompt_search_job

        def snapshot(job):
            self.assertTrue(self.app.GALLERY_PROMPT_SEARCH_LOCK.locked())
            return original(job)

        with mock.patch.object(self.app, 'public_gallery_prompt_search_job', side_effect=snapshot):
            self.app.gallery_prompt_search_status(job_id)
            self.app.gallery_prompt_search_cancel(job_id)


if __name__ == '__main__':
    unittest.main()
