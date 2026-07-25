export interface Route {
  id: string;
  shortName: string;
  longName: string;
  color?: string;
}

export interface Stop {
  id: string;
  code: string;
  name: string;
  lat: number;
  lon: number;
}

export interface DirectionOption {
  directionId: string;
  headsign: string;
  repTripId: string;
}

export interface ScheduledArrival {
  tripId: string;
  arrivalSec: number;
}

export interface GtfsCache {
  schemaVersion: number;
  fetchedAt: number;
  serviceDate: string;
  routes: Route[];
  stops: Stop[];
  stopIdsByVariant: Map<string, string[]>;
  directionIdByTripId: Map<string, string>;
  stopSeqByRepTrip: Map<string, number>;
  directionsByRoute: Map<string, DirectionOption[]>;
  routeIdByTripId: Map<string, string>;
  headsignByTripId: Map<string, string>;
  arrivalsByStop: Map<string, ScheduledArrival[]>;
}

export interface Watch {
  id: string;
  routeId: string;
  routeShortName: string;
  directionId: string;
  tripHeadsign: string;
  stopId: string;
  stopCode: string;
  stopName: string;
  createdAt: number;
  alertsEnabled?: boolean;
  alertLeadMinutes?: number;
}

export interface RealtimeStopTimeUpdate {
  stopSequence?: number;
  stopId?: string;
  arrivalTime?: number;
  departureTime?: number;
  scheduleRelationship?: number;
}

export interface RealtimeTripDescriptor {
  tripId?: string;
  routeId?: string;
  directionId?: number;
  tripHeadsign?: string;
  scheduleRelationship?: number;
}

export interface RealtimeTripUpdate {
  trip?: RealtimeTripDescriptor;
  stopTimeUpdates: RealtimeStopTimeUpdate[];
}

export interface RealtimeEntity {
  id: string;
  tripUpdate?: RealtimeTripUpdate;
}

export interface Arrival {
  timestamp: number;
  minutes: number;
  isLive: boolean;
}

export const GTFS_SCHEMA_VERSION = 3;
export const GTFS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_ALERT_LEAD_MINUTES = 5;
export const ALERT_LEAD_OPTIONS = [2, 5, 10, 15] as const;
export const ROUTE_DIRECTION_SEPARATOR = "__";
export const ROUTE_VARIANT_SEPARATOR = "\u001f";

export function routeDirectionKey(routeId: string, directionId: string): string {
  return `${routeId}${ROUTE_DIRECTION_SEPARATOR}${directionId}`;
}

export function routeVariantKey(
  routeId: string,
  directionId: string,
  headsign: string,
): string {
  return [routeId, directionId, headsign].join(ROUTE_VARIANT_SEPARATOR);
}
