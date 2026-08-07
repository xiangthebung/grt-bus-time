/**
 * Shared data model for the GRT Next Bus extension.
 *
 * The static GTFS feed is normalised into a compact, structured-clone friendly
 * index (`GtfsIndex`) so it can live in IndexedDB and be read cheaply by both
 * the popup and the service worker.
 */

export const GTFS_SCHEMA_VERSION = 5;

/** Grand River Transit publishes schedules in Waterloo Region local time. */
export const AGENCY_TIME_ZONE = "America/Toronto";

/** How long a downloaded static feed is trusted before a background refresh. */
export const STATIC_FEED_TTL_MS = 6 * 60 * 60 * 1000;

/** Realtime predictions older than this are treated as unusable. */
export const REALTIME_STALE_MS = 3 * 60 * 1000;

export const DEFAULT_ALERT_LEAD_MINUTES = 5;
export const ALERT_LEAD_OPTIONS = [2, 5, 10, 15] as const;
export type AlertLeadMinutes = (typeof ALERT_LEAD_OPTIONS)[number];

export const DEPARTURES_PER_STOP_OPTIONS = [2, 3, 4, 5] as const;
export const DEFAULT_DEPARTURES_PER_STOP = 3;

/** GTFS direction_id values used by the route patterns in the static feed. */
export const DIRECTION_IDS = ["0", "1"] as const;
export type DirectionId = (typeof DIRECTION_IDS)[number];

export const MAX_SAVED_STOPS = 12;

export interface Route {
  id: string;
  shortName: string;
  longName: string;
  /** `#RRGGBB`, already validated. */
  color?: string;
  textColor?: string;
  /** GTFS route_type. 0 = ION light rail, 3 = bus. */
  type: number;
}

export interface Stop {
  id: string;
  code: string;
  name: string;
  lat: number;
  lon: number;
}

/** Stop times for a single stop, sorted by `timeSec`. */
export interface StopTimeBlock {
  /** Index into `GtfsIndex.tripIds`. */
  tripIndex: Int32Array;
  /** Seconds after midnight of the trip's service day (may exceed 86400). */
  timeSec: Int32Array;
  /** GTFS stop_sequence. */
  sequence: Uint16Array;
}

/** A route + GTFS direction pattern a rider can browse. */
export interface RoutePattern {
  routeId: string;
  directionId: string;
  /** Headsigns served by this direction, most frequent first. */
  headsigns: string[];
  /** Stop ids in travel order. */
  stopIds: string[];
}

export interface GtfsIndex {
  schemaVersion: number;
  fetchedAt: number;
  routes: Route[];
  stops: Stop[];
  /** Sorted `YYYYMMDD` service days covered by the feed. */
  serviceDates: string[];
  /** `YYYYMMDD` -> active service indices. */
  servicesByDate: Map<string, Int32Array>;
  tripIds: string[];
  /** trip_id -> index into `tripIds`. */
  tripIndexById: Map<string, number>;
  /** route_id -> index into `routes`. */
  routeIndexById: Map<string, number>;
  /** Per trip: index into `routes`. */
  tripRoute: Int32Array;
  /** Per trip: index into `headsigns`. */
  tripHeadsign: Int32Array;
  /** Per trip: index into the interned service id list. */
  tripService: Int32Array;
  /** Per trip: GTFS direction_id (0 or 1). */
  tripDirection: Uint8Array;
  headsigns: string[];
  /** stop_id -> stop times at that stop. */
  stopTimes: Map<string, StopTimeBlock>;
  /** stop_id -> route ids serving it, in route display order. */
  routeIdsByStop: Map<string, string[]>;
  /** `routeId:directionId` -> browsable pattern. */
  patterns: Map<string, RoutePattern>;
}

/**
 * Returns the GTFS directions that actually call at one physical stop for a
 * route. A route usually has two patterns, but a stop is normally present in
 * only one of them. The route-wide pattern list is therefore not enough to
 * decide whether a rider needs to choose a destination.
 */
export function directionsAtStop(
  index: Pick<GtfsIndex, "patterns">,
  stopId: string,
  routeId: string,
): DirectionId[] {
  return DIRECTION_IDS.filter((directionId) =>
    index.patterns.get(patternKey(routeId, directionId))?.stopIds.includes(stopId),
  );
}

/**
 * A rider's saved stop + route + optional direction.
 *
 * `routeId` is optional only for entries created by older builds, which watched
 * every route at a stop. New entries always name one route. A missing direction
 * is an all-destinations legacy entry retained for older saved entries.
 */
export interface SavedStop {
  id: string;
  stopId: string;
  stopCode: string;
  stopName: string;
  /** When set, only this route counts for this entry. */
  routeId?: string;
  /** When set, only this route direction counts for this entry. */
  directionId?: DirectionId;
  /** Denormalised destination shown before the timetable has loaded. */
  directionHeadsign?: string;
  /**
   * Denormalised so the card can name the route before the feed has loaded, the
   * same reason `stopName` is stored. The live feed wins whenever it is around,
   * so a route GRT has since renamed corrects itself.
   */
  routeShortName?: string;
  createdAt: number;
  /** Manual sort position; lower comes first. */
  position: number;
  alertsEnabled?: boolean;
  alertLeadMinutes?: number;
}



export interface Settings {
  theme: "auto" | "light" | "dark";
  departuresPerStop: number;
  /** Pro: reorder saved stops so the closest one is first. */
  nearestFirst: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "auto",
  departuresPerStop: DEFAULT_DEPARTURES_PER_STOP,
  nearestFirst: true,
};

/* ------------------------------------------------------------------ *
 * Realtime
 * ------------------------------------------------------------------ */

/** GTFS-RT ScheduleRelationship values we act on. */
export const TRIP_CANCELED = 3;
export const TRIP_DELETED = 7;
export const STOP_SKIPPED = 1;
export const STOP_NO_DATA = 2;

export interface RealtimeStopTime {
  stopId?: string;
  sequence?: number;
  /** Epoch seconds. */
  time?: number;
  relationship?: number;
}

export interface RealtimeTrip {
  tripId?: string;
  routeId?: string;
  /** `YYYYMMDD` service day the trip instance belongs to. */
  startDate?: string;
  relationship?: number;
  stopTimes: RealtimeStopTime[];
}

export interface RealtimeVehicle {
  tripId?: string;
  startDate?: string;
  sequence?: number;
  lat?: number;
  lon?: number;
  /** Epoch seconds. */
  timestamp?: number;
}

export interface ServiceAlert {
  id: string;
  title: string;
  body: string;
  routeIds: string[];
  stopIds: string[];
  /** Direction selectors from the feed, when the agency supplied them. */
  directionIds?: DirectionId[];
  startMs?: number;
  endMs?: number;
  url?: string;
}

export interface RealtimeSnapshot {
  fetchedAt: number;
  /** Feed header timestamp in epoch ms, when provided. */
  feedTimestamp?: number;
  /** Whether each independent GRT realtime feed was available in this snapshot. */
  tripUpdatesAvailable: boolean;
  vehiclePositionsAvailable: boolean;
  alertsAvailable: boolean;
  trips: RealtimeTrip[];
  vehicles: RealtimeVehicle[];
  alerts: ServiceAlert[];
  /** True when at least one sub-feed failed, so predictions may be partial. */
  degraded: boolean;
}

export const EMPTY_REALTIME: RealtimeSnapshot = {
  fetchedAt: 0,
  tripUpdatesAvailable: false,
  vehiclePositionsAvailable: false,
  alertsAvailable: false,
  trips: [],
  vehicles: [],
  alerts: [],
  degraded: false,
};

/** True when trip predictions are recent both locally and at the agency. */
export function realtimePredictionsFresh(
  snapshot: RealtimeSnapshot,
  now = Date.now(),
): boolean {
  if (!snapshot.tripUpdatesAvailable) return false;
  if (now - snapshot.fetchedAt > REALTIME_STALE_MS) return false;
  if (snapshot.feedTimestamp === undefined) return true;
  // A small future allowance covers clock skew without accepting an obviously
  // malformed header as fresh data.
  return (
    snapshot.feedTimestamp <= now + 60_000 &&
    now - snapshot.feedTimestamp <= REALTIME_STALE_MS
  );
}

/* ------------------------------------------------------------------ *
 * Departures
 * ------------------------------------------------------------------ */

export interface Departure {
  key: string;
  tripId: string;
  routeId: string;
  routeShortName: string;
  routeColor?: string;
  headsign: string;
  /** Effective departure time in epoch ms (realtime when available). */
  timeMs: number;
  scheduledMs: number;
  isLive: boolean;
  /** Signed seconds late (negative = early). Only meaningful when live. */
  delaySec: number;
  /** Stops between the vehicle and this stop, when a position is known. */
  stopsAway?: number;
}

/** Legacy shape kept only so old saved data can be migrated. */
export interface LegacyWatch {
  id?: string;
  stopId?: string;
  stopCode?: string;
  stopName?: string;
  directionId?: string;
  tripHeadsign?: string;
  createdAt?: number;
  alertsEnabled?: boolean;
  alertLeadMinutes?: number;
}

export function patternKey(routeId: string, directionId: string): string {
  return `${routeId}:${directionId}`;
}
