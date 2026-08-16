import { createHash } from 'node:crypto';

const DOWNLOADER_UA_RE = /\b(IDMan|Internet Download Manager|JDownloader|aria2|Wget|curl|Free Download Manager|FDM|python-requests|Go-http-client)\b/i;

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
    if (host === 'yeunauan-lms-v4-test.vercel.app' || host === 'yeunauan-lms-clone.vercel.app') return true;
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
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range, X-V4-Playback, X-V4-Playback-Proof, Content-Type');
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

export function validateProtectedPlayback(req, ticket, tokenSource) {
  if (String(ticket?.purpose || 'legacy') !== 'playback') return { ok: true, protected: false };
  if (tokenSource !== 'authorization') return { ok: false, status: 403, error: 'playback_authorization_required' };
  if (clean(req.headers?.['x-v4-playback']) !== 'sw-v1') return { ok: false, status: 403, error: 'playback_proxy_required' };
  const origin = clean(req.headers?.origin || '');
  if (!isAllowedV4Origin(origin)) return { ok: false, status: 403, error: 'playback_origin_denied' };

  const proof = clean(req.headers?.['x-v4-playback-proof'] || '');
  if (!proof || !ticket.playback_proof_hash || sha256(proof) !== ticket.playback_proof_hash) {
    return { ok: false, status: 403, error: 'playback_proof_invalid' };
  }

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

  return { ok: true, protected: true };
}
