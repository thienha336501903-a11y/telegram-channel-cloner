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

test('2. Remux command uses strictly -c copy -movflags +faststart -f mp4 without transcoding', () => {
  assert.match(worker, /def remux_video_faststart\(input_path, output_path\):/);
  assert.match(worker, /"-c",\s*"copy"/);
  assert.match(worker, /"-movflags",\s*"\+faststart"/);
  assert.match(worker, /"-f",\s*"mp4"/);
  assert.doesNotMatch(worker, /"-c:v"/);
  assert.doesNotMatch(worker, /"-c:a"/);
  assert.doesNotMatch(worker, /"-b:v"/);
  assert.doesNotMatch(worker, /"-crf"/);
});

test('3. Upload uses remux output and verifies final R2 bytes', () => {
  assert.match(worker, /upload_path = remux_path/);
  assert.match(worker, /uploaded = upload_resumable\([\s\S]*?upload_path,[\s\S]*?args\.object_key/);
  assert.match(worker, /actual_bytes = upload_bytes/);
  assert.match(worker, /if uploaded\["bytes"\] != actual_bytes:\s*\n\s*raise RuntimeError\(f"mirror_size_mismatch:/);
});

test('4. Faststart fails closed but failed jobs preserve cache for a retry', () => {
  assert.match(worker, /raise RuntimeError\("faststart_remux_failed:no_video_stream_in_source"\)/);
  assert.match(worker, /raise RuntimeError\(f"faststart_remux_failed:ffmpeg_exit_\{res\.returncode\}/);
  assert.match(worker, /raise RuntimeError\("faststart_remux_failed:output_missing"\)/);
  assert.match(worker, /raise RuntimeError\("faststart_remux_failed:output_empty"\)/);
  assert.match(worker, /raise RuntimeError\(f"faststart_remux_failed:\{moov_error\}"\)/);
  assert.match(worker, /finally:[\s\S]*?if success:[\s\S]*?remux_path\.unlink\(missing_ok=True\)[\s\S]*?local_path\.unlink\(missing_ok=True\)/);
  assert.match(worker, /if validate_faststart_cache\(local_path, remux_path\):[\s\S]*?faststart_reused/);
});

test('5. Non-video assets bypass faststart', () => {
  assert.match(worker, /is_photo = \(/);
  assert.match(worker, /is_video = \(\s*not is_photo\s*and args\.media_variant != "thumbnail"/);
  assert.match(worker, /if is_video:/);
});

test('6. Reader version is 1.4.0 across agent and installer', () => {
  assert.match(agent, /APP_VERSION = "1\.4\.0"/);
  assert.match(installer, /#define MyAppVersion "1\.4\.0"/);
});

test('7. Installer packages bundled ffmpeg.exe and ffprobe.exe to {app}\\bin', () => {
  assert.match(installer, /Source: "bin\\ffmpeg\.exe"; DestDir: "\{app\}\\bin"; Flags: ignoreversion/);
  assert.match(installer, /Source: "bin\\ffprobe\.exe"; DestDir: "\{app\}\\bin"; Flags: ignoreversion/);
});

test('8. Binary resolver prioritizes bundled bin and fails closed with faststart_dependency_missing', () => {
  assert.match(worker, /def resolve_binary\(name\):/);
  assert.match(worker, /def get_ffmpeg_bin\(\):/);
  assert.match(worker, /def get_ffprobe_bin\(\):/);
  assert.match(worker, /faststart_dependency_missing/);
  assert.match(worker, /sys\.executable/);
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

test('9. Functional: synthetic MP4 remuxes to .faststart.part with moov before mdat and preserved codecs', (t) => {
  if (!hasCommand('ffmpeg') || !hasCommand('ffprobe')) {
    t.skip('ffmpeg or ffprobe not available in test runner');
    return;
  }
  const pyScript = `
import tempfile, subprocess, json, sys
from pathlib import Path
sys.path.insert(0, 'reader-cli')
from mirror_v5_r2 import check_moov_before_mdat, remux_video_faststart, probe_media

with tempfile.TemporaryDirectory() as td:
    src = Path(td) / 'test_end_moov.mp4'
    out_part = Path(td) / 'test_asset_123-video.faststart.part'
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
    assert not src_moov_ok
    out_size = remux_video_faststart(src, out_part)
    assert out_part.exists() and out_size > 0
    out_probe = probe_media(out_part)
    out_moov_ok, _ = check_moov_before_mdat(out_part)
    assert out_moov_ok
    assert src_probe['streams'][0]['codec_name'] == out_probe['streams'][0]['codec_name']
    assert src_probe['streams'][1]['codec_name'] == out_probe['streams'][1]['codec_name']
    src_dur = float(src_probe['format']['duration'])
    out_dur = float(out_probe['format']['duration'])
    assert abs(src_dur - out_dur) < 0.1
    print(json.dumps({'ok': True, 'out_size': out_size, 'moov_before_mdat': True}))
`;
  const output = execFileSync(pythonBin, ['-c', pyScript], { cwd: repoRoot, encoding: 'utf8' });
  const result = JSON.parse(output.trim().split('\n').pop());
  assert.equal(result.ok, true);
  assert.equal(result.moov_before_mdat, true);
  assert.ok(result.out_size > 0);
});

test('10. Functional: corrupted/non-video input fails with faststart_remux_failed', (t) => {
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
    out = Path(td) / 'out.faststart.part'
    try:
        remux_video_faststart(bad_file, out)
        print(json.dumps({'ok': False, 'error': 'should_have_failed'}))
    except Exception as exc:
        print(json.dumps({'ok': True, 'error': str(exc)}))
`;
  const output = execFileSync(pythonBin, ['-c', pyScript], { cwd: repoRoot, encoding: 'utf8' });
  const result = JSON.parse(output.trim().split('\n').pop());
  assert.equal(result.ok, true);
  assert.match(result.error, /faststart_remux_failed/);
});

test('11. PATH-independent functional remux succeeds using bundled bin', (t) => {
  if (!hasCommand('ffmpeg') || !hasCommand('ffprobe')) {
    t.skip('ffmpeg or ffprobe not available in test runner');
    return;
  }
  const pyScript = `
import os, sys, shutil, tempfile, subprocess, json
from pathlib import Path
sys.path.insert(0, 'reader-cli')
import mirror_v5_r2
real_ffmpeg = mirror_v5_r2.resolve_binary('ffmpeg')
real_ffprobe = mirror_v5_r2.resolve_binary('ffprobe')
with tempfile.TemporaryDirectory() as td:
    fake_app = Path(td) / 'mock_app'
    fake_bin = fake_app / 'bin'
    fake_bin.mkdir(parents=True)
    exe_suffix = '.exe' if os.name == 'nt' else ''
    shutil.copy2(real_ffmpeg, fake_bin / f'ffmpeg{exe_suffix}')
    shutil.copy2(real_ffprobe, fake_bin / f'ffprobe{exe_suffix}')
    old_file = mirror_v5_r2.__file__
    fake_module = fake_app / 'mirror_v5_r2.py'
    fake_module.write_text('pass')
    mirror_v5_r2.__file__ = str(fake_module)
    orig_path = os.environ.get('PATH', '')
    os.environ['PATH'] = 'C:\\\\Windows\\\\system32;C:\\\\Windows' if os.name == 'nt' else '/bin:/usr/bin'
    try:
        resolved_ffmpeg = mirror_v5_r2.resolve_binary('ffmpeg')
        resolved_ffprobe = mirror_v5_r2.resolve_binary('ffprobe')
        assert str(fake_bin) in resolved_ffmpeg
        assert str(fake_bin) in resolved_ffprobe
        src = Path(td) / 'in.mp4'
        subprocess.run([
            resolved_ffmpeg, '-y',
            '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=25',
            '-f', 'lavfi', '-i', 'sine=duration=1:frequency=440',
            '-c:v', 'libx264', '-c:a', 'aac',
            '-movflags', '-faststart',
            str(src)
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        out_part = Path(td) / 'clean_path_test.faststart.part'
        out_size = mirror_v5_r2.remux_video_faststart(src, out_part)
        assert out_part.exists() and out_size > 0
        moov_ok, _ = mirror_v5_r2.check_moov_before_mdat(out_part)
        assert moov_ok
        print(json.dumps({'ok': True, 'out_size': out_size}))
    finally:
        mirror_v5_r2.__file__ = old_file
        os.environ['PATH'] = orig_path
`;
  const output = execFileSync(pythonBin, ['-c', pyScript], { cwd: repoRoot, encoding: 'utf8' });
  const result = JSON.parse(output.trim().split('\n').pop());
  assert.equal(result.ok, true);
  assert.ok(result.out_size > 0);
});

test('12. Resolver fails closed when a dependency is absent', () => {
  const pyScript = `
import os, sys, json
sys.path.insert(0, 'reader-cli')
import mirror_v5_r2
orig_path = os.environ.get('PATH', '')
os.environ['PATH'] = 'C:\\\\Windows\\\\system32;C:\\\\Windows' if os.name == 'nt' else '/bin:/usr/bin'
try:
    mirror_v5_r2.resolve_binary('nonexistent_binary_xyz')
    print(json.dumps({'ok': False, 'error': 'should_have_failed'}))
except RuntimeError as exc:
    print(json.dumps({'ok': True, 'error': str(exc)}))
finally:
    os.environ['PATH'] = orig_path
`;
  const output = execFileSync(pythonBin, ['-c', pyScript], { cwd: repoRoot, encoding: 'utf8' });
  const result = JSON.parse(output.trim().split('\n').pop());
  assert.equal(result.ok, true);
  assert.match(result.error, /^faststart_dependency_missing:/);
});
