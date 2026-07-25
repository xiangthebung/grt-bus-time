import { unzipSync } from "fflate";
import { openDB, type DBSchema } from "idb";
import Papa from "papaparse";
import {
  GTFS_CACHE_TTL_MS,
  GTFS_SCHEMA_VERSION,
  routeVariantKey,
  type DirectionOption,
  type GtfsCache,
  type Route,
  type ScheduledArrival,
  type Stop,
} from "./types";

export const STATIC_GTFS_URL =
  "https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/1";

const DB_NAME = "grt-bus-time";
const DB_VERSION = 1;
const CACHE_STORE = "cache";
const CACHE_KEY = "current";

interface GtfsDb extends DBSchema {
  cache: {
    key: string;
    value: GtfsCache;
  };
}

interface RouteRow {
  route_id?: string;
  route_short_name?: string;
  route_long_name?: string;
  route_color?: string;
}

interface StopRow {
  stop_id?: string;
  stop_code?: string;
  stop_name?: string;
  stop_lat?: string;
  stop_lon?: string;
}

interface TripRow {
  route_id?: string;
  service_id?: string;
  trip_id?: string;
  trip_headsign?: string;
  direction_id?: string;
}

interface StopTimeRow {
  trip_id?: string;
  arrival_time?: string;
  stop_id?: string;
  stop_sequence?: string;
}

interface CalendarDateRow {
  service_id?: string;
  date?: string;
  exception_type?: string;
}

let cachePromise: Promise<GtfsCache> | undefined;
let backgroundRefreshPromise: Promise<void> | undefined;

function getDb() {
  return openDB<GtfsDb>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE);
      }
    },
  });
}

async function readCache(): Promise<GtfsCache | undefined> {
  const db = await getDb();
  return db.get(CACHE_STORE, CACHE_KEY);
}

async function writeCache(cache: GtfsCache): Promise<void> {
  const db = await getDb();
  await db.put(CACHE_STORE, cache, CACHE_KEY);
}

function parseCsv<T>(input: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    Papa.parse<T>(input, {
      header: true,
      skipEmptyLines: true,
      worker: true,
      complete: (results) => resolve(results.data),
      error: (error: Error) => reject(error),
    });
  });
}

function decodeZipFile(files: Record<string, Uint8Array>, filename: string): string {
  const file = files[filename];
  if (!file) throw new Error(`The GTFS feed is missing ${filename}.`);
  return new TextDecoder().decode(file);
}

function parseGtfsTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts = value.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function getActiveServices(rows: CalendarDateRow[], serviceDate: string): Set<string> {
  const active = new Set<string>();
  for (const row of rows) {
    if (row.date !== serviceDate || !row.service_id) continue;
    if (row.exception_type === "1") active.add(row.service_id);
    if (row.exception_type === "2") active.delete(row.service_id);
  }
  return active;
}

function compareRouteNames(a: Route, b: Route): number {
  const aNumber = Number.parseInt(a.shortName, 10);
  const bNumber = Number.parseInt(b.shortName, 10);
  const bothNumeric = Number.isFinite(aNumber) && Number.isFinite(bNumber);
  if (bothNumeric && aNumber !== bNumber) return aNumber - bNumber;
  return a.shortName.localeCompare(b.shortName, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function sortRoutes(routes: Route[]): Route[] {
  return [...routes].sort(compareRouteNames);
}

async function parseFeed(zipBytes: Uint8Array): Promise<GtfsCache> {
  const serviceDate = formatLocalDate(new Date());
  const files = unzipSync(zipBytes);
  const [routeRows, stopRows, tripRows, calendarDateRows] = await Promise.all([
    parseCsv<RouteRow>(decodeZipFile(files, "routes.txt")),
    parseCsv<StopRow>(decodeZipFile(files, "stops.txt")),
    parseCsv<TripRow>(decodeZipFile(files, "trips.txt")),
    parseCsv<CalendarDateRow>(decodeZipFile(files, "calendar_dates.txt")),
  ]);

  const routes: Route[] = routeRows.flatMap((row) => {
    if (!row.route_id || !row.route_short_name) return [];
    return [
      {
        id: row.route_id,
        shortName: row.route_short_name,
        longName: row.route_long_name ?? "",
        ...(row.route_color ? { color: `#${row.route_color}` } : {}),
      },
    ];
  });
  routes.sort(compareRouteNames);

  const stops: Stop[] = stopRows.flatMap((row) => {
    if (!row.stop_id || !row.stop_name) return [];
    const lat = Number(row.stop_lat);
    const lon = Number(row.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    return [
      {
        id: row.stop_id,
        code: row.stop_code ?? row.stop_id,
        name: row.stop_name,
        lat,
        lon,
      },
    ];
  });

  const activeServices = getActiveServices(calendarDateRows, serviceDate);
  const hasActiveServiceRows = activeServices.size > 0;
  const routeIdByTripId = new Map<string, string>();
  const directionIdByTripId = new Map<string, string>();
  const headsignByTripId = new Map<string, string>();
  const tripById = new Map<string, TripRow>();
  const directionsByRoute = new Map<string, DirectionOption[]>();
  const representativeTripByVariant = new Map<string, string>();
  const selectedTripIds = new Set<string>();

  for (const row of tripRows) {
    if (!row.trip_id || !row.route_id) continue;
    const directionId = row.direction_id?.trim() || "0";
    const headsign = row.trip_headsign?.trim() || `Direction ${directionId}`;
    routeIdByTripId.set(row.trip_id, row.route_id);
    directionIdByTripId.set(row.trip_id, directionId);
    headsignByTripId.set(row.trip_id, headsign);
    tripById.set(row.trip_id, row);
    if (!hasActiveServiceRows || (row.service_id && activeServices.has(row.service_id))) {
      selectedTripIds.add(row.trip_id);
    }

    const key = routeVariantKey(row.route_id, directionId, headsign);
    const existingRepresentative = representativeTripByVariant.get(key);
    if (
      !existingRepresentative ||
      (!selectedTripIds.has(existingRepresentative) && selectedTripIds.has(row.trip_id))
    ) {
      representativeTripByVariant.set(key, row.trip_id);
    }
    if (!existingRepresentative) {
      const directions = directionsByRoute.get(row.route_id) ?? [];
      directions.push({
        directionId,
        headsign,
        repTripId: row.trip_id,
      });
      directionsByRoute.set(row.route_id, directions);
    }
  }

  const stopTimes = await parseCsv<StopTimeRow>(
    decodeZipFile(files, "stop_times.txt"),
  );
  const stopIdsByVariant = new Map<string, string[]>();
  const stopSeqByRepTrip = new Map<string, number>();
  const arrivalsByStop = new Map<string, ScheduledArrival[]>();
  const repStopTimes = new Map<string, Array<{ stopId: string; sequence: number }>>();

  for (const row of stopTimes) {
    if (!row.trip_id || !row.stop_id) continue;
    const arrivalSec = parseGtfsTime(row.arrival_time);
    const sequence = Number(row.stop_sequence);
    if (arrivalSec === undefined || !Number.isFinite(sequence)) continue;

    const trip = tripById.get(row.trip_id);
    const directionId = trip?.direction_id?.trim() || "0";
    const headsign = headsignByTripId.get(row.trip_id) ?? `Direction ${directionId}`;
    const representative = representativeTripByVariant.get(
      trip ? routeVariantKey(trip.route_id ?? "", directionId, headsign) : "",
    );
    if (representative === row.trip_id) {
      const list = repStopTimes.get(row.trip_id) ?? [];
      list.push({ stopId: row.stop_id, sequence });
      repStopTimes.set(row.trip_id, list);
      stopSeqByRepTrip.set(`${row.trip_id}__${row.stop_id}`, sequence);
    }

    if (selectedTripIds.has(row.trip_id)) {
      const arrivals = arrivalsByStop.get(row.stop_id) ?? [];
      arrivals.push({ tripId: row.trip_id, arrivalSec });
      arrivalsByStop.set(row.stop_id, arrivals);
    }
  }

  for (const [routeVariant, repTripId] of representativeTripByVariant) {
    const ordered = (repStopTimes.get(repTripId) ?? []).sort(
      (a, b) => a.sequence - b.sequence,
    );
    stopIdsByVariant.set(
      routeVariant,
      ordered.map((stopTime) => stopTime.stopId),
    );
  }
  for (const [stopId, arrivals] of arrivalsByStop) {
    arrivals.sort((a, b) => a.arrivalSec - b.arrivalSec);
    arrivalsByStop.set(stopId, arrivals);
  }

  return {
    schemaVersion: GTFS_SCHEMA_VERSION,
    fetchedAt: Date.now(),
    serviceDate,
    routes,
    stops,
    stopIdsByVariant,
    stopSeqByRepTrip,
    directionsByRoute,
    routeIdByTripId,
    directionIdByTripId,
    headsignByTripId,
    arrivalsByStop,
  };
}

export async function refreshGtfsCache(): Promise<GtfsCache> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetch(STATIC_GTFS_URL, {
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The GRT static feed request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    throw new Error(`GRT static feed returned HTTP ${response.status}.`);
  }
  const cache = await parseFeed(new Uint8Array(await response.arrayBuffer()));
  await writeCache(cache);
  return cache;
}

function refreshCacheInBackground(): void {
  if (backgroundRefreshPromise) return;
  backgroundRefreshPromise = refreshGtfsCache()
    .then(() => undefined)
    .catch((error) => {
      console.warn("Unable to refresh the stale GRT static feed", error);
    })
    .finally(() => {
      backgroundRefreshPromise = undefined;
    });
}

export async function getGtfsCache(
  forceRefresh = false,
  allowStale = false,
): Promise<GtfsCache> {
  if (cachePromise) return cachePromise;
  cachePromise = (async () => {
    const cached = await readCache();
    const serviceDate = formatLocalDate(new Date());
    const cacheHasCurrentSchema =
      cached && cached.schemaVersion === GTFS_SCHEMA_VERSION;
    const cacheCanBeDisplayed =
      cacheHasCurrentSchema && cached.serviceDate === serviceDate;
    const cacheIsFresh =
      cacheCanBeDisplayed &&
      Date.now() - cached.fetchedAt < GTFS_CACHE_TTL_MS;
    if (!forceRefresh && cacheIsFresh) return cached;
    if (!forceRefresh && allowStale && cacheCanBeDisplayed) {
      refreshCacheInBackground();
      return cached;
    }
    return refreshGtfsCache();
  })();
  try {
    return await cachePromise;
  } finally {
    cachePromise = undefined;
  }
}
