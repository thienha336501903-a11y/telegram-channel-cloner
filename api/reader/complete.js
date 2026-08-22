import { json, method, readJson } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { claimReaderJob, finishReaderJob, heartbeatReaderJob } from '../../lib/reader-jobs.js';
import { applyReconcileSnapshot, createReconcilePlan } from '../../lib/reader-reconcile.js';
import { patch } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';

function requireReaderSecret(req, res) {
  if (req.headers.authorization === `Bearer ${requireEnv('READER_INGEST_SECRET')}`) return true;
  json(res, 401, { ok: false, error: 'unauthorized' });
  return false;
}

export default async function handler(req, res) {
  if (!method(req, res, ['POST'])) return;
  if (!requireReaderSecret(req, res)) return;

  const action = String(req.query?.action || '').trim();
  const body = await readJson(req, { maxBytes: 1_500_000 });

  if (action === 'claim') {
    const job = await claimReaderJob(body.agent_id);
    return json(res, 200, { ok: true, job });
  }

  if (action === 'heartbeat') {
    const job = await heartbeatReaderJob({ jobId: body.job_id, agentId: body.agent_id });
    if (!job) return json(res, 409, { ok: false, error: 'reader_job_not_owned' });
    return json(res, 200, { ok: true, job });
  }

  if (action === 'finish-job') {
    const job = await finishReaderJob({
      jobId: body.job_id,
      agentId: body.agent_id,
      ok: body.ok === true,
      messageCount: body.message_count,
      deletedCount: body.deleted_count,
      error: body.error
    });
    if (!job) return json(res, 409, { ok: false, error: 'reader_job_not_owned' });
    return json(res, 200, { ok: true, job });
  }

  if (action === 'reconcile-plan') {
    try {
      const plan = await createReconcilePlan(body.source_id);
      return json(res, 200, { ok: true, plan });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message || 'reconcile_plan_failed') });
    }
  }

  if (action === 'reconcile') {
    try {
      const result = await applyReconcileSnapshot({
        sourceId: body.source_id,
        telegramChatId: body.telegram_chat_id,
        upperBoundMessageId: body.upper_bound_message_id,
        presentMessageIds: body.present_message_ids
      });
      return json(res, 200, { ok: true, result });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message || 'reconcile_failed') });
    }
  }

  if (!body.source_id) return json(res, 400, { ok: false, error: 'source_id_required' });
  const rows = await patch(
    TABLES.sources,
    `id=eq.${encodeURIComponent(body.source_id)}`,
    {
      indexed_at: new Date().toISOString(),
      indexed_message_count: Number(body.message_count || 0)
    }
  );
  return json(res, 200, { ok: true, source: rows[0] || null });
}
