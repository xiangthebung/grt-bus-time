/**
 * Turning ExtensionPay plans into something a rider can read.
 *
 * The popup used to state "$0.99/month or $7.99/year" as markup. That is a
 * promise made in a file nobody edits when a price changes in a dashboard, and a
 * price shown in an extension that does not match the price on the checkout page
 * is not a cosmetic bug — it is the wrong number in front of someone about to
 * pay. So the popup asks ExtensionPay what the plans actually are, and this
 * module is the pure part of that: no DOM, no network, so it can be reasoned
 * about and tested directly.
 *
 * Amounts arrive from Stripe in the currency's smallest unit, and how many of
 * those there are per major unit differs by currency: 100 cents to a dollar, but
 * a yen has no subunit at all. Rather than carry Stripe's list of zero-decimal
 * currencies, the divisor is read back out of `Intl` for the currency in hand,
 * which is the same source that will format it a line later and therefore cannot
 * disagree with itself.
 */

/**
 * The parts of an ExtensionPay plan this popup uses.
 *
 * Deliberately narrower than `extpay`'s own `Plan`. Its declaration types
 * `nickname` as the boxed `String`, which will not assign to `string`, and a
 * structural subset sidesteps that without a cast or a patch — nothing here needs
 * the nickname anyway.
 */
export interface Plan {
  unitAmountCents: number;
  currency: string;
  interval: "month" | "year" | "once";
  intervalCount: number | null;
}

export interface PlanOffer {
  /** The price, formatted for the visitor's locale, e.g. `CA$0.99`. */
  amount: string;
  /** What the price buys, e.g. `/month`, `/3 months`, ` one-off`. */
  period: string;
  interval: Plan["interval"];
}

/** How many minor units make one major unit of this currency. */
function minorUnitsPer(currency: string): number {
  try {
    const digits = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
    return 10 ** (digits ?? 2);
  } catch {
    // An unknown or malformed currency code. Two decimals is the common case.
    return 100;
  }
}

export function formatAmount(unitAmountCents: number, currency: string): string {
  const value = unitAmountCents / minorUnitsPer(currency);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    // Better a bare number with its code than a thrown error inside a render.
    return `${value} ${currency.toUpperCase()}`;
  }
}

const PERIOD_NAME: Record<Plan["interval"], string> = {
  month: "month",
  year: "year",
  once: "one-off",
};

export function describePlan(plan: Plan): PlanOffer {
  const count = plan.intervalCount ?? 1;
  const name = PERIOD_NAME[plan.interval] ?? plan.interval;

  let period: string;
  if (plan.interval === "once") {
    period = " one-off";
  } else if (count > 1) {
    period = `/${count} ${name}s`;
  } else {
    period = `/${name}`;
  }

  return { amount: formatAmount(plan.unitAmountCents, plan.currency), period, interval: plan.interval };
}

const INTERVAL_ORDER: Plan["interval"][] = ["month", "year", "once"];

/**
 * Monthly first, then yearly, then anything one-off.
 *
 * ExtensionPay returns plans in dashboard order, which is whatever order they
 * were created in. Cheapest-commitment-first is the order the sentence "$X a
 * month or $Y a year" wants, and the sentence should not change shape because a
 * plan was re-saved.
 */
export function orderPlans(plans: readonly Plan[]): Plan[] {
  return [...plans].sort((a, b) => {
    const byInterval =
      INTERVAL_ORDER.indexOf(a.interval) - INTERVAL_ORDER.indexOf(b.interval);
    return byInterval !== 0 ? byInterval : a.unitAmountCents - b.unitAmountCents;
  });
}

/**
 * Drops plans that cannot be shown honestly.
 *
 * A plan with a missing or nonsensical amount is worse than one fewer option on
 * the card: it would render as `CA$NaN` next to a button that takes money.
 */
export function usablePlans(plans: readonly Plan[]): Plan[] {
  return orderPlans(
    plans.filter(
      (plan) =>
        typeof plan?.unitAmountCents === "number" &&
        Number.isFinite(plan.unitAmountCents) &&
        plan.unitAmountCents >= 0 &&
        typeof plan.currency === "string" &&
        plan.currency.length > 0,
    ),
  );
}
