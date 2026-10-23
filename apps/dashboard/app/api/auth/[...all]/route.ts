import { OPERATOR_URL } from '@/lib/api';

// Hop-by-hop headers, and encodings fetch has already undone.
const DROPPED_REQUEST_HEADERS = ['host', 'connection', 'content-length'];
const DROPPED_RESPONSE_HEADERS = ['connection', 'content-encoding', 'content-length', 'transfer-encoding'];

/**
 * Forwards Better Auth's endpoints to the operator, which hosts them. Through this origin, its session
 * cookies are the dashboard's, and the browser never calls the operator directly.
 */
async function forward(request: Request, { params }: RouteContext<'/api/auth/[...all]'>): Promise<Response> {
  const { all } = await params;
  const { search } = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name);
  const upstream = await fetch(`${OPERATOR_URL}/auth/${all.map(encodeURIComponent).join('/')}${search}`, {
    method: request.method,
    headers,
    body: request.method === 'GET' ? undefined : await request.arrayBuffer(),
    // OAuth and email links answer with redirects the browser must follow itself.
    redirect: 'manual',
    cache: 'no-store',
  });
  const responseHeaders = new Headers(upstream.headers);
  for (const name of DROPPED_RESPONSE_HEADERS) responseHeaders.delete(name);
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export { forward as GET, forward as POST };
