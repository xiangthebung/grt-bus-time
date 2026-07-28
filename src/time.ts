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

/** Resolves the agency-local calendar day and its midnight for an instant. */
export function serviceDayAt(timestamp: number): ServiceDay {
  const parts = zonedParts(timestamp);
  const subSecond = ((timestamp % 1000) + 1000) % 1000;
  const millisecondsIntoDay =
    (parts.hour * 3600 + parts.minute * 60 + parts.second) * 1000 + subSecond;
  return {
    dateKey: dateKeyOf(parts),
    midnightMs: timestamp - millisecondsIntoDay,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Service days that can contribute departures right now: yesterday (for trips
 * that run past midnight), today, and tomorrow (for a late-evening lookahead).
 */
export function relevantServiceDays(now: number): ServiceDay[] {
  return [
    serviceDayAt(now - DAY_MS),
    serviceDayAt(now),
    serviceDayAt(now + DAY_MS),
  ];
}

/** `YYYYMMDD` for the agency-local day containing `timestamp`. */
export function serviceDateKey(timestamp: number): string {
  return dateKeyOf(zonedParts(timestamp));
}
