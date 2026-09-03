import { clearSessionCookie } from '../../lib/auth.js';
import { json, method } from '../../lib/http.js';
export default async function handler(req, res) {
  if (!method(req, res, ['POST'])) return;
  res.setHeader('Set-Cookie', clearSessionCookie());
  json(res, 200, { ok: true });
}
