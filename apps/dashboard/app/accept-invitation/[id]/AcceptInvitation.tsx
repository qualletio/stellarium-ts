'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import styles from '@/app/auth.module.css';
import ui from '@/components/ui.module.css';
import { authClient, errorMessage } from '@/lib/auth-client';

type Invitation = { organizationName: string; inviterEmail: string; role: string | null };

export function AcceptInvitation({ invitationId, email }: { invitationId: string; email: string }) {
  const router = useRouter();
  const [invitation, setInvitation] = useState<Invitation>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    authClient.organization.getInvitation({ query: { id: invitationId } }).then(({ data, error }) => {
      if (data) setInvitation(data);
      else setError(errorMessage(error));
    });
  }, [invitationId]);

  async function respond(accept: boolean) {
    setPending(true);
    setError(undefined);
    const { error } = accept
      ? await authClient.organization.acceptInvitation({ invitationId })
      : await authClient.organization.rejectInvitation({ invitationId });
    if (!error) {
      // Accepting makes the organization the active one.
      router.replace(accept ? '/' : '/select-organization');
      router.refresh();
      return;
    }
    setError(errorMessage(error));
    setPending(false);
  }

  if (error && !invitation) {
    return (
      <>
        <p className={ui.error} role="alert">{error}</p>
        <p className={ui.note}>
          You're signed in as {email}. The invitation must be for this address, still pending and not expired.
        </p>
        <Link href="/" className={ui.textLink}>Go to the console</Link>
      </>
    );
  }
  if (!invitation) return <p className={ui.note}>Loading the invitation…</p>;

  return (
    <>
      <p>
        {invitation.inviterEmail} invited you to join <strong>{invitation.organizationName}</strong>
        {invitation.role ? ` as ${invitation.role}` : ''}.
      </p>
      {error && <p className={ui.error} role="alert">{error}</p>}
      <div className={styles.form}>
        <button type="button" className={`${ui.button} ${styles.wide}`} disabled={pending} onClick={() => respond(true)}>
          Join {invitation.organizationName}
        </button>
        <button type="button" className={`${ui.buttonSecondary} ${styles.wide}`} disabled={pending} onClick={() => respond(false)}>
          Decline
        </button>
      </div>
    </>
  );
}
