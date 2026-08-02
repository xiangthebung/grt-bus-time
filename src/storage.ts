/**
 * Saved stops and rider settings, kept in `chrome.storage.sync` so they follow
 * the rider between browsers.
 *
 * One entry per stop, holding the route/direction the rider is waiting for there.
 * A stop is one place, so two entries for it would be two cards with the same
 * name and the same code, each carrying a route selector that only spoke for one
 * of them — asking a rider to tell them apart by reading their departures.
 * Choosing a different route or direction at a stop already saved moves that
 * stop's entry instead.
 *
 * Entries written by the very first version were per route + direction + stop and
 * are collapsed on first read, as are any duplicates an older build let through.
 */

import {
  DEFAULT_ALERT_LEAD_MINUTES,
  DEFAULT_SETTINGS,
  DEPARTURES_PER_STOP_OPTIONS,
  MAX_SAVED_STOPS,
  isDirectionId,
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
  const directionId = routeId && isDirectionId(stop.directionId) ? stop.directionId : undefined;
  return {
    id: stop.id,
    stopId: stop.stopId,
    stopCode: stop.stopCode || stop.stopId,
    stopName: stop.stopName,
    // An empty string would read as a route filter that matches nothing, so it
    // is dropped back to "every route" along with a missing value.
    ...(routeId ? { routeId } : {}),
    ...(routeId &&
    typeof stop.routeShortName === "string" &&
    stop.routeShortName
      ? { routeShortName: stop.routeShortName }
      : {}),
    ...(directionId ? { directionId } : {}),
    ...(directionId &&
    typeof stop.directionHeadsign === "string" &&
    stop.directionHeadsign
      ? { directionHeadsign: stop.directionHeadsign }
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
 * Collapses repeats of a stop, keeping the one the rider put first.
 *
 * Applied on every read rather than once behind a version check, so a list that
 * arrives over sync from a browser still running an older build is cleaned up
 * here too. Alerts survive the collapse: having asked to be told about a bus at
 * this stop is not something to lose quietly.
 */
function collapseByStop(stops: SavedStop[]): SavedStop[] {
  const byStopId = new Map<string, SavedStop>();
  for (const stop of stops) {
    const kept = byStopId.get(stop.stopId);
    if (!kept) {
      byStopId.set(stop.stopId, stop);
      continue;
    }
    if (stop.alertsEnabled && !kept.alertsEnabled) {
      byStopId.set(stop.stopId, { ...kept, alertsEnabled: true });
    }
  }
  return [...byStopId.values()];
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
    const stops = collapseByStop(sortStops(raw.filter(isSavedStop).map(normalize)));
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
  /** Omit to watch every route at the stop. */
  routeId?: string;
  routeShortName?: string;
  /** When set with `routeId`, omit departures in the other direction. */
  directionId?: SavedStop["directionId"];
  /** Cached only for the picker/card label while the feed is loading. */
  directionHeadsign?: string;
}

function savedStopFor(stops: readonly SavedStop[], stopId: string): SavedStop | undefined {
  return stops.find((stop) => stop.stopId === stopId);
}

/**
 * Adds a stop, or points an already-saved one at a different route.
 *
 * The two are one call because they are one intention: pressing a route at a
 * stop means "this is the bus I am waiting for here", whether or not the stop
 * was on the list already.
 */
export async function addSavedStop(stop: NewSavedStop): Promise<SavedStop[]> {
  const stops = await getSavedStops();
  const existing = savedStopFor(stops, stop.stopId);
  if (existing) {
    return setStopRoute(
      existing.id,
      stop.routeId,
      stop.routeShortName,
      stop.directionId,
      stop.directionHeadsign,
    );
  }
  if (stops.length >= MAX_SAVED_STOPS) {
    throw new Error(`You can save up to ${MAX_SAVED_STOPS} stops.`);
  }
  return persist([
    ...stops,
    normalize(
      {
        id: crypto.randomUUID(),
        stopId: stop.stopId,
        stopCode: stop.stopCode,
        stopName: stop.stopName,
        ...(stop.routeId ? { routeId: stop.routeId } : {}),
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

/**
 * Narrows an entry to one route/direction, or widens it back to every route
 * when `routeId` is omitted.
 */
export async function setStopRoute(
  id: string,
  routeId?: string,
  routeShortName?: string,
  directionId?: SavedStop["directionId"],
  directionHeadsign?: string,
): Promise<SavedStop[]> {
  return updateSavedStop(id, {
    routeId,
    routeShortName,
    directionId,
    directionHeadsign,
  });
}

export async function removeSavedStop(id: string): Promise<SavedStop[]> {
  const stops = (await getSavedStops()).filter((stop) => stop.id !== id);
  return persist(stops);
}

/** Puts a previously removed stop back, keeping its original position. */
export async function restoreSavedStop(stop: SavedStop): Promise<SavedStop[]> {
  const stops = await getSavedStops();
  if (savedStopFor(stops, stop.stopId)) return stops;
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
