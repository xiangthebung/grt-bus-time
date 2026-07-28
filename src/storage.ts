/**
 * Saved stops and rider settings, kept in `chrome.storage.sync` so they follow
 * the rider between browsers.
 *
 * Earlier versions stored one entry per route + direction + stop. A GRT stop
 * only serves one direction of travel, so those entries are collapsed into a
 * single saved stop with a route filter on first read.
 */

import {
  DEFAULT_ALERT_LEAD_MINUTES,
  DEFAULT_SETTINGS,
  DEPARTURES_PER_STOP_OPTIONS,
  MAX_SAVED_STOPS,
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
  return {
    id: stop.id,
    stopId: stop.stopId,
    stopCode: stop.stopCode || stop.stopId,
    stopName: stop.stopName,
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
    return sortStops(raw.filter(isSavedStop).map(normalize));
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
}

export async function addSavedStop(stop: NewSavedStop): Promise<SavedStop[]> {
  const stops = await getSavedStops();
  if (stops.some((candidate) => candidate.stopId === stop.stopId)) return stops;
  if (stops.length >= MAX_SAVED_STOPS) {
    throw new Error(`You can save up to ${MAX_SAVED_STOPS} stops.`);
  }
  return persist([
    ...stops,
    {
      id: crypto.randomUUID(),
      stopId: stop.stopId,
      stopCode: stop.stopCode,
      stopName: stop.stopName,
      createdAt: Date.now(),
      position: stops.length,
    },
  ]);
}

export async function removeSavedStop(id: string): Promise<SavedStop[]> {
  const stops = (await getSavedStops()).filter((stop) => stop.id !== id);
  return persist(stops);
}

/** Puts a previously removed stop back, keeping its original position. */
export async function restoreSavedStop(stop: SavedStop): Promise<SavedStop[]> {
  const stops = await getSavedStops();
  if (stops.some((candidate) => candidate.stopId === stop.stopId)) return stops;
  const restored = [...stops];
  restored.splice(Math.min(stop.position, restored.length), 0, stop);
  return persist(restored);
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
