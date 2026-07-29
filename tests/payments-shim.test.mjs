/**
 * The Free build swaps `./payments` for `./payments.free`, so the two files have
 * to keep the same shape.
 *
 * `tsc` does not notice when they drift: it only ever sees the real module, and
 * the alias is applied by the bundler. The failure therefore lands at the end of
 * `npm run build:free`, after a clean typecheck, as a rollup error about a missing
 * export — which is how a `getPaymentPlans` added to one file and not the other was
 * actually found. This compares the two directly instead.
 *
 * Read as text rather than imported: the real module pulls in `extpay`, which
 * expects a browser.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");

/** Exported top-level names, in declaration order. */
function exportedNames(source) {
  return [
    ...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm),
  ].map((match) => match[1]);
}

test("the Free payments shim exports everything the real module does", async () => {
  const [real, free] = await Promise.all([read("payments.ts"), read("payments.free.ts")]);

  const expected = exportedNames(real);
  const actual = exportedNames(free);
  assert.ok(expected.length >= 5, `could not read the exports of payments.ts (${expected.length})`);

  const missing = expected.filter((name) => !actual.includes(name));
  assert.deepEqual(
    missing,
    [],
    `payments.free.ts is missing ${missing.join(", ")} — the Free build will fail to bundle`,
  );

  // The reverse matters too: an export only the shim has is dead code that looks
  // like a feature.
  const extra = actual.filter((name) => !expected.includes(name));
  assert.deepEqual(extra, [], `payments.free.ts exports ${extra.join(", ")} which the real module does not`);
});

test("the Free shim really is inert", async () => {
  const free = await read("payments.free.ts");
  assert.match(free, /PAYMENTS_CONFIGURED = false/);
  // No import of the payment SDK, so the Free build cannot ship it by accident.
  assert.doesNotMatch(free, /from\s+"extpay"/);
});
