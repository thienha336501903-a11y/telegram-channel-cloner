import test from 'node:test';
import assert from 'node:assert/strict';
import { botApiChatIdToPrivateLinkId, destinationMessageLink, extractInternalLinks, rewriteInternalLinks, rewriteTextAndEntities } from '../lib/links.js';

test('converts -100 chat id to private link id', () => {
  assert.equal(botApiChatIdToPrivateLinkId('-1004296153365'), '4296153365');
});

test('extracts only links belonging to source private channel', () => {
  const text = 'A https://t.me/c/4296153365/10 B https://t.me/c/999/2';
  assert.deepEqual(extractInternalLinks(text, { private_link_id: '4296153365' }).map(x => x.source_message_id), [10]);
});

test('rewrites private source links to private destination links', () => {
  const result = rewriteInternalLinks('HD3 https://t.me/c/4296153365/10', {
    source: { private_link_id: '4296153365' },
    destination: { chat_id: '-1007778889990' },
    mappings: new Map([[10, 417]])
  });
  assert.equal(result.text, 'HD3 https://t.me/c/7778889990/417');
  assert.equal(result.rewritten, 1);
  assert.deepEqual(result.unresolved, []);
});

test('rewrites public source links to destination username links', () => {
  const result = rewriteInternalLinks('See https://t.me/master_course/10', {
    source: { username: 'master_course' },
    destination: { chat_id: '-1007778889990', username: 'clone_a' },
    mappings: { 10: 44 }
  });
  assert.equal(result.text, 'See https://t.me/clone_a/44');
});

test('reports unresolved mappings without leaking false replacement', () => {
  const original = 'See https://t.me/c/4296153365/99';
  const result = rewriteInternalLinks(original, {
    source: { private_link_id: '4296153365' },
    destination: { chat_id: '-1007778889990' },
    mappings: new Map()
  });
  assert.equal(result.text, original);
  assert.deepEqual(result.unresolved, [99]);
});

test('shifts later Telegram entities when URL length changes', () => {
  const text = 'X https://t.me/c/4296153365/10 Y';
  const urlStart = text.indexOf('https://');
  const yStart = text.lastIndexOf('Y');
  const result = rewriteTextAndEntities(text, [
    { type: 'url', offset: urlStart, length: 'https://t.me/c/4296153365/10'.length },
    { type: 'bold', offset: yStart, length: 1 }
  ], {
    source: { private_link_id: '4296153365' },
    destination: { chat_id: '-1007' },
    mappings: new Map([[10, 1234]])
  });
  assert.equal(result.text, 'X https://t.me/c/7/1234 Y');
  assert.equal(result.entities[1].offset, result.text.lastIndexOf('Y'));
});

test('builds public destination link when username exists', () => {
  assert.equal(destinationMessageLink({ destinationChatId: '-1001', destinationUsername: '@abcde', messageId: 5 }), 'https://t.me/abcde/5');
});
