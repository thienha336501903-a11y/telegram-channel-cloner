import { select } from './supabase.js';
import { TABLES } from './tables.js';
import { chooseReaderProfile } from './reader-manager.js';

const ONLINE_WINDOW_MS = 90 * 1000;

function clean(value, max = 160) {
  return String(value || '').trim().slice(0, max);
}

function normalizeAllowedProfileIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => clean(value, 80)).filter(Boolean))];
}

async function listEligibleProfiles(allowedProfileIds = []) {
  const allowed = normalizeAllowedProfileIds(allowedProfileIds);
  const now = new Date().toISOString();
  const onlineCutoff = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
  const idFilter = allowed.length
    ? `&id=in.(${allowed.map(encodeURIComponent).join(',')})`
    : '';
  return select(
    TABLES.readerProfiles,
    `select=*,tgcloner_reader_agents!inner(id,status,last_seen_at,revoked_at)&revoked_at=is.null&status=eq.ready&or=(cooldown_until.is.null,cooldown_until.lte.${encodeURIComponent(now)})&tgcloner_reader_agents.status=eq.online&tgcloner_reader_agents.revoked_at=is.null&tgcloner_reader_agents.last_seen_at=gte.${encodeURIComponent(onlineCutoff)}${idFilter}&order=last_job_assigned_at.asc.nullsfirst,created_at.asc&limit=50`
  );
}

export async function chooseReaderProfileForSource(sourceId, { requestedId = '', allowedProfileIds = [] } = {}) {
  const source = clean(sourceId, 80);
  if (!source) throw new Error('reader_source_required');

  const requested = clean(requestedId, 80);
  const allowed = normalizeAllowedProfileIds(allowedProfileIds);
  if (requested && requested !== 'auto') {
    if (allowed.length && !allowed.includes(requested)) return null;
    // An explicit profile selection is a deliberate re-check and therefore keeps
    // the existing Reader Manager behavior even if a previous access probe denied it.
    return chooseReaderProfile(requested);
  }

  const profiles = await listEligibleProfiles(allowed);
  if (!profiles?.length) return null;

  const profileIds = profiles.map(profile => profile.id).filter(Boolean);
  const accessRows = await select(
    TABLES.readerSourceAccess,
    `select=reader_profile_id,status,checked_at&source_id=eq.${encodeURIComponent(source)}&reader_profile_id=in.(${profileIds.map(encodeURIComponent).join(',')})&limit=${Math.max(1, profileIds.length)}`
  );
  const accessByProfile = new Map((accessRows || []).map(row => [row.reader_profile_id, String(row.status || 'unknown')]));

  // Prefer a profile already proven to have access. If none is verified, allow
  // exactly the normal LRU order among unknown/unprobed profiles for discovery.
  // Profiles already known denied are never selected automatically.
  const verified = profiles.find(profile => accessByProfile.get(profile.id) === 'verified');
  if (verified) return verified;
  return profiles.find(profile => accessByProfile.get(profile.id) !== 'denied') || null;
}
