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
import { coversToday, readIndex } from "./indexStore";
import { errorMessage, sendRequest } from "./messages";
import {
  getPaymentPlans,
  getPaymentUser,
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
  setStopRoute,
} from "./storage";
import { serviceDateKey } from "./time";
import {
  ALERT_LEAD_OPTIONS,
  DEFAULT_ALERT_LEAD_MINUTES,
  DIRECTION_IDS,
  DEFAULT_SETTINGS,
  EMPTY_REALTIME,
  MAX_SAVED_STOPS,
  patternKey,
  REALTIME_STALE_MS,
  type GtfsIndex,
  type DirectionId,
  type Route,
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
const CARD_ANIMATION_MS = 350;

/** Cards whose entry animation has finished, so re-renders don't replay it. */
const animatedCardIds = new Set<string>();
const cardAnimationTimers = new Map<string, number>();

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
  locatingNearby: boolean;
  distancesById?: Map<string, number>;
  nearestSavedId?: string;
  selectedRouteId: string;
  selectedDirectionId: DirectionId | "";
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
    render({ background: true });
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
    const user = await getPaymentUser();
    state.isPro = Boolean(user?.paid);
    state.paymentUnavailable = false;
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
      saved.routeId,
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
 *
 * When a live bus is past its predicted time, the countdown slot shows the
 * delay instead of "Due" — that is the number the rider's eyes are on, and
 * "Due" says nothing about how late the bus actually is.
 */
function departureLabels(timeMs: number, delaySec?: number, now = Date.now()): TimeLabels {
  const minutes = minutesUntil(timeMs, now);
  const dayPrefix =
    serviceDateKey(timeMs) === serviceDateKey(now) ? "" : `${formatWeekday(timeMs)} `;
  if (minutes < 60) {
    const overdue =
      delaySec === undefined ? undefined : formatOverdueDelay(timeMs, delaySec, now);
    if (overdue) {
      return {
        primary: overdue,
        secondary: `${dayPrefix}${formatClock(timeMs)}`,
        className: "countdown is-soon",
      };
    }
    return {
      primary: formatCountdown(timeMs, now),
      secondary: `${dayPrefix}${formatClock(timeMs)}`,
      className: `countdown${minutes <= 2 ? " is-soon" : minutes <= 5 ? " is-near" : ""}`,
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
): Node[] {
  if (!departure.isLive) return [];
  const notes: Node[] = [element("span", { className: "note-live", text: "Live" })];
  const delay = formatDelay(departure.delaySec);
  if (delay && labels.primary !== delay) {
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
  return notes;
}

function renderDeparture(group: NextBus): HTMLElement {
  const departure = group.head;
  const now = Date.now();
  const labels = departureLabels(
    departure.timeMs,
    departure.isLive ? departure.delaySec : undefined,
    now,
  );

  return element(
    "li",
    {
      className: "departure",
      dataset: {
        time: String(departure.timeMs),
        delay: departure.isLive ? String(departure.delaySec) : "",
      },
    },
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
        element(
          "p",
          {
            className: "departure-note",
            dataset: {
              live: String(departure.isLive),
              delay: String(departure.delaySec),
              stopsAway:
                departure.stopsAway === undefined ? "" : String(departure.stopsAway),
            },
          },
          withSeparators(departureNoteNodes(departure, labels)),
        ),
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
  const canReorder = canReorderStop(saved);
  const grip = button(
    "tool-button stop-grip",
    {
      ariaLabel: canReorder
        ? `Reorder ${saved.stopName}; use the arrow keys to move`
        : `${saved.stopName} is ordered automatically as the closest stop`,
      title: canReorder
        ? "Drag to reorder, or use the arrow keys"
        : "Closest stop is ordered automatically",
      dataset: { focusKey: `grip:${saved.id}` },
    },
    [icon(ICONS.grip, true)],
  );
  grip.disabled = !canReorder;
  grip.draggable = canReorder;
  if (canReorder) grip.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown");
  grip.addEventListener("keydown", (event) => onGripKeyDown(event, saved));
  tools.append(grip);

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

interface DirectionChoice {
  directionId: DirectionId;
  headsign: string;
  label: string;
}

interface RouteChoice {
  routeId: string;
  directionId?: DirectionId;
  directionHeadsign?: string;
  label: string;
  name: string;
}

function directionChoicesAt(stopId: string, routeId: string): DirectionChoice[] {
  if (!state.index) return [];
  return DIRECTION_IDS.flatMap((directionId) => {
    const pattern = state.index?.patterns.get(patternKey(routeId, directionId));
    if (!pattern || !pattern.stopIds.includes(stopId)) return [];
    const headsign = pattern.headsigns.slice(0, 2).join(" / ");
    return [
      {
        directionId,
        headsign,
        label: headsign ? `To ${headsign}` : `Direction ${directionId}`,
      },
    ];
  });
}

function routeChoicesAt(stopId: string, routeIds: readonly string[]): RouteChoice[] {
  return routeIds.flatMap((routeId) => {
    const route = routeFor(routeId);
    const shortName = route?.shortName ?? routeId;
    const directions = directionChoicesAt(stopId, routeId);
    if (directions.length <= 1) {
      const direction = directions[0];
      if (direction) {
        return [
          {
            routeId,
            directionId: direction.directionId,
            directionHeadsign: direction.headsign || undefined,
            label: `${shortName} · ${direction.label}`,
            name: `Route ${shortName}, ${direction.label}`,
          },
        ];
      }
      return [
        {
          routeId,
          label: shortName,
          name: `Route ${shortName}`,
        },
      ];
    }
    return [
      {
        routeId,
        label: `${shortName} · Any direction`,
        name: `Route ${shortName}, any direction`,
      },
      ...directions.map((direction) => ({
        routeId,
        directionId: direction.directionId,
        directionHeadsign: direction.headsign || undefined,
        label: `${shortName} · ${direction.label}`,
        name: `Route ${shortName}, ${direction.label}`,
      })),
    ];
  });
}

function routeChoiceKey(choice: Pick<RouteChoice, "routeId" | "directionId">): string {
  return `${choice.routeId}|${choice.directionId ?? ""}`;
}

function savedChoiceKey(saved: SavedStop | undefined): string {
  return `${saved?.routeId ?? ""}|${saved?.directionId ?? ""}`;
}

function savedDirectionLabel(saved: SavedStop): string | undefined {
  if (!saved.routeId || !saved.directionId) return undefined;
  const current = directionChoicesAt(saved.stopId, saved.routeId).find(
    (choice) => choice.directionId === saved.directionId,
  );
  if (current) return current.label;
  return directionLabel(saved.directionId, saved.directionHeadsign);
}

function directionLabel(
  directionId: DirectionId | undefined,
  headsign?: string,
): string | undefined {
  if (!directionId) return undefined;
  return headsign ? `To ${headsign}` : `Direction ${directionId}`;
}

function savedRouteDescription(saved: SavedStop | undefined): string | undefined {
  if (!saved) return undefined;
  const route = savedRouteLabel(saved);
  if (!route) return undefined;
  const direction = savedDirectionLabel(saved);
  if (direction) return `${route} · ${direction}`;
  if (saved.routeId && directionChoicesAt(saved.stopId, saved.routeId).length > 1) {
    return `${route} · Any direction`;
  }
  return route;
}

function routeChoiceForSaved(saved: SavedStop | undefined): RouteChoice | undefined {
  if (!saved?.routeId) return undefined;
  const label = savedRouteDescription(saved) ?? saved.routeId;
  return {
    routeId: saved.routeId,
    ...(saved.directionId ? { directionId: saved.directionId } : {}),
    ...(saved.directionHeadsign ? { directionHeadsign: saved.directionHeadsign } : {}),
    label,
    name: label,
  };
}

const ANY_ROUTE_VALUE = "__any_route__";

function routeSelectionChoicesAt(
  stopId: string,
  routeIds: readonly string[],
  saved?: SavedStop,
): RouteChoice[] {
  const choices = routeChoicesAt(stopId, routeIds);
  const savedChoice = routeChoiceForSaved(saved);
  if (
    savedChoice &&
    !choices.some((choice) => routeChoiceKey(choice) === routeChoiceKey(savedChoice))
  ) {
    choices.unshift(savedChoice);
  }
  return choices;
}

function anyRouteChoice(): RouteChoice {
  return {
    routeId: "",
    label: "Any route",
    name: "Every route",
  };
}

/** Keep the same compact native selector on every saved stop, even for one route. */
function renderStopRouteSelect(saved: SavedStop): HTMLSelectElement {
  const routeIds = state.index?.routeIdsByStop.get(saved.stopId) ?? [];
  const choices = routeSelectionChoicesAt(saved.stopId, routeIds, saved);
  const byValue = new Map(choices.map((choice) => [routeChoiceKey(choice), choice]));
  const select = element("select", {
    className: "stop-route-select",
    ariaLabel: `Route and direction followed at ${saved.stopName}`,
    dataset: { focusKey: `route-select:${saved.id}` },
  });
  select.append(new Option(anyRouteChoice().label, ANY_ROUTE_VALUE));
  for (const choice of choices) {
    select.append(new Option(choice.label, routeChoiceKey(choice)));
  }
  select.value = saved.routeId ? savedChoiceKey(saved) : ANY_ROUTE_VALUE;
  select.addEventListener("change", () => {
    const choice = byValue.get(select.value);
    void changeStopRoute(
      saved,
      choice?.routeId ?? "",
      choice?.directionId,
      choice?.directionHeadsign,
    );
  });
  return select;
}

function stopEmptyMessage(board: DepartureBoard, saved: SavedStop): string {
  if (board.scheduleExpired) {
    return "The saved timetable does not cover today. Reload the schedule from settings.";
  }
  const route = savedRouteDescription(saved);
  if (route) {
    // Naming the route matters here: other buses may well be running, and
    // "out of service" on its own would look like the whole stop was dead.
    return `No departures for ${route} in the next day. Other buses may still serve this stop.`;
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

  // Keep the stop name and metadata readable before the controls. Metadata may
  // wrap when a narrow panel cannot fit the distance; the follow selector is
  // placed in its own row below this block so neither set of facts is clipped.
  const meta = element("div", { className: "stop-meta" }, [
    element("span", { className: "meta-code", text: `Stop ${saved.stopCode}` }),
  ]);
  const routeSelect = renderStopRouteSelect(saved);
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
  card.append(
    element("div", { className: "stop-route-row" }, [
      element("span", { className: "stop-route-label", text: "Follow" }),
      routeSelect,
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
  el.skeleton.hidden = !state.loading || Boolean(state.index);
  const hasStops = state.savedStops.length > 0;
  el.emptyState.hidden = !state.index || hasStops;
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
    const clock = node.querySelector<HTMLElement>(".clock");
    if (!countdown || !clock) continue;
    const labels = departureLabels(
      timeMs,
      Number.isFinite(delaySec) ? delaySec : undefined,
    );
    countdown.textContent = labels.primary;
    countdown.className = labels.className;
    clock.textContent = labels.secondary;

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
          ),
        ),
      );
    }
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

function savedStopFor(stopId: string): SavedStop | undefined {
  return state.savedStops.find((saved) => saved.stopId === stopId);
}

function routeFor(routeId: string): Route | undefined {
  const routeIndex = state.index?.routeIndexById.get(routeId);
  return routeIndex === undefined ? undefined : state.index?.routes[routeIndex];
}

/** Routes serving a stop, in the feed's display order. */
function routesAt(stop: Stop, routeIds?: string[]): string[] {
  return routeIds ?? state.index?.routeIdsByStop.get(stop.id) ?? [];
}

interface ResultItemOptions {
  distanceMeters?: number;
  routeIds?: string[];
  /** The route being browsed in the route tab, if any. */
  browsingRouteId?: string;
  /** The direction being browsed in the route tab, if any. */
  browsingDirectionId?: DirectionId;
}

/**
 * The route/direction a press on the row itself saves: the one being browsed if
 * one is selected, otherwise the first choice at the stop.
 *
 * Choosing a route and direction and then walking its stops is a rider saying
 * which bus they want, so the row takes them at their word rather than reverting
 * to whichever choice the feed happens to list first. "Any" is never the default
 * — someone at a stop is waiting for a bus, not for all of them — but it stays one
 * press away.
 */
function defaultRouteChoice(
  choices: readonly RouteChoice[],
  browsingRouteId?: string,
  browsingDirectionId?: DirectionId,
): RouteChoice | undefined {
  if (browsingRouteId && browsingDirectionId) {
    const exact = choices.find(
      (choice) =>
        choice.routeId === browsingRouteId && choice.directionId === browsingDirectionId,
    );
    if (exact) return exact;
  }
  if (browsingRouteId) {
    const route = choices.find((choice) => choice.routeId === browsingRouteId);
    if (route) return route;
  }
  return choices[0];
}

/** A stop in the picker with one compact route/destination selector. */
function resultItem(stop: Stop, options: ResultItemOptions): HTMLElement {
  const routes = routesAt(stop, options.routeIds);
  const saved = savedStopFor(stop.id);
  const choices = routeSelectionChoicesAt(stop.id, routes, saved);
  const byValue = new Map(choices.map((choice) => [routeChoiceKey(choice), choice]));
  const any = anyRouteChoice();
  const fallback = defaultRouteChoice(
    choices,
    options.browsingRouteId,
    options.browsingDirectionId,
  );

  const meta = element("div", { className: "result-meta" }, [
    element("span", { text: `Stop ${stop.code}` }),
    options.distanceMeters !== undefined
      ? element("span", { text: formatDistance(options.distanceMeters) })
      : undefined,
  ]);

  const select = element("select", {
    className: "result-select",
    ariaLabel: `Route and direction to follow at ${stop.name}`,
    dataset: { focusKey: `result-select:${stop.id}` },
  });
  if (!saved) select.append(new Option("Choose route and destination…", ""));
  select.append(new Option(any.label, ANY_ROUTE_VALUE));
  for (const choice of choices) {
    select.append(new Option(choice.label, routeChoiceKey(choice)));
  }
  select.value = saved
    ? saved.routeId
      ? savedChoiceKey(saved)
      : ANY_ROUTE_VALUE
    : "";
  select.addEventListener("change", () => {
    if (!select.value) return;
    const choice =
      select.value === ANY_ROUTE_VALUE ? any : byValue.get(select.value);
    if (!choice) return;
    void saveStop(
      stop,
      choice.routeId || undefined,
      choice.directionId,
      choice.directionHeadsign,
    );
  });

  const choiceRow = element("div", { className: "result-choice-row" }, [
    element("span", { className: "result-choice-label", text: "Follow" }),
    select,
  ]);

  const entry = element("div", { className: "result-entry" }, [
    element("p", { className: "result-name", text: stop.name, title: stop.name }),
    meta,
    choiceRow,
  ]);

  // In Browse routes, the route and direction are already explicit in the tab.
  // Keep the row shortcut there, while Search always makes the selection in the
  // one visible control so a destination is never chosen by accident.
  if (options.browsingRouteId && fallback) {
    entry.classList.add("is-pressable");
    entry.title = `Save ${fallback.name} at ${stop.name}`;
    entry.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("select")) return;
      void saveStop(
        stop,
        fallback?.routeId,
        fallback?.directionId,
        fallback?.directionHeadsign,
      );
    });
  }

  return element("li", { className: "result-row" }, [entry]);
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
    ? DIRECTION_IDS.filter((directionId) =>
        state.index?.patterns.has(patternKey(state.selectedRouteId, directionId)),
      )
    : [];
  el.directionChips.hidden = directions.length === 0;
  el.directionChips.replaceChildren();
  for (const directionId of directions) {
    const pattern = state.index.patterns.get(patternKey(state.selectedRouteId, directionId));
    const headsign = pattern?.headsigns.slice(0, 2).join(" / ");
    const label = headsign ? `To ${headsign}` : `Direction ${directionId}`;
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
      // Browsing a route is a rider naming the bus they want, so it becomes what
      // a press on the row saves rather than the feed's first route at the stop.
      return [
        resultItem(stop, {
          routeIds,
          browsingRouteId: state.selectedRouteId,
          browsingDirectionId: state.selectedDirectionId || undefined,
        }),
      ];
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
 * second to be caught by a poll that runs every twenty-five. Background
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

/**
 * Saves a stop for one route, or moves an already-saved stop onto that route.
 *
 * A stop is one place and gets one card, so pressing a route at a stop that is
 * already on the list points that card at the new route rather than adding a
 * second one beside it.
 */
async function saveStop(
  stop: Stop,
  routeId?: string,
  directionId?: DirectionId,
  directionHeadsign?: string,
): Promise<void> {
  const shortName = routeId ? routeFor(routeId)?.shortName : undefined;
  const moved = Boolean(savedStopFor(stop.id));
  try {
    const stops = await addSavedStop({
      stopId: stop.id,
      stopCode: stop.code,
      stopName: stop.name,
      ...(routeId ? { routeId } : {}),
      ...(shortName ? { routeShortName: shortName } : {}),
      ...(routeId && directionId ? { directionId } : {}),
      ...(routeId && directionId && directionHeadsign
        ? { directionHeadsign }
        : {}),
    });
    state.pickerOpen = false;
    state.searchTerm = "";
    el.stopSearch.value = "";
    await afterStopsChanged(stops);
    const direction = routeId ? directionLabel(directionId, directionHeadsign) : undefined;
    const route = routeId
      ? `route ${shortName ?? routeId}${direction ? ` · ${direction}` : ""}`
      : "every route";
    flashStatus(
      moved ? `Now following ${route} · ${stop.name}` : `Saved · ${route} at ${stop.name}`,
    );
  } catch (error) {
    flashStatus(errorMessage(error, "Could not save that stop."), "error");
  }
}

/** Changes which route/direction a saved card follows, or widens it back to every route. */
async function changeStopRoute(
  saved: SavedStop,
  routeId: string,
  directionId?: DirectionId,
  directionHeadsign?: string,
): Promise<void> {
  try {
    const shortName = routeId ? routeFor(routeId)?.shortName : undefined;
    const stops = await setStopRoute(
      saved.id,
      routeId || undefined,
      shortName,
      routeId ? directionId : undefined,
      routeId ? directionHeadsign : undefined,
    );
    await afterStopsChanged(stops);
    const direction = routeId ? directionLabel(directionId, directionHeadsign) : undefined;
    flashStatus(
      routeId
        ? `Following route ${shortName ?? routeId}${direction ? ` · ${direction}` : ""} · ${saved.stopName}`
        : `Following every route · ${saved.stopName}`,
    );
  } catch (error) {
    flashStatus(errorMessage(error, "Could not change that route."), "error");
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
    // Accuracy travels with the position: without it a kilometre-wide fix would
    // later be treated as pinpoint when picking the closest stop.
    await saveLastLocation(
      position.coords.latitude,
      position.coords.longitude,
      position.coords.accuracy,
    );
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
  const directions = DIRECTION_IDS.filter((directionId) =>
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
    render({ background: true });
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
