/** A `redirect` parameter if it's a path on this site, so sign-in can't send anyone elsewhere. Otherwise `/`. */
export function safeRedirect(value: string | string[] | null | undefined): string {
  const path = Array.isArray(value) ? value[0] : value;
  return path?.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') ? path : '/';
}

/** A link to `page` that carries the redirect on, unless it is the default. */
export function withRedirect(page: string, redirect: string): string {
  return redirect === '/' ? page : `${page}?redirect=${encodeURIComponent(redirect)}`;
}
