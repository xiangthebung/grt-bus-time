/**
 * Builds the Chrome Web Store artifacts for both channels from the built
 * extensions.
 *
 *   npm run build:all && node scripts/store-shots.mjs
 *   npm install --no-save playwright   (once, if it is not already there)
 *
 * Writes `store-assets/`: four 1280x800 screenshots of the Pro channel, one of
 * the Free channel, and the 440x280 promotional tile.
 *
 * Five decisions worth knowing about.
 *
 * It loads `dist/` and `dist-free/`, never `src/`. Those two directories are what
 * `npm run zip:all` packages and what a reviewer installs, so they are what the
 * pictures have to come from. A screenshot taken from a dev server is a
 * screenshot of something nobody can download.
 *
 * The transit feeds are answered by `context.route`, not by the internet. The
 * real extension downloads a region-wide GTFS zip and three GTFS-realtime
 * protobufs; depending on those for a picture means the picture changes every
 * time GRT's evening rush does, and breaks entirely when the feed is down. So
 * this file *generates* a small GTFS zip and three real protobuf feeds, and
 * fulfils the extension's own requests with them. Playwright's routing reaches
 * the extension service worker, which is where those fetches happen — so the
 * whole shipped pipeline runs for real: download, unzip, CSV parse into typed
 * arrays, IndexedDB write, realtime decode, departure board. Nothing about the
 * rendering path is stubbed. Only the bytes on the wire are ours.
 *
 * Everything in the timetable is invented, and it is invented to agree with
 * itself. Every scheduled time is derived from one anchor (`NOW`, the top of the
 * current minute); every prediction is that time plus the delay the card claims;
 * every "N stops away" is the difference between the vehicle's reported
 * `stop_sequence` and the sequence of the stop being watched. The clock label
 * beside a countdown is formatted from the same millisecond value the countdown
 * counts down to, by the extension's own `format.ts`. There is no way for them to
 * disagree, because there is only one number.
 *
 * The popup's clock is pinned with `page.clock.setFixedTime(NOW)`. Without it a
 * "2 min" countdown becomes "1 min" partway through a run and the set of
 * screenshots stops agreeing with itself. `NOW` is the top of the real current
 * minute rather than an invented hour, so "Updated just now" — which the service
 * worker timestamps with its own unpinned clock — stays true.
 *
 * The composition is done in the browser rather than with an image library. The
 * page being screenshotted is already a layout engine; asking it to put one PNG
 * on a background is less code than a dependency, and it means the caption
 * typography is set in CSS instead of measured by hand. Every source is captured
 * at exactly the size it is placed at. Where a picture needs to be bigger than
 * the popup's 420px, the popup is re-laid-out with `zoom` and rendered at that
 * size, because enlarging a PNG only produces a soft PNG.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { chromium } from "playwright";

const { transit_realtime: rt } = GtfsRealtimeBindings;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "store-assets");

/* ------------------------------------------------------------------ *
 * Store sizes
 * ------------------------------------------------------------------ */

const WIDTH = 1280;
const HEIGHT = 800;
/** Caption band on the frames that centre a single enlarged element. */
const BAND = 132;
const STAGE = HEIGHT - BAND;
/** The popup's own width, from `popup.css`. Never scaled. */
const POPUP_WIDTH = 420;
/**
 * Room the split layout leaves for the popup, allowing for its shadow.
 *
 * Anything taller gets cropped by the frame, which is why each shot is seeded
 * with as many saved stops as it has room for rather than always three: the
 * settings panel alone is worth two cards' worth of height.
 */
const POPUP_MAX_HEIGHT = 700;

const AGENCY_TIME_ZONE = "America/Toronto";
const GTFS_HOST = "https://webapps.regionofwaterloo.ca";
const STATIC_FEED_PATH = "/api/grt-routes/api/staticfeeds/1";

/**
 * One anchor for the whole run: the top of the current minute.
 *
 * Minute-aligned so every offset below lands on a whole minute, and taken from
 * the real clock so the service worker's "Updated just now" is not a lie.
 */
const NOW = Math.floor(Date.now() / 60_000) * 60_000;

/* ------------------------------------------------------------------ *
 * Agency-local service days
 *
 * Mirrors `src/time.ts`. GTFS times are seconds after midnight of a service day
 * in the agency's timezone and may exceed 24 hours, so the fixture has to know
 * where that midnight is — including for a run that happens to straddle it.
 * ------------------------------------------------------------------ */

const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: AGENCY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function serviceDayAt(timestamp) {
  const values = {};
  for (const part of partsFormatter.formatToParts(new Date(timestamp))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const msIntoDay =
    (values.hour * 3600 + values.minute * 60 + values.second) * 1000 +
    (((timestamp % 1000) + 1000) % 1000);
  return {
    dateKey:
      `${values.year}` +
      `${String(values.month).padStart(2, "0")}` +
      `${String(values.day).padStart(2, "0")}`,
    midnightMs: timestamp - msIntoDay,
  };
}

const TODAY = serviceDayAt(NOW);

/** Seconds after today's midnight for an instant. May exceed 86400. */
const secondsAfterMidnight = (timestamp) => Math.round((timestamp - TODAY.midnightMs) / 1000);

function gtfsTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}`;
}

/** `YYYYMMDD` keys from yesterday to a fortnight out, DST included. */
function serviceDateKeys() {
  const keys = [];
  for (let day = -1; day <= 13; day += 1) {
    // Noon rather than midnight, so a spring-forward day still lands on itself.
    keys.push(serviceDayAt(TODAY.midnightMs + day * 86_400_000 + 12 * 3_600_000).dateKey);
  }
  return [...new Set(keys)];
}

/* ------------------------------------------------------------------ *
 * The invented network
 *
 * Real Waterloo Region place names, because a transit extension photographed
 * against "Stop A / Stop B" tells a buyer nothing. Everything numeric — stop
 * codes, coordinates, which route calls where, and every single time — is made
 * up for these pictures and is stated as such in STORE_LISTING.md.
 * ------------------------------------------------------------------ */

/** id, code, name, lat, lon. */
const STOPS = [
  ["1122", "1122", "Queen St / Charles St", 43.4498, -80.4931],
  ["1123", "1123", "Charles St Terminal", 43.4508, -80.4919],
  ["1310", "1310", "Ottawa St / Mill St", 43.4322, -80.478],
  ["1360", "1360", "The Boardwalk", 43.4501, -80.5848],
  ["1380", "1380", "Fischer-Hallman / Erb", 43.4622, -80.5719],
  ["1400", "1400", "Fischer-Hallman / Highland", 43.445, -80.5411],
  ["1420", "1420", "Fischer-Hallman / Ottawa", 43.4288, -80.525],
  ["1460", "1460", "Fischer-Hallman / Victoria", 43.436, -80.533],
  ["1490", "1490", "Fischer-Hallman / Activa", 43.414, -80.498],
  ["1520", "1520", "Fischer-Hallman / Bleams", 43.4085, -80.4885],
  ["2033", "2033", "King St / University Ave", 43.4712, -80.5238],
  ["2087", "2087", "University Ave / Phillip St", 43.4762, -80.539],
  ["2140", "2140", "Conestoga Mall Station", 43.4986, -80.5265],
  ["3460", "3460", "Conestoga Station", 43.499, -80.527],
  ["3480", "3480", "Grand River Hospital Station", 43.4595, -80.506],
  ["3500", "3500", "Central Station", 43.453, -80.499],
  ["3503", "3503", "Queen Station", 43.4495, -80.4925],
  ["3506", "3506", "Kitchener Market Station", 43.447, -80.4835],
  ["3509", "3509", "Borden Station", 43.438, -80.464],
  ["3512", "3512", "Fairway Station", 43.4243, -80.439],
];

/**
 * The four routes the screenshots actually show.
 *
 * `dwellSec` is the gap between consecutive stops on a trip; it is what makes a
 * vehicle two stops back read as roughly six minutes out rather than an hour.
 */
const ROUTES = [
  {
    id: "7",
    shortName: "7",
    longName: "Mainline",
    type: 3,
    headsign: "Conestoga Mall",
    dwellSec: 180,
    stops: ["3512", "1310", "1122", "1123", "2033", "2087", "2140"],
  },
  {
    id: "201",
    shortName: "201",
    longName: "iXpress Fischer-Hallman",
    type: 3,
    headsign: "The Boardwalk",
    dwellSec: 240,
    stops: ["1520", "1490", "1420", "1460", "1400", "1380", "1360"],
  },
  {
    id: "301",
    shortName: "301",
    longName: "ION",
    type: 0,
    headsign: "Conestoga",
    dwellSec: 120,
    stops: ["3512", "3509", "3506", "3503", "3500", "3480", "3460"],
  },
];

/**
 * The three cards, and every number on them.
 *
 * `minutes` is the countdown the card will show. `delayMin` is how late the bus
 * is, so the scheduled time is `minutes - delayMin` and the card can say both
 * without the two contradicting each other. `stopsAway` places the vehicle that
 * many stops back along the same trip; omit it where the vehicle feed has no
 * position, which is the honest state for a bus at the start of its run.
 */
const CARDS = [
  {
    stopId: "1123",
    routeId: "7",
    minutes: 2,
    delayMin: 1,
    stopsAway: 1,
    follow: [12, 22],
    alertLeadMinutes: 5,
  },
  {
    stopId: "3512",
    routeId: "301",
    minutes: 7,
    delayMin: 3,
    follow: [15, 23],
  },
  {
    stopId: "1420",
    routeId: "201",
    minutes: 13,
    delayMin: -1,
    stopsAway: 2,
    follow: [28, 43],
  },
];

/** A rider standing at Charles St Terminal. Also invented. */
const RIDER = { latitude: 43.4512, longitude: -80.4925, accuracy: 22 };

/**
 * A detour on route 7, so it reaches the Charles St Terminal card.
 *
 * The active period is bounded because the copy names an end — "until Friday
 * evening" — and a fixture whose text and whose timestamps disagree is a trap for
 * whoever reads this next.
 *
 * It used to be bounded for a different and worse reason: an alert with a `start`
 * and no `end`, which is how an agency says "until further notice", was being
 * dropped altogether. protobuf decodes an absent `end` to 0, `gtfsRealtime.ts`
 * recorded `endMs: 0`, and `alertsForStop` read that as an alert that finished in
 * 1970. That is fixed at the decoder now (`numberIfPresent`), with tests, so an
 * open-ended alert would photograph correctly here too.
 */
const SERVICE_ALERT = {
  id: "grt-detour-king-water",
  routeId: "7",
  title: "Detour: King St closed between Water and Francis",
  body:
    "Route 7 is detouring via Charles St until Friday evening. Stops on King between " +
    "Water and Francis are not being served.",
  startMs: NOW - 3 * 3_600_000,
  endMs: NOW + 2 * 86_400_000,
};

/* ------------------------------------------------------------------ *
 * Filler network
 *
 * The settings panel reports how many stops the cached timetable covers. A
 * fixture with twenty-two of them would put "22 stops" on a store screenshot and
 * make the extension look broken. These routes exist only to make that count
 * plausible: they run once at dawn, no saved stop is on them, and nothing in any
 * screenshot shows them.
 * ------------------------------------------------------------------ */

const STREETS = [
  "King St", "Queen St", "Weber St", "Charles St", "Victoria St", "Ottawa St",
  "Highland Rd", "Westmount Rd", "Erb St", "University Ave", "Columbia St",
  "Bridgeport Rd", "Lancaster St", "Frederick St", "Courtland Ave", "Strasburg Rd",
  "Homer Watson Blvd", "Block Line Rd", "Bleams Rd", "Huron Rd", "Manitou Dr",
  "Wilson Ave", "River Rd", "Lackner Blvd", "Fairway Rd", "Hespeler Rd",
  "Franklin Blvd", "Coronation Blvd", "Dundas St", "Main St", "Water St",
  "Park St", "Union St", "Margaret Ave", "Northfield Dr", "Regina St",
  "Albert St", "Seagram Dr", "Phillip St", "Lester St", "Hazel St",
  "Bearinger Rd", "Trussler Rd", "Ira Needles Blvd", "Doon Village Rd",
];

const FILLER_ROUTE_NUMBERS = [
  1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23, 25,
  27, 29, 30, 31, 33, 34, 51, 52, 53, 54, 55, 56, 57, 58, 60, 61, 62, 63, 64,
  67, 72, 73, 75, 76, 77, 78, 91, 92, 110, 111, 116, 200, 202, 203, 204, 205,
];
const FILLER_STOPS_PER_ROUTE = 43;

function buildFiller() {
  const stops = [];
  const routes = [];
  let code = 4000;
  FILLER_ROUTE_NUMBERS.forEach((number, routeIndex) => {
    const stopIds = [];
    for (let position = 0; position < FILLER_STOPS_PER_ROUTE; position += 1) {
      const street = STREETS[(routeIndex * 7 + position) % STREETS.length];
      const cross = STREETS[(routeIndex * 3 + position * 5 + 11) % STREETS.length];
      const id = String(code);
      code += 1;
      stops.push([id, id, `${street} / ${cross === street ? "Weber St" : cross}`,
        43.36 + (position * 0.0055) + routeIndex * 0.0004,
        -80.62 + (routeIndex * 0.0045) + position * 0.0006]);
      stopIds.push(id);
    }
    routes.push({
      id: String(number),
      shortName: String(number),
      longName: `${STREETS[routeIndex % STREETS.length]} — ${
        STREETS[(routeIndex + 9) % STREETS.length]
      }`,
      type: 3,
      headsign: STREETS[(routeIndex + 9) % STREETS.length],
      dwellSec: 120,
      stops: stopIds,
      // Well before any screenshot's window, so these can never surface.
      firstDepartureSec: 5 * 3600 + routeIndex * 60,
    });
  });
  return { stops, routes };
}

/* ------------------------------------------------------------------ *
 * The GTFS zip
 * ------------------------------------------------------------------ */

const csv = (rows) => `${rows.map((row) => row.join(",")).join("\n")}\n`;
const quote = (value) => (/[",]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/**
 * Assembles the static feed and the trip table the realtime feeds refer to.
 *
 * Every hero trip is positioned by working backwards from the time its watched
 * stop should be scheduled at, so the stop the card names is the stop whose time
 * the card shows.
 */
function buildStaticFeed() {
  const filler = buildFiller();
  const allStops = [...STOPS, ...filler.stops];
  const allRoutes = [...ROUTES, ...filler.routes];
  const routeById = new Map(allRoutes.map((route) => [route.id, route]));
  const SERVICE_ID = "screenshot-service";

  /** Every trip the realtime feeds may talk about. */
  const trips = [];

  for (const card of CARDS) {
    const route = routeById.get(card.routeId);
    const sequenceIndex = route.stops.indexOf(card.stopId);
    if (sequenceIndex < 0) throw new Error(`route ${route.id} does not serve stop ${card.stopId}`);

    const runs = [card.minutes - card.delayMin, ...card.follow];
    runs.forEach((offsetMinutes, run) => {
      trips.push({
        id: `${route.id}-${card.stopId}-${run}`,
        route,
        // The watched stop's scheduled time; every other stop is derived from it.
        anchorIndex: sequenceIndex,
        anchorSec: secondsAfterMidnight(NOW + offsetMinutes * 60_000),
      });
    });
  }

  for (const route of filler.routes) {
    for (let run = 0; run < 2; run += 1) {
      trips.push({
        id: `${route.id}-f${run}`,
        route,
        anchorIndex: 0,
        anchorSec: route.firstDepartureSec + run * 1800,
      });
    }
  }

  const stopTimeRows = [[
    "trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence", "pickup_type",
  ]];
  for (const trip of trips) {
    trip.route.stops.forEach((stopId, index) => {
      const seconds = trip.anchorSec + (index - trip.anchorIndex) * trip.route.dwellSec;
      if (seconds < 0) return;
      stopTimeRows.push([
        trip.id,
        gtfsTime(seconds),
        gtfsTime(seconds),
        stopId,
        String(index + 1),
        "0",
      ]);
    });
  }

  const files = {
    "routes.txt": strToU8(
      csv([
        ["route_id", "route_short_name", "route_long_name", "route_type", "route_color", "route_text_color"],
        ...allRoutes.map((route) => [
          route.id,
          route.shortName,
          quote(route.longName),
          String(route.type),
          "",
          "",
        ]),
      ]),
    ),
    "stops.txt": strToU8(
      csv([
        ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon", "location_type"],
        ...allStops.map(([id, code, name, lat, lon]) => [
          id,
          code,
          quote(name),
          lat.toFixed(6),
          lon.toFixed(6),
          "0",
        ]),
      ]),
    ),
    "trips.txt": strToU8(
      csv([
        ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id"],
        ...trips.map((trip) => [
          trip.route.id,
          SERVICE_ID,
          trip.id,
          quote(trip.route.headsign),
          "0",
        ]),
      ]),
    ),
    "stop_times.txt": strToU8(csv(stopTimeRows)),
    "calendar_dates.txt": strToU8(
      csv([
        ["service_id", "date", "exception_type"],
        ...serviceDateKeys().map((dateKey) => [SERVICE_ID, dateKey, "1"]),
      ]),
    ),
  };

  return {
    zip: Buffer.from(zipSync(files, { level: 6 })),
    trips,
    stopCount: allStops.length,
    routeCount: allRoutes.length,
  };
}

/* ------------------------------------------------------------------ *
 * The GTFS-realtime feeds
 *
 * Real protobuf, encoded with the same `gtfs-realtime-bindings` the extension
 * decodes with, so the decode path in `gtfsRealtime.ts` is exercised rather than
 * bypassed.
 * ------------------------------------------------------------------ */

const encode = (message) => Buffer.from(rt.FeedMessage.encode(message).finish());

function header() {
  return {
    gtfsRealtimeVersion: "2.0",
    incrementality: rt.FeedHeader.Incrementality.FULL_DATASET,
    timestamp: Math.floor(NOW / 1000),
  };
}

function buildRealtimeFeeds(trips) {
  const tripsById = new Map(trips.map((trip) => [trip.id, trip]));
  const tripUpdates = [];
  const vehicles = [];

  for (const card of CARDS) {
    // Only the head departure is predicted. The follow-up times stay scheduled,
    // which exercises the popup's mixed live-and-scheduled arrival treatment.
    const trip = tripsById.get(`${card.routeId}-${card.stopId}-0`);
    const route = trip.route;
    const predictedSec = Math.floor((NOW + card.minutes * 60_000) / 1000);
    const watchedSequence = route.stops.indexOf(card.stopId) + 1;

    tripUpdates.push({
      id: `tu-${trip.id}`,
      tripUpdate: {
        trip: {
          tripId: trip.id,
          routeId: route.id,
          startDate: TODAY.dateKey,
          scheduleRelationship: rt.TripDescriptor.ScheduleRelationship.SCHEDULED,
        },
        stopTimeUpdate: route.stops.map((stopId, index) => {
          const time = predictedSec + (index - (watchedSequence - 1)) * route.dwellSec;
          return {
            stopId,
            stopSequence: index + 1,
            arrival: { time },
            departure: { time },
            scheduleRelationship:
              rt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SCHEDULED,
          };
        }),
        timestamp: Math.floor(NOW / 1000) - 20,
      },
    });

    if (card.stopsAway === undefined) continue;
    const vehicleSequence = watchedSequence - card.stopsAway;
    const [, , , lat, lon] = STOPS.find(([id]) => id === route.stops[vehicleSequence - 1]);
    vehicles.push({
      id: `vp-${trip.id}`,
      vehicle: {
        trip: { tripId: trip.id, routeId: route.id, startDate: TODAY.dateKey },
        currentStopSequence: vehicleSequence,
        currentStatus: rt.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO,
        position: { latitude: lat, longitude: lon },
        // Fresh: `departures.ts` ignores a position older than five minutes.
        timestamp: Math.floor(NOW / 1000) - 25,
      },
    });
  }

  return {
    tripUpdates: encode({ header: header(), entity: tripUpdates }),
    vehiclePositions: encode({ header: header(), entity: vehicles }),
    /** A feed with no alerts in it, which is most of the time on most routes. */
    quietAlerts: encode({ header: header(), entity: [] }),
    alerts: encode({
      header: header(),
      entity: [
        {
          id: SERVICE_ALERT.id,
          alert: {
            activePeriod: [
              {
                start: Math.floor(SERVICE_ALERT.startMs / 1000),
                end: Math.floor(SERVICE_ALERT.endMs / 1000),
              },
            ],
            informedEntity: [{ routeId: SERVICE_ALERT.routeId }],
            cause: rt.Alert.Cause.CONSTRUCTION,
            effect: rt.Alert.Effect.DETOUR,
            headerText: { translation: [{ text: SERVICE_ALERT.title, language: "en" }] },
            descriptionText: {
              translation: [{ text: SERVICE_ALERT.body, language: "en" }],
            },
          },
        },
      ],
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Seed data for chrome.storage
 * ------------------------------------------------------------------ */

function savedStopsSeed({ withAlerts = false, cards = CARDS.length } = {}) {
  const routeById = new Map(ROUTES.map((route) => [route.id, route]));
  return CARDS.slice(0, cards).map((card, index) => {
    const [, code, name] = STOPS.find(([id]) => id === card.stopId);
    return {
      id: `fixture-${card.stopId}`,
      stopId: card.stopId,
      stopCode: code,
      stopName: name,
      routeId: card.routeId,
      routeShortName: routeById.get(card.routeId).shortName,
      directionId: "0",
      directionHeadsign: routeById.get(card.routeId).headsign,
      createdAt: NOW - (CARDS.length - index) * 86_400_000,
      position: index,
      ...(withAlerts && card.alertLeadMinutes
        ? { alertsEnabled: true, alertLeadMinutes: card.alertLeadMinutes }
        : {}),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Frame markup
 * ------------------------------------------------------------------ */

/** The extension's own tokens, from `popup.css`. */
const STYLE = `
  * { box-sizing: border-box }
  body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    margin: 0;
    overflow: hidden;
    color: #16262c;
    background: #f2f6f6;
    font: 15px/1.5 Inter, ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .split { display: flex; width: ${WIDTH}px; height: ${HEIGHT}px }
  .copy {
    display: flex;
    flex: 0 0 656px;
    flex-direction: column;
    justify-content: center;
    padding: 64px 48px 64px 72px;
    background:
      radial-gradient(120% 90% at 0% 0%, #e4f0ef 0%, transparent 62%),
      #f2f6f6;
  }
  .eyebrow {
    margin: 0;
    color: #0f6a62;
    font-size: 11.5px;
    font-weight: 800;
    letter-spacing: 0.17em;
    text-transform: uppercase;
  }
  h1 {
    margin: 12px 0 0;
    max-width: 500px;
    font-size: 38px;
    font-weight: 780;
    letter-spacing: -0.032em;
    line-height: 1.12;
    text-wrap: balance;
  }
  .note {
    margin: 14px 0 0;
    max-width: 470px;
    color: #486067;
    font-size: 17px;
    line-height: 1.5;
    text-wrap: pretty;
  }
  ul.points { margin: 26px 0 0; padding: 0; list-style: none }
  ul.points li {
    position: relative;
    margin-top: 11px;
    padding-left: 26px;
    color: #16262c;
    font-size: 15.5px;
    line-height: 1.45;
  }
  ul.points li::before {
    position: absolute;
    top: -1px;
    left: 0;
    color: #0f6a62;
    content: "\\2713";
    font-weight: 800;
  }
  .foot { margin: 30px 0 0; color: #6d8087; font-size: 12.5px; line-height: 1.5 }
  .shot {
    position: relative;
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    background:
      radial-gradient(110% 80% at 70% 6%, #cee3e1 0%, #b3d0ce 52%, #93b9b6 100%);
  }
  .shot img, .centre img {
    display: block;
    border-radius: 16px;
    box-shadow:
      0 0 0 1px rgba(18, 44, 48, 0.1),
      0 34px 70px -26px rgba(11, 33, 37, 0.55);
  }
  .head {
    display: flex;
    height: ${BAND}px;
    flex-direction: column;
    justify-content: center;
    padding: 0 60px;
    background:
      radial-gradient(120% 300% at 100% 0%, #e4f0ef 0%, transparent 58%),
      #f2f6f6;
  }
  .head h1 { max-width: none; font-size: 33px; text-wrap: initial }
  .head .note { max-width: 1000px; margin-top: 8px; font-size: 15.5px }
  .centre {
    position: relative;
    display: flex;
    height: ${STAGE}px;
    align-items: center;
    justify-content: center;
    border-top: 1px solid #c3d7d6;
    background:
      radial-gradient(100% 130% at 50% 0%, #d9eae9 0%, #a9c8c6 100%);
  }
  /* Says out loud that the departures in the picture were made up. The rest of
     the picture is the shipped build doing its real work on them. */
  .stamp {
    position: absolute;
    right: 16px;
    bottom: 14px;
    padding: 5px 10px;
    border-radius: 7px;
    color: rgba(255, 255, 255, 0.94);
    background: rgba(11, 33, 37, 0.6);
    font-size: 10.5px;
    font-weight: 600;
  }
`;

const STAMP = "Sample timetable &middot; interface rendered by the shipped build";

const page = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${body}</body></html>`;

function splitFrame({ eyebrow, title, note, points, foot, shot }) {
  return page(`<div class="split">
  <div class="copy">
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <p class="note">${note}</p>
    <ul class="points">${points.map((point) => `<li>${point}</li>`).join("")}</ul>
    <p class="foot">${foot}</p>
  </div>
  <div class="shot"><img src="${shot}" alt=""><span class="stamp">${STAMP}</span></div>
</div>`);
}

function heroFrame({ eyebrow, title, note, shot }) {
  return page(`<div class="head">
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <p class="note">${note}</p>
  </div>
  <div class="centre"><img src="${shot}" alt=""><span class="stamp">${STAMP}</span></div>`);
}

function tile(icon) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box }
  body {
    display: flex;
    width: 440px;
    height: 280px;
    flex-direction: column;
    justify-content: center;
    margin: 0;
    padding: 0 34px;
    overflow: hidden;
    color: #f2fbfa;
    background: radial-gradient(120% 140% at 8% 0%, #1c8478 0%, #0f6a62 58%, #09363a 100%);
    font: 15px/1.5 Inter, ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* On a white tile: the icon is teal on teal otherwise, and disappears. */
  .mark {
    display: inline-flex;
    width: 66px;
    height: 66px;
    align-items: center;
    justify-content: center;
    border-radius: 17px;
    background: #ffffff;
    box-shadow: 0 10px 24px -10px rgba(3, 24, 26, 0.55);
  }
  img { display: block; width: 48px; height: 48px }
  h1 { margin: 18px 0 0; font-size: 33px; font-weight: 780; letter-spacing: -0.03em }
  p { margin: 9px 0 0; color: rgba(242, 251, 250, 0.78); font-size: 15px }
  small { margin-top: 14px; color: rgba(242, 251, 250, 0.55); font-size: 11px }
</style></head>
<body>
  <span class="mark"><img src="${icon}" alt=""></span>
  <h1>GRT Next Bus</h1>
  <p>Your stops, your routes, the next bus.</p>
  <small>Unofficial. Not affiliated with Grand River Transit.</small>
</body></html>`;
}

const UNOFFICIAL =
  "Unofficial third-party extension. Not affiliated with, endorsed by, or operated by " +
  "Grand River Transit or the Region of Waterloo. Departures shown are sample data.";

/* ------------------------------------------------------------------ *
 * Browser plumbing
 * ------------------------------------------------------------------ */

const dataUrl = (buffer) => `data:image/png;base64,${buffer.toString("base64")}`;

async function shoot(context, name, html, size = { width: WIDTH, height: HEIGHT }) {
  const frame = await context.newPage();
  await frame.setViewportSize(size);
  await frame.setContent(html, { waitUntil: "load" });
  // Data URLs decode asynchronously; without this the first frame can be blank.
  await frame.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  await frame.evaluate(() => document.fonts.ready);
  await frame.screenshot({ path: path.join(out, name) });
  await frame.close();
  process.stdout.write(`  ${name}\n`);
}

/** Answers the feeds, and ExtensionPay, without a network. */
async function installRoutes(context, feed, realtime, { paid }) {
  const counts = new Map();
  const count = (label) => counts.set(label, (counts.get(label) ?? 0) + 1);
  /** Which alert feed is currently being served. Swapped between shots. */
  let alertsFeed = realtime.alerts;

  await context.route(`${GTFS_HOST}/**`, (route) => {
    const url = new URL(route.request().url());
    count(url.pathname);
    if (url.pathname === STATIC_FEED_PATH) {
      return route.fulfill({ status: 200, contentType: "application/zip", body: feed.zip });
    }
    const protobuf = url.pathname.includes("/tripupdates/")
      ? realtime.tripUpdates
      : url.pathname.includes("/vehiclepositions/")
        ? realtime.vehiclePositions
        : url.pathname.includes("/alerts/")
          ? alertsFeed
          : undefined;
    return protobuf
      ? route.fulfill({
          status: 200,
          contentType: "application/x-protobuf",
          body: protobuf,
        })
      : route.fulfill({ status: 404, body: "" });
  });

  await context.route("https://extensionpay.com/**", (route) => {
    const url = new URL(route.request().url());
    count(url.pathname);
    const json = (value) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname.endsWith("/api/new-key")) return json("screenshot-fixture-key");
    if (url.pathname.includes("/api/v2/user")) {
      return json({
        paid,
        paidAt: paid ? new Date(NOW - 40 * 86_400_000).toISOString() : null,
        installedAt: new Date(NOW - 90 * 86_400_000).toISOString(),
        trialStartedAt: null,
        subscriptionStatus: paid ? "active" : null,
        subscriptionCancelAt: null,
      });
    }
    // Deliberately empty. The plan card prices itself from whatever ExtensionPay
    // reports, and this repo does not state a price anywhere, so putting a number
    // here would invent one for a picture that sells a subscription.
    if (url.pathname.includes("/api/v2/current-plans")) return json([]);
    return route.fulfill({ status: 404, body: "" });
  });

  return {
    counts,
    setAlerts(feedBytes) {
      alertsFeed = feedBytes;
    },
  };
}

/** Puts the fixture rider's stops, settings, location and plan into storage. */
async function seedStorage(context, id, { withAlerts, paid, cards } = {}) {
  const seeder = await context.newPage();
  await seeder.goto(`chrome-extension://${id}/popup.html`);
  await seeder.evaluate(
    async ([savedStops, location, extpay]) => {
      await chrome.storage.sync.set({
        savedStops,
        settings: { theme: "auto", departuresPerStop: 3, nearestFirst: true },
        ...extpay,
      });
      await chrome.storage.local.set({ locationConsent: true, lastLocation: location });
    },
    [
      savedStopsSeed({ withAlerts, cards }),
      {
        latitude: RIDER.latitude,
        longitude: RIDER.longitude,
        updatedAt: Date.now(),
        accuracyMeters: RIDER.accuracy,
      },
      paid
        ? {
            extensionpay_api_key: "screenshot-fixture-key",
            extensionpay_installed_at: new Date(NOW - 90 * 86_400_000).toISOString(),
          }
        : {},
    ],
  );
  await seeder.close();
}

/**
 * Opens the popup as its own document, with the clock pinned and motion off.
 *
 * `zoom` re-lays the popup out larger and renders the type at that size, which is
 * what a rider at 240% browser zoom sees. It is not a scaled-up bitmap.
 */
async function openPopup(context, id, { zoom = 1 } = {}) {
  const popup = await context.newPage();
  await popup.clock.setFixedTime(NOW);
  await popup.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await popup.setViewportSize({
    width: Math.ceil(POPUP_WIDTH * zoom) + 40,
    height: 1200,
  });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  if (zoom !== 1) {
    await popup.evaluate((value) => {
      document.documentElement.style.zoom = String(value);
    }, zoom);
  }
  // Wait for real data, not for a timeout: the skeleton is gone and the first
  // card has a live prediction on it.
  await popup.waitForSelector(".stop-card .note-live", { timeout: 30_000 });
  await popup.waitForFunction(() => {
    const detail = document.querySelector("#feed-detail");
    return Boolean(detail && detail.textContent && detail.textContent.length > 0);
  });
  return popup;
}

/**
 * Captures the popup document at its natural width and content height.
 *
 * The height comes from `.app`, not from `scrollHeight`: the popup is opened in a
 * tall viewport so nothing is cut off while it settles, and `scrollHeight` in a
 * viewport taller than the content just reports the viewport.
 */
async function shootPopup(popup) {
  const height = await popup.evaluate(() =>
    Math.ceil(document.querySelector(".app").getBoundingClientRect().height),
  );
  if (height > POPUP_MAX_HEIGHT) {
    process.stdout.write(
      `  ! popup is ${height}px tall; the frame has room for ${POPUP_MAX_HEIGHT}px\n`,
    );
  }
  await popup.setViewportSize({ width: POPUP_WIDTH, height });
  await popup.waitForTimeout(150);
  return { shot: await popup.screenshot(), height };
}

/* ------------------------------------------------------------------ *
 * Channels
 * ------------------------------------------------------------------ */

async function launch(dist) {
  const label = path.basename(dist);
  if (!existsSync(path.join(dist, "manifest.json"))) {
    process.stderr.write(
      `${label}/manifest.json is missing. Run \`npm run build:all\` first.\n`,
    );
    process.exit(1);
  }
  const profile = mkdtempSync(path.join(os.tmpdir(), `grt-store-${label}-`));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: POPUP_WIDTH, height: 900 },
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation(RIDER);
  const worker =
    context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  return { context, profile, id: new URL(worker.url()).hostname };
}

async function proChannel(feed, realtime) {
  const dist = path.join(root, "dist");
  const { context, profile, id } = await launch(dist);
  const served = await installRoutes(context, feed, realtime, { paid: true });

  /* --- the departure list ------------------------------------------ *
   * Three stops and the service-alert accordion do not both fit the frame, so
   * this shot is taken against an alert feed with nothing in it — a quiet
   * afternoon on GRT — and shot 03 is taken against the detour. Both are real
   * states of the same build reading a real feed; neither is the other with an
   * element hidden.                                                            */
  served.setAlerts(realtime.quietAlerts);
  await seedStorage(context, id, { withAlerts: false, paid: true, cards: 3 });
  const list = await openPopup(context, id);
  const listShot = await shootPopup(list);
  const facts = await list.evaluate(() =>
    [...document.querySelectorAll(".stop-card")].map((card) => ({
      stop: card.querySelector(".stop-name")?.textContent,
      meta: card.querySelector(".stop-meta")?.innerText.replace(/\s+/g, " ").trim(),
      route: card.querySelector(".route-badge")?.textContent,
      savedRoute: card.querySelector(".saved-route-line")?.innerText.replace(/\s+/g, " ").trim(),
      headsign: card.querySelector(".headsign")?.textContent,
      note: card.querySelector(".departure-note")?.innerText.replace(/\s+/g, " ").trim(),
      arrivals: card.querySelector(".arrival-times")?.innerText.replace(/\s+/g, " ").trim(),
      countdown: card.querySelector(".countdown")?.textContent,
    })),
  );
  for (const [index, card] of facts.entries()) {
    const missing = ["stop", "route", "savedRoute", "headsign", "countdown", "arrivals"]
      .filter((key) => !card[key]);
    if (missing.length > 0) {
      throw new Error(`Store fixture card ${index + 1} is missing: ${missing.join(", ")}`);
    }
  }
  await list.close();

  /* --- the same countdown, big ------------------------------------- */
  const hero = await openPopup(context, id, { zoom: 2.85 });
  const heroShot = await hero.locator(".stop-card").first().screenshot();
  await hero.close();

  /* --- settings: one saved stop, because the panel takes the rest --- */
  await seedStorage(context, id, { withAlerts: false, paid: true, cards: 1 });
  const settings = await openPopup(context, id);
  await settings.locator("#settings-button").click();
  await settings.waitForSelector("#settings-panel:not([hidden])");
  await settings.evaluate(() => document.activeElement?.blur());
  await settings.waitForTimeout(250);
  const settingsShot = await shootPopup(settings);
  const settingsNote = await settings.locator("#settings-note").innerText();
  await settings.close();

  /* --- arrival alerts armed, and GRT's own alert on the feed -------- */
  served.setAlerts(realtime.alerts);
  await seedStorage(context, id, { withAlerts: true, paid: true, cards: 2 });
  const alerts = await openPopup(context, id);
  // The extension's own refresh, so it re-reads the feed rather than reusing the
  // snapshot it cached a moment ago.
  await alerts.locator("#refresh-button").click();
  const serviceAlertShown = await alerts
    .waitForSelector("#alerts-section:not([hidden])", { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (serviceAlertShown) {
    await alerts.locator("#alerts-toggle").click();
    await alerts.waitForSelector("#alerts-list:not([hidden])");
  } else {
    await alerts.close();
    throw new Error("Store fixture did not render the required service-alert accordion.");
  }
  // A real confirmation from the extension, produced by really changing the lead
  // time. Nothing here writes text into the popup.
  await alerts.locator(".lead-select").first().selectOption("10");
  await alerts.waitForFunction(() =>
    document.querySelector("#feed-state")?.classList.contains("is-flash"),
  );
  await alerts.evaluate(() => document.activeElement?.blur());
  const flash = await alerts.locator("#feed-state-text").innerText();
  const alertText = await alerts.locator(".alert-item").first().innerText();
  if (!alertText.includes("Active ")) {
    await alerts.close();
    throw new Error("Store fixture service alert is missing its active-period context.");
  }
  const alertsShot = await shootPopup(alerts);
  await alerts.close();

  /* --- what the toolbar badge really says ------------------------- */
  const reader = await context.newPage();
  await reader.goto(`chrome-extension://${id}/popup.html`);
  await reader.waitForSelector(".stop-card");
  await reader.waitForTimeout(1500);
  const badge = await reader.evaluate(async () => ({
    text: await chrome.action.getBadgeText({}),
    title: await chrome.action.getTitle({}),
  }));
  await reader.close();

  /* --- compose ---------------------------------------------------- */
  await shoot(
    context,
    "01-departures-1280x800.png",
    splitFrame({
      eyebrow: "GRT Next Bus &middot; Chrome extension",
      title: "Your stops. Your routes. The next bus.",
      note:
        "One click gives you the next Grand River Transit departure from every stop you " +
        "save, and the one after that.",
      points: [
        "Live predictions from GRT's realtime feed, marked <strong>Live</strong> and never mixed up with the timetable",
        "How late the bus is running, and how many stops back it currently is",
        "Pick the route and direction you are actually waiting for, or choose any direction",
        "Falls back to the published schedule when the feed is unreachable, and says so",
      ],
      foot: UNOFFICIAL,
      shot: dataUrl(listShot.shot),
    }),
  );

  await shoot(
    context,
    "02-countdown-1280x800.png",
    heroFrame({
      eyebrow: "GRT Next Bus Pro &middot; Countdown",
      title: "The number you actually wanted, without reading a timetable.",
      note:
        "Pro repeats this countdown on the toolbar icon and keeps it current in the " +
        "background, so the answer is there before the popup is open.",
      shot: dataUrl(heroShot),
    }),
  );

  await shoot(
    context,
    "03-alerts-1280x800.png",
    splitFrame({
      eyebrow: "GRT Next Bus Pro &middot; Alerts",
      title: "Told before it gets there.",
      note:
        "Arm an alert on any saved stop and Chrome taps you on the shoulder 2 to 15 " +
        "minutes before your bus is due.",
      points: [
        "A separate lead time per stop, because a two-minute walk is not a ten-minute one",
        "Notifications are an <strong>optional</strong> permission, asked for only when you switch an alert on",
        "GRT's own service alerts for your stops and routes, in the same panel",
        "Alerts are worked out on your device from data you already have",
      ],
      foot: UNOFFICIAL,
      shot: dataUrl(alertsShot.shot),
    }),
  );

  await shoot(
    context,
    "04-settings-1280x800.png",
    splitFrame({
      eyebrow: "GRT Next Bus &middot; Settings",
      title: "Small, and yours to set.",
      note:
        "Everything the extension knows is on this panel, and everything it stores stays " +
        "on your device or in your own Chrome sync.",
      points: [
        "Light, dark, or follow the system",
        "Two to five departures per stop",
        "<strong>Closest stop first</strong> uses your location on this device only, and is off until you turn it on",
        "The cached timetable's age and coverage, with a manual reload",
      ],
      foot: UNOFFICIAL,
      shot: dataUrl(settingsShot.shot),
    }),
  );

  await shoot(
    context,
    "promo-440x280.png",
    tile(dataUrl(readFileSync(path.join(dist, "icon.png")))),
    { width: 440, height: 280 },
  );

  await context.close();
  rmSync(profile, { recursive: true, force: true });
  return {
    facts,
    settingsNote,
    flash,
    alertText,
    badge,
    serviceAlertShown,
    served: Object.fromEntries(served.counts),
    heights: {
      list: listShot.height,
      settings: settingsShot.height,
      alerts: alertsShot.height,
    },
  };
}

async function freeChannel(feed, realtime) {
  const dist = path.join(root, "dist-free");
  const { context, profile, id } = await launch(dist);
  const served = await installRoutes(context, feed, realtime, { paid: false });
  await seedStorage(context, id, { withAlerts: false, paid: false });

  served.setAlerts(realtime.quietAlerts);
  const popup = await openPopup(context, id);
  const { shot, height } = await shootPopup(popup);
  const visible = await popup.evaluate(() => ({
    planChip: !document.querySelector("#plan-button")?.hidden,
    bells: document.querySelectorAll(".tool-button[aria-pressed]").length,
    leadSelects: document.querySelectorAll(".lead-select").length,
    closestTags: document.querySelectorAll(".stop-tag").length,
  }));
  await popup.close();

  /* --- what the Free build withholds, and what it still uses -------- *
   * Not screenshots: checks.
   *
   * The settings panel has to be open before its fields report anything, because
   * `renderSettings` returns early while it is closed and leaves the markup's
   * initial state in place — reading them from a closed panel says nothing.
   *
   * Then the "Near me" button, which is the only thing in the Free channel that
   * could need the `geolocation` permission it declares. Pressing it in the
   * shipped Free build and seeing whether real stops come back is the difference
   * between a permission that is used and one that is merely asked for.         */
  const prober = await openPopup(context, id);
  await prober.locator("#settings-button").click();
  await prober.waitForSelector("#settings-panel:not([hidden])");
  visible.nearestField = await prober.evaluate(
    () => !document.querySelector("#nearest-field").hidden,
  );
  visible.testAlertButton = await prober.evaluate(
    () => !document.querySelector("#test-alert-button").hidden,
  );
  visible.managePlanButton = await prober.evaluate(
    () => !document.querySelector("#manage-plan-button").hidden,
  );
  await prober.locator("#settings-button").click();
  await prober.locator("#picker-toggle").click();
  await prober.waitForSelector("#picker-body:not([hidden])");
  await prober.locator("#near-button").click();
  const nearby = await prober
    .waitForFunction(() => document.querySelectorAll("#search-results li").length > 0, {
      timeout: 20_000,
    })
    .then(async () => ({
      used: true,
      results: await prober.evaluate(() =>
        [...document.querySelectorAll("#search-results .result-name")]
          .slice(0, 3)
          .map((node) => node.textContent),
      ),
      mapLinks: await prober.evaluate(() =>
        [...document.querySelectorAll("#search-results .result-map-link")]
          .slice(0, 3)
          .map((node) => node.getAttribute("href")),
      ),
      hint: await prober.locator("#search-hint").innerText(),
    }))
    .catch(async () => ({
      used: false,
      message: await prober.locator("#feed-state-text").innerText().catch(() => ""),
    }));
  await prober.close();
  if (!nearby.used || nearby.results?.length === 0) {
    throw new Error("Store fixture could not use the Free build's nearby-stop search.");
  }
  if (
    nearby.mapLinks?.length === 0 ||
    nearby.mapLinks.some((href) => !href?.startsWith("https://www.google.com/maps/")) ||
    !nearby.hint?.includes("straight-line")
  ) {
    throw new Error("Store fixture could not verify nearby distance and map details.");
  }

  await shoot(
    context,
    "05-free-1280x800.png",
    splitFrame({
      eyebrow: "GRT Next Bus Free &middot; Chrome extension",
      title: "Free, and complete on its own.",
      note:
        "The whole departure board, stop search and service alerts, with no account, no " +
        "payment code and nothing withheld behind a countdown.",
      points: [
        "Save up to twelve stops and pick the route you wait for at each",
        "Live GRT predictions, delays and stops-away, exactly as the paid build shows them",
        "Find stops near you, or search by the number printed on the pole",
        "No toolbar countdown and no arrival alerts &mdash; those are the paid build's only additions",
      ],
      foot: UNOFFICIAL,
      shot: dataUrl(shot),
    }),
  );

  await context.close();
  rmSync(profile, { recursive: true, force: true });
  return { height, visible, nearby };
}

/* ------------------------------------------------------------------ *
 * Verification
 * ------------------------------------------------------------------ */

/** Width and height straight out of the PNG's IHDR chunk. */
function pngSize(file) {
  const header = readFileSync(file).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

const EXPECTED = {
  "01-departures-1280x800.png": [WIDTH, HEIGHT],
  "02-countdown-1280x800.png": [WIDTH, HEIGHT],
  "03-alerts-1280x800.png": [WIDTH, HEIGHT],
  "04-settings-1280x800.png": [WIDTH, HEIGHT],
  "05-free-1280x800.png": [WIDTH, HEIGHT],
  "promo-440x280.png": [440, 280],
};

/** Fails the run rather than shipping an asset the store will reject. */
function checkSizes() {
  const wrong = [];
  const report = [];
  for (const [name, [width, height]] of Object.entries(EXPECTED)) {
    const size = pngSize(path.join(out, name));
    const ok = size.width === width && size.height === height;
    report.push(`  ${ok ? "ok  " : "BAD "} ${name}  ${size.width}x${size.height}`);
    if (!ok) wrong.push(`${name} is ${size.width}x${size.height}, wanted ${width}x${height}`);
  }
  process.stdout.write(`\nmeasured output\n${report.join("\n")}\n`);
  if (wrong.length > 0) {
    process.stderr.write(`${wrong.join("\n")}\n`);
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  mkdirSync(out, { recursive: true });
  const feed = buildStaticFeed();
  const realtime = buildRealtimeFeeds(feed.trips);
  process.stdout.write(
    `fixture: ${feed.routeCount} routes, ${feed.stopCount} stops, ` +
      `${feed.trips.length} trips, ${(feed.zip.length / 1024).toFixed(1)} kB zip\n` +
      `anchor:  ${new Date(NOW).toISOString()} (service day ${TODAY.dateKey})\n`,
  );

  const pro = await proChannel(feed, realtime);
  const free = await freeChannel(feed, realtime);

  process.stdout.write(`\nwhat the shipped build rendered\n`);
  for (const card of pro.facts) {
    process.stdout.write(
      `  ${card.route} ${card.stop} -> ${card.headsign}\n` +
        `      ${card.countdown}  ${card.note}  ${card.arrivals}\n` +
        `      ${card.meta}\n`,
    );
  }
  process.stdout.write(`  settings note: ${pro.settingsNote}\n`);
  process.stdout.write(`  alert confirmation: ${pro.flash}\n`);
  process.stdout.write(
    `  toolbar badge (drawn by Chrome, not photographed): ` +
      `"${pro.badge.text}" / ${pro.badge.title}\n`,
  );
  process.stdout.write(
    `  popup heights: list ${pro.heights.list}, settings ${pro.heights.settings}, ` +
      `alerts ${pro.heights.alerts}, free ${free.height}\n`,
  );
  process.stdout.write(`  free channel Pro surfaces: ${JSON.stringify(free.visible)}\n`);
  process.stdout.write(
    `  free channel "Find stops near me": ${JSON.stringify(free.nearby)}\n`,
  );
  process.stdout.write(`  service alert accordion: ${pro.serviceAlertShown}\n`);
  process.stdout.write(
    `  service alert as rendered: ${JSON.stringify(pro.alertText ?? null)}\n`,
  );
  process.stdout.write(`  feeds served: ${JSON.stringify(pro.served)}\n`);
  checkSizes();
  process.stdout.write(`\nstore assets in ${path.relative(root, out)}\n`);
}

await main();
