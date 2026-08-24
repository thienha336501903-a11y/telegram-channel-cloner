import { json, method, readJson } from '../../lib/http.js';
import { claimReaderJob, finishReaderJob, heartbeatReaderJob } from '../../lib/reader-jobs.js';
import { applyReconcileSnapshot, createReconcilePlan } from '../../lib/reader-reconcile.js';
import {
  authenticateReaderRequest,
  consumeReaderPairing,
  heartbeatReaderAgent,
  listAgentProfiles,
  registerReaderProfile,
  reportReaderSourceAccess,
  updateReaderProfile
} from '../../lib/reader-manager.js';
import { patch } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';

export default async function handler(req, res) {
  if (!method(req, res, ['POST'])) return;
  const action = String(req.query?.action || '').trim();
  const body = await readJson(req, { maxBytes: 1_500_000 });

  if (action === 'pair') {
    try {
      const result = await consumeReaderPairing({
        code: body.code,
        platform: body.platform,
        appVersion: body.app_version
      });
      return json(res, 201, {
        ok: true,
        agent: result.agent,
        agent_token: result.agentToken,
        telegram_api_id: result.telegramApiId,
        telegram_api_hash: result.telegramApiHash
      });
    } catch (error) {
      return json(res, Number(error?.status || 500), { ok: false, error: String(error?.message || 'pairing_failed') });
    }
  }

  const auth = await authenticateReaderRequest(req);
  if (!auth) return json(res, 401, { ok: false, error: 'unauthorized' });
  const managedAgentId = auth.mode === 'managed' ? auth.agent.id : null;

  if (action === 'heartbeat-agent') {
    if (!managedAgentId) return json(res, 400, { ok: false, error: 'managed_reader_required' });
    const agent = await heartbeatReaderAgent(managedAgentId, { platform: body.platform, appVersion: body.app_version });
    const profiles = await listAgentProfiles(managedAgentId);
    return json(res, 200, { ok: true, agent, profiles });
  }

  if (action === 'register-profile') {
    if (!managedAgentId) return json(res, 400, { ok: false, error: 'managed_reader_required' });
    try {
      const profile = await registerReaderProfile(managedAgentId, body);
      return json(res, 201, { ok: true, profile });
    } catch (error) {
      return json(res, Number(error?.status || 500), { ok: false, error: String(error?.message || 'reader_profile_failed') });
    }
  }

  if (action === 'profile-status') {
    if (!managedAgentId) return json(res, 400, { ok: false, error: 'managed_reader_required' });
    const profile = await updateReaderProfile(managedAgentId, body.profile_id, body);
    if (!profile) return json(res, 404, { ok: false, error: 'reader_profile_not_found' });
    return json(res, 200, { ok: true, profile });
  }

  if (action === 'source-access') {
    if (!managedAgentId) return json(res, 400, { ok: false, error: 'managed_reader_required' });
    try {
      const access = await reportReaderSourceAccess(managedAgentId, {
        profileId: body.profile_id,
        sourceId: body.source_id,
        ok: body.ok === true,
        error: body.error
      });
      return json(res, 200, { ok: true, access });
    } catch (error) {
      return json(res, Number(error?.status || 500), { ok: false, error: String(error?.message || 'reader_source_access_failed') });
    }
  }

  if (action === 'claim') {
    const profiles = managedAgentId ? await listAgentProfiles(managedAgentId) : [];
    const readyProfileIds = profiles
      .filter(profile => profile.status === 'ready' && (!profile.cooldown_until || Date.parse(profile.cooldown_until) <= Date.now()))
      .map(profile => profile.id);
    const job = await claimReaderJob(
      managedAgentId || body.agent_id,
      body.capabilities,
      { managed: Boolean(managedAgentId), profileIds: readyProfileIds }
    );
    return json(res, 200, { ok: true, job });
  }

  if (action === 'heartbeat') {
    const job = await heartbeatReaderJob({ jobId: body.job_id, agentId: managedAgentId || body.agent_id });
    if (!job) return json(res, 409, { ok: false, error: 'reader_job_not_owned' });
    return json(res, 200, { ok: true, job });
  }

  if (action === 'finish-job') {
    const job = await finishReaderJob({
      jobId: body.job_id,
      agentId: managedAgentId || body.agent_id,
      ok: body.ok === true,
      messageCount: body.message_count,
      deletedCount: body.deleted_count,
      error: body.error
    });
    if (!job) return json(res, 409, { ok: false, error: 'reader_job_not_owned' });
    return json(res, 200, { ok: true, job });
  }

  if (action === 'job-progress') {
    const job = await heartbeatReaderJob({
      jobId: body.job_id,
      agentId: managedAgentId || body.agent_id,
      progressCurrent: body.progress_current,
      progressTotal: body.progress_total,
      progressStage: body.progress_stage,
      progressDetail: body.progress_detail
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
