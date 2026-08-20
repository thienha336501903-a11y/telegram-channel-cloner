import { assertTgClonerTableName } from './tables.js';

function cleanEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function optionalEnv(name) {
  const value = process.env[name];
  return value ? value.trim().replace(/^['"]|['"]$/g, '') : '';
}

function serverKey() {
  const modern = optionalEnv('SUPABASE_SECRET_KEY');
  const legacy = optionalEnv('SUPABASE_SERVICE_ROLE_KEY');

  // A modern Supabase server key always uses the sb_secret_* format. Some
  // deployments may still carry an older/misnamed JWT in SUPABASE_SECRET_KEY;
  // when a real legacy service-role key is also configured, prefer that known
  // legacy slot instead of blindly selecting the malformed/misnamed value.
  if (modern.startsWith('sb_secret_')) return modern;
  if (legacy) return legacy;
  if (modern) return modern;

  throw new Error('Missing required environment variable: SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY)');
}

function baseHeaders() {
  const key = serverKey();
  const headers = {
    apikey: key,
    'Content-Type': 'application/json'
  };
  // New sb_secret_* keys are API keys rather than JWTs. Legacy service_role keys
  // are JWTs and remain compatible with the Authorization bearer header.
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function baseUrl() {
  return cleanEnv('SUPABASE_URL').replace(/\/$/, '');
}

export async function db(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl()}/rest/v1/${path}`, {
    method,
    headers: { ...baseHeaders(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const err = new Error(`Supabase REST ${response.status}`);
    err.status = response.status;
    err.details = data;
    throw err;
  }
  return data;
}

function safeTable(table) {
  return assertTgClonerTableName(table);
}

export async function select(table, query = '') {
  return db(`${safeTable(table)}?${query}`);
}

export async function insert(table, rows, { returning = true } = {}) {
  return db(safeTable(table), {
    method: 'POST',
    body: rows,
    headers: {
      Prefer: returning ? 'return=representation' : 'return=minimal'
    }
  });
}

export async function upsert(table, rows, { onConflict, returning = true } = {}) {
  const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  return db(`${safeTable(table)}${qs}`, {
    method: 'POST',
    body: rows,
    headers: {
      Prefer: `${returning ? 'return=representation' : 'return=minimal'},resolution=merge-duplicates`
    }
  });
}

export async function patch(table, query, values, { returning = true } = {}) {
  return db(`${safeTable(table)}?${query}`, {
    method: 'PATCH',
    body: values,
    headers: { Prefer: returning ? 'return=representation' : 'return=minimal' }
  });
}

export async function remove(table, query) {
  return db(`${safeTable(table)}?${query}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
}
