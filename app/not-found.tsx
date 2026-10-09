import Link from "next/link";

export default function NotFound() {
  return (
    <main className="route-state" aria-labelledby="not-found-title">
      <section className="route-state__sheet">
        <p className="route-state__brand">Luban Market Lab · 404</p>
        <h1 id="not-found-title" className="route-state__title--lines">
          <span>You bought the dip.</span> <span>The dip was a typo.</span>
        </h1>
        <p>
          This page is down 100% and isn&apos;t coming back. On the bright
          side, it&apos;s the only loss in this simulator that doesn&apos;t count
          against your team.
        </p>
        <Link className="button button--primary" href="/">
          Cut your losses →
        </Link>
      </section>
    </main>
  );
}
