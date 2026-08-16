import os
import tempfile
import unittest
from unittest import mock

import image_logic
import utils


class _Cp949Logger:
    """Simulate a Windows CP949 stream that rejects emoji log messages."""

    def __init__(self):
        self.messages = []

    def __call__(self, message):
        message = str(message)
        message.encode("cp949")
        self.messages.append(message)


class ImageLogicDeleteTests(unittest.TestCase):
    def test_delete_survives_cp949_log_encoding_failure(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_dir = os.path.join(temp_dir, "한글 폴더")
            os.makedirs(source_dir)
            source_path = os.path.join(source_dir, "삭제.png")
            with open(source_path, "wb") as image_file:
                image_file.write(b"not-an-image")

            db_path = os.path.join(temp_dir, "history.sqlite")
            real_history_db = utils.HistoryDB
            logger = _Cp949Logger()

            with mock.patch.object(
                utils,
                "HistoryDB",
                side_effect=lambda: real_history_db(db_path),
            ):
                image_logic.handle_integrated_tasks(
                    temp_dir,
                    {"deletes": ["한글 폴더/삭제.png"]},
                    log_func=logger,
                )

            self.assertFalse(os.path.exists(source_path))
            trash_files = []
            trash_root = os.path.join(temp_dir, "_TRASH")
            for root, _dirs, files in os.walk(trash_root):
                trash_files.extend(os.path.join(root, name) for name in files)
            self.assertEqual(len(trash_files), 1)
            self.assertTrue(trash_files[0].endswith("삭제.png"))


if __name__ == "__main__":
    unittest.main()
