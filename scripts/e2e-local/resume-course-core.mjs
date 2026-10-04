// The previously confirmed five TEST posts are the immutable restart checkpoint.
export const COURSE_SOURCE = '-1003535777660';
export const COURSE_DESTINATION = '-1004492904064';
export const PREFIX_SOURCE_IDS = Object.freeze([2, 3, 4, 5, 7]);
export const PREFIX_DESTINATION_IDS = Object.freeze([14, 15, 16, 17, 18]);

export function validateResumeMappings(mappings, messages) {
  const ids = messages.map((message) => Number(message.source_message_id));
  if (ids.length <= PREFIX_SOURCE_IDS.length || PREFIX_SOURCE_IDS.some((id, index) => ids[index] !== id)) {
    throw new Error('Full course no longer starts with the confirmed five source posts');
  }
  const rows = [...mappings].sort((a, b) => Number(a.source_message_id) - Number(b.source_message_id));
  if (rows.length < 5 || rows.length > ids.length) throw new Error('Local TEST mapping count does not match the confirmed prefix');
  for (const [index, row] of rows.entries()) {
    const sourceId = Number(row.source_message_id);
    const destinationId = Number(row.destination_message_id);
    if (row.status !== 'copied' || sourceId !== ids[index] || !Number.isSafeInteger(destinationId) || destinationId <= 0) {
      throw new Error(`TEST mapping mismatch at chronological position ${index + 1}`);
    }
    if (index < 5 && destinationId !== PREFIX_DESTINATION_IDS[index]) {
      throw new Error(`Confirmed TEST destination ID changed at source post ${sourceId}`);
    }
    if (index && destinationId <= Number(rows[index - 1].destination_message_id)) {
      throw new Error('TEST destination mappings are no longer chronological');
    }
  }
  const albumUnits = new Map();
  for (const [index, message] of messages.entries()) {
    if (!message.media_group_id) continue;
    const positions = albumUnits.get(message.media_group_id) || [];
    positions.push(index);
    albumUnits.set(message.media_group_id, positions);
  }
  for (const positions of albumUnits.values()) {
    if (positions.some((position) => position < rows.length) && positions.some((position) => position >= rows.length)) {
      throw new Error('Local TEST mapping ends inside an album');
    }
  }
  return rows;
}
