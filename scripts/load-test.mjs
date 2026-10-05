#!/usr/bin/env node
/**
 * Simulates a class using the simulator at once, against a running server in
 * demo mode, and reports latency, errors, response sizes, and server CPU.
 *
 *   node scripts/load-test.mjs --base http://localhost:3006 \
 *     --db data/loadtest.sqlite --users 75 --minutes 6
 *
 * It adds students "lt-001" and up, on teams of five, straight into the given
 * SQLite database (the one the server under test uses), replacing any from a
 * previous run. Never point it at a real database.
 *
 * Each student behaves like the real page: loads the dashboard, popular
 * picks, a chart, and their watchlist's sparklines, then polls the dashboard
 * once a minute (asking only for new history points), switches symbols and
 * searches every few minutes, and places a market order now and then.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, list) => {
    if (value.startsWith("--")) pairs.push([value.slice(2), list[index + 1]]);
    return pairs;
  }, []),
);
const BASE = (args.base ?? "http://localhost:3006").replace(/\/$/, "");
const DB_PATH = args.db;
const USERS = Number(args.users ?? 75);
const MINUTES = Number(args.minutes ?? 6);
const TEAM_SIZE = 5;
const POLL_MS = 60_000;
const SYMBOLS = ["SHOP.TO", "RY.TO", "TD.TO", "ENB.TO", "CNR.TO", "XEQT.TO"];
const SEARCHES = ["sho", "royal", "bank", "enb", "cn", "xeq"];

if (!DB_PATH) {
  console.error("Pass --db, the SQLite file the server under test uses.");
  process.exit(1);
}

/* ─────────────────────────────── Seeding ─────────────────────────────── */

function seed() {
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const competition = db
    .prepare("SELECT id, starting_cash_cents FROM competitions ORDER BY created_at DESC LIMIT 1")
    .get();
  if (!competition) throw new Error("Start the server once so it creates and seeds the database.");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM teams WHERE id LIKE 'lt-team-%'").run();
    db.prepare("DELETE FROM sessions WHERE user_id LIKE 'lt-%'").run();
    db.prepare("DELETE FROM users WHERE id LIKE 'lt-%'").run();
    const now = new Date().toISOString();
    const teams = Math.ceil(USERS / TEAM_SIZE);
    for (let team = 1; team <= teams; team += 1) {
      const teamId = `lt-team-${String(team).padStart(2, "0")}`;
      db.prepare(
        `INSERT INTO teams (id, competition_id, name, status, cash_cents, version, created_at)
         VALUES (?, ?, ?, 'active', ?, 0, ?)`,
      ).run(teamId, competition.id, `Load Team ${team}`, competition.starting_cash_cents, now);
      db.prepare(
        `INSERT INTO ledger_entries (id, team_id, order_id, entry_type, amount_cents, symbol, quantity, note, created_at)
         VALUES (?, ?, NULL, 'STARTING_CASH', ?, NULL, NULL, 'Load test starting cash', ?)`,
      ).run(randomUUID(), teamId, competition.starting_cash_cents, now);
    }
    for (let user = 1; user <= USERS; user += 1) {
      const id = `lt-${String(user).padStart(3, "0")}`;
      const teamId = `lt-team-${String(Math.ceil(user / TEAM_SIZE)).padStart(2, "0")}`;
      db.prepare(
        `INSERT INTO users (id, name, email, role, status, created_at)
         VALUES (?, ?, ?, 'student', 'active', ?)`,
      ).run(id, `Load Student ${user}`, `${id}@load.test`, now);
      db.prepare(
        `INSERT INTO team_members (team_id, user_id, is_captain, joined_at) VALUES (?, ?, ?, ?)`,
      ).run(teamId, id, user % TEAM_SIZE === 1 ? 1 : 0, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

/* ──────────────────────────── Measurement ────────────────────────────── */

const samples = [];
const errors = new Map();

async function call(student, label, path, init = {}) {
  const started = performance.now();
  let status = 0;
  let body = "";
  try {
    const response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Origin: BASE,
        ...(student.cookie ? { Cookie: student.cookie } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    status = response.status;
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) student.cookie = setCookie.split(";")[0];
    body = await response.text();
  } catch (error) {
    body = String(error);
  }
  const ms = performance.now() - started;
  const bytes = Buffer.byteLength(body);
  samples.push({ label, status, ms, bytes, gzip: gzipSync(body).length });
  if (status < 200 || status >= 300) {
    let code = String(status);
    try {
      code += ` ${JSON.parse(body).error?.code ?? ""}`;
    } catch {
      code += " (no JSON)";
    }
    const key = `${label}: ${code.trim()}`;
    errors.set(key, (errors.get(key) ?? 0) + 1);
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function serverCpuSeconds() {
  if (process.platform !== "win32") return null;
  try {
    const port = new URL(BASE).port || "80";
    const pid = execSync(
      `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1).OwningProcess"`,
    )
      .toString()
      .trim();
    const seconds = execSync(
      `powershell -NoProfile -Command "(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds"`,
    )
      .toString()
      .trim();
    return Number(seconds);
  } catch {
    return null;
  }
}

/* ───────────────────────────── Behaviour ─────────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = (list) => list[Math.floor(Math.random() * list.length)];

async function dashboard(student, refreshMarket) {
  const params = new URLSearchParams({ refreshMarket: refreshMarket ? "1" : "0", symbol: student.symbol });
  if (student.history?.length >= 2) {
    params.set("historyTeam", student.teamId);
    params.set("historyAfter", student.history[student.history.length - 2].at);
  }
  const data = await call(student, student.history ? "dashboard (poll)" : "dashboard (first load)", `/api/dashboard?${params}`);
  if (data) {
    student.history = data.portfolioHistoryAfter
      ? [...student.history.slice(0, -1), ...data.portfolioHistory]
      : data.portfolioHistory;
    student.watchlist = data.watchlist.map((item) => item.symbol);
  }
}

async function sparklines(student) {
  await Promise.all(
    student.watchlist.map((symbol) =>
      call(student, "chart history", `/api/quotes/history?symbol=${encodeURIComponent(symbol)}&range=1D`),
    ),
  );
}

async function runStudent(student, endsAt, index) {
  // Everyone arrives within the first ten seconds of class.
  await sleep(Math.random() * 10_000);
  await call(student, "sign in", "/api/auth/demo-login", {
    method: "POST",
    body: JSON.stringify({ userId: student.id }),
  });
  await Promise.all([
    dashboard(student, true),
    call(student, "popular picks", "/api/quotes?popular=1"),
    call(student, "chart history", `/api/quotes/history?symbol=${student.symbol}&range=1D`),
  ]);
  // The first student on each team builds the team's watchlist.
  if (index % TEAM_SIZE === 0) {
    for (const symbol of SYMBOLS.slice(0, 4)) {
      await call(student, "watchlist add", "/api/watchlist", {
        method: "POST",
        body: JSON.stringify({ symbol }),
      });
    }
  }
  await sparklines(student);

  let minute = 0;
  while (Date.now() < endsAt) {
    await sleep(POLL_MS + (Math.random() - 0.5) * 4_000);
    if (Date.now() >= endsAt) break;
    minute += 1;
    await dashboard(student, true);
    if (Math.random() < 0.4) {
      student.symbol = pick(SYMBOLS);
      await call(student, "search", `/api/quotes?q=${pick(SEARCHES)}`);
      await call(student, "chart history", `/api/quotes/history?symbol=${student.symbol}&range=1D`);
    }
    if (Math.random() < 0.35) {
      await call(student, "place order", "/api/orders", {
        method: "POST",
        headers: { "Idempotency-Key": `lt-${randomUUID()}` },
        body: JSON.stringify({ symbol: student.symbol, side: "BUY", quantity: 1 }),
      });
    }
    if (minute % 5 === 0) await sparklines(student);
  }
}

/* ─────────────────────────────── Report ──────────────────────────────── */

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function report(elapsedMs, cpuSeconds) {
  const minutes = elapsedMs / 60_000;
  const byLabel = new Map();
  for (const sample of samples) {
    const list = byLabel.get(sample.label) ?? [];
    list.push(sample);
    byLabel.set(sample.label, list);
  }
  console.log(`\n${USERS} students for ${minutes.toFixed(1)} minutes against ${BASE}\n`);
  console.log("endpoint                 requests   p50 ms   p95 ms   max ms   avg KB   avg gzip KB");
  for (const [label, list] of [...byLabel].sort()) {
    const times = list.map((sample) => sample.ms).sort((a, b) => a - b);
    const kb = list.reduce((sum, sample) => sum + sample.bytes, 0) / list.length / 1024;
    const gz = list.reduce((sum, sample) => sum + sample.gzip, 0) / list.length / 1024;
    console.log(
      `${label.padEnd(24)} ${String(list.length).padStart(8)} ${percentile(times, 0.5).toFixed(0).padStart(8)} ${percentile(times, 0.95).toFixed(0).padStart(8)} ${times.at(-1).toFixed(0).padStart(8)} ${kb.toFixed(1).padStart(8)} ${gz.toFixed(1).padStart(12)}`,
    );
  }
  const total = samples.length;
  const failed = [...errors.values()].reduce((sum, count) => sum + count, 0);
  const gzipBytes = samples.reduce((sum, sample) => sum + sample.gzip, 0);
  console.log(`\nrequests: ${total} (${(total / minutes).toFixed(0)} per minute), failed: ${failed}`);
  for (const [key, count] of errors) console.log(`  ${count} × ${key}`);
  const perHour = (value) => (value / minutes) * 60;
  console.log(`\nper class-hour at this rate:`);
  console.log(`  function invocations  ${perHour(total).toFixed(0)}`);
  console.log(`  compressed transfer   ${(perHour(gzipBytes) / 1024 / 1024).toFixed(1)} MB`);
  if (cpuSeconds !== null) {
    console.log(`  server CPU            ${(perHour(cpuSeconds) / 60).toFixed(1)} CPU-minutes (${((cpuSeconds * 1000) / total).toFixed(1)} ms per request)`);
  }
}

/* ──────────────────────────────── Run ────────────────────────────────── */

seed();
const students = Array.from({ length: USERS }, (_, index) => ({
  id: `lt-${String(index + 1).padStart(3, "0")}`,
  teamId: `lt-team-${String(Math.ceil((index + 1) / TEAM_SIZE)).padStart(2, "0")}`,
  symbol: SYMBOLS[index % SYMBOLS.length],
  cookie: null,
  history: null,
  watchlist: [],
}));
const cpuBefore = serverCpuSeconds();
const started = Date.now();
const endsAt = started + MINUTES * 60_000;
await Promise.all(students.map((student, index) => runStudent(student, endsAt, index)));
const cpuAfter = serverCpuSeconds();
report(Date.now() - started, cpuBefore !== null && cpuAfter !== null ? cpuAfter - cpuBefore : null);
