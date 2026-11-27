#!/usr/bin/env node
// Staging-only Reader Agent simulator for the Import acceptance plan (handoff
// docs/cloner/IMPORT_CLONE_STAGING_ACCEPTANCE_PLAN_20261127.md, path I-A).
// It never reads Telegram: it posts Agent-shaped payloads built from a fixture
// whose ids/texts the Owner copied from real posts in the staging source channel.
//
// Usage (secrets only via env file, never printed):
//   node --env-file=D:/SYSTEMB_SECRETS/staging/reader-vercel.secrets.env scripts/staging/reader-agent-sim.mjs <health|import|fail-access|foreign> --base <staging url> [--fixture file.json]
// Env: READER_INGEST_SECRET (staging), VERCEL_AUTOMATION_BYPASS_SECRET (Preview protection bypass).
import fs from 'node:fs';

const PRODUCTION_HOSTS = new Set(['reader.yeubep.shop']);
const AGENT_ID = 'staging-agent-sim';
const BATCH = 20;

export function assertStagingBase(base) {
  let url;
  try { url = new URL(base); } catch { throw new Error('base_url_invalid'); }
  if (url.protocol !== 'https:') throw new Error('base_url_must_be_https');
  if (PRODUCTION_HOSTS.has(url.hostname)) throw new Error('refused_production_host');
  if (!/^telegram-channel-cloner-.*staging.*\.vercel\.app$/.test(url.hostname)) throw new Error('refused_non_staging_host');
  return url.origin;
}

export function assertStagingHealth(health) {
  if (!health?.ok) throw new Error('health_not_ok');
  if (health.environment === 'production') throw new Error('refused_production_environment');
  if (health.checks?.database !== true) throw new Error('health_database_false');
  if (health.channelAllowlist?.enabled !== true || health.channelAllowlist?.entries !== 1) throw new Error('allowlist_must_have_exactly_1_entry');
}

const DESCRIPTOR_TYPES = new Set(['video', 'audio', 'document']);

// One fixture entry -> one Agent-shaped message (same fields as reader-cli/export_history.py).
export function toAgentMessage(entry, now = new Date().toISOString()) {
  const id = Number(entry.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`fixture_bad_id:${entry.id}`);
  const type = String(entry.type || 'text');
  const raw = { from_reader: true };
  const size = entry.no_descriptor ? 0 : Number(entry.file_size || 123456);
  if (type === 'photo' && !entry.no_descriptor) raw.photo = [{ file_id: '', file_size: size, width: 1280, height: 720, type: 'y', mtproto: true }];
  if (DESCRIPTOR_TYPES.has(type) && !entry.no_descriptor) {
    raw[type] = { file_id: '', file_size: size, mime_type: entry.mime_type || 'application/octet-stream', file_name: entry.file_name || `${type}-${id}`, mtproto: true };
  }
  // voice/animation/video_note get no descriptor, exactly like the real Agent -> server skip path.
  const text = type === 'text' ? String(entry.text ?? '') : null;
  const caption = type === 'text' ? null : (entry.caption ?? null);
  return {
    source_message_id: id,
    media_group_id: entry.album ? String(entry.album) : null,
    message_type: type,
    text,
    text_entities: text !== null ? (entry.entities || []) : [],
    caption,
    caption_entities: caption !== null ? (entry.entities || []) : [],
    reply_to_source_message_id: entry.reply_to ? Number(entry.reply_to) : null,
    is_pinned: Boolean(entry.pinned),
    source_date: entry.date || now,
    raw_message: raw
  };
}

function client(origin) {
  const secret = String(process.env.READER_INGEST_SECRET || '');
  const bypass = String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '');
  if (secret.length < 32) throw new Error('READER_INGEST_SECRET_missing');
  if (!bypass) throw new Error('VERCEL_AUTOMATION_BYPASS_SECRET_missing');
  return async function call(method, path, body) {
    const res = await fetch(origin + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, 'x-vercel-protection-bypass': bypass },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
    return { status: res.status, data };
  };
}

async function main(argv) {
  const [command] = argv;
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i > 0 ? argv[i + 1] : undefined; };
  const origin = assertStagingBase(arg('base') || '');
  const call = client(origin);
  const health = await call('GET', '/api/health');
  assertStagingHealth(health.data);
  console.log('health', health.status, { environment: health.data.environment, allowlist: health.data.channelAllowlist });
  if (command === 'health') return;

  if (command === 'foreign') {
    const r = await call('POST', '/api/reader/ingest', { source_id: '00000000-0000-4000-8000-000000000000', messages: [toAgentMessage({ id: 1, type: 'text', text: 'x' })] });
    console.log('foreign ingest', r.status, r.data.error);
    return;
  }

  const claim = await call('POST', '/api/reader/complete?action=claim', { agent_id: AGENT_ID, capabilities: [] });
  const job = claim.data?.job;
  console.log('claim', claim.status, job ? { id: job.id, source_id: job.source_id, job_type: job.job_type } : null);
  if (!job) return;

  if (command === 'fail-access') {
    const r = await call('POST', '/api/reader/complete?action=finish-job', { job_id: job.id, agent_id: AGENT_ID, ok: false, error: 'reader_source_access_denied' });
    console.log('finish-job (failed)', r.status, r.data?.job?.status);
    return;
  }
  if (command !== 'import') throw new Error('unknown_command');

  const fixture = JSON.parse(fs.readFileSync(arg('fixture') || '', 'utf8'));
  if (fixture.source_id !== job.source_id) {
    await call('POST', '/api/reader/complete?action=finish-job', { job_id: job.id, agent_id: AGENT_ID, ok: false, error: 'sim_fixture_source_mismatch' });
    throw new Error('fixture_source_mismatch');
  }
  const messages = fixture.messages.map((entry) => toAgentMessage(entry));
  const skipped = [];
  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    const r = await call('POST', '/api/reader/ingest', { source_id: job.source_id, messages: batch });
    console.log('ingest', r.status, { saved: r.data.saved, internal_links: r.data.internal_links, hydration_attempts: r.data.hydration_attempts, skipped: r.data.hydration_skipped_source_message_ids, error: r.data.error });
    if (r.status !== 200) {
      await call('POST', '/api/reader/complete?action=finish-job', { job_id: job.id, agent_id: AGENT_ID, ok: false, error: `sim_ingest_${r.status}` });
      throw new Error(`ingest_failed_${r.status}`);
    }
    skipped.push(...(r.data.hydration_skipped_source_message_ids || []));
    await call('POST', '/api/reader/complete?action=job-progress', { job_id: job.id, agent_id: AGENT_ID, progress_current: Math.min(i + BATCH, messages.length), progress_total: messages.length, progress_stage: 'ingesting' });
  }
  const fin = await call('POST', '/api/reader/complete?action=finish-job', { job_id: job.id, agent_id: AGENT_ID, ok: true, message_count: messages.length });
  const done = await call('POST', '/api/reader/complete', { source_id: job.source_id, message_count: messages.length });
  console.log('finish-job', fin.status, fin.data?.job?.status, '| complete', done.status, done.data?.source?.indexed_message_count, '| skipped ids', skipped);
}

if (process.argv[1]?.endsWith('reader-agent-sim.mjs')) {
  main(process.argv.slice(2)).catch((error) => { console.error('ERROR', error.message); process.exit(1); });
}
