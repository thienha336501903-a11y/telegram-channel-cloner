import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const supabase = read('lib/supabase.js');
assert.match(supabase, /export async function count\(/);
assert.match(supabase, /method: 'HEAD'/);
assert.match(supabase, /Prefer: 'count=exact'/);
assert.match(supabase, /content-range/);

const repository = read('lib/repository.js');
assert.match(repository, /export async function syncSourceIndexedMessageCount/);
assert.match(repository, /count\(TABLES\.sourceMessages/);
assert.match(repository, /indexed_message_count=eq\./);
assert.match(repository, /source_index_count_concurrent_update/);

const webhook = read('api/telegram/webhook.js');
assert.match(webhook, /syncSourceIndexedMessageCount/);
assert.match(webhook, /await syncSourceIndexedMessageCount\(source\.id\)/);

const edge = read('supabase/functions/tgcloner-telegram-webhook/index.ts');
assert.match(edge, /async function countRows/);
assert.match(edge, /prefer', 'count=exact'/);
assert.match(edge, /async function syncSourceIndexedMessageCount/);
assert.match(edge, /await syncSourceIndexedMessageCount\(source\.id\)/);

console.log('V4 live exact index count checks passed');
