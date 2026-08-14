import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { db } from '../lib/supabase.js';
import mediaHandler from '../api/telegram/media.js';

if (process.env.VERCEL_ENV !== 'preview') process.exit(0);

async function exercise(ticket) {
  const chunks = [];
  const headers = new Map();
  const res = new PassThrough();
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (name, value) => headers.set(String(name).toLowerCase(), String(value));
  res.getHeader = (name) => headers.get(String(name).toLowerCase());
  res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

  const req = {
    method: 'GET',
    query: { ticket },
    headers: { range: 'bytes=1048576-1050623' }
  };

  const startedAt = Date.now();
  await mediaHandler(req, res);
  if (!res.writableEnded) await new Promise((resolve) => res.once('finish', resolve));
  const body = Buffer.concat(chunks);
  return {
    status: res.statusCode,
    contentLength: headers.get('content-length') || null,
    contentRange: headers.get('content-range') || null,
    acceptRanges: headers.get('accept-ranges') || null,
    bodyBytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    elapsedMs: Date.now() - startedAt
  };
}

const tickets = await db(
  'lms_v4_media_tickets?select=token,email,message_id&email=like.__clone_factory_test_v4_mtproto_*&revoked_at=is.null&order=email.asc'
);

if (!Array.isArray(tickets) || tickets.length !== 3) {
  throw new Error(`Expected 3 MTProto test tickets, got ${Array.isArray(tickets) ? tickets.length : 'invalid'}`);
}

const results = [];
for (const ticket of tickets) {
  const result = await exercise(String(ticket.token));
  results.push({ email: ticket.email, ...result });
  if (
    result.status !== 206 ||
    result.bodyBytes !== 2048 ||
    result.contentLength !== '2048' ||
    !String(result.contentRange || '').startsWith('bytes 1048576-1050623/') ||
    result.acceptRanges !== 'bytes'
  ) {
    throw new Error(`V4 MTProto gateway probe failed for ${ticket.email}: ${JSON.stringify(result)}`);
  }
}

console.log(`[v4-mtproto-gateway-probe] ${JSON.stringify({ ok: true, results })}`);
