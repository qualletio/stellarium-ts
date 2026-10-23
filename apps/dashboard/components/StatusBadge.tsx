import ui from './ui.module.css';

type Tone = 'success' | 'warning' | 'danger' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  success: ui.badgeSuccess,
  warning: ui.badgeWarning,
  danger: ui.badgeDanger,
  muted: ui.badgeMuted,
};

/** Receipt, top-up and payout statuses, and how each reads. */
const TONES: Record<string, Tone> = {
  captured: 'success',
  succeeded: 'success',
  paid: 'success',
  active: 'success',
  held: 'warning',
  pending: 'warning',
  released: 'muted',
  revoked: 'muted',
  failed: 'danger',
  reversed: 'danger',
};

export function StatusBadge({ status, label = status }: { status: string; label?: string }) {
  return <span className={TONE_CLASS[TONES[status] ?? 'muted']}>{label}</span>;
}
