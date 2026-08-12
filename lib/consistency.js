export function evaluateConsistency({ messages = [], mappings = [], internalLinks = [] } = {}) {
  const expectedIds = new Set(messages.map((m) => Number(m.source_message_id)));
  const copied = new Map(
    mappings
      .filter((m) => m.status === 'copied' && m.destination_message_id != null)
      .map((m) => [Number(m.source_message_id), Number(m.destination_message_id)])
  );

  const missingMessageIds = [...expectedIds].filter((id) => !copied.has(id)).sort((a, b) => a - b);
  const unresolvedLinkTargets = [...new Set(
    internalLinks
      .map((l) => Number(l.source_message_id))
      .filter((id) => Number.isFinite(id) && !copied.has(id))
  )].sort((a, b) => a - b);

  const pinnedIds = messages.filter((m) => m.is_pinned).map((m) => Number(m.source_message_id));
  const missingPinnedIds = pinnedIds.filter((id) => !copied.has(id)).sort((a, b) => a - b);

  const groups = new Map();
  for (const message of messages) {
    if (!message.media_group_id) continue;
    const group = groups.get(message.media_group_id) || [];
    group.push(Number(message.source_message_id));
    groups.set(message.media_group_id, group);
  }
  const incompleteAlbums = [...groups.entries()]
    .filter(([, ids]) => ids.some((id) => !copied.has(id)))
    .map(([mediaGroupId, ids]) => ({ media_group_id: mediaGroupId, source_message_ids: ids.sort((a, b) => a - b) }));

  return {
    pass: missingMessageIds.length === 0 && unresolvedLinkTargets.length === 0 && missingPinnedIds.length === 0 && incompleteAlbums.length === 0,
    expected_messages: expectedIds.size,
    copied_mappings: copied.size,
    missing_message_ids: missingMessageIds,
    unresolved_link_targets: unresolvedLinkTargets,
    missing_pinned_ids: missingPinnedIds,
    incomplete_albums: incompleteAlbums
  };
}
