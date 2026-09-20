import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = rel => readFileSync(path.join(repoRoot, rel), 'utf8');

const requirements = read('reader-cli/requirements.txt');
const buildScript = read('reader-manager/build.ps1');
const spec = read('reader-manager/YeuNauAnReader.spec');
const worker = read('reader-cli/mirror_v5_r2.py');
const agent = read('reader-manager/reader_manager_agent.py');
const installer = read('reader-manager/installer.iss');

function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
}

test('1. reader-cli/requirements.txt declares cryptg dependency', () => {
  assert.match(requirements, /^cryptg>=/m);
  assert.match(requirements, /^Telethon>=1\.36/m);
});

test('2. reader-manager/build.ps1 bundles cryptg into all worker executables', () => {
  assert.match(buildScript, /--hidden-import\s+cryptg\s+--name\s+YeuNauAnReaderMirror/);
  assert.match(buildScript, /--hidden-import\s+cryptg\s+--name\s+YeuNauAnReaderImport/);
  assert.match(buildScript, /--hidden-import\s+cryptg\s+--name\s+YeuNauAnReaderReconcile/);
});

test('3. reader-manager/YeuNauAnReader.spec includes cryptg in hiddenimports', () => {
  assert.match(spec, /hiddenimports\s*=\s*\[[^\]]*"cryptg"[^\]]*\]/);
});

test('4. mirror_v5_r2.py preserves strict sequential download and request size invariants', () => {
  // Request size strictly 512 KiB
  assert.match(worker, /DOWNLOAD_REQUEST_SIZE\s*=\s*512\s*\*\s*1024/);
  // Sequential iter_download with max_inflight=1
  assert.match(worker, /async\s+for\s+chunk\s+in\s+client\.iter_download\(\s*message\.media,\s*offset=existing,\s*request_size=DOWNLOAD_REQUEST_SIZE,/);
  // No parallel chunks or concurrent downloader tasks
  assert.doesNotMatch(worker, /asyncio\.gather\(\*\[client\.iter_download/);
  assert.doesNotMatch(worker, /worker_lanes/);
});

test('5. mirror_v5_r2.py reports crypto_backend across all telemetry branches', () => {
  assert.match(worker, /def detect_crypto_backend\(\)/);
  // Startup log
  assert.match(worker, /\[CRYPTO\] Telethon crypto backend:/);
  // Shortcircuit telemetry
  assert.match(worker, /"crypto_backend":\s*crypto_backend/);
  // Failure telemetry
  assert.match(worker, /"crypto_backend":\s*detect_crypto_backend\(\)/);
  // CLI --check-crypto flag
  assert.match(worker, /if "--check-crypto" in sys\.argv:/);
});

test('6. Reader Manager bumped to 1.4.11 and logs crypto backend at startup', () => {
  assert.match(agent, /APP_VERSION\s*=\s*"1\.4\.11"/);
  assert.match(installer, /#define MyAppVersion\s*"1\.4\.11"/);
  assert.match(agent, /Reader Manager \{APP_VERSION\} starting \(crypto_backend=\{detect_crypto_backend\(\)\}\)/);
});

test('7. Functional Python test: detect_crypto_backend and fallback behavior', () => {
  const pythonBin = resolvePython();
  const pyCode = `
import sys
from pathlib import Path
sys.path.insert(0, r'${path.join(repoRoot, 'reader-cli').replace(/\\/g, '/')}')

from mirror_v5_r2 import detect_crypto_backend

try:
    import telethon.crypto.aes as aes_mod
    has_telethon = True
except ImportError:
    has_telethon = False

if has_telethon:
    # 1. Normal detection
    backend = detect_crypto_backend()
    assert backend in ("cryptg", "pyaes", "libssl"), f"Unexpected backend: {backend}"

    # 2. Simulate cryptg missing -> fallback to pyaes or libssl
    orig_cryptg = getattr(aes_mod, "cryptg", None)
    orig_libssl = getattr(aes_mod, "libssl", None)

    try:
        aes_mod.cryptg = None
        if hasattr(aes_mod, "libssl") and aes_mod.libssl:
            aes_mod.libssl.decrypt_ige = None
        fallback = detect_crypto_backend()
        assert fallback == "pyaes", f"Expected pyaes fallback, got {fallback}"
    finally:
        aes_mod.cryptg = orig_cryptg
        if orig_libssl:
            aes_mod.libssl = orig_libssl
else:
    # Telethon not installed in CI runner python env
    backend = detect_crypto_backend()
    assert backend == "unknown", f"Expected unknown when telethon missing, got {backend}"

print("FUNCTIONAL_CRYPTO_DETECTOR_PASS")
`;

  const output = execFileSync(pythonBin, ['-c', pyCode], { encoding: 'utf8' });
  assert.match(output, /FUNCTIONAL_CRYPTO_DETECTOR_PASS/);
});

test('8. Functional CLI test: mirror_v5_r2.py --check-crypto', () => {
  const pythonBin = resolvePython();
  const scriptPath = path.join(repoRoot, 'reader-cli', 'mirror_v5_r2.py');
  const output = execFileSync(pythonBin, [scriptPath, '--check-crypto'], { encoding: 'utf8' });
  assert.match(output, /^CRYPTO_BACKEND=(cryptg|pyaes|libssl|unknown)$/m);
});
