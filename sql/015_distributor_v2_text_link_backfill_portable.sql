-- PostgreSQL standard_conforming_strings keeps backslashes literal, so use
-- character classes for dots in the URL host regex. This migration is idempotent
-- and repairs any existing hidden MessageEntityTextUrl rows missed by 013.

update public.tgcloner_source_messages m
set has_internal_links = true,
    updated_at = now()
from public.tgcloner_sources s
where s.id = m.source_id
  and not m.has_internal_links
  and (
    exists (
      select 1 from jsonb_array_elements(coalesce(m.text_entities, '[]'::jsonb)) e
      where e->>'type' = 'text_link'
        and (
          (s.private_link_id is not null and e->>'url' ~ ('^https?://(t[.]me|telegram[.]me)/c/' || s.private_link_id || '/[0-9]+'))
          or
          (s.username is not null and lower(e->>'url') ~ ('^https?://(t[.]me|telegram[.]me)/(s/)?' || lower(regexp_replace(s.username, '^@', '')) || '/[0-9]+'))
        )
    )
    or exists (
      select 1 from jsonb_array_elements(coalesce(m.caption_entities, '[]'::jsonb)) e
      where e->>'type' = 'text_link'
        and (
          (s.private_link_id is not null and e->>'url' ~ ('^https?://(t[.]me|telegram[.]me)/c/' || s.private_link_id || '/[0-9]+'))
          or
          (s.username is not null and lower(e->>'url') ~ ('^https?://(t[.]me|telegram[.]me)/(s/)?' || lower(regexp_replace(s.username, '^@', '')) || '/[0-9]+'))
        )
    )
  );
