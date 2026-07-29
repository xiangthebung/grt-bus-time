# GRT Next Bus

A Chrome extension that shows the next Grand River Transit bus for the stops you
actually use, blending the published timetable with GRT's live predictions.

Saved stops sync with your Chrome profile. Pro adds a countdown on the toolbar
icon, arrival alerts, and closest-stop ordering.

## Install locally

Requirements: Node 20+ and Chrome.

```bash
npm install
npm run build          # -> dist/
```

Then load it:

1. open `chrome://extensions`
2. turn on **Developer mode** (top right)
3. click **Load unpacked**
4. select the `dist/` folder

Load `dist/`, not the repository root and not `dist-free/`. `dist/` is the Pro
channel and the one to develop against; `dist-free/` exists only to be packaged
for the second store listing.

## Two channels, one codebase

Two Web Store listings are built from this source. The channel is chosen by Vite's
`--mode` flag, and `vite.config.ts` rewrites the output manifest to match.

| | `dist/` | `dist-free/` |
| --- | --- | --- |
| Listing name | GRT Next Bus | GRT Next Bus Free |
| Built by | `npm run build` | `npm run build:free` |
| Toolbar countdown, arrival alerts, closest-stop ordering | yes | no |
| ExtensionPay bundled | yes | no — `payments.ts` is aliased away entirely |
| Permissions | `storage`, `alarms`, `geolocation`, `offscreen` | `storage`, `alarms`, `geolocation` |

The free channel is selected with `--mode free` rather than a `BUILD_CHANNEL=free`
prefix, because that prefix is shell syntax that cmd.exe and PowerShell do not
understand: `npm run build:free` used to fail before Vite even started on Windows.

## Commands

| command | what it does |
| --- | --- |
| `npm run build` | Pro channel into `dist/` (typechecks first) |
| `npm run build:free` | Free channel into `dist-free/` |
| `npm run build:all` | both channels |
| `npm run watch` | rebuild the Pro channel on change |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify` | typecheck + build |
| `npm run zip` | build, then `artifacts/grt-next-bus-<version>.zip` (verified) |
| `npm run zip:free` | build:free, then `artifacts/grt-next-bus-free-<version>.zip` |
| `npm run zip:all` | both archives |
| `npm run clean` | remove `dist/`, `dist-free/` and `artifacts/` |

Packaging is pure Node (`scripts/zip.mjs`), so it behaves the same on every
platform, and the archive is always cut from the build that just ran. It reads its
own output back, inflates every entry and checks each CRC, and it refuses to
package a Pro build whose manifest requests the `offscreen` permission without
shipping `offscreen.html` — which is precisely the unloadable state the previously
committed `dist/` was in.

## Where the data comes from

Everything is public Region of Waterloo open data, fetched directly from
`webapps.regionofwaterloo.ca`. There is no API key and no server of ours in the
middle.

| Feed | Used for |
| --- | --- |
| GTFS static (zip) | the timetable: routes, stops, trips, stop times, service calendar |
| GTFS-Realtime trip updates | live predictions |
| GTFS-Realtime vehicle positions | "3 stops away" |
| GTFS-Realtime service alerts | the alerts accordion |

The static feed is parsed into typed arrays and cached in IndexedDB, refreshed
every 12 hours, so a single download serves every service day the feed covers.

Data © Region of Waterloo.

## Privacy

Saved stops live in `chrome.storage.sync`. Location, when you opt in, is used on
the device to decide which saved stop is closest and is never sent anywhere —
there is no reverse geocoding call and no analytics. Consent is explicit and
revoking it deletes the cached position.

The full policy is published at `/legal/grt-next-bus/privacy`.

## Before publishing

1. Register the ExtensionPay ID `grt-next-bus` and connect Stripe.
2. Confirm the Pro prices in the ExtensionPay dashboard. The popup reads them from
   the provider at runtime rather than hard-coding them, so the dialog cannot
   disagree with what Stripe actually charges.
3. Run `npm run zip:all` and upload the two archives from `artifacts/`.
