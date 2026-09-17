import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateReportedMirror } from '../lib/v5-mirror-jobs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const workerPath = path.join(REPO_ROOT, 'reader-cli', 'mirror_v5_r2.py');
const workerCode = fs.readFileSync(workerPath, 'utf8');
const jobsCode = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'v5-mirror-jobs.js'), 'utf8');

function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  try {
    const cmd = process.platform === 'win32' ? 'where.exe python' : 'which python || which python3';
    const out = spawnSync(cmd, { shell: true, encoding: 'utf8' });
    if (out.stdout) return out.stdout.trim().split(/\r?\n/)[0];
  } catch {}
  return 'python';
}

const pythonBin = resolvePython();

test('1. Video already faststart: checks moov before mdat and avoids remux', () => {
  assert.match(workerCode, /def check_already_faststart\(file_path\):/);
  assert.match(workerCode, /elif check_already_faststart\(local_path\):/);
  assert.match(workerCode, /upload_bytes = actual_bytes/);
  assert.match(workerCode, /upload_path = local_path/);
  assert.match(workerCode, /faststart_remuxed = False/);

  const readerCli = path.join(REPO_ROOT, 'reader-cli').replace(/\\/g, '/');
  const pyTest = `import sys\nsys.path.insert(0, '${readerCli}')\nfrom mirror_v5_r2 import check_already_faststart\nassert check_already_faststart('nonexistent.txt') == False\nprint('TEST1_OK')`;
  const res = spawnSync(pythonBin, ['-c', pyTest], { encoding: 'utf8' });
  assert.equal(res.status, 0, `Python check failed: ${res.stderr}`);
  assert.match(res.stdout, /TEST1_OK/);
});

test('2. Remux command preserves all streams using -map 0 without transcoding', () => {
  assert.match(workerCode, /"-map",\s*"0"/);
  assert.match(workerCode, /"-c",\s*"copy"/);
  assert.match(workerCode, /"-movflags",\s*"\+faststart"/);
  assert.match(workerCode, /"-f",\s*"mp4"/);
  assert.doesNotMatch(workerCode, /"-c:v"/);
  assert.doesNotMatch(workerCode, /"-c:a"/);
});

test('3. Duration drift > 0.5s fails with duration_drift error', () => {
  assert.match(workerCode, /faststart_remux_failed:duration_drift/);
  assert.match(workerCode, /abs\(src_dur - out_dur\) > 0\.5/);
});

test('4. Codec mismatch fails with codec_mismatch error', () => {
  assert.match(workerCode, /faststart_remux_failed:video_codec_mismatch/);
  assert.match(workerCode, /faststart_remux_failed:audio_codec_mismatch/);
});

test('5. Missing video stream in source fails with no_video_stream_in_source', () => {
  assert.match(workerCode, /raise RuntimeError\("faststart_remux_failed:no_video_stream_in_source"\)/);
});

test('6. R2 HEAD size conflict check raises explicit v5_mirror_r2_size_conflict error', () => {
  assert.match(workerCode, /v5_mirror_r2_size_conflict/);
  assert.match(workerCode, /existing_any = head_matching_object\(client, bucket, object_key, None\)/);
  assert.match(workerCode, /if existing_any and existing_any\["bytes"\] != total_bytes:/);
});

test('7. Checksum SHA256 calculation verifies exact file hash', () => {
  assert.match(workerCode, /def compute_file_sha256\(file_path\):/);
  assert.match(workerCode, /hashlib\.sha256\(\)/);

  const tempFile = path.join(REPO_ROOT, 'reader-cli', '.temp_sha256_test.bin');
  const testData = Buffer.from('hello-world-telemetry-video-payload-test');
  fs.writeFileSync(tempFile, testData);
  try {
    const expectedSha256 = crypto.createHash('sha256').update(testData).digest('hex');
    const readerCli = path.join(REPO_ROOT, 'reader-cli').replace(/\\/g, '/');
    const tempFileEscaped = tempFile.replace(/\\/g, '/');
    const pyScript = `import sys\nsys.path.insert(0, '${readerCli}')\nfrom mirror_v5_r2 import compute_file_sha256\ndigest = compute_file_sha256('${tempFileEscaped}')\nprint(digest)`;
    const res = spawnSync(pythonBin, ['-c', pyScript], { encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), expectedSha256);
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});

test('8. validateReportedMirror enforces exact size match for original-v1', () => {
  const asset = { id: 'asset-1', bytes: 5000, mime_type: 'video/mp4' };
  const expectedKey = 'media/v5/course-1/asset-1/video.mp4';

  const valid = validateReportedMirror({
    job: { id: 'job-1' },
    asset,
    objectKey: expectedKey,
    finalBytes: 5000,
    sourceBytes: 5000,
    transformVersion: 'original-v1',
    checksumSha256: 'abc123sha',
    expectedObjectKey: expectedKey
  });
  assert.equal(valid.finalBytes, 5000);
  assert.equal(valid.sourceBytes, 5000);
  assert.equal(valid.transformVersion, 'original-v1');
  assert.equal(valid.checksumSha256, 'abc123sha');

  assert.throws(() => {
    validateReportedMirror({
      job: { id: 'job-1' },
      asset,
      objectKey: expectedKey,
      finalBytes: 5050,
      sourceBytes: 5000,
      transformVersion: 'original-v1',
      expectedObjectKey: expectedKey
    });
  }, { message: 'v5_mirror_size_mismatch:5050/5000' });
});

test('9. validateReportedMirror permits bounded faststart drift for ffmpeg-faststart-v1 and rejects excessive drift', () => {
  const asset = { id: 'asset-video', bytes: 79579331, mime_type: 'video/mp4' };
  const expectedKey = 'media/v5/course-mochi/asset-video/lesson.mp4';

  const valid = validateReportedMirror({
    job: { id: 'job-mochi' },
    asset,
    objectKey: expectedKey,
    finalBytes: 79579382,
    sourceBytes: 79579331,
    transformVersion: 'ffmpeg-faststart-v1',
    checksumSha256: 'deadbeef79579382',
    expectedObjectKey: expectedKey
  });
  assert.equal(valid.finalBytes, 79579382);
  assert.equal(valid.sourceBytes, 79579331);
  assert.equal(valid.transformVersion, 'ffmpeg-faststart-v1');
  assert.equal(valid.checksumSha256, 'deadbeef79579382');

  assert.throws(() => {
    validateReportedMirror({
      job: { id: 'job-mochi' },
      asset,
      objectKey: expectedKey,
      finalBytes: 82000000,
      sourceBytes: 79579331,
      transformVersion: 'ffmpeg-faststart-v1',
      expectedObjectKey: expectedKey
    });
  }, /v5_mirror_faststart_drift_excessive:82000000\/79579331/);
});

test('10. Artifact provenance contract updates media asset bytes and records result provenance', () => {
  assert.match(jobsCode, /source_bytes:\s*validated\.sourceBytes/);
  assert.match(jobsCode, /final_bytes:\s*validated\.finalBytes/);
  assert.match(jobsCode, /transform_version:\s*validated\.transformVersion/);
  assert.match(jobsCode, /checksum_sha256:\s*validated\.checksumSha256/);
  assert.match(jobsCode, /v5_media_assets\?id=eq\./);
  assert.match(jobsCode, /bytes:\s*validated\.finalBytes/);
});
