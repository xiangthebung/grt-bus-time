import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./src-hooks.mjs", import.meta.url));

const saved = [
  {
    id: "a",
    stopId: "a",
    stopCode: "1000",
    stopName: "A",
    routeId: "r7",
    routeShortName: "7",
    createdAt: 1,
    position: 0,
  },
  {
    id: "b",
    stopId: "b",
    stopCode: "2000",
    stopName: "B",
    routeId: "r13",
    routeShortName: "13",
    createdAt: 2,
    position: 1,
  },
  {
    id: "c",
    stopId: "a",
    stopCode: "1000",
    stopName: "A",
    routeId: "r8",
    routeShortName: "8",
    createdAt: 3,
    position: 2,
  },
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

const { addSavedStop, getSavedStops, reorderSavedStops } = await import(
  "../src/storage.ts"
);

test.beforeEach(() => {
  syncStore.savedStops = structuredClone(saved);
});

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

test("addSavedStop keeps stop + route pairs unique", async () => {
  const duplicate = await addSavedStop({
    stopId: "a",
    stopCode: "1000",
    stopName: "A",
    routeId: "r7",
    routeShortName: "7",
  });
  assert.equal(duplicate.length, 3, "the same pair must not be added twice");

  const anotherRoute = await addSavedStop({
    stopId: "a",
    stopCode: "1000",
    stopName: "A",
    routeId: "r12",
    routeShortName: "12",
  });
  assert.equal(anotherRoute.length, 4, "another route at the same stop is a new pair");
  assert.ok(
    anotherRoute.some((entry) => entry.stopId === "a" && entry.routeId === "r12"),
  );
});

test("direction-aware duplicates migrate to one route pair", async () => {
  syncStore.savedStops = [
    { ...saved[0], directionId: "0", directionHeadsign: "Downtown" },
    {
      ...saved[0],
      id: "a-other-direction",
      directionId: "1",
      directionHeadsign: "Terminal",
      alertsEnabled: true,
    },
  ];

  const migrated = await getSavedStops();
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].routeId, "r7");
  assert.equal(migrated[0].directionId, undefined);
  assert.equal(migrated[0].directionHeadsign, undefined);
  assert.equal(migrated[0].alertsEnabled, true);
});

test("choosing a route upgrades a legacy all-routes entry in place", async () => {
  syncStore.savedStops = [
    {
      id: "legacy",
      stopId: "a",
      stopCode: "1000",
      stopName: "A",
      createdAt: 1,
      position: 0,
      alertsEnabled: true,
    },
  ];

  const upgraded = await addSavedStop({
    stopId: "a",
    stopCode: "1000",
    stopName: "A",
    routeId: "r7",
    routeShortName: "7",
  });
  assert.equal(upgraded.length, 1);
  assert.equal(upgraded[0].id, "legacy");
  assert.equal(upgraded[0].routeId, "r7");
  assert.equal(upgraded[0].alertsEnabled, true);
});
