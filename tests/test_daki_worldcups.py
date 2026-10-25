from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from flask import Flask

from naim.storage.daki_projects import DakiNotFoundError
from naim.storage.daki_worldcups import DakiWorldCups, DakiWorldCupConflict
from naim.web.daki_worldcups import register_daki_worldcup_routes


def tournament_request(count=5, **changes):
    participants = [{'path': f'gallery/{index}.png', 'name': f'Synthetic {index}'} for index in range(count)]
    round_paths = [entry['path'] for entry in participants]
    choices = []
    while len(round_paths) > 1:
        winners = []
        for index in range(0, len(round_paths) - 1, 2):
            choices.append(round_paths[index])
            winners.append(round_paths[index])
        if len(round_paths) % 2:
            winners.append(round_paths[-1])
        round_paths = winners
    return {'id': '1' * 32, 'title': 'Synthetic tagged cup', 'gallery_key': 'shared:all',
            'tag': {'id': 'synthetic-tag', 'label': 'Synthetic favorites'},
            'participants': participants, 'choices': choices, **changes}


class DakiWorldCupsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / 'worldcups'
        self.store = DakiWorldCups(lambda: self.root)

    @unittest.skipUnless(os.name == 'nt', 'Windows path aliases only')
    def test_record_path_accepts_extended_resolve_alias(self):
        root = self.root.resolve()
        identifier = '1' * 32
        original_resolve = Path.resolve

        def extended_alias(path, *args, **kwargs):
            resolved = original_resolve(path, *args, **kwargs)
            if path.name != identifier + '.json':
                return resolved
            value = str(resolved)
            if value.startswith('\\\\?\\'):
                return resolved
            if value.startswith('\\\\'):
                return Path('\\\\?\\UNC\\' + value[2:])
            return Path('\\\\?\\' + value)

        with mock.patch.object(Path, 'resolve', extended_alias):
            self.assertEqual(self.store._path(root, identifier), root / (identifier + '.json'))

    def test_even_bracket_shared_ranks_and_actual_match_wins(self):
        record = self.store.create(tournament_request(8))
        by_path = {entry['path']: entry for entry in record['participants']}
        ranks = [by_path[f'gallery/{index}.png']['rank'] for index in range(8)]
        self.assertEqual(ranks, [1, 5, 3, 5, 2, 5, 3, 5])
        wins = [by_path[f'gallery/{index}.png']['wins'] for index in range(8)]
        self.assertEqual(wins, [3, 0, 1, 0, 2, 0, 1, 0])
        self.assertEqual([item['path'] for item in record['participants'] if item['rank'] == 5],
                         ['gallery/1.png', 'gallery/3.png', 'gallery/5.png', 'gallery/7.png'])
        self.assertEqual(record['winner']['rank'], 1)
        self.assertEqual(record['winner']['path'], 'gallery/0.png')

    def test_odd_bracket_last_entry_byes_do_not_count_as_wins(self):
        data = tournament_request(5)
        data['choices'][-1] = 'gallery/4.png'
        record = self.store.create(data)
        self.assertEqual([entry['rank'] for entry in record['participants']], [1, 2, 3, 4, 4])
        self.assertEqual([entry['path'] for entry in record['participants']],
                         ['gallery/4.png', 'gallery/0.png', 'gallery/2.png', 'gallery/1.png', 'gallery/3.png'])
        self.assertEqual(record['participants'][0]['wins'], 1)
        self.assertEqual(record['participants'][1]['wins'], 2)
        self.assertEqual(record['initial_participants'], data['participants'])

    def test_two_and_three_entry_brackets_terminate_with_one_winner(self):
        for count in (2, 3):
            with self.subTest(count=count):
                record = self.store.create(tournament_request(count, id=str(count) * 32))
                self.assertEqual(record['total'], count)
                self.assertEqual(len(record['choices']), count - 1)
                self.assertEqual([item['rank'] for item in record['participants']], list(range(1, count + 1)))

    def test_incomplete_extra_and_impossible_choices_are_rejected_without_files(self):
        for change in ('incomplete', 'extra', 'outsider', 'eliminated'):
            data = tournament_request(5)
            if change == 'incomplete':
                data['choices'].pop()
            elif change == 'extra':
                data['choices'].append(data['choices'][-1])
            elif change == 'outsider':
                data['choices'][0] = 'other.png'
            else:
                data['choices'][-1] = 'gallery/1.png'
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.store.create(data)
            self.assertFalse(self.root.exists())

    def test_undo_replacement_choices_replay_only_the_final_match_history(self):
        data = tournament_request(4)
        # The second choice was undone: its replacement wins the second match.
        data['choices'] = ['gallery/0.png', 'gallery/3.png', 'gallery/3.png']
        record = self.store.create(data)
        self.assertEqual(record['winner']['path'], 'gallery/3.png')
        self.assertEqual(record['participants'][0]['wins'], 2)
        self.assertEqual(record['choices'], data['choices'])

    def test_idempotent_retry_is_immutable_and_conflicting_retry_fails(self):
        data = tournament_request()
        first = self.store.create(data)
        path = self.root / (data['id'] + '.json')
        original = path.read_bytes()
        self.assertEqual(self.store.create(deepcopy(data)), first)
        self.assertEqual(path.read_bytes(), original)
        for changes in ({'title': 'Different title'}, {'gallery_key': 'personal'},
                        {'tag': {'id': 'new', 'label': 'New tag'}}):
            with self.subTest(changes=changes), self.assertRaises(DakiWorldCupConflict):
                self.store.create({**data, **changes})
            self.assertEqual(path.read_bytes(), original)

    def test_concurrent_duplicate_requests_publish_one_record(self):
        data = tournament_request()
        stores = [DakiWorldCups(self.root) for _ in range(8)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            records = list(pool.map(lambda store: store.create(data), stores))
        self.assertTrue(all(record == records[0] for record in records))
        self.assertEqual(len(list(self.root.glob('*.json'))), 1)
        self.assertEqual(len(self.store.list_records()), 1)

    def test_saved_history_survives_restart_without_any_image_files(self):
        record = self.store.create(tournament_request())
        restarted = DakiWorldCups(self.root)
        self.assertEqual(restarted.get(record['id']), record)
        self.assertEqual(len(restarted.list_records()[0]['winner']), 4)
        self.assertFalse((self.root.parent / 'gallery').exists())
        record['participants'][0]['name'] = 'modified returned object'
        self.assertNotEqual(restarted.get(record['id'])['participants'][0]['name'], record['participants'][0]['name'])

    def test_list_exact_gallery_filter_newest_first_and_replay_keeps_parent(self):
        first = self.store.create(tournament_request(id='1' * 32, gallery_key='shared:all'))
        self.store.create(tournament_request(id='2' * 32, gallery_key='shared:all2'))
        replay = self.store.create(tournament_request(id='3' * 32, gallery_key='shared:all', replay_of=first['id']))
        records = self.store.list_records('shared:all')
        self.assertEqual([record['id'] for record in records], ['3' * 32, '1' * 32])
        self.assertEqual(records[0]['replay_of'], first['id'])
        self.assertEqual(self.store.get(first['id']), first)
        self.assertEqual(replay['initial_participants'], first['initial_participants'])
        self.assertNotIn('participants', records[0])
        self.assertEqual(set(records[0]), {'id', 'title', 'gallery_key', 'tag', 'created_at', 'total', 'winner', 'replay_of'})
        self.assertEqual(self.store.list_records('shared'), [])

    def test_safe_image_urls_are_derived_instead_of_accepting_arbitrary_urls(self):
        data = tournament_request(2)
        path = 'folder/literal%2F#plus+ 한글.png'
        data['participants'][0].update(path=path, src='https://outside.invalid/secret', rank=-9, wins=900)
        data['choices'] = [path]
        record = self.store.create(data)
        self.assertEqual(record['winner']['src'], '/image/folder/literal%252F%23plus%2B%20%ED%95%9C%EA%B8%80.png')
        self.assertEqual(record['winner']['rank'], 1)
        self.assertEqual(record['participants'][0]['wins'], 1)
        self.assertNotIn('outside.invalid', (self.root / (data['id'] + '.json')).read_text(encoding='utf-8'))

    def test_unsafe_duplicate_and_malformed_reserved_paths_are_rejected(self):
        for path in ('../outside.png', '/outside.png', 'C:/outside.png',
                     'https://outside.invalid/image.png', '__daki_personal__/wrong.png',
                     '__daki_tests__/invalid/style.png', 'notes.txt'):
            data = tournament_request(2)
            data['participants'][0]['path'] = path
            data['choices'] = [path]
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.store.create(data)
        data = tournament_request(2)
        data['participants'][1]['path'] = 'gallery\\0.png'
        with self.assertRaises(ValueError):
            self.store.create(data)
        self.assertFalse(self.root.exists())

    def test_known_virtual_paths_are_saved_without_resolving_originals(self):
        data = tournament_request(3)
        paths = ['__daki_shared__/sample.png', '__daki_tests__/' + 'a' * 32 + '/sample.png',
                 '__daki_personal__/personal_' + 'b' * 32 + '.png']
        for participant, path in zip(data['participants'], paths):
            participant['path'] = path
        data['choices'] = [paths[0], paths[2]]
        record = self.store.create(data)
        self.assertEqual(record['winner']['path'], paths[2])

    def test_validation_rejects_invalid_metadata_and_oversized_participant_lists(self):
        for change in ({'id': '../bad'}, {'title': ''}, {'title': 'x' * 241},
                       {'gallery_key': 'x' * 201}, {'tag': None}, {'tag': {'id': 'NONE', 'label': 'None'}},
                       {'participants': []}, {'participants': [{}] * 10001}, {'replay_of': 'bad'},
                       {'replay_of': '1' * 32}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.store.create(tournament_request(**change))
        self.assertFalse(self.root.exists())

    def test_corrupt_record_is_never_overwritten_by_retry(self):
        data = tournament_request()
        self.root.mkdir()
        path = self.root / (data['id'] + '.json')
        for text in ('{broken', '{"version":1,"request":{}}'):
            path.write_text(text, encoding='utf-8')
            for operation in (lambda: self.store.get(data['id']), self.store.list_records,
                              lambda: self.store.create(data)):
                with self.assertRaises(ValueError):
                    operation()
                self.assertEqual(path.read_text(encoding='utf-8'), text)

    def test_missing_records_and_empty_listing_do_not_create_directories(self):
        self.assertEqual(self.store.list_records(), [])
        with self.assertRaises(DakiNotFoundError):
            self.store.get('0' * 32)
        self.assertFalse(self.root.exists())

    def test_resolved_record_path_cannot_escape_storage_root(self):
        original = Path.resolve
        def outside(path, *args, **kwargs):
            return self.root.parent / path.name if path.suffix == '.json' else original(path, *args, **kwargs)
        with mock.patch.object(Path, 'resolve', outside), self.assertRaises(ValueError):
            self.store.create(tournament_request())
        self.assertFalse(self.root.exists())


class DakiWorldCupsApiTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / 'worldcups'
        self.store = DakiWorldCups(self.root)
        app = Flask(__name__)
        register_daki_worldcup_routes(app, self.store)
        self.client = app.test_client()

    def test_save_list_filter_detail_and_retry_contract(self):
        data = tournament_request()
        root = '/api/daki/worldcups'
        response = self.client.post(root, json=data)
        self.assertEqual(response.status_code, 201, response.json)
        record = response.json['record']
        self.assertEqual(self.client.post(root, json=data).json['record'], record)
        detail = self.client.get(root + '/' + data['id'])
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json['record'], record)
        records = self.client.get(root, query_string={'gallery_key': 'shared:all'}).json['records']
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['winner'], record['winner'])
        self.assertEqual(self.client.get(root, query_string={'gallery_key': 'shared'}).json['records'], [])
        response = self.client.post(root, json={**data, 'title': 'Different'})
        self.assertEqual(response.status_code, 409, response.json)

    def test_invalid_partial_missing_and_storage_errors_are_safe_json(self):
        root = '/api/daki/worldcups'
        for data in (None, [], {}, tournament_request(choices=[])):
            response = self.client.post(root, json=data)
            self.assertEqual(response.status_code, 400, response.json)
        self.assertEqual(self.client.get(root + '/' + '0' * 32).status_code, 404)
        self.assertEqual(self.client.get(root + '/invalid').status_code, 400)
        with mock.patch.object(self.store, 'create', side_effect=OSError(str(self.root))):
            response = self.client.post(root, json=tournament_request())
        self.assertEqual(response.status_code, 500)
        self.assertNotIn(str(self.root), response.get_data(as_text=True))


if __name__ == '__main__':
    unittest.main()
