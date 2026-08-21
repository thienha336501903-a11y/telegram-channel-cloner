const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const PRIVATE_RE = /https?:\/\/(?:t\.me|telegram\.me)\/c\/(\d+)\/(\d+)(?:\?[^\s<]*)?/gi;
const PUBLIC_RE = /https?:\/\/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{5,})\/(\d+)(?:\?[^\s<]*)?/gi;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function detectMessageType(m: Record<string, unknown>) {
  if (m.text) return 'text';
  if (m.photo) return 'photo';
  if (m.video) return 'video';
  if (m.document) return 'document';
  if (m.audio) return 'audio';
  if (m.voice) return 'voice';
  if (m.animation) return 'animation';
  if (m.video_note) return 'video_note';
  if (m.sticker) return 'sticker';
  return 'other';
}

function extractInternalLinks(text: unknown, source: Record<string, unknown>) {
  if (!text) return [] as Array<{ full: string; source_message_id: number; kind: string }>;
  const value = String(text);
  const found: Array<{ full: string; source_message_id: number; kind: string }> = [];
  const sourcePrivateId = source.private_link_id ? String(source.private_link_id) : null;
  const sourceUsername = source.username ? String(source.username).replace(/^@/, '').toLowerCase() : null;

  PRIVATE_RE.lastIndex = 0;
  for (const match of value.matchAll(PRIVATE_RE)) {
    if (sourcePrivateId && match[1] === sourcePrivateId) {
      found.push({ full: match[0], source_message_id: Number(match[2]), kind: 'private' });
    }
  }
  PUBLIC_RE.lastIndex = 0;
  for (const match of value.matchAll(PUBLIC_RE)) {
    if (match[1].toLowerCase() === 'c') continue;
    if (sourceUsername && match[1].toLowerCase() === sourceUsername) {
      found.push({ full: match[0], source_message_id: Number(match[2]), kind: 'public' });
    }
  }
  return found;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function rest(path: string, init: RequestInit = {}) {
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('Supabase function environment is incomplete');
  const headers = new Headers(init.headers || {});
  headers.set('apikey', SERVICE_ROLE);
  headers.set('authorization', `Bearer ${SERVICE_ROLE}`);
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase REST ${response.status}: ${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : null;
}

async function selectRows(table: string, query: string) {
  return await rest(`${table}?${query}`, { method: 'GET' }) as Record<string, unknown>[];
}

async function countRows(table: string, query = '') {
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('Supabase function environment is incomplete');
  const headers = new Headers();
  headers.set('apikey', SERVICE_ROLE);
  headers.set('authorization', `Bearer ${SERVICE_ROLE}`);
  headers.set('prefer', 'count=exact');
  const suffix = query ? `&${query}` : '';
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id${suffix}`, {
    method: 'HEAD',
    headers
  });
  if (!response.ok) throw new Error(`Supabase REST ${response.status}`);
  const contentRange = String(response.headers.get('content-range') || '');
  const total = Number(contentRange.split('/')[1]);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Supabase exact count missing');
  return total;
}

async function insertRows(table: string, rows: unknown) {
  return await rest(table, {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(rows)
  }) as Record<string, unknown>[];
}

async function upsertRows(table: string, rows: unknown, onConflict: string) {
  return await rest(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows)
  }) as Record<string, unknown>[];
}

async function patchRows(table: string, query: string, values: unknown) {
  return await rest(`${table}?${query}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(values)
  }) as Record<string, unknown>[];
}

async function syncSourceIndexedMessageCount(sourceId: unknown) {
  const value = String(sourceId || '').trim();
  if (!value) return null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rows = await selectRows(
      'tgcloner_sources',
      `select=id,indexed_message_count&id=eq.${encodeURIComponent(value)}&limit=1`
    );
    const source = rows?.[0];
    if (!source) return null;

    const actual = await countRows('tgcloner_source_messages', `source_id=eq.${encodeURIComponent(value)}`);
    const rawCurrent = source.indexed_message_count;
    const currentNumber = Number(rawCurrent ?? 0);
    const current = Number.isSafeInteger(currentNumber) && currentNumber >= 0 ? currentNumber : 0;
    if (current === actual) return source;

    const countFilter = rawCurrent === null || rawCurrent === undefined
      ? 'indexed_message_count=is.null'
      : `indexed_message_count=eq.${current}`;
    const updated = await patchRows(
      'tgcloner_sources',
      `id=eq.${encodeURIComponent(value)}&${countFilter}`,
      { indexed_message_count: actual, updated_at: new Date().toISOString() }
    );
    if (updated?.length) return updated[0];
  }

  throw new Error('source_index_count_concurrent_update');
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  try {
    const providedSecret = req.headers.get('x-telegram-bot-api-secret-token') || '';
    if (!providedSecret) return json(401, { ok: false });

    const settings = await selectRows('tgcloner_settings', 'select=webhook_secret_sha256&singleton=eq.true&limit=1');
    const expectedHash = String(settings?.[0]?.webhook_secret_sha256 || '');
    if (!expectedHash) return json(503, { ok: false, error: 'webhook_secret_not_configured' });
    const providedHash = await sha256Hex(providedSecret);
    if (!timingSafeEqualHex(providedHash, expectedHash)) return json(401, { ok: false });

    const contentLength = Number(req.headers.get('content-length') || 0);
    if (contentLength > 5_000_000) return json(413, { ok: false, error: 'payload_too_large' });
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 5_000_000) return json(413, { ok: false, error: 'payload_too_large' });
    const update = raw ? JSON.parse(raw) : {};
    const message = update.channel_post || update.edited_channel_post;
    if (!message) return json(200, { ok: true, ignored: true });

    const chatId = String(message.chat?.id ?? '').trim();
    if (!chatId) return json(200, { ok: true, ignored: true });
    // All registered sources keep receiving live index updates for V4 courses.
    // Only source.active=true is treated as MASTER for clone/mirror jobs.
    const sources = await selectRows(
      'tgcloner_sources',
      `select=*&chat_id=eq.${encodeURIComponent(chatId)}&limit=1`
    );
    const source = sources?.[0];
    if (!source) return json(200, { ok: true, ignored: true });

    const text = message.text ?? null;
    const caption = message.caption ?? null;
    const links = [
      ...extractInternalLinks(text, source).map(link => ({ ...link, location: 'text' })),
      ...extractInternalLinks(caption, source).map(link => ({ ...link, location: 'caption' }))
    ];

    const normalized = {
      source_id: source.id,
      source_message_id: Number(message.message_id),
      media_group_id: message.media_group_id || null,
      message_type: detectMessageType(message),
      text,
      text_entities: message.entities ?? [],
      caption,
      caption_entities: message.caption_entities ?? [],
      reply_to_source_message_id: message.reply_to_message?.message_id ?? null,
      is_pinned: Boolean(message.pinned_message),
      raw_message: message,
      source_date: message.date ? new Date(message.date * 1000).toISOString() : null,
      has_internal_links: links.length > 0,
      updated_at: new Date().toISOString()
    };

    const savedRows = await upsertRows('tgcloner_source_messages', normalized, 'source_id,source_message_id');
    const saved = savedRows?.[0];
    if (!saved?.id) throw new Error('source_message_upsert_returned_no_id');
    await syncSourceIndexedMessageCount(source.id);

    if (links.length) {
      await upsertRows(
        'tgcloner_internal_links',
        links.map(link => ({
          source_id: source.id,
          source_message_db_id: saved.id,
          source_message_id: link.source_message_id,
          location: link.location,
          original_url: link.full
        })),
        'source_message_db_id,location,original_url'
      );
    }

    if (source.active === true) {
      const destinations = await selectRows('tgcloner_destinations', 'select=*&active=eq.true&order=created_at.asc');
      const targets = (destinations || []).filter(destination => destination.source_id === source.id || !destination.source_id);
      const edited = Boolean(update.edited_channel_post);

      for (const destination of targets) {
        const jobs = await insertRows('tgcloner_clone_jobs', {
          source_id: source.id,
          destination_id: destination.id,
          mode: 'live_mirror',
          status: 'queued'
        });
        const job = jobs?.[0];
        if (!job?.id) throw new Error('clone_job_insert_returned_no_id');

        if (!edited) {
          await insertRows('tgcloner_clone_job_items', {
            job_id: job.id,
            source_message_id: normalized.source_message_id,
            source_message_ids: [normalized.source_message_id],
            phase: 'copy',
            status: 'queued'
          });
        }
        if (edited || links.length > 0) {
          await insertRows('tgcloner_clone_job_items', {
            job_id: job.id,
            source_message_id: normalized.source_message_id,
            source_message_ids: [normalized.source_message_id],
            phase: 'rewrite',
            status: 'queued'
          });
        }
      }
    }

    return json(200, { ok: true, indexed: true, mirrored: source.active === true });
  } catch (error) {
    console.error('[tgcloner-telegram-webhook]', error instanceof Error ? error.message : String(error));
    return json(500, { ok: false, error: 'internal_error' });
  }
});
