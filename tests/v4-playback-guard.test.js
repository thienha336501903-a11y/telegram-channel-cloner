import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedV4Origin,
  sha256,
  validateProtectedPlayback
} from '../lib/v4-playback-guard.js';

function req({
  origin = 'https://yeunauan-lms-v4-test.vercel.app',
  userAgent = 'Mozilla/5.0 Safari/605.1.15',
  ip = '203.0.113.10',
  proof = 'proof-value',
  marker = 'sw-v1'
} = {}) {
  return {
    headers: {
      origin,
      'user-agent': userAgent,
      'x-forwarded-for': ip,
      'x-v4-playback-proof': proof,
      'x-v4-playback': marker
    }
  };
}

function ticket(overrides = {}) {
  return {
    purpose: 'playback',
    playback_proof_hash: sha256('proof-value'),
    bound_ua_hash: sha256('Mozilla/5.0 Safari/605.1.15'),
    bound_ip_hash: sha256('203.0.113.10'),
    ...overrides
  };
}

test('accepts canonical and Vercel preview LMS origins', () => {
  assert.equal(isAllowedV4Origin('https://yeunauan-lms-v4-test.vercel.app'), true);
  assert.equal(isAllowedV4Origin('https://yeunauan-lms-v4-test-abc123-owner-projects.vercel.app'), true);
  assert.equal(isAllowedV4Origin('https://example.com'), false);
});

test('protected playback requires Authorization transport', () => {
  const result = validateProtectedPlayback(req(), ticket(), 'query');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'playback_authorization_required');
});

test('protected playback accepts matching service-worker proof and fingerprint', () => {
  const result = validateProtectedPlayback(req(), ticket(), 'authorization');
  assert.deepEqual(result, { ok: true, protected: true });
});

test('protected playback rejects IDM-style downloader user agents', () => {
  const downloader = 'IDMan/6.42';
  const result = validateProtectedPlayback(
    req({ userAgent: downloader }),
    ticket({ bound_ua_hash: sha256(downloader) }),
    'authorization'
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'download_client_denied');
});

test('protected playback rejects copied lease from another IP', () => {
  const result = validateProtectedPlayback(req({ ip: '198.51.100.20' }), ticket(), 'authorization');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'playback_network_mismatch');
});

test('legacy/feed tickets remain non-protected so callers can preserve non-video compatibility', () => {
  assert.deepEqual(validateProtectedPlayback(req(), { purpose: 'feed' }, 'query'), { ok: true, protected: false });
});
