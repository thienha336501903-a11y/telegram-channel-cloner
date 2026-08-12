import { createSessionCookie, verifyPassword } from '../../lib/auth.js';
import { json, method, readJson } from '../../lib/http.js';

export default async function handler(req, res) {
  if (!method(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!verifyPassword(body.password)) return json(res, 401, { ok: false, error: 'invalid_credentials' });
  res.setHeader('Set-Cookie', createSessionCookie());
  json(res, 200, { ok: true });
}
