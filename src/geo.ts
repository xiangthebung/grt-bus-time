/**
 * Location helpers: distance maths, cached coordinates, and consent tracking.
 *
 * Location is only ever read after the rider opts in, is cached locally for a
 * short window so the service worker can order stops without waking the GPS,
 * and is never sent anywhere.
 */

import type { SavedStop, Stop } from "./types";

const EARTH_RADIUS_METERS = 6_371_000;
const LAST_LOCATION_KEY = "lastLocation";
const LOCATION_CONSENT_KEY = "locationConsent";
const LOCATION_MAX_AGE_MS = 30 * 60 * 1000;

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

/** Id of the saved stop closest to a point, if any coordinates are known. */
export function nearestSavedStopId(
  savedStops: readonly SavedStop[],
  stops: readonly Stop[],
  latitude: number,
  longitude: number,
): string | undefined {
  const stopsById = new Map(stops.map((stop) => [stop.id, stop]));
  let bestId: string | undefined;
  let bestMeters = Number.POSITIVE_INFINITY;
  for (const saved of savedStops) {
    const stop = stopsById.get(saved.stopId);
    if (!stop) continue;
    const meters = haversineMeters(latitude, longitude, stop.lat, stop.lon);
    if (meters < bestMeters) {
      bestMeters = meters;
      bestId = saved.id;
    }
  }
  return bestId;
}

export interface StoredLocation {
  latitude: number;
  longitude: number;
  updatedAt: number;
}

export async function saveLastLocation(
  latitude: number,
  longitude: number,
): Promise<void> {
  await chrome.storage.local.set({
    [LAST_LOCATION_KEY]: { latitude, longitude, updatedAt: Date.now() },
  });
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

export function getCurrentPosition(
  timeoutMs = 10_000,
): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser cannot share your location."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      maximumAge: 2 * 60 * 1000,
      timeout: timeoutMs,
    });
  });
}

/**
 * Reads the current position and remembers it. Falls back to the cached value
 * when the lookup fails but consent is still in place.
 */
export async function resolveLocation(): Promise<StoredLocation | undefined> {
  if (!(await hasLocationConsent())) return undefined;
  try {
    const position = await getCurrentPosition();
    await saveLastLocation(position.coords.latitude, position.coords.longitude);
    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      updatedAt: Date.now(),
    };
  } catch (error) {
    if (isLocationDenied(error)) {
      await setLocationConsent(false);
      return undefined;
    }
    return getLastLocation();
  }
}
