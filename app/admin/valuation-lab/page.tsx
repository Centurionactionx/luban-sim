import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AdminValuationLab } from "@/components/admin-valuation-lab";
import {
  SESSION_COOKIE_NAME,
  getSessionFromToken,
} from "@/lib";
import { isManagedAuthMode } from "@/lib/server/auth-mode";

export const dynamic = "force-dynamic";

const TORONTO_TIME_ZONE = "America/Toronto";

function torontoCalendarDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TORONTO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

function previousCalendarDay(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  return previous.toISOString().slice(0, 10);
}

function oneYearEarlier(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const targetYear = year - 1;
  const lastDayOfMonth = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  const target = new Date(
    Date.UTC(targetYear, month - 1, Math.min(day, lastDayOfMonth)),
  );
  return target.toISOString().slice(0, 10);
}

function dateDefaults() {
  const maxPurchaseDate = previousCalendarDay(torontoCalendarDate(new Date()));
  return {
    defaultPurchaseDate: oneYearEarlier(maxPurchaseDate),
    maxPurchaseDate,
  };
}

export default async function AdminValuationLabPage() {
  if (isManagedAuthMode()) {
    const {
      getManagedSessionState,
      hasManagedMfaEnrolled,
      isAdminMfaRequired,
    } = await import("@/lib/server/managed-identity");

    const state = await getManagedSessionState();

    if (state.kind === "signed-out") {
      redirect("/sign-in");
    }

    if (state.kind !== "linked" || state.user.role !== "platform_admin") {
      redirect("/");
    }

    if (isAdminMfaRequired() && !(await hasManagedMfaEnrolled(state.subject))) {
      redirect("/account?mfa=required");
    }

    return <AdminValuationLab {...dateDefaults()} />;
  }

  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const user = token ? getSessionFromToken(token) : null;

  if (!user || user.role !== "platform_admin") {
    redirect("/");
  }

  return <AdminValuationLab {...dateDefaults()} />;
}
