"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js, which shows an offline page when a page can't load. Only
 * in production builds, where a worker would get in the way of dev reloads.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => {
        // Without the worker the site still works; it just has no offline page.
      });
  }, []);

  return null;
}
