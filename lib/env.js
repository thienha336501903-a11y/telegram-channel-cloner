export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function cloneSafetyConfig() {
  return {
    minDestinationDelayMs: intEnv('CLONE_MIN_DESTINATION_DELAY_MS', 2000, { min: 1000, max: 60_000 }),
    maxWritesPerTick: intEnv('CLONE_MAX_WRITES_PER_TICK', 5, { min: 1, max: 20 }),
    maxDestinationsPerTick: intEnv('CLONE_MAX_DESTINATIONS_PER_TICK', 5, { min: 1, max: 10 })
  };
}
