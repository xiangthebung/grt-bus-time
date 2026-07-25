import { getArrivalsForWatches } from "./arrivals";
import { getLastLocation, getNearestWatchId, hasLocationConsent } from "./geo";
import { getGtfsCache } from "./gtfsStatic";
import { fetchRealtime } from "./gtfsRealtime";
import { getWatches } from "./storage";
import { getPaymentUser, PAYMENTS_CONFIGURED, startPaymentBackground } from "./payments";
import { IS_PRO_BUILD } from "./pro";
import {
  ALERT_LEAD_OPTIONS,
  DEFAULT_ALERT_LEAD_MINUTES,
  type RealtimeEntity,
} from "./types";

const REFRESH_ALARM = "realtime-refresh";
const REFRESH_PERIOD_MINUTES = 0.5;
const ALERT_STATE_KEY = "alertState";
const PAYMENT_CACHE_TTL_MS = 30_000;

type BackgroundMessage =
  | { type: "FETCH_GTFS"; forceRefresh?: boolean }
  | { type: "FETCH_REALTIME" }
  | { type: "LOCATION_UPDATED" }
  | { type: "ALERTS_UPDATED" }
  | { type: "PAYMENT_UPDATED" }
  | { type: "NOTIFICATION_STATUS" }
  | { type: "TEST_NOTIFICATION" }
  | { type: "PING" };

type NotificationStatus = {
  extensionPermissionGranted: boolean;
  permissionLevel: "granted" | "denied";
};

let latestRealtime: RealtimeEntity[] = [];
let paidAccess: boolean | undefined;
let paidAccessCheckedAt = 0;

function formatBadgeText(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

async function hasPaidProAccess(forceRefresh = false): Promise<boolean> {
  if (!IS_PRO_BUILD || !PAYMENTS_CONFIGURED) return false;
  if (
    !forceRefresh &&
    paidAccess !== undefined &&
    Date.now() - paidAccessCheckedAt < PAYMENT_CACHE_TTL_MS
  ) {
    return paidAccess;
  }

  try {
    const user = await getPaymentUser();
    paidAccess = Boolean(user?.paid);
    paidAccessCheckedAt = Date.now();
    return paidAccess;
  } catch (error) {
    console.warn("Unable to verify GRT Next Bus Pro access", error);
    return paidAccess ?? false;
  }
}

async function prewarmGtfs(): Promise<void> {
  try {
    await getGtfsCache();
  } catch (error) {
    console.warn("Unable to pre-warm the GRT static feed", error);
  }
}

function ensureRefreshAlarm(): void {
  if (!IS_PRO_BUILD) return;
  void chrome.alarms.create(REFRESH_ALARM, {
    delayInMinutes: REFRESH_PERIOD_MINUTES,
    periodInMinutes: REFRESH_PERIOD_MINUTES,
  });
}

async function clearBadge(): Promise<void> {
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "GRT Next Bus" });
}

async function getNotificationStatus(): Promise<NotificationStatus> {
  const extensionPermissionGranted = await chrome.permissions.contains({
    permissions: ["notifications"],
  });
  if (!extensionPermissionGranted) {
    return { extensionPermissionGranted: false, permissionLevel: "denied" };
  }

  const permissionLevel = await chrome.notifications.getPermissionLevel();
  return { extensionPermissionGranted, permissionLevel };
}

async function updateBadge(): Promise<void> {
  if (!(await hasPaidProAccess())) {
    await clearBadge();
    return;
  }
  const watches = await getWatches();
  if (watches.length === 0) {
    await clearBadge();
    return;
  }

  try {
    const cache = await getGtfsCache();
    const entities = latestRealtime.length > 0 ? latestRealtime : await fetchRealtime();
    latestRealtime = entities;
    const location = (await hasLocationConsent()) ? await getLastLocation() : undefined;
    const nearestWatchId = location
      ? getNearestWatchId(watches, cache.stops, location.latitude, location.longitude)
      : undefined;
    const badgeWatch =
      watches.find((watch) => watch.id === nearestWatchId) ?? watches[0];
    const arrivals = getArrivalsForWatches(watches, cache, entities).get(badgeWatch.id) ?? [];
    await chrome.action.setBadgeText({
      text: arrivals.length > 0 ? formatBadgeText(arrivals[0].minutes) : "–",
    });
    await chrome.action.setTitle({
      title:
        arrivals.length > 0
          ? `Next bus · ${badgeWatch.routeShortName} at ${badgeWatch.stopName} · ${arrivals[0].minutes} min away`
          : `No upcoming buses · ${badgeWatch.stopName}`,
    });
    await chrome.action.setBadgeBackgroundColor({
      color:
        arrivals.length === 0
          ? "#65717d"
          : arrivals[0].minutes <= 2
            ? "#c73737"
            : arrivals[0].minutes <= 7
              ? "#d77720"
              : "#2d8a5a",
    });
  } catch (error) {
    console.warn("Unable to update the GRT badge", error);
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({ title: "GRT Next Bus · refresh unavailable" });
    await chrome.action.setBadgeBackgroundColor({ color: "#65717d" });
  }
}

async function updateAlerts(): Promise<void> {
  if (!(await hasPaidProAccess())) return;

  const notificationStatus = await getNotificationStatus();
  if (!notificationStatus.extensionPermissionGranted || notificationStatus.permissionLevel !== "granted") {
    console.warn("GRT arrival alerts are paused because notifications are not enabled", notificationStatus);
    return;
  }

  const watches = (await getWatches()).filter((watch) => watch.alertsEnabled);
  const stored = await chrome.storage.local.get(ALERT_STATE_KEY);
  const notified =
    stored[ALERT_STATE_KEY] && typeof stored[ALERT_STATE_KEY] === "object"
      ? { ...(stored[ALERT_STATE_KEY] as Record<string, number>) }
      : {};
  const activeWatchIds = new Set(watches.map((watch) => watch.id));
  for (const watchId of Object.keys(notified)) {
    if (!activeWatchIds.has(watchId)) delete notified[watchId];
  }

  if (watches.length === 0) {
    await chrome.storage.local.set({ [ALERT_STATE_KEY]: notified });
    return;
  }

  try {
    const cache = await getGtfsCache();
    const entities = latestRealtime.length > 0 ? latestRealtime : await fetchRealtime();
    latestRealtime = entities;
    const arrivals = getArrivalsForWatches(watches, cache, entities);

    for (const watch of watches) {
      const nextArrival = arrivals.get(watch.id)?.[0];
      const savedLeadMinutes = watch.alertLeadMinutes;
      const alertLeadMinutes =
        savedLeadMinutes !== undefined &&
        ALERT_LEAD_OPTIONS.includes(savedLeadMinutes as (typeof ALERT_LEAD_OPTIONS)[number])
          ? savedLeadMinutes
          : DEFAULT_ALERT_LEAD_MINUTES;
      if (!nextArrival || nextArrival.minutes > alertLeadMinutes) continue;
      if (notified[watch.id] === nextArrival.timestamp) continue;

      await chrome.notifications.create(`grt-${watch.id}-${nextArrival.timestamp}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon.png"),
        title: `${watch.routeShortName} bus in ${nextArrival.minutes} min`,
        message: `${watch.stopName} → ${watch.tripHeadsign}`,
        priority: 0,
      });
      notified[watch.id] = nextArrival.timestamp;
    }
  } catch (error) {
    console.warn("Unable to update GRT arrival alerts", error);
  }

  await chrome.storage.local.set({ [ALERT_STATE_KEY]: notified });
}

async function refreshRealtime(): Promise<void> {
  if (!(await hasPaidProAccess())) {
    await clearBadge();
    return;
  }
  try {
    latestRealtime = await fetchRealtime();
    await updateBadge();
    await updateAlerts();
  } catch (error) {
    console.warn("Unable to refresh the GRT realtime feed", error);
    await updateBadge();
    await updateAlerts();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureRefreshAlarm();
  void prewarmGtfs();
  if (IS_PRO_BUILD) void updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  ensureRefreshAlarm();
  void prewarmGtfs();
  if (IS_PRO_BUILD) void refreshRealtime();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (IS_PRO_BUILD && alarm.name === REFRESH_ALARM) void refreshRealtime();
});

chrome.runtime.onMessage.addListener(
  (
    message: BackgroundMessage,
    _sender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (message.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "FETCH_GTFS") {
      void getGtfsCache(Boolean(message.forceRefresh))
        .then((cache) =>
          sendResponse({
            ok: true,
            fetchedAt: cache.fetchedAt,
            schemaVersion: cache.schemaVersion,
            routeCount: cache.routes.length,
            stopCount: cache.stops.length,
          }),
        )
        .catch((error: unknown) =>
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        );
      return true;
    }

    if (message.type === "FETCH_REALTIME") {
      void fetchRealtime()
        .then(async (entities) => {
          latestRealtime = entities;
          if (IS_PRO_BUILD && (await hasPaidProAccess())) {
            void updateBadge();
            void updateAlerts();
          }
          sendResponse({ ok: true, entities });
        })
        .catch((error: unknown) =>
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        );
      return true;
    }

    if (message.type === "LOCATION_UPDATED") {
      if (!IS_PRO_BUILD) {
        sendResponse({ ok: false });
        return false;
      }
      void updateBadge().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (message.type === "ALERTS_UPDATED") {
      if (!IS_PRO_BUILD) {
        sendResponse({ ok: false });
        return false;
      }
      void updateAlerts().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (message.type === "PAYMENT_UPDATED") {
      if (!IS_PRO_BUILD) {
        sendResponse({ ok: false });
        return false;
      }
      void hasPaidProAccess(true)
        .then(() => Promise.all([updateBadge(), updateAlerts()]))
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (message.type === "NOTIFICATION_STATUS") {
      if (!IS_PRO_BUILD) {
        sendResponse({ ok: false, error: "Notifications are not available in this build." });
        return false;
      }
      void getNotificationStatus()
        .then((status) => sendResponse({ ok: true, ...status }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }

    if (message.type === "TEST_NOTIFICATION") {
      if (!IS_PRO_BUILD) {
        sendResponse({ ok: false, error: "Notifications are not available in this build." });
        return false;
      }
      void (async () => {
        const status = await getNotificationStatus();
        if (!status.extensionPermissionGranted) {
          sendResponse({
            ok: false,
            ...status,
            error: "Chrome notification access was not granted for GRT Next Bus.",
          });
          return;
        }
        if (status.permissionLevel !== "granted") {
          sendResponse({
            ok: false,
            ...status,
            error: "Notifications are blocked for GRT Next Bus. Turn on notifications for Google Chrome in macOS System Settings, then try again.",
          });
          return;
        }

        const notificationId = await chrome.notifications.create(`grt-test-${Date.now()}`, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icon.png"),
          title: "GRT Next Bus test",
          message: "Chrome notifications are working.",
          priority: 0,
        });
        sendResponse({ ok: true, notificationId, ...status });
      })().catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return true;
    }

    return false;
  },
);

ensureRefreshAlarm();
void prewarmGtfs();
startPaymentBackground();
if (!IS_PRO_BUILD) void clearBadge();
