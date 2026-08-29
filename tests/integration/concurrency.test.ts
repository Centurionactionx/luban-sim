import { spawn } from "node:child_process";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { getDashboard, getQuote, resetPrototype } from "@/lib";
import { getDatabase } from "@/lib/server/db";

interface WorkerResult {
  ok: boolean;
  code?: string;
  status?: number;
  orderId?: string;
}

function runOrderWorker(input: Record<string, unknown>): Promise<WorkerResult> {
  const workerPath = join(
    process.cwd(),
    "tests",
    "helpers",
    "concurrent-order-worker.ts",
  );

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", workerPath, JSON.stringify(input)],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Order worker exited ${code}: ${stderr}`));
        return;
      }

      const line = stdout.trim().split(/\r?\n/).at(-1);
      if (!line) {
        reject(new Error(`Order worker returned no JSON: ${stderr}`));
        return;
      }

      resolve(JSON.parse(line) as WorkerResult);
    });
  });
}

beforeEach(() => {
  resetPrototype("host");
});

describe("parallel team orders", () => {
  it("serializes two processes so the shared cash balance never goes negative", async () => {
    const before = getDashboard("alex");
    const quote = getQuote("ENB.TO");
    const cash = before.portfolio?.cashCents ?? 0;
    const price = quote?.priceCadCents ?? 0;
    const quantity = Math.floor(cash / price);

    expect(quantity).toBeGreaterThan(0);

    const [alex, maya] = await Promise.all([
      runOrderWorker({
        actorUserId: "alex",
        symbol: "ENB.TO",
        side: "BUY",
        quantity,
        idempotencyKey: "parallel-alex-order-001",
      }),
      runOrderWorker({
        actorUserId: "maya",
        symbol: "ENB.TO",
        side: "BUY",
        quantity,
        idempotencyKey: "parallel-maya-order-001",
      }),
    ]);

    const outcomes = [alex, maya];
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
      expect.objectContaining({ code: "INSUFFICIENT_CASH", status: 409 }),
    ]);

    const after = getDashboard("jordan");
    const ledger = getDatabase()
      .prepare(
        "SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM ledger_entries WHERE team_id = 'northstar'",
      )
      .get() as { balance: number };

    expect(after.portfolio?.cashCents).toBeGreaterThanOrEqual(0);
    expect(Number(ledger.balance)).toBe(after.portfolio?.cashCents);
    expect(after.team?.version).toBe((before.team?.version ?? 0) + 1);
  });
});
