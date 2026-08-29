export default function Loading() {
  return (
    <main className="route-state" aria-label="Loading Luban Market Lab">
      <section className="route-state__sheet route-state__sheet--loading">
        <p className="route-state__brand">Luban Market Lab</p>
        <h1>Opening the team trading room…</h1>
        <div className="loading-rule" aria-hidden="true" />
        <p>Connecting to the local portfolio ledger and synthetic market feed.</p>
      </section>
    </main>
  );
}
