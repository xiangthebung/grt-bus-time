/**
 * Tests for the realtime normalisation in `src/gtfsRealtime.ts`, and for the one
 * consumer whose behaviour depends most sharply on it, `alertsForStop`.
 *
 * These go through real encoded protobuf rather than hand-written snapshot
 * objects on purpose. The decoder is where the interesting mistakes live: a
 * GTFS-realtime field that never arrived still reads back as its type's default,
 * so `0` reaching the normaliser means either "the agency said zero" or "the
 * agency said nothing", and only the wire bytes can tell the two apart. A test
 * that starts from a snapshot literal cannot reproduce that at all.
 *
 * Sources are imported through `src-hooks.mjs`; see that file for why.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import bindings from "gtfs-realtime-bindings";

register(new URL("./src-hooks.mjs", import.meta.url));

const { decodeRealtimeSnapshot } = await import("../src/gtfsRealtime.ts");
const { alertsForStop } = await import("../src/departures.ts");
const { realtimePredictionsFresh } = await import("../src/types.ts");

const { transit_realtime } = bindings;

const NOW = Date.UTC(2025, 5, 10, 15, 0, 0);
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** GTFS-realtime counts in whole seconds; the snapshot converts back to ms. */
const seconds = (ms) => Math.floor(ms / 1000);

/** Encodes a feed the way the GRT endpoints serve one. */
const encodeFeed = (entity, header = {}) =>
  transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: "2.0", timestamp: seconds(NOW), ...header },
    entity,
  }).finish();

/** `decodeRealtimeSnapshot` always wants trip updates; most cases do not care. */
const NO_TRIP_UPDATES = encodeFeed([]);

/** `period` goes straight onto `active_period`, so an absent `end` stays absent. */
const alertEntity = (id, period, informed, url) => ({
  id,
  alert: {
    activePeriod: [period],
    informedEntity: [informed],
    headerText: { translation: [{ language: "en", text: `${id} headline` }] },
    descriptionText: { translation: [{ language: "en", text: "Detour in effect." }] },
    ...(url ? { url: { translation: [{ language: "en", text: url }] } } : {}),
  },
});

/** `alertsForStop` reads nothing but `routeIdsByStop`, so that is the whole stub. */
const indexStub = (routeIdsByStop = {}) => ({
  routeIdsByStop: new Map(Object.entries(routeIdsByStop)),
});

const decodeAlerts = (entity) =>
  decodeRealtimeSnapshot({ tripUpdates: NO_TRIP_UPDATES, alerts: encodeFeed(entity) });

test("an alert with a start and no end runs until further notice", () => {
  // An `active_period` with a `start` and no `end` is how an agency says "until
  // further notice", which is the alert a rider most needs to see.
  const snapshot = decodeAlerts([
    alertEntity("open-ended", { start: seconds(NOW - 3 * HOUR_MS) }, { stopId: "1122" }),
  ]);

  const [alert] = snapshot.alerts;
  assert.equal(alert.startMs, NOW - 3 * HOUR_MS);
  assert.equal(
    alert.endMs,
    undefined,
    "an absent active_period.end must stay absent, not become an end date in 1970",
  );

  const shown = alertsForStop(indexStub({ 1122: ["7"] }), snapshot, "1122", undefined, NOW);
  assert.deepEqual(
    shown.map((entry) => entry.id),
    ["open-ended"],
    "the open-ended alert was dropped as though it had already finished",
  );
});

test("an active period the agency really did bound is still honoured", () => {
  // The other half of the same filter: fixing the open-ended case must not turn
  // `alertsForStop` into a pass-through that shows finished detours forever, or
  // announces next month's construction today.
  const atStop = { stopId: "1122" };
  const snapshot = decodeAlerts([
    alertEntity(
      "finished",
      { start: seconds(NOW - 2 * DAY_MS), end: seconds(NOW - HOUR_MS) },
      atStop,
    ),
    alertEntity("not-yet", { start: seconds(NOW + 7 * DAY_MS) }, atStop),
    alertEntity(
      "running",
      { start: seconds(NOW - HOUR_MS), end: seconds(NOW + HOUR_MS) },
      atStop,
    ),
    alertEntity("route-wide", { start: seconds(NOW - HOUR_MS) }, { routeId: "7" }),
  ]);

  const shown = alertsForStop(indexStub({ 1122: ["7"] }), snapshot, "1122", undefined, NOW);
  assert.deepEqual(
    shown.map((entry) => entry.id),
    ["running", "route-wide"],
  );
});

test("direction-specific alert selectors stay attached to the alert", () => {
  const snapshot = decodeAlerts([
    alertEntity("outbound", { start: seconds(NOW - HOUR_MS) }, {
      routeId: "7",
      directionId: 0,
    }),
  ]);
  assert.deepEqual(snapshot.alerts[0].directionIds, ["0"]);
  assert.equal(
    alertsForStop(indexStub({ 1122: ["7"] }), snapshot, "1122", "7", NOW, "1").length,
    0,
  );
  assert.equal(
    alertsForStop(indexStub({ 1122: ["7"] }), snapshot, "1122", "7", NOW, "0").length,
    1,
  );
});

test("alert links keep only safe web URLs", () => {
  const snapshot = decodeAlerts([
    alertEntity("safe", { start: seconds(NOW - HOUR_MS) }, { stopId: "1122" }, "https://grt.example/alert"),
    alertEntity("unsafe", { start: seconds(NOW - HOUR_MS) }, { stopId: "1122" }, "javascript:alert(1)"),
  ]);
  assert.equal(snapshot.alerts[0].url, "https://grt.example/alert");
  assert.equal(snapshot.alerts[1].url, undefined);
});

test("a vehicle at the first stop of its trip is not mistaken for one with no position", () => {
  // `stops away` counts from `currentStopSequence`, so a vehicle that never
  // reported one has to stay `undefined`: counted from a fabricated 0 it would
  // tell a rider at an early stop that the bus is a couple of stops back when
  // nobody knows where it is. Sequence 0 that the agency did send is a real
  // position — the first stop of the trip — and has to survive.
  const snapshot = decodeRealtimeSnapshot({
    tripUpdates: NO_TRIP_UPDATES,
    vehiclePositions: encodeFeed([
      { id: "v1", vehicle: { trip: { tripId: "silent" }, timestamp: seconds(NOW) } },
      {
        id: "v2",
        vehicle: {
          trip: { tripId: "at-first-stop" },
          currentStopSequence: 0,
          timestamp: seconds(NOW),
        },
      },
      {
        id: "v3",
        vehicle: {
          trip: { tripId: "under-way" },
          currentStopSequence: 12,
          timestamp: seconds(NOW),
        },
      },
    ]),
  });

  const bySequence = Object.fromEntries(
    snapshot.vehicles.map((vehicle) => [vehicle.tripId, vehicle.sequence]),
  );
  assert.deepEqual(bySequence, {
    silent: undefined,
    "at-first-stop": 0,
    "under-way": 12,
  });
});

test("stop time updates keep the difference between sequence 0 and no sequence", () => {
  const snapshot = decodeRealtimeSnapshot({
    tripUpdates: encodeFeed([
      {
        id: "t1",
        tripUpdate: {
          trip: { tripId: "trip-a" },
          stopTimeUpdate: [
            { stopId: "first", stopSequence: 0, departure: { time: seconds(NOW) } },
            { stopId: "unsequenced", departure: { time: seconds(NOW + MINUTE_MS) } },
            { stopId: "later", stopSequence: 9, departure: { time: seconds(NOW + HOUR_MS) } },
          ],
        },
      },
    ]),
  });

  const stopTimes = Object.fromEntries(
    snapshot.trips[0].stopTimes.map((stopTime) => [stopTime.stopId, stopTime]),
  );

  // Same reasoning as the vehicle case, pointed the other way: `sequence` is what
  // the board uses to work out whether the bus is already past this stop, and a
  // fabricated 0 makes every trip look like it is still at the very beginning.
  assert.equal(stopTimes.first.sequence, 0);
  assert.equal(stopTimes.unsequenced.sequence, undefined);
  assert.equal(stopTimes.later.sequence, 9);

  // An absent `schedule_relationship`, by contrast, genuinely means SCHEDULED —
  // the spec gives the default that meaning — so 0 here is a fact, not a gap.
  assert.equal(stopTimes.unsequenced.relationship, 0);
});

test("a delay-only stop time update reports no predicted time rather than 1970", () => {
  // GTFS-realtime allows a StopTimeEvent carrying `delay` and no `time`. Read as
  // epoch 0 that becomes a departure in 1970, and the board drops the bus for
  // being in the past instead of falling back to its scheduled time.
  const snapshot = decodeRealtimeSnapshot({
    tripUpdates: encodeFeed([
      {
        id: "t1",
        tripUpdate: {
          trip: { tripId: "trip-a" },
          stopTimeUpdate: [
            { stopId: "delay-only", stopSequence: 4, departure: { delay: 120 } },
            {
              stopId: "predicted",
              stopSequence: 5,
              departure: { time: seconds(NOW + 5 * MINUTE_MS) },
            },
          ],
        },
      },
    ]),
  });

  const stopTimes = Object.fromEntries(
    snapshot.trips[0].stopTimes.map((stopTime) => [stopTime.stopId, stopTime]),
  );
  assert.equal(stopTimes["delay-only"].time, undefined);
  assert.equal(stopTimes.predicted.time, seconds(NOW + 5 * MINUTE_MS));
});

test("a partial snapshot preserves alerts and vehicle data when trip updates fail", () => {
  const snapshot = decodeRealtimeSnapshot({
    vehiclePositions: encodeFeed([
      { id: "v1", vehicle: { trip: { tripId: "trip-a" }, currentStopSequence: 4 } },
    ]),
    alerts: encodeFeed([]),
  });
  assert.equal(snapshot.tripUpdatesAvailable, false);
  assert.equal(snapshot.vehiclePositionsAvailable, true);
  assert.equal(snapshot.alertsAvailable, true);
  assert.equal(snapshot.degraded, true);
  assert.equal(snapshot.vehicles.length, 1);
  assert.equal(realtimePredictionsFresh(snapshot, NOW), false);
});

test("agency feed age makes a freshly downloaded frozen feed unusable", () => {
  const snapshot = decodeRealtimeSnapshot({
    tripUpdates: encodeFeed([], { timestamp: seconds(NOW - 10 * MINUTE_MS) }),
  });
  assert.equal(snapshot.tripUpdatesAvailable, true);
  assert.equal(snapshot.feedTimestamp, NOW - 10 * MINUTE_MS);
  assert.equal(realtimePredictionsFresh(snapshot, NOW), false);
});

test("an omitted feed timestamp does not masquerade as Unix epoch", () => {
  const bytes = transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: "2.0" },
    entity: [],
  }).finish();
  const snapshot = decodeRealtimeSnapshot({ tripUpdates: bytes });
  assert.equal(snapshot.feedTimestamp, undefined);
});
