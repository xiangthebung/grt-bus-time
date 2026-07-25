import "./popup.css";
import {
  formatArrivalTime,
  formatMinutesAway,
  getArrivalsForWatches,
} from "./arrivals";
import { IS_PRO_BUILD } from "./pro";
import {
  getCurrentPosition,
  getLastLocation,
  getNearestWatchId,
  hasLocationConsent,
  saveLastLocation,
  setLocationConsent,
  sortStopsByDistance,
} from "./geo";
import { getGtfsCache } from "./gtfsStatic";
import {
  getPaymentUser,
  openLoginPage,
  openPaymentPage,
  PAYMENTS_CONFIGURED,
} from "./payments";
import {
  deleteWatch,
  getWatches,
  saveWatch,
  setWatchAlerts,
} from "./storage";
import {
  ALERT_LEAD_OPTIONS,
  DEFAULT_ALERT_LEAD_MINUTES,
  type Arrival,
  type DirectionOption,
  type GtfsCache,
  type RealtimeEntity,
  type Route,
  type Stop,
  type Watch,
} from "./types";
import { routeVariantKey } from "./types";

type RealtimeResponse =
  | { ok: true; entities: RealtimeEntity[] }
  | { ok: false; error: string };

type NotificationStatusResponse =
  | {
      ok: true;
      extensionPermissionGranted: boolean;
      permissionLevel: "granted" | "denied";
    }
  | {
      ok: false;
      error: string;
    };

const routeSelect = document.querySelector<HTMLSelectElement>("#route-select");
const directionSelect = document.querySelector<HTMLSelectElement>("#direction-select");
const stopSelect = document.querySelector<HTMLSelectElement>("#stop-select");
const directionStep = document.querySelector<HTMLElement>("#direction-step");
const stopStep = document.querySelector<HTMLElement>("#stop-step");
const nearButton = document.querySelector<HTMLButtonElement>("#near-button");
const saveButton = document.querySelector<HTMLButtonElement>("#save-button");
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh-button");
const statusElement = document.querySelector<HTMLElement>("#status");
const dataError = document.querySelector<HTMLElement>("#data-error");
const dataErrorMessage = document.querySelector<HTMLElement>("#data-error-message");
const retryRouteDataButton = document.querySelector<HTMLButtonElement>("#retry-route-data-button");
const stepCountElement = document.querySelector<HTMLElement>("#step-count");
const watchesElement = document.querySelector<HTMLElement>("#watches");
const emptyState = document.querySelector<HTMLElement>("#empty-state");
const lastUpdatedElement = document.querySelector<HTMLElement>("#last-updated");
const setupCard = document.querySelector<HTMLElement>("#setup-card");
const setupToggle = document.querySelector<HTMLButtonElement>("#setup-toggle");
const setupLabel = document.querySelector<HTMLElement>("#setup-label");
const setupTitle = document.querySelector<HTMLElement>("#setup-title");
const collapseIcon = document.querySelector<HTMLElement>(".collapse-icon");
const planButton = document.querySelector<HTMLButtonElement>("#plan-button");
const planClose = document.querySelector<HTMLButtonElement>("#plan-close");
const testNotificationButton = document.querySelector<HTMLButtonElement>("#test-notification-button");
const locationPrompt = document.querySelector<HTMLElement>("#location-prompt");
const locationButton = document.querySelector<HTMLButtonElement>("#location-button");
const proAccess = document.querySelector<HTMLElement>("#pro-access");
const planDialog = document.querySelector<HTMLElement>(".plan-dialog");
const proAccessTitle = document.querySelector<HTMLElement>("#pro-access-title");
const proAccessMessage = document.querySelector<HTMLElement>("#pro-access-message");
const planBenefitLead = document.querySelector<HTMLElement>("#plan-benefit-lead");
const planPrice = document.querySelector<HTMLElement>("#plan-price");
const planStatus = document.querySelector<HTMLElement>("#plan-status");
const upgradeButton = document.querySelector<HTMLButtonElement>("#upgrade-button");
const restoreButton = document.querySelector<HTMLButtonElement>("#restore-button");

if (
  !routeSelect ||
  !directionSelect ||
  !stopSelect ||
  !directionStep ||
  !stopStep ||
  !nearButton ||
  !saveButton ||
  !refreshButton ||
  !statusElement ||
  !dataError ||
  !dataErrorMessage ||
  !retryRouteDataButton ||
  !stepCountElement ||
  !watchesElement ||
  !emptyState ||
  !lastUpdatedElement ||
  !setupCard ||
  !setupToggle ||
  !setupLabel ||
  !setupTitle ||
  !collapseIcon ||
  !planButton ||
  !planClose ||
  !testNotificationButton ||
  !locationPrompt ||
  !locationButton ||
  !proAccess ||
  !planDialog ||
  !proAccessTitle ||
  !proAccessMessage ||
  !planBenefitLead ||
  !planPrice ||
  !planStatus ||
  !upgradeButton ||
  !restoreButton
) {
  throw new Error("GRT Bus Time popup is missing required elements.");
}

const elements = {
  routeSelect,
  directionSelect,
  stopSelect,
  directionStep,
  stopStep,
  nearButton,
  saveButton,
  refreshButton,
  statusElement,
  dataError,
  dataErrorMessage,
  retryRouteDataButton,
  stepCountElement,
  watchesElement,
  emptyState,
  lastUpdatedElement,
  setupCard,
  setupToggle,
  setupLabel,
  setupTitle,
  collapseIcon,
  planButton,
  planClose,
  testNotificationButton,
  locationPrompt,
  locationButton,
  proAccess,
  planDialog,
  proAccessTitle,
  proAccessMessage,
  planBenefitLead,
  planPrice,
  planStatus,
  upgradeButton,
  restoreButton,
};

const state: {
  cache?: GtfsCache;
  watches: Watch[];
  realtime: RealtimeEntity[];
  selectedRouteId: string;
  selectedDirectionId: string;
  selectedDirectionKey: string;
  selectedStopId: string;
  visibleStops: Stop[];
  setupOpen: boolean;
  planOpen: boolean;
  proPaid: boolean;
  paymentError: boolean;
  lastRealtimeAt?: number;
  planPreviousFocus?: HTMLElement;
  nearestWatchId?: string;
} = {
  watches: [],
  realtime: [],
  selectedRouteId: "",
  selectedDirectionId: "",
  selectedDirectionKey: "",
  selectedStopId: "",
  visibleStops: [],
  setupOpen: true,
  planOpen: false,
  proPaid: !IS_PRO_BUILD,
  paymentError: false,
};

function hasProFeatures(): boolean {
  return IS_PRO_BUILD && state.proPaid;
}

function setStatus(message: string, error = false): void {
  elements.statusElement.textContent = message;
  elements.statusElement.classList.toggle("visible", Boolean(message));
  elements.statusElement.classList.toggle("error", error);
}

function showDataError(message: string): void {
  elements.dataErrorMessage.textContent = message;
  elements.dataError.hidden = false;
}

function hideDataError(): void {
  elements.dataError.hidden = true;
}

function renderLastUpdated(): void {
  elements.lastUpdatedElement.textContent = state.lastRealtimeAt
    ? `Updated ${formatArrivalTime(state.lastRealtimeAt)}`
    : "";
}

function isLocationPermissionDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 1
  );
}

function syncSetupVisibility(): void {
  elements.setupCard.classList.toggle("collapsed", !state.setupOpen);
  elements.setupLabel.textContent = "Add a stop";
  elements.setupTitle.textContent =
    !state.selectedRouteId
      ? "Choose a route"
      : getSelectedDirections().length > 1 && !state.selectedDirectionKey
        ? "Choose a direction"
        : "Choose a stop";
  elements.setupToggle.setAttribute("aria-expanded", String(state.setupOpen));
  elements.setupToggle.setAttribute(
    "aria-label",
    state.setupOpen ? "Collapse add stop form" : "Add another stop",
  );
  elements.collapseIcon.textContent = "";
}

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function runtimeMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (response === undefined) {
        reject(new Error("The background service did not respond."));
        return;
      }
      resolve(response);
    });
  });
}

function getSelectedDirections(): DirectionOption[] {
  return state.cache?.directionsByRoute.get(state.selectedRouteId) ?? [];
}

function getSelectedRoute(): Route | undefined {
  return state.cache?.routes.find((route) => route.id === state.selectedRouteId);
}

function updateStepCount(): void {
  if (!state.selectedRouteId) {
    elements.stepCountElement.textContent = "1 of 3";
  } else if (getSelectedDirections().length > 1 && !state.selectedDirectionKey) {
    elements.stepCountElement.textContent = "2 of 3";
  } else {
    elements.stepCountElement.textContent = "3 of 3";
  }
}

function renderRouteOptions(): void {
  const routes = state.cache?.routes ?? [];
  elements.routeSelect.replaceChildren(new Option("Select a route", ""));
  for (const route of routes) {
    const option = new Option(`${route.shortName} · ${route.longName}`, route.id);
    elements.routeSelect.append(option);
  }
  elements.routeSelect.value = state.selectedRouteId;
}

function renderDirectionOptions(): void {
  const directions = getSelectedDirections();
  elements.directionSelect.replaceChildren(new Option("Select a direction", ""));
  for (const direction of directions) {
    const directionKey = routeVariantKey(
      state.selectedRouteId,
      direction.directionId,
      direction.headsign,
    );
    elements.directionSelect.append(
      new Option(`→ ${direction.headsign}`, directionKey),
    );
  }

  const hasRoute = Boolean(state.selectedRouteId);
  const hasMultipleDirections = directions.length > 1;
  elements.directionStep.hidden = !hasRoute || !hasMultipleDirections;

  if (directions.length === 1) {
    state.selectedDirectionId = directions[0].directionId;
    state.selectedDirectionKey = routeVariantKey(
      state.selectedRouteId,
      directions[0].directionId,
      directions[0].headsign,
    );
  }
  elements.directionSelect.value = state.selectedDirectionKey;
  renderStopOptions();
  updateStepCount();
}

function getSelectedDirection(): DirectionOption | undefined {
  return getSelectedDirections().find(
    (direction) =>
      routeVariantKey(state.selectedRouteId, direction.directionId, direction.headsign) ===
      state.selectedDirectionKey,
  );
}

function getStopsForSelection(): Stop[] {
  const direction = getSelectedDirection();
  if (!state.cache || !state.selectedRouteId || !direction) return [];
  const stopIds = state.cache.stopIdsByVariant.get(
    routeVariantKey(state.selectedRouteId, direction.directionId, direction.headsign),
  ) ?? [];
  const stopsById = new Map(state.cache.stops.map((stop) => [stop.id, stop]));
  return stopIds.flatMap((stopId) => {
    const stop = stopsById.get(stopId);
    return stop ? [stop] : [];
  });
}

function renderStopOptions(): void {
  elements.nearButton.hidden = !hasProFeatures();
  const stops = getStopsForSelection();
  state.visibleStops = state.visibleStops.length > 0 ? state.visibleStops : stops;
  if (
    state.visibleStops.length === 0 ||
    state.visibleStops.some((stop) => !stops.some((candidate) => candidate.id === stop.id))
  ) {
    state.visibleStops = stops;
  }

  elements.stopSelect.replaceChildren(new Option("Select a stop", ""));
  for (const stop of state.visibleStops) {
    elements.stopSelect.append(new Option(`${stop.name} · ${stop.code}`, stop.id));
  }
  elements.stopSelect.value = state.selectedStopId;
  elements.stopStep.hidden = !state.selectedDirectionKey;
  elements.saveButton.disabled = !state.selectedStopId;
  updateStepCount();
}

function renderSetup(): void {
  renderRouteOptions();
  renderDirectionOptions();
  syncSetupVisibility();
}

function minuteClass(minutes: number): string {
  if (minutes <= 2) return "critical";
  if (minutes <= 7) return "warning";
  return "";
}

function routeColor(route: Route | undefined): string {
  if (route?.color && /^#[\da-f]{6}$/i.test(route.color)) return route.color;
  return "#28766f";
}

function renderArrival(arrival: Arrival): HTMLElement {
  const item = makeElement("div", "arrival");
  item.append(
    makeElement("span", "arrival-time", formatArrivalTime(arrival.timestamp)),
    makeElement(
      "span",
      `arrival-minutes ${minuteClass(arrival.minutes)}`,
      formatMinutesAway(arrival.minutes),
    ),
  );
  return item;
}

function getAlertLeadMinutes(watch: Watch): number {
  const value = watch.alertLeadMinutes;
  return value !== undefined && ALERT_LEAD_OPTIONS.includes(value as (typeof ALERT_LEAD_OPTIONS)[number])
    ? value
    : DEFAULT_ALERT_LEAD_MINUTES;
}

function renderAlertControl(watch: Watch): HTMLElement {
  const control = makeElement("div", "alert-control");
  const toggle = makeElement("button", "alert-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-pressed", String(Boolean(watch.alertsEnabled)));
  toggle.title = watch.alertsEnabled ? "Turn alerts off" : "Turn alerts on";
  toggle.setAttribute(
    "aria-label",
    watch.alertsEnabled
      ? `Turn off arrival alerts for ${watch.stopName}`
      : `Turn on arrival alerts for ${watch.stopName}`,
  );
  toggle.classList.toggle("enabled", Boolean(watch.alertsEnabled));
  const bellIcon = makeElement("span", "bell-icon");
  bellIcon.setAttribute("aria-hidden", "true");
  toggle.append(bellIcon);
  toggle.addEventListener("click", () => {
    void updateAlertEnabled(watch, !watch.alertsEnabled);
  });

  const select = makeElement("select", "alert-time-select");
  select.setAttribute("aria-label", `Alert lead time for ${watch.stopName}`);
  const selectedMinutes = getAlertLeadMinutes(watch);
  for (const minutes of ALERT_LEAD_OPTIONS) {
    select.append(new Option(`${minutes}m`, String(minutes)));
  }
  select.value = String(selectedMinutes);
  select.addEventListener("change", () => {
    void updateAlertTime(watch, Number(select.value));
  });
  control.append(toggle, select);
  return control;
}

function renderWatch(watch: Watch, arrivals: Arrival[]): HTMLElement {
  const route = state.cache?.routes.find((candidate) => candidate.id === watch.routeId);
  const card = makeElement(
    "article",
    [
      arrivals.length === 0 ? "watch-card" : arrivals[0].isLive ? "watch-card live" : "watch-card scheduled",
      hasProFeatures() && watch.id === state.nearestWatchId ? "nearest" : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
  const topLine = makeElement("div", "watch-topline");
  const badge = makeElement("span", "route-badge", watch.routeShortName);
  badge.style.backgroundColor = routeColor(route);
  const stop = makeElement("div", "watch-stop");
  const stopName = makeElement("span", "watch-stop-name", watch.stopName);
  const stopMeta = makeElement("span", "watch-stop-meta");
  stopMeta.append(makeElement("span", "watch-stop-code", `Stop ${watch.stopCode}`));
  if (hasProFeatures() && watch.id === state.nearestWatchId) {
    stopMeta.append(makeElement("span", "nearest-label", "Closest to you"));
  }
  stop.append(stopName);
  if (stopMeta.childElementCount > 0) stop.append(stopMeta);
  const watchActions = makeElement("div", "watch-actions");
  if (hasProFeatures()) {
    watchActions.append(renderAlertControl(watch));
  }
  const deleteButton = makeElement("button", "delete-button", "×");
  deleteButton.type = "button";
  deleteButton.setAttribute("aria-label", `Delete ${watch.stopName}`);
  deleteButton.addEventListener("click", () => {
    void removeWatch(watch.id);
  });
  watchActions.append(deleteButton);
  topLine.append(badge, stop, watchActions);

  const direction = makeElement("div", "watch-direction");
  direction.append("→ ", makeElement("strong", undefined, watch.tripHeadsign));

  const arrivalStatus = makeElement(
    "div",
    `arrival-status ${arrivals.length > 0 ? (arrivals[0].isLive ? "live" : "scheduled") : "empty"}`,
    arrivals.length === 0
      ? "No current arrival data"
      : arrivals[0].isLive
        ? "Live departures"
        : "Scheduled times",
  );

  const arrivalRow = makeElement("div", "arrival-row");
  if (arrivals.length > 0) {
    arrivals.forEach((arrival) => arrivalRow.append(renderArrival(arrival)));
  } else {
    arrivalRow.append(makeElement("span", "no-arrival", "No arrival data"));
  }
  card.setAttribute(
    "aria-label",
    arrivals.length === 0
      ? `${watch.stopName}, no arrival data`
      : `${watch.stopName}, ${arrivals[0].isLive ? "live" : "scheduled"} arrivals`,
  );
  card.append(topLine, direction, arrivalStatus, arrivalRow);
  return card;
}

function renderWatches(): void {
  elements.watchesElement.replaceChildren();
  elements.emptyState.hidden = state.watches.length > 0;
  if (!state.cache) return;
  const arrivalMap = getArrivalsForWatches(state.watches, state.cache, state.realtime);
  const watches = [...state.watches].sort((a, b) => {
    if (hasProFeatures() && a.id === state.nearestWatchId) return -1;
    if (hasProFeatures() && b.id === state.nearestWatchId) return 1;
    return a.createdAt - b.createdAt;
  });
  for (const watch of watches) {
    elements.watchesElement.append(renderWatch(watch, arrivalMap.get(watch.id) ?? []));
  }
}

async function refreshNearbyWatch(): Promise<void> {
  if (!hasProFeatures() || !(await hasLocationConsent())) return;
  try {
    const position = await getCurrentPosition();
    await saveLastLocation(position.coords.latitude, position.coords.longitude);
    if (state.cache) {
      state.nearestWatchId = getNearestWatchId(
        state.watches,
        state.cache.stops,
        position.coords.latitude,
        position.coords.longitude,
      );
      renderWatches();
    }
    void runtimeMessage<{ ok: boolean }>({ type: "LOCATION_UPDATED" }).catch(() => undefined);
  } catch (error) {
    if (isLocationPermissionDenied(error)) {
      await setLocationConsent(false);
      await syncLocationPrompt();
      return;
    }
    const location = await getLastLocation();
    if (location && state.cache) {
      state.nearestWatchId = getNearestWatchId(
        state.watches,
        state.cache.stops,
        location.latitude,
        location.longitude,
      );
      renderWatches();
    }
  }
}

async function removeWatch(id: string): Promise<void> {
  state.watches = await deleteWatch(id);
  if (state.watches.length === 0) state.setupOpen = true;
  if (id === state.nearestWatchId) state.nearestWatchId = undefined;
  renderWatches();
  void refreshNearbyWatch();
  void syncLocationPrompt();
  syncSetupVisibility();
  setStatus("");
}

function resetSetup(): void {
  state.selectedRouteId = "";
  state.selectedDirectionId = "";
  state.selectedDirectionKey = "";
  state.selectedStopId = "";
  state.visibleStops = [];
  renderSetup();
}

async function addWatch(): Promise<void> {
  const route = getSelectedRoute();
  const direction = getSelectedDirection();
  const stop = state.visibleStops.find((candidate) => candidate.id === state.selectedStopId);
  if (!route || !direction || !stop) return;

  state.watches = await saveWatch({
    id: crypto.randomUUID(),
    routeId: route.id,
    routeShortName: route.shortName,
    directionId: direction.directionId,
    tripHeadsign: direction.headsign,
    stopId: stop.id,
    stopCode: stop.code,
    stopName: stop.name,
    createdAt: Date.now(),
  });
  state.setupOpen = false;
  renderWatches();
  resetSetup();
  void refreshNearbyWatch();
  void syncLocationPrompt();
  setStatus("");
}

async function requestNotificationPermission(): Promise<boolean> {
  if (!IS_PRO_BUILD) return false;
  return chrome.permissions.request({ permissions: ["notifications"] });
}

async function getNotificationStatus(): Promise<NotificationStatusResponse> {
  return runtimeMessage<NotificationStatusResponse>({ type: "NOTIFICATION_STATUS" });
}

function notificationPermissionMessage(status: NotificationStatusResponse): string {
  if (!status.ok) return status.error;
  if (!status.extensionPermissionGranted) {
    return "Chrome notification access was not granted. Press Test again and choose Allow.";
  }
  if (status.permissionLevel !== "granted") {
    return "Chrome notifications are blocked. Turn on Google Chrome in macOS System Settings → Notifications, then try again.";
  }
  return "Chrome says notifications are enabled. If nothing appears, check Google Chrome in macOS System Settings → Notifications.";
}

async function sendTestNotification(): Promise<void> {
  if (!IS_PRO_BUILD) return;
  elements.testNotificationButton.disabled = true;
  setStatus("Requesting notification permission…");
  try {
    if (!(await requestNotificationPermission())) {
      const status = await getNotificationStatus().catch(
        (): NotificationStatusResponse => ({
          ok: false,
          error: "Chrome did not grant notification access.",
        }),
      );
      setStatus(notificationPermissionMessage(status), true);
      return;
    }
    const response = await runtimeMessage<
      NotificationStatusResponse & { notificationId?: string }
    >({
      type: "TEST_NOTIFICATION",
    });
    if (!response.ok) {
      setStatus(notificationPermissionMessage(response), true);
      return;
    }
    setStatus("Chrome accepted the test. If no banner appears, enable Google Chrome in macOS System Settings → Notifications.");
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Could not send a test notification.",
      true,
    );
  } finally {
    elements.testNotificationButton.disabled = false;
  }
}

async function syncLocationPrompt(): Promise<void> {
  if (!hasProFeatures() || state.watches.length === 0) {
    elements.locationPrompt.hidden = true;
    return;
  }
  elements.locationPrompt.hidden = await hasLocationConsent();
}

async function enableLocation(): Promise<void> {
  elements.locationButton.disabled = true;
  try {
    await getCurrentPosition();
    await setLocationConsent(true);
    elements.locationPrompt.hidden = true;
    await refreshNearbyWatch();
  } catch (error) {
    if (isLocationPermissionDenied(error)) await setLocationConsent(false);
    setStatus(
      isLocationPermissionDenied(error)
        ? "Location access was not granted."
        : "Could not enable location ordering.",
      true,
    );
  } finally {
    elements.locationButton.disabled = false;
  }
}

async function updateAlertEnabled(watch: Watch, enabled: boolean): Promise<void> {
  if (!hasProFeatures()) return;
  try {
    if (enabled) {
      if (!(await requestNotificationPermission())) {
        const status = await getNotificationStatus().catch(
          (): NotificationStatusResponse => ({
            ok: false,
            error: "Chrome did not grant notification access.",
          }),
        );
        setStatus(notificationPermissionMessage(status), true);
        return;
      }

      const status = await getNotificationStatus();
      if (!status.ok || !status.extensionPermissionGranted || status.permissionLevel !== "granted") {
        setStatus(notificationPermissionMessage(status), true);
        return;
      }
    }
    state.watches = await setWatchAlerts(watch.id, enabled, getAlertLeadMinutes(watch));
    renderWatches();
    void runtimeMessage<{ ok: boolean }>({ type: "ALERTS_UPDATED" }).catch(() => undefined);
    setStatus("");
  } catch {
    setStatus("Could not update arrival alerts.", true);
    renderWatches();
  }
}

async function updateAlertTime(watch: Watch, alertLeadMinutes: number): Promise<void> {
  if (!hasProFeatures()) return;
  try {
    state.watches = await setWatchAlerts(
      watch.id,
      Boolean(watch.alertsEnabled),
      alertLeadMinutes,
    );
    renderWatches();
    void runtimeMessage<{ ok: boolean }>({ type: "ALERTS_UPDATED" }).catch(() => undefined);
    setStatus("");
  } catch {
    setStatus("Could not update the alert time.", true);
    renderWatches();
  }
}

async function sortStopsNearMe(): Promise<void> {
  if (!hasProFeatures()) return;
  elements.nearButton.disabled = true;
  setStatus("Finding stops near you…");
  try {
    const position = await getCurrentPosition();
    await setLocationConsent(true);
    state.visibleStops = sortStopsByDistance(
      getStopsForSelection(),
      position.coords.latitude,
      position.coords.longitude,
    );
    renderStopOptions();
    setStatus("");
  } catch (error) {
    if (isLocationPermissionDenied(error)) {
      await setLocationConsent(false);
    }
    setStatus(
      isLocationPermissionDenied(error)
        ? "Location access was not granted."
        : error instanceof Error
          ? error.message
          : "Could not find your location.",
      true,
    );
  } finally {
    elements.nearButton.disabled = false;
  }
}

async function refreshArrivals(showStatus = true): Promise<void> {
  elements.refreshButton.disabled = true;
  try {
    const response = await runtimeMessage<RealtimeResponse>({ type: "FETCH_REALTIME" });
    if (!response.ok) throw new Error(response.error);
    state.realtime = response.entities;
    state.lastRealtimeAt = Date.now();
    renderLastUpdated();
    renderWatches();
    if (showStatus) setStatus("");
  } catch (error) {
    if (showStatus) {
      setStatus(
        error instanceof Error ? error.message : "Could not update arrivals.",
        true,
      );
    }
    renderWatches();
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function retryRouteData(): Promise<void> {
  elements.retryRouteDataButton.disabled = true;
  setStatus("Refreshing route data…");
  try {
    state.cache = await getGtfsCache(true);
    hideDataError();
    renderSetup();
    renderWatches();
    setStatus("");
    void refreshArrivals(false);
  } catch (error) {
    setStatus("");
    showDataError(
      error instanceof Error ? error.message : "Could not load GRT route data.",
    );
  } finally {
    elements.retryRouteDataButton.disabled = false;
  }
}

function schedulePopupRefresh(): void {
  window.setTimeout(() => {
    void refreshArrivals(false).finally(schedulePopupRefresh);
  }, 20_000);
}

function renderPlanButton(): void {
  const pro = hasProFeatures();
  elements.planButton.hidden = !IS_PRO_BUILD;
  elements.testNotificationButton.hidden = !IS_PRO_BUILD;
  elements.planButton.textContent = pro ? "Pro" : "Free";
  elements.planButton.classList.toggle("pro", pro);
  elements.planButton.setAttribute("aria-expanded", String(state.planOpen));
  elements.planButton.setAttribute(
    "aria-label",
    pro ? "Pro plan, view benefits" : "Free plan, view Pro benefits",
  );
}

function closePlan(): void {
  state.planOpen = false;
  renderPlanButton();
  renderProAccess();
  state.planPreviousFocus?.focus();
  state.planPreviousFocus = undefined;
}

function openPlan(): void {
  state.planPreviousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : undefined;
  state.planOpen = true;
  renderPlanButton();
  renderProAccess();
  elements.planClose.focus();
}

function renderProAccess(): void {
  if (!IS_PRO_BUILD || !state.planOpen) {
    elements.proAccess.hidden = true;
    return;
  }

  elements.proAccess.hidden = false;
  elements.upgradeButton.disabled = !PAYMENTS_CONFIGURED;
  elements.restoreButton.disabled = !PAYMENTS_CONFIGURED;
  if (state.proPaid) {
    elements.proAccessTitle.textContent = "Pro is active";
    elements.proAccessMessage.textContent =
      "You have the full GRT Next Bus experience.";
    elements.planBenefitLead.textContent = "Your next bus tools are active.";
    elements.planPrice.hidden = true;
    elements.planStatus.textContent = "Pro is active on this browser.";
    elements.upgradeButton.textContent = "Manage subscription";
    elements.restoreButton.textContent = "Refresh plan status";
  } else if (!PAYMENTS_CONFIGURED) {
    elements.proAccessTitle.textContent = "Pro payments need setup";
    elements.proAccessMessage.textContent =
      "Set the ExtensionPay ID before publishing this extension.";
    elements.planBenefitLead.textContent = "Payment setup is required before release.";
    elements.planPrice.hidden = false;
    elements.planStatus.textContent = "Pro checkout is not configured yet.";
  } else if (state.paymentError) {
    elements.proAccessTitle.textContent = "Couldn’t verify Pro access";
    elements.proAccessMessage.textContent =
      "Check your connection, then try again or restore your purchase.";
    elements.planBenefitLead.textContent = "Your plan status could not be checked.";
    elements.planPrice.hidden = false;
    elements.planStatus.textContent = "Try again when you are back online.";
  } else {
    elements.proAccessTitle.textContent = "See more at a glance";
    elements.proAccessMessage.textContent =
      "Unlock the features that make your next bus easier to catch.";
    elements.planBenefitLead.textContent = "A clearer view of your next departure.";
    elements.planPrice.hidden = false;
    elements.planStatus.textContent =
      "Plans are monthly or yearly. Your saved stops stay right where they are.";
    elements.upgradeButton.textContent = "Choose Pro";
    elements.restoreButton.textContent = "Already purchased? Restore";
  }
}

function renderPaymentState(): void {
  renderPlanButton();
  renderProAccess();
  renderSetup();
  renderWatches();
}

async function loadPaymentStatus(): Promise<void> {
  if (!IS_PRO_BUILD) {
    state.proPaid = true;
    return;
  }
  if (!PAYMENTS_CONFIGURED) {
    state.proPaid = false;
    state.paymentError = true;
    return;
  }

  try {
    const user = await getPaymentUser();
    state.proPaid = Boolean(user?.paid);
    state.paymentError = false;
  } catch (error) {
    console.warn("Unable to verify GRT Next Bus Pro access", error);
    state.proPaid = false;
    state.paymentError = true;
  }
}

async function startUpgrade(): Promise<void> {
  if (!IS_PRO_BUILD || !PAYMENTS_CONFIGURED) return;
  elements.upgradeButton.disabled = true;
  try {
    await openPaymentPage();
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Could not open the payment page.",
      true,
    );
  } finally {
    elements.upgradeButton.disabled = false;
  }
}

async function restorePurchase(): Promise<void> {
  if (!IS_PRO_BUILD || !PAYMENTS_CONFIGURED) return;
  elements.restoreButton.disabled = true;
  try {
    await openLoginPage();
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Could not open the restore page.",
      true,
    );
  } finally {
    elements.restoreButton.disabled = false;
  }
}

elements.routeSelect.addEventListener("change", () => {
  state.selectedRouteId = elements.routeSelect.value;
  state.selectedDirectionId = "";
  state.selectedDirectionKey = "";
  state.selectedStopId = "";
  state.visibleStops = [];
  renderDirectionOptions();
});

elements.directionSelect.addEventListener("change", () => {
  state.selectedDirectionKey = elements.directionSelect.value;
  state.selectedDirectionId = getSelectedDirection()?.directionId ?? "";
  state.selectedStopId = "";
  state.visibleStops = [];
  renderStopOptions();
});

elements.stopSelect.addEventListener("change", () => {
  state.selectedStopId = elements.stopSelect.value;
  elements.saveButton.disabled = !state.selectedStopId;
});

elements.nearButton.addEventListener("click", () => {
  void sortStopsNearMe();
});

elements.locationButton.addEventListener("click", () => {
  void enableLocation();
});

elements.planButton.addEventListener("click", () => {
  if (state.planOpen) closePlan();
  else openPlan();
});

elements.planClose.addEventListener("click", () => {
  closePlan();
});

elements.retryRouteDataButton.addEventListener("click", () => {
  void retryRouteData();
});

elements.testNotificationButton.addEventListener("click", () => {
  void sendTestNotification();
});

elements.upgradeButton.addEventListener("click", () => {
  void startUpgrade();
});

elements.restoreButton.addEventListener("click", () => {
  void restorePurchase();
});

elements.saveButton.addEventListener("click", () => {
  void addWatch();
});

elements.refreshButton.addEventListener("click", () => {
  void refreshArrivals();
});

elements.setupToggle.addEventListener("click", () => {
  state.setupOpen = !state.setupOpen;
  syncSetupVisibility();
  if (state.setupOpen) elements.routeSelect.focus();
});

document.addEventListener("click", (event) => {
  if (!state.planOpen || !(event.target instanceof Node)) return;
  if (elements.proAccess.contains(event.target) || elements.planButton.contains(event.target)) return;
  closePlan();
});

document.addEventListener("keydown", (event) => {
  if (!state.planOpen) return;
  if (event.key === "Escape") {
    closePlan();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    elements.planDialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex=\"-1\"])",
    ),
  );
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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes.watches) return;
  void getWatches().then((watches) => {
    state.watches = watches;
    renderWatches();
    void syncLocationPrompt();
  });
});

async function initialize(): Promise<void> {
  renderPlanButton();
  try {
    setStatus("Loading route data…");
    const [cache, watches] = await Promise.all([getGtfsCache(false, true), getWatches()]);
    state.cache = cache;
    state.watches = watches;
    state.setupOpen = state.watches.length === 0;
    hideDataError();
    renderPlanButton();
    renderSetup();
    renderWatches();
    setStatus("");

    void refreshArrivals(false);
    void loadPaymentStatus().then(async () => {
      renderPaymentState();
      const locationConsent = hasProFeatures() && (await hasLocationConsent());
      elements.locationPrompt.hidden =
        !hasProFeatures() || state.watches.length === 0 || locationConsent;
      if (IS_PRO_BUILD) {
        void runtimeMessage<{ ok: boolean }>({ type: "PAYMENT_UPDATED" }).catch(() => undefined);
      }
      if (locationConsent) void refreshNearbyWatch();
    });
  } catch (error) {
    setStatus("");
    showDataError(
      error instanceof Error ? error.message : "Could not load GRT route data.",
    );
  }
  schedulePopupRefresh();
}

void initialize();
