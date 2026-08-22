import test from 'node:test';
import assert from 'node:assert/strict';

function staleIds(indexedIds, presentIds, upperBound) {
  const present = new Set(presentIds.filter(id => id <= upperBound));
  return indexedIds.filter(id => id <= upperBound && !present.has(id));
}

test('reconcile deletes only missing ids at or below frozen upper bound', () => {
  assert.deepEqual(staleIds([1, 2, 3, 4, 5], [1, 3, 5], 5), [2, 4]);
});

test('new rows above frozen upper bound survive even when absent from snapshot', () => {
  assert.deepEqual(staleIds([10, 11, 12, 13], [10, 12], 12), [11]);
});

test('telegram ids above upper bound do not affect old-snapshot deletion', () => {
  assert.deepEqual(staleIds([20, 21, 22], [20, 22, 23, 24], 22), [21]);
});
