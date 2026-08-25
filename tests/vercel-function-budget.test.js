import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function functionFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? functionFiles(absolute) : entry.name.endsWith('.js') ? [absolute] : [];
  });
}

test('Vercel Hobby deployment stays within the 12-function limit', () => {
  const apiDirectory = fileURLToPath(new URL('../api', import.meta.url));
  const files = functionFiles(apiDirectory);
  assert.ok(files.length <= 12, `expected at most 12 functions, found ${files.length}`);
});

test('public Clone Factory config is routed through the existing admin function', () => {
  const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const rewrite = vercel.rewrites.find(item => item.source === '/api/public-config.js');
  assert.equal(rewrite?.destination, '/api/admin?action=public-config');
});
