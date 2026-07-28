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
  formatWalkTime,
  formatWeekday,
  minutesUntil,
  routeBadgeColor,
} from "./format";
import {
  getCurrentPosition,
  hasLocationConsent,
  haversineMeters,
  isLocationDenied,
  nearestSavedStopId,
  nearestStops,
  resolveLocation,
  saveLastLocation,
  setLocationConsent,
  type StopWithDistance,
} from "./geo";
import { coversToday, readIndex } from "./indexStore";
import { errorMessage, sendRequest } from "./messages";
import { getPaymentUser, openLoginPage, openPaymentPage, PAYMENTS_CONFIGURED } from "./payments";
import { IS_PRO_BUILD } from "./pro";
import {
  addSavedStop,
  getSavedStops,
  getSettings,
  removeSavedStop,
  restoreSavedStop,
  saveSettings,
  setStopAlerts,
} from "./storage";
import { serviceDateKey } from "./time";
import {
  ALERT_LEAD_OPTIONS,
  DEFAULT_ALERT_LEAD_MINUTES,
  DEFAULT_SETTINGS,
  EMPTY_REALTIME,
  MAX_SAVED_STOPS,
  patternKey,
  REALTIME_STALE_MS,
  type GtfsIndex,
  type SavedStop,
  type ServiceAlert,
  type Settings,
  type Stop,
} from "./types";

const COUNTDOWN_TICK_MS = 10_000;
const REALTIME_POLL_MS = 25_000;
const SEARCH_RESULT_LIMIT = 25;
const TOAST_MS = 8_000;
const FLASH_MS = 3_000;
const FLASH_ERROR_MS = 5_000;

const el = {
  root: document.documentElement,
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
  emptyNearButton: query<HTMLButtonElement>("#empty-near-button"),
  emptySearchButton: query<HTMLButtonElement>("#empty-search-button"),
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
  directionChips: query<HTMLElement>("#direction-chips"),
  routeStops: query<HTMLElement>("#route-stops"),
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
  realtimeAt?: number;
  realtimeFailed: boolean;
  scheduleError?: string;
  scheduleExpired: boolean;
  loading: boolean;
  isPro: boolean;
  paymentUnavailable: boolean;
  planOpen: boolean;
  settingsOpen: boolean;
  pickerOpen: boolean;
  pickerTab: PickerTab;
  searchTerm: string;
  nearbyStops?: StopWithDistance[];
  locatingNearby: boolean;
  distancesById?: Map<string, number>;
  nearestSavedId?: string;
  selectedRouteId: string;
  selectedDirectionId: string;
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
  loading: true,
  isPro: false,
  paymentUnavailable: false,
  planOpen: false,
  settingsOpen: false,
  pickerOpen: false,
  pickerTab: "search",
  searchTerm: "",
  locatingNearby: false,
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
    render();
  }, tone === "error" ? FLASH_ERROR_MS : FLASH_MS);
  render();
}

let toastTimer = 0;

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
  toastTimer = window.setTimeout(hideToast, TOAST_MS);
}

function hideToast(): void {
  el.toast.hidden = true;
  document.body.classList.remove("has-toast");
  window.clearTimeout(toastTimer);
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

async function loadSchedule(force = false): Promise<void> {
  try {
    const summary = await sendRequest({ type: "ENSURE_SCHEDULE", ...(force ? { force } : {}) });
    if (!state.index || state.index.fetchedAt !== summary.fetchedAt) {
      const fresh = await readIndex();
      if (fresh) state.index = fresh;
    }
    if (state.index) {
      state.scheduleError = undefined;
      state.scheduleExpired = !coversToday(state.index);
    }
  } catch (error) {
    if (!state.index) {
      state.scheduleError = errorMessage(error, "Could not load the GRT schedule.");
    }
  } finally {
    state.loading = false;
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
    state.lookup = prepareRealtime(snapshot);
    state.alerts = snapshot.alerts;
    state.realtimeAt = snapshot.fetchedAt;
    state.realtimeFailed = false;
  } catch (error) {
    state.realtimeFailed = true;
    // Old predictions are worse than none: fall back to the timetable.
    if (!state.realtimeAt || Date.now() - state.realtimeAt > REALTIME_STALE_MS) {
      state.lookup = EMPTY_LOOKUP;
    }
    if (options.showErrors) {
      flashStatus(errorMessage(error, "Live departures are unavailable right now."), "error");
    }
  } finally {
    el.refreshButton.classList.remove("spinning");
    render();
  }
}

async function loadPaymentStatus(): Promise<void> {
  if (!proBuild) return;
  if (!PAYMENTS_CONFIGURED) {
    state.paymentUnavailable = true;
    return;
  }
  try {
    const user = await getPaymentUser();
    state.isPro = Boolean(user?.paid);
    state.paymentUnavailable = false;
  } catch (error) {
    console.warn("Could not check Pro status", error);
    state.paymentUnavailable = true;
  }
}

async function refreshLocation(): Promise<void> {
  if (!state.index) return;
  const location = await resolveLocation();
  if (!location) {
    state.distancesById = undefined;
    state.nearestSavedId = undefined;
    return;
  }
  const stopsById = new Map(state.index.stops.map((stop) => [stop.id, stop]));
  const distances = new Map<string, number>();
  for (const saved of state.savedStops) {
    const stop = stopsById.get(saved.stopId);
    if (!stop) continue;
    distances.set(
      saved.id,
      haversineMeters(location.latitude, location.longitude, stop.lat, stop.lon),
    );
  }
  state.distancesById = distances;
  state.nearestSavedId = proUnlocked()
    ? nearestSavedStopId(
        state.savedStops,
        state.index.stops,
        location.latitude,
        location.longitude,
      )
    : undefined;
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
  });
}

function renderFeedLine(boards: DepartureBoard[]): void {
  const classes = el.feedState.classList;
  classes.remove("is-live", "is-scheduled", "is-offline", "is-flash", "is-error");

  if (state.flash) {
    classes.add(state.flash.tone === "error" ? "is-error" : "is-flash");
    el.feedStateText.textContent = state.flash.message;
    el.feedDetail.textContent = "";
    return;
  }

  if (state.loading && !state.index) {
    el.feedStateText.textContent = "Loading schedule…";
    el.feedDetail.textContent = "";
    return;
  }
  if (state.realtimeFailed) {
    classes.add("is-offline");
    el.feedStateText.textContent = "Can't reach GRT · showing schedule";
    el.feedState.title =
      "Live departures could not be loaded, so these are the published schedule times.";
    el.feedDetail.textContent = state.realtimeAt
      ? `Last live update ${formatFreshness(state.realtimeAt)}`
      : "";
    return;
  }
  if (state.savedStops.length === 0) {
    // Nothing to report on yet; the empty state does the talking.
    el.feedStateText.textContent = "";
    el.feedDetail.textContent = "";
    el.feedState.title = "";
    return;
  }

  const hasLive = boards.some((board) => board.hasLive);
  classes.add(hasLive ? "is-live" : "is-scheduled");
  el.feedStateText.textContent = hasLive ? "Live departures" : "Scheduled times";
  el.feedState.title = hasLive
    ? "Times marked Live come from the bus itself. The rest are schedule times."
    : "GRT is not tracking buses for your stops right now, so these are the published schedule times.";
  el.feedDetail.textContent = state.realtimeAt
    ? `Updated ${formatFreshness(state.realtimeAt)}`
    : "";
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
    ...alerts.map((alert) =>
      element("div", { className: "alert-item" }, [
        element("p", { className: "alert-title", text: alert.title }),
        alert.body ? element("p", { className: "alert-body", text: alert.body }) : undefined,
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
      ]),
    ),
  );
}

function routeShortName(routeId: string): string {
  const index = state.index?.routeIndexById.get(routeId);
  return index === undefined ? routeId : (state.index?.routes[index].shortName ?? routeId);
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
  primary: string;
  secondary: string;
  className: string;
}

/**
 * Within the hour a countdown is what riders want; beyond that the clock time
 * is far more useful, so the two swap places.
 */
function departureLabels(timeMs: number, now = Date.now()): TimeLabels {
  const minutes = minutesUntil(timeMs, now);
  const dayPrefix =
    serviceDateKey(timeMs) === serviceDateKey(now) ? "" : `${formatWeekday(timeMs)} `;
  if (minutes < 60) {
    return {
      primary: formatCountdown(timeMs, now),
      secondary: `${dayPrefix}${formatClock(timeMs)}`,
      className: `countdown${minutes <= 2 ? " is-soon" : minutes <= 7 ? " is-near" : ""}`,
    };
  }
  return {
    primary: `${dayPrefix}${formatClock(timeMs)}`,
    secondary: minutes >= 90 ? `in ${Math.floor(minutes / 60)} hr` : `in ${minutes} min`,
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

/** Compact label for follow-up times: a countdown nearby, a clock later on. */
function shortTimeLabel(timeMs: number, now = Date.now()): string {
  const minutes = minutesUntil(timeMs, now);
  if (minutes < 1) return "due";
  if (minutes < 60) return `${minutes} min`;
  return formatClock(timeMs);
}

/**
 * Follow-up times get their own line. Sharing the status line meant a live bus
 * with a delay and a stop count pushed them past the edge of the card, where
 * they were clipped mid-digit. Rendered even when empty, so a row keeps its
 * height as follow-ups come and go.
 */
function renderFollowUps(rest: readonly Departure[]): HTMLElement {
  const row = element("p", { className: "departure-then" });
  if (rest.length === 0) return row;
  row.append(element("span", { className: "then-label", text: "then" }));
  rest.forEach((departure, position) => {
    if (position > 0) row.append(separator());
    row.append(
      element("span", {
        className: "then-time",
        text: shortTimeLabel(departure.timeMs),
        dataset: { time: String(departure.timeMs) },
      }),
    );
  });
  return row;
}

function separator(): HTMLElement {
  return element("span", { className: "note-sep", text: "·" });
}

/** Interleaves note fragments with a middot so each fact reads on its own. */
function withSeparators(parts: readonly Node[]): Node[] {
  return parts.flatMap((part, position) => (position === 0 ? [part] : [separator(), part]));
}

function renderDeparture(group: NextBus): HTMLElement {
  const departure = group.head;
  const notes: Node[] = [];
  if (departure.isLive) {
    notes.push(element("span", { className: "note-live", text: "Live" }));
    const delay = formatDelay(departure.delaySec);
    if (delay) {
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
  }

  const labels = departureLabels(departure.timeMs);
  return element(
    "li",
    { className: "departure", dataset: { time: String(departure.timeMs) } },
    [
      routeBadge({
        shortName: departure.routeShortName,
        ...(departure.routeColor ? { color: departure.routeColor } : {}),
      }),
      element("div", { className: "departure-copy" }, [
        element("p", {
          className: "headsign",
          text: departure.headsign || `Route ${departure.routeShortName}`,
        }),
        // Always present, even when empty, so a row keeps its height when live
        // information arrives or drops away.
        element("p", { className: "departure-note" }, withSeparators(notes)),
        renderFollowUps(group.rest),
      ]),
      element("div", { className: "departure-time" }, [
        element("span", { className: labels.className, text: labels.primary }),
        element("span", { className: "clock", text: labels.secondary }),
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
 * every message names its stop: alerts are per stop, never global.
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

  if (proBuild) {
    const enabled = Boolean(saved.alertsEnabled) && proUnlocked();
    const leadMinutes = alertLeadFor(saved);
    const { setting } = describeAlerts(saved.stopName, enabled, leadMinutes);

    // Lead time first, then the bell it belongs to: the pair reads left to
    // right as "5 min before · alerts on". Always rendered so switching alerts
    // on or off never resizes the card.
    const select = element("select", {
      className: "lead-select",
      ariaLabel: `Alert lead time for ${saved.stopName}`,
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
    tools.append(select);

    const bell = button(
      "tool-button",
      {
        // Stable label plus aria-pressed, so the control reads the same way
        // whichever state it is in.
        ariaLabel: `Arrival alerts for ${saved.stopName}`,
        title: setting,
        dataset: { focusKey: `bell:${saved.id}` },
        onClick: () => void toggleAlerts(saved),
      },
      [icon(enabled ? ICONS.bell : ICONS.bellOff)],
    );
    bell.setAttribute("aria-pressed", String(enabled));
    tools.append(bell);
  }

  tools.append(
    button(
      "tool-button tool-remove is-danger",
      {
        ariaLabel: `Remove ${saved.stopName}`,
        title: "Remove this stop",
        dataset: { focusKey: `remove:${saved.id}` },
        onClick: () => void removeStop(saved),
      },
      [icon(ICONS.close)],
    ),
  );
  return tools;
}

function stopEmptyMessage(board: DepartureBoard): string {
  if (board.scheduleExpired) {
    return "The saved timetable does not cover today. Reload the schedule from settings.";
  }
  return "No departures in the next day. This stop may be out of service.";
}

function renderStopCard(saved: SavedStop, board: DepartureBoard): HTMLElement {
  const isNearest = proUnlocked() && saved.id === state.nearestSavedId;
  const card = element("article", {
    className: `stop-card${isNearest ? " is-nearest" : ""}`,
  });
  card.setAttribute("role", "listitem");

  // One line, most important first: anything that will not fit is clipped
  // rather than wrapped, so the card never changes height.
  const meta = element("div", { className: "stop-meta" }, [
    element("span", { className: "meta-code", text: `Stop ${saved.stopCode}` }),
  ]);
  if (isNearest) {
    meta.append(element("span", { className: "stop-tag", text: "Closest" }));
  }
  const distance = state.distancesById?.get(saved.id);
  if (distance !== undefined) {
    meta.append(
      element("span", {
        className: "meta-distance",
        text: formatDistance(distance),
        title: formatWalkTime(distance),
      }),
    );
  }

  card.append(
    element("div", { className: "stop-head" }, [
      element("div", { className: "stop-identity" }, [
        element("h3", { className: "stop-name", text: saved.stopName, title: saved.stopName }),
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
        ariaLabel: `Next bus from ${saved.stopName}`,
      },
      [renderDeparture(bus)],
    );
    card.append(list);
  } else {
    card.append(element("p", { className: "stop-empty", text: stopEmptyMessage(board) }));
  }

  return card;
}

/**
 * Display order: the rider's own order, except Pro hoists the closest stop so
 * the one they are standing at is the first thing they see.
 */
function displayOrder(): SavedStop[] {
  const stops = [...state.savedStops];
  if (!proUnlocked() || !state.settings.nearestFirst || !state.nearestSavedId) {
    return stops;
  }
  const position = stops.findIndex((stop) => stop.id === state.nearestSavedId);
  if (position <= 0) return stops;
  const [nearest] = stops.splice(position, 1);
  return [nearest, ...stops];
}

function renderStops(): DepartureBoard[] {
  el.skeleton.hidden = !state.loading || Boolean(state.index);
  const hasStops = state.savedStops.length > 0;
  el.emptyState.hidden = !state.index || hasStops;
  el.stopList.replaceChildren();
  if (!state.index || !hasStops) return [];

  const boards: DepartureBoard[] = [];
  for (const saved of displayOrder()) {
    const board = boardFor(saved);
    boards.push(board);
    el.stopList.append(renderStopCard(saved, board));
  }
  return boards;
}

/** Cheap in-place refresh of the time labels between data loads. */
function tickCountdowns(): void {
  for (const node of queryAll<HTMLElement>(".departure[data-time]")) {
    const timeMs = Number(node.dataset.time);
    if (!Number.isFinite(timeMs)) continue;
    const countdown = node.querySelector<HTMLElement>(".countdown");
    const clock = node.querySelector<HTMLElement>(".clock");
    if (!countdown || !clock) continue;
    const labels = departureLabels(timeMs);
    countdown.textContent = labels.primary;
    countdown.className = labels.className;
    clock.textContent = labels.secondary;
  }
  for (const node of queryAll<HTMLElement>(".then-time[data-time]")) {
    const timeMs = Number(node.dataset.time);
    if (Number.isFinite(timeMs)) node.textContent = shortTimeLabel(timeMs);
  }
  if (state.realtimeAt && !state.flash) {
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

function savedStopIds(): Set<string> {
  return new Set(state.savedStops.map((saved) => saved.stopId));
}

function resultItem(
  stop: Stop,
  options: { distanceMeters?: number; routeIds?: string[] },
): HTMLElement {
  const saved = savedStopIds().has(stop.id);
  const routes = options.routeIds ?? state.index?.routeIdsByStop.get(stop.id) ?? [];
  const meta = element("div", { className: "result-meta" }, [
    element("span", { text: `Stop ${stop.code}` }),
    options.distanceMeters !== undefined
      ? element("span", { text: formatDistance(options.distanceMeters) })
      : undefined,
  ]);
  if (routes.length > 0) {
    meta.append(
      element(
        "span",
        { className: "result-routes" },
        routes.slice(0, 6).map((routeId) => {
          const routeIndex = state.index?.routeIndexById.get(routeId);
          const route = routeIndex === undefined ? undefined : state.index?.routes[routeIndex];
          const chip = element("span", {
            className: "result-route",
            text: route?.shortName ?? routeId,
          });
          const color = route ? routeBadgeColor(route) : undefined;
          if (color) {
            chip.style.backgroundColor = color;
            chip.style.color = "#fff";
          }
          return chip;
        }),
      ),
    );
  }

  const action = button(
    "result-item",
    {
      ariaLabel: saved ? `${stop.name} is already saved` : `Save ${stop.name}`,
      onClick: () => void saveStop(stop),
    },
    [
      element("div", { className: "result-copy" }, [
        element("p", { className: "result-name", text: stop.name }),
        meta,
      ]),
      element("span", { className: "result-add", text: saved ? "✓" : "+" }),
    ],
  );
  action.disabled = saved;
  return element("li", {}, [action]);
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

  if (state.locatingNearby) {
    el.searchEmpty.hidden = false;
    el.searchEmpty.textContent = "Finding stops near you…";
    return;
  }
  if (state.searchTerm.trim().length >= 2) {
    const results = searchStops(state.searchTerm);
    if (results.length === 0) {
      el.searchEmpty.hidden = false;
      el.searchEmpty.textContent = `No stops match “${state.searchTerm.trim()}”.`;
      return;
    }
    el.searchResults.append(...results.map((stop) => resultItem(stop, {})));
    return;
  }
  if (state.nearbyStops) {
    if (state.nearbyStops.length === 0) {
      el.searchEmpty.hidden = false;
      el.searchEmpty.textContent = "No GRT stops within 2 km of you.";
      return;
    }
    el.searchResults.append(
      ...state.nearbyStops.map((entry) =>
        resultItem(entry.stop, { distanceMeters: entry.meters }),
      ),
    );
  }
}

function renderRoutePane(): void {
  if (!state.index) return;
  if (el.routeSelect.options.length <= 1) {
    el.routeSelect.replaceChildren(new Option("Choose a route", ""));
    for (const route of state.index.routes) {
      el.routeSelect.append(
        new Option(`${route.shortName} · ${route.longName}`, route.id),
      );
    }
  }
  el.routeSelect.value = state.selectedRouteId;

  const directions = state.selectedRouteId
    ? ["0", "1"].filter((directionId) =>
        state.index?.patterns.has(patternKey(state.selectedRouteId, directionId)),
      )
    : [];
  el.directionChips.hidden = directions.length === 0;
  el.directionChips.replaceChildren();
  for (const directionId of directions) {
    const pattern = state.index.patterns.get(patternKey(state.selectedRouteId, directionId));
    const label = pattern?.headsigns.slice(0, 2).join(" / ") || `Direction ${directionId}`;
    const chip = button("chip", {
      text: label,
      onClick: () => {
        state.selectedDirectionId = directionId;
        render();
      },
    });
    chip.setAttribute("role", "radio");
    chip.setAttribute("aria-checked", String(state.selectedDirectionId === directionId));
    el.directionChips.append(chip);
  }

  el.routeStops.replaceChildren();
  if (!state.selectedRouteId || !state.selectedDirectionId) return;
  const pattern = state.index.patterns.get(
    patternKey(state.selectedRouteId, state.selectedDirectionId),
  );
  if (!pattern) return;
  const stopsById = new Map(state.index.stops.map((stop) => [stop.id, stop]));
  el.routeStops.append(
    ...pattern.stopIds.flatMap((stopId) => {
      const stop = stopsById.get(stopId);
      if (!stop) return [];
      const routeIds = state.index?.routeIdsByStop.get(stopId) ?? [];
      return [resultItem(stop, { routeIds })];
    }),
  );
}

function renderPicker(): void {
  const atLimit = state.savedStops.length >= MAX_SAVED_STOPS;
  el.pickerToggle.setAttribute("aria-expanded", String(state.pickerOpen));
  el.pickerBody.hidden = !state.pickerOpen;
  el.pickerToggle.querySelector(".picker-toggle-label")!.textContent = atLimit
    ? `Saved stop limit reached (${MAX_SAVED_STOPS})`
    : "Add a stop";
  el.pickerToggle.disabled = atLimit && !state.pickerOpen;
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
  }
  for (const node of queryAll<HTMLButtonElement>("#count-group [data-count-value]")) {
    node.setAttribute(
      "aria-checked",
      String(Number(node.dataset.countValue) === state.settings.departuresPerStop),
    );
  }

  el.nearestField.hidden = !proBuild;
  el.nearestToggle.checked = state.settings.nearestFirst && proUnlocked();
  el.nearestHint.textContent = proUnlocked()
    ? "Uses your location on this device only."
    : "Included with Pro. Your location never leaves this device.";
  el.testAlertButton.hidden = !proUnlocked();
  el.managePlanButton.hidden = !proUnlocked();

  const notes: string[] = [];
  if (state.index) {
    const first = state.index.serviceDates[0];
    const last = state.index.serviceDates[state.index.serviceDates.length - 1];
    notes.push(`Timetable updated ${formatFreshness(state.index.fetchedAt)}`);
    if (first && last) {
      notes.push(`covers ${prettyDate(first)} – ${prettyDate(last)}`);
    }
    notes.push(`${state.index.stops.length} stops`);
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
  el.upgradeButton.textContent = "Get Pro";
  el.restoreButton.textContent = "Already purchased? Restore";
  el.planTitle.textContent = "Catch your bus without checking";
  el.planMessage.textContent =
    "Pro keeps your next departure on the toolbar and taps you on the shoulder before it arrives.";
  el.planStatus.textContent = !configured
    ? "Checkout is not configured in this build."
    : state.paymentUnavailable
      ? "Your plan status could not be checked. Try again when you are back online."
      : "Monthly or yearly. Saved stops keep working either way.";
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

function render(): void {
  const focusKey = captureFocusKey();
  const boards = renderStops();
  renderFeedLine(boards);
  renderAlerts();
  renderPicker();
  renderSettings();
  renderPlan();

  if (state.scheduleError) {
    showBanner(state.scheduleError, {
      action: { label: "Retry", run: () => void reloadSchedule() },
    });
  } else if (state.scheduleExpired) {
    showBanner("This timetable does not cover today.", {
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

async function saveStop(stop: Stop): Promise<void> {
  try {
    const stops = await addSavedStop({
      stopId: stop.id,
      stopCode: stop.code,
      stopName: stop.name,
    });
    state.pickerOpen = false;
    state.searchTerm = "";
    el.stopSearch.value = "";
    await afterStopsChanged(stops);
    flashStatus("Stop saved");
  } catch (error) {
    flashStatus(errorMessage(error, "Could not save that stop."), "error");
  }
}

async function removeStop(saved: SavedStop): Promise<void> {
  const stops = await removeSavedStop(saved.id);
  await afterStopsChanged(stops);
  showToast(`${saved.stopName} removed`, {
    label: "Undo",
    run: () => {
      void restoreSavedStop(saved).then(afterStopsChanged);
    },
  });
}

async function toggleAlerts(saved: SavedStop): Promise<void> {
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
  flashStatus(describeAlerts(saved.stopName, enabling, leadMinutes).confirmation);
}

/** Changing the lead time confirms itself the same way toggling does. */
async function updateAlertLead(saved: SavedStop, leadMinutes: number): Promise<void> {
  if (!proUnlocked()) return;
  // Editing the lead time never changes whether alerts are on, so the
  // confirmation reports the same state the card shows.
  const enabled = Boolean(saved.alertsEnabled);
  const stops = await setStopAlerts(saved.id, enabled, leadMinutes);
  await afterStopsChanged(stops);
  flashStatus(describeAlerts(saved.stopName, enabled, leadMinutes).confirmation);
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

async function findNearbyStops(): Promise<void> {
  state.pickerOpen = true;
  state.pickerTab = "search";
  state.locatingNearby = true;
  state.searchTerm = "";
  el.stopSearch.value = "";
  render();
  try {
    const position = await getCurrentPosition();
    await setLocationConsent(true);
    await saveLastLocation(position.coords.latitude, position.coords.longitude);
    state.nearbyStops = state.index
      ? nearestStops(
          state.index.stops,
          position.coords.latitude,
          position.coords.longitude,
        )
      : [];
    await refreshLocation();
  } catch (error) {
    state.nearbyStops = undefined;
    flashStatus(
      isLocationDenied(error)
        ? "Location access was declined."
        : errorMessage(error, "Could not find your location."),
      "error",
    );
  } finally {
    state.locatingNearby = false;
    render();
  }
}

async function toggleNearestFirst(enabled: boolean): Promise<void> {
  if (!proUnlocked()) {
    el.nearestToggle.checked = false;
    openPlan();
    return;
  }
  if (enabled) {
    // Reading a position can take a few seconds; keep the control honest.
    el.nearestToggle.disabled = true;
    flashStatus("Checking your location…");
    try {
      const position = await getCurrentPosition();
      await setLocationConsent(true);
      await saveLastLocation(position.coords.latitude, position.coords.longitude);
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
    state.nearestSavedId = undefined;
    state.distancesById = undefined;
  }
  state.settings = await saveSettings({ nearestFirst: enabled });
  if (enabled) await refreshLocation();
  flashStatus(enabled ? "Closest stop first is on" : "Closest stop first is off");
  void sendRequest({ type: "LOCATION_CHANGED" }).catch(() => undefined);
}

function openPlan(): void {
  if (!proBuild) return;
  state.lastFocusBeforePlan =
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  state.planOpen = true;
  render();
  el.planClose.focus();
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

el.refreshButton.addEventListener("click", () => {
  announce("Refreshing departures.");
  void refreshRealtime({ showErrors: true, force: true });
});

el.settingsButton.addEventListener("click", () => {
  state.settingsOpen = !state.settingsOpen;
  if (state.settingsOpen) state.planOpen = false;
  render();
});

el.planButton.addEventListener("click", () => {
  if (state.planOpen) closePlan();
  else openPlan();
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
  render();
  if (state.pickerOpen) el.stopSearch.focus();
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
  render();
  el.stopSearch.focus();
});

el.routeSelect.addEventListener("change", () => {
  state.selectedRouteId = el.routeSelect.value;
  const directions = ["0", "1"].filter((directionId) =>
    state.index?.patterns.has(patternKey(state.selectedRouteId, directionId)),
  );
  state.selectedDirectionId = directions.length === 1 ? directions[0] : "";
  render();
});

el.themeGroup.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-theme-value]");
  const value = target?.dataset.themeValue;
  if (value !== "auto" && value !== "light" && value !== "dark") return;
  void saveSettings({ theme: value }).then((settings) => {
    state.settings = settings;
    applyTheme();
    render();
  });
});

el.countGroup.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-count-value]");
  const value = Number(target?.dataset.countValue);
  if (!Number.isFinite(value)) return;
  void saveSettings({ departuresPerStop: value }).then((settings) => {
    state.settings = settings;
    render();
  });
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
    if (changes.savedStops) state.savedStops = await getSavedStops();
    if (changes.settings) {
      state.settings = await getSettings();
      applyTheme();
    }
    render();
  })();
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function initialize(): Promise<void> {
  const [settings, savedStops] = await Promise.all([getSettings(), getSavedStops()]);
  state.settings = settings;
  state.savedStops = savedStops;
  applyTheme();
  render();

  // Show whatever is already cached before touching the network.
  const cached = await readIndex();
  if (cached) {
    state.index = cached;
    state.scheduleExpired = !coversToday(cached);
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
