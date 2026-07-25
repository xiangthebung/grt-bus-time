import type { Stop, Watch } from "./types";

const EARTH_RADIUS_METERS = 6_371_000;

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

export function sortStopsByDistance(
  stops: Stop[],
  latitude: number,
  longitude: number,
): Stop[] {
  return stops
    .map((stop, index) => ({
      stop,
      index,
      distance: haversineMeters(latitude, longitude, stop.lat, stop.lon),
    }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .map(({ stop }) => stop);
}

export interface StoredLocation {
  latitude: number;
  longitude: number;
  updatedAt: number;
}

const LAST_LOCATION_KEY = "lastLocation";
const LOCATION_CONSENT_KEY = "locationConsent";
const LOCATION_MAX_AGE_MS = 30 * 60 * 1000;

export function getNearestWatchId(
  watches: Watch[],
  stops: Stop[],
  latitude: number,
  longitude: number,
): string | undefined {
  const stopsById = new Map(stops.map((stop) => [stop.id, stop]));
  return watches
    .map((watch, index) => {
      const stop = stopsById.get(watch.stopId);
      return {
        id: watch.id,
        index,
        distance: stop
          ? haversineMeters(latitude, longitude, stop.lat, stop.lon)
          : Number.POSITIVE_INFINITY,
      };
    })
    .sort((a, b) => a.distance - b.distance || a.index - b.index)[0]?.id;
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
  const result = await chrome.storage.local.get(LAST_LOCATION_KEY);
  const location = result[LAST_LOCATION_KEY] as Partial<StoredLocation> | undefined;
  if (
    !location ||
    typeof location.latitude !== "number" ||
    typeof location.longitude !== "number" ||
    typeof location.updatedAt !== "number"
  ) {
    return undefined;
  }
  if (
    !Number.isFinite(location.latitude) ||
    !Number.isFinite(location.longitude) ||
    !Number.isFinite(location.updatedAt) ||
    location.latitude < -90 ||
    location.latitude > 90 ||
    location.longitude < -180 ||
    location.longitude > 180 ||
    Date.now() - location.updatedAt > LOCATION_MAX_AGE_MS
  ) {
    return undefined;
  }
  return location as StoredLocation;
}

export async function hasLocationConsent(): Promise<boolean> {
  const result = await chrome.storage.local.get(LOCATION_CONSENT_KEY);
  return result[LOCATION_CONSENT_KEY] === true;
}

export async function setLocationConsent(consented: boolean): Promise<void> {
  await chrome.storage.local.set({ [LOCATION_CONSENT_KEY]: consented });
}

export function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location is not available in this browser."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      maximumAge: 5 * 60 * 1000,
      timeout: 10_000,
    });
  });
}
