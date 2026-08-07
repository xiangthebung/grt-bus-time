/**
 * Service worker: owns every network call, the toolbar badge, and alerts.
 *
 * Design notes
 *  - The schedule download/parse happens here so the popup never blocks on it.
 *  - Realtime polling only runs when it can actually be used (Pro access with
 *    at least one saved stop), and the poll alarm is torn down otherwise.
 *  - Realtime responses are cached briefly and shared with the popup, so
 *    opening the popup does not trigger a duplicate fetch.
 *  - Chrome restarts this worker constantly, so nothing the badge relies on is
 *    kept in a module variable alone: see the session-state section below.
 */

import { currentLocation } from "./backgroundLocation";
import { getDepartureBoard, prepareRealtime, type RealtimeLookup } from "./departures";
import {
  formatBadge,
  formatCountdown,
  formatOverdueDelay,
  minutesUntil,
} from "./format";
import {
  chooseNearestSavedStop,
  getNearestStopChoice,
  LAST_LOCATION_KEY,
  setNearestStopChoice,
} from "./geo";
import { downloadGtfsFeed } from "./gtfsStatic";
import { fetchRealtimeSnapshot } from "./gtfsRealtime";
import { isIndexFresh, readIndex, writeIndex } from "./indexStore";
import {
  GEOLOCATION_TARGET,
  type ExtensionRequest,
  type NotificationStatusPayload,
  type ScheduleReadyPayload,
} from "./messages";
import { getPaymentAccess, PAYMENTS_CONFIGURED, startPaymentBackground } from "./payments";
import { IS_PRO_BUILD } from "./pro";
import { getSavedStops, getSettings } from "./storage";
import {
  ALERT_LEAD_OPTIONS,
  DEFAULT_ALERT_LEAD_MINUTES,
  EMPTY_REALTIME,
  realtimePredictionsFresh,
  type GtfsIndex,
  type RealtimeSnapshot,
  type SavedStop,
} from "./types";

const TICK_ALARM = "surface-tick";
const LEGACY_REALTIME_ALARM = "realtime-refresh";
const SCHEDULE_ALARM = "schedule-refresh";
const SCHEDULE_PERIOD_MINUTES = 6 * 60;
/**
 * How often the badge is recomputed.
 *
 * The countdown is in whole minutes, so a once-a-minute alarm could show a
 * number that was already a minute old — the icon looked stuck. Half a minute is
 * the shortest period Chrome honours (120 and later; older versions clamp back
 * to a minute) and halves that worst case.
 *
 * It does cost fetches: `tick` refetches once the snapshot passes
 * `FETCH_AGE_NEAR_MS`, and at this period that lands on every other tick rather
 * than every one, so polling while a bus is close is roughly unchanged.
 */
const TICK_PERIOD_MINUTES = 0.5;
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
 * State that has to outlive a worker restart
 *
 * Chrome tears this service worker down after about 30 seconds of quiet and
 * starts a fresh one for the next alarm, so module-level variables are gone far
 * more often than they are kept. Anything the badge depends on between ticks
 * lives in `chrome.storage.session` instead, which survives restarts but is
 * dropped when the browser closes.
 * ------------------------------------------------------------------ */

const BADGE_MINUTES_KEY = "badgeMinutes";
/**
 * Alarms outlive the browser session, so the period we last asked for is kept in
 * the local area alongside them rather than in session storage.
 */
const TICK_PERIOD_KEY = "tickPeriodMinutes";

async function getTickPeriod(): Promise<number | undefined> {
  const stored = await chrome.storage.local.get(TICK_PERIOD_KEY);
  const value = stored[TICK_PERIOD_KEY];
  return typeof value === "number" ? value : undefined;
}

async function setTickPeriod(minutes: number | undefined): Promise<void> {
  await (minutes === undefined
    ? chrome.storage.local.remove(TICK_PERIOD_KEY)
    : chrome.storage.local.set({ [TICK_PERIOD_KEY]: minutes }));
}

/** Minutes to the soonest departure the surfaces care about, or `undefined`. */
async function getMinutesToNextDeparture(): Promise<number | undefined> {
  const stored = await chrome.storage.session.get(BADGE_MINUTES_KEY);
  const value = stored[BADGE_MINUTES_KEY];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function setMinutesToNextDeparture(minutes: number | undefined): Promise<void> {
  await (minutes === undefined
    ? chrome.storage.session.remove(BADGE_MINUTES_KEY)
    : chrome.storage.session.set({ [BADGE_MINUTES_KEY]: minutes }));
}

/* ------------------------------------------------------------------ *
 * Pro access
 * ------------------------------------------------------------------ */

async function hasProAccess(force = false): Promise<boolean> {
  if (!IS_PRO_BUILD || !PAYMENTS_CONFIGURED) return false;
  if (!force && Date.now() - paidAccessCheckedAt < PAYMENT_CACHE_MS) {
    return paidAccess;
  }
  const access = await getPaymentAccess();
  paidAccess = access.paid;
  paidAccessCheckedAt = Date.now();
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
        stale: false,
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
      stale: false,
    };
  } catch (error) {
    // A usable-but-stale copy beats no schedule at all.
    if (index) {
      return {
        fetchedAt: index.fetchedAt,
        routeCount: index.routes.length,
        stopCount: index.stops.length,
        fromCache: true,
        stale: true,
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
  return !realtimePredictionsFresh(realtime)
    ? prepareRealtime(EMPTY_REALTIME)
    : prepareRealtime(realtime);
}

/**
 * Predictions to compute the badge from, fetched first when what we hold is too
 * old to use.
 *
 * This is the difference between a badge that tracks the bus and one that just
 * reads the timetable. `realtime` is a module variable, so a restarted worker
 * starts with an empty snapshot; every path that recomputed the badge without
 * fetching would then quietly fall back to scheduled times, which is why the
 * icon could disagree with the list in the popup and sit on a stale number while
 * a bus ran late. Fetches are still shared and rate limited by `getRealtime`.
 */
async function badgeLookup(): Promise<RealtimeLookup> {
  // Only fetch when the alternative is falling back to the timetable. Keeping
  // predictions merely fresh is the tick's job, and refetching more eagerly than
  // this would double the polling rate whenever the popup is open.
  if (realtimePredictionsFresh(realtime)) return prepareRealtime(realtime);
  try {
    const latest = await getRealtime();
    return realtimePredictionsFresh(latest) ? prepareRealtime(latest) : prepareRealtime(EMPTY_REALTIME);
  } catch (error) {
    console.warn("Could not refresh predictions for the badge", error);
    return usableRealtime();
  }
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
  if (minutes <= 5) return "#c26a15";
  return "#1f7a52";
}

interface BadgeStop {
  stop: SavedStop;
  /** How the stop was chosen, so the tooltip can say what the badge is showing. */
  reason: "nearest" | "approximate" | "unknown-location" | "first-saved";
}

/**
 * Chooses the stop the badge counts down.
 *
 * With closest-stop-first on, this refreshes the position when it has gone
 * stale, keeps the previous choice unless another stop is clearly closer, and
 * flags when the position was too coarse to be sure. When there is no usable
 * position at all it falls back to the first saved stop and says so in the
 * tooltip, rather than quietly counting down a stop the rider is nowhere near.
 */
async function pickBadgeStop(
  savedStops: SavedStop[],
  currentIndex: GtfsIndex,
): Promise<BadgeStop> {
  const settings = await getSettings();
  if (!settings.nearestFirst) {
    return { stop: savedStops[0], reason: "first-saved" };
  }

  const location = await currentLocation();
  const choice = location
    ? chooseNearestSavedStop({
        savedStops,
        stops: currentIndex.stops,
        location,
        previousId: await getNearestStopChoice(),
      })
    : undefined;
  const nearest = choice && savedStops.find((stop) => stop.id === choice.id);
  if (!choice || !nearest) {
    return { stop: savedStops[0], reason: "unknown-location" };
  }

  await setNearestStopChoice(nearest.id);
  return { stop: nearest, reason: choice.confident ? "nearest" : "approximate" };
}

function badgeStopSuffix(picked: BadgeStop): string {
  switch (picked.reason) {
    case "nearest":
      return `${picked.stop.stopName} · closest stop`;
    case "approximate":
      return `${picked.stop.stopName} · closest stop (approximate)`;
    case "unknown-location":
      return `${picked.stop.stopName} · location unavailable, showing your first stop`;
    case "first-saved":
      return picked.stop.stopName;
  }
}

/** Updates the toolbar badge and reports minutes to the next departure. */
async function updateBadge(lookup: RealtimeLookup): Promise<number | undefined> {
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

  const picked = await pickBadgeStop(savedStops, currentIndex);
  // One clock for the whole update: reading Date.now() again per label can land
  // either side of a minute boundary and leave the badge and tooltip disagreeing.
  const now = Date.now();
  const board = getDepartureBoard(currentIndex, lookup, {
    stopId: picked.stop.stopId,
    limit: 1,
    now,
    // The badge counts down the same bus the card does, so the icon and the
    // popup cannot disagree about which one is next.
    ...(picked.stop.routeId ? { routeId: picked.stop.routeId } : {}),
    ...(picked.stop.directionId ? { directionId: picked.stop.directionId } : {}),
  });
  const next = board.departures[0];

  if (!next) {
    await chrome.action.setBadgeText({ text: "–" });
    await chrome.action.setBadgeBackgroundColor({ color: "#5d6b73" });
    await chrome.action.setTitle({
      title: `No upcoming departures · ${badgeStopSuffix(picked)}`,
    });
    return undefined;
  }

  const minutes = minutesUntil(next.timeMs, now);
  const countdown =
    (next.isLive ? formatOverdueDelay(next.timeMs, next.delaySec, now) : undefined) ??
    formatCountdown(next.timeMs, now);
  await chrome.action.setBadgeText({ text: formatBadge(next.timeMs, now) });
  await chrome.action.setBadgeBackgroundColor({ color: badgeColor(minutes) });
  await chrome.action.setTitle({
    title: `${next.routeShortName} to ${next.headsign} · ${countdown}${
      next.isLive ? " (live)" : ""
    } · ${badgeStopSuffix(picked)}`,
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
async function updateAlerts(lookup: RealtimeLookup): Promise<number | undefined> {
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
  const now = Date.now();
  let soonest: number | undefined;

  for (const stop of savedStops) {
    const board = getDepartureBoard(currentIndex, lookup, {
      stopId: stop.stopId,
      limit: 1,
      now,
      // An alert on a narrowed stop is about that route: another bus pulling in
      // is not what the rider asked to be told about.
      ...(stop.routeId ? { routeId: stop.routeId } : {}),
      ...(stop.directionId ? { directionId: stop.directionId } : {}),
    });
    const next = board.departures[0];
    if (!next) continue;
    const minutes = minutesUntil(next.timeMs, now);
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

/**
 * Badge and alert updates run one at a time, in the order they were asked for.
 *
 * Several things ask for a refresh at once — the tick alarm, the open popup, a
 * finished realtime fetch — and each one reads storage and builds a departure
 * board before it writes. Left to interleave, the slowest of them finishes last
 * and leaves its older countdown on the icon.
 */
let surfaceQueue: Promise<void> = Promise.resolve();
/** A run that has been asked for but has not started yet, if there is one. */
let surfaceWaiting: Promise<void> | undefined;
let surfacesRunning = false;

/**
 * Asks for a refresh, coalescing with one that is already waiting.
 *
 * Refreshes are idempotent — each one reads the current state and writes the
 * badge — so queueing more than one behind the running refresh would only repeat
 * work. Anything asked for while a refresh is in flight joins the single waiting
 * run instead, which keeps a popup that pings every few seconds from building a
 * backlog the badge then has to work through.
 */
function queueSurfaces(): Promise<void> {
  if (surfaceWaiting) return surfaceWaiting;
  const waiting = surfaceQueue.then(
    () => runSurfaces(),
    () => runSurfaces(),
  );
  surfaceWaiting = waiting;
  surfaceQueue = waiting;
  return waiting;
}

/** True while a refresh is queued or running, so callers can skip a duplicate. */
function surfacesBusy(): boolean {
  return surfacesRunning || surfaceWaiting !== undefined;
}

/** Recomputes the badge and fires any due alerts. */
async function runSurfaces(): Promise<void> {
  // Claimed here rather than in `queueSurfaces`: from this point on, a new
  // request has to wait for the next run instead of folding into this one.
  surfaceWaiting = undefined;
  surfacesRunning = true;
  try {
    const lookup = await badgeLookup();
    const badgeMinutes = await updateBadge(lookup);
    const alertMinutes = await updateAlerts(lookup);
    await setMinutesToNextDeparture(soonest(badgeMinutes, alertMinutes));
  } catch (error) {
    console.warn("Could not update the toolbar badge", error);
  } finally {
    surfacesRunning = false;
  }
}

/**
 * The heartbeat.
 *
 * The badge is always recomputed, because a countdown changes with the clock
 * whether or not new predictions arrived — that is what used to leave the icon
 * frozen between polls. The network is a separate decision, made inside
 * `badgeLookup`: it refetches when the snapshot in hand has gone cold, which
 * covers both a long gap between ticks and a freshly restarted worker.
 */
async function tick(options: { forceFetch?: boolean } = {}): Promise<void> {
  if (!(await hasProAccess())) {
    await clearBadge();
    return;
  }
  const minutes = await getMinutesToNextDeparture();
  const near = minutes === undefined || minutes <= NEAR_DEPARTURE_MINUTES;
  const age = Date.now() - realtime.fetchedAt;
  if (
    options.forceFetch ||
    !realtimePredictionsFresh(realtime) ||
    age >= (near ? FETCH_AGE_NEAR_MS : FETCH_AGE_IDLE_MS)
  ) {
    try {
      await getRealtime(true);
    } catch (error) {
      console.warn("Realtime refresh failed", error);
    }
  }
  await queueSurfaces();
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
    const existing = await chrome.alarms.get(TICK_ALARM);
    // Recreating the alarm resets its delay, so it is only done when there is
    // nothing to keep: either no alarm at all, or one an earlier version created
    // with a slower period, which would otherwise hold the countdown at that
    // old cadence for as long as the alarm survives. The period we asked for is
    // recorded rather than read back, because Chrome clamps what it reports.
    if (!existing || (await getTickPeriod()) !== TICK_PERIOD_MINUTES) {
      await chrome.alarms.create(TICK_ALARM, {
        periodInMinutes: TICK_PERIOD_MINUTES,
        delayInMinutes: TICK_PERIOD_MINUTES,
      });
      await setTickPeriod(TICK_PERIOD_MINUTES);
    }
    return;
  }

  await chrome.alarms.clear(TICK_ALARM);
  await setTickPeriod(undefined);
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
  if (area === "sync" && (changes.savedStops || changes.settings)) {
    void syncAlarms().then(() => tick());
    return;
  }
  // The popup stores positions in the local area. Reacting to them keeps the
  // badge on the same stop the popup just moved to the top of its list. A refresh
  // already under way is skipped: it will read the new position itself, and this
  // listener also sees the worker's own background lookups.
  if (area === "local" && changes[LAST_LOCATION_KEY] && !surfacesBusy()) {
    void hasProAccess().then((pro) => {
      if (pro) void queueSurfaces();
    });
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
      // Queued rather than awaited: the popup gets its data straight away, and
      // the queue guarantees this refresh cannot be overtaken by an older one.
      if (await hasProAccess()) void queueSurfaces();
      return { snapshot };
    }
    case "STOPS_CHANGED":
      await syncAlarms();
      await tick();
      return {};
    case "LOCATION_CHANGED":
      // Gated on Pro like every other refresh: the free build has no badge, so
      // there is nothing to recompute and no reason to poll the feed for it.
      if (await hasProAccess()) await queueSurfaces();
      return {};
    case "PAYMENT_CHANGED":
      await hasProAccess(true);
      await syncAlarms();
      await tick();
      return {};
    case "REFRESH_BADGE":
      // Sent while the popup is open so the icon and the list agree.
      if (await hasProAccess()) await queueSurfaces();
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
    // Offscreen traffic rides the same bus. Answering it here would win the race
    // against the offscreen document and swallow the position it just read.
    if ((request as { target?: string }).target === GEOLOCATION_TARGET) return undefined;
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
