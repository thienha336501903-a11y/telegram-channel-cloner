import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const repository = read('lib/repository.js');
assert.match(repository, /export async function getSourceByChatId/);
assert.match(repository, /select=\*&chat_id=eq\./);

const webhook = read('api/telegram/webhook.js');
assert.match(webhook, /getSourceByChatId/);
assert.match(webhook, /if \(!source\?\.active\) return/);
assert.match(webhook, /indexed: true, mirrored: Boolean\(source\.active\)/);
assert.doesNotMatch(webhook, /getActiveSourceByChatId/);

const edge = read('supabase/functions/tgcloner-telegram-webhook/index.ts');
assert.match(edge, /`select=\*&chat_id=eq\.\$\{encodeURIComponent\(chatId\)\}&limit=1`/);
assert.match(edge, /if \(source\.active === true\)/);
assert.match(edge, /indexed: true, mirrored: source\.active === true/);
assert.doesNotMatch(edge, /select=\*&active=eq\.true&chat_id/);

console.log('V4 multi-source live indexing checks passed');
