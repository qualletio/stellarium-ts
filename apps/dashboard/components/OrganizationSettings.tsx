'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { authClient, errorMessage } from '@/lib/auth-client';
import ui from './ui.module.css';

type Result = { error: { message?: string } | null };

/** Runs a Better Auth call, then re-renders the page with the change, or keeps its error to show. */
function useAuthCall() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (call: () => Promise<Result>, after?: () => void) => {
    setPending(true);
    setError(undefined);
    const { error } = await call();
    setPending(false);
    if (error) return setError(errorMessage(error));
    after?.();
    router.refresh();
  };
  return { run, pending, error };
}

const ErrorText = ({ error }: { error?: string }) => (error ? <p className={ui.error} role="alert">{error}</p> : null);

export function RenameForm({ name }: { name: string }) {
  const { run, pending, error } = useAuthCall();
  return (
    <form
      className={ui.form}
      action={(formData) => run(() => authClient.organization.update({ data: { name: String(formData.get('name')).trim() } }))}
    >
      <input className={ui.input} name="name" defaultValue={name} maxLength={100} required aria-label="Organization name" />
      <button type="submit" className={ui.buttonSecondary} disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      <ErrorText error={error} />
    </form>
  );
}

export function InviteForm() {
  const { run, pending, error } = useAuthCall();
  const [sentTo, setSentTo] = useState<string>();
  return (
    <form
      className={ui.form}
      action={(formData) => {
        const email = String(formData.get('email')).trim();
        const role = formData.get('role') === 'admin' ? 'admin' : 'member';
        return run(() => authClient.organization.inviteMember({ email, role }), () => setSentTo(email));
      }}
    >
      <label className={ui.field}>
        Email
        <input className={ui.input} name="email" type="email" required />
      </label>
      <label className={ui.field}>
        Role
        <select className={ui.input} name="role" defaultValue="member">
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <button type="submit" className={ui.button} disabled={pending}>
        {pending ? 'Inviting…' : 'Invite'}
      </button>
      {sentTo && !error && <p className={ui.note} role="status">Invitation sent to {sentTo}.</p>}
      <ErrorText error={error} />
    </form>
  );
}

export function MemberActions({ memberId, role }: { memberId: string; role: string }) {
  const { run, pending, error } = useAuthCall();
  const [confirming, setConfirming] = useState(false);
  return (
    <span className={ui.actions}>
      <select
        className={ui.input}
        aria-label="Role"
        value={role === 'admin' ? 'admin' : 'member'}
        disabled={pending}
        onChange={(event) => {
          const next = event.target.value === 'admin' ? 'admin' : 'member';
          run(() => authClient.organization.updateMemberRole({ memberId, role: next }));
        }}
      >
        <option value="member">Member</option>
        <option value="admin">Admin</option>
      </select>
      {confirming ? (
        <>
          <button type="button" className={ui.buttonDanger} disabled={pending} onClick={() => run(() => authClient.organization.removeMember({ memberIdOrEmail: memberId }))}>
            {pending ? 'Removing…' : 'Confirm remove'}
          </button>
          <button type="button" className={ui.buttonSecondary} disabled={pending} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className={ui.buttonSecondary} onClick={() => setConfirming(true)}>
          Remove
        </button>
      )}
      <ErrorText error={error} />
    </span>
  );
}

export function InvitationActions({ invitationId }: { invitationId: string }) {
  const { run, pending, error } = useAuthCall();
  return (
    <span className={ui.actions}>
      <button type="button" className={ui.buttonSecondary} disabled={pending} onClick={() => run(() => authClient.organization.cancelInvitation({ invitationId }))}>
        {pending ? 'Canceling…' : 'Cancel'}
      </button>
      <ErrorText error={error} />
    </span>
  );
}

/** Leaves the organization, then asks for another. Better Auth refuses if the user is its only owner. */
export function LeaveButton({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const { run, pending, error } = useAuthCall();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className={ui.buttonSecondary} onClick={() => setConfirming(true)}>
        Leave
      </button>
    );
  }
  return (
    <span className={ui.actions}>
      <button
        type="button"
        className={ui.buttonDanger}
        disabled={pending}
        onClick={() => run(() => authClient.organization.leave({ organizationId }), () => router.replace('/select-organization'))}
      >
        {pending ? 'Leaving…' : 'Confirm leave'}
      </button>
      <button type="button" className={ui.buttonSecondary} disabled={pending} onClick={() => setConfirming(false)}>
        Cancel
      </button>
      <ErrorText error={error} />
    </span>
  );
}
