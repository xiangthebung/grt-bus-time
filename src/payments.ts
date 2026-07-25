import ExtPay from "extpay";
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
