import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const worker = read('reader-cli/mirror_v5_r2.py');
const agent = read('reader-manager/reader_manager_agent.py');
const installer = read('reader-manager/installer.iss');

function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  try {
    const cmd = process.platform === 'win32' ? 'where.exe python' : 'which python || which python3';
    return execSync(cmd, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  } catch {
    return 'python';
  }
}

const pythonBin = resolvePython();

test('1. MP4 atom parser checks top-level box order and requires moov before mdat', () => {
  assert.match(worker, /def parse_mp4_atoms\(file_path\):/);
  assert.match(worker, /def check_moov_before_mdat\(file_path\):/);
  assert.match(worker, /moov_offset < mdat_offset/);
  assert.match(worker, /malformed_atom_size/);
  assert.match(worker, /atom_exceeds_file_size/);
});

test('2. Remux command uses strictly -c copy -movflags +faststart without transcoding', () => {
  assert.match(worker, /def remux_video_faststart\(input_path, output_path\):/);
  assert.match(worker, /"-c",\s*"copy"/);
  assert.match(worker, /"-movflags",\s*"\+faststart"/);
  // Verify no transcoding arguments
  assert.doesNotMatch(worker, /"-c:v"/);
  assert.doesNotMatch(worker, /"-c:a"/);
  assert.doesNotMatch(worker, /"-b:v"/);
  assert.doesNotMatch(worker, /"-crf"/);
});

test('3. Upload uses remux output path and verifies R2 HEAD matches output bytes', () => {
  assert.match(worker, /upload_path = remux_path/);
  assert.match(worker, /uploaded = upload_resumable\(upload_path,/);
  assert.match(worker, /actual_bytes = upload_bytes/);
  assert.match(worker, /if uploaded\["bytes"\] != actual_bytes:\s*\n\s*raise RuntimeError\(f"mirror_size_mismatch:\{uploaded\['bytes'\]\}\/\{actual_bytes\}"\)/);
});

test('4. Remux failure raises faststart_remux_failed and cleans up temp files in finally block', () => {
  assert.match(worker, /raise RuntimeError\("faststart_remux_failed:no_video_stream_in_source"\)/);
  assert.match(worker, /raise RuntimeError\(f"faststart_remux_failed:ffmpeg_exit_\{res\.returncode\}/);
  assert.match(worker, /raise RuntimeError\("faststart_remux_failed:output_missing"\)/);
  assert.match(worker, /raise RuntimeError\("faststart_remux_failed:output_empty"\)/);
  assert.match(worker, /raise RuntimeError\(f"faststart_remux_failed:\{moov_err\}"\)/);
  assert.match(worker, /finally:\s*\n\s*remux_path\.unlink\(missing_ok=True\)\s*\n\s*local_path\.unlink\(missing_ok=True\)/);
});

test('5. Non-video assets (photos, thumbnails, documents) bypass faststart remuxing', () => {
  assert.match(worker, /is_photo = \(/);
  assert.match(worker, /is_video = \(\s*not is_photo\s*and args\.media_variant != "thumbnail"/);
  assert.match(worker, /if is_video:/);
});

test('6. Reader version bumped to 1.3.2 across agent and installer', () => {
  assert.match(agent, /APP_VERSION = "1\.3\.2"/);
  assert.match(installer, /#define MyAppVersion "1\.3\.2"/);
});

function hasCommand(cmd) {
  try {
    const checkCmd = process.platform === 'win32' ? `where.exe ${cmd}` : `which ${cmd}`;
    execSync(checkCmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('7. Functional test: synthetic MP4 with end moov remuxes to moov_before_mdat with preserved codecs', (t) => {
  if (!hasCommand('ffmpeg') || !hasCommand('ffprobe')) {
    t.skip('ffmpeg or ffprobe not available in test runner');
    return;
  }
  const pyScript = `
import tempfile, subprocess, json, sys
from pathlib import Path
sys.path.insert(0, 'reader-cli')
from mirror_v5_r2 import parse_mp4_atoms, check_moov_before_mdat, remux_video_faststart, probe_media

with tempfile.TemporaryDirectory() as td:
    src = Path(td) / 'test_end_moov.mp4'
    out = Path(td) / 'test_faststart.mp4'
    # Generate MP4 with moov atom at end (-movflags -faststart)
    subprocess.run([
        'ffmpeg', '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=25',
        '-f', 'lavfi', '-i', 'sine=duration=1:frequency=440',
        '-c:v', 'libx264', '-c:a', 'aac',
        '-movflags', '-faststart',
        str(src)
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

    src_probe = probe_media(src)
    src_moov_ok, _ = check_moov_before_mdat(src)
    assert not src_moov_ok, "Source must have moov at end"

    out_size = remux_video_faststart(src, out)
    assert out.exists() and out_size > 0

    out_probe = probe_media(out)
    out_moov_ok, _ = check_moov_before_mdat(out)
    assert out_moov_ok, "Output must have moov before mdat"

    # Verify codecs preserved
    assert src_probe['streams'][0]['codec_name'] == out_probe['streams'][0]['codec_name']
    assert src_probe['streams'][1]['codec_name'] == out_probe['streams'][1]['codec_name']

    # Verify duration delta is negligible
    src_dur = float(src_probe['format']['duration'])
    out_dur = float(out_probe['format']['duration'])
    assert abs(src_dur - out_dur) < 0.1

    print(json.dumps({'ok': True, 'out_size': out_size, 'moov_before_mdat': True}))
`;
  const output = execFileSync(pythonBin, ['-c', pyScript], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  const result = JSON.parse(output.trim().split('\n').pop());
  assert.equal(result.ok, true);
  assert.equal(result.moov_before_mdat, true);
  assert.ok(result.out_size > 0);
});

test('8. Functional test: corrupted/non-video input fails with faststart_remux_failed', (t) => {
  if (!hasCommand('ffmpeg') || !hasCommand('ffprobe')) {
    t.skip('ffmpeg or ffprobe not available in test runner');
    return;
  }
  const pyScript = `
import tempfile, json, sys
from pathlib import Path
sys.path.insert(0, 'reader-cli')
from mirror_v5_r2 import remux_video_faststart

with tempfile.TemporaryDirectory() as td:
    bad_file = Path(td) / 'bad.mp4'
    bad_file.write_bytes(b'not a valid mp4 media stream')
    out = Path(td) / 'out.mp4'
    try:
        remux_video_faststart(bad_file, out)
        print(json.dumps({'ok': False, 'error': 'should_have_failed'}))
    except Exception as exc:
        print(json.dumps({'ok': True, 'error': str(exc)}))
`;
  const output = execFileSync(pythonBin, ['-c', pyScript], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  const result = JSON.parse(output.trim().split('\n').pop());
  assert.equal(result.ok, true);
  assert.match(result.error, /faststart_remux_failed/);
});
