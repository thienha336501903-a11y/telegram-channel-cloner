import { clearSessionCookie } from '../../lib/auth.js';
import { json } from '../../lib/http.js';
export default async function handler(req, res) {
  res.setHeader('Set-Cookie', clearSessionCookie());
  json(res, 200, { ok: true });
}
