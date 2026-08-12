import test from 'node:test';
import assert from 'node:assert/strict';
import { TABLES, assertTgClonerTableName } from '../lib/tables.js';

test('every application table is isolated with tgcloner_ prefix', () => {
  const names = Object.values(TABLES);
  assert.equal(names.length, 8);
  for (const name of names) {
    assert.match(name, /^tgcloner_/);
    assert.equal(assertTgClonerTableName(name), name);
  }
});

test('database guard rejects non-tgcloner tables', () => {
  assert.throws(() => assertTgClonerTableName('courses'), /Refusing non-tgcloner table/);
  assert.throws(() => assertTgClonerTableName('telegram_sources'), /Refusing non-tgcloner table/);
});
