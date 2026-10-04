export const confirmedMappings = Object.freeze([
  '38,10,copied', '39,11,copied', '44,12,copied', '55,13,copied'
]);
export const confirmedDeleteIds = Object.freeze([13, 12, 11, 10, 9]);

export function assertConfirmedRepairSnapshot(rows, unsafeWorkCount) {
  if (JSON.stringify(rows) !== JSON.stringify(confirmedMappings)) {
    throw new Error(`Local TEST mapping is no longer the confirmed 4-copy snapshot; observed=${JSON.stringify(rows)}. No Telegram message was deleted.`);
  }
  if (unsafeWorkCount !== '0') {
    throw new Error(`Found ${unsafeWorkCount} ambiguous or unfinished TEST copy work items; no Telegram message was deleted.`);
  }
}
