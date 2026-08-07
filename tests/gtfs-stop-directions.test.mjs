import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./src-hooks.mjs", import.meta.url));

const { directionsAtStop } = await import("../src/types.ts");

const pattern = (routeId, directionId, stopIds) => ({
  routeId,
  directionId,
  headsigns: [],
  stopIds,
});

const index = {
  patterns: new Map([
    ["r13:0", pattern("r13", "0", ["one-way", "shared"])],
    ["r13:1", pattern("r13", "1", ["shared"])],
    ["r7:0", pattern("r7", "0", ["other-route"])],
  ]),
};

test("a stop ID infers its one route destination", () => {
  assert.deepEqual(directionsAtStop(index, "one-way", "r13"), ["0"]);
});

test("shared platforms retain both real destinations without inventing choices elsewhere", () => {
  assert.deepEqual(directionsAtStop(index, "shared", "r13"), ["0", "1"]);
  assert.deepEqual(directionsAtStop(index, "one-way", "r7"), []);
});
