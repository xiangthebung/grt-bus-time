import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./src-hooks.mjs", import.meta.url));

const { EMPTY_LOOKUP, getDepartureBoard } = await import("../src/departures.ts");
const { relevantServiceDays } = await import("../src/time.ts");

const NOW = Date.UTC(2026, 7, 2, 15, 0, 0);
const today = relevantServiceDays(NOW)[1];
const nowSec = Math.floor((NOW - today.midnightMs) / 1000);

const index = {
  schemaVersion: 5,
  fetchedAt: NOW,
  routes: [
    { id: "r13", shortName: "13", longName: "Route 13", type: 3 },
  ],
  stops: [{ id: "stop", code: "1109", name: "Laurelwood", lat: 0, lon: 0 }],
  serviceDates: [today.dateKey],
  servicesByDate: new Map([[today.dateKey, Int32Array.from([0])]]),
  tripIds: ["trip-outbound", "trip-inbound"],
  tripIndexById: new Map([
    ["trip-outbound", 0],
    ["trip-inbound", 1],
  ]),
  routeIndexById: new Map([["r13", 0]]),
  tripRoute: Int32Array.from([0, 0]),
  tripHeadsign: Int32Array.from([0, 1]),
  tripService: Int32Array.from([0, 0]),
  tripDirection: Uint8Array.from([0, 1]),
  headsigns: ["Conestoga Mall", "Fairview Park Mall"],
  stopTimes: new Map([
    [
      "stop",
      {
        tripIndex: Int32Array.from([0, 1]),
        timeSec: Int32Array.from([nowSec + 5 * 60, nowSec + 10 * 60]),
        sequence: Uint16Array.from([12, 12]),
      },
    ],
  ]),
  routeIdsByStop: new Map([["stop", ["r13"]]]),
  patterns: new Map(),
};

test("direction filters keep only the selected route direction", () => {
  const outbound = getDepartureBoard(index, EMPTY_LOOKUP, {
    stopId: "stop",
    routeId: "r13",
    directionId: "0",
    limit: 3,
    now: NOW,
  });
  assert.deepEqual(
    outbound.departures.map(({ tripId, headsign }) => [tripId, headsign]),
    [["trip-outbound", "Conestoga Mall"]],
  );

  const inbound = getDepartureBoard(index, EMPTY_LOOKUP, {
    stopId: "stop",
    routeId: "r13",
    directionId: "1",
    limit: 3,
    now: NOW,
  });
  assert.deepEqual(
    inbound.departures.map(({ tripId, headsign }) => [tripId, headsign]),
    [["trip-inbound", "Fairview Park Mall"]],
  );

  const eitherDirection = getDepartureBoard(index, EMPTY_LOOKUP, {
    stopId: "stop",
    routeId: "r13",
    limit: 3,
    now: NOW,
  });
  assert.deepEqual(
    eitherDirection.departures.map(({ tripId }) => tripId),
    ["trip-outbound", "trip-inbound"],
  );
});
