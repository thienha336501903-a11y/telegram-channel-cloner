import { requireEnv } from './env.js';

function baseHeaders() {
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  };
}

function baseUrl() {
  return requireEnv('SUPABASE_URL').replace(/\/$/, '');
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

export async function select(table, query = '') {
  return db(`${table}?${query}`);
}

export async function insert(table, rows, { returning = true } = {}) {
  return db(table, {
    method: 'POST',
    body: rows,
    headers: {
      Prefer: returning ? 'return=representation' : 'return=minimal'
    }
  });
}

export async function upsert(table, rows, { onConflict, returning = true } = {}) {
  const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  return db(`${table}${qs}`, {
    method: 'POST',
    body: rows,
    headers: {
      Prefer: `${returning ? 'return=representation' : 'return=minimal'},resolution=merge-duplicates`
    }
  });
}

export async function patch(table, query, values, { returning = true } = {}) {
  return db(`${table}?${query}`, {
    method: 'PATCH',
    body: values,
    headers: { Prefer: returning ? 'return=representation' : 'return=minimal' }
  });
}

export async function remove(table, query) {
  return db(`${table}?${query}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
}
