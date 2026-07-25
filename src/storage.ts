import { DEFAULT_ALERT_LEAD_MINUTES, type Watch } from "./types";

const WATCHES_KEY = "watches";

function isWatch(value: unknown): value is Watch {
  if (!value || typeof value !== "object") return false;
  const watch = value as Partial<Watch>;
  return Boolean(
    typeof watch.id === "string" &&
      typeof watch.routeId === "string" &&
      typeof watch.stopId === "string" &&
      typeof watch.directionId === "string",
  );
}

export async function getWatches(): Promise<Watch[]> {
  const result = await chrome.storage.sync.get(WATCHES_KEY);
  const watches = result[WATCHES_KEY];
  return Array.isArray(watches) ? watches.filter(isWatch) : [];
}

export async function saveWatch(watch: Watch): Promise<Watch[]> {
  const watches = await getWatches();
  const deduplicated = watches.filter(
    (existing) =>
      !(
        existing.routeId === watch.routeId &&
        existing.stopId === watch.stopId &&
        existing.directionId === watch.directionId &&
        existing.tripHeadsign === watch.tripHeadsign
      ),
  );
  deduplicated.push(watch);
  await chrome.storage.sync.set({ [WATCHES_KEY]: deduplicated });
  return deduplicated;
}

export async function deleteWatch(id: string): Promise<Watch[]> {
  const watches = (await getWatches()).filter((watch) => watch.id !== id);
  await chrome.storage.sync.set({ [WATCHES_KEY]: watches });
  return watches;
}

export async function setWatchAlerts(
  id: string,
  enabled: boolean,
  alertLeadMinutes = DEFAULT_ALERT_LEAD_MINUTES,
): Promise<Watch[]> {
  const watches = (await getWatches()).map((watch) =>
    watch.id === id
      ? { ...watch, alertsEnabled: enabled, alertLeadMinutes }
      : watch,
  );
  await chrome.storage.sync.set({ [WATCHES_KEY]: watches });
  return watches;
}
