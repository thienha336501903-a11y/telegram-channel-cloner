import { json, method, readJson } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { extractInternalLinks } from '../../lib/links.js';
import { recordInternalLinks, upsertSourceMessage } from '../../lib/repository.js';
import { select } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!method(req, res, ['POST'])) return;
  if (req.headers.authorization !== `Bearer ${requireEnv('READER_INGEST_SECRET')}`) return json(res, 401, { ok: false, error: 'unauthorized' });
  const body = await readJson(req, { maxBytes: 8_000_000 });
  if (!body.source_id || !Array.isArray(body.messages)) return json(res, 400, { ok: false, error: 'source_id_and_messages_required' });
  const sources = await select('telegram_sources', `select=*&id=eq.${encodeURIComponent(body.source_id)}&limit=1`);
  const source = sources[0];
  if (!source) return json(res, 404, { ok: false, error: 'source_not_found' });

  let savedCount = 0;
  let linkCount = 0;
  for (const m of body.messages) {
    const textLinks = extractInternalLinks(m.text, source).map((x) => ({ ...x, location: 'text' }));
    const captionLinks = extractInternalLinks(m.caption, source).map((x) => ({ ...x, location: 'caption' }));
    const links = [...textLinks, ...captionLinks];
    const [saved] = await upsertSourceMessage({
      source_id: source.id,
      source_message_id: Number(m.source_message_id),
      media_group_id: m.media_group_id || null,
      message_type: m.message_type || 'other',
      text: m.text ?? null,
      text_entities: m.text_entities || [],
      caption: m.caption ?? null,
      caption_entities: m.caption_entities || [],
      reply_to_source_message_id: m.reply_to_source_message_id || null,
      is_pinned: Boolean(m.is_pinned),
      raw_message: m.raw_message || {},
      source_date: m.source_date || null,
      has_internal_links: links.length > 0,
      updated_at: new Date().toISOString()
    });
    await recordInternalLinks(source.id, saved.id, links);
    savedCount += 1;
    linkCount += links.length;
  }
  json(res, 200, { ok: true, saved: savedCount, internal_links: linkCount });
}
