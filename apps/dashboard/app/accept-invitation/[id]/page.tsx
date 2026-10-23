import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthShell } from '@/components/AuthShell';
import { getSession } from '@/lib/api';
import { AcceptInvitation } from './AcceptInvitation';

export const metadata: Metadata = { title: 'Join an organization' };

/** Where invitation emails link. The invited email address must sign in, or sign up, first. */
export default async function AcceptInvitationPage({ params }: PageProps<'/accept-invitation/[id]'>) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect(`/sign-in?redirect=${encodeURIComponent(`/accept-invitation/${id}`)}`);
  return (
    <AuthShell title="Join an organization">
      <AcceptInvitation invitationId={id} email={session.user.email} />
    </AuthShell>
  );
}
