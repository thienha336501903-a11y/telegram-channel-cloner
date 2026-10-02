export async function verifyTestBot({ token, expectedUsername, fetchImpl = fetch }) {
  if (!token) throw new Error('TEST bot token is required');
  const expected = String(expectedUsername || 'yeubep_distributor_test_bot').replace(/^@/, '').trim().toLowerCase();
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`);
  const body = await response.json();
  const actual = String(body?.result?.username || '').toLowerCase();
  if (!response.ok || body?.ok !== true || actual !== expected) {
    throw new Error(`Refusing E2E: token belongs to @${actual || 'unknown'}, expected @${expected}`);
  }
  return actual;
}
