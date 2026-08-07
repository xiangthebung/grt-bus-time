export const EXTENSION_PAY_ID = "";
export const PAYMENTS_CONFIGURED = false;

export function startPaymentBackground(): void {
  // Payments are intentionally excluded from the Free build.
}

export async function getPaymentUser(): Promise<undefined> {
  return undefined;
}

export async function getPaymentAccess(): Promise<{ paid: false; unavailable: false }> {
  return { paid: false, unavailable: false };
}

export async function getPaymentPlans(): Promise<[]> {
  return [];
}

export async function openPaymentPage(): Promise<void> {
  throw new Error("Pro payments are not available in the Free build.");
}

export async function openLoginPage(): Promise<void> {
  throw new Error("Pro payments are not available in the Free build.");
}
