import json
from contextlib import closing
from datetime import datetime
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests

from naim.storage.shared_library_store import SharedLibraryStore
from naim.style_manager import arca_style_collector as collector
from naim.style_manager import naim_shared_library


class _StoreCatalog:
    def __init__(self, path):
        self.store = SharedLibraryStore(path)

    def public_records(self, include_excluded=False):
        records = self.store.list_records(include_excluded=include_excluded)
        sources = self.store.public_sources([record["id"] for record in records])
        for record in records:
            record["sources"] = [
                {key: value for key, value in json.loads(row["source_json"]).items()
                 if not key.startswith("_")}
                for row in sources.get(record["id"], [])
            ]
        return records


class SharedLibraryStatsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.db_path = self.root / "artist_rater.sqlite"
        collector.init_arca_style_tables(self.db_path)
        self.addCleanup(naim_shared_library.configure, None)

    @staticmethod
    def _style(model, source_url, *source_urls):
        return {
            "id": "common-0123456789abcdef01234567",
            "model": model,
            "source_url": source_url,
            "sources": [{"source_url": value} for value in source_urls],
        }

    def _local_item(self, source_url, *, model="nai-diffusion-5-full", recommendations=11, views=22):
        now = datetime.now().isoformat()
        model_id, model_family = "nai-diffusion-5-full", "v5"
        if model == "nai-diffusion-4-5-full":
            model_id, model_family = "nai-diffusion-4-5-full", "v4.5"
        with closing(collector._connect(self.db_path)) as conn, conn:
            item_id = conn.execute(
                "INSERT INTO arca_style_items(source_url,board_tab,collected_at,updated_at,model,model_id,model_family,"
                "recommendation_count,view_count) VALUES(?,?,?,?,?,?,?,?,?)",
                (source_url, "NAI", now, now, model, model_id, model_family, recommendations, views),
            ).lastrowid
            conn.execute(
                "INSERT INTO arca_style_images(item_id,image_url,created_at,model,model_id,model_family) "
                "VALUES(?,?,?,?,?,?)",
                (item_id, "https://ac.namu.la/test.png", now, model, model_id, model_family),
            )
        return item_id

    def _real_catalog(self, source_url, *, count=24, collected_at="2026-01-01T00:00:00+00:00"):
        catalog = _StoreCatalog(self.root / "shared.sqlite")
        key = ("shared", "nai-diffusion-5-full", ("style", ("watercolor",)))
        catalog.store.ingest([{
            "key": key,
            "record": {
                "id": "discarded",
                "name": "Synthetic shared style",
                "model": "nai-diffusion-5-full",
                "positive": "watercolor",
                "negative": "",
                "recommendation_count": count,
                "recommendation_collected_at": collected_at,
                "source_url": source_url,
            },
            "origin": "naim",
            "source_id": "synthetic-shared-source",
            "source": {"origin": "naim", "source_url": source_url},
        }])
        naim_shared_library.configure(catalog)
        return catalog

    def _create_stats_job(self, model="all"):
        job_id, items = collector.create_stats_refresh_job(self.db_path, model=model)
        return job_id, items

    def _run_with_response(self, job_id, items, statistics):
        session, list_session = Mock(), Mock()
        with (
            patch.object(collector, "_stats_refresh_searches", return_value=[]),
            patch.object(collector, "create_arca_session", return_value=session),
            patch.object(collector, "_clone_arca_session", return_value=list_session),
            patch.object(collector, "fetch_html", return_value="synthetic html") as fetch,
            patch.object(collector, "_with_transient_retries", side_effect=lambda callback, *args, **kwargs: callback()),
            patch.object(collector, "extract_article_statistics", return_value=statistics),
        ):
            result = collector.refresh_arca_style_stats(self.db_path, job_id, items)
        return result, fetch, list_session

    def test_common_only_targets_use_synthetic_ids_and_model_filter(self):
        r18_url = "https://arca.live/b/aiart/101?tab=/R18_NAI/"
        shared_url = "https://arca.live/b/aiart/102"
        other_url = "https://arca.live/b/aiart/103"
        catalog = SimpleNamespace(
            public_records=Mock(return_value=[
                self._style("nai-diffusion-5-full", r18_url, r18_url, shared_url),
                self._style("nai-diffusion-4-5-full", other_url),
            ]),
            store=Mock(),
        )
        naim_shared_library.configure(catalog)

        all_items = collector._stats_refresh_items(self.db_path, "all")
        v5_items = collector._stats_refresh_items(self.db_path, "v5")
        v45_items = collector._stats_refresh_items(self.db_path, "nai-diffusion-4-5-full")

        self.assertEqual({item["source_url"] for item in all_items}, {
            "https://arca.live/b/aiart/101", shared_url, other_url,
        })
        self.assertEqual({item["id"] for item in v5_items}, {
            "shared:https://arca.live/b/aiart/101", "shared:" + shared_url,
        })
        self.assertEqual(v5_items[0]["board_tab"], "R18_NAI")
        self.assertTrue(all(item["common_only"] for item in all_items))
        self.assertEqual([item["source_url"] for item in v45_items], [other_url])
        catalog.public_records.assert_called_with(include_excluded=False)
        self.assertEqual(catalog.store.list_records.call_count, 0)
        with closing(collector._connect(self.db_path)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM arca_style_items").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM arca_style_images").fetchone()[0], 0)

    def test_local_and_common_same_url_fetch_once_and_update_both(self):
        source_url = "https://arca.live/b/aiart/211"
        local_id = self._local_item(source_url, recommendations=31, views=42)
        store = Mock()
        store.update_recommendations.return_value = 1
        catalog = SimpleNamespace(
            public_records=Mock(return_value=[self._style("nai-diffusion-5-full", source_url)]),
            store=store,
        )
        naim_shared_library.configure(catalog)

        job_id, items = self._create_stats_job("v5")
        result, fetch, list_session = self._run_with_response(
            job_id, items, {"recommendation_count": 0, "view_count": 53},
        )

        self.assertEqual([item["id"] for item in items], [local_id])
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(result, {"updated": 1, "failed_posts": 0, "skipped_existing": False})
        self.assertEqual(store.update_recommendations.call_count, 1)
        updated_url, recommendation_count, collected_at = store.update_recommendations.call_args.args
        self.assertEqual((updated_url, recommendation_count), (source_url, 0))
        self.assertIn(".", collected_at)
        with closing(collector._connect(self.db_path)) as conn:
            row = conn.execute(
                "SELECT recommendation_count,view_count,updated_at FROM arca_style_items WHERE id=?",
                (local_id,),
            ).fetchone()
        self.assertEqual(tuple(row[:2]), (0, 53))
        self.assertEqual(row["updated_at"], collected_at)
        job = collector.get_collection_job(self.db_path, job_id)
        self.assertEqual(job["total_posts"], 1)
        self.assertEqual(job["scanned_posts"], 1)
        self.assertEqual(job["updated"], 1)
        list_session.close.assert_called_once()

    def test_shared_store_accepts_zero_and_decreasing_latest_counts_and_clears_cache(self):
        source_url = "https://arca.live/b/aiart/311"
        catalog = self._real_catalog(source_url, count=28)
        self.assertEqual(naim_shared_library.list_styles()[0]["recommendation_count"], 28)

        self.assertEqual(naim_shared_library.update_recommendations(source_url, 7, "2026-01-02T00:00:00+00:00"), 1)
        self.assertEqual(naim_shared_library.update_recommendations(source_url, 0, "2026-01-03T00:00:00+00:00"), 1)

        latest = naim_shared_library.list_styles()[0]
        self.assertEqual(latest["recommendation_count"], 0)
        self.assertEqual(latest["recommendation_collected_at"], "2026-01-03T00:00:00+00:00")
        self.assertIs(catalog.store, naim_shared_library._configured_catalog().store)

    def test_unknown_recommendation_does_not_erase_shared_value(self):
        source_url = "https://arca.live/b/aiart/411"
        catalog = self._real_catalog(source_url, count=19)
        job_id, items = self._create_stats_job()

        result, fetch, _ = self._run_with_response(
            job_id, items, {"recommendation_count": None, "view_count": None},
        )

        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(result["updated"], 0)
        self.assertEqual(result["failed_posts"], 1)
        self.assertEqual(catalog.store.list_records()[0]["recommendation_count"], 19)

    def test_stop_and_failure_preserve_previous_shared_values(self):
        for suffix, control_error, expected_status in (
            ("501", collector.ArcaCollectionStopped("stopped"), "stopped"),
            ("502", requests.Timeout("timeout"), "failed"),
        ):
            with self.subTest(status=expected_status):
                source_url = f"https://arca.live/b/aiart/{suffix}"
                catalog = self._real_catalog(source_url, count=23)
                local_id = self._local_item(source_url, recommendations=29, views=37)
                job_id, items = self._create_stats_job()
                session, list_session = Mock(), Mock()
                with (
                    patch.object(collector, "_stats_refresh_searches", return_value=[]),
                    patch.object(collector, "create_arca_session", return_value=session),
                    patch.object(collector, "_clone_arca_session", return_value=list_session),
                    patch.object(collector, "_wait_for_collection_control", side_effect=control_error),
                ):
                    if expected_status == "failed":
                        with patch.object(collector, "_wait_for_collection_control", return_value=None), \
                                patch.object(collector, "fetch_html", side_effect=control_error), \
                                patch.object(collector, "_with_transient_retries", side_effect=control_error):
                            collector._run_stats_refresh_job(self.db_path, job_id, items)
                    else:
                        collector._run_stats_refresh_job(self.db_path, job_id, items)

                self.assertEqual(collector.get_collection_job(self.db_path, job_id)["status"], expected_status)
                self.assertEqual(catalog.store.list_records()[0]["recommendation_count"], 23)
                with closing(collector._connect(self.db_path)) as conn:
                    row = conn.execute(
                        "SELECT recommendation_count,view_count FROM arca_style_items WHERE id=?",
                        (local_id,),
                    ).fetchone()
                self.assertEqual(tuple(row), (29, 37))
                list_session.close.assert_called_once()

    def test_start_reuses_same_active_stats_job(self):
        job_id, _ = self._create_stats_job("v5")

        with patch.object(collector, "Thread") as thread:
            reused = collector.start_stats_refresh_job(self.db_path, "5")

        self.assertEqual(reused, job_id)
        thread.assert_not_called()
        with closing(collector._connect(self.db_path)) as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM arca_collection_jobs WHERE job_type='stats_refresh'",
            ).fetchone()[0]
        self.assertEqual(count, 1)

    def test_start_initializes_a_fresh_database_before_active_job_lookup(self):
        fresh_db = self.root / "fresh-start.sqlite"

        with patch.object(collector, "Thread") as thread:
            job_id = collector.start_stats_refresh_job(fresh_db)
        self.addCleanup(collector._remove_collection_control, job_id)

        self.assertEqual(collector.get_collection_job(fresh_db, job_id)["status"], "queued")
        thread.assert_called_once()


if __name__ == "__main__":
    unittest.main()
