/**
 * Service-day maths for the agency timezone.
 *
 * GTFS times are relative to midnight of a *service day* and can exceed 24
 * hours (GRT publishes trips up to 25:05:00). Resolving departures therefore
 * needs the exact epoch time of midnight in Waterloo Region, which is what
 * these helpers provide — DST transitions included, and correct even when the
 * rider's browser is in another timezone.
 */

import { AGENCY_TIME_ZONE } from "./types";

export interface ServiceDay {
  /** `YYYYMMDD`. */
  dateKey: string;
  /** Epoch ms of 00:00:00 local time on that day. */
  midnightMs: number;
}

const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: AGENCY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(timestamp: number): ZonedParts {
  const parts = partsFormatter.formatToParts(new Date(timestamp));
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type === "literal") continue;
    values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

function dateKeyOf(parts: ZonedParts): string {
  return (
    `${parts.year}` +
    `${String(parts.month).padStart(2, "0")}` +
    `${String(parts.day).padStart(2, "0")}`
  );
}

function datePartsFromKey(dateKey: string): { year: number; month: number; day: number } {
  return {
    year: Number(dateKey.slice(0, 4)),
    month: Number(dateKey.slice(4, 6)),
    day: Number(dateKey.slice(6, 8)),
  };
}

/**
 * Finds the epoch for local midnight without assuming that a local day is
 * exactly 24 elapsed hours. The old implementation subtracted the displayed
 * wall-clock time from the instant; on a DST transition day that subtracts an
 * hour too much or too little after the offset change.
 */
function zonedMidnightMs(parts: Pick<ZonedParts, "year" | "month" | "day">): number {
  const wantedWallMs = Date.UTC(parts.year, parts.month - 1, parts.day);
  let candidate = wantedWallMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(candidate);
    const actualWallMs = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const corrected = candidate + (wantedWallMs - actualWallMs);
    if (corrected === candidate) return candidate;
    candidate = corrected;
  }
  return candidate;
}

function serviceDayForDateKey(dateKey: string): ServiceDay {
  const parts = datePartsFromKey(dateKey);
  return { dateKey, midnightMs: zonedMidnightMs(parts) };
}

function shiftDateKey(dateKey: string, days: number): string {
  const { year, month, day } = datePartsFromKey(dateKey);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return (
    `${shifted.getUTCFullYear()}` +
    `${String(shifted.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(shifted.getUTCDate()).padStart(2, "0")}`
  );
}

/** Resolves the agency-local calendar day and its midnight for an instant. */
export function serviceDayAt(timestamp: number): ServiceDay {
  const parts = zonedParts(timestamp);
  return {
    dateKey: dateKeyOf(parts),
    midnightMs: zonedMidnightMs(parts),
  };
}

/**
 * Service days that can contribute departures right now: yesterday (for trips
 * that run past midnight), today, and tomorrow (for a late-evening lookahead).
 */
export function relevantServiceDays(now: number): ServiceDay[] {
  const today = serviceDayAt(now);
  return [
    serviceDayForDateKey(shiftDateKey(today.dateKey, -1)),
    today,
    serviceDayForDateKey(shiftDateKey(today.dateKey, 1)),
  ];
}

/** `YYYYMMDD` for the agency-local day containing `timestamp`. */
export function serviceDateKey(timestamp: number): string {
  return dateKeyOf(zonedParts(timestamp));
}
