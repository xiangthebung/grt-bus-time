import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./src-hooks.mjs", import.meta.url));

const saved = [
  { id: "a", stopId: "a", stopCode: "1000", stopName: "A", createdAt: 1, position: 0 },
  { id: "b", stopId: "b", stopCode: "2000", stopName: "B", createdAt: 2, position: 1 },
  { id: "c", stopId: "c", stopCode: "3000", stopName: "C", createdAt: 3, position: 2 },
];
const syncStore = { savedStops: structuredClone(saved) };

globalThis.chrome = {
  storage: {
    sync: {
      async get() {
        return { savedStops: structuredClone(syncStore.savedStops) };
      },
      async set(values) {
        Object.assign(syncStore, structuredClone(values));
      },
      async remove() {},
    },
  },
};

const { reorderSavedStops, setStopRoute } = await import("../src/storage.ts");

test("reorderSavedStops persists a complete order and rejects incomplete orders", async () => {
  const reordered = await reorderSavedStops(["c", "a", "b"]);
  assert.deepEqual(
    reordered.map(({ id, position }) => [id, position]),
    [
      ["c", 0],
      ["a", 1],
      ["b", 2],
    ],
  );

  const unchanged = await reorderSavedStops(["c", "a"]);
  assert.deepEqual(
    unchanged.map(({ id, position }) => [id, position]),
    [
      ["c", 0],
      ["a", 1],
      ["b", 2],
    ],
    "a malformed order must not silently drop a saved stop",
  );

  const unknown = await reorderSavedStops(["c", "a", "missing"]);
  assert.deepEqual(
    unknown.map(({ id, position }) => [id, position]),
    [
      ["c", 0],
      ["a", 1],
      ["b", 2],
    ],
    "an order containing an unknown stop must be ignored",
  );
});

test("setStopRoute persists and clears a direction with the route filter", async () => {
  const narrowed = await setStopRoute("a", "r13", "13", "1", "Fairview Park Mall");
  assert.equal(narrowed[1].directionId, "1");
  assert.equal(narrowed[1].directionHeadsign, "Fairview Park Mall");

  const routeOnly = await setStopRoute("a", "r13", "13");
  assert.equal(routeOnly[1].routeId, "r13");
  assert.equal(routeOnly[1].directionId, undefined);
  assert.equal(routeOnly[1].directionHeadsign, undefined);

  const everyRoute = await setStopRoute("a");
  assert.equal(everyRoute[1].routeId, undefined);
  assert.equal(everyRoute[1].directionId, undefined);
  assert.equal(everyRoute[1].directionHeadsign, undefined);
});
