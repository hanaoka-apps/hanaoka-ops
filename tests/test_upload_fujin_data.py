import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[1]
requests_stub = types.ModuleType("requests")
requests_stub.utils = types.SimpleNamespace(quote=quote)
requests_stub.post = Mock()
requests_stub.put = Mock()
requests_stub.get = Mock()
sys.modules.setdefault("requests", requests_stub)
SPEC = importlib.util.spec_from_file_location("upload_fujin_data", ROOT / "scripts/upload_fujin_data.py")
UPLOAD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPLOAD)


class LargeUploadTests(unittest.TestCase):
    def test_production_results_is_only_a_protected_upload_target(self):
        matching = [path for path, remote in UPLOAD.TARGETS
                    if remote == "value_analysis_production_results.json"]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0].parent.name, "data")

    def test_large_file_uses_upload_session_and_sequential_ranges(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "fixture.json"
            path.write_bytes(b"x" * 700_000)
            first = Mock()
            first.status_code = 202
            second = Mock()
            second.status_code = 202
            last = Mock()
            last.status_code = 201
            last.json.return_value = {"size": 700_000}
            session = Mock()
            session.json.return_value = {"uploadUrl": "https://example.invalid/preauthenticated"}
            with patch.object(UPLOAD, "UPLOAD_SESSION_THRESHOLD", 1), \
                 patch.object(UPLOAD, "UPLOAD_CHUNK_SIZE", 327_680), \
                 patch.object(UPLOAD.requests, "post", return_value=session) as post, \
                 patch.object(UPLOAD.requests, "put", side_effect=[first, second, last]) as put:
                UPLOAD.upload_file("fake-token", path, "fixture.json")

            self.assertEqual(post.call_count, 1)
            self.assertEqual(put.call_count, 3)
            sent_ranges = [call.kwargs["headers"]["Content-Range"] for call in put.call_args_list]
            self.assertEqual(sent_ranges, [
                "bytes 0-327679/700000",
                "bytes 327680-655359/700000",
                "bytes 655360-699999/700000",
            ])
            self.assertTrue(all("Authorization" not in call.kwargs["headers"] for call in put.call_args_list))

    def test_final_accepted_fragment_does_not_count_as_completed_upload(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "fixture.json"
            path.write_bytes(b"x" * 700_000)
            session = Mock()
            session.json.return_value = {"uploadUrl": "https://example.invalid/preauthenticated"}
            pending = Mock(status_code=202)
            with patch.object(UPLOAD, "UPLOAD_CHUNK_SIZE", 327_680), \
                 patch.object(UPLOAD.requests, "post", return_value=session), \
                 patch.object(UPLOAD.requests, "put", return_value=pending):
                with self.assertRaisesRegex(RuntimeError, "確定していません"):
                    UPLOAD.upload_large_file("fake-token", path, "fixture.json", "fixture.json", 700_000)

    def test_readback_rejects_truncated_protected_file(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "value_analysis.json"
            path.write_bytes(b'{"ok":true}')
            response = Mock()
            response.iter_content.return_value = iter([b'{"ok":'])
            with patch.object(UPLOAD.requests, "get", return_value=response):
                with self.assertRaisesRegex(RuntimeError, "一致しません"):
                    UPLOAD.verify_uploaded_file("fake-token", path, "https://example.invalid/content", path.stat().st_size)
            response.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
