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

const { reorderSavedStops } = await import("../src/storage.ts");

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
