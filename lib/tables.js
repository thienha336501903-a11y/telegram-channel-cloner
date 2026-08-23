export const TABLES = Object.freeze({
  sources: 'tgcloner_sources',
  destinations: 'tgcloner_destinations',
  sourceMessages: 'tgcloner_source_messages',
  messageMappings: 'tgcloner_message_mappings',
  cloneJobs: 'tgcloner_clone_jobs',
  cloneJobItems: 'tgcloner_clone_job_items',
  internalLinks: 'tgcloner_internal_links',
  syncEvents: 'tgcloner_sync_events',
  schedulerNonces: 'tgcloner_scheduler_nonces',
  settings: 'tgcloner_settings',
  readerJobs: 'tgcloner_reader_jobs',
  readerAgents: 'tgcloner_reader_agents',
  readerProfiles: 'tgcloner_reader_profiles',
  readerPairings: 'tgcloner_reader_pairings',
  readerSourceAccess: 'tgcloner_reader_source_access'
});

export function assertTgClonerTableName(name) {
  if (!Object.values(TABLES).includes(name) || !name.startsWith('tgcloner_')) {
    throw new Error(`Refusing non-tgcloner table: ${name}`);
  }
  return name;
}
