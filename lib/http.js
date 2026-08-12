export function json(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export async function readJson(req, { maxBytes = 2_000_000 } = {}) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Payload too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
  }
}

export function method(req, res, allowed) {
  if (!allowed.includes(req.method)) {
    res.setHeader('Allow', allowed.join(', '));
    json(res, 405, { ok: false, error: 'method_not_allowed' });
    return false;
  }
  return true;
}
