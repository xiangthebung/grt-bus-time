import ExtPay from "extpay";
import { usablePlans, type Plan } from "./plans";
import { IS_PRO_BUILD } from "./pro";

declare const __EXTPAY_EXTENSION_ID__: string;

export const EXTENSION_PAY_ID = __EXTPAY_EXTENSION_ID__;
export const PAYMENTS_CONFIGURED = IS_PRO_BUILD && EXTENSION_PAY_ID.length > 0;

type ExtPayClient = ReturnType<typeof ExtPay>;

function createClient(): ExtPayClient | undefined {
  if (!PAYMENTS_CONFIGURED) return undefined;
  return ExtPay(EXTENSION_PAY_ID);
}

let backgroundStarted = false;
const PAYMENT_ACCESS_KEY = "paymentAccess";
const PAYMENT_GRACE_MS = 24 * 60 * 60 * 1000;

interface CachedPaymentAccess {
  paid: boolean;
  checkedAt: number;
}

export function startPaymentBackground(): void {
  if (backgroundStarted) return;
  const client = createClient();
  if (!client) return;
  client.startBackground();
  backgroundStarted = true;
}

export async function getPaymentUser(): Promise<Awaited<ReturnType<ExtPayClient["getUser"]>> | undefined> {
  return createClient()?.getUser();
}

/**
 * Keeps a bounded last-known entitlement through a temporary provider failure.
 * A service-worker restart must not turn a paid rider's badge off merely because
 * ExtensionPay is having a short outage, but the grace period is finite so this
 * is not an indefinite entitlement cache.
 */
export async function getPaymentAccess(): Promise<{
  paid: boolean;
  unavailable: boolean;
}> {
  if (!PAYMENTS_CONFIGURED) return { paid: false, unavailable: false };
  try {
    const user = await getPaymentUser();
    const paid = Boolean(user?.paid);
    await chrome.storage.local.set({
      [PAYMENT_ACCESS_KEY]: { paid, checkedAt: Date.now() } satisfies CachedPaymentAccess,
    });
    return { paid, unavailable: false };
  } catch (error) {
    console.warn("Could not check ExtensionPay access", error);
    const stored = await chrome.storage.local.get(PAYMENT_ACCESS_KEY);
    const cached = stored[PAYMENT_ACCESS_KEY] as Partial<CachedPaymentAccess> | undefined;
    const usable =
      cached?.paid === true &&
      typeof cached.checkedAt === "number" &&
      Date.now() - cached.checkedAt <= PAYMENT_GRACE_MS;
    return { paid: usable, unavailable: true };
  }
}

/**
 * The plans as configured in ExtensionPay, which is the same source the checkout
 * page prices from. Returns an empty list rather than throwing when payments are
 * not configured, so callers can treat "no plans" as one situation.
 */
export async function getPaymentPlans(): Promise<Plan[]> {
  const plans = await createClient()?.getPlans();
  return usablePlans(plans ?? []);
}

export async function openPaymentPage(): Promise<void> {
  const client = createClient();
  if (!client) throw new Error("ExtensionPay is not configured for this build.");
  await client.openPaymentPage();
}

export async function openLoginPage(): Promise<void> {
  const client = createClient();
  if (!client) throw new Error("ExtensionPay is not configured for this build.");
  await client.openLoginPage();
}
