import "./popup.css";
import {
  alertsForStop,
  EMPTY_LOOKUP,
  getDepartureBoard,
  prepareRealtime,
  type DepartureBoard,
  type RealtimeLookup,
} from "./departures";
import { button, element, ICONS, icon, query, queryAll } from "./dom";
import {
  formatClock,
  formatCountdown,
  formatDelay,
  formatDistance,
  formatFreshness,
  formatOverdueDelay,
  formatWalkTime,
  formatWeekday,
  minutesUntil,
  routeBadgeColor,
} from "./format";
import {
  chooseNearestSavedStop,
  getCurrentPosition,
  getNearestStopChoice,
  hasLocationConsent,
  isLocationDenied,
  nearestStops,
  resolveLocation,
  saveLastLocation,
  savedStopDistances,
  setLocationConsent,
  setNearestStopChoice,
  type StopWithDistance,
} from "./geo";
import { coversToday, isIndexFresh, readIndex } from "./indexStore";
import { errorMessage, sendRequest } from "./messages";
import {
  getPaymentPlans,
  getPaymentAccess,
  openLoginPage,
  openPaymentPage,
  PAYMENTS_CONFIGURED,
} from "./payments";
import { describePlan, type Plan } from "./plans";
import { IS_PRO_BUILD } from "./pro";
import {
  addSavedStop,
  getSavedStops,
  getSettings,
  removeSavedStop,
  reorderSavedStops,
  restoreSavedStop,
  saveSettings,
  setStopAlerts,
  updateSavedStop,
} from "./storage";
import { serviceDateKey } from "./time";
import {
  AGENCY_TIME_ZONE,
  ALERT_LEAD_OPTIONS,
  DEFAULT_ALERT_LEAD_MINUTES,
  DIRECTION_IDS,
  DEFAULT_SETTINGS,
  EMPTY_REALTIME,
  MAX_SAVED_STOPS,
  directionsAtStop,
  patternKey,
  type DirectionId,
  type GtfsIndex,
  type Route,
  realtimePredictionsFresh,
  type RealtimeSnapshot,
  type SavedStop,
  type ServiceAlert,
  type Settings,
  type Stop,
} from "./types";

const COUNTDOWN_TICK_MS = 10_000;
const REALTIME_POLL_MS = 45_000;
const SEARCH_RESULT_LIMIT = 25;
const TOAST_MS = 8_000;
const FLASH_MS = 3_000;
const FLASH_ERROR_MS = 5_000;
const CARD_ANIMATION_MS = 350;
const SCHEDULE_SLOW_MS = 10_000;

/** Cards whose entry animation has finished, so re-renders don't replay it. */
const animatedCardIds = new Set<string>();
const cardAnimationTimers = new Map<string, number>();

const el = {
  root: document.documentElement,
  topbarAddButton: query<HTMLButtonElement>("#topbar-add-button"),
  planButton: query<HTMLButtonElement>("#plan-button"),
  settingsButton: query<HTMLButtonElement>("#settings-button"),
  refreshButton: query<HTMLButtonElement>("#refresh-button"),
  feedState: query<HTMLElement>("#feed-state"),
  feedStateText: query<HTMLElement>("#feed-state-text"),
  feedDetail: query<HTMLElement>("#feed-detail"),
  banner: query<HTMLElement>("#banner"),
  bannerText: query<HTMLElement>("#banner-text"),
  bannerAction: query<HTMLButtonElement>("#banner-action"),
  settingsPanel: query<HTMLElement>("#settings-panel"),
  themeGroup: query<HTMLElement>("#theme-group"),
  countGroup: query<HTMLElement>("#count-group"),
  nearestField: query<HTMLElement>("#nearest-field"),
  nearestToggle: query<HTMLInputElement>("#nearest-toggle"),
  nearestHint: query<HTMLElement>("#nearest-hint"),
  testAlertButton: query<HTMLButtonElement>("#test-alert-button"),
  reloadScheduleButton: query<HTMLButtonElement>("#reload-schedule-button"),
  managePlanButton: query<HTMLButtonElement>("#manage-plan-button"),
  settingsNote: query<HTMLElement>("#settings-note"),
  alertsSection: query<HTMLElement>("#alerts-section"),
  alertsToggle: query<HTMLButtonElement>("#alerts-toggle"),
  alertsSummary: query<HTMLElement>("#alerts-summary"),
  alertsList: query<HTMLElement>("#alerts-list"),
  skeleton: query<HTMLElement>("#skeleton"),
  stopList: query<HTMLElement>("#stop-list"),
  emptyState: query<HTMLElement>("#empty-state"),
  emptyTitle: query<HTMLElement>("#empty-title"),
  emptyCopy: query<HTMLElement>("#empty-copy"),
  emptyNearButton: query<HTMLButtonElement>("#empty-near-button"),
  emptySearchButton: query<HTMLButtonElement>("#empty-search-button"),
  picker: query<HTMLElement>("#picker"),
  pickerToggle: query<HTMLButtonElement>("#picker-toggle"),
  pickerBody: query<HTMLElement>("#picker-body"),
  tabSearch: query<HTMLButtonElement>("#tab-search"),
  tabRoute: query<HTMLButtonElement>("#tab-route"),
  paneSearch: query<HTMLElement>("#pane-search"),
  paneRoute: query<HTMLElement>("#pane-route"),
  stopSearch: query<HTMLInputElement>("#stop-search"),
  nearButton: query<HTMLButtonElement>("#near-button"),
  searchResults: query<HTMLElement>("#search-results"),
  searchEmpty: query<HTMLElement>("#search-empty"),
  routeSelect: query<HTMLSelectElement>("#route-select"),
  routeNearButton: query<HTMLButtonElement>("#route-near-button"),
  routeSummary: query<HTMLElement>("#route-summary"),
  routeStops: query<HTMLElement>("#route-stops"),
  routeEmpty: query<HTMLElement>("#route-empty"),
  planOverlay: query<HTMLElement>("#plan-overlay"),
  planDialog: query<HTMLElement>("#plan-dialog"),
  planClose: query<HTMLButtonElement>("#plan-close"),
  planTitle: query<HTMLElement>("#plan-title"),
  planMessage: query<HTMLElement>("#plan-message"),
  planPrice: query<HTMLElement>("#plan-price"),
  upgradeButton: query<HTMLButtonElement>("#upgrade-button"),
  restoreButton: query<HTMLButtonElement>("#restore-button"),
  planStatus: query<HTMLElement>("#plan-status"),
  toast: query<HTMLElement>("#toast"),
  toastText: query<HTMLElement>("#toast-text"),
  toastAction: query<HTMLButtonElement>("#toast-action"),
  toastClose: query<HTMLButtonElement>("#toast-close"),
  liveRegion: query<HTMLElement>("#live-region"),
};

type PickerTab = "search" | "route";

interface AppState {
  index?: GtfsIndex;
  savedStops: SavedStop[];
  settings: Settings;
  lookup: RealtimeLookup;
  alerts: ServiceAlert[];
  realtime?: RealtimeSnapshot;
  realtimeAt?: number;
  realtimeFailed: boolean;
  scheduleError?: string;
  scheduleExpired: boolean;
  scheduleStale: boolean;
  loading: boolean;
  scheduleSlow: boolean;
  isPro: boolean;
  paymentUnavailable: boolean;
  /**
   * Plans as ExtensionPay reports them. `undefined` means "not asked yet", an
   * empty array means "asked, and there is nothing showable" — a difference the
   * price line has to respect, because the two say different things to a reader.
   */
  plans?: Plan[];
  planOpen: boolean;
  settingsOpen: boolean;
  pickerOpen: boolean;
  pickerTab: PickerTab;
  searchTerm: string;
  nearbyStops?: StopWithDistance[];
  nearbyFallback: boolean;
  locatingNearby: boolean;
  routeNearbyStops?: StopWithDistance[];
  locatingRouteNearby: boolean;
  locationConsent: boolean;
  distancesById?: Map<string, number>;
  nearestSavedId?: string;
  selectedRouteId: string;
  selectedDirectionId: DirectionId | "both" | "";
  alertsExpanded: boolean;
  notificationsBlocked: boolean;
  flash?: { message: string; tone: "info" | "error" };
  lastFocusBeforePlan?: HTMLElement;
}

const state: AppState = {
  savedStops: [],
  settings: { ...DEFAULT_SETTINGS },
  lookup: EMPTY_LOOKUP,
  alerts: [],
  realtimeFailed: false,
  scheduleExpired: false,
  scheduleStale: false,
  loading: true,
  scheduleSlow: false,
  isPro: false,
  paymentUnavailable: false,
  planOpen: false,
  settingsOpen: false,
  pickerOpen: false,
  pickerTab: "search",
  searchTerm: "",
  nearbyFallback: false,
  locatingNearby: false,
  locatingRouteNearby: false,
  locationConsent: false,
  selectedRouteId: "",
  selectedDirectionId: "",
  alertsExpanded: false,
  notificationsBlocked: false,
};

/* ------------------------------------------------------------------ *
 * Capabilities
 * ------------------------------------------------------------------ */

/** Pro features exist in this build (the Free channel ships without them). */
const proBuild = IS_PRO_BUILD;

function proUnlocked(): boolean {
  return proBuild && state.isPro;
}

/* ------------------------------------------------------------------ *
 * Chrome + feedback helpers
 * ------------------------------------------------------------------ */

function announce(message: string): void {
  el.liveRegion.textContent = message;
}

let flashTimer = 0;
let lastAnnouncedFeedState = "";

/**
 * Transient feedback for something the rider just did. It replaces the status
 * line under the header rather than floating over the content, so it never
 * covers a control.
 */
function flashStatus(message: string, tone: "info" | "error" = "info"): void {
  state.flash = { message, tone };
  announce(message);
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    state.flash = undefined;
    render({ background: true });
  }, tone === "error" ? FLASH_ERROR_MS : FLASH_MS);
  render();
}

function setFeedStateText(message: string): void {
  el.feedStateText.textContent = message;
  if (!message) {
    lastAnnouncedFeedState = "";
    return;
  }
  if (message === lastAnnouncedFeedState) return;
  lastAnnouncedFeedState = message;
  announce(message);
}

let toastTimer = 0;
let toastDeadline = 0;
let toastRemaining = TOAST_MS;
let toastPaused = false;

/**
 * The bottom sheet is reserved for messages that carry an action, since those
 * have to stay put long enough to be clicked. While one is up the app reserves
 * space for it so nothing underneath is blocked.
 */
function showToast(message: string, action: { label: string; run: () => void }): void {
  el.toastText.textContent = message;
  el.toast.hidden = false;
  el.toastAction.hidden = false;
  el.toastAction.textContent = action.label;
  el.toastAction.onclick = () => {
    hideToast();
    action.run();
  };
  document.body.classList.add("has-toast");
  announce(message);
  window.clearTimeout(toastTimer);
  toastRemaining = TOAST_MS;
  toastPaused = false;
  toastDeadline = Date.now() + toastRemaining;
  toastTimer = window.setTimeout(hideToast, toastRemaining);
}

function pauseToast(): void {
  if (el.toast.hidden || toastPaused) return;
  toastRemaining = Math.max(0, toastDeadline - Date.now());
  toastPaused = true;
  window.clearTimeout(toastTimer);
}

function resumeToast(): void {
  if (el.toast.hidden || !toastPaused) return;
  toastPaused = false;
  toastDeadline = Date.now() + toastRemaining;
  toastTimer = window.setTimeout(hideToast, toastRemaining);
}

function hideToast(): void {
  el.toast.hidden = true;
  document.body.classList.remove("has-toast");
  window.clearTimeout(toastTimer);
  toastDeadline = 0;
  toastRemaining = TOAST_MS;
  toastPaused = false;
}

function showBanner(
  message: string,
  options: { tone?: "error" | "info"; action?: { label: string; run: () => void } } = {},
): void {
  el.bannerText.textContent = message;
  el.banner.hidden = false;
  el.banner.classList.toggle("is-info", options.tone === "info");
  el.bannerAction.hidden = !options.action;
  if (options.action) {
    el.bannerAction.textContent = options.action.label;
    el.bannerAction.onclick = options.action.run;
  } else {
    el.bannerAction.onclick = null;
  }
}

function hideBanner(): void {
  el.banner.hidden = true;
}

/* ------------------------------------------------------------------ *
 * Theme
 * ------------------------------------------------------------------ */

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(): void {
  const resolved =
    state.settings.theme === "auto"
      ? darkQuery.matches
        ? "dark"
        : "light"
      : state.settings.theme;
  el.root.dataset.theme = resolved;
}

darkQuery.addEventListener("change", () => {
  if (state.settings.theme === "auto") applyTheme();
});

/* ------------------------------------------------------------------ *
 * Data loading
 * ------------------------------------------------------------------ */

let scheduleSlowTimer = 0;

function watchScheduleLoad(): void {
  window.clearTimeout(scheduleSlowTimer);
  state.scheduleSlow = false;
  if (!state.loading) return;
  scheduleSlowTimer = window.setTimeout(() => {
    scheduleSlowTimer = 0;
    if (!state.loading) return;
    state.scheduleSlow = true;
    announce(
      state.index
        ? "The timetable refresh is taking longer than usual."
        : "The timetable is taking longer than usual.",
    );
    render();
  }, SCHEDULE_SLOW_MS);
}

function stopWatchingScheduleLoad(): void {
  window.clearTimeout(scheduleSlowTimer);
  scheduleSlowTimer = 0;
  state.scheduleSlow = false;
}

async function loadSchedule(force = false): Promise<void> {
  watchScheduleLoad();
  try {
    // The popup normally reads this before starting the request. Reading once
    // here as well closes a small race on a cold service worker: a cached index
    // can become available while ENSURE_SCHEDULE is already in flight.
    if (!state.index) {
      const cached = await readIndex();
      if (cached) {
        state.index = cached;
        state.scheduleExpired = !coversToday(cached);
        state.scheduleStale = !isIndexFresh(cached);
        render();
      }
    }
    const summary = await sendRequest({ type: "ENSURE_SCHEDULE", ...(force ? { force } : {}) });
    if (!state.index || state.index.fetchedAt !== summary.fetchedAt) {
      const fresh = await readIndex();
      if (fresh) state.index = fresh;
    }
    if (state.index) {
      state.scheduleError = undefined;
      state.scheduleExpired = !coversToday(state.index);
      state.scheduleStale = summary.stale;
    }
  } catch (error) {
    if (!state.index) {
      state.scheduleError = errorMessage(error, "Could not load the GRT schedule.");
    } else {
      state.scheduleStale = !isIndexFresh(state.index);
    }
  } finally {
    state.loading = false;
    stopWatchingScheduleLoad();
    // Schedule and realtime are independent. Do not leave the initial loading
    // label in place while a slower live-feed request keeps initialize() open.
    render();
  }
}

async function refreshRealtime(
  options: { showErrors?: boolean; force?: boolean } = {},
): Promise<void> {
  el.refreshButton.classList.add("spinning");
  try {
    const { snapshot } = await sendRequest({
      type: "GET_REALTIME",
      ...(options.force ? { force: true } : {}),
    });
    state.realtime = snapshot;
    state.lookup = realtimePredictionsFresh(snapshot) ? prepareRealtime(snapshot) : EMPTY_LOOKUP;
    state.alerts = snapshot.alerts;
    state.realtimeAt = snapshot.fetchedAt;
    state.realtimeFailed = false;
  } catch (error) {
    state.realtimeFailed = true;
    // Keep a still-fresh last-known snapshot, but never let an old or frozen
    // prediction masquerade as current data.
    if (!state.realtime || !realtimePredictionsFresh(state.realtime)) {
      state.lookup = EMPTY_LOOKUP;
    }
    if (options.showErrors) {
      flashStatus(errorMessage(error, "Live departures are unavailable right now."), "error");
    }
  } finally {
    el.refreshButton.classList.remove("spinning");
    render({ background: true });
  }
}

async function loadPaymentStatus(): Promise<void> {
  if (!proBuild) return;
  if (!PAYMENTS_CONFIGURED) {
    state.paymentUnavailable = true;
    return;
  }
  try {
    const access = await getPaymentAccess();
    state.isPro = access.paid;
    state.paymentUnavailable = access.unavailable;
  } catch (error) {
    console.warn("Could not check Pro status", error);
    state.paymentUnavailable = true;
  }
}

/**
 * Fetches the plans, once, the first time the card is opened.
 *
 * Not at startup: most sessions never open the plan card, and a rider who wants
 * to know when the next bus is should not wait on a pricing request. Failure is
 * not surfaced as an error either — the card falls back to saying the price is
 * shown at checkout, which is true and is better than a number this build
 * happened to be compiled with.
 */
async function loadPlans(): Promise<void> {
  if (!PAYMENTS_CONFIGURED || state.plans !== undefined) return;
  try {
    state.plans = await getPaymentPlans();
  } catch (error) {
    console.warn("Could not read the plans from ExtensionPay", error);
    state.plans = [];
  }
  render();
}

async function refreshLocation(): Promise<void> {
  if (!state.index) return;
  const location = await resolveLocation();
  if (!location) {
    state.locationConsent = await hasLocationConsent();
    state.distancesById = undefined;
    state.nearestSavedId = undefined;
    return;
  }
  state.distancesById = savedStopDistances(
    state.savedStops,
    state.index.stops,
    location.latitude,
    location.longitude,
  );
  if (proUnlocked()) {
    // Same helper and same shared previous choice as the badge, so the stop this
    // list leads with is the stop the toolbar icon is counting down.
    const choice = chooseNearestSavedStop({
      savedStops: state.savedStops,
      stops: state.index.stops,
      location,
      previousId: await getNearestStopChoice(),
    });
    state.nearestSavedId = choice?.id;
    await setNearestStopChoice(choice?.id);
  } else {
    state.nearestSavedId = undefined;
  }
  void sendRequest({ type: "LOCATION_CHANGED" }).catch(() => undefined);
}

/* ------------------------------------------------------------------ *
 * Rendering: status line
 * ------------------------------------------------------------------ */

function boardFor(saved: SavedStop): DepartureBoard {
  if (!state.index) {
    return { departures: [], hasLive: false, outOfService: false, scheduleExpired: false };
  }
  return getDepartureBoard(state.index, state.lookup, {
    stopId: saved.stopId,
    // Wide enough to find later runs of whichever route comes first.
    limit: Math.min(24, state.settings.departuresPerStop * 4),
    ...(saved.routeId ? { routeId: saved.routeId } : {}),
    ...(saved.directionId ? { directionId: saved.directionId } : {}),
  });
}

function realtimeDetail(snapshot: RealtimeSnapshot | undefined): string {
  if (!snapshot) return "";
  const facts = [`Fetched ${formatFreshness(snapshot.fetchedAt)}`];
  if (snapshot.feedTimestamp !== undefined) {
    facts.push(`GRT data ${formatFreshness(snapshot.feedTimestamp)}`);
  }
  if (!snapshot.vehiclePositionsAvailable) facts.push("vehicle positions unavailable");
  if (!snapshot.alertsAvailable) facts.push("service alerts unavailable");
  if (!snapshot.tripUpdatesAvailable) facts.push("live predictions unavailable");
  return facts.join(" · ");
}

function renderFeedLine(boards: DepartureBoard[]): void {
  const classes = el.feedState.classList;
  classes.remove("is-live", "is-scheduled", "is-offline", "is-flash", "is-error", "is-loading");

  if (state.flash) {
    classes.add(state.flash.tone === "error" ? "is-error" : "is-flash");
    el.feedStateText.textContent = state.flash.message;
    el.feedDetail.textContent = "";
    return;
  }

  if (state.loading) {
    classes.add("is-loading");
    setFeedStateText(
      state.index
        ? state.scheduleSlow
          ? "Timetable refresh is taking longer than usual"
          : "Refreshing timetable…"
        : state.scheduleSlow
          ? "Timetable is taking longer than usual"
          : "Loading schedule…",
    );
    el.feedDetail.textContent = state.index ? "Using cached timetable" : "";
    return;
  }
  if (state.savedStops.length === 0) {
    // Nothing to report on yet; the empty state does the talking.
    setFeedStateText("");
    el.feedDetail.textContent = "";
    el.feedState.title = "";
    return;
  }

  const predictionsFresh = state.realtime
    ? realtimePredictionsFresh(state.realtime)
    : false;
  const hasLive = boards.some((board) => board.hasLive);
  const hasPartialFeed = Boolean(state.realtime?.degraded);
  if (hasLive && predictionsFresh) {
    classes.add("is-live");
    setFeedStateText(
      state.realtimeFailed
        ? "Last-known live departures"
        : hasPartialFeed
          ? "Live departures · partial feed"
          : "Live departures",
    );
    el.feedState.title = hasPartialFeed
      ? "Live predictions are current, but one or more supporting GRT realtime feeds are unavailable."
      : "Times marked Live come from the bus itself. The rest are schedule times.";
    el.feedDetail.textContent = realtimeDetail(state.realtime);
    return;
  }

  classes.add(state.realtimeFailed ? "is-offline" : "is-scheduled");
  setFeedStateText(
    state.realtimeFailed
      ? "Can't reach GRT · showing schedule"
      : state.realtime?.tripUpdatesAvailable === false
        ? "Live predictions unavailable · showing schedule"
        : "Scheduled times",
  );
  el.feedState.title = state.realtimeFailed
    ? "Live departures could not be loaded, so these are the published schedule times."
    : "Live predictions are not current for these stops, so these are the published schedule times.";
  el.feedDetail.textContent = realtimeDetail(state.realtime);
}

/* ------------------------------------------------------------------ *
 * Rendering: service alerts
 * ------------------------------------------------------------------ */

function renderAlerts(): void {
  if (!state.index || state.savedStops.length === 0 || state.alerts.length === 0) {
    el.alertsSection.hidden = true;
    return;
  }
  const relevant = new Map<string, ServiceAlert>();
  for (const saved of state.savedStops) {
    const alerts = alertsForStop(
      state.index,
      { ...EMPTY_REALTIME, alerts: state.alerts },
      saved.stopId,
      saved.routeId,
      Date.now(),
      saved.directionId,
    );
    for (const alert of alerts) relevant.set(alert.id, alert);
  }

  const alerts = [...relevant.values()];
  el.alertsSection.hidden = alerts.length === 0;
  if (alerts.length === 0) return;

  el.alertsSummary.textContent =
    alerts.length === 1
      ? alerts[0].title
      : `${alerts.length} service alerts for your stops`;
  el.alertsToggle.setAttribute("aria-expanded", String(state.alertsExpanded));
  el.alertsList.hidden = !state.alertsExpanded;
  el.alertsList.replaceChildren(
    element("p", {
      className: "alert-feed-note",
      text: state.realtime
        ? `GRT alerts updated ${formatFreshness(state.realtime.feedTimestamp ?? state.realtime.fetchedAt)}`
        : "GRT alert update time unavailable",
    }),
    ...alerts.map((alert) =>
      element("div", { className: "alert-item" }, [
        element("p", { className: "alert-title", text: alert.title }),
        alert.body ? element("p", { className: "alert-body", text: alert.body }) : undefined,
        alertPeriodNode(alert),
        alert.routeIds.length > 0
          ? element(
              "div",
              { className: "alert-routes" },
              alert.routeIds
                .slice(0, 8)
                .map((routeId) =>
                  element("span", {
                    className: "alert-route",
                    text: routeShortName(routeId),
                  }),
                ),
            )
          : undefined,
        alert.url
          ? (() => {
              const link = element("a", { className: "alert-link", text: "More details" });
              link.href = alert.url;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
              return link;
            })()
          : undefined,
      ]),
    ),
  );
}

function routeShortName(routeId: string): string {
  const index = state.index?.routeIndexById.get(routeId);
  return index === undefined ? routeId : (state.index?.routes[index].shortName ?? routeId);
}

const alertDateFormatter = new Intl.DateTimeFormat(undefined, {
  timeZone: AGENCY_TIME_ZONE,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function alertPeriodText(alert: ServiceAlert): string | undefined {
  const start = alert.startMs === undefined ? undefined : new Date(alert.startMs);
  const end = alert.endMs === undefined ? undefined : new Date(alert.endMs);
  const startsLater = alert.startMs !== undefined && alert.startMs > Date.now();
  if (start && end) {
    return `${startsLater ? "Starts" : "Active"} ${alertDateFormatter.format(start)} – ${alertDateFormatter.format(end)}`;
  }
  if (start) return `${startsLater ? "Starts" : "From"} ${alertDateFormatter.format(start)}`;
  if (end) return `Until ${alertDateFormatter.format(end)}`;
  return undefined;
}

function alertPeriodNode(alert: ServiceAlert): HTMLElement | undefined {
  const text = alertPeriodText(alert);
  return text ? element("p", { className: "alert-period", text }) : undefined;
}

/* ------------------------------------------------------------------ *
 * Rendering: saved stop cards
 * ------------------------------------------------------------------ */

function routeBadge(route: { shortName: string; color?: string }): HTMLElement {
  const badge = element("span", { className: "route-badge", text: route.shortName });
  const color = routeBadgeColor(route);
  if (color) {
    // Family colours are dark, so they always carry white text.
    badge.style.backgroundColor = color;
    badge.style.color = "#fff";
  }
  return badge;
}

interface TimeLabels {
  countdown: string;
  clock: string;
  className: string;
}

/**
 * Clock time is the stable schedule; the countdown is the quick urgency cue.
 * Keeping those roles fixed prevents the row from changing its reading order
 * as a departure crosses the one-hour boundary.
 *
 * When a live bus is past its predicted time, the countdown shows the delay
 * instead of "Due" — that is more honest and useful at a glance.
 */
function departureLabels(timeMs: number, delaySec?: number, now = Date.now()): TimeLabels {
  const minutes = minutesUntil(timeMs, now);
  const dayPrefix =
    serviceDateKey(timeMs) === serviceDateKey(now) ? "" : `${formatWeekday(timeMs)} `;
  const clock = `${dayPrefix}${formatClock(timeMs)}`;
  if (minutes < 60) {
    const overdue =
      delaySec === undefined ? undefined : formatOverdueDelay(timeMs, delaySec, now);
    if (overdue) {
      return {
        countdown: overdue,
        clock,
        className: "countdown is-soon",
      };
    }
    return {
      countdown: formatCountdown(timeMs, now),
      clock,
      className: `countdown${minutes <= 2 ? " is-soon" : minutes <= 5 ? " is-near" : ""}`,
    };
  }
  return {
    countdown: `in ${formatCountdown(timeMs, now)}`,
    clock,
    className: "countdown is-distant",
  };
}

type Departure = DepartureBoard["departures"][number];

interface NextBus {
  /** The soonest departure at the stop. */
  head: Departure;
  /** Its later runs, same route and same destination. */
  rest: Departure[];
}

/**
 * A card answers one question: when is my next bus, and when is the one after
 * that? Interleaving several routes in one list made the card hard to read, so
 * only the soonest departure's route is shown.
 */
function nextBus(departures: readonly Departure[], times: number): NextBus | undefined {
  const head = departures[0];
  if (!head) return undefined;
  const sameService = departures.filter(
    (departure) =>
      departure.routeId === head.routeId && departure.headsign === head.headsign,
  );
  return { head, rest: sameService.slice(1, Math.max(1, times)) };
}

/** Actual arrivals stay chronological; relative time is shown separately. */
function renderArrivalTimes(head: Departure, rest: readonly Departure[]): HTMLElement {
  const departures = [head, ...rest];
  return element(
    "p",
    {
      className: "arrival-times",
      ariaLabel: `Arrival times: ${departures
        .map((departure) => departureLabels(departure.timeMs).clock)
        .join(", ")}`,
    },
    departures.map((departure, index) =>
      element("span", {
        className: `arrival-time${index === 0 ? " is-next" : ""}`,
        ariaLabel: `${departureLabels(departure.timeMs).clock} · ${departure.isLive ? "Live" : "Scheduled"}`,
        text: departureLabels(departure.timeMs).clock,
        title: departure.isLive ? "Live prediction" : "Published schedule",
        dataset: {
          time: String(departure.timeMs),
          source: departure.isLive ? "live" : "scheduled",
        },
      }),
    ),
  );
}

function separator(): HTMLElement {
  return element("span", { className: "note-sep", text: "·" });
}

/* ------------------------------------------------------------------ *
 * Drag-and-drop reorder
 * ------------------------------------------------------------------ */

let dragStopId: string | undefined;

function autoOrderActive(): boolean {
  return (
    proUnlocked() &&
    state.settings.nearestFirst &&
    state.nearestSavedId !== undefined &&
    state.savedStops.some((stop) => stop.id === state.nearestSavedId)
  );
}

function canReorderStop(saved: SavedStop): boolean {
  return !(autoOrderActive() && saved.id === state.nearestSavedId);
}

/** Keeps the closest stop pinned while reordering the other visible cards. */
function canonicalOrderForDisplay(
  displayed: readonly SavedStop[],
  pinnedNearestId?: string,
): SavedStop[] {
  if (!pinnedNearestId || !state.savedStops.some((stop) => stop.id === pinnedNearestId)) {
    return [...displayed];
  }
  const remaining = displayed.filter((stop) => stop.id !== pinnedNearestId);
  const canonical: SavedStop[] = [];
  let nextRemaining = 0;
  for (const stop of state.savedStops) {
    if (stop.id === pinnedNearestId) {
      canonical.push(stop);
      continue;
    }
    const replacement = remaining[nextRemaining++];
    if (replacement) canonical.push(replacement);
  }
  return canonical.length === state.savedStops.length ? canonical : [...displayed];
}

async function persistDisplayOrder(
  displayed: readonly SavedStop[],
  pinnedNearestId?: string,
): Promise<void> {
  const canonical = canonicalOrderForDisplay(displayed, pinnedNearestId);
  const stops = await reorderSavedStops(canonical.map((stop) => stop.id));
  await afterStopsChanged(stops);
  flashStatus("Stop order updated");
}

function onGripKeyDown(event: KeyboardEvent, saved: SavedStop): void {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  if (!canReorderStop(saved)) {
    announce("The closest stop is ordered automatically.");
    return;
  }
  const ordered = displayOrder();
  const fromIndex = ordered.findIndex((stop) => stop.id === saved.id);
  if (fromIndex === -1) return;
  const direction = event.key === "ArrowUp" ? -1 : 1;
  const pinnedNearestId = autoOrderActive() ? state.nearestSavedId : undefined;
  let toIndex = Math.max(0, Math.min(ordered.length - 1, fromIndex + direction));
  if (pinnedNearestId) toIndex = Math.max(1, toIndex);
  if (toIndex === fromIndex) return;
  const next = [...ordered];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  void persistDisplayOrder(next, pinnedNearestId).catch((error) => {
    flashStatus(errorMessage(error, "Could not reorder stops."), "error");
  });
}

function onDragStart(event: DragEvent, saved: SavedStop): void {
  if (!canReorderStop(saved) || !event.dataTransfer) return;
  dragStopId = saved.id;
  const card = (event.currentTarget as HTMLElement).closest(".stop-card");
  if (card) card.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.dropEffect = "move";
  event.dataTransfer.setData("text/plain", saved.id);
}

function onDragEnd(_event: DragEvent): void {
  dragStopId = undefined;
  for (const card of queryAll(".stop-card")) {
    card.classList.remove("is-dragging", "is-drop-before", "is-drop-after");
  }
}

function onDragOver(event: DragEvent, saved: SavedStop): void {
  if (!dragStopId || dragStopId === saved.id || !canReorderStop(saved)) return;
  event.preventDefault();
  const card = (event.currentTarget as HTMLElement).closest(".stop-card");
  if (!card) return;
  for (const other of queryAll(".stop-card")) {
    if (other !== card) other.classList.remove("is-drop-before", "is-drop-after");
  }
  const rect = card.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  card.classList.remove("is-drop-before", "is-drop-after");
  card.classList.add(event.clientY < midY ? "is-drop-before" : "is-drop-after");
}

function onDragLeave(event: DragEvent): void {
  const card = (event.currentTarget as HTMLElement).closest(".stop-card");
  const related = event.relatedTarget;
  if (card && related instanceof Node && card.contains(related)) return;
  if (card) card.classList.remove("is-drop-before", "is-drop-after");
}

async function onDrop(event: DragEvent, targetSaved: SavedStop): Promise<void> {
  event.preventDefault();
  const sourceId = dragStopId;
  if (!sourceId || sourceId === targetSaved.id || !canReorderStop(targetSaved)) {
    onDragEnd(event);
    return;
  }
  const card = (event.currentTarget as HTMLElement).closest(".stop-card");
  if (!card) {
    onDragEnd(event);
    return;
  }
  const rect = card.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  const insertBefore = event.clientY < midY;

  const ordered = displayOrder();
  const fromIndex = ordered.findIndex((stop) => stop.id === sourceId);
  if (fromIndex === -1) {
    onDragEnd(event);
    return;
  }
  let toIndex = ordered.findIndex((stop) => stop.id === targetSaved.id);
  if (toIndex === -1) {
    onDragEnd(event);
    return;
  }
  if (!insertBefore) toIndex += 1;
  if (fromIndex < toIndex) toIndex -= 1;
  const pinnedNearestId = autoOrderActive() ? state.nearestSavedId : undefined;
  if (sourceId === pinnedNearestId) {
    onDragEnd(event);
    return;
  }
  if (pinnedNearestId) toIndex = Math.max(1, toIndex);
  toIndex = Math.max(0, Math.min(ordered.length - 1, toIndex));
  if (fromIndex === toIndex) {
    onDragEnd(event);
    return;
  }
  const next = [...ordered];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);

  onDragEnd(event);
  try {
    await persistDisplayOrder(next, pinnedNearestId);
  } catch (error) {
    flashStatus(errorMessage(error, "Could not reorder stops."), "error");
  }
}

/** Interleaves note fragments with a middot so each fact reads on its own. */
function withSeparators(parts: readonly Node[]): Node[] {
  return parts.flatMap((part, position) => (position === 0 ? [part] : [separator(), part]));
}

function departureNoteNodes(
  departure: Pick<Departure, "isLive" | "delaySec" | "stopsAway">,
  labels: TimeLabels,
  laterDepartures: readonly Pick<Departure, "isLive">[] = [],
): Node[] {
  if (!departure.isLive) {
    return [element("span", { className: "note-scheduled", text: "Scheduled" })];
  }
  const notes: Node[] = [element("span", { className: "note-live", text: "Live" })];
  const delay = formatDelay(departure.delaySec);
  if (delay && labels.countdown !== delay) {
    notes.push(
      element("span", {
        className: departure.delaySec > 0 ? "note-late" : "note-early",
        text: delay,
      }),
    );
  }
  if (departure.stopsAway !== undefined) {
    notes.push(
      element("span", {
        text:
          departure.stopsAway === 0
            ? "at your stop"
            : departure.stopsAway === 1
              ? "1 stop away"
              : `${departure.stopsAway} stops away`,
      }),
    );
  }
  if (laterDepartures.some((later) => !later.isLive)) {
    notes.push(element("span", { className: "note-scheduled", text: "later scheduled" }));
  }
  return notes;
}

function renderDeparture(group: NextBus, options: { compact?: boolean } = {}): HTMLElement {
  const departure = group.head;
  const compact = options.compact === true;
  const now = Date.now();
  const labels = departureLabels(
    departure.timeMs,
    departure.isLive ? departure.delaySec : undefined,
    now,
  );
  const notes = departureNoteNodes(departure, labels, group.rest);

  return element(
    "li",
    {
      className: `departure${compact ? " is-compact" : ""}`,
      dataset: {
        time: String(departure.timeMs),
        delay: departure.isLive ? String(departure.delaySec) : "",
      },
    },
    [
      compact
        ? undefined
        : routeBadge({
            shortName: departure.routeShortName,
            ...(departure.routeColor ? { color: departure.routeColor } : {}),
          }),
      element("div", { className: "departure-copy" }, [
        element(
          "div",
          { className: "departure-summary" },
          compact
            ? [
                element("span", { className: "departure-kicker", text: "Next" }),
                element("span", {
                  className: labels.className,
                  text: labels.countdown,
                  ariaLabel: `Next departure ${labels.countdown}`,
                }),
              ]
            : [
                element("p", {
                  className: "headsign",
                  text: departure.headsign || `Route ${departure.routeShortName}`,
                }),
                element("span", {
                  className: labels.className,
                  text: labels.countdown,
                  ariaLabel: `Next departure ${labels.countdown}`,
                }),
              ],
        ),
        renderArrivalTimes(departure, group.rest),
        notes.length > 0
          ? element(
              "p",
              {
                className: "departure-note",
                dataset: {
                  live: String(departure.isLive),
                  delay: String(departure.delaySec),
                  stopsAway:
                    departure.stopsAway === undefined
                      ? ""
                      : String(departure.stopsAway),
                  mixed: String(group.rest.some((later) => !later.isLive)),
                },
              },
              withSeparators(notes),
            )
          : undefined,
      ]),
    ],
  );
}

function alertLeadFor(saved: SavedStop): number {
  const lead = saved.alertLeadMinutes;
  return lead !== undefined && (ALERT_LEAD_OPTIONS as readonly number[]).includes(lead)
    ? lead
    : DEFAULT_ALERT_LEAD_MINUTES;
}

/**
 * The one place alert state is turned into words. Tooltips, labels, and the
 * confirmation message all read from here so they cannot drift apart, and
 * every message names its stop and route: alerts are per pair, never global.
 */
function describeAlerts(
  stopName: string,
  enabled: boolean,
  leadMinutes: number,
): { setting: string; confirmation: string } {
  const setting = enabled ? `Alerts ${leadMinutes} min before` : "Alerts off";
  // Setting first: if the stop name has to truncate, the state still reads.
  return { setting, confirmation: `${setting} · ${stopName}` };
}

function renderStopTools(saved: SavedStop): HTMLElement {
  const tools = element("div", { className: "stop-tools" });
  const menu = element("div", { className: "stop-tools-menu" });
  menu.hidden = true;
  const more = button(
    "tool-button stop-more",
    {
      ariaLabel: `More actions for ${savedEntryLabel(saved)}`,
      title: "More actions",
      dataset: { focusKey: `more:${saved.id}` },
    },
    [icon(ICONS.more)],
  );
  more.setAttribute("aria-expanded", "false");
  more.addEventListener("click", () => {
    const open = menu.hidden;
    menu.hidden = !open;
    more.setAttribute("aria-expanded", String(open));
  });
  tools.append(more, menu);

  const canReorder = canReorderStop(saved);
  const entryName = savedEntryLabel(saved);
  const grip = button(
    "tool-button stop-grip",
    {
      ariaLabel: canReorder
        ? `Reorder ${entryName}; use the arrow keys to move`
        : `${entryName} is ordered automatically as the closest stop`,
      title: canReorder
        ? "Drag to reorder, or use the arrow keys"
        : "Closest stop is ordered automatically",
      dataset: { focusKey: `grip:${saved.id}` },
    },
    [icon(ICONS.grip, true), element("span", { className: "tool-label", text: "Reorder" })],
  );
  grip.disabled = !canReorder;
  grip.draggable = canReorder;
  if (canReorder) grip.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown");
  grip.addEventListener("keydown", (event) => onGripKeyDown(event, saved));
  menu.append(grip);

  if (proBuild) {
    const enabled = Boolean(saved.alertsEnabled) && proUnlocked();
    const leadMinutes = alertLeadFor(saved);
    const { setting } = describeAlerts(entryName, enabled, leadMinutes);

    // Lead time first, then the bell it belongs to: the pair reads left to
    // right as "5 min before · alerts on". Always rendered so switching alerts
    // on or off never resizes the card.
    const select = element("select", {
      className: "lead-select",
      ariaLabel: `Alert lead time for ${entryName}`,
      dataset: { focusKey: `lead:${saved.id}` },
    });
    for (const minutes of ALERT_LEAD_OPTIONS) {
      select.append(new Option(`${minutes} min`, String(minutes)));
    }
    select.value = String(leadMinutes);
    select.disabled = !enabled;
    select.classList.toggle("is-reserved", !enabled);
    if (!enabled) select.setAttribute("aria-hidden", "true");
    select.title = `Alerting ${leadMinutes} minutes before departure`;
    select.addEventListener("change", () => {
      void updateAlertLead(saved, Number(select.value));
    });
    menu.append(select);

    const bell = button(
      "tool-button",
      {
        // Stable label plus aria-pressed, so the control reads the same way
        // whichever state it is in.
        ariaLabel: `Arrival alerts for ${entryName}`,
        title: setting,
        dataset: { focusKey: `bell:${saved.id}` },
        onClick: () => void toggleAlerts(saved),
      },
      [
        icon(enabled ? ICONS.bell : ICONS.bellOff),
        element("span", { className: "tool-label", text: "Alerts" }),
      ],
    );
    bell.setAttribute("aria-pressed", String(enabled));
    menu.append(bell);
  }

  menu.append(
    button(
      "tool-button tool-remove is-danger",
      {
        ariaLabel: `Remove ${entryName}`,
        title: "Remove this stop and route",
        dataset: { focusKey: `remove:${saved.id}` },
        onClick: () => void removeStop(saved),
      },
      [icon(ICONS.close), element("span", { className: "tool-label", text: "Remove" })],
    ),
  );
  return tools;
}

/**
 * What a saved entry is watching. The live feed is preferred over the name
 * stored with the entry so a renamed route corrects itself, and the stored name
 * covers the moment before the feed has loaded.
 */
function savedRouteLabel(saved: SavedStop): string | undefined {
  if (!saved.routeId) return undefined;
  const known = routeShortName(saved.routeId);
  return known === saved.routeId ? (saved.routeShortName ?? known) : known;
}

function savedEntryLabel(saved: SavedStop): string {
  const route = savedRouteLabel(saved);
  const direction = ` · ${savedDirectionText(saved)}`;
  return route ? `Route ${route}${direction} at ${saved.stopName}` : saved.stopName;
}

function savedDirectionText(saved: SavedStop): string {
  if (!saved.routeId) return "All destinations";
  if (saved.directionId) {
    const pattern = state.index?.patterns.get(patternKey(saved.routeId, saved.directionId));
    if (!pattern && saved.directionHeadsign) return `Toward ${saved.directionHeadsign}`;
    return directionLabel(saved.routeId, saved.directionId);
  }
  const directions = directionsForStopRoute(saved.stopId, saved.routeId);
  if (directions.length === 1) return directionLabel(saved.routeId, directions[0]);
  return "All destinations";
}

function changeSavedDirection(saved: SavedStop, directionId?: DirectionId): Promise<void> {
  const duplicate = state.savedStops.some(
    (other) =>
      other.id !== saved.id &&
      other.stopId === saved.stopId &&
      other.routeId === saved.routeId &&
      other.directionId === directionId,
  );
  if (duplicate) {
    flashStatus("That stop and destination are already saved.", "error");
    render();
    return Promise.resolve();
  }
  return updateSavedStop(saved.id, {
    ...(directionId ? { directionId, directionHeadsign: directionHeadsign(saved.routeId ?? "", directionId) } : {}),
    ...(directionId ? {} : { directionId: undefined, directionHeadsign: undefined }),
  })
    .then(afterStopsChanged)
    .then(() => flashStatus(`${saved.stopName} destination updated`))
    .catch((error) => {
      flashStatus(errorMessage(error, "Could not update that destination."), "error");
    });
}

function savedDirectionControl(saved: SavedStop): HTMLElement {
  const routeId = saved.routeId;
  if (!routeId) return element("span", { className: "saved-direction", text: "All destinations" });
  const directions = directionsForStopRoute(saved.stopId, routeId);
  if (directions.length <= 1) {
    return element("span", { className: "saved-direction", text: savedDirectionText(saved) });
  }
  const select = element("select", {
    className: "saved-direction",
    ariaLabel: `Destination for ${saved.stopName}`,
    dataset: { focusKey: `direction:${saved.id}` },
  });
  select.append(new Option("All destinations", ""));
  for (const directionId of directions) {
    select.append(new Option(directionLabel(routeId, directionId), directionId));
  }
  select.value = saved.directionId ?? "";
  select.addEventListener("change", () => {
    const value = select.value;
    void changeSavedDirection(saved, value === "" ? undefined : (value as DirectionId));
  });
  return select;
}

function stopEmptyMessage(board: DepartureBoard, saved: SavedStop): string {
  if (board.scheduleExpired) {
    return "The saved timetable does not cover today. Reload the schedule from settings.";
  }
  const route = savedRouteLabel(saved);
  if (route) {
    // Naming the route matters here: other buses may well be running, and
    // "out of service" on its own would look like the whole stop was dead.
    return `No departures for route ${route} in the next day. Other buses may still serve this stop.`;
  }
  return "No departures in the next day. This stop may be out of service.";
}

function cardShouldAnimate(id: string): boolean {
  if (animatedCardIds.has(id)) return false;
  if (!cardAnimationTimers.has(id)) {
    const timer = window.setTimeout(() => {
      animatedCardIds.add(id);
      cardAnimationTimers.delete(id);
    }, CARD_ANIMATION_MS);
    cardAnimationTimers.set(id, timer);
  }
  return true;
}

function renderStopCard(saved: SavedStop, board: DepartureBoard): HTMLElement {
  const isNearest = proUnlocked() && saved.id === state.nearestSavedId;
  const isNew = cardShouldAnimate(saved.id);
  const card = element("article", {
    className: `stop-card${isNearest ? " is-nearest" : ""}${isNew ? " is-new" : ""}`,
  });
  card.setAttribute("role", "listitem");

  // A card is one stop + route pair, so both facts live together in its heading.
  const meta = element("div", { className: "stop-meta" }, [
    element("span", { className: "meta-code", text: `Stop ${saved.stopCode}` }),
  ]);
  const route = savedRouteLabel(saved);
  const distance = state.distancesById?.get(saved.id);
  if (distance !== undefined) {
    meta.append(
      element("span", {
        className: "meta-distance",
        text: formatDistance(distance),
        title: `Straight-line distance; ${formatWalkTime(distance)} is an estimate`,
      }),
    );
  }
  if (isNearest) {
    meta.append(element("span", { className: "stop-tag", text: "Closest" }));
  }

  card.append(
    element("div", { className: "stop-head" }, [
      element("div", { className: "stop-identity" }, [
        element("h3", { className: "stop-name", text: saved.stopName, title: saved.stopName }),
        route
          ? element("div", { className: "saved-route-line" }, [
              element("span", { text: `Route ${route}` }),
              savedDirectionControl(saved),
            ])
          : undefined,
        meta,
      ]),
      renderStopTools(saved),
    ]),
  );

  const bus = nextBus(board.departures, state.settings.departuresPerStop);
  if (bus) {
    const list = element(
      "ul",
      {
        className: "departures",
        ariaLabel: route
          ? `Next route ${route} departure from ${saved.stopName}`
          : `Next departure from ${saved.stopName}`,
      },
      [renderDeparture(bus, { compact: true })],
    );
    card.append(list);
  } else {
    card.append(
      element("p", { className: "stop-empty", text: stopEmptyMessage(board, saved) }),
    );
  }

  // Drag-and-drop reorder wiring
  const grip = card.querySelector<HTMLElement>(".stop-grip");
  if (grip && !grip.hasAttribute("disabled")) {
    grip.addEventListener("dragstart", (event) => onDragStart(event as DragEvent, saved));
    grip.addEventListener("dragend", (event) => onDragEnd(event as DragEvent));
  }
  card.addEventListener("dragover", (event) => onDragOver(event as DragEvent, saved));
  card.addEventListener("dragleave", (event) => onDragLeave(event as DragEvent));
  card.addEventListener("drop", (event) => onDrop(event as DragEvent, saved));

  return card;
}

/**
 * Display order: the rider's own order, except Pro hoists the closest stop so
 * the one they are standing at is the first thing they see.
 */
function displayOrder(): SavedStop[] {
  const stops = [...state.savedStops];
  if (!autoOrderActive()) {
    return stops;
  }
  const position = stops.findIndex((stop) => stop.id === state.nearestSavedId);
  if (position <= 0) return stops;
  const [nearest] = stops.splice(position, 1);
  return [nearest, ...stops];
}

/**
 * The boards behind the cards, in display order.
 *
 * Separate from rendering them so a refresh that has to leave the list alone can
 * still report on it: the status line reads from these.
 */
function stopBoards(): { saved: SavedStop; board: DepartureBoard }[] {
  if (!state.index || state.savedStops.length === 0) return [];
  return displayOrder().map((saved) => ({ saved, board: boardFor(saved) }));
}

function renderStops(): DepartureBoard[] {
  const waitingWithoutSchedule = state.loading && !state.index;
  const slowWithoutSchedule = waitingWithoutSchedule && state.scheduleSlow;
  el.skeleton.hidden = !waitingWithoutSchedule;
  const hasStops = state.savedStops.length > 0;
  const scheduleBlocked = !state.index && !state.loading;
  el.emptyState.hidden = waitingWithoutSchedule
    ? !slowWithoutSchedule
    : Boolean(state.index) && hasStops;
  if (slowWithoutSchedule) {
    el.emptyTitle.textContent = "Timetable is taking longer than usual";
    el.emptyCopy.textContent =
      "GRT is still downloading the timetable. Keep this window open; if it does not finish, open Settings and reload the schedule.";
    el.emptyNearButton.hidden = true;
    el.emptySearchButton.hidden = true;
  } else if (scheduleBlocked) {
    el.emptyTitle.textContent = "Schedule unavailable";
    el.emptyCopy.textContent =
      "The timetable is needed to search stops. Use Retry above to download it, then add a stop.";
    el.emptyNearButton.hidden = true;
    el.emptySearchButton.hidden = true;
  } else {
    el.emptyTitle.textContent = "Save a stop to see departures";
    el.emptyCopy.textContent =
      "Find the stop you use most, then GRT Next Bus keeps its next departures one click away.";
    el.emptyNearButton.hidden = false;
    el.emptySearchButton.hidden = false;
  }
  const entries = stopBoards();
  el.stopList.replaceChildren(
    ...entries.map(({ saved, board }) => renderStopCard(saved, board)),
  );
  return entries.map((entry) => entry.board);
}

/** Cheap in-place refresh of the time labels between data loads. */
function tickCountdowns(): void {
  for (const node of queryAll<HTMLElement>(".departure[data-time]")) {
    const timeMs = Number(node.dataset.time);
    if (!Number.isFinite(timeMs)) continue;
    const delaySec = Number(node.dataset.delay);
    const countdown = node.querySelector<HTMLElement>(".countdown");
    if (!countdown) continue;
    const labels = departureLabels(
      timeMs,
      Number.isFinite(delaySec) ? delaySec : undefined,
    );
    countdown.textContent = labels.countdown;
    countdown.className = labels.className;
    countdown.setAttribute("aria-label", `Next departure ${labels.countdown}`);

    const note = node.querySelector<HTMLElement>(".departure-note");
    if (note?.dataset.live === "true") {
      const stopsAwayValue = note.dataset.stopsAway;
      const stopsAwayNumber = Number(stopsAwayValue);
      const stopsAway =
        stopsAwayValue && Number.isFinite(stopsAwayNumber) ? stopsAwayNumber : undefined;
      const noteDelay = Number(note.dataset.delay);
      note.replaceChildren(
        ...withSeparators(
          departureNoteNodes(
            {
              isLive: true,
              delaySec: Number.isFinite(noteDelay) ? noteDelay : 0,
              ...(stopsAway !== undefined ? { stopsAway } : {}),
            },
            labels,
            note.dataset.mixed === "true" ? [{ isLive: false }] : [],
          ),
        ),
      );
    }
  }
  for (const node of queryAll<HTMLElement>(".arrival-time[data-time]")) {
    const timeMs = Number(node.dataset.time);
    if (Number.isFinite(timeMs)) {
      const clock = departureLabels(timeMs).clock;
      node.textContent = clock;
      node.setAttribute(
        "aria-label",
        `${clock} · ${node.dataset.source === "live" ? "Live" : "Scheduled"}`,
      );
    }
  }
  if (state.realtime && !state.flash) {
    el.feedDetail.textContent = realtimeDetail(state.realtime);
  } else if (state.realtimeAt && !state.flash) {
    el.feedDetail.textContent = state.realtimeFailed
      ? `Last live update ${formatFreshness(state.realtimeAt)}`
      : `Updated ${formatFreshness(state.realtimeAt)}`;
  }
  // Keep the toolbar countdown in step with the list while both are visible.
  if (proUnlocked()) {
    void sendRequest({ type: "REFRESH_BADGE" }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ *
 * Rendering: stop picker
 * ------------------------------------------------------------------ */

function savedStopFor(
  stopId: string,
  routeId: string,
  directionId?: DirectionId,
): SavedStop | undefined {
  const exact = state.savedStops.find(
    (saved) =>
      saved.stopId === stopId &&
      saved.routeId === routeId &&
      saved.directionId === directionId,
  );
  if (exact || directionId === undefined) return exact;
  // Older route-only entries meant "all destinations". Treat one as the same
  // saved journey when the current feed now lets us infer the only destination
  // from the physical stop ID, so the picker does not offer a duplicate.
  return state.savedStops.find(
    (saved) =>
      saved.stopId === stopId && saved.routeId === routeId && saved.directionId === undefined,
  );
}

function routeFor(routeId: string): Route | undefined {
  const routeIndex = state.index?.routeIndexById.get(routeId);
  return routeIndex === undefined ? undefined : state.index?.routes[routeIndex];
}

function directionsForRoute(routeId: string): DirectionId[] {
  if (!state.index) return [];
  return DIRECTION_IDS.filter((directionId) =>
    state.index?.patterns.has(patternKey(routeId, directionId)),
  );
}

function directionsForStopRoute(stopId: string, routeId: string): DirectionId[] {
  if (!state.index) return [];
  return directionsAtStop(state.index, stopId, routeId);
}

function directionHeadsign(routeId: string, directionId: DirectionId): string {
  return (
    state.index?.patterns.get(patternKey(routeId, directionId))?.headsigns.slice(0, 2).join(" / ") ??
    `Direction ${directionId}`
  );
}

function directionLabel(routeId: string, directionId: DirectionId): string {
  const headsign = directionHeadsign(routeId, directionId);
  return headsign.startsWith("Direction ") ? headsign : `Toward ${headsign}`;
}

/** Routes serving a stop, in the feed's display order. */
function routesAt(stop: Stop): string[] {
  return state.index?.routeIdsByStop.get(stop.id) ?? [];
}

interface ResultItemOptions {
  distanceMeters?: number;
  showRouteBadge?: boolean;
  showDestination?: boolean;
  directionId?: DirectionId;
}

/** One explicit stop + route + direction action. */
function resultRouteItem(
  stop: Stop,
  routeId: string,
  options: ResultItemOptions = {},
): HTMLElement {
  const route = routeFor(routeId);
  const shortName = route?.shortName ?? routeId;
  const directions = directionsForStopRoute(stop.id, routeId);
  let selectedDirection =
    options.directionId ?? (directions.length === 1 ? directions[0] : undefined);
  const currentSaved = () => savedStopFor(stop.id, routeId, selectedDirection);

  let badge: HTMLElement | undefined;
  if (options.showRouteBadge !== false) {
    badge = routeBadge({
      shortName,
      ...(route?.color ? { color: route.color } : {}),
    });
    badge.classList.add("result-route-badge");
    badge.title = route?.longName
      ? `Route ${shortName} · ${route.longName}`
      : `Route ${shortName}`;
  }

  const directionControl =
    options.showDestination === false
      ? undefined
      : element("span", {
          className: "result-direction is-static",
          text:
            selectedDirection !== undefined
              ? directionLabel(routeId, selectedDirection)
              : "All destinations",
          ariaLabel:
            selectedDirection !== undefined
              ? directionLabel(routeId, selectedDirection)
              : `All destinations for route ${shortName} at ${stop.name}`,
        });

  const add = button("result-add", {
    dataset: {
      focusKey: `result-add:${stop.id}:${routeId}:${selectedDirection ?? "all"}`,
    },
  });

  function syncAddState(): void {
    const saved = currentSaved();
    const atLimit = !saved && state.savedStops.length >= MAX_SAVED_STOPS;
    add.classList.toggle("is-added", Boolean(saved));
    add.textContent = saved ? "Added" : atLimit ? "Limit" : "Add";
    add.disabled = Boolean(saved) || atLimit;
    add.setAttribute(
      "aria-label",
      saved
        ? `${directionLabelForAction(selectedDirection, routeId)} at ${stop.name} is already added`
        : atLimit
          ? `Saved limit reached; cannot add route ${shortName} at ${stop.name}`
          : `Add ${directionLabelForAction(selectedDirection, routeId)} at ${stop.name}`,
    );
    add.title = saved
      ? "This stop, route, and destination are already saved"
      : atLimit
        ? `You can save up to ${MAX_SAVED_STOPS} stop and route pairs`
        : `Add ${directionLabelForAction(selectedDirection, routeId)}`;
  }

  function directionLabelForAction(
    directionId: DirectionId | undefined,
    route: string,
  ): string {
    return directionId === undefined
      ? `Route ${route} · All destinations`
      : `Route ${route} ${directionLabel(route, directionId)}`;
  }

  add.addEventListener("click", () => {
    void saveStop(
      stop,
      routeId,
      selectedDirection,
      selectedDirection ? directionHeadsign(routeId, selectedDirection) : undefined,
    );
  });
  syncAddState();

  return element("div", { className: "result-route-entry" }, [badge, directionControl, add]);
}

/**
 * Search is stop-first: one physical stop ID normally implies one destination.
 * When GRT uses a shared platform for both destinations, show two explicit
 * rows instead of asking the rider to open a destination menu.
 */
function resultRouteItems(
  stop: Stop,
  routeId: string,
  options: ResultItemOptions = {},
): HTMLElement[] {
  if (options.directionId !== undefined) return [resultRouteItem(stop, routeId, options)];
  const directions = directionsForStopRoute(stop.id, routeId);
  if (directions.length <= 1) return [resultRouteItem(stop, routeId, options)];
  return directions.map((directionId) =>
    resultRouteItem(stop, routeId, { ...options, directionId }),
  );
}

/** Search groups multiple destinations under one route badge. This keeps a
 * shared platform honest without making two directions look like duplicate
 * route results. */
function resultRouteGroup(
  stop: Stop,
  routeId: string,
  options: ResultItemOptions = {},
): HTMLElement {
  const route = routeFor(routeId);
  const shortName = route?.shortName ?? routeId;
  const badge = routeBadge({
    shortName,
    ...(route?.color ? { color: route.color } : {}),
  });
  badge.classList.add("result-route-badge");
  badge.title = route?.longName
    ? `Route ${shortName} · ${route.longName}`
    : `Route ${shortName}`;
  const entries = resultRouteItems(stop, routeId, {
    ...options,
    showRouteBadge: false,
  });
  return element("div", { className: "result-route-group" }, [
    badge,
    element("div", { className: "result-route-options" }, entries),
  ]);
}

/** One route result for the route-browser pane. */
function resultItem(
  stop: Stop,
  routeId: string,
  options: ResultItemOptions = {},
): HTMLElement {
  const meta = element("div", { className: "result-meta" }, [
    element("span", { text: `Stop ${stop.code}` }),
    options.distanceMeters !== undefined
      ? element("span", {
          text: formatDistance(options.distanceMeters),
          title: "Straight-line distance; walking time is an estimate",
        })
      : undefined,
  ]);
  const actions = resultRouteItem(stop, routeId, options);
  actions.classList.add("route-browser-actions");
  return element("li", { className: "result-row" }, [
    element("div", { className: "result-entry" }, [
      element("div", { className: "result-copy" }, [
        element("p", { className: "result-name", text: stop.name, title: stop.name }),
        meta,
      ]),
      actions,
    ]),
  ]);
}

function resultItemsForStops(
  entries: readonly { stop: Stop; distanceMeters?: number }[],
  limit = SEARCH_RESULT_LIMIT,
): HTMLElement[] {
  const grouped = new Map<string, { name: string; entries: { stop: Stop; distanceMeters?: number }[] }>();
  let locationCount = 0;
  for (const entry of entries) {
    if (locationCount >= limit || routesAt(entry.stop).length === 0) break;
    const key = entry.stop.name;
    const group = grouped.get(key) ?? { name: entry.stop.name, entries: [] };
    group.entries.push(entry);
    grouped.set(key, group);
    locationCount += 1;
  }

  const items: HTMLElement[] = [];
  for (const group of grouped.values()) {
    const locations = element("div", { className: "result-location-list" });
    for (const entry of group.entries) {
      const mapLink =
        entry.distanceMeters === undefined
          ? undefined
          : (() => {
              const link = element("a", {
                className: "result-map-link",
                text: "Map",
                ariaLabel: `Open ${entry.stop.name}, stop ${entry.stop.code}, in Google Maps`,
              }) as HTMLAnchorElement;
              link.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                `${entry.stop.lat},${entry.stop.lon}`,
              )}`;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
              return link;
            })();
      const locationMeta = element("div", { className: "result-meta" }, [
        entry.distanceMeters !== undefined
          ? element("span", {
              text: formatDistance(entry.distanceMeters),
              title: "Straight-line distance; walking time is an estimate",
            })
          : undefined,
        mapLink,
      ]);
      const routes = routesAt(entry.stop);
      locations.append(
        element("div", { className: "result-stop-location" }, [
          element("div", { className: "result-location-heading" }, [
            element("span", {
              className: "result-stop-code",
              text: `Stop ${entry.stop.code}`,
            }),
            locationMeta,
          ]),
          element(
            "div",
            { className: "result-route-list" },
            routes.map((routeId) =>
              resultRouteGroup(entry.stop, routeId, {
                ...(entry.distanceMeters !== undefined
                  ? { distanceMeters: entry.distanceMeters }
                  : {}),
              }),
            ),
          ),
        ]),
      );
    }
    items.push(
      element("li", { className: "result-name-group" }, [
        element("div", { className: "result-name-heading" }, [
          element("p", { className: "result-name", text: group.name, title: group.name }),
          group.entries.length > 1
            ? element("span", {
                className: "result-name-count",
                text: `${group.entries.length} stop locations`,
              })
            : undefined,
        ]),
        locations,
      ]),
    );
  }
  return items;
}

function searchStops(term: string): Stop[] {
  if (!state.index) return [];
  const needle = term.trim().toLowerCase();
  if (needle.length < 2) return [];
  const digitsOnly = /^\d+$/.test(needle);
  const starts: Stop[] = [];
  const contains: Stop[] = [];
  for (const stop of state.index.stops) {
    if (digitsOnly) {
      if (stop.code.startsWith(needle)) starts.push(stop);
      else if (stop.code.includes(needle)) contains.push(stop);
      continue;
    }
    const name = stop.name.toLowerCase();
    if (name.startsWith(needle)) starts.push(stop);
    else if (name.includes(needle)) contains.push(stop);
    if (starts.length >= SEARCH_RESULT_LIMIT) break;
  }
  return [...starts, ...contains].slice(0, SEARCH_RESULT_LIMIT);
}

function renderSearchPane(): void {
  el.searchResults.replaceChildren();
  el.searchEmpty.hidden = true;
  el.stopSearch.disabled = !state.index;
  el.nearButton.disabled = !state.index || state.locatingNearby;

  if (state.locatingNearby) {
    el.searchEmpty.hidden = false;
    el.searchEmpty.textContent = "Finding stops near you…";
    return;
  }
  if (!state.index) {
    el.searchEmpty.hidden = false;
    el.searchEmpty.textContent = state.loading
      ? state.scheduleSlow
        ? "The timetable is taking longer than usual. Search will be available when it finishes."
        : "Downloading the timetable…"
      : "Schedule unavailable — retry the download above to search stops.";
    return;
  }
  if (state.searchTerm.trim().length >= 2) {
    const results = searchStops(state.searchTerm);
    if (results.length === 0) {
      el.searchEmpty.hidden = false;
      el.searchEmpty.textContent = `No stops match “${state.searchTerm.trim()}”.`;
      return;
    }
    const items = resultItemsForStops(results.map((stop) => ({ stop })));
    if (items.length === 0) {
      el.searchEmpty.hidden = false;
      el.searchEmpty.textContent = "No routes serve those stops.";
      return;
    }
    el.searchResults.append(...items);
    return;
  }
  if (state.nearbyStops) {
    if (state.nearbyStops.length === 0) {
      el.searchEmpty.hidden = false;
      el.searchEmpty.textContent = "No GRT stops within 2 km of you.";
      return;
    }
    el.searchResults.append(
      ...resultItemsForStops(
        state.nearbyStops.map((entry) => ({
          stop: entry.stop,
          distanceMeters: entry.meters,
        })),
      ),
    );
    if (state.nearbyFallback) {
      el.searchEmpty.hidden = false;
      el.searchEmpty.textContent = "No stops were within 2 km; showing the nearest stop instead.";
    }
  }
}

function renderRoutePane(): void {
  el.routeSummary.hidden = true;
  el.routeSummary.textContent = "";
  if (!state.index) {
    el.routeSelect.replaceChildren(
      new Option(state.loading ? "Downloading timetable…" : "Schedule unavailable", ""),
    );
    el.routeSelect.disabled = true;
    el.routeNearButton.disabled = true;
    el.routeStops.replaceChildren();
    el.routeEmpty.hidden = false;
    el.routeEmpty.textContent = state.loading
      ? "Routes will appear when the timetable finishes loading."
      : "Reload the timetable from Settings to browse routes.";
    return;
  }
  el.routeSelect.disabled = false;
  if (el.routeSelect.options.length <= 1) {
    el.routeSelect.replaceChildren(new Option("Choose a route", ""));
    for (const route of state.index.routes) {
      el.routeSelect.append(
        new Option(`${route.shortName} · ${route.longName}`, route.id),
      );
    }
  }
  el.routeSelect.value = state.selectedRouteId;
  const directions = DIRECTION_IDS.filter((directionId) =>
    state.index?.patterns.has(patternKey(state.selectedRouteId, directionId)),
  );
  if (directions.length <= 1) {
    state.selectedDirectionId = directions[0] ?? "";
  } else if (
    state.selectedDirectionId !== "both" &&
    !directions.includes(state.selectedDirectionId as DirectionId)
  ) {
    state.selectedDirectionId = "both";
  }

  const filteringNearby = state.routeNearbyStops !== undefined;
  el.routeNearButton.textContent = state.locatingRouteNearby
    ? "Finding…"
    : filteringNearby
      ? "Show all"
      : "Near me";
  el.routeNearButton.disabled = !state.selectedRouteId || state.locatingRouteNearby;
  el.routeNearButton.setAttribute("aria-pressed", String(filteringNearby));

  el.routeStops.replaceChildren();
  el.routeEmpty.hidden = true;
  if (!state.selectedRouteId || directions.length === 0) return;
  if (state.locatingRouteNearby) {
    el.routeEmpty.hidden = false;
    el.routeEmpty.textContent = "Finding this route near you…";
    return;
  }

  // A physical stop already identifies the side of the road in the GRT feed.
  // Browse the whole route and let the stop pattern provide the destination;
  // a destination choice here would only repeat that decision globally.
  const selectedDirections = directions;
  const stopIds = [
    ...new Set(
      selectedDirections.flatMap(
        (directionId) => state.index?.patterns.get(patternKey(state.selectedRouteId, directionId))?.stopIds ?? [],
      ),
    ),
  ];
  const stopsById = new Map(state.index.stops.map((stop) => [stop.id, stop]));
  const nearbyByStop = new Map(
    (state.routeNearbyStops ?? []).map((entry) => [entry.stop.id, entry.meters]),
  );
  const visibleStopIds = filteringNearby
    ? stopIds
        .filter((stopId) => nearbyByStop.has(stopId))
        .sort(
          (left, right) =>
            (nearbyByStop.get(left) ?? Infinity) -
            (nearbyByStop.get(right) ?? Infinity),
        )
    : stopIds;
  const items = visibleStopIds.flatMap((stopId) => {
    const stop = stopsById.get(stopId);
    if (!stop) return [];
    const distanceMeters = nearbyByStop.get(stopId);
    const stopDirections = selectedDirections.filter((directionId) =>
      state.index?.patterns
        .get(patternKey(state.selectedRouteId, directionId))
        ?.stopIds.includes(stopId),
    );
    return stopDirections.map((directionId) =>
      resultItem(stop, state.selectedRouteId, {
        showRouteBadge: false,
        showDestination: stopDirections.length > 1,
        directionId,
        ...(distanceMeters !== undefined ? { distanceMeters } : {}),
      }),
    );
  });
  if (items.length === 0) {
    el.routeEmpty.hidden = false;
    el.routeEmpty.textContent = filteringNearby
      ? "No stops for this route and destination filter are within 2 km."
      : "No stops found for this route and destination filter.";
    return;
  }
  const stopCountLabel = `${visibleStopIds.length} ${visibleStopIds.length === 1 ? "stop" : "stops"}`;
  el.routeSummary.textContent = `${stopCountLabel}${filteringNearby ? " · nearest first" : ""}`;
  el.routeSummary.hidden = false;
  el.routeStops.append(...items);
}

function renderPicker(): void {
  const atLimit = state.savedStops.length >= MAX_SAVED_STOPS;
  el.picker.classList.toggle("is-open", state.pickerOpen);
  el.topbarAddButton.textContent = state.pickerOpen ? "Close" : "Add stop";
  el.topbarAddButton.disabled =
    (!state.index && !state.pickerOpen) || (atLimit && !state.pickerOpen);
  el.topbarAddButton.title = state.pickerOpen
    ? "Close stop picker"
    : state.loading && !state.index
      ? "The timetable is still loading"
      : "Add a stop";
  el.topbarAddButton.setAttribute("aria-expanded", String(state.pickerOpen));
  el.topbarAddButton.setAttribute(
    "aria-label",
    state.pickerOpen ? "Close stop picker" : "Add a stop",
  );
  el.pickerToggle.setAttribute("aria-expanded", String(state.pickerOpen));
  el.pickerBody.hidden = !state.pickerOpen;
  el.tabRoute.disabled = !state.index;
  el.pickerToggle.querySelector(".picker-toggle-label")!.textContent = !state.index
    ? state.loading
      ? "Loading timetable…"
      : "Schedule unavailable"
    : atLimit
      ? `Saved limit reached (${MAX_SAVED_STOPS})`
      : "Add a stop";
  el.pickerToggle.disabled =
    (!state.index && !state.pickerOpen) || (atLimit && !state.pickerOpen);
  if (!state.pickerOpen) return;

  const searching = state.pickerTab === "search";
  el.tabSearch.setAttribute("aria-selected", String(searching));
  el.tabRoute.setAttribute("aria-selected", String(!searching));
  el.tabSearch.tabIndex = searching ? 0 : -1;
  el.tabRoute.tabIndex = searching ? -1 : 0;
  el.paneSearch.hidden = !searching;
  el.paneRoute.hidden = searching;
  if (searching) renderSearchPane();
  else renderRoutePane();
}

/* ------------------------------------------------------------------ *
 * Rendering: settings + plan
 * ------------------------------------------------------------------ */

function renderSettings(): void {
  el.settingsPanel.hidden = !state.settingsOpen;
  el.settingsButton.setAttribute("aria-expanded", String(state.settingsOpen));
  if (!state.settingsOpen) return;

  for (const node of queryAll<HTMLButtonElement>("#theme-group [data-theme-value]")) {
    node.setAttribute(
      "aria-checked",
      String(node.dataset.themeValue === state.settings.theme),
    );
    node.tabIndex = node.getAttribute("aria-checked") === "true" ? 0 : -1;
  }
  for (const node of queryAll<HTMLButtonElement>("#count-group [data-count-value]")) {
    node.setAttribute(
      "aria-checked",
      String(Number(node.dataset.countValue) === state.settings.departuresPerStop),
    );
    node.tabIndex = node.getAttribute("aria-checked") === "true" ? 0 : -1;
  }

  el.nearestField.hidden = !proBuild;
  el.nearestToggle.checked =
    state.settings.nearestFirst && proUnlocked() && state.locationConsent;
  el.nearestHint.textContent = !proUnlocked()
    ? "Included with Pro. Your location never leaves this device."
    : state.locationConsent
      ? "Uses your location on this device only."
      : "Off until you allow location access on this device.";
  el.testAlertButton.hidden = !proUnlocked();
  el.managePlanButton.hidden = !proUnlocked();

  const notes: string[] = [];
  if (state.index) {
    const first = state.index.serviceDates[0];
    const last = state.index.serviceDates[state.index.serviceDates.length - 1];
    const updateLabel = state.loading
      ? state.scheduleSlow
        ? "Timetable refresh is taking longer than usual · cached copy updated"
        : "Refreshing timetable · cached copy updated"
      : "Timetable updated";
    notes.push(`${updateLabel} ${formatFreshness(state.index.fetchedAt)}`);
    if (state.scheduleStale) notes.push("cached copy is older than usual");
    if (first && last) {
      notes.push(`covers ${prettyDate(first)} – ${prettyDate(last)}`);
    }
    notes.push(`${state.index.stops.length} stops`);
  } else if (state.loading) {
    notes.push(
      state.scheduleSlow
        ? "Timetable is taking longer than usual"
        : "Downloading timetable…",
    );
  }
  el.settingsNote.textContent = notes.join(" · ");
}

function prettyDate(dateKey: string): string {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(4, 6));
  const day = Number(dateKey.slice(6, 8));
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(year, month - 1, day),
  );
}

function renderPlan(): void {
  // Once Pro is active the chip has nothing left to offer, so the header loses
  // it and plan management moves into Settings.
  el.planButton.hidden = !proBuild || proUnlocked();
  el.planButton.textContent = "Get Pro";
  el.planButton.setAttribute("aria-label", "See what Pro adds");
  el.planOverlay.hidden = !state.planOpen;
  if (!state.planOpen) return;

  const configured = PAYMENTS_CONFIGURED;
  el.upgradeButton.disabled = !configured;
  el.restoreButton.disabled = !configured;

  if (proUnlocked()) {
    el.planTitle.textContent = "Pro is active";
    el.planMessage.textContent =
      "Toolbar countdown, arrival alerts, and closest-stop ordering are all on.";
    el.planPrice.hidden = true;
    el.upgradeButton.textContent = "Manage subscription";
    el.restoreButton.textContent = "Refresh plan status";
    el.planStatus.textContent = "Thanks for supporting the extension.";
    return;
  }

  el.planPrice.hidden = false;
  renderPlanPrice();
  el.upgradeButton.textContent = "Get Pro";
  el.restoreButton.textContent = "Already purchased? Restore";
  el.planTitle.textContent = "Catch your bus without checking";
  el.planMessage.textContent =
    "Pro keeps your next departure on the toolbar and taps you on the shoulder before it arrives.";
  el.planStatus.textContent = !configured
    ? "Checkout is not configured in this build."
    : state.paymentUnavailable
      ? "Your plan status could not be checked. Try again when you are back online."
      : "Saved stops keep working either way.";
}

/**
 * The price line, from whatever ExtensionPay said.
 *
 * Three states, all of them honest: nothing yet while the request is in flight,
 * the real amounts once they arrive, and a plain sentence pointing at checkout if
 * they never do. There is deliberately no fourth state where a number compiled
 * into this build stands in for one it cannot confirm.
 */
function renderPlanPrice(): void {
  const plans = state.plans;
  el.planPrice.replaceChildren();

  if (plans === undefined) {
    el.planPrice.classList.add("is-loading");
    el.planPrice.append(element("span", { text: "Checking the current price…" }));
    return;
  }

  el.planPrice.classList.remove("is-loading");

  if (plans.length === 0) {
    el.planPrice.append(
      element("span", { text: "The price and billing period are shown at checkout." }),
    );
    return;
  }

  plans.forEach((plan, index) => {
    const offer = describePlan(plan);
    if (index > 0) el.planPrice.append(element("em", { text: "or" }));
    el.planPrice.append(
      element("strong", { text: offer.amount }),
      element("span", { text: offer.period }),
    );
  });
}

/* ------------------------------------------------------------------ *
 * Render entry point
 * ------------------------------------------------------------------ */

/**
 * Cards are rebuilt wholesale on every data change, so remember which control
 * held focus and hand it back. Without this, a background refresh would yank
 * focus away mid-interaction.
 */
function captureFocusKey(): string | undefined {
  const active = document.activeElement;
  return active instanceof HTMLElement ? active.dataset.focusKey : undefined;
}

function restoreFocus(focusKey: string | undefined): void {
  if (!focusKey) return;
  const target = document.querySelector<HTMLElement>(
    `[data-focus-key="${CSS.escape(focusKey)}"]`,
  );
  target?.focus();
}

/**
 * True while a native dropdown is open somewhere in the popup.
 *
 * A `<select>` holds focus while its menu is up. Rebuilding the markup around
 * it — or even reassigning its value — closes that menu.
 */
function menuIsOpen(): boolean {
  return document.activeElement instanceof HTMLSelectElement;
}

/**
 * `background: true` marks a refresh nobody asked for: the realtime poll, an
 * expiring status message, a change synced from another window.
 *
 * Those used to rebuild the stop list and the picker underneath an open menu,
 * which shut it the instant it was opened — a route menu only has to be up for a
 * second to be caught by a poll that runs every forty-five seconds. Background
 * refreshes now leave both regions alone while a menu is open. Nothing goes
 * stale: the countdowns are updated in place on their own timer, the status line
 * still refreshes, and the next thing the rider does rebuilds the rest.
 */
function render(options: { background?: boolean } = {}): void {
  const focusKey = captureFocusKey();
  const keepMenuOpen = Boolean(options.background) && menuIsOpen();
  const boards = keepMenuOpen
    ? stopBoards().map((entry) => entry.board)
    : renderStops();
  renderFeedLine(boards);
  renderAlerts();
  if (!keepMenuOpen) renderPicker();
  renderSettings();
  renderPlan();

  if (state.scheduleError) {
    showBanner(state.scheduleError, {
      action: { label: "Retry", run: () => void reloadSchedule() },
    });
  } else if (state.loading && state.scheduleSlow) {
    showBanner(
      state.index
        ? "The timetable refresh is taking longer than usual. Cached departures remain available."
        : "The timetable is taking longer than usual. Keep this window open while GRT data downloads.",
      { tone: "info" },
    );
  } else if (state.scheduleExpired) {
    showBanner("This timetable does not cover today.", {
      tone: "info",
      action: { label: "Reload", run: () => void reloadSchedule() },
    });
  } else if (state.scheduleStale && state.index) {
    showBanner(`Using a cached timetable updated ${formatFreshness(state.index.fetchedAt)}.`, {
      tone: "info",
      action: { label: "Reload", run: () => void reloadSchedule() },
    });
  } else if (state.notificationsBlocked) {
    showBanner(
      "Chrome is not allowed to show notifications, so arrival alerts stay quiet. Turn them on for Chrome in your system settings.",
      { tone: "info" },
    );
  } else {
    hideBanner();
  }

  restoreFocus(focusKey);
}

function focusPickerStart(): void {
  if (!state.pickerOpen) return;
  (state.pickerTab === "search" ? el.stopSearch : el.routeSelect).focus();
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

async function afterStopsChanged(stops: SavedStop[]): Promise<void> {
  state.savedStops = stops;
  render();
  void sendRequest({ type: "STOPS_CHANGED" }).catch(() => undefined);
  if (state.settings.nearestFirst && (await hasLocationConsent())) {
    await refreshLocation();
    render();
  }
}

/** Saves one explicit stop + route + direction and leaves the picker open. */
async function saveStop(
  stop: Stop,
  routeId: string,
  directionId?: DirectionId,
  directionHeadsignValue?: string,
): Promise<void> {
  const shortName = routeFor(routeId)?.shortName ?? routeId;
  if (savedStopFor(stop.id, routeId, directionId)) {
    flashStatus(`Already added · route ${shortName} at ${stop.name}`);
    return;
  }
  try {
    const stops = await addSavedStop({
      stopId: stop.id,
      stopCode: stop.code,
      stopName: stop.name,
      routeId,
      routeShortName: shortName,
      ...(directionId ? { directionId } : {}),
      ...(directionHeadsignValue ? { directionHeadsign: directionHeadsignValue } : {}),
    });
    await afterStopsChanged(stops);
    flashStatus(`Saved · route ${shortName} at ${stop.name}`);
  } catch (error) {
    flashStatus(errorMessage(error, "Could not save that stop and route."), "error");
  }
}

async function removeStop(saved: SavedStop): Promise<void> {
  try {
    const stops = await removeSavedStop(saved.id);
    await afterStopsChanged(stops);
    showToast(`${savedEntryLabel(saved)} removed`, {
      label: "Undo",
      run: () => {
        void restoreSavedStop(saved)
          .then(afterStopsChanged)
          .catch((error) => flashStatus(errorMessage(error, "Could not restore that stop."), "error"));
      },
    });
    el.toastAction.focus();
  } catch (error) {
    flashStatus(errorMessage(error, "Could not remove that stop."), "error");
  }
}

async function toggleAlerts(saved: SavedStop): Promise<void> {
  try {
    if (!proUnlocked()) {
      openPlan();
      return;
    }
    const enabling = !saved.alertsEnabled;
    if (enabling) {
      // Must be requested straight from the click to keep the user gesture.
      const granted = await chrome.permissions.request({ permissions: ["notifications"] });
      if (!granted) {
        flashStatus("Arrival alerts need Chrome's notification permission.", "error");
        return;
      }
      const status = await sendRequest({ type: "NOTIFICATION_STATUS" }).catch(() => undefined);
      state.notificationsBlocked = Boolean(status && !status.systemEnabled);
    } else if (
      // Only stop warning once no stop is waiting on notifications.
      !state.savedStops.some((stop) => stop.id !== saved.id && stop.alertsEnabled)
    ) {
      state.notificationsBlocked = false;
    }

    const leadMinutes = alertLeadFor(saved);
    const stops = await setStopAlerts(saved.id, enabling, leadMinutes);
    await afterStopsChanged(stops);
    flashStatus(describeAlerts(savedEntryLabel(saved), enabling, leadMinutes).confirmation);
  } catch (error) {
    flashStatus(errorMessage(error, "Could not update arrival alerts."), "error");
  }
}

/** Changing the lead time confirms itself the same way toggling does. */
async function updateAlertLead(saved: SavedStop, leadMinutes: number): Promise<void> {
  try {
    if (!proUnlocked()) return;
    // Editing the lead time never changes whether alerts are on, so the
    // confirmation reports the same state the card shows.
    const enabled = Boolean(saved.alertsEnabled);
    const stops = await setStopAlerts(saved.id, enabled, leadMinutes);
    await afterStopsChanged(stops);
    flashStatus(describeAlerts(savedEntryLabel(saved), enabled, leadMinutes).confirmation);
  } catch (error) {
    flashStatus(errorMessage(error, "Could not update the alert lead time."), "error");
  }
}

async function reloadSchedule(): Promise<void> {
  state.loading = true;
  state.scheduleError = undefined;
  hideBanner();
  el.reloadScheduleButton.disabled = true;
  announce("Reloading the GRT timetable.");
  render();
  await loadSchedule(true);
  el.reloadScheduleButton.disabled = false;
  render();
  if (!state.scheduleError) flashStatus("Timetable reloaded");
}

/** Bring nearby controls and the first results into the popup's main scroll area. */
function scrollPickerIntoView(): void {
  window.requestAnimationFrame(() => {
    const activePane = state.pickerTab === "search" ? el.paneSearch : el.paneRoute;
    activePane.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  });
}

async function readNearbyPosition(): Promise<GeolocationPosition> {
  const position = await getCurrentPosition();
  await setLocationConsent(true);
  state.locationConsent = true;
  // Accuracy travels with the position: without it a kilometre-wide fix would
  // later be treated as pinpoint when picking the closest saved entry.
  await saveLastLocation(
    position.coords.latitude,
    position.coords.longitude,
    position.coords.accuracy,
  );
  return position;
}

async function findNearbyStops(): Promise<void> {
  state.pickerOpen = true;
  state.settingsOpen = false;
  state.pickerTab = "search";
  state.locatingNearby = true;
  state.nearbyFallback = false;
  state.searchTerm = "";
  el.stopSearch.value = "";
  render();
  scrollPickerIntoView();
  try {
    const position = await readNearbyPosition();
    const withinRadius = state.index
      ? nearestStops(
          state.index.stops,
          position.coords.latitude,
          position.coords.longitude,
        )
      : [];
    state.nearbyFallback = withinRadius.length === 0;
    state.nearbyStops =
      withinRadius.length > 0 || !state.index
        ? withinRadius
        : nearestStops(
            state.index.stops,
            position.coords.latitude,
            position.coords.longitude,
            1,
            Number.POSITIVE_INFINITY,
          );
    await refreshLocation();
  } catch (error) {
    state.nearbyStops = undefined;
    state.nearbyFallback = false;
    flashStatus(
      isLocationDenied(error)
        ? "Location access was declined."
        : errorMessage(error, "Could not find your location."),
      "error",
    );
  } finally {
    state.locatingNearby = false;
    render();
    scrollPickerIntoView();
  }
}

async function findNearbyRouteStops(): Promise<void> {
  if (!state.selectedRouteId) return;
  state.locatingRouteNearby = true;
  render();
  scrollPickerIntoView();
  try {
    const position = await readNearbyPosition();
    state.routeNearbyStops = state.index
      ? nearestStops(
          state.index.stops,
          position.coords.latitude,
          position.coords.longitude,
          state.index.stops.length,
        )
      : [];
    await refreshLocation();
  } catch (error) {
    state.routeNearbyStops = undefined;
    flashStatus(
      isLocationDenied(error)
        ? "Location access was declined."
        : errorMessage(error, "Could not find your location."),
      "error",
    );
  } finally {
    state.locatingRouteNearby = false;
    render();
    scrollPickerIntoView();
  }
}

async function toggleNearestFirst(enabled: boolean): Promise<void> {
  if (!proUnlocked()) {
    el.nearestToggle.checked = false;
    openPlan();
    return;
  }
  try {
    if (enabled) {
      // Reading a position can take a few seconds; keep the control honest.
      el.nearestToggle.disabled = true;
      flashStatus("Checking your location…");
      try {
        const position = await getCurrentPosition();
        await setLocationConsent(true);
        state.locationConsent = true;
        await saveLastLocation(
          position.coords.latitude,
          position.coords.longitude,
          position.coords.accuracy,
        );
      } catch (error) {
        el.nearestToggle.checked = false;
        flashStatus(
          isLocationDenied(error)
            ? "Location access was declined."
            : errorMessage(error, "Could not read your location."),
          "error",
        );
        return;
      } finally {
        el.nearestToggle.disabled = false;
      }
    } else {
      await setLocationConsent(false);
      state.locationConsent = false;
      state.nearestSavedId = undefined;
      state.distancesById = undefined;
    }
    state.settings = await saveSettings({ nearestFirst: enabled });
    if (enabled) await refreshLocation();
    flashStatus(enabled ? "Closest stop first is on" : "Closest stop first is off");
    void sendRequest({ type: "LOCATION_CHANGED" }).catch(() => undefined);
  } catch (error) {
    flashStatus(errorMessage(error, "Could not save the closest-stop setting."), "error");
    render();
  }
}

function openPlan(): void {
  if (!proBuild) return;
  state.lastFocusBeforePlan =
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  state.planOpen = true;
  render();
  el.planClose.focus();
  // Fire and forget: the card is already on screen, and it re-renders itself when
  // the answer lands.
  void loadPlans();
}

function closePlan(): void {
  state.planOpen = false;
  render();
  state.lastFocusBeforePlan?.focus();
  state.lastFocusBeforePlan = undefined;
}

async function startUpgrade(): Promise<void> {
  if (!PAYMENTS_CONFIGURED) return;
  el.upgradeButton.disabled = true;
  try {
    await openPaymentPage();
  } catch (error) {
    flashStatus(errorMessage(error, "Could not open the checkout page."), "error");
  } finally {
    el.upgradeButton.disabled = false;
  }
}

async function restorePurchase(): Promise<void> {
  if (!PAYMENTS_CONFIGURED) return;
  el.restoreButton.disabled = true;
  try {
    if (proUnlocked()) {
      await loadPaymentStatus();
      flashStatus("Plan status refreshed");
    } else {
      await openLoginPage();
    }
  } catch (error) {
    flashStatus(errorMessage(error, "Could not open the restore page."), "error");
  } finally {
    el.restoreButton.disabled = false;
    render();
  }
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

function onRadioGroupKeyDown(event: KeyboardEvent): void {
  if (
    event.key !== "ArrowLeft" &&
    event.key !== "ArrowRight" &&
    event.key !== "ArrowUp" &&
    event.key !== "ArrowDown" &&
    event.key !== "Home" &&
    event.key !== "End"
  ) {
    return;
  }
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="radio"]');
  if (!target) return;
  const radios = queryAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]')
    .filter((radio) => radio.parentElement === target.parentElement);
  const current = radios.indexOf(target);
  if (current < 0) return;
  event.preventDefault();
  const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? radios.length - 1
      : (current + (event.key === (horizontal ? "ArrowRight" : "ArrowDown") ? 1 : -1) + radios.length) % radios.length;
  radios[next]?.click();
  radios[next]?.focus();
}

for (const group of [el.themeGroup, el.countGroup]) {
  group.addEventListener("keydown", onRadioGroupKeyDown);
}

el.refreshButton.addEventListener("click", () => {
  announce("Refreshing departures.");
  void refreshRealtime({ showErrors: true, force: true });
});

el.settingsButton.addEventListener("click", () => {
  state.settingsOpen = !state.settingsOpen;
  if (state.settingsOpen) {
    state.planOpen = false;
    state.pickerOpen = false;
  }
  render();
});

el.planButton.addEventListener("click", () => {
  if (state.planOpen) closePlan();
  else openPlan();
});

el.topbarAddButton.addEventListener("click", () => {
  state.pickerOpen = !state.pickerOpen;
  if (state.pickerOpen) state.settingsOpen = false;
  render();
  focusPickerStart();
});

el.planClose.addEventListener("click", closePlan);
el.upgradeButton.addEventListener("click", () => void startUpgrade());
el.restoreButton.addEventListener("click", () => void restorePurchase());

el.planOverlay.addEventListener("click", (event) => {
  if (event.target === el.planOverlay) closePlan();
});

el.alertsToggle.addEventListener("click", () => {
  state.alertsExpanded = !state.alertsExpanded;
  render();
});

el.pickerToggle.addEventListener("click", () => {
  state.pickerOpen = !state.pickerOpen;
  if (state.pickerOpen) state.settingsOpen = false;
  render();
  focusPickerStart();
});

el.tabSearch.addEventListener("click", () => {
  state.pickerTab = "search";
  render();
  el.stopSearch.focus();
});

el.tabRoute.addEventListener("click", () => {
  state.pickerTab = "route";
  render();
  el.routeSelect.focus();
});

let searchDebounce = 0;
el.stopSearch.addEventListener("input", () => {
  window.clearTimeout(searchDebounce);
  searchDebounce = window.setTimeout(() => {
    state.searchTerm = el.stopSearch.value;
    renderSearchPane();
  }, 120);
});

el.nearButton.addEventListener("click", () => void findNearbyStops());
el.emptyNearButton.addEventListener("click", () => void findNearbyStops());
el.emptySearchButton.addEventListener("click", () => {
  state.pickerOpen = true;
  state.pickerTab = "search";
  state.settingsOpen = false;
  render();
  el.stopSearch.focus();
});

el.routeSelect.addEventListener("change", () => {
  state.selectedRouteId = el.routeSelect.value;
  const directions = directionsForRoute(state.selectedRouteId);
  state.selectedDirectionId = directions.length > 1 ? "both" : directions[0] ?? "";
  render();
});

el.routeNearButton.addEventListener("click", () => {
  if (state.routeNearbyStops !== undefined) {
    state.routeNearbyStops = undefined;
    render();
    return;
  }
  void findNearbyRouteStops();
});

el.themeGroup.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-theme-value]");
  const value = target?.dataset.themeValue;
  if (value !== "auto" && value !== "light" && value !== "dark") return;
  void saveSettings({ theme: value })
    .then((settings) => {
      state.settings = settings;
      applyTheme();
      render();
    })
    .catch((error) => flashStatus(errorMessage(error, "Could not save the appearance setting."), "error"));
});

el.countGroup.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-count-value]");
  const value = Number(target?.dataset.countValue);
  if (!Number.isFinite(value)) return;
  void saveSettings({ departuresPerStop: value })
    .then((settings) => {
      state.settings = settings;
      render();
    })
    .catch((error) => flashStatus(errorMessage(error, "Could not save the departure count."), "error"));
});

el.nearestToggle.addEventListener("change", () => {
  void toggleNearestFirst(el.nearestToggle.checked);
});

el.testAlertButton.addEventListener("click", () => {
  el.testAlertButton.disabled = true;
  void (async () => {
    try {
      const granted = await chrome.permissions.request({ permissions: ["notifications"] });
      if (!granted) {
        flashStatus("Arrival alerts need Chrome's notification permission.", "error");
        return;
      }
      const status = await sendRequest({ type: "SEND_TEST_NOTIFICATION" });
      state.notificationsBlocked = !status.systemEnabled;
      flashStatus(
        status.systemEnabled ? "Test alert sent" : "Chrome is blocking notifications.",
        status.systemEnabled ? "info" : "error",
      );
      render();
    } catch (error) {
      flashStatus(errorMessage(error, "Could not send a test alert."), "error");
    } finally {
      el.testAlertButton.disabled = false;
    }
  })();
});

el.reloadScheduleButton.addEventListener("click", () => void reloadSchedule());

el.managePlanButton.addEventListener("click", () => {
  state.settingsOpen = false;
  openPlan();
});

el.toastClose.addEventListener("click", hideToast);
el.toast.addEventListener("mouseenter", pauseToast);
el.toast.addEventListener("mouseleave", resumeToast);
el.toast.addEventListener("focusin", pauseToast);
el.toast.addEventListener("focusout", (event) => {
  if (event.relatedTarget instanceof Node && el.toast.contains(event.relatedTarget)) return;
  resumeToast();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!el.toast.hidden) {
      hideToast();
      return;
    }
    if (state.planOpen) {
      closePlan();
      return;
    }
    if (state.pickerOpen) {
      event.preventDefault();
      event.stopPropagation();
      state.pickerOpen = false;
      render();
      return;
    }
    if (state.settingsOpen) {
      state.settingsOpen = false;
      render();
      el.settingsButton.focus();
      return;
    }
    return;
  }

  if (event.key === "r" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void refreshRealtime({ showErrors: true, force: true });
    return;
  }

  if (!state.planOpen || event.key !== "Tab") return;
  const focusable = [
    ...el.planDialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

// Left/right arrows move between picker tabs, per ARIA tab pattern.
for (const tab of [el.tabSearch, el.tabRoute]) {
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    state.pickerTab = state.pickerTab === "search" ? "route" : "search";
    render();
    (state.pickerTab === "search" ? el.tabSearch : el.tabRoute).focus();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  void (async () => {
    try {
      if (changes.savedStops) state.savedStops = await getSavedStops();
      if (changes.settings) {
        state.settings = await getSettings();
        applyTheme();
      }
      render({ background: true });
    } catch (error) {
      flashStatus(errorMessage(error, "Could not refresh saved settings."), "error");
    }
  })();
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function initialize(): Promise<void> {
  const [settings, savedStops] = await Promise.all([getSettings(), getSavedStops()]);
  state.settings = settings;
  state.savedStops = savedStops;
  state.locationConsent = await hasLocationConsent();
  applyTheme();
  render();

  // Show whatever is already cached before touching the network.
  const cached = await readIndex();
  if (cached) {
    state.index = cached;
    state.scheduleExpired = !coversToday(cached);
    state.scheduleStale = !isIndexFresh(cached);
    state.loading = false;
    render();
  }

  await Promise.all([
    loadSchedule(),
    refreshRealtime(),
    loadPaymentStatus().then(() => {
      if (proBuild) {
        void sendRequest({ type: "PAYMENT_CHANGED" }).catch(() => undefined);
      }
    }),
  ]);
  render();

  if (proUnlocked() && state.settings.nearestFirst && (await hasLocationConsent())) {
    await refreshLocation();
    render();
  }

  window.setInterval(tickCountdowns, COUNTDOWN_TICK_MS);
  window.setInterval(() => void refreshRealtime(), REALTIME_POLL_MS);
}

void initialize().catch((error: unknown) => {
  state.loading = false;
  state.scheduleError = errorMessage(error, "GRT Next Bus could not start.");
  render();
});
