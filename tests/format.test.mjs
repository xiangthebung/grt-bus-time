import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./src-hooks.mjs", import.meta.url));

const { formatOverdueDelay } = await import("../src/format.ts");

const NOW = Date.UTC(2026, 7, 2, 15, 0, 0);

test("only a passed predicted time gets an overdue label", () => {
  assert.equal(
    formatOverdueDelay(NOW + 30_000, 5 * 60, NOW),
    undefined,
    "a positive schedule delay is not overdue while the prediction is still ahead",
  );
  assert.equal(formatOverdueDelay(NOW, 60, NOW), "1 min late");
  assert.equal(formatOverdueDelay(NOW - 30_000, -60, NOW), undefined);
  assert.equal(formatOverdueDelay(NOW - 30_000, Number.NaN, NOW), undefined);
});
