import Link from 'next/link';
import { AuthShell } from '@/components/AuthShell';
import ui from '@/components/ui.module.css';

export default function NotFound() {
  return (
    <AuthShell>
      <p className={ui.note}>This page doesn't exist.</p>
      <Link href="/" className={ui.button}>Back to the console</Link>
    </AuthShell>
  );
}
