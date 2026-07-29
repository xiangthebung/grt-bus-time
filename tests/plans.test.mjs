/**
 * Tests for the plan formatting in `src/plans.ts`.
 *
 * Imported as TypeScript directly: Node strips the type annotations itself, and
 * `plans.ts` is deliberately free of anything that needs real compilation (no
 * enums, no namespaces, no decorators) so it can be tested without dragging a
 * build step into the test run.
 *
 * Worth testing at all because this is the code that decides what number appears
 * above the button that charges someone. The popup used to state "$0.99/month"
 * as markup, with no connection to the amount configured in the payment
 * dashboard.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  describePlan,
  formatAmount,
  orderPlans,
  usablePlans,
} from "../src/plans.ts";

const plan = (unitAmountCents, interval, extra = {}) => ({
  unitAmountCents,
  currency: "cad",
  interval,
  intervalCount: null,
  ...extra,
});

test("amounts are converted out of the currency's smallest unit", () => {
  const cad = formatAmount(99, "cad");
  assert.match(cad, /0\.99/, `expected 99 cad to read as 0.99, got ${cad}`);
  assert.match(formatAmount(799, "cad"), /7\.99/);
  assert.match(formatAmount(1250, "usd"), /12\.50/);

  // Yen has no subunit, so Stripe's figure is already the whole price. Dividing
  // by a hundred would advertise a 700 yen subscription as 7 yen.
  const jpy = formatAmount(700, "jpy");
  assert.match(jpy, /700/, `expected 700 jpy to stay 700, got ${jpy}`);

  // A bad currency code must not throw inside a render.
  assert.match(formatAmount(99, "zzz-not-a-currency"), /99|0\.99/);
});

test("periods read the way a price line needs them to", () => {
  assert.equal(describePlan(plan(99, "month")).period, "/month");
  assert.equal(describePlan(plan(799, "year")).period, "/year");
  assert.equal(describePlan(plan(299, "month", { intervalCount: 3 })).period, "/3 months");
  assert.equal(describePlan(plan(1999, "once")).period, " one-off");
});

test("plans are ordered by commitment, not by whatever the dashboard returns", () => {
  const ordered = orderPlans([plan(1999, "once"), plan(799, "year"), plan(99, "month")]);
  assert.deepEqual(
    ordered.map((entry) => entry.interval),
    ["month", "year", "once"],
  );

  // Two plans on the same interval fall back to cheapest first.
  const sameInterval = orderPlans([plan(1299, "year"), plan(799, "year")]);
  assert.deepEqual(
    sameInterval.map((entry) => entry.unitAmountCents),
    [799, 1299],
  );
});

test("plans that cannot be shown honestly are dropped, not rendered as NaN", () => {
  const kept = usablePlans([
    plan(99, "month"),
    { unitAmountCents: Number.NaN, currency: "cad", interval: "year", intervalCount: null },
    { unitAmountCents: 799, currency: "", interval: "year", intervalCount: null },
    { currency: "cad", interval: "year", intervalCount: null },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].unitAmountCents, 99);

  // And the whole thing survives a provider that returns nothing.
  assert.deepEqual(usablePlans([]), []);
});

test("a formatted offer never contains NaN or undefined", () => {
  for (const interval of ["month", "year", "once"]) {
    const offer = describePlan(plan(99, interval));
    assert.doesNotMatch(`${offer.amount}${offer.period}`, /NaN|undefined/);
  }
});
