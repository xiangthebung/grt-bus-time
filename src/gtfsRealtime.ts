/**
 * GRT realtime feeds: trip updates (predictions), vehicle positions
 * ("3 stops away"), and service alerts (detours, cancellations).
 *
 * Each feed is fetched independently so one outage cannot blank the others;
 * the resulting snapshot is plain JSON so it can cross the extension message
 * boundary unchanged.
 */

import { transit_realtime } from "gtfs-realtime-bindings";
import type {
  RealtimeSnapshot,
  RealtimeTrip,
  RealtimeVehicle,
  ServiceAlert,
} from "./types";

const API_BASE = "https://webapps.regionofwaterloo.ca/api/grt-routes/api";

export const TRIP_UPDATES_URL = `${API_BASE}/tripupdates/1`;
export const VEHICLE_POSITIONS_URL = `${API_BASE}/vehiclepositions/1`;
export const SERVICE_ALERTS_URL = `${API_BASE}/alerts/1`;

const FEED_TIMEOUT_MS = 12_000;

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (
    value &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof (value as { toNumber: () => number }).toNumber === "function"
  ) {
    const result = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(result) ? result : undefined;
  }
  return undefined;
}

/**
 * Reads a numeric field only when the feed actually sent it.
 *
 * protobufjs keeps each field's default on the message prototype, so a field that
 * never arrived still reads back as 0 — `toNumber` is handed a Long of 0 and has
 * no way to tell that apart from a zero the agency meant. Presence survives
 * decoding as an own property, which is what this checks.
 *
 * The fix for absent values belongs here rather than downstream: the consumers
 * are already correct for a snapshot that says what it means, and teaching the
 * alert filter to read `endMs: 0` as "no end" would turn 0 into a sentinel every
 * future reader of `ServiceAlert` has to know about.
 *
 * Use it only where a default of 0 would be a lie, or where 0 is itself a
 * legitimate value. `schedule_relationship` is neither: GTFS-realtime defines its
 * default as SCHEDULED, so absent and 0 say the same thing and plain `toNumber`
 * is right there.
 */
function numberIfPresent<T extends object, K extends keyof T & string>(
  message: T | null | undefined,
  field: K,
): number | undefined {
  if (!message || !Object.prototype.hasOwnProperty.call(message, field)) {
    return undefined;
  }
  return toNumber(message[field]);
}

async function fetchFeed(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeFeed(bytes: Uint8Array): transit_realtime.FeedMessage {
  return transit_realtime.FeedMessage.decode(bytes);
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

function normalizeTripUpdates(feed: transit_realtime.FeedMessage): RealtimeTrip[] {
  const trips: RealtimeTrip[] = [];
  for (const entity of feed.entity ?? []) {
    const update = entity.tripUpdate;
    if (!update) continue;
    const descriptor = update.trip;
    const stopTimes = (update.stopTimeUpdate ?? []).flatMap((stopTime) => {
      // A StopTimeEvent may carry `delay` and no `time`; read as epoch 0 that
      // becomes a departure in 1970 and the board drops the bus for being in the
      // past instead of falling back to its scheduled time.
      const time =
        numberIfPresent(stopTime.departure, "time") ??
        numberIfPresent(stopTime.arrival, "time");
      // stop_sequence 0 is a real first stop, so it cannot be spelled the same as
      // "no sequence given": the board reads the lowest sequence still served to
      // decide whether the bus is already past this stop, and a fabricated 0
      // makes every trip look like it is still at the start of its run.
      const sequence = numberIfPresent(stopTime, "stopSequence");
      const relationship = toNumber(stopTime.scheduleRelationship);
      if (time === undefined && relationship === undefined) return [];
      return [
        {
          ...(stopTime.stopId ? { stopId: stopTime.stopId } : {}),
          ...(sequence !== undefined ? { sequence } : {}),
          ...(time !== undefined ? { time } : {}),
          ...(relationship !== undefined ? { relationship } : {}),
        },
      ];
    });
    const relationship = toNumber(descriptor?.scheduleRelationship);
    trips.push({
      ...(descriptor?.tripId ? { tripId: descriptor.tripId } : {}),
      ...(descriptor?.routeId ? { routeId: descriptor.routeId } : {}),
      ...(descriptor?.startDate ? { startDate: descriptor.startDate } : {}),
      ...(relationship !== undefined ? { relationship } : {}),
      stopTimes,
    });
  }
  return trips;
}

function normalizeVehicles(feed: transit_realtime.FeedMessage): RealtimeVehicle[] {
  const vehicles: RealtimeVehicle[] = [];
  for (const entity of feed.entity ?? []) {
    const vehicle = entity.vehicle;
    if (!vehicle?.trip?.tripId) continue;
    // "3 stops away" counts from this, so a vehicle that never reported a stop
    // sequence has to stay unset: counted from a fabricated 0 it would tell a
    // rider at an early stop that the bus is nearly there when nobody knows where
    // it is. A reported 0 is a genuine position — the first stop of the trip.
    const sequence = numberIfPresent(vehicle, "currentStopSequence");
    const timestamp = toNumber(vehicle.timestamp);
    const lat = toNumber(vehicle.position?.latitude);
    const lon = toNumber(vehicle.position?.longitude);
    vehicles.push({
      tripId: vehicle.trip.tripId,
      ...(vehicle.trip.startDate ? { startDate: vehicle.trip.startDate } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
      ...(lat !== undefined ? { lat } : {}),
      ...(lon !== undefined ? { lon } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    });
  }
  return vehicles;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/** GRT embeds HTML in alert text, so reduce it to readable plain text. */
export function htmlToText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&([a-z#0-9]+);/gi, (match, entity: string) => {
      const key = entity.toLowerCase();
      if (HTML_ENTITIES[key]) return HTML_ENTITIES[key];
      const numeric = /^#(\d+)$/.exec(entity);
      return numeric ? String.fromCharCode(Number(numeric[1])) : match;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function pickTranslation(
  text: transit_realtime.ITranslatedString | null | undefined,
): string {
  const translations = text?.translation ?? [];
  const english = translations.find((entry) =>
    entry.language?.toLowerCase().startsWith("en"),
  );
  return (english ?? translations[0])?.text ?? "";
}

/**
 * GRT ships the whole alert in `description_text` with a bolded lead line, so
 * the first sentence-like segment becomes the title and the rest the body.
 */
function splitAlertText(
  header: string,
  description: string,
): { title: string; body: string } {
  const boldMatch = /<strong>([\s\S]*?)<\/strong>/i.exec(description);
  const headline = htmlToText(header) || htmlToText(boldMatch?.[1] ?? "");
  const full = htmlToText(description);
  if (!headline) {
    const [firstLine, ...rest] = full.split("\n");
    return { title: firstLine || "Service alert", body: rest.join("\n").trim() };
  }
  const body = full.startsWith(headline) ? full.slice(headline.length).trim() : full;
  return { title: headline, body };
}

function normalizeAlerts(feed: transit_realtime.FeedMessage): ServiceAlert[] {
  const alerts: ServiceAlert[] = [];
  for (const entity of feed.entity ?? []) {
    const alert = entity.alert;
    if (!alert) continue;
    const { title, body } = splitAlertText(
      pickTranslation(alert.headerText),
      pickTranslation(alert.descriptionText),
    );
    if (!title && !body) continue;

    const routeIds = new Set<string>();
    const stopIds = new Set<string>();
    for (const informed of alert.informedEntity ?? []) {
      if (informed.routeId) routeIds.add(informed.routeId);
      if (informed.stopId) stopIds.add(informed.stopId);
      if (informed.trip?.routeId) routeIds.add(informed.trip.routeId);
    }

    const period = alert.activePeriod?.[0];
    // An active period with a `start` and no `end` is how an agency says "until
    // further notice", so an absent bound has to stay absent: as 0 it reads as an
    // alert that finished in 1970 and `alertsForStop` discards it.
    const start = numberIfPresent(period, "start");
    const end = numberIfPresent(period, "end");
    const url = pickTranslation(alert.url);
    alerts.push({
      id: entity.id || `${title}-${start ?? 0}`,
      title: title || "Service alert",
      body,
      routeIds: [...routeIds],
      stopIds: [...stopIds],
      ...(start !== undefined ? { startMs: start * 1000 } : {}),
      ...(end !== undefined ? { endMs: end * 1000 } : {}),
      ...(url ? { url } : {}),
    });
  }
  return alerts;
}

/* ------------------------------------------------------------------ *
 * Snapshot
 * ------------------------------------------------------------------ */

export interface RealtimeFeedBytes {
  tripUpdates: Uint8Array;
  vehiclePositions?: Uint8Array;
  alerts?: Uint8Array;
}

/** Decodes raw protobuf payloads into the snapshot the UI consumes. */
export function decodeRealtimeSnapshot(bytes: RealtimeFeedBytes): RealtimeSnapshot {
  const updates = decodeFeed(bytes.tripUpdates);
  const feedTimestamp = toNumber(updates.header?.timestamp);
  return {
    fetchedAt: Date.now(),
    ...(feedTimestamp !== undefined ? { feedTimestamp: feedTimestamp * 1000 } : {}),
    trips: normalizeTripUpdates(updates),
    vehicles: bytes.vehiclePositions
      ? normalizeVehicles(decodeFeed(bytes.vehiclePositions))
      : [],
    alerts: bytes.alerts ? normalizeAlerts(decodeFeed(bytes.alerts)) : [],
    degraded: !bytes.vehiclePositions || !bytes.alerts,
  };
}

export async function fetchRealtimeSnapshot(): Promise<RealtimeSnapshot> {
  const [updates, vehicles, alerts] = await Promise.allSettled([
    fetchFeed(TRIP_UPDATES_URL),
    fetchFeed(VEHICLE_POSITIONS_URL),
    fetchFeed(SERVICE_ALERTS_URL),
  ]);

  if (updates.status === "rejected") {
    throw new Error(
      `Live departures are unavailable right now (${
        updates.reason instanceof Error ? updates.reason.message : "network error"
      }).`,
    );
  }

  return decodeRealtimeSnapshot({
    tripUpdates: updates.value,
    ...(vehicles.status === "fulfilled" ? { vehiclePositions: vehicles.value } : {}),
    ...(alerts.status === "fulfilled" ? { alerts: alerts.value } : {}),
  });
}
