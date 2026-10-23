'use client';

import { useActionState } from 'react';
import { createNodeToken } from '@/lib/actions';
import { formatDateTime } from '@/lib/format';
import { CopyButton } from './CopyButton';
import styles from './EnrollmentForm.module.css';
import ui from './ui.module.css';

/** Creates a one-time enrollment token and shows it once, with the env line a node needs. */
export function EnrollmentForm() {
  const [state, formAction, pending] = useActionState(createNodeToken, undefined);
  const enrollment = state?.enrollment;
  return (
    <div className={styles.wrap}>
      <form action={formAction} className={ui.form}>
        <label className={ui.field}>
          Label
          <input className={ui.input} name="label" placeholder="prod-weather-1" maxLength={255} />
        </label>
        <button type="submit" className={ui.button} disabled={pending}>
          {pending ? 'Creating…' : 'Create enrollment token'}
        </button>
        {state?.error && <p className={ui.error}>{state.error}</p>}
      </form>
      {enrollment && (
        <div className={styles.token}>
          <p className={styles.tokenHead}>
            <span className={ui.kicker}>Shown once</span>
            <span className={ui.note}>Single use · expires {formatDateTime(enrollment.expiresAt)} UTC</span>
          </p>
          <pre className={styles.code}>ENROLLMENT_TOKEN={enrollment.token}</pre>
          <div className={ui.actions}>
            <CopyButton value={`ENROLLMENT_TOKEN=${enrollment.token}`} label="Copy env line" />
            <CopyButton value={enrollment.token} label="Copy token" />
          </div>
          <p className={ui.note}>
            Start the node with this set. It enrolls on startup, and after that it only needs its signing key.
          </p>
        </div>
      )}
    </div>
  );
}
