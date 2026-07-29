/**
 * Position lookups for the service worker.
 *
 * The worker has no `navigator`, so it borrows one from a hidden offscreen
 * document (see `offscreen.ts`). Everything here is best effort: if the offscreen
 * API is missing, the rider declined, or the lookup times out, callers fall back
 * to the last position the popup stored.
 */

import {
  getLastLocation,
  hasLocationConsent,
  LOCATION_STALE_MS,
  saveLastLocation,
  setLocationConsent,
  type StoredLocation,
} from "./geo";
import { GEOLOCATION_TARGET, type GeolocationAsk, type GeolocationReply } from "./messages";

const OFFSCREEN_PATH = "offscreen.html";
/** Floor between background lookups, so a busy tick never spins up the GPS. */
const ATTEMPT_COOLDOWN_MS = 60_000;
const REPLY_TIMEOUT_MS = 15_000;
/**
 * When the last attempt happened, in `chrome.storage.session`.
 *
 * A module variable would not do: the worker restarts between ticks, so the
 * cooldown would reset every time and a location that fails rather than being
 * denied — no signal available, say — would be retried on every single tick,
 * each retry opening a document and waiting out the timeout.
 */
const ATTEMPT_KEY = "locationAttemptAt";

let creating: Promise<void> | undefined;

async function lastAttemptAt(): Promise<number> {
  const stored = await chrome.storage.session.get(ATTEMPT_KEY);
  const value = stored[ATTEMPT_KEY];
  return typeof value === "number" ? value : 0;
}

/**
 * `getContexts` is how the document is tracked, so without it there is no safe
 * way to know whether one is already open — and a second `createDocument` throws.
 */
function offscreenSupported(): boolean {
  return (
    typeof chrome.offscreen?.createDocument === "function" &&
    typeof chrome.runtime.getContexts === "function"
  );
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  if (creating) {
    await creating;
    return;
  }
  creating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        // GEOLOCATION was added after the API shipped; DOM_SCRAPING is the
        // documented fallback for builds that predate it.
        reasons: [
          (chrome.offscreen.Reason.GEOLOCATION ??
            chrome.offscreen.Reason.DOM_SCRAPING) as chrome.offscreen.Reason,
        ],
        justification:
          "Read the device location so the toolbar badge can count down the closest saved stop.",
      });
    } finally {
      creating = undefined;
    }
  })();
  await creating;
}

async function closeOffscreenDocument(): Promise<void> {
  try {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
  } catch {
    // Already gone, or torn down with the worker. Nothing to recover.
  }
}

function askOffscreen(): Promise<GeolocationReply> {
  const ask: GeolocationAsk = { target: GEOLOCATION_TARGET };
  return new Promise<GeolocationReply>((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, error: "Location lookup timed out." }),
      REPLY_TIMEOUT_MS,
    );
    chrome.runtime.sendMessage(ask, (reply: GeolocationReply | undefined) => {
      clearTimeout(timer);
      const failure = chrome.runtime.lastError;
      resolve(
        reply ?? {
          ok: false,
          error: failure?.message ?? "The location helper did not respond.",
        },
      );
    });
  });
}

/** One attempt at a fresh position through the offscreen document. */
async function readFreshLocation(): Promise<StoredLocation | undefined> {
  if (!offscreenSupported()) return undefined;
  try {
    await ensureOffscreenDocument();
    const reply = await askOffscreen();
    if (!reply.ok) {
      // Code 1 is PERMISSION_DENIED: stop asking until the rider opts back in.
      if (reply.code === 1) await setLocationConsent(false);
      return undefined;
    }
    await saveLastLocation(reply.latitude, reply.longitude, reply.accuracyMeters);
    return {
      latitude: reply.latitude,
      longitude: reply.longitude,
      updatedAt: Date.now(),
      ...(reply.accuracyMeters !== undefined
        ? { accuracyMeters: reply.accuracyMeters }
        : {}),
    };
  } catch (error) {
    // A missing permission, an unsupported Chrome, or two lookups colliding.
    // The cooldown keeps retries cheap, so this attempt just gives up.
    console.warn("Background location lookup failed", error);
    return undefined;
  } finally {
    await closeOffscreenDocument();
  }
}

/**
 * The position to reason about right now.
 *
 * A stored position that is still fresh is used as is. A stale one is refreshed
 * first — that is what keeps the badge pointed at the stop the rider is standing
 * at rather than the one they were at when they last opened the popup.
 */
export async function currentLocation(): Promise<StoredLocation | undefined> {
  if (!(await hasLocationConsent())) return undefined;
  const stored = await getLastLocation();
  if (stored && Date.now() - stored.updatedAt < LOCATION_STALE_MS) return stored;
  if (Date.now() - (await lastAttemptAt()) < ATTEMPT_COOLDOWN_MS) return stored;
  // Recorded before the attempt, so a failed or slow lookup still starts the
  // cooldown instead of being retried by the next tick.
  await chrome.storage.session.set({ [ATTEMPT_KEY]: Date.now() });
  return (await readFreshLocation()) ?? stored;
}
