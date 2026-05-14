export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const password = body && body.password;
  const name = (body && body.name || '').trim().slice(0, 20);
  const expected = 'DPUGBIF';
  if (!name) {
    return res.status(400).json({ ok: false, error: 'Name required' });
  }
  if (password !== expected) {
    return res.status(401).json({ ok: false, error: 'Wrong password' });
  }
  res.setHeader(
    'Set-Cookie',
    `tosm_auth=${encodeURIComponent(expected)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`
  );
  return res.status(200).json({ ok: true });
}
