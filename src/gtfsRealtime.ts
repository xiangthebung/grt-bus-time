import { transit_realtime } from "gtfs-realtime-bindings";
import type {
  RealtimeEntity,
  RealtimeStopTimeUpdate,
  RealtimeTripDescriptor,
  RealtimeTripUpdate,
} from "./types";

export const REALTIME_TRIP_UPDATES_URL =
  "https://webapps.regionofwaterloo.ca/api/grt-routes/api/tripupdates/1";

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    value &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof value.toNumber === "function"
  ) {
    const numberValue = value.toNumber();
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  return undefined;
}

function normalizeDescriptor(
  descriptor: transit_realtime.ITripDescriptor | null | undefined,
): RealtimeTripDescriptor | undefined {
  if (!descriptor) return undefined;
  return {
    ...(descriptor.tripId ? { tripId: descriptor.tripId } : {}),
    ...(descriptor.routeId ? { routeId: descriptor.routeId } : {}),
    ...(descriptor.directionId !== undefined && descriptor.directionId !== null
      ? { directionId: descriptor.directionId }
      : {}),
    ...(descriptor.scheduleRelationship !== undefined &&
    descriptor.scheduleRelationship !== null
      ? { scheduleRelationship: descriptor.scheduleRelationship }
      : {}),
  };
}

function normalizeTripUpdate(
  update: transit_realtime.ITripUpdate | null | undefined,
): RealtimeTripUpdate | undefined {
  if (!update) return undefined;
  const stopTimeUpdates: RealtimeStopTimeUpdate[] = (update.stopTimeUpdate ?? []).map(
    (stopTimeUpdate) => ({
      ...(stopTimeUpdate.stopSequence !== undefined && stopTimeUpdate.stopSequence !== null
        ? { stopSequence: stopTimeUpdate.stopSequence }
        : {}),
      ...(stopTimeUpdate.stopId ? { stopId: stopTimeUpdate.stopId } : {}),
      ...(stopTimeUpdate.arrival?.time !== undefined
        ? { arrivalTime: toNumber(stopTimeUpdate.arrival.time) }
        : {}),
      ...(stopTimeUpdate.departure?.time !== undefined
        ? { departureTime: toNumber(stopTimeUpdate.departure.time) }
        : {}),
      ...(stopTimeUpdate.scheduleRelationship !== undefined &&
      stopTimeUpdate.scheduleRelationship !== null
        ? { scheduleRelationship: stopTimeUpdate.scheduleRelationship }
        : {}),
    }),
  );
  return {
    ...(normalizeDescriptor(update.trip)
      ? { trip: normalizeDescriptor(update.trip) }
      : {}),
    stopTimeUpdates,
  };
}

export function decodeRealtimeFeed(bytes: Uint8Array): RealtimeEntity[] {
  const feed = transit_realtime.FeedMessage.decode(bytes);
  return (feed.entity ?? []).flatMap((entity) => {
    if (!entity.id) return [];
    const tripUpdate = normalizeTripUpdate(entity.tripUpdate);
    return [{ id: entity.id, ...(tripUpdate ? { tripUpdate } : {}) }];
  });
}

export async function fetchRealtime(): Promise<RealtimeEntity[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(REALTIME_TRIP_UPDATES_URL, {
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The GRT realtime feed request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    throw new Error(`GRT realtime feed returned HTTP ${response.status}.`);
  }
  return decodeRealtimeFeed(new Uint8Array(await response.arrayBuffer()));
}
