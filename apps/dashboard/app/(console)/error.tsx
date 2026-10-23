'use client';

import ui from '@/components/ui.module.css';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>Something went wrong</h1>
      </header>
      <p className={ui.alert}>This page couldn't be loaded from the operator. Nothing was changed. If it keeps happening, sign out and back in.</p>
      {error.digest && <p className={ui.note}>Reference: <code>{error.digest}</code></p>}
      <p style={{ marginTop: 16 }}>
        <button type="button" className={ui.buttonSecondary} onClick={reset}>Try again</button>
      </p>
    </>
  );
}
