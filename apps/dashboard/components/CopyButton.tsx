'use client';

import { useState } from 'react';
import ui from './ui.module.css';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the text is still selectable.
    }
  };

  return (
    <button type="button" className={ui.buttonSecondary} onClick={copy} aria-live="polite">
      {copied ? 'Copied' : label}
    </button>
  );
}
