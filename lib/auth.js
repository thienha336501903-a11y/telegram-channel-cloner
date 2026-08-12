import crypto from 'node:crypto';
import { requireEnv } from './env.js';

const COOKIE = 'tcc_session';
const TTL_SECONDS = 60 * 60 * 12;

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(payload) {
  return crypto.createHmac('sha256', requireEnv('SESSION_SECRET')).update(payload).digest('base64url');
}

export function createSessionCookie() {
  const data = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + TTL_SECONDS, nonce: crypto.randomBytes(12).toString('hex') });
  const payload = b64url(data);
  const token = `${payload}.${sign(payload)}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL_SECONDS}`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

export function isAuthenticated(req) {
  const token = getCookie(req, COOKIE);
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function verifyPassword(candidate) {
  const expected = requireEnv('ADMIN_PASSWORD');
  const a = Buffer.from(String(candidate ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
