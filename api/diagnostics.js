import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { json } from '../lib/http.js';
import { select } from '../lib/supabase.js';
import { TABLES } from '../lib/tables.js';
import { getMe, telegram } from '../lib/telegram.js';
import mediaHandler from './telegram/media.js';

const CAGIATAY_CHAT_ID = '-1004486574754';
const CAGIATAY_TEST_MESSAGE_ID = 4;

function safeError(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.errorMessage || error?.message || 'unknown_error').slice(0, 240),
    code: error?.code ?? error?.errorCode ?? null
  };
}

async function runGatewayProbe(ticket) {
  const chunks = [];
  const headers = new Map();
  const mockRes = new PassThrough();
  mockRes.statusCode = 200;
  mockRes.headersSent = false;
  mockRes.setHeader = (name, value) => headers.set(String(name).toLowerCase(), String(value));
  mockRes.getHeader = (name) => headers.get(String(name).toLowerCase());
  mockRes.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

  const mockReq = {
    method: 'GET',
    query: { ticket: String(ticket || '') },
    headers: { range: 'bytes=1048576-1050623' }
  };

  const startedAt = Date.now();
  await mediaHandler(mockReq, mockRes);
  if (!mockRes.writableEnded) {
    await new Promise((resolve) => mockRes.once('finish', resolve));
  }
  const body = Buffer.concat(chunks);
  return {
    status: mockRes.statusCode,
    contentLengthHeader: headers.get('content-length') || null,
    contentRange: headers.get('content-range') || null,
    acceptRanges: headers.get('accept-ranges') || null,
    contentType: headers.get('content-type') || null,
    bodyBytes: body.length,
    bodySha256: createHash('sha256').update(body).digest('hex'),
    elapsedMs: Date.now() - startedAt
  };
}

async function runMtprotoProbe({ download = false } = {}) {
  const apiId = Number.parseInt(String(process.env.TELEGRAM_API_ID || ''), 10);
  const apiHash = String(process.env.TELEGRAM_API_HASH || '').trim();
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const result = {
    env: {
      apiId: Number.isInteger(apiId) && apiId > 0,
      apiHash: Boolean(apiHash),
      botToken: Boolean(botToken)
    },
    auth: { ok: false },
    entity: { ok: false },
    message: { ok: false },
    download: download ? { ok: false } : undefined
  };

  if (!result.env.apiId || !result.env.apiHash || !result.env.botToken) return result;

  let client = null;
  try {
    const [{ TelegramClient }, { StringSession }] = await Promise.all([
      import('teleproto'),
      import('teleproto/sessions/index.js')
    ]);
    client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 5,
      requestRetries: 5,
      autoReconnect: true,
      sequentialUpdates: true
    });

    await client.start({ botAuthToken: botToken });
    const me = await client.getMe();
    result.auth = {
      ok: true,
      bot: Boolean(me?.bot),
      id: me?.id != null ? String(me.id) : null,
      username: me?.username || null
    };

    try {
      const entity = await client.getInputEntity(CAGIATAY_CHAT_ID);
      result.entity = {
        ok: true,
        className: entity?.className || entity?.constructor?.name || null,
        channelId: entity?.channelId != null ? String(entity.channelId) : null,
        hasAccessHash: entity?.accessHash != null
      };

      try {
        const messages = await client.getMessages(entity, { ids: CAGIATAY_TEST_MESSAGE_ID });
        const message = Array.isArray(messages) ? messages[0] : null;
        const document = message?.media?.document || null;
        result.message = {
          ok: Boolean(message),
          id: message?.id ?? null,
          className: message?.className || message?.constructor?.name || null,
          hasMedia: Boolean(message?.media),
          hasDocument: Boolean(document),
          documentSize: document?.size != null ? Number(document.size) : null,
          documentId: document?.id != null ? String(document.id) : null,
          hasDocumentAccessHash: document?.accessHash != null,
          hasFileReference: Boolean(document?.fileReference?.length)
        };

        if (download && message && document) {
          const startedAt = Date.now();
          try {
            const buffer = await client.downloadMedia(message);
            const byteLength = Buffer.isBuffer(buffer) ? buffer.length : 0;
            result.download = {
              ok: byteLength > 0 && byteLength === Number(document.size),
              byteLength,
              expectedBytes: Number(document.size),
              elapsedMs: Date.now() - startedAt
            };
          } catch (error) {
            result.download = {
              ok: false,
              elapsedMs: Date.now() - startedAt,
              error: safeError(error)
            };
          }
        }
      } catch (error) {
        result.message = { ok: false, error: safeError(error) };
      }
    } catch (error) {
      result.entity = { ok: false, error: safeError(error) };
    }
  } catch (error) {
    result.auth = { ok: false, error: safeError(error) };
  } finally {
    try { await client?.disconnect(); } catch {}
  }

  return result;
}

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV !== 'preview') {
    return json(res, 404, { ok: false, error: 'not_found' });
  }

  const gatewayTicket = String(req.query?.gateway_ticket || '').trim();
  if (gatewayTicket) {
    try {
      return json(res, 200, { ok: true, gateway: await runGatewayProbe(gatewayTicket) });
    } catch (error) {
      return json(res, 500, { ok: false, error: safeError(error) });
    }
  }

  const mtprotoMode = String(req.query?.mtproto || '');
  if (mtprotoMode === '1' || mtprotoMode === 'download') {
    return json(res, 200, {
      ok: true,
      mtproto: await runMtprotoProbe({ download: mtprotoMode === 'download' })
    });
  }

  const checks = {
    supabase: { ok: false },
    telegram: { ok: false },
    webhook: { ok: false }
  };

  try {
    const rows = await select(TABLES.settings, 'select=singleton,scheduler_enabled&limit=1');
    checks.supabase = {
      ok: Array.isArray(rows),
      settingsRows: Array.isArray(rows) ? rows.length : null,
      schedulerEnabled: Array.isArray(rows) && rows[0] ? Boolean(rows[0].scheduler_enabled) : false
    };
  } catch (error) {
    checks.supabase = { ok: false, error: error?.message || 'supabase_check_failed' };
  }

  try {
    const me = await getMe();
    checks.telegram = {
      ok: true,
      id: me?.id ?? null,
      username: me?.username ?? null,
      canJoinGroups: Boolean(me?.can_join_groups),
      supportsInlineQueries: Boolean(me?.supports_inline_queries)
    };
  } catch (error) {
    checks.telegram = { ok: false, error: error?.message || 'telegram_check_failed' };
  }

  try {
    const info = await telegram('getWebhookInfo');
    checks.webhook = {
      ok: true,
      configured: Boolean(info?.url),
      pendingUpdateCount: Number(info?.pending_update_count || 0),
      lastErrorDate: info?.last_error_date || null,
      lastErrorMessage: info?.last_error_message || null
    };
  } catch (error) {
    checks.webhook = { ok: false, error: error?.message || 'webhook_check_failed' };
  }

  const ok = checks.supabase.ok && checks.telegram.ok && checks.webhook.ok;
  return json(res, ok ? 200 : 503, { ok, checks });
}
