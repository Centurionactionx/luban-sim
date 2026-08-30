"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type AcceptState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done" }
  | { kind: "error"; message: string };

/**
 * Final step of invitation registration: the visitor is signed in through the
 * managed provider but has no Luban account yet. The server re-validates the
 * token, the provider session, and the verified email before creating
 * anything — this button only asks.
 */
export function JoinAcceptPanel({
  token,
  teamName,
}: {
  token: string;
  teamName: string | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<AcceptState>({ kind: "idle" });

  const accept = async () => {
    setState({ kind: "working" });

    try {
      const response = await fetch("/api/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token }),
      });

      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;

      if (!response.ok) {
        setState({
          kind: "error",
          message:
            payload?.error?.message ??
            "The invitation could not be accepted. Try again.",
        });
        return;
      }

      setState({ kind: "done" });
      router.push("/");
    } catch {
      setState({
        kind: "error",
        message: "The server could not be reached. Try again.",
      });
    }
  };

  return (
    <div className="join-accept">
      <button
        className="button button--primary"
        type="button"
        onClick={() => void accept()}
        disabled={state.kind === "working" || state.kind === "done"}
      >
        {state.kind === "working"
          ? "Creating your account…"
          : state.kind === "done"
            ? "Opening the trading room…"
            : teamName
              ? `Join ${teamName}`
              : "Accept invitation"}
      </button>
      {state.kind === "error" ? (
        <p className="join-accept__error" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
