import type { Metadata } from 'next';
import ui from '@/components/ui.module.css';
import { StaffSignInForm } from './StaffSignInForm';

export const metadata: Metadata = { title: 'Sign in' };

export default function StaffSignInPage() {
  return (
    <>
      <header className={ui.header}>
        <h1 className={ui.title}>Stellarium staff</h1>
      </header>
      <section className={ui.section}>
        <p className={ui.description}>
          Sign in with your own staff API key, from the operator&apos;s STAFF_API_KEYS. Everything you do is in the audit log under your name,
          and bans, upheld appeals, raised limits and host-fault findings need a second staff member.
        </p>
        <StaffSignInForm />
      </section>
    </>
  );
}
