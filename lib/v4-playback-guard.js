import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

const DOWNLOADER_UA_RE = /\b(IDMan|Internet Download Manager|JDownloader|aria2|Wget|curl|Free Download Manager|FDM|python-requests|Go-http-client)\b/i;
const SIGNATURE_MAX_SKEW_MS = 20 * 1000;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function clean(value) {
  return String(value || '').trim().replace(/^[\'\"]|[\'\"]$/g, '');
}

export function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

export function requestIp(req) {
  const forwarded = clean(req.headers?.['x-forwarded-for'] || '');
  if (forwarded) return clean(forwarded.split(',')[0]);
  return clean(req.headers?.['x-real-ip'] || req.socket?.remoteAddress || '');
}

function configuredOrigins() {
  return clean(process.env.V4_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

export function isAllowedV4Origin(origin) {
  const value = clean(origin);
  if (!value) return false;
  if (configuredOrigins().includes(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'daubepnho.store' || host === 'yeunauan-lms-v4-test.vercel.app' || host === 'yeunauan-lms-clone.vercel.app') return true;
    if (/^yeunauan-lms-git-[a-z0-9-]+-thienha100022653824678-stacks-projects\.vercel\.app$/.test(host)) return true;
    return /^yeunauan-lms-(?:v4-test|clone)-[a-z0-9-]+\.vercel\.app$/.test(host);
  } catch {
    return false;
  }
}

export function applyPlaybackCors(req, res) {
  const origin = clean(req.headers?.origin || '');
  if (origin && isAllowedV4Origin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range, X-V4-Playback, X-V4-Playback-Timestamp, X-V4-Playback-Nonce, X-V4-Playback-Signature, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length, Content-Range, Accept-Ranges, Server-Timing, X-Telegram-Media-Transport, X-MP4-Layout, X-MP4-Index-Cache');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }
  return !origin;
}

export function ticketTokenFromRequest(req) {
  const authorization = clean(req.headers?.authorization || '');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
  if (bearer) return { token: bearer, via: 'authorization' };
  return { token: clean(req.query?.ticket || ''), via: 'query' };
}

function playbackSigningPayload(req, token, origin, timestamp, nonce) {
  const method = String(req.method || 'GET').toUpperCase() === 'HEAD' ? 'HEAD' : 'GET';
  const range = clean(req.headers?.range || '');
  return [method, range, timestamp, nonce, token, origin].join('\n');
}

function verifyPlaybackRequestSignature(req, ticket, token) {
  const timestamp = clean(req.headers?.['x-v4-playback-timestamp'] || '');
  const nonce = clean(req.headers?.['x-v4-playback-nonce'] || '');
  const signature = clean(req.headers?.['x-v4-playback-signature'] || '');
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > SIGNATURE_MAX_SKEW_MS) {
    return { ok: false, error: 'playback_signature_expired' };
  }
  if (!nonce || nonce.length < 16 || nonce.length > 80 || !BASE64URL_RE.test(nonce)) {
    return { ok: false, error: 'playback_nonce_invalid' };
  }
  if (!signature || signature.length > 256 || !BASE64URL_RE.test(signature)) {
    return { ok: false, error: 'playback_signature_invalid' };
  }
  const publicKeyText = clean(ticket.playback_public_key_jwk || ticket.playback_proof_hash || '');
  if (!publicKeyText) {
    return { ok: false, error: 'playback_public_key_missing' };
  }

  try {
    const publicJwk = JSON.parse(publicKeyText);
    const publicKey = createPublicKey({ key: publicJwk, format: 'jwk' });
    const origin = clean(req.headers?.origin || '');
    const payload = playbackSigningPayload(req, token, origin, timestamp, nonce);
    const valid = verifySignature(
      'sha256',
      Buffer.from(payload),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url')
    );
    return valid ? { ok: true } : { ok: false, error: 'playback_signature_invalid' };
  } catch {
    return { ok: false, error: 'playback_signature_invalid' };
  }
}

export function validateProtectedPlayback(req, ticket, tokenSource, token = '') {
  if (String(ticket?.purpose || 'legacy') !== 'playback') return { ok: true, protected: false };
  if (tokenSource !== 'authorization') return { ok: false, status: 403, error: 'playback_authorization_required' };
  if (clean(req.headers?.['x-v4-playback']) !== 'sw-v2') return { ok: false, status: 403, error: 'playback_proxy_required' };
  const origin = clean(req.headers?.origin || '');
  if (!isAllowedV4Origin(origin)) return { ok: false, status: 403, error: 'playback_origin_denied' };

  const userAgent = clean(req.headers?.['user-agent'] || '');
  if (!userAgent || DOWNLOADER_UA_RE.test(userAgent)) {
    return { ok: false, status: 403, error: 'download_client_denied' };
  }
  if (ticket.bound_ua_hash && sha256(userAgent) !== ticket.bound_ua_hash) {
    return { ok: false, status: 403, error: 'playback_user_agent_mismatch' };
  }

  const ip = requestIp(req);
  if (ticket.bound_ip_hash && (!ip || sha256(ip) !== ticket.bound_ip_hash)) {
    return { ok: false, status: 403, error: 'playback_network_mismatch' };
  }

  const effectiveToken = token || ticketTokenFromRequest(req).token;
  const signed = verifyPlaybackRequestSignature(req, ticket, effectiveToken);
  if (!signed.ok) return { ok: false, status: 403, error: signed.error };
  return { ok: true, protected: true };
}
