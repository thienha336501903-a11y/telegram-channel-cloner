import { cloneConfig } from '../lib/clone-config.js';

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const config = cloneConfig();
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  return res.status(200).send(`window.CLONE_RUNTIME_CONFIG=${JSON.stringify({
    systemId: config.systemId,
    systemName: config.systemName,
    clonerPublicUrl: config.clonerPublicUrl,
    lmsPublicUrl: config.lmsPublicUrl,
    v4PublicUrl: config.v4PublicUrl
  })};`);
}
