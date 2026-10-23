'use client';

import { useState } from 'react';
import styles from '@/app/auth.module.css';
import ui from '@/components/ui.module.css';
import { authClient, errorMessage } from '@/lib/auth-client';

/** Signs in or up with GitHub, returning to `redirect`. Shown when the operator has GitHub credentials. */
export function GitHubButton({ redirect }: { redirect: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <>
      <button
        type="button"
        className={`${ui.buttonSecondary} ${styles.wide}`}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          // On success the browser leaves for GitHub.
          const { error } = await authClient.signIn.social({ provider: 'github', callbackURL: redirect, errorCallbackURL: '/sign-in' });
          if (error) {
            setError(errorMessage(error));
            setPending(false);
          }
        }}
      >
        Continue with GitHub
      </button>
      {error && <p className={ui.error} role="alert">{error}</p>}
      <p className={styles.divider}>or</p>
    </>
  );
}
