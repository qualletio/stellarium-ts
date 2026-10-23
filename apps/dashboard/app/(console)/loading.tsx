import ui from '@/components/ui.module.css';

/** Placeholder cards and rows while the operator answers, like the console's. */
export default function Loading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <header className={ui.header}>
        <span className={ui.skeleton} style={{ width: 200, height: 22 }} />
      </header>
      <div className={ui.cards}>
        {[0, 1, 2].map((card) => (
          <div key={card} className={ui.card}>
            <span className={ui.skeleton} style={{ width: '40%' }} />
            <span className={ui.skeleton} style={{ width: '55%', height: 26 }} />
            <span className={ui.skeleton} style={{ width: '70%' }} />
          </div>
        ))}
      </div>
      <section className={ui.section} style={{ marginTop: 28 }}>
        {[0, 1, 2, 3, 4].map((row) => (
          <span key={row} className={ui.skeleton} style={{ margin: '18px 0', width: `${90 - row * 6}%` }} />
        ))}
      </section>
    </div>
  );
}
