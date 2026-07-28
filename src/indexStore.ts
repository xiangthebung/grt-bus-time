/**
 * IndexedDB persistence for the parsed GTFS index.
 *
 * Structured clone keeps the typed arrays and Maps intact, so reading the
 * schedule back is a single fast get with no re-parsing. The service worker
 * owns downloading and writing; the popup only reads.
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { GTFS_SCHEMA_VERSION, STATIC_FEED_TTL_MS, type GtfsIndex } from "./types";
import { serviceDateKey } from "./time";

const DB_NAME = "grt-next-bus";
const DB_VERSION = 2;
const STORE = "schedule";
const RECORD_KEY = "current";

interface ScheduleDb extends DBSchema {
  schedule: {
    key: string;
    value: GtfsIndex;
  };
}

let databasePromise: Promise<IDBPDatabase<ScheduleDb>> | undefined;

function getDatabase(): Promise<IDBPDatabase<ScheduleDb>> {
  databasePromise ??= openDB<ScheduleDb>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      // Drop anything from an older layout: the index is a rebuildable cache.
      for (const name of [...database.objectStoreNames]) {
        database.deleteObjectStore(name);
      }
      database.createObjectStore(STORE);
    },
  });
  return databasePromise;
}

export async function readIndex(): Promise<GtfsIndex | undefined> {
  try {
    const database = await getDatabase();
    const index = await database.get(STORE, RECORD_KEY);
    return index?.schemaVersion === GTFS_SCHEMA_VERSION ? index : undefined;
  } catch (error) {
    console.warn("Could not read the cached GRT schedule", error);
    return undefined;
  }
}

export async function writeIndex(index: GtfsIndex): Promise<void> {
  const database = await getDatabase();
  await database.put(STORE, index, RECORD_KEY);
}

export async function clearIndex(): Promise<void> {
  try {
    const database = await getDatabase();
    await database.delete(STORE, RECORD_KEY);
  } catch (error) {
    console.warn("Could not clear the cached GRT schedule", error);
  }
}

/** True when the cached feed still covers today and is inside its TTL. */
export function isIndexFresh(index: GtfsIndex, now = Date.now()): boolean {
  return coversToday(index, now) && now - index.fetchedAt < STATIC_FEED_TTL_MS;
}

export function coversToday(index: GtfsIndex, now = Date.now()): boolean {
  return index.servicesByDate.has(serviceDateKey(now));
}
