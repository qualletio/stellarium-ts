'use client';

import { useLayoutEffect } from 'react';
import { THEME_STORAGE_KEY } from '@/lib/theme';
import styles from './ThemeToggle.module.css';

type Theme = 'light' | 'dark';

function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function ThemeToggle() {
  // Strict Mode's dev remount clears the attribute the inline script set; put it back.
  useLayoutEffect(() => {
    if (document.documentElement.hasAttribute('data-theme')) return;
    let theme: Theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === 'light' || saved === 'dark') theme = saved;
    } catch {}
    document.documentElement.setAttribute('data-theme', theme);
  }, []);

  const toggle = () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice still applies to this page.
    }
  };

  // Both icons render; CSS shows the one for the active theme, so server and client markup match.
  return (
    <button type="button" className={styles.toggle} onClick={toggle} aria-label="Toggle dark mode" title="Toggle dark mode">
      <svg className={styles.moon} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <svg className={styles.sun} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
