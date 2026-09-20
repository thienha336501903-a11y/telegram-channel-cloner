"""Tests for native crypto backend detection, fallback behavior, and invariants."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "reader-manager"))
sys.path.insert(0, str(ROOT / "reader-cli"))

import reader_manager_agent as agent
import mirror_v5_r2 as mirror


class CryptoBackendDetectionTests(unittest.TestCase):
    def test_version_bumped(self):
        self.assertEqual(agent.APP_VERSION, "1.4.11")

    def test_download_request_size_invariant(self):
        self.assertEqual(mirror.DOWNLOAD_REQUEST_SIZE, 512 * 1024)

    def test_detect_backend_returns_valid_string(self):
        backend = mirror.detect_crypto_backend()
        self.assertIn(backend, ("cryptg", "pyaes", "libssl"))

    def test_agent_detect_backend_matches_mirror(self):
        self.assertEqual(agent.detect_crypto_backend(), mirror.detect_crypto_backend())

    def test_fallback_to_pyaes_when_cryptg_and_libssl_absent(self):
        import telethon.crypto.aes as aes_mod
        orig_cryptg = getattr(aes_mod, "cryptg", None)
        orig_libssl = getattr(aes_mod, "libssl", None)
        try:
            aes_mod.cryptg = None
            if hasattr(aes_mod, "libssl") and aes_mod.libssl:
                aes_mod.libssl.decrypt_ige = None
            self.assertEqual(mirror.detect_crypto_backend(), "pyaes")
            self.assertEqual(agent.detect_crypto_backend(), "pyaes")
        finally:
            aes_mod.cryptg = orig_cryptg
            if orig_libssl:
                aes_mod.libssl = orig_libssl

    def test_reports_cryptg_when_cryptg_present(self):
        import telethon.crypto.aes as aes_mod
        orig_cryptg = getattr(aes_mod, "cryptg", None)
        try:
            aes_mod.cryptg = SimpleNamespace(decrypt_ige=lambda *args: b"mock")
            self.assertEqual(mirror.detect_crypto_backend(), "cryptg")
            self.assertEqual(agent.detect_crypto_backend(), "cryptg")
        finally:
            aes_mod.cryptg = orig_cryptg

    def test_reports_libssl_when_only_libssl_present(self):
        import telethon.crypto.aes as aes_mod
        orig_cryptg = getattr(aes_mod, "cryptg", None)
        orig_libssl = getattr(aes_mod, "libssl", None)
        try:
            aes_mod.cryptg = None
            mock_libssl = SimpleNamespace(decrypt_ige=lambda *args: b"mock")
            aes_mod.libssl = mock_libssl
            self.assertEqual(mirror.detect_crypto_backend(), "libssl")
            self.assertEqual(agent.detect_crypto_backend(), "libssl")
        finally:
            aes_mod.cryptg = orig_cryptg
            aes_mod.libssl = orig_libssl


if __name__ == "__main__":
    unittest.main()
