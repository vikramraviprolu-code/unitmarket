// Page security headers (SOP 10). Runs on the Node.js runtime so the nonce comes from the same
// injected Ids as the route wrapper's. Middleware is a convenience layer only: authorisation runs in
// withRoute and in the data access functions (architecture 9.8), never here.
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { maintenanceActive, newNonce } from '../composition.server';
import { pageHeaders } from './lib/page-headers';

export const config = {
  runtime: 'nodejs',
  // Pages only: route handlers set their own headers through withRoute; static assets need none.
  matcher: [{ source: '/((?!api/|c/|healthz|_next/static|_next/image|favicon.ico).*)' }],
};

export function middleware(req: NextRequest): NextResponse {
  // CO-7b (D-037): in maintenance mode a page is not served; the database behind it is closed anyway.
  // The API, content and health routes are not matched here: withRoute answers for them.
  if (maintenanceActive())
    return NextResponse.json(
      { error: { code: 'maintenance', message: 'The service is down for maintenance.' } },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  const nonce = newNonce();
  const headers = pageHeaders(nonce);
  const forward = new Headers(req.headers);
  forward.set('x-nonce', nonce);
  forward.set('content-security-policy', headers['Content-Security-Policy'] ?? '');
  const res = NextResponse.next({ request: { headers: forward } });
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}
