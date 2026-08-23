import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signPayload } from 'node:crypto';
import {
  isAllowedV4Origin,
  sha256,
  validateProtectedPlayback
} from '../lib/v4-playback-guard.js';

const TOKEN = 'test-playback-token';
const ORIGIN = 'https://yeunauan-lms-v4-test.vercel.app';
const USER_AGENT = 'Mozilla/5.0 Safari/605.1.15';
const IP = '203.0.113.10';
const RANGE = 'bytes=0-1023';
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicJwk = publicKey.export({ format: 'jwk' });

function signatureFor({ method = 'GET', range = RANGE, timestamp, nonce, token = TOKEN, origin = ORIGIN } = {}) {
  const payload = [method, range, timestamp, nonce, token, origin].join('\n');
  return signPayload(
    'sha256',
    Buffer.from(payload),
    { key: privateKey, dsaEncoding: 'ieee-p1363' }
  ).toString('base64url');
}

function req({
  origin = ORIGIN,
  userAgent = USER_AGENT,
  ip = IP,
  range = RANGE,
  timestamp = String(Date.now()),
  nonce = 'abcdefghijklmnop123456',
  marker = 'sw-v2',
  token = TOKEN,
  signature = null
} = {}) {
  const actualSignature = signature || signatureFor({ range, timestamp, nonce, token, origin });
  return {
    method: 'GET',
    headers: {
      origin,
      range,
      authorization: `Bearer ${token}`,
      'user-agent': userAgent,
      'x-forwarded-for': ip,
      'x-v4-playback': marker,
      'x-v4-playback-timestamp': timestamp,
      'x-v4-playback-nonce': nonce,
      'x-v4-playback-signature': actualSignature
    }
  };
}

function ticket(overrides = {}) {
  return {
    purpose: 'playback',
    playback_proof_hash: JSON.stringify(publicJwk),
    bound_ua_hash: sha256(USER_AGENT),
    bound_ip_hash: sha256(IP),
    ...overrides
  };
}

test('accepts canonical and Vercel preview LMS origins', () => {
  assert.equal(isAllowedV4Origin(ORIGIN), true);
  assert.equal(isAllowedV4Origin('https://yeunauan-lms-v4-test-abc123-owner-projects.vercel.app'), true);
  assert.equal(isAllowedV4Origin('https://yeunauan-lms-git-f01d1d-thienha100022653824678-stacks-projects.vercel.app'), true);
  assert.equal(isAllowedV4Origin('https://yeunauan-lms-git-f01d1d-attacker-projects.vercel.app'), false);
  assert.equal(isAllowedV4Origin('https://example.com'), false);
});

test('protected playback requires Authorization transport', () => {
  const result = validateProtectedPlayback(req(), ticket(), 'query');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'playback_authorization_required');
});

test('protected playback accepts a fresh signed Range request with matching fingerprint', () => {
  const result = validateProtectedPlayback(req(), ticket(), 'authorization');
  assert.deepEqual(result, { ok: true, protected: true });
});

test('protected playback rejects a copied signature used for a different Range', () => {
  const timestamp = String(Date.now());
  const nonce = 'abcdefghijklmnop123456';
  const signature = signatureFor({ range: RANGE, timestamp, nonce });
  const result = validateProtectedPlayback(
    req({ range: 'bytes=1024-2047', timestamp, nonce, signature }),
    ticket(),
    'authorization'
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'playback_signature_invalid');
});

test('protected playback rejects an expired signed request', () => {
  const timestamp = String(Date.now() - 60_000);
  const result = validateProtectedPlayback(req({ timestamp }), ticket(), 'authorization');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'playback_signature_expired');
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
