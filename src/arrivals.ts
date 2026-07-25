import type {
  Arrival,
  GtfsCache,
  RealtimeEntity,
  Watch,
} from "./types";

function matchesRoute(
  watch: Watch,
  tripId: string | undefined,
  realtimeRouteId: string | undefined,
  cache: GtfsCache,
): boolean {
  const routeId = realtimeRouteId ?? (tripId ? cache.routeIdByTripId.get(tripId) : undefined);
  return routeId === watch.routeId;
}

function matchesHeadsign(
  watch: Watch,
  tripId: string | undefined,
  cache: GtfsCache,
): boolean {
  if (!watch.directionId || !watch.tripHeadsign) return true;
  if (!tripId) return false;
  return cache.headsignByTripId.get(tripId) === watch.tripHeadsign;
}

function matchesDirection(
  watch: Watch,
  tripId: string | undefined,
  realtimeDirectionId: number | undefined,
  cache: GtfsCache,
): boolean {
  if (!watch.directionId) return true;
  if (realtimeDirectionId !== undefined) {
    return String(realtimeDirectionId) === watch.directionId;
  }
  if (!tripId) return false;
  return cache.directionIdByTripId.get(tripId) === watch.directionId;
}

function minutesAway(timestamp: number, now: number): number {
  return Math.max(0, Math.ceil((timestamp - now) / 60_000));
}

function scheduledTimestamp(arrivalSec: number, now: Date): number {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  return dayStart.getTime() + arrivalSec * 1000;
}

function getRealtimeArrivals(
  watch: Watch,
  cache: GtfsCache,
  entities: RealtimeEntity[],
  now: number,
): Arrival[] {
  const timestamps: number[] = [];
  for (const entity of entities) {
    const tripUpdate = entity.tripUpdate;
    if (!tripUpdate) continue;
    if ([3, 7].includes(tripUpdate.trip?.scheduleRelationship ?? 0)) continue;
    const tripId = tripUpdate.trip?.tripId;
    if (!matchesRoute(watch, tripId, tripUpdate.trip?.routeId, cache)) continue;
    if (!matchesDirection(watch, tripId, tripUpdate.trip?.directionId, cache)) continue;
    if (!matchesHeadsign(watch, tripId, cache)) continue;

    for (const stopTimeUpdate of tripUpdate.stopTimeUpdates) {
      if (stopTimeUpdate.scheduleRelationship === 1) continue;
      if (stopTimeUpdate.stopId !== watch.stopId) continue;
      const timestamp = stopTimeUpdate.arrivalTime ?? stopTimeUpdate.departureTime;
      if (timestamp === undefined) continue;
      const timestampMs = timestamp * 1000;
      if (timestampMs <= now) continue;
      timestamps.push(timestampMs);
    }
  }
  return [...new Set(timestamps)]
    .sort((a, b) => a - b)
    .slice(0, 3)
    .map((timestamp) => ({
      timestamp,
      minutes: minutesAway(timestamp, now),
      isLive: true,
    }));
}

function getScheduledArrivals(
  watch: Watch,
  cache: GtfsCache,
  now: number,
): Arrival[] {
  const nowDate = new Date(now);
  return (cache.arrivalsByStop.get(watch.stopId) ?? [])
    .filter((scheduled) => {
      const tripRoute = cache.routeIdByTripId.get(scheduled.tripId);
      return (
        tripRoute === watch.routeId &&
        matchesDirection(watch, scheduled.tripId, undefined, cache) &&
        matchesHeadsign(watch, scheduled.tripId, cache)
      );
    })
    .map((scheduled) => scheduledTimestamp(scheduled.arrivalSec, nowDate))
    .filter((timestamp) => timestamp > now)
    .sort((a, b) => a - b)
    .slice(0, 3)
    .map((timestamp) => ({
      timestamp,
      minutes: minutesAway(timestamp, now),
      isLive: false,
    }));
}

export function getArrivalsForWatch(
  watch: Watch,
  cache: GtfsCache,
  entities: RealtimeEntity[],
  now = Date.now(),
): Arrival[] {
  const realtimeArrivals = getRealtimeArrivals(watch, cache, entities, now);
  return realtimeArrivals.length > 0
    ? realtimeArrivals
    : getScheduledArrivals(watch, cache, now);
}

export function getArrivalsForWatches(
  watches: Watch[],
  cache: GtfsCache,
  entities: RealtimeEntity[],
  now = Date.now(),
): Map<string, Arrival[]> {
  return new Map(
    watches.map((watch) => [
      watch.id,
      getArrivalsForWatch(watch, cache, entities, now),
    ]),
  );
}

export function formatArrivalTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function formatMinutesAway(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0
    ? `${hours}h`
    : `${hours}h ${remainingMinutes}m`;
}
