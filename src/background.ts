/**
 * Service worker: owns every network call, the toolbar badge, and alerts.
 *
 * Design notes
 *  - The schedule download/parse happens here so the popup never blocks on it.
 *  - Realtime polling only runs when it can actually be used (Pro access with
 *    at least one saved stop), and the poll alarm is torn down otherwise.
 *  - Realtime responses are cached briefly and shared with the popup, so
 *    opening the popup does not trigger a duplicate fetch.
 */

import { getDepartureBoard, prepareRealtime, type RealtimeLookup } from "./departures";
import { formatBadge, formatCountdown, minutesUntil } from "./format";
import { getLastLocation, hasLocationConsent, nearestSavedStopId } from "./geo";
import { downloadGtfsFeed } from "./gtfsStatic";
import { fetchRealtimeSnapshot } from "./gtfsRealtime";
import { isIndexFresh, readIndex, writeIndex } from "./indexStore";
import type {
  ExtensionRequest,
  NotificationStatusPayload,
  ScheduleReadyPayload,
} from "./messages";
import { getPaymentUser, PAYMENTS_CONFIGURED, startPaymentBackground } from "./payments";
import { IS_PRO_BUILD } from "./pro";
import { getSavedStops, getSettings } from "./storage";
import {
  ALERT_LEAD_OPTIONS,
  DEFAULT_ALERT_LEAD_MINUTES,
  EMPTY_REALTIME,
  REALTIME_STALE_MS,
  type GtfsIndex,
  type RealtimeSnapshot,
  type SavedStop,
} from "./types";

const TICK_ALARM = "surface-tick";
const LEGACY_REALTIME_ALARM = "realtime-refresh";
const SCHEDULE_ALARM = "schedule-refresh";
const SCHEDULE_PERIOD_MINUTES = 6 * 60;
/** The badge counts whole minutes, so it is recomputed every minute. */
const TICK_PERIOD_MINUTES = 1;
/** Predictions are refetched every tick while a bus is this close. */
const NEAR_DEPARTURE_MINUTES = 30;
const FETCH_AGE_NEAR_MS = 45_000;
const FETCH_AGE_IDLE_MS = 3 * 60 * 1000;
const REALTIME_CACHE_MS = 20_000;
const PAYMENT_CACHE_MS = 60_000;
const ALERT_STATE_KEY = "alertState";
const ALERT_REPEAT_GUARD_MS = 15 * 60 * 1000;
const NOTIFICATION_PREFIX = "grt-arrival-";

interface AlertRecord {
  tripId: string;
  notifiedAt: number;
}

let index: GtfsIndex | undefined;
let indexPromise: Promise<GtfsIndex> | undefined;
let realtime: RealtimeSnapshot = EMPTY_REALTIME;
let realtimePromise: Promise<RealtimeSnapshot> | undefined;
let paidAccess = false;
let paidAccessCheckedAt = 0;

/* ------------------------------------------------------------------ *
 * Pro access
 * ------------------------------------------------------------------ */

async function hasProAccess(force = false): Promise<boolean> {
  if (!IS_PRO_BUILD || !PAYMENTS_CONFIGURED) return false;
  if (!force && Date.now() - paidAccessCheckedAt < PAYMENT_CACHE_MS) {
    return paidAccess;
  }
  try {
    const user = await getPaymentUser();
    paidAccess = Boolean(user?.paid);
    paidAccessCheckedAt = Date.now();
  } catch (error) {
    console.warn("Could not verify Pro access", error);
  }
  return paidAccess;
}

/* ------------------------------------------------------------------ *
 * Schedule
 * ------------------------------------------------------------------ */

async function ensureSchedule(force = false): Promise<ScheduleReadyPayload> {
  if (!force) {
    index ??= await readIndex();
    if (index && isIndexFresh(index)) {
      return {
        fetchedAt: index.fetchedAt,
        routeCount: index.routes.length,
        stopCount: index.stops.length,
        fromCache: true,
      };
    }
  }

  indexPromise ??= (async () => {
    try {
      const downloaded = await downloadGtfsFeed();
      await writeIndex(downloaded);
      index = downloaded;
      return downloaded;
    } finally {
      indexPromise = undefined;
    }
  })();

  try {
    const fresh = await indexPromise;
    return {
      fetchedAt: fresh.fetchedAt,
      routeCount: fresh.routes.length,
      stopCount: fresh.stops.length,
      fromCache: false,
    };
  } catch (error) {
    // A usable-but-stale copy beats no schedule at all.
    if (index) {
      return {
        fetchedAt: index.fetchedAt,
        routeCount: index.routes.length,
        stopCount: index.stops.length,
        fromCache: true,
      };
    }
    throw error;
  }
}

async function loadedIndex(): Promise<GtfsIndex | undefined> {
  index ??= await readIndex();
  return index;
}

/* ------------------------------------------------------------------ *
 * Realtime
 * ------------------------------------------------------------------ */

async function getRealtime(force = false): Promise<RealtimeSnapshot> {
  if (!force && Date.now() - realtime.fetchedAt < REALTIME_CACHE_MS) {
    return realtime;
  }
  realtimePromise ??= (async () => {
    try {
      realtime = await fetchRealtimeSnapshot();
      return realtime;
    } finally {
      realtimePromise = undefined;
    }
  })();
  return realtimePromise;
}

/** Predictions past their shelf life are dropped in favour of the timetable. */
function usableRealtime(): RealtimeLookup {
  return Date.now() - realtime.fetchedAt > REALTIME_STALE_MS
    ? prepareRealtime(EMPTY_REALTIME)
    : prepareRealtime(realtime);
}

/* ------------------------------------------------------------------ *
 * Badge
 * ------------------------------------------------------------------ */

async function clearBadge(title = "GRT Next Bus"): Promise<void> {
  await Promise.all([
    chrome.action.setBadgeText({ text: "" }),
    chrome.action.setTitle({ title }),
  ]);
}

function badgeColor(minutes: number): string {
  if (minutes <= 2) return "#c2352f";
  if (minutes <= 7) return "#c26a15";
  return "#1f7a52";
}

async function pickBadgeStop(
  savedStops: SavedStop[],
  currentIndex: GtfsIndex,
): Promise<SavedStop> {
  const settings = await getSettings();
  if (settings.nearestFirst && (await hasLocationConsent())) {
    const location = await getLastLocation();
    if (location) {
      const nearestId = nearestSavedStopId(
        savedStops,
        currentIndex.stops,
        location.latitude,
        location.longitude,
      );
      const nearest = savedStops.find((stop) => stop.id === nearestId);
      if (nearest) return nearest;
    }
  }
  return savedStops[0];
}

/** Updates the toolbar badge and reports minutes to the next departure. */
async function updateBadge(lookup?: RealtimeLookup): Promise<number | undefined> {
  if (!(await hasProAccess())) {
    await clearBadge();
    return undefined;
  }
  const savedStops = await getSavedStops();
  if (savedStops.length === 0) {
    await clearBadge("GRT Next Bus · save a stop to see a countdown");
    return undefined;
  }
  const currentIndex = await loadedIndex();
  if (!currentIndex) {
    await clearBadge("GRT Next Bus · schedule not downloaded yet");
    return undefined;
  }

  const stop = await pickBadgeStop(savedStops, currentIndex);
  const board = getDepartureBoard(currentIndex, lookup ?? usableRealtime(), {
    stopId: stop.stopId,
    limit: 1,
  });
  const next = board.departures[0];

  if (!next) {
    await chrome.action.setBadgeText({ text: "–" });
    await chrome.action.setBadgeBackgroundColor({ color: "#5d6b73" });
    await chrome.action.setTitle({
      title: `No upcoming departures · ${stop.stopName}`,
    });
    return undefined;
  }

  const minutes = minutesUntil(next.timeMs);
  await chrome.action.setBadgeText({ text: formatBadge(next.timeMs) });
  await chrome.action.setBadgeBackgroundColor({ color: badgeColor(minutes) });
  await chrome.action.setTitle({
    title: `${next.routeShortName} to ${next.headsign} · ${formatCountdown(
      next.timeMs,
    )} · ${stop.stopName}`,
  });
  return minutes;
}

/* ------------------------------------------------------------------ *
 * Arrival alerts
 * ------------------------------------------------------------------ */

async function getNotificationStatus(): Promise<NotificationStatusPayload> {
  if (!IS_PRO_BUILD || !chrome.notifications) {
    return { permissionGranted: false, systemEnabled: false };
  }
  const permissionGranted = await chrome.permissions.contains({
    permissions: ["notifications"],
  });
  if (!permissionGranted) return { permissionGranted: false, systemEnabled: false };
  const level = await chrome.notifications.getPermissionLevel();
  return { permissionGranted: true, systemEnabled: level === "granted" };
}

function alertLeadFor(stop: SavedStop): number {
  const lead = stop.alertLeadMinutes;
  return lead !== undefined &&
    (ALERT_LEAD_OPTIONS as readonly number[]).includes(lead)
    ? lead
    : DEFAULT_ALERT_LEAD_MINUTES;
}

/**
 * Fires due alerts and reports the soonest departure among alert-enabled
 * stops, so polling can stay tight enough to hit their lead times.
 */
async function updateAlerts(lookup?: RealtimeLookup): Promise<number | undefined> {
  if (!(await hasProAccess())) return undefined;
  const savedStops = (await getSavedStops()).filter((stop) => stop.alertsEnabled);
  const stored = await chrome.storage.local.get(ALERT_STATE_KEY);
  const previous = (stored[ALERT_STATE_KEY] ?? {}) as Record<string, AlertRecord>;
  const state: Record<string, AlertRecord> = {};
  for (const stop of savedStops) {
    const record = previous[stop.id];
    if (record && Date.now() - record.notifiedAt < ALERT_REPEAT_GUARD_MS) {
      state[stop.id] = record;
    }
  }

  if (savedStops.length === 0) {
    await chrome.storage.local.set({ [ALERT_STATE_KEY]: state });
    return undefined;
  }

  const status = await getNotificationStatus();
  if (!status.permissionGranted || !status.systemEnabled) {
    await chrome.storage.local.set({ [ALERT_STATE_KEY]: state });
    return undefined;
  }

  const currentIndex = await loadedIndex();
  if (!currentIndex) return undefined;
  const resolved = lookup ?? usableRealtime();
  let soonest: number | undefined;

  for (const stop of savedStops) {
    const board = getDepartureBoard(currentIndex, resolved, {
      stopId: stop.stopId,
      limit: 1,
    });
    const next = board.departures[0];
    if (!next) continue;
    const minutes = minutesUntil(next.timeMs);
    soonest = soonest === undefined ? minutes : Math.min(soonest, minutes);
    if (minutes > alertLeadFor(stop)) continue;
    if (state[stop.id]?.tripId === next.tripId) continue;

    try {
      await chrome.notifications.create(`${NOTIFICATION_PREFIX}${stop.id}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon.png"),
        title:
          minutes <= 0
            ? `${next.routeShortName} is arriving now`
            : `${next.routeShortName} in ${minutes} min`,
        message: `${stop.stopName} → ${next.headsign}`,
        contextMessage: next.isLive ? "Live prediction" : "Scheduled time",
        priority: 2,
      });
      state[stop.id] = { tripId: next.tripId, notifiedAt: Date.now() };
    } catch (error) {
      console.warn("Could not show an arrival alert", error);
    }
  }

  await chrome.storage.local.set({ [ALERT_STATE_KEY]: state });
  return soonest;
}

/* ------------------------------------------------------------------ *
 * Scheduling
 * ------------------------------------------------------------------ */

function soonest(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

let minutesToNextDeparture: number | undefined;

/** Recomputes the badge and fires any due alerts from the data on hand. */
async function updateSurfaces(lookup: RealtimeLookup): Promise<void> {
  const badgeMinutes = await updateBadge(lookup);
  const alertMinutes = await updateAlerts(lookup);
  minutesToNextDeparture = soonest(badgeMinutes, alertMinutes);
}

/**
 * The once-a-minute heartbeat.
 *
 * The badge is always recomputed, because a countdown changes with the clock
 * whether or not new predictions arrived — that is what used to leave the icon
 * frozen between polls. The network is a separate decision: every tick while a
 * bus is close, and only every few minutes when the next one is far off.
 */
async function tick(options: { forceFetch?: boolean } = {}): Promise<void> {
  if (!(await hasProAccess())) {
    await clearBadge();
    return;
  }
  const near =
    minutesToNextDeparture === undefined ||
    minutesToNextDeparture <= NEAR_DEPARTURE_MINUTES;
  const age = Date.now() - realtime.fetchedAt;
  if (options.forceFetch || age >= (near ? FETCH_AGE_NEAR_MS : FETCH_AGE_IDLE_MS)) {
    try {
      await getRealtime(true);
    } catch (error) {
      console.warn("Realtime refresh failed", error);
    }
  }
  await updateSurfaces(usableRealtime());
}

async function syncAlarms(): Promise<void> {
  if (!chrome.alarms) return;
  await chrome.alarms.clear(LEGACY_REALTIME_ALARM);
  await chrome.alarms.create(SCHEDULE_ALARM, {
    periodInMinutes: SCHEDULE_PERIOD_MINUTES,
    delayInMinutes: SCHEDULE_PERIOD_MINUTES,
  });

  const pro = await hasProAccess();
  const savedStops = await getSavedStops();
  if (pro && savedStops.length > 0) {
    if (!(await chrome.alarms.get(TICK_ALARM))) {
      await chrome.alarms.create(TICK_ALARM, {
        periodInMinutes: TICK_PERIOD_MINUTES,
        delayInMinutes: TICK_PERIOD_MINUTES,
      });
    }
    return;
  }

  await chrome.alarms.clear(TICK_ALARM);
  if (!pro) await clearBadge();
}

async function warmUp(): Promise<void> {
  try {
    await ensureSchedule();
  } catch (error) {
    console.warn("Could not prepare the GRT schedule", error);
  }
  await syncAlarms();
  await tick();
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  void warmUp();
});

chrome.runtime.onStartup.addListener(() => {
  void warmUp();
});

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === TICK_ALARM) void tick();
    if (alarm.name === SCHEDULE_ALARM) {
      void ensureSchedule().catch((error: unknown) => {
        console.warn("Scheduled schedule refresh failed", error);
      });
    }
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.savedStops || changes.settings) {
    void syncAlarms().then(() => tick());
  }
});

if (chrome.notifications) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    chrome.notifications.clear(notificationId);
    // Available from Chrome 127; harmless where it is not.
    void chrome.action.openPopup?.().catch(() => undefined);
  });
}

async function handleRequest(request: ExtensionRequest): Promise<unknown> {
  switch (request.type) {
    case "ENSURE_SCHEDULE":
      return ensureSchedule(Boolean(request.force));
    case "GET_REALTIME": {
      const snapshot = await getRealtime(Boolean(request.force));
      if (await hasProAccess()) void updateSurfaces(prepareRealtime(snapshot));
      return { snapshot };
    }
    case "STOPS_CHANGED":
      await syncAlarms();
      await tick();
      return {};
    case "LOCATION_CHANGED":
      await updateSurfaces(usableRealtime());
      return {};
    case "PAYMENT_CHANGED":
      await hasProAccess(true);
      await syncAlarms();
      await tick();
      return {};
    case "REFRESH_BADGE":
      // Sent while the popup is open so the icon and the list agree.
      if (await hasProAccess()) await updateSurfaces(usableRealtime());
      return {};
    case "NOTIFICATION_STATUS":
      return getNotificationStatus();
    case "SEND_TEST_NOTIFICATION": {
      const status = await getNotificationStatus();
      if (status.permissionGranted && status.systemEnabled) {
        await chrome.notifications.create(`grt-test-${Date.now()}`, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icon.png"),
          title: "Alerts are working",
          message: "This is what an arrival alert looks like.",
          priority: 2,
        });
      }
      return status;
    }
    default:
      throw new Error("Unknown request.");
  }
}

chrome.runtime.onMessage.addListener(
  (request: ExtensionRequest, _sender, sendResponse: (value: unknown) => void) => {
    handleRequest(request).then(
      (payload) => sendResponse({ ok: true, ...(payload as object) }),
      (error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return true;
  },
);

startPaymentBackground();
void warmUp();
