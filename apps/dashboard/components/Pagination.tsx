import Link from 'next/link';
import styles from './Pagination.module.css';

/**
 * Newest-first pages: "Older" continues before the last row's id. A full page may be followed by nothing,
 * which then shows as an empty page.
 */
export function Pagination({ path, params = {}, before, lastId, full }: {
  path: string;
  params?: Record<string, string>;
  before?: number;
  lastId?: number;
  full: boolean;
}) {
  if (!before && !full) return null;
  const href = (cursor?: number) => {
    const search = new URLSearchParams(params);
    if (cursor) search.set('before', String(cursor));
    const query = search.toString();
    return query ? `${path}?${query}` : path;
  };
  return (
    <nav className={styles.nav} aria-label="Pages">
      {before ? <Link href={href()}>← Newest</Link> : <span className={styles.disabled}>← Newest</span>}
      {full && lastId ? <Link href={href(lastId)}>Older →</Link> : <span className={styles.disabled}>Older →</span>}
    </nav>
  );
}
