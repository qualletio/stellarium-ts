/** The Stellarium mark, as on stellarium.sh. */
export function StarMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M24 2v44M2 24h44" stroke="currentColor" strokeWidth="1.5" />
      <path d="m7 7 34 34M41 7 7 41" stroke="currentColor" strokeWidth="1" opacity=".45" />
      <circle cx="24" cy="24" r="5.5" fill="currentColor" />
    </svg>
  );
}
