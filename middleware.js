export default function middleware(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (
    path === '/login' ||
    path === '/login.html' ||
    path.startsWith('/api/login') ||
    path.startsWith('/favicon')
  ) {
    return;
  }

  const expected = 'DPUGBIF';

  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)tosm_auth=([^;]+)/);
  if (match && decodeURIComponent(match[1]) === expected) {
    return;
  }

  return Response.redirect(new URL('/login.html', request.url), 302);
}
