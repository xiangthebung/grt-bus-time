/**
 * Typed request/response contract between the popup and the service worker.
 *
 * The worker owns every network call: it downloads and indexes the schedule
 * (so a 12 MB parse never blocks the popup) and it de-duplicates realtime
 * polling across popup opens.
 */

import type { RealtimeSnapshot } from "./types";

export type ExtensionRequest =
  | { type: "ENSURE_SCHEDULE"; force?: boolean }
  | { type: "GET_REALTIME"; force?: boolean }
  /** Recompute the toolbar badge from data already in hand. No network. */
  | { type: "REFRESH_BADGE" }
  | { type: "STOPS_CHANGED" }
  | { type: "LOCATION_CHANGED" }
  | { type: "PAYMENT_CHANGED" }
  | { type: "REFRESH_BADGE" }
  | { type: "NOTIFICATION_STATUS" }
  | { type: "SEND_TEST_NOTIFICATION" };

export interface ScheduleReadyPayload {
  fetchedAt: number;
  routeCount: number;
  stopCount: number;
  /** True when the cached copy was reused instead of downloaded. */
  fromCache: boolean;
}

export interface NotificationStatusPayload {
  /** The optional `notifications` permission is granted to the extension. */
  permissionGranted: boolean;
  /** Chrome itself is allowed to show notifications. */
  systemEnabled: boolean;
}

export type ResponseFor<T extends ExtensionRequest> = T extends {
  type: "ENSURE_SCHEDULE";
}
  ? ScheduleReadyPayload
  : T extends { type: "GET_REALTIME" }
    ? { snapshot: RealtimeSnapshot }
    : T extends { type: "NOTIFICATION_STATUS" }
      ? NotificationStatusPayload
      : T extends { type: "SEND_TEST_NOTIFICATION" }
        ? NotificationStatusPayload
        : Record<string, never>;

export type Envelope<T> = ({ ok: true } & T) | { ok: false; error: string };

/** Sends a request to the service worker and unwraps the response. */
export async function sendRequest<T extends ExtensionRequest>(
  request: T,
): Promise<ResponseFor<T>> {
  const response = await new Promise<Envelope<ResponseFor<T>> | undefined>(
    (resolve, reject) => {
      chrome.runtime.sendMessage(request, (value) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message ?? "Background worker unavailable."));
        else resolve(value as Envelope<ResponseFor<T>> | undefined);
      });
    },
  );
  if (!response) throw new Error("The background worker did not respond.");
  if (!response.ok) throw new Error(response.error);
  return response;
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
