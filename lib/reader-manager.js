import crypto from 'node:crypto';
import { requireEnv } from './env.js';
import { insert, patch, select, upsert } from './supabase.js';
import { TABLES } from './tables.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;
const ONLINE_WINDOW_MS = 90 * 1000;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PROFILE_STATUSES = new Set(['ready', 'busy', 'cooldown', 'reauth', 'paused', 'offline']);

function clean(value, max = 160) {
  return String(value || '').trim().slice(0, max);
}

function timingSafeTextEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function secretHash(value, purpose) {
  return crypto.createHmac('sha256', requireEnv('SESSION_SECRET'))
    .update(`reader-manager:${purpose}:${String(value || '')}`)
    .digest('hex');
}

function bearerToken(req) {
  return clean(String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1], 500);
}

function pairingCode() {
  const bytes = crypto.randomBytes(10);
  let value = '';
  for (let i = 0; i < 10; i += 1) value += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${value.slice(0, 5)}-${value.slice(5)}`;
}

function normalizePairingCode(value) {
  const raw = clean(value, 32).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 10 ? `${raw.slice(0, 5)}-${raw.slice(5)}` : raw;
}

function publicAgent(row) {
  if (!row) return null;
  const { token_hash: _tokenHash, ...safe } = row;
  return safe;
}

export async function createReaderPairing(displayName) {
  const code = pairingCode();
  const rows = await insert(TABLES.readerPairings, {
    code_hash: secretHash(code, 'pairing'),
    display_name: clean(displayName || 'Máy Reader', 80),
    expires_at: new Date(Date.now() + PAIRING_TTL_MS).toISOString()
  });
  return { pairing: rows[0], code };
}

export async function consumeReaderPairing({ code, platform, appVersion }) {
  const normalized = normalizePairingCode(code);
  if (!normalized) throw Object.assign(new Error('pairing_code_required'), { status: 400 });
  const hash = secretHash(normalized, 'pairing');
  const rows = await select(
    TABLES.readerPairings,
    `select=*&code_hash=eq.${encodeURIComponent(hash)}&used_at=is.null&limit=1`
  );
  const pairing = rows?.[0];
  if (!pairing) throw Object.assign(new Error('pairing_invalid_or_used'), { status: 401 });
  if (Date.parse(pairing.expires_at) <= Date.now()) {
    throw Object.assign(new Error('pairing_expired'), { status: 410 });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const created = await insert(TABLES.readerAgents, {
    display_name: clean(pairing.display_name || 'Máy Reader', 80),
    token_hash: secretHash(token, 'agent-token'),
    platform: clean(platform, 80) || null,
    app_version: clean(appVersion, 40) || null,
    status: 'online',
    last_seen_at: new Date().toISOString()
  });
  const agent = created[0];
  const used = await patch(
    TABLES.readerPairings,
    `id=eq.${encodeURIComponent(pairing.id)}&used_at=is.null`,
    { used_at: new Date().toISOString(), agent_id: agent.id }
  );
  if (!used?.length) {
    await patch(TABLES.readerAgents, `id=eq.${encodeURIComponent(agent.id)}`, {
      status: 'revoked', revoked_at: new Date().toISOString()
    }, { returning: false });
    throw Object.assign(new Error('pairing_already_consumed'), { status: 409 });
  }
  return {
    agent: publicAgent(agent),
    agentToken: token,
    telegramApiId: requireEnv('TELEGRAM_API_ID'),
    telegramApiHash: requireEnv('TELEGRAM_API_HASH')
  };
}

export async function authenticateReaderRequest(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const legacy = String(process.env.READER_INGEST_SECRET || '');
  if (legacy && timingSafeTextEqual(token, legacy)) return { mode: 'legacy', agent: null, token };
  const hash = secretHash(token, 'agent-token');
  const rows = await select(
    TABLES.readerAgents,
    `select=*&token_hash=eq.${encodeURIComponent(hash)}&revoked_at=is.null&status=neq.revoked&limit=1`
  );
  const agent = rows?.[0];
  return agent ? { mode: 'managed', agent: publicAgent(agent), token } : null;
}

export async function heartbeatReaderAgent(agentId, { platform, appVersion } = {}) {
  const now = new Date().toISOString();
  const rows = await patch(TABLES.readerAgents, `id=eq.${encodeURIComponent(agentId)}&revoked_at=is.null`, {
    platform: clean(platform, 80) || null,
    app_version: clean(appVersion, 40) || null,
    status: 'online',
    last_seen_at: now,
    updated_at: now
  });
  return publicAgent(rows?.[0]);
}

export async function registerReaderProfile(agentId, body) {
  const telegramUserId = clean(body.telegram_user_id, 40);
  if (!telegramUserId || !/^\d+$/.test(telegramUserId)) {
    throw Object.assign(new Error('telegram_user_id_required'), { status: 400 });
  }
  const now = new Date().toISOString();
  const rows = await upsert(TABLES.readerProfiles, {
    agent_id: agentId,
    telegram_user_id: telegramUserId,
    display_name: clean(body.display_name || `Reader ${telegramUserId.slice(-4)}`, 80),
    masked_phone: clean(body.masked_phone, 32) || null,
    status: 'ready',
    cooldown_until: null,
    revoked_at: null,
    last_seen_at: now,
    updated_at: now
  }, { onConflict: 'agent_id,telegram_user_id' });
  return rows[0];
}

export async function listAgentProfiles(agentId) {
  return select(
    TABLES.readerProfiles,
    `select=*&agent_id=eq.${encodeURIComponent(agentId)}&revoked_at=is.null&order=created_at.asc`
  );
}

export async function updateReaderProfile(agentId, profileId, body) {
  const now = new Date().toISOString();
  const values = { last_seen_at: now, updated_at: now };
  if (PROFILE_STATUSES.has(body.status)) values.status = body.status;
  if (body.status === 'revoked') values.revoked_at = now;
  if (body.cooldown_until === null || Number.isFinite(Date.parse(body.cooldown_until))) {
    values.cooldown_until = body.cooldown_until || null;
  }
  if (body.display_name) values.display_name = clean(body.display_name, 80);
  const rows = await patch(
    TABLES.readerProfiles,
    `id=eq.${encodeURIComponent(profileId)}&agent_id=eq.${encodeURIComponent(agentId)}&revoked_at=is.null`,
    values
  );
  return rows?.[0] || null;
}

export async function reportReaderSourceAccess(agentId, { profileId, sourceId, ok, error }) {
  const owned = await select(
    TABLES.readerProfiles,
    `select=id&id=eq.${encodeURIComponent(profileId)}&agent_id=eq.${encodeURIComponent(agentId)}&revoked_at=is.null&limit=1`
  );
  if (!owned?.[0]) throw Object.assign(new Error('reader_profile_not_owned'), { status: 403 });
  const now = new Date().toISOString();
  const rows = await upsert(TABLES.readerSourceAccess, {
    source_id: sourceId,
    reader_profile_id: profileId,
    status: ok ? 'verified' : 'denied',
    checked_at: now,
    last_error: ok ? null : clean(error || 'reader_source_access_denied', 500),
    updated_at: now
  }, { onConflict: 'source_id,reader_profile_id' });
  return rows[0];
}

export async function chooseReaderProfile(requestedId = '') {
  const requested = clean(requestedId, 80);
  const now = new Date().toISOString();
  const onlineCutoff = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
  if (requested && requested !== 'auto') {
    const rows = await select(
      TABLES.readerProfiles,
      `select=*,tgcloner_reader_agents!inner(id,status,last_seen_at,revoked_at)&id=eq.${encodeURIComponent(requested)}&revoked_at=is.null&status=eq.ready&tgcloner_reader_agents.status=eq.online&tgcloner_reader_agents.revoked_at=is.null&tgcloner_reader_agents.last_seen_at=gte.${encodeURIComponent(onlineCutoff)}&limit=1`
    );
    if (!rows?.[0]) throw Object.assign(new Error('reader_profile_unavailable'), { status: 409 });
    return rows[0];
  }
  const rows = await select(
    TABLES.readerProfiles,
    `select=*,tgcloner_reader_agents!inner(id,status,last_seen_at,revoked_at)&revoked_at=is.null&status=eq.ready&or=(cooldown_until.is.null,cooldown_until.lte.${encodeURIComponent(now)})&tgcloner_reader_agents.status=eq.online&tgcloner_reader_agents.revoked_at=is.null&tgcloner_reader_agents.last_seen_at=gte.${encodeURIComponent(onlineCutoff)}&order=last_job_assigned_at.asc.nullsfirst,created_at.asc&limit=1`
  );
  return rows?.[0] || null;
}

export async function touchReaderAssignment(profileId) {
  if (!profileId) return;
  await patch(TABLES.readerProfiles, `id=eq.${encodeURIComponent(profileId)}`, {
    last_job_assigned_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, { returning: false });
}

export async function listReaderManagerState() {
  const [agents, profiles, access] = await Promise.all([
    select(TABLES.readerAgents, 'select=*&order=created_at.asc'),
    select(TABLES.readerProfiles, 'select=*&order=created_at.asc'),
    select(TABLES.readerSourceAccess, 'select=*&order=checked_at.desc.nullslast&limit=200')
  ]);
  const now = Date.now();
  const publicAgents = (agents || []).map(row => ({
    ...publicAgent(row),
    effective_status: row.revoked_at ? 'revoked' : (Date.parse(row.last_seen_at || 0) >= now - ONLINE_WINDOW_MS ? row.status : 'offline')
  }));
  const agentStatus = new Map(publicAgents.map(agent => [agent.id, agent.effective_status]));
  return {
    download_url: clean(process.env.READER_MANAGER_DOWNLOAD_URL, 500) || null,
    agents: publicAgents,
    profiles: (profiles || []).map(profile => ({
      ...profile,
      effective_status: agentStatus.get(profile.agent_id) === 'online' ? profile.status : 'offline'
    })),
    source_access: access || []
  };
}

export async function adminUpdateReader({ operation, agentId, profileId, displayName }) {
  const now = new Date().toISOString();
  if (operation === 'revoke_agent' && agentId) {
    const rows = await patch(TABLES.readerAgents, `id=eq.${encodeURIComponent(agentId)}&revoked_at=is.null`, {
      status: 'revoked', revoked_at: now, updated_at: now
    });
    return { agent: publicAgent(rows?.[0]) };
  }
  if (operation === 'revoke_profile' && profileId) {
    const rows = await patch(TABLES.readerProfiles, `id=eq.${encodeURIComponent(profileId)}&revoked_at=is.null`, {
      status: 'revoked', revoked_at: now, updated_at: now
    });
    return { profile: rows?.[0] || null };
  }
  if ((operation === 'pause_profile' || operation === 'resume_profile') && profileId) {
    const rows = await patch(TABLES.readerProfiles, `id=eq.${encodeURIComponent(profileId)}&revoked_at=is.null`, {
      status: operation === 'pause_profile' ? 'paused' : 'ready',
      display_name: displayName ? clean(displayName, 80) : undefined,
      updated_at: now
    });
    return { profile: rows?.[0] || null };
  }
  throw Object.assign(new Error('reader_admin_operation_invalid'), { status: 400 });
}
