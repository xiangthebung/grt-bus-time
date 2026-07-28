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
      const time =
        toNumber(stopTime.departure?.time) ?? toNumber(stopTime.arrival?.time);
      const sequence = toNumber(stopTime.stopSequence);
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
    const sequence = toNumber(vehicle.currentStopSequence);
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
    const start = toNumber(period?.start);
    const end = toNumber(period?.end);
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
