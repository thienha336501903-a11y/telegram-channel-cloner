const DEFAULTS = Object.freeze({
  systemId: 'system-b',
  systemName: 'YeuBep',
  clonerPublicUrl: 'https://reader.yeubep.shop',
  lmsPublicUrl: 'https://hoc.yeubep.shop',
  v4PublicUrl: 'https://v4.daubepnho.store',
  legacyV4Origins: ['https://daubepnho.store', 'https://yeunauan-lms-v4-test.vercel.app', 'https://yeunauan-lms-clone.vercel.app']
});

const OWNED_LMS_VERCEL_HOSTS = [
  /^yeunauan-lms-v4-test-[a-z0-9-]+-thienha336501903-a11ys-projects\.vercel\.app$/,
  /^yeunauan-lms-(?:clone-|git-)?[a-z0-9-]+-thienha100022653824678-stacks-projects\.vercel\.app$/
];

export function cleanConfigValue(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

export function httpsOrigin(value, fallback = '') {
  const candidate = cleanConfigValue(value || fallback);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) && !/^https:\/\//i.test(candidate)) {
    throw new Error('clone_config_invalid_https_origin');
  }
  const url = new URL(/^https:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('clone_config_invalid_https_origin');
  }
  return url.origin;
}

export function cloneConfig(env = process.env) {
  const clonerPublicUrl = httpsOrigin(env.CLONER_PUBLIC_URL || env.READER_MANAGER_PUBLIC_URL, DEFAULTS.clonerPublicUrl);
  const lmsPublicUrl = httpsOrigin(env.LMS_PUBLIC_URL, DEFAULTS.lmsPublicUrl);
  const v4PublicUrl = httpsOrigin(env.V4_PUBLIC_URL, DEFAULTS.v4PublicUrl);
  const explicitOrigins = cleanConfigValue(env.V4_ALLOWED_ORIGINS).split(',').map(value => value.trim()).filter(Boolean);
  const vercelOrigins = [env.VERCEL_BRANCH_URL, env.VERCEL_URL]
    .map(value => cleanConfigValue(value))
    .filter(Boolean)
    .map(value => httpsOrigin(value));
  return Object.freeze({
    systemId: cleanConfigValue(env.SYSTEM_ID) || DEFAULTS.systemId,
    systemName: cleanConfigValue(env.SYSTEM_NAME) || DEFAULTS.systemName,
    clonerPublicUrl,
    lmsPublicUrl,
    v4PublicUrl,
    v4AllowedOrigins: [...new Set([v4PublicUrl, lmsPublicUrl, ...DEFAULTS.legacyV4Origins, ...explicitOrigins, ...vercelOrigins])]
  });
}

export function isConfiguredV4Origin(origin, env = process.env) {
  const value = cleanConfigValue(origin);
  if (cloneConfig(env).v4AllowedOrigins.includes(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return false;
    const host = url.hostname.toLowerCase();
    return OWNED_LMS_VERCEL_HOSTS.some(pattern => pattern.test(host));
  } catch {
    return false;
  }
}

export { DEFAULTS as CLONE_CONFIG_DEFAULTS };
