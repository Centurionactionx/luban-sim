"use client";

import { useEffect } from "react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="route-state" aria-labelledby="error-title">
      <section className="route-state__sheet">
        <p className="route-state__brand">Luban Market Lab</p>
        <h1 id="error-title">The trading room could not open.</h1>
        <p>
          Your simulated portfolio has not been changed. Reload the room to try
          the local server again.
        </p>
        <button className="button button--primary" type="button" onClick={reset}>
          Reload trading room
        </button>
      </section>
    </main>
  );
}
