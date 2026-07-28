/**
 * Display formatting. Clock times use the agency timezone so a rider in
 * another timezone still reads Waterloo Region departure times.
 */

import { AGENCY_TIME_ZONE } from "./types";

const clockFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  timeZone: AGENCY_TIME_ZONE,
});

const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  timeZone: AGENCY_TIME_ZONE,
});

export function formatClock(timestamp: number): string {
  return clockFormatter.format(new Date(timestamp));
}

export function formatWeekday(timestamp: number): string {
  return weekdayFormatter.format(new Date(timestamp));
}

/** Countdown label for a departure: `Due`, `4 min`, `1h 20`. */
export function formatCountdown(timeMs: number, now = Date.now()): string {
  const minutes = Math.floor((timeMs - now) / 60_000);
  if (minutes <= 0) return "Due";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} hr` : `${hours}h ${String(remainder).padStart(2, "0")}`;
}

/** Minutes until a departure, floored, never negative. */
export function minutesUntil(timeMs: number, now = Date.now()): number {
  return Math.max(0, Math.floor((timeMs - now) / 60_000));
}

/** Short badge text for the toolbar icon. */
export function formatBadge(timeMs: number, now = Date.now()): string {
  const minutes = minutesUntil(timeMs, now);
  if (minutes < 1) return "now";
  if (minutes < 60) return String(minutes);
  const hours = Math.floor(minutes / 60);
  return hours < 10 ? `${hours}h` : "9h+";
}

/**
 * `3 min late` / `1 min early`, empty when effectively on time. Implausible
 * gaps are suppressed rather than shown: they mean the prediction could not be
 * lined up with the timetable, and a wrong number is worse than none.
 */
export const MAX_REPORTABLE_DELAY_MINUTES = 60;

export function formatDelay(delaySeconds: number): string {
  const minutes = Math.round(delaySeconds / 60);
  if (minutes === 0 || Math.abs(minutes) > MAX_REPORTABLE_DELAY_MINUTES) return "";
  return minutes > 0
    ? `${minutes} min late`
    : `${Math.abs(minutes)} min early`;
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

/** Relative freshness label for the last successful refresh. */
export function formatFreshness(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return formatClock(timestamp);
}

/** Walking time estimate at a relaxed 1.25 m/s. */
export function formatWalkTime(meters: number): string {
  const minutes = Math.max(1, Math.round(meters / 75));
  return `${minutes} min walk`;
}

/**
 * Badge colour for a route. GRT's feed carries no `route_color`, so the family
 * of service is used instead: 200-series iXpress and 300-series ION read
 * differently from local buses at a glance.
 */
export function routeBadgeColor(route: {
  shortName: string;
  color?: string;
}): string | undefined {
  if (route.color) return route.color;
  const number = Number.parseInt(route.shortName, 10);
  if (!Number.isFinite(number)) return undefined;
  if (number >= 300 && number < 400) return "#1d6f9c";
  if (number >= 200 && number < 300) return "#8c4a22";
  return undefined;
}
