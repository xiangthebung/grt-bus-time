/**
 * Offscreen document: the service worker's only way to read a position.
 *
 * `navigator.geolocation` is a DOM API, so it does not exist inside a manifest
 * V3 service worker. Chrome's answer is an offscreen document — a hidden page
 * bundled with the extension that the worker can message. Without it the badge
 * could only ever use whatever position the popup happened to store last, which
 * is why it used to keep pointing at the stop the rider had already left.
 *
 * This document is created on demand, answers one question, and is closed again.
 */

import { GEOLOCATION_TARGET, type GeolocationReply } from "./messages";

const TIMEOUT_MS = 12_000;

function readPosition(): Promise<GeolocationReply> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ ok: false, error: "This browser cannot share your location." });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        resolve({
          ok: true,
          latitude,
          longitude,
          ...(typeof accuracy === "number" && Number.isFinite(accuracy)
            ? { accuracyMeters: accuracy }
            : {}),
        });
      },
      // A GeolocationPositionError does not survive structured cloning, so the
      // parts the worker acts on are copied out by hand.
      (error) => resolve({ ok: false, code: error.code, error: error.message }),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: TIMEOUT_MS },
    );
  });
}

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (value: GeolocationReply) => void) => {
    const request = message as { target?: string } | null;
    if (request?.target !== GEOLOCATION_TARGET) return undefined;
    void readPosition().then(sendResponse);
    // Keeps the message channel open for the asynchronous reply.
    return true;
  },
);
