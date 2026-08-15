import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const thumbnail = readFileSync(new URL('../api/telegram/thumbnail.js', import.meta.url), 'utf8');

test('thumbnail gateway caches metadata, file paths, and thumbnail bytes in Runtime Cache', () => {
  assert.match(thumbnail, /getCache/);
  assert.match(thumbnail, /namespace: 'tgcloner-thumbnails-v1'/);
  assert.match(thumbnail, /thumbnail-meta:/);
  assert.match(thumbnail, /bot-file-path:/);
  assert.match(thumbnail, /thumbnail-bytes:/);
  assert.match(thumbnail, /X-Thumbnail-Cache/);
});

test('thumbnail gateway keeps a browser cache after ticket validation', () => {
  assert.match(thumbnail, /THUMBNAIL_BROWSER_TTL_SECONDS = 60 \* 60/);
  assert.match(thumbnail, /Cache-Control', `private, max-age=\$\{THUMBNAIL_BROWSER_TTL_SECONDS\}`/);
});
