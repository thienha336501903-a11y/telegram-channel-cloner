import test from 'node:test';
import assert from 'node:assert/strict';
import { assertConfirmedRepairSnapshot, confirmedDeleteIds, confirmedMappings } from '../scripts/e2e-local/repair-test-copies-core.mjs';

test('repair permits only the four observed local mappings and five exact destination IDs', () => {
  assert.deepEqual(confirmedDeleteIds, [13, 12, 11, 10, 9]);
  assert.doesNotThrow(() => assertConfirmedRepairSnapshot([...confirmedMappings], '0'));
  assert.throws(() => assertConfirmedRepairSnapshot([...confirmedMappings, '56,14,copied'], '0'), /no longer the confirmed/);
  assert.throws(() => assertConfirmedRepairSnapshot(['38,20,copied', ...confirmedMappings.slice(1)], '0'), /no longer the confirmed/);
  assert.throws(() => assertConfirmedRepairSnapshot(['38,10,failed', ...confirmedMappings.slice(1)], '0'), /no longer the confirmed/);
  assert.throws(() => assertConfirmedRepairSnapshot([...confirmedMappings], '1'), /ambiguous or unfinished TEST copy/);
});
