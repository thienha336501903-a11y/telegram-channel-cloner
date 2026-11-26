// Fake PostgREST for handler tests: caps every GET at the Production "Max rows" (1000), supports the
// filters the Cloner uses (eq/neq/in/lt/lte/gte, the job:tgcloner_clone_jobs!inner embed and its job.* filters),
// order/limit/offset, HEAD exact counts, insert, patch.
export const CAP = 1000;

export function fakeDb(tables) {
  const calls = [];
  let nextId = 1;
  let clock = Date.parse('2026-11-26T00:00:00Z');
  const stamp = () => new Date(clock++).toISOString();
  function filterRows(rows, params) {
    let out = rows;
    for (const [key, value] of params) {
      if (['select', 'order', 'limit', 'offset', 'or'].includes(key)) continue;
      const [op, ...rest] = value.split('.');
      const arg = rest.join('.');
      const get = key.startsWith('job.') ? (r => r.job?.[key.slice(4)]) : (r => r[key]);
      if (op === 'eq') out = out.filter(r => String(get(r)) === arg);
      else if (op === 'neq') out = out.filter(r => String(get(r)) !== arg);
      else if (op === 'lt') out = out.filter(r => String(get(r)) < arg);
      else if (op === 'lte') out = out.filter(r => String(get(r)) <= arg);
      else if (op === 'gte') out = out.filter(r => String(get(r)) >= arg);
      else if (op === 'is' && arg === 'null') out = out.filter(r => get(r) == null);
      else if (op === 'not' && arg === 'is.null') out = out.filter(r => get(r) != null);
      else if (op === 'in') { const set = new Set(arg.replace(/^\(|\)$/g, '').split(',')); out = out.filter(r => set.has(String(get(r)))); }
      else throw new Error(`fake db: unsupported filter ${key}=${value}`);
    }
    const order = params.get('order');
    if (order) {
      const keys = order.split(',').map(k => { const [col, dir] = k.split('.'); return [col, dir === 'desc' ? -1 : 1]; });
      out = [...out].sort((a, b) => { for (const [k, d] of keys) { if (a[k] < b[k]) return -d; if (a[k] > b[k]) return d; } return 0; });
    }
    return out;
  }
  function base(table, params) {
    tables[table] ||= [];
    if (String(params.get('select') || '').includes('job:tgcloner_clone_jobs!inner')) {
      return tables[table].map(r => ({ ...r, job: (tables.tgcloner_clone_jobs || []).find(j => j.id === r.job_id) })).filter(r => r.job);
    }
    return tables[table];
  }
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const table = u.pathname.split('/rest/v1/')[1];
    const method = init.method || 'GET';
    calls.push({ method, table, query: decodeURIComponent(u.search) });
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-range': `*/${filterRows(base(table, u.searchParams), u.searchParams).length}` } });
    }
    if (method === 'GET') {
      const rows = filterRows(base(table, u.searchParams), u.searchParams);
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = Math.min(Number(u.searchParams.get('limit') || CAP), CAP);
      return new Response(JSON.stringify(rows.slice(offset, offset + limit)), { status: 200 });
    }
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      const rows = (Array.isArray(body) ? body : [body]).map(r => { const t = stamp(); return { id: `row-${nextId++}`, created_at: t, updated_at: t, ...r }; });
      (tables[table] ||= []).push(...rows);
      return new Response(JSON.stringify(rows), { status: 201 });
    }
    if (method === 'PATCH') {
      const values = JSON.parse(init.body);
      const rows = filterRows(tables[table] || [], u.searchParams);
      rows.forEach(r => Object.assign(r, values));
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    throw new Error(`fake db: unsupported ${method}`);
  };
  return { fetch, calls, tables };
}

export function withSupabaseEnv(t, extra = {}) {
  const names = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET', 'READER_CHANNEL_ALLOWLIST'];
  const old = Object.fromEntries(names.map(n => [n, process.env[n]]));
  const oldFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = ['sb', 'secret', 'fake_postgrest_test_key'].join('_');
  process.env.SESSION_SECRET = 'fake-postgrest-session-secret-0123456789';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.READER_CHANNEL_ALLOWLIST;
  Object.assign(process.env, extra);
  t.after(() => {
    global.fetch = oldFetch;
    for (const n of names) { if (old[n] === undefined) delete process.env[n]; else process.env[n] = old[n]; }
  });
}
