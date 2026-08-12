import { createHash } from 'node:crypto';
import { json } from '../../lib/http.js';
import { claimQueuedItems } from '../../lib/repository.js';
import { runTick } from '../../lib/engine.js';
import { patch } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function consumeSchedulerToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!/^[A-Fa-f0-9]{64}$/.test(token)) return false;
  const now = new Date().toISOString();
  const rows = await patch(
    TABLES.schedulerNonces,
    `token_hash=eq.${sha256(token)}&used_at=is.null&expires_at=gt.${encodeURIComponent(now)}`,
    { used_at: now }
  );
  return Array.isArray(rows) && rows.length === 1;
}

export default async function handler(req, res) {
  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  const auth = req.headers.authorization;
  const staticAuthorized = Boolean(cronSecret && auth === `Bearer ${cronSecret}`);
  const schedulerAuthorized = await consumeSchedulerToken(req.headers['x-tgcloner-scheduler-token']);

  if (!staticAuthorized && !schedulerAuthorized) {
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }

  const result = await runTick(claimQueuedItems);
  json(res, 200, { ok: true, auth: schedulerAuthorized ? 'supabase_scheduler' : 'static_secret', ...result });
}
