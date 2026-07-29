/**
 * Location helpers: distance maths, cached coordinates, and consent tracking.
 *
 * Location is only ever read after the rider opts in, is cached locally for a
 * short window so the service worker can order stops without waking the GPS,
 * and is never sent anywhere.
 *
 * Both the popup list and the toolbar badge answer "which stop am I closest to"
 * through `chooseNearestSavedStop`, so they cannot drift apart.
 */

import type { SavedStop, Stop } from "./types";

const EARTH_RADIUS_METERS = 6_371_000;
export const LAST_LOCATION_KEY = "lastLocation";
const LOCATION_CONSENT_KEY = "locationConsent";
const LOCATION_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * A stored position older than this is still usable, but worth replacing: the
 * service worker refreshes it in the background before choosing a stop so the
 * badge follows the rider instead of where they were half an hour ago.
 */
export const LOCATION_STALE_MS = 4 * 60 * 1000;

/**
 * How much closer a stop must be before it takes over as "the closest one".
 *
 * Two things make a bare minimum-distance comparison unreliable: browser
 * positions carry an accuracy radius that is often larger than the gap between
 * neighbouring stops, and small jitter between readings would otherwise flip
 * the badge back and forth between two stops on the same corner. Switching only
 * on a clear win keeps the answer stable and honest.
 */
const MIN_SWITCH_MARGIN_METERS = 60;

/**
 * Ceiling on that margin. Without one, a very coarse fix would make every stop
 * look equally close and pin the answer to whichever was chosen first, which is
 * the failure this whole margin exists to avoid.
 */
const MAX_SWITCH_MARGIN_METERS = 250;

/**
 * A fix vaguer than this says nothing useful about which stop a rider is at —
 * it is roughly a city block in every direction — so it is treated as no fix
 * at all rather than dressed up as an answer.
 */
export const MAX_USABLE_ACCURACY_METERS = 750;

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function haversineMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(latitudeA)) *
      Math.cos(toRadians(latitudeB)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

export interface StopWithDistance {
  stop: Stop;
  meters: number;
}

/** The closest stops to a point, nearest first. */
export function nearestStops(
  stops: readonly Stop[],
  latitude: number,
  longitude: number,
  limit = 12,
  maxMeters = 2_000,
): StopWithDistance[] {
  const results: StopWithDistance[] = [];
  for (const stop of stops) {
    const meters = haversineMeters(latitude, longitude, stop.lat, stop.lon);
    if (meters <= maxMeters) results.push({ stop, meters });
  }
  return results.sort((a, b) => a.meters - b.meters).slice(0, limit);
}

export function sortStopsByDistance(
  stops: readonly Stop[],
  latitude: number,
  longitude: number,
): Stop[] {
  return stops
    .map((stop, index) => ({
      stop,
      index,
      meters: haversineMeters(latitude, longitude, stop.lat, stop.lon),
    }))
    .sort((a, b) => a.meters - b.meters || a.index - b.index)
    .map(({ stop }) => stop);
}

export interface StoredLocation {
  latitude: number;
  longitude: number;
  updatedAt: number;
  /** Radius the browser reported around the fix, when it gave one. */
  accuracyMeters?: number;
}

/** Straight-line distance from a position to each saved stop, in metres. */
export function savedStopDistances(
  savedStops: readonly SavedStop[],
  stops: readonly Stop[],
  latitude: number,
  longitude: number,
): Map<string, number> {
  const stopsById = new Map(stops.map((stop) => [stop.id, stop]));
  const distances = new Map<string, number>();
  for (const saved of savedStops) {
    const stop = stopsById.get(saved.stopId);
    if (!stop) continue;
    distances.set(
      saved.id,
      haversineMeters(latitude, longitude, stop.lat, stop.lon),
    );
  }
  return distances;
}

export interface NearestChoice {
  /** `SavedStop.id` of the stop to lead with. */
  id: string;
  meters: number;
  /**
   * False when the position is too coarse, or the stops too close together, to
   * say which one really is nearest. The choice is still the best guess.
   */
  confident: boolean;
}

/**
 * Picks the saved stop to treat as "the closest one".
 *
 * `previousId` is the answer given last time. It is kept when another stop is
 * only closer by less than the position's own margin of error, so the badge does
 * not hop between two stops a few metres apart while the rider stands still. That
 * inertia gives way as soon as another stop is several times closer, so a rider
 * who has walked to a different stop is not held at the old one by the very
 * margin meant to keep small wobbles out.
 */
export function chooseNearestSavedStop(options: {
  savedStops: readonly SavedStop[];
  stops: readonly Stop[];
  location: StoredLocation;
  previousId?: string;
}): NearestChoice | undefined {
  const { savedStops, stops, location, previousId } = options;
  if ((location.accuracyMeters ?? 0) > MAX_USABLE_ACCURACY_METERS) return undefined;
  const distances = savedStopDistances(
    savedStops,
    stops,
    location.latitude,
    location.longitude,
  );
  const ranked = [...distances.entries()]
    .map(([id, meters]) => ({ id, meters }))
    .sort((a, b) => a.meters - b.meters);
  const best = ranked[0];
  if (!best) return undefined;

  // Confidence is judged against the accuracy as reported. Whether to switch is
  // judged against a capped version of it, because an unbounded margin would make
  // every stop look equally close and freeze the choice where it started.
  const uncertainty = Math.max(MIN_SWITCH_MARGIN_METERS, location.accuracyMeters ?? 0);
  const margin = Math.min(MAX_SWITCH_MARGIN_METERS, uncertainty);
  const runnerUp = ranked[1];
  const confident = !runnerUp || runnerUp.meters - best.meters > uncertainty;

  const previousMeters = previousId === undefined ? undefined : distances.get(previousId);
  if (
    previousId !== undefined &&
    previousMeters !== undefined &&
    previousMeters - best.meters <= margin &&
    // Relative escape hatch: a stop several times closer wins regardless of the
    // margin, so a rider who has walked to another stop is not held at the old one.
    previousMeters <= best.meters * 2 + MIN_SWITCH_MARGIN_METERS
  ) {
    return { id: previousId, meters: previousMeters, confident };
  }
  return { id: best.id, meters: best.meters, confident };
}

export async function saveLastLocation(
  latitude: number,
  longitude: number,
  accuracyMeters?: number,
): Promise<void> {
  const location: StoredLocation = {
    latitude,
    longitude,
    updatedAt: Date.now(),
    ...(typeof accuracyMeters === "number" && Number.isFinite(accuracyMeters)
      ? { accuracyMeters }
      : {}),
  };
  await chrome.storage.local.set({ [LAST_LOCATION_KEY]: location });
}

export async function getLastLocation(): Promise<StoredLocation | undefined> {
  const stored = await chrome.storage.local.get(LAST_LOCATION_KEY);
  const location = stored[LAST_LOCATION_KEY] as Partial<StoredLocation> | undefined;
  if (
    typeof location?.latitude !== "number" ||
    typeof location.longitude !== "number" ||
    typeof location.updatedAt !== "number" ||
    !Number.isFinite(location.latitude) ||
    !Number.isFinite(location.longitude) ||
    Math.abs(location.latitude) > 90 ||
    Math.abs(location.longitude) > 180 ||
    Date.now() - location.updatedAt > LOCATION_MAX_AGE_MS
  ) {
    return undefined;
  }
  return location as StoredLocation;
}

const NEAREST_CHOICE_KEY = "nearestStopChoice";

/**
 * The saved stop last treated as closest, shared through `chrome.storage.session`.
 *
 * Both the popup list and the toolbar badge read and write this, so the stop the
 * popup pulls to the top is the same one the badge counts down — and so the
 * choice stays put across the service worker restarts Chrome does between ticks.
 */
export async function getNearestStopChoice(): Promise<string | undefined> {
  const stored = await chrome.storage.session.get(NEAREST_CHOICE_KEY);
  const value = stored[NEAREST_CHOICE_KEY];
  return typeof value === "string" ? value : undefined;
}

export async function setNearestStopChoice(id: string | undefined): Promise<void> {
  await (id === undefined
    ? chrome.storage.session.remove(NEAREST_CHOICE_KEY)
    : chrome.storage.session.set({ [NEAREST_CHOICE_KEY]: id }));
}

export async function hasLocationConsent(): Promise<boolean> {
  const stored = await chrome.storage.local.get(LOCATION_CONSENT_KEY);
  return stored[LOCATION_CONSENT_KEY] === true;
}

export async function setLocationConsent(consented: boolean): Promise<void> {
  await chrome.storage.local.set({ [LOCATION_CONSENT_KEY]: consented });
  if (!consented) await chrome.storage.local.remove(LAST_LOCATION_KEY);
}

export function isLocationDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 1
  );
}

/**
 * Accuracy matters here: neighbouring GRT stops can be 100 m apart, so a coarse
 * fix is not good enough to tell them apart. A short `maximumAge` keeps a cached
 * position from standing in for the rider's current one.
 */
export function getCurrentPosition(timeoutMs = 10_000): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser cannot share your location."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 30_000,
      timeout: timeoutMs,
    });
  });
}

/** Copies the fields we keep out of a browser position. */
export function toStoredLocation(position: GeolocationPosition): StoredLocation {
  const { latitude, longitude, accuracy } = position.coords;
  return {
    latitude,
    longitude,
    updatedAt: Date.now(),
    ...(typeof accuracy === "number" && Number.isFinite(accuracy)
      ? { accuracyMeters: accuracy }
      : {}),
  };
}

/**
 * Reads the current position and remembers it. Falls back to the cached value
 * when the lookup fails but consent is still in place.
 */
export async function resolveLocation(): Promise<StoredLocation | undefined> {
  if (!(await hasLocationConsent())) return undefined;
  try {
    const location = toStoredLocation(await getCurrentPosition());
    await saveLastLocation(location.latitude, location.longitude, location.accuracyMeters);
    return location;
  } catch (error) {
    if (isLocationDenied(error)) {
      await setLocationConsent(false);
      return undefined;
    }
    return getLastLocation();
  }
}
