import type { Metadata } from 'next';
import Link from 'next/link';
import { CopyButton } from '@/components/CopyButton';
import ui from '@/components/ui.module.css';
import { getOrganization, listListings } from '@/lib/api';
import { formatTokenPrice, shortKey } from '@/lib/format';

export const metadata: Metadata = { title: 'Explore' };

export default async function ExplorePage() {
  const [organization, listings] = await Promise.all([getOrganization(), listListings()]);

  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>Explore</h1>
        {organization.admin && <Link href="/clients" className={ui.buttonSecondary}>API clients</Link>}
      </header>
      <p className={`${ui.description} ${ui.spacedBelow}`}>
        Nodes that run anyone&apos;s scripts. Create an API client for one, and your organization&apos;s balance pays its price per million
        script tokens, plus the paid functions your scripts call. Only the tokens a run executes are charged: branches a script doesn&apos;t
        take cost nothing.
      </p>
      {listings.length === 0 ? (
        <p className={ui.empty}>No nodes are listed yet.</p>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Node</th>
                <th>Organization</th>
                <th>URL</th>
                <th>Price</th>
                {organization.admin && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {listings.map((listing) => (
                <tr key={listing.publicKey}>
                  <td>
                    {listing.name ?? <span className={ui.secondary}>Unnamed</span>}
                    {listing.description && <span className={ui.secondary}>{listing.description}</span>}
                    <span className={ui.actions}>
                      <span className={`${ui.secondary} ${ui.mono}`} title={listing.publicKey}>{shortKey(listing.publicKey)}</span>
                      <CopyButton value={listing.publicKey} label="Copy key" />
                    </span>
                  </td>
                  <td>
                    {listing.organizationName}
                    {listing.organizationId === organization.id && <span className={ui.secondary}>Yours: runs free</span>}
                  </td>
                  <td className={ui.mono}>{listing.baseUrl ?? '—'}</td>
                  <td>{formatTokenPrice(listing.priceMicroUsdPerMillionTokens)}</td>
                  {organization.admin && (
                    <td className={ui.numeric}>
                      <Link href={`/clients?node=${encodeURIComponent(listing.publicKey)}`} className={ui.buttonSecondary}>Create API client</Link>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
