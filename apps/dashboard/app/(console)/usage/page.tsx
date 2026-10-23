import type { Metadata } from 'next';
import Link from 'next/link';
import { Pagination } from '@/components/Pagination';
import { ReceiptTable } from '@/components/ReceiptTable';
import ui from '@/components/ui.module.css';
import { listReceipts, PAGE_SIZE } from '@/lib/api';

export const metadata: Metadata = { title: 'Usage' };

const TABS = [
  { as: 'payer', label: 'Spent', description: 'Paid calls your nodes made, charged to your balance.' },
  { as: 'provider', label: 'Earned', description: 'Paid calls to your nodes\' functions. You earn each charge less the 20% platform fee.' },
] as const;

/** A positive integer from the query string, or undefined. */
const cursor = (value: string | string[] | undefined) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export default async function UsagePage({ searchParams }: PageProps<'/usage'>) {
  const query = await searchParams;
  const tab = TABS.find((t) => t.as === query.as) ?? TABS[0];
  const before = cursor(query.before);
  const receipts = await listReceipts(tab.as, before);

  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>Usage</h1>
      </header>
      <nav className={ui.tabs} aria-label="Usage">
        {TABS.map((t) => (
          <Link key={t.as} href={`/usage?as=${t.as}`} className={ui.tab} aria-current={t.as === tab.as ? 'page' : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      <p className={`${ui.description} ${ui.spacedBelow}`}>{tab.description} Times are UTC.</p>
      <ReceiptTable
        receipts={receipts}
        as={tab.as}
        empty={before ? 'No older calls.' : tab.as === 'payer' ? 'Your nodes haven\'t made a paid call yet.' : 'No one has paid for your functions yet.'}
      />
      <Pagination path="/usage" params={{ as: tab.as }} before={before} lastId={receipts.at(-1)?.id} full={receipts.length === PAGE_SIZE} />
    </>
  );
}
