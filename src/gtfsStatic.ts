/**
 * Downloads and indexes the Grand River Transit static GTFS feed.
 *
 * The parsed result is a compact index built on typed arrays: roughly 3 MB for
 * 310k stop times instead of the tens of megabytes an object-per-row shape
 * costs. It is date-agnostic, so a single download serves every service day the
 * feed covers (no forced re-download at midnight).
 */

import { unzipSync } from "fflate";
import {
  columnIndexes,
  parseCsv,
  parseGtfsTime,
  parseInteger,
  readCsvHeader,
} from "./csv";
import {
  GTFS_SCHEMA_VERSION,
  patternKey,
  type GtfsIndex,
  type Route,
  type RoutePattern,
  type Stop,
  type StopTimeBlock,
} from "./types";

export const STATIC_GTFS_URL =
  "https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/1";

const DOWNLOAD_TIMEOUT_MS = 45_000;

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

function decodeEntry(files: Record<string, Uint8Array>, name: string): string {
  const file = files[name];
  if (!file) throw new Error(`The GRT feed is missing ${name}.`);
  return new TextDecoder().decode(file);
}

function normalizeColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const hex = value.trim().replace(/^#/, "");
  return /^[\da-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : undefined;
}

export function compareRoutes(a: Route, b: Route): number {
  const aNumber = Number.parseInt(a.shortName, 10);
  const bNumber = Number.parseInt(b.shortName, 10);
  const bothNumeric = Number.isFinite(aNumber) && Number.isFinite(bNumber);
  if (bothNumeric && aNumber !== bNumber) return aNumber - bNumber;
  return a.shortName.localeCompare(b.shortName, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function parseRoutes(text: string): Route[] {
  const routes: Route[] = [];
  const header = readCsvHeader(text);
  const at = columnIndexes(header, [
    "route_id",
    "route_short_name",
    "route_long_name",
    "route_color",
    "route_text_color",
    "route_type",
  ]);
  parseCsv(text, (fields) => {
    const id = fields[at.route_id];
    if (!id) return;
    const shortName = fields[at.route_short_name] || id;
    const color = normalizeColor(fields[at.route_color]);
    const textColor = normalizeColor(fields[at.route_text_color]);
    routes.push({
      id,
      shortName,
      longName: fields[at.route_long_name] ?? "",
      type: Math.max(0, parseInteger(fields[at.route_type])),
      ...(color ? { color } : {}),
      ...(textColor ? { textColor } : {}),
    });
  });
  return routes.sort(compareRoutes);
}

function parseStops(text: string): Stop[] {
  const stops: Stop[] = [];
  const header = readCsvHeader(text);
  const at = columnIndexes(header, [
    "stop_id",
    "stop_code",
    "stop_name",
    "stop_lat",
    "stop_lon",
    "location_type",
  ]);
  parseCsv(text, (fields) => {
    const id = fields[at.stop_id];
    const name = fields[at.stop_name];
    if (!id || !name) return;
    // Skip stations and other non-boarding nodes.
    const locationType = fields[at.location_type];
    if (locationType && locationType !== "0") return;
    const lat = Number(fields[at.stop_lat]);
    const lon = Number(fields[at.stop_lon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    stops.push({
      id,
      code: fields[at.stop_code] || id,
      name: name.trim(),
      lat,
      lon,
    });
  });
  return stops;
}

interface ServiceCalendar {
  serviceIndexById: Map<string, number>;
  servicesByDate: Map<string, Int32Array>;
  serviceDates: string[];
}

function parseCalendar(text: string): ServiceCalendar {
  const serviceIndexById = new Map<string, number>();
  const activeByDate = new Map<string, Set<number>>();
  const header = readCsvHeader(text);
  const at = columnIndexes(header, ["service_id", "date", "exception_type"]);

  parseCsv(text, (fields) => {
    const serviceId = fields[at.service_id];
    const date = fields[at.date];
    if (!serviceId || !date) return;
    let serviceIndex = serviceIndexById.get(serviceId);
    if (serviceIndex === undefined) {
      serviceIndex = serviceIndexById.size;
      serviceIndexById.set(serviceId, serviceIndex);
    }
    const active = activeByDate.get(date) ?? new Set<number>();
    // exception_type 1 adds service, 2 removes it.
    if (fields[at.exception_type] === "2") active.delete(serviceIndex);
    else active.add(serviceIndex);
    activeByDate.set(date, active);
  });

  const servicesByDate = new Map<string, Int32Array>();
  for (const [date, active] of activeByDate) {
    servicesByDate.set(date, Int32Array.from(active));
  }
  return {
    serviceIndexById,
    servicesByDate,
    serviceDates: [...servicesByDate.keys()].sort(),
  };
}

interface TripTable {
  tripIds: string[];
  tripIndexById: Map<string, number>;
  tripRoute: Int32Array;
  tripHeadsign: Int32Array;
  tripService: Int32Array;
  tripDirection: Uint8Array;
  headsigns: string[];
  /** `routeId:directionId` -> headsigns sorted by trip count, descending. */
  headsignsByPattern: Map<string, string[]>;
}

function parseTrips(
  text: string,
  routeIndexById: Map<string, number>,
  routes: Route[],
  serviceIndexById: Map<string, number>,
): TripTable {
  const tripIds: string[] = [];
  const tripIndexById = new Map<string, number>();
  const routeIndexes: number[] = [];
  const headsignIndexes: number[] = [];
  const serviceIndexes: number[] = [];
  const directions: number[] = [];
  const headsigns: string[] = [];
  const headsignIndexByName = new Map<string, number>();
  const headsignCounts = new Map<string, Map<string, number>>();

  const header = readCsvHeader(text);
  const at = columnIndexes(header, [
    "route_id",
    "service_id",
    "trip_id",
    "trip_headsign",
    "direction_id",
  ]);

  parseCsv(text, (fields) => {
    const tripId = fields[at.trip_id];
    const routeId = fields[at.route_id];
    if (!tripId || !routeId) return;
    const routeIndex = routeIndexById.get(routeId);
    if (routeIndex === undefined) return;

    const direction = fields[at.direction_id] === "1" ? 1 : 0;
    const rawHeadsign = fields[at.trip_headsign]?.trim();
    const headsign =
      rawHeadsign || routes[routeIndex].longName || `Direction ${direction}`;
    let headsignIndex = headsignIndexByName.get(headsign);
    if (headsignIndex === undefined) {
      headsignIndex = headsigns.length;
      headsigns.push(headsign);
      headsignIndexByName.set(headsign, headsignIndex);
    }

    const serviceId = fields[at.service_id] ?? "";
    const serviceIndex = serviceIndexById.get(serviceId) ?? -1;

    tripIndexById.set(tripId, tripIds.length);
    tripIds.push(tripId);
    routeIndexes.push(routeIndex);
    headsignIndexes.push(headsignIndex);
    serviceIndexes.push(serviceIndex);
    directions.push(direction);

    const key = patternKey(routeId, String(direction));
    const counts = headsignCounts.get(key) ?? new Map<string, number>();
    counts.set(headsign, (counts.get(headsign) ?? 0) + 1);
    headsignCounts.set(key, counts);
  });

  const headsignsByPattern = new Map<string, string[]>();
  for (const [key, counts] of headsignCounts) {
    headsignsByPattern.set(
      key,
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([headsign]) => headsign),
    );
  }

  return {
    tripIds,
    tripIndexById,
    tripRoute: Int32Array.from(routeIndexes),
    tripHeadsign: Int32Array.from(headsignIndexes),
    tripService: Int32Array.from(serviceIndexes),
    tripDirection: Uint8Array.from(directions),
    headsigns,
    headsignsByPattern,
  };
}

interface StopTimeAccumulator {
  tripIndexes: number[];
  times: number[];
  sequences: number[];
}

interface PatternStopAccumulator {
  /** stop_id -> [sum of stop_sequence, sample count] */
  sequenceTotals: Map<string, [number, number]>;
}

function parseStopTimes(
  text: string,
  trips: TripTable,
  routes: Route[],
  stopIds: Set<string>,
): Pick<GtfsIndex, "stopTimes" | "routeIdsByStop" | "patterns"> {
  const perStop = new Map<string, StopTimeAccumulator>();
  const routeIndexesByStop = new Map<string, Set<number>>();
  const patternStops = new Map<string, PatternStopAccumulator>();

  const header = readCsvHeader(text);
  const at = columnIndexes(header, [
    "trip_id",
    "arrival_time",
    "departure_time",
    "stop_id",
    "stop_sequence",
    "pickup_type",
  ]);

  parseCsv(text, (fields) => {
    const stopId = fields[at.stop_id];
    if (!stopId || !stopIds.has(stopId)) return;
    const tripId = fields[at.trip_id];
    if (!tripId) return;
    const tripIndex = trips.tripIndexById.get(tripId);
    if (tripIndex === undefined) return;
    // pickup_type 1 means no boarding here, so it is not a departure.
    if (fields[at.pickup_type] === "1") return;

    const departureSec = parseGtfsTime(fields[at.departure_time]);
    const timeSec =
      departureSec >= 0 ? departureSec : parseGtfsTime(fields[at.arrival_time]);
    const sequence = parseInteger(fields[at.stop_sequence]);
    if (timeSec < 0 || sequence < 0) return;

    const accumulator = perStop.get(stopId) ?? {
      tripIndexes: [],
      times: [],
      sequences: [],
    };
    accumulator.tripIndexes.push(tripIndex);
    accumulator.times.push(timeSec);
    accumulator.sequences.push(Math.min(sequence, 65535));
    perStop.set(stopId, accumulator);

    const routeIndex = trips.tripRoute[tripIndex];
    const routesAtStop = routeIndexesByStop.get(stopId) ?? new Set<number>();
    routesAtStop.add(routeIndex);
    routeIndexesByStop.set(stopId, routesAtStop);

    const key = patternKey(
      routes[routeIndex].id,
      String(trips.tripDirection[tripIndex]),
    );
    const pattern = patternStops.get(key) ?? { sequenceTotals: new Map() };
    const totals = pattern.sequenceTotals.get(stopId);
    if (totals) {
      totals[0] += sequence;
      totals[1] += 1;
    } else {
      pattern.sequenceTotals.set(stopId, [sequence, 1]);
    }
    patternStops.set(key, pattern);
  });

  const stopTimes = new Map<string, StopTimeBlock>();
  for (const [stopId, accumulator] of perStop) {
    const count = accumulator.times.length;
    const order = new Int32Array(count);
    for (let index = 0; index < count; index += 1) order[index] = index;
    const times = accumulator.times;
    order.sort((a, b) => times[a] - times[b]);

    const tripIndex = new Int32Array(count);
    const timeSec = new Int32Array(count);
    const sequence = new Uint16Array(count);
    for (let index = 0; index < count; index += 1) {
      const source = order[index];
      tripIndex[index] = accumulator.tripIndexes[source];
      timeSec[index] = accumulator.times[source];
      sequence[index] = accumulator.sequences[source];
    }
    stopTimes.set(stopId, { tripIndex, timeSec, sequence });
  }

  const routeIdsByStop = new Map<string, string[]>();
  for (const [stopId, routeIndexes] of routeIndexesByStop) {
    routeIdsByStop.set(
      stopId,
      [...routeIndexes].sort((a, b) => a - b).map((index) => routes[index].id),
    );
  }

  const patterns = new Map<string, RoutePattern>();
  for (const [key, pattern] of patternStops) {
    const separator = key.lastIndexOf(":");
    const routeId = key.slice(0, separator);
    const directionId = key.slice(separator + 1);
    const ordered = [...pattern.sequenceTotals.entries()]
      .map(([stopId, [total, count]]) => ({ stopId, average: total / count }))
      .sort((a, b) => a.average - b.average)
      .map((entry) => entry.stopId);
    patterns.set(key, {
      routeId,
      directionId,
      headsigns: trips.headsignsByPattern.get(key) ?? [],
      stopIds: ordered,
    });
  }

  return { stopTimes, routeIdsByStop, patterns };
}

/** Turns a raw GTFS zip into the compact index. Pure: no storage access. */
export function parseGtfsFeed(zipBytes: Uint8Array): GtfsIndex {
  const files = unzipSync(zipBytes, {
    filter: (file) =>
      [
        "routes.txt",
        "stops.txt",
        "trips.txt",
        "stop_times.txt",
        "calendar_dates.txt",
      ].includes(file.name),
  });

  const routes = parseRoutes(decodeEntry(files, "routes.txt"));
  if (routes.length === 0) throw new Error("The GRT feed contained no routes.");
  const routeIndexById = new Map(routes.map((route, index) => [route.id, index]));

  const stops = parseStops(decodeEntry(files, "stops.txt"));
  if (stops.length === 0) throw new Error("The GRT feed contained no stops.");
  const stopIds = new Set(stops.map((stop) => stop.id));

  const calendar = parseCalendar(decodeEntry(files, "calendar_dates.txt"));
  const trips = parseTrips(
    decodeEntry(files, "trips.txt"),
    routeIndexById,
    routes,
    calendar.serviceIndexById,
  );
  const { stopTimes, routeIdsByStop, patterns } = parseStopTimes(
    decodeEntry(files, "stop_times.txt"),
    trips,
    routes,
    stopIds,
  );
  if (stopTimes.size === 0) {
    throw new Error("The GRT feed contained no stop times.");
  }

  return {
    schemaVersion: GTFS_SCHEMA_VERSION,
    fetchedAt: Date.now(),
    routes,
    // Keep only stops a rider can actually board at.
    stops: stops.filter((stop) => stopTimes.has(stop.id)),
    serviceDates: calendar.serviceDates,
    servicesByDate: calendar.servicesByDate,
    tripIds: trips.tripIds,
    tripIndexById: trips.tripIndexById,
    routeIndexById,
    tripRoute: trips.tripRoute,
    tripHeadsign: trips.tripHeadsign,
    tripService: trips.tripService,
    tripDirection: trips.tripDirection,
    headsigns: trips.headsigns,
    stopTimes,
    routeIdsByStop,
    patterns,
  };
}

/* ------------------------------------------------------------------ *
 * Download
 * ------------------------------------------------------------------ */

export async function downloadGtfsFeed(): Promise<GtfsIndex> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(STATIC_GTFS_URL, {
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The GRT schedule download timed out.");
    }
    throw new Error("The GRT schedule could not be downloaded.");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`The GRT schedule server returned HTTP ${response.status}.`);
  }
  return parseGtfsFeed(new Uint8Array(await response.arrayBuffer()));
}
