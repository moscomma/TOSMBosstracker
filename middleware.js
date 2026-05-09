export const config = {
  matcher: ['/((?!api/login|login\\.html|favicon).*)'],
};

export default function middleware(req) {
  const cookie = req.cookies.get('tosm_auth');
  const expected = process.env.WEBSITE_PASSWORD;
  if (expected && cookie && cookie.value === expected) return;
  const url = new URL('/login.html', req.url);
  return Response.redirect(url, 302);
}
