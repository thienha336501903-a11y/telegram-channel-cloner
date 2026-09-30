#!/usr/bin/env python3
"""Read-only Telegram verifier for the isolated Distributor V2 E2E harness."""
import asyncio
import os
import re
import requests
from telethon import TelegramClient
from telethon.tl.types import InputMessagesFilterPinned, MessageEntityTextUrl

BASE = os.getenv('SUPABASE_URL', 'http://127.0.0.1:54321').rstrip('/')
APIKEY = os.getenv('SUPABASE_SECRET_KEY', 'sb_secret_e2e')
SOURCE_CHAT = os.getenv('E2E_SOURCE_CHAT_ID', '').strip()
DEST_CHATS = [x.strip() for x in os.getenv('E2E_DESTINATION_CHAT_IDS', '').split(',') if x.strip()]
API_ID = int(os.getenv('TELEGRAM_API_ID', '0') or 0)
API_HASH = os.getenv('TELEGRAM_API_HASH', '').strip()


def rest(table, query):
    response = requests.get(f'{BASE}/rest/v1/{table}?{query}', headers={'apikey': APIKEY}, timeout=30)
    response.raise_for_status()
    return response.json()


def mtproto_id(bot_chat_id):
    raw = str(bot_chat_id)
    if not re.fullmatch(r'-100\d+', raw):
        raise ValueError(f'Expected Bot API channel id, got {raw}')
    return -1000000000000 - int(raw)


async def resolve_channel(client, bot_chat_id):
    wanted = mtproto_id(bot_chat_id)
    async for dialog in client.iter_dialogs():
        entity = getattr(dialog, 'entity', None)
        if getattr(entity, 'id', None) is not None and int(entity.id) == wanted:
            return entity
    raise RuntimeError(f'Reader account cannot resolve channel {bot_chat_id}')


def expected_link(destination, destination_message_id):
    username = getattr(destination, 'username', None)
    if username:
        return f'https://t.me/{username}/{destination_message_id}'
    return f'https://t.me/c/{int(destination.id)}/{destination_message_id}'


def entity_urls(message):
    values = []
    for entity in getattr(message, 'entities', None) or []:
        if isinstance(entity, MessageEntityTextUrl):
            values.append(entity.url)
    return values


async def main():
    if not SOURCE_CHAT or not DEST_CHATS or not API_ID or not API_HASH:
        raise RuntimeError('E2E_SOURCE_CHAT_ID, E2E_DESTINATION_CHAT_IDS, TELEGRAM_API_ID and TELEGRAM_API_HASH are required')

    sources = rest('tgcloner_sources', f'select=*&chat_id=eq.{SOURCE_CHAT}&limit=1')
    if not sources:
        raise RuntimeError('Source row missing from isolated DB')
    source = sources[0]
    source_messages = rest('tgcloner_source_messages', f'select=*&source_id=eq.{source["id"]}&order=source_message_id.asc')
    source_by_db = {row['id']: row for row in source_messages}
    source_private = str(source.get('private_link_id') or '')
    source_username = str(source.get('username') or '').lstrip('@').lower()
    links = rest('tgcloner_internal_links', f'select=*&source_id=eq.{source["id"]}')

    async with TelegramClient('telegram-cloner-e2e-reader', API_ID, API_HASH) as client:
        source_entity = await resolve_channel(client, SOURCE_CHAT)
        source_pinned = [int(msg.id) async for msg in client.iter_messages(source_entity, filter=InputMessagesFilterPinned)]
        db_pinned = [int(row['source_message_id']) for row in source_messages if row.get('is_pinned')]
        if sorted(source_pinned) != sorted(db_pinned):
            raise RuntimeError(f'Source pin drift: Telegram={source_pinned}, DB={db_pinned}')

        for destination_chat in DEST_CHATS:
            destination_rows = rest('tgcloner_destinations', f'select=*&chat_id=eq.{destination_chat}&limit=1')
            if not destination_rows:
                raise RuntimeError(f'Destination row missing: {destination_chat}')
            destination = destination_rows[0]
            mappings = rest('tgcloner_message_mappings', f'select=*&destination_id=eq.{destination["id"]}&status=eq.copied&order=source_message_id.asc')
            map_by_source = {int(row['source_message_id']): int(row['destination_message_id']) for row in mappings}
            if len(map_by_source) < len(source_messages):
                raise RuntimeError(f'{destination_chat}: incomplete mappings {len(map_by_source)}/{len(source_messages)}')

            entity = await resolve_channel(client, destination_chat)
            ids = list(map_by_source.values())
            fetched = await client.get_messages(entity, ids=ids)
            if not isinstance(fetched, list):
                fetched = [fetched]
            by_id = {int(msg.id): msg for msg in fetched if msg is not None}
            if len(by_id) != len(ids):
                raise RuntimeError(f'{destination_chat}: some mapped Telegram messages cannot be read')

            groups = {}
            for row in source_messages:
                if row.get('media_group_id'):
                    groups.setdefault(row['media_group_id'], []).append(int(row['source_message_id']))
            for source_ids in groups.values():
                if len(source_ids) < 2:
                    continue
                dest_group_ids = {getattr(by_id[map_by_source[sid]], 'grouped_id', None) for sid in source_ids}
                if None in dest_group_ids or len(dest_group_ids) != 1:
                    raise RuntimeError(f'{destination_chat}: album grouping mismatch for source {source_ids}')

            for row in source_messages:
                if row.get('message_type') != 'video':
                    continue
                msg = by_id[map_by_source[int(row['source_message_id'])]]
                mime = str(getattr(getattr(msg, 'document', None), 'mime_type', '') or '')
                if not getattr(msg, 'video', None) and not mime.startswith('video/'):
                    raise RuntimeError(f'{destination_chat}: mapped video is not a Telegram video/document')
                data = await client.download_media(msg, file=bytes)
                if not data:
                    raise RuntimeError(f'{destination_chat}: mapped video media cannot be downloaded/read')

            for link in links:
                container = source_by_db.get(link['source_message_db_id'])
                if not container:
                    raise RuntimeError('Internal-link row points to missing source message')
                container_source_id = int(container['source_message_id'])
                target_source_id = int(link['source_message_id'])
                container_dest_id = map_by_source[container_source_id]
                target_dest_id = map_by_source[target_source_id]
                msg = by_id[container_dest_id]
                expected = expected_link(entity, target_dest_id)
                text = str(getattr(msg, 'raw_text', '') or '')
                urls = entity_urls(msg)
                if expected not in text and expected not in urls:
                    raise RuntimeError(f'{destination_chat}: rewritten target missing: {expected}')
                if source_private and f't.me/c/{source_private}/' in text:
                    raise RuntimeError(f'{destination_chat}: source private literal link remains')
                if source_private and any(f't.me/c/{source_private}/' in url for url in urls):
                    raise RuntimeError(f'{destination_chat}: source private hidden link remains')
                if source_username and f't.me/{source_username}/' in text.lower():
                    raise RuntimeError(f'{destination_chat}: source public literal link remains')
                if source_username and any(f't.me/{source_username}/' in url.lower() for url in urls):
                    raise RuntimeError(f'{destination_chat}: source public hidden link remains')

            pinned = [int(msg.id) async for msg in client.iter_messages(entity, filter=InputMessagesFilterPinned)]
            expected_pinned = [map_by_source[sid] for sid in db_pinned]
            if sorted(pinned) != sorted(expected_pinned):
                raise RuntimeError(f'{destination_chat}: pin mismatch Telegram={pinned}, expected={expected_pinned}')

            print(f'E2E_TELEGRAM_DESTINATION_PASS {destination_chat} mappings={len(map_by_source)}')

    print('E2E_TELEGRAM_READONLY_VERIFICATION_PASS')


if __name__ == '__main__':
    asyncio.run(main())
