/**
 * Departure board for a stop: schedule from the static feed, corrected with
 * realtime predictions.
 *
 * Accuracy rules applied here, in order:
 *  1. Only trips whose service is active on the relevant service day count.
 *     Yesterday is included so trips running past midnight still appear.
 *  2. A cancelled or deleted trip is dropped entirely.
 *  3. A stop marked SKIPPED for a trip is dropped.
 *  4. When a trip is reporting but its earliest remaining stop is past ours,
 *     the bus has already left: drop it instead of showing a stale schedule.
 *  5. Realtime times win over schedule; NO_DATA falls back to schedule.
 *  6. Trips that only exist in the realtime feed (added trips) are included.
 */

import {
  STOP_NO_DATA,
  STOP_SKIPPED,
  TRIP_CANCELED,
  TRIP_DELETED,
  type Departure,
  type DirectionId,
  type GtfsIndex,
  type RealtimeSnapshot,
  type RealtimeStopTime,
  type RealtimeTrip,
  type RealtimeVehicle,
  type ServiceAlert,
} from "./types";
import { relevantServiceDays, type ServiceDay } from "./time";

/** Keep a bus visible briefly after its predicted time so it does not blink out. */
const GRACE_MS = 45_000;
/** Never look further ahead than this when hunting for the next departure. */
const SEARCH_HORIZON_MS = 26 * 60 * 60 * 1000;
/** Vehicle positions older than this are ignored for "stops away". */
const VEHICLE_FRESH_MS = 5 * 60 * 1000;
const MAX_STOPS_AWAY = 8;

interface RealtimeTripState {
  trip: RealtimeTrip;
  byStopId: Map<string, RealtimeStopTime>;
  bySequence: Map<number, RealtimeStopTime>;
  /** Lowest still-served stop_sequence reported for the trip. */
  minSequence: number;
  canceled: boolean;
}

export interface RealtimeLookup {
  fetchedAt: number;
  trips: Map<string, RealtimeTripState>;
  vehicles: Map<string, RealtimeVehicle>;
  hasTripData: boolean;
}

function tripKey(tripId: string, startDate?: string): string {
  return startDate ? `${tripId}|${startDate}` : tripId;
}

/** Builds the lookup structures used while resolving a board. */
export function prepareRealtime(snapshot: RealtimeSnapshot): RealtimeLookup {
  const trips = new Map<string, RealtimeTripState>();
  for (const trip of snapshot.trips) {
    if (!trip.tripId) continue;
    const canceled =
      trip.relationship === TRIP_CANCELED || trip.relationship === TRIP_DELETED;
    const byStopId = new Map<string, RealtimeStopTime>();
    const bySequence = new Map<number, RealtimeStopTime>();
    let minSequence = Number.POSITIVE_INFINITY;
    for (const stopTime of trip.stopTimes) {
      if (stopTime.stopId && !byStopId.has(stopTime.stopId)) {
        byStopId.set(stopTime.stopId, stopTime);
      }
      if (stopTime.sequence !== undefined) {
        if (!bySequence.has(stopTime.sequence)) {
          bySequence.set(stopTime.sequence, stopTime);
        }
        if (
          stopTime.relationship !== STOP_SKIPPED &&
          stopTime.sequence < minSequence
        ) {
          minSequence = stopTime.sequence;
        }
      }
    }
    const state: RealtimeTripState = {
      trip,
      byStopId,
      bySequence,
      minSequence,
      canceled,
    };
    trips.set(tripKey(trip.tripId, trip.startDate), state);
    // Fallback entry so lookups still work when the service day is unknown.
    if (!trips.has(trip.tripId)) trips.set(trip.tripId, state);
  }

  const vehicles = new Map<string, RealtimeVehicle>();
  for (const vehicle of snapshot.vehicles) {
    if (!vehicle.tripId) continue;
    vehicles.set(tripKey(vehicle.tripId, vehicle.startDate), vehicle);
    if (!vehicles.has(vehicle.tripId)) vehicles.set(vehicle.tripId, vehicle);
  }

  return {
    fetchedAt: snapshot.fetchedAt,
    trips,
    vehicles,
    hasTripData: snapshot.trips.length > 0,
  };
}

export const EMPTY_LOOKUP: RealtimeLookup = {
  fetchedAt: 0,
  trips: new Map(),
  vehicles: new Map(),
  hasTripData: false,
};

/** First index whose time is >= `seconds`, using the sorted time array. */
function lowerBound(times: Int32Array, seconds: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle] < seconds) low = middle + 1;
    else high = middle;
  }
  return low;
}

interface Candidate {
  tripIndex: number;
  tripId: string;
  routeIndex: number;
  sequence: number;
  scheduledMs: number;
  dateKey: string;
}

export interface DepartureQuery {
  stopId: string;
  limit: number;
  now?: number;
  /**
   * When set, only this route's departures are returned.
   *
   * Filtering happens while the schedule is being scanned rather than on the
   * finished board. A stop can be served by a frequent route and an hourly one,
   * and a board built from the first few departures at the stop could contain
   * nothing but the frequent route — so filtering afterwards would report the
   * hourly route as having no service at all.
   */
  routeId?: string;
  /** When set with `routeId`, only this route direction is returned. */
  directionId?: DirectionId;
}

export interface DepartureBoard {
  departures: Departure[];
  /** At least one departure carries a realtime prediction. */
  hasLive: boolean;
  /** The stop exists in the feed but has no trips in the search window. */
  outOfService: boolean;
  /** The schedule does not cover today, so times cannot be trusted. */
  scheduleExpired: boolean;
}

function servicesFor(index: GtfsIndex, day: ServiceDay): Set<number> | undefined {
  const services = index.servicesByDate.get(day.dateKey);
  return services ? new Set(services) : undefined;
}

function collectScheduled(
  index: GtfsIndex,
  query: DepartureQuery,
  now: number,
  wanted: number,
): { candidates: Candidate[]; scheduleExpired: boolean } {
  const block = index.stopTimes.get(query.stopId);
  const candidates: Candidate[] = [];
  if (!block) return { candidates, scheduleExpired: false };

  const days = relevantServiceDays(now);
  const today = days[1];
  const scheduleExpired = !index.servicesByDate.has(today.dateKey);

  for (const day of days) {
    const services = servicesFor(index, day);
    if (!services || services.size === 0) continue;

    const fromSec = Math.floor((now - GRACE_MS - day.midnightMs) / 1000);
    const untilSec = Math.floor((now + SEARCH_HORIZON_MS - day.midnightMs) / 1000);
    if (untilSec < 0) continue;

    // The budget is per service day. Counted across all three, a day that filled
    // it would starve the days after it, and the caller sorts by time afterwards
    // — so the earliest departure could be missing from the list it sorts.
    let taken = 0;
    for (
      let position = lowerBound(block.timeSec, Math.max(fromSec, 0));
      position < block.timeSec.length;
      position += 1
    ) {
      const timeSec = block.timeSec[position];
      if (timeSec > untilSec) break;
      const tripIndex = block.tripIndex[position];
      if (!services.has(index.tripService[tripIndex])) continue;
      const routeIndex = index.tripRoute[tripIndex];
      // Before the budget is spent, so another route cannot use it up.
      if (query.routeId && index.routes[routeIndex].id !== query.routeId) continue;
      if (query.directionId && String(index.tripDirection[tripIndex]) !== query.directionId) {
        continue;
      }
      candidates.push({
        tripIndex,
        tripId: index.tripIds[tripIndex],
        routeIndex,
        sequence: block.sequence[position],
        scheduledMs: day.midnightMs + timeSec * 1000,
        dateKey: day.dateKey,
      });
      taken += 1;
      if (taken >= wanted) break;
    }
  }

  return { candidates, scheduleExpired };
}

function stopsAwayFor(
  lookup: RealtimeLookup,
  tripId: string,
  dateKey: string,
  sequence: number,
  now: number,
): number | undefined {
  const vehicle =
    lookup.vehicles.get(tripKey(tripId, dateKey)) ?? lookup.vehicles.get(tripId);
  if (!vehicle || vehicle.sequence === undefined) return undefined;
  if (
    vehicle.timestamp !== undefined &&
    now - vehicle.timestamp * 1000 > VEHICLE_FRESH_MS
  ) {
    return undefined;
  }
  const away = sequence - vehicle.sequence;
  if (away < 0 || away > MAX_STOPS_AWAY) return undefined;
  return away;
}

function realtimeStopTime(
  state: RealtimeTripState,
  stopId: string,
  sequence: number,
): RealtimeStopTime | undefined {
  return state.byStopId.get(stopId) ?? state.bySequence.get(sequence);
}

/**
 * Departures that only the realtime feed knows about: added trips, plus trips
 * the static schedule has not caught up with yet. Anything already matched
 * against the schedule is skipped.
 */
function collectUnscheduledDepartures(
  index: GtfsIndex,
  lookup: RealtimeLookup,
  query: DepartureQuery,
  now: number,
  seen: Set<string>,
): Departure[] {
  const departures: Departure[] = [];
  const visited = new Set<RealtimeTripState>();

  for (const state of lookup.trips.values()) {
    if (visited.has(state) || state.canceled) continue;
    visited.add(state);
    const tripId = state.trip.tripId;
    if (!tripId || seen.has(tripId)) continue;

    const stopTime = state.byStopId.get(query.stopId);
    if (
      !stopTime ||
      stopTime.time === undefined ||
      stopTime.relationship === STOP_SKIPPED
    ) {
      continue;
    }
    const timeMs = stopTime.time * 1000;
    if (timeMs < now - GRACE_MS) continue;

    const tripIndex = index.tripIndexById.get(tripId);
    const routeIndex =
      tripIndex !== undefined
        ? index.tripRoute[tripIndex]
        : state.trip.routeId
          ? index.routeIndexById.get(state.trip.routeId)
          : undefined;
    const route = routeIndex !== undefined ? index.routes[routeIndex] : undefined;
    const routeId = route?.id ?? state.trip.routeId;
    if (!routeId) continue;
    if (query.routeId && routeId !== query.routeId) continue;
    const directionId =
      tripIndex !== undefined ? String(index.tripDirection[tripIndex]) : undefined;
    if (query.directionId && directionId !== query.directionId) continue;
    const headsign =
      tripIndex !== undefined
        ? (index.headsigns[index.tripHeadsign[tripIndex]] ?? "")
        : (route?.longName ?? "");

    const stopsAway =
      stopTime.sequence !== undefined
        ? stopsAwayFor(
            lookup,
            tripId,
            state.trip.startDate ?? "",
            stopTime.sequence,
            now,
          )
        : undefined;

    departures.push({
      key: `${tripId}-live`,
      tripId,
      routeId,
      routeShortName: route?.shortName ?? routeId,
      ...(route?.color ? { routeColor: route.color } : {}),
      headsign,
      timeMs,
      scheduledMs: timeMs,
      isLive: true,
      delaySec: 0,
      ...(stopsAway !== undefined ? { stopsAway } : {}),
    });
  }
  return departures;
}

export function getDepartureBoard(
  index: GtfsIndex,
  lookup: RealtimeLookup,
  query: DepartureQuery,
): DepartureBoard {
  const now = query.now ?? Date.now();
  const limit = Math.max(1, query.limit);
  const { candidates, scheduleExpired } = collectScheduled(
    index,
    query,
    now,
    limit + 12,
  );

  const departures: Departure[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate.tripId)) continue;
    seen.add(candidate.tripId);

    const state =
      lookup.trips.get(tripKey(candidate.tripId, candidate.dateKey)) ??
      lookup.trips.get(candidate.tripId);
    let timeMs = candidate.scheduledMs;
    let isLive = false;

    if (state) {
      if (state.canceled) continue;
      const stopTime = realtimeStopTime(state, query.stopId, candidate.sequence);
      if (stopTime?.relationship === STOP_SKIPPED) continue;
      if (stopTime?.time !== undefined && stopTime.relationship !== STOP_NO_DATA) {
        timeMs = stopTime.time * 1000;
        isLive = true;
      } else if (
        !stopTime &&
        Number.isFinite(state.minSequence) &&
        candidate.sequence < state.minSequence
      ) {
        // The vehicle is reporting from a later stop: this one is behind it.
        continue;
      }
    }

    if (timeMs < now - GRACE_MS) continue;

    const route = index.routes[candidate.routeIndex];
    const stopsAway = isLive
      ? stopsAwayFor(lookup, candidate.tripId, candidate.dateKey, candidate.sequence, now)
      : undefined;

    departures.push({
      key: `${candidate.tripId}-${candidate.dateKey}`,
      tripId: candidate.tripId,
      routeId: route.id,
      routeShortName: route.shortName,
      ...(route.color ? { routeColor: route.color } : {}),
      headsign: index.headsigns[index.tripHeadsign[candidate.tripIndex]] ?? "",
      timeMs,
      scheduledMs: candidate.scheduledMs,
      isLive,
      delaySec: isLive ? Math.round((timeMs - candidate.scheduledMs) / 1000) : 0,
      ...(stopsAway !== undefined ? { stopsAway } : {}),
    });
  }

  departures.push(...collectUnscheduledDepartures(index, lookup, query, now, seen));
  departures.sort((a, b) => a.timeMs - b.timeMs);
  const visible = departures.slice(0, limit);

  return {
    departures: visible,
    hasLive: visible.some((departure) => departure.isLive),
    outOfService: departures.length === 0 && !scheduleExpired,
    scheduleExpired,
  };
}

/**
 * Service alerts that touch a stop or the routes serving it.
 *
 * `routeId` narrows the route half of that to one route, so a rider watching a
 * single bus is not shown a detour on a route they are not waiting for. Alerts
 * naming the stop itself still come through either way: those affect them
 * whichever bus they are there for.
 */
export function alertsForStop(
  index: GtfsIndex,
  snapshot: RealtimeSnapshot,
  stopId: string,
  routeId?: string,
  now = Date.now(),
): ServiceAlert[] {
  const relevantRoutes = new Set(
    routeId ? [routeId] : (index.routeIdsByStop.get(stopId) ?? []),
  );
  return snapshot.alerts.filter((alert) => {
    if (alert.startMs !== undefined && alert.startMs > now + 60 * 60 * 1000) return false;
    if (alert.endMs !== undefined && alert.endMs < now) return false;
    if (alert.stopIds.includes(stopId)) return true;
    return alert.routeIds.some((routeId) => relevantRoutes.has(routeId));
  });
}
