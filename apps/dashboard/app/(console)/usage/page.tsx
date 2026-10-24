import type { Metadata } from 'next';
import Link from 'next/link';
import { Pagination } from '@/components/Pagination';
import { ReceiptTable } from '@/components/ReceiptTable';
import { RunTable } from '@/components/RunTable';
import ui from '@/components/ui.module.css';
import { listReceipts, listRuns, PAGE_SIZE } from '@/lib/api';

export const metadata: Metadata = { title: 'Usage' };

const TABS = [
  { as: 'payer', view: 'calls', label: 'Spent', description: 'Paid calls your nodes and API clients\' runs made, charged to your balance.' },
  { as: 'provider', view: 'calls', label: 'Earned', description: 'Paid calls to your nodes\' functions. You earn each charge less the 20% platform fee.' },
  {
    as: 'payer', view: 'runs', label: 'Runs spent',
    description: 'Scripts your API clients ran on other organizations\' nodes, charged per token executed. Their paid calls are under Spent.',
  },
  { as: 'provider', view: 'runs', label: 'Runs earned', description: 'Scripts other organizations ran on your listed nodes. You earn each charge less the 20% platform fee.' },
] as const;

const tabHref = (tab: (typeof TABS)[number]) => `/usage?as=${tab.as}${tab.view === 'runs' ? '&view=runs' : ''}`;

/** A positive integer from the query string, or undefined. */
const cursor = (value: string | string[] | undefined) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export default async function UsagePage({ searchParams }: PageProps<'/usage'>) {
  const query = await searchParams;
  const view = query.view === 'runs' ? 'runs' : 'calls';
  const tab = TABS.find((t) => t.as === query.as && t.view === view) ?? TABS[0];
  const before = cursor(query.before);

  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>Usage</h1>
      </header>
      <nav className={ui.tabs} aria-label="Usage">
        {TABS.map((t) => (
          <Link key={tabHref(t)} href={tabHref(t)} className={ui.tab} aria-current={t === tab ? 'page' : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      <p className={`${ui.description} ${ui.spacedBelow}`}>{tab.description} Times are UTC.</p>
      {tab.view === 'runs' ? <Runs as={tab.as} before={before} /> : <Calls as={tab.as} before={before} />}
    </>
  );
}

async function Calls({ as, before }: { as: 'payer' | 'provider'; before?: number }) {
  const receipts = await listReceipts(as, before);
  return (
    <>
      <ReceiptTable
        receipts={receipts}
        as={as}
        empty={before ? 'No older calls.' : as === 'payer' ? 'Your nodes haven\'t made a paid call yet.' : 'No one has paid for your functions yet.'}
      />
      <Pagination path="/usage" params={{ as }} before={before} lastId={receipts.at(-1)?.id} full={receipts.length === PAGE_SIZE} />
    </>
  );
}

async function Runs({ as, before }: { as: 'payer' | 'provider'; before?: number }) {
  const runs = await listRuns(as, before);
  return (
    <>
      <RunTable
        runs={runs}
        as={as}
        empty={before ? 'No older runs.' : as === 'payer' ? 'Your API clients haven\'t run a billed script yet.' : 'No one has run a script on your listed nodes yet.'}
      />
      <Pagination path="/usage" params={{ as, view: 'runs' }} before={before} lastId={runs.at(-1)?.id} full={runs.length === PAGE_SIZE} />
    </>
  );
}
