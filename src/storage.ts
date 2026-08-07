/**
 * Saved stops and rider settings, kept in `chrome.storage.sync` so they follow
 * the rider between browsers.
 *
 * Each entry is one explicit stop + route + optional destination pattern. A stop
 * served by several routes can therefore appear more than once. The destination
 * is inferred from the physical GRT stop ID whenever possible; an omitted
 * direction is retained for legacy all-destinations entries and shared platforms.
 *
 * Entries written by the direction-aware version retain their direction. Exact
 * duplicates from an older build are still collapsed on first read.
 */

import {
  DEFAULT_ALERT_LEAD_MINUTES,
  DEFAULT_SETTINGS,
  DEPARTURES_PER_STOP_OPTIONS,
  MAX_SAVED_STOPS,
  type DirectionId,
  type LegacyWatch,
  type SavedStop,
  type Settings,
} from "./types";

const SAVED_STOPS_KEY = "savedStops";
const LEGACY_WATCHES_KEY = "watches";
const SETTINGS_KEY = "settings";

function isSavedStop(value: unknown): value is SavedStop {
  if (!value || typeof value !== "object") return false;
  const stop = value as Partial<SavedStop>;
  return (
    typeof stop.id === "string" &&
    typeof stop.stopId === "string" &&
    typeof stop.stopName === "string"
  );
}

function normalize(stop: SavedStop, fallbackPosition: number): SavedStop {
  const routeId = typeof stop.routeId === "string" && stop.routeId ? stop.routeId : undefined;
  const directionId =
    stop.directionId === "0" || stop.directionId === "1" ? stop.directionId : undefined;
  return {
    id: stop.id,
    stopId: stop.stopId,
    stopCode: stop.stopCode || stop.stopId,
    stopName: stop.stopName,
    // An empty string would read as a route filter that matches nothing, so it
    // is dropped back to "every route" along with a missing value.
    ...(routeId ? { routeId } : {}),
    ...(routeId && directionId ? { directionId } : {}),
    ...(routeId && directionId &&
    typeof stop.directionHeadsign === "string" &&
    stop.directionHeadsign
      ? { directionHeadsign: stop.directionHeadsign }
      : {}),
    ...(routeId &&
    typeof stop.routeShortName === "string" &&
    stop.routeShortName
      ? { routeShortName: stop.routeShortName }
      : {}),
    createdAt: typeof stop.createdAt === "number" ? stop.createdAt : Date.now(),
    position:
      typeof stop.position === "number" && Number.isFinite(stop.position)
        ? stop.position
        : fallbackPosition,
    ...(stop.alertsEnabled ? { alertsEnabled: true } : {}),
    ...(typeof stop.alertLeadMinutes === "number"
      ? { alertLeadMinutes: stop.alertLeadMinutes }
      : {}),
  };
}

function migrateLegacyWatches(value: unknown): SavedStop[] {
  if (!Array.isArray(value)) return [];
  const byStopId = new Map<string, SavedStop>();
  for (const entry of value as LegacyWatch[]) {
    if (!entry || typeof entry !== "object" || typeof entry.stopId !== "string") {
      continue;
    }
    const existing = byStopId.get(entry.stopId);
    if (existing) {
      existing.alertsEnabled = existing.alertsEnabled || Boolean(entry.alertsEnabled);
      continue;
    }
    byStopId.set(entry.stopId, {
      id: typeof entry.id === "string" ? entry.id : crypto.randomUUID(),
      stopId: entry.stopId,
      stopCode: entry.stopCode || entry.stopId,
      stopName: entry.stopName || `Stop ${entry.stopCode ?? entry.stopId}`,
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
      position: byStopId.size,
      ...(entry.alertsEnabled ? { alertsEnabled: true } : {}),
      ...(typeof entry.alertLeadMinutes === "number"
        ? { alertLeadMinutes: entry.alertLeadMinutes }
        : {}),
    });
  }
  return [...byStopId.values()];
}

function sortStops(stops: SavedStop[]): SavedStop[] {
  return [...stops].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
}

/**
 * Collapses repeats of the same stop + route + direction, keeping the first.
 *
 * Applied on every read rather than once behind a version check, so a list that
 * arrives over sync from a browser still running an older build is cleaned up
 * here too. Alerts survive the collapse: having asked to be told about a bus at
 * this stop is not something to lose quietly.
 */
function collapseByStopRouteDirection(stops: SavedStop[]): SavedStop[] {
  const byPair = new Map<string, SavedStop>();
  for (const stop of stops) {
    const key = `${stop.stopId}\u0000${stop.routeId ?? ""}\u0000${stop.directionId ?? ""}`;
    const kept = byPair.get(key);
    if (!kept) {
      byPair.set(key, stop);
      continue;
    }
    if (stop.alertsEnabled && !kept.alertsEnabled) {
      byPair.set(key, { ...kept, alertsEnabled: true });
    }
  }
  return [...byPair.values()];
}

/**
 * Writes the list exactly as given: array order is the truth, and `position`
 * is only a way to carry that order through storage. Sorting here would undo
 * any reordering the caller just did.
 */
async function persist(stops: SavedStop[]): Promise<SavedStop[]> {
  const ordered = stops.map((stop, index) => ({ ...stop, position: index }));
  await chrome.storage.sync.set({ [SAVED_STOPS_KEY]: ordered });
  return ordered;
}

export async function getSavedStops(): Promise<SavedStop[]> {
  const stored = await chrome.storage.sync.get([SAVED_STOPS_KEY, LEGACY_WATCHES_KEY]);
  const raw = stored[SAVED_STOPS_KEY];
  if (Array.isArray(raw)) {
    const stops = collapseByStopRouteDirection(sortStops(raw.filter(isSavedStop).map(normalize)));
    // Written back only when the collapse actually dropped something, so the
    // common read does not turn into a write and wake every other listener.
    return stops.length === raw.length ? stops : persist(stops);
  }

  const migrated = migrateLegacyWatches(stored[LEGACY_WATCHES_KEY]);
  if (migrated.length === 0) return [];
  const ordered = await persist(migrated);
  await chrome.storage.sync.remove(LEGACY_WATCHES_KEY);
  return ordered;
}

export interface NewSavedStop {
  stopId: string;
  stopCode: string;
  stopName: string;
  routeId: string;
  routeShortName?: string;
  directionId?: DirectionId;
  directionHeadsign?: string;
}

function savedStopFor(
  stops: readonly SavedStop[],
  stopId: string,
  routeId: string | undefined,
  directionId?: DirectionId,
): SavedStop | undefined {
  return stops.find(
    (stop) =>
      stop.stopId === stopId &&
      stop.routeId === routeId &&
      stop.directionId === directionId,
  );
}

/**
 * Adds one stop + route + optional destination. Repeated presses are idempotent.
 *
 * An older all-routes entry at the same stop is upgraded in place the first
 * time the rider chooses an explicit route, preserving its order and alerts.
 */
export async function addSavedStop(stop: NewSavedStop): Promise<SavedStop[]> {
  const stops = await getSavedStops();
  if (savedStopFor(stops, stop.stopId, stop.routeId, stop.directionId)) return stops;

  const legacy = savedStopFor(stops, stop.stopId, undefined, undefined);
  if (legacy) {
    return updateSavedStop(legacy.id, {
      routeId: stop.routeId,
      routeShortName: stop.routeShortName,
      ...(stop.directionId ? { directionId: stop.directionId } : {}),
      ...(stop.directionHeadsign ? { directionHeadsign: stop.directionHeadsign } : {}),
    });
  }
  // A route-only entry from an older build means "all destinations". Upgrade it
  // in place when the rider now makes an explicit choice, rather than keeping
  // an ambiguous duplicate beside the corrected journey.
  const allDestinations =
    stop.directionId !== undefined
      ? savedStopFor(stops, stop.stopId, stop.routeId, undefined)
      : undefined;
  if (allDestinations) {
    return updateSavedStop(allDestinations.id, {
      directionId: stop.directionId,
      ...(stop.directionHeadsign ? { directionHeadsign: stop.directionHeadsign } : {}),
    });
  }
  if (stops.length >= MAX_SAVED_STOPS) {
    throw new Error(`You can save up to ${MAX_SAVED_STOPS} stop and route pairs.`);
  }
  return persist([
    ...stops,
    normalize(
      {
        id: crypto.randomUUID(),
        stopId: stop.stopId,
        stopCode: stop.stopCode,
        stopName: stop.stopName,
        routeId: stop.routeId,
        ...(stop.routeShortName ? { routeShortName: stop.routeShortName } : {}),
        ...(stop.directionId ? { directionId: stop.directionId } : {}),
        ...(stop.directionHeadsign ? { directionHeadsign: stop.directionHeadsign } : {}),
        createdAt: Date.now(),
        position: stops.length,
      },
      stops.length,
    ),
  ]);
}

export async function removeSavedStop(id: string): Promise<SavedStop[]> {
  const stops = (await getSavedStops()).filter((stop) => stop.id !== id);
  return persist(stops);
}

/** Puts a previously removed stop back, keeping its original position. */
export async function restoreSavedStop(stop: SavedStop): Promise<SavedStop[]> {
  const stops = await getSavedStops();
  if (savedStopFor(stops, stop.stopId, stop.routeId, stop.directionId)) return stops;
  const restored = [...stops];
  restored.splice(Math.min(stop.position, restored.length), 0, stop);
  return persist(restored);
}

/** Persists a complete saved-stop order after validating that no stop was lost. */
export async function reorderSavedStops(ids: readonly string[]): Promise<SavedStop[]> {
  const stops = await getSavedStops();
  const idsSet = new Set(ids);
  if (
    ids.length !== stops.length ||
    idsSet.size !== ids.length ||
    stops.some((stop) => !idsSet.has(stop.id))
  ) {
    return stops;
  }
  const byId = new Map(stops.map((stop) => [stop.id, stop]));
  if (byId.size !== stops.length || ids.some((id) => !byId.has(id))) return stops;
  const reordered = ids.map((id) => byId.get(id) as SavedStop);
  return persist(reordered);
}

export async function updateSavedStop(
  id: string,
  changes: Partial<Omit<SavedStop, "id">>,
): Promise<SavedStop[]> {
  const stops = await getSavedStops();
  return persist(
    stops.map((stop) => (stop.id === id ? normalize({ ...stop, ...changes }, stop.position) : stop)),
  );
}

export async function setStopAlerts(
  id: string,
  enabled: boolean,
  leadMinutes = DEFAULT_ALERT_LEAD_MINUTES,
): Promise<SavedStop[]> {
  return updateSavedStop(id, {
    alertsEnabled: enabled,
    alertLeadMinutes: leadMinutes,
  });
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY] as Partial<Settings> | undefined;
  const departures = Number(value?.departuresPerStop);
  return {
    theme:
      value?.theme === "light" || value?.theme === "dark"
        ? value.theme
        : DEFAULT_SETTINGS.theme,
    departuresPerStop: (
      DEPARTURES_PER_STOP_OPTIONS as readonly number[]
    ).includes(departures)
      ? departures
      : DEFAULT_SETTINGS.departuresPerStop,
    nearestFirst:
      typeof value?.nearestFirst === "boolean"
        ? value.nearestFirst
        : DEFAULT_SETTINGS.nearestFirst,
  };
}

export async function saveSettings(changes: Partial<Settings>): Promise<Settings> {
  const settings = { ...(await getSettings()), ...changes };
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  return settings;
}
