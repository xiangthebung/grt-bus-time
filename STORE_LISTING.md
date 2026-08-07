# Chrome Web Store listing copy

This repository produces two extensions and therefore two store listings: **GRT Next
Bus** from `dist/`, which contains the paid Pro features, and **GRT Next Bus Free**
from `dist-free/`, which contains no payment code at all. Everything below is split
where the two listings differ and shared where they do not.

Neither extension is affiliated with, endorsed by, or operated by Grand River Transit
or the Region of Waterloo. It reads their public open-data feeds. That sentence, or
one like it, belongs in both listings and in the first screenshot.

## Name

- Paid listing: **GRT Next Bus**
- Free listing: **GRT Next Bus Free**

## Summary

- Paid: Live Grand River Transit departures for the stops you save, with a countdown
  on the toolbar icon and an alert before your bus arrives.
- Free: Live Grand River Transit departures for the stops you save, with nearby stop
  search and service alerts.

## Category

Travel & Local. (Productivity is the second-best fit; the extension is about catching
a bus, not about doing work, so Travel & Local is the honest one.)

## Single purpose

Both builds: show a rider when the next Grand River Transit bus leaves the stops they
have chosen to save, by combining the Region of Waterloo's published GTFS timetable
with its GTFS-realtime predictions, and — in the paid build only — surface that same
next departure on the toolbar icon and as a notification shortly before it arrives.

## Detailed description

Save the stops you actually travel from, pick the route you are actually waiting for,
and the next departure is one click away.

GRT Next Bus reads the Region of Waterloo's own open data: the published timetable and
the live feed the buses report into. It shows you which one a time came from, so a
prediction is never quietly presented as a promise.

Both builds include:

- Up to twelve saved stop-and-route pairs, with duplicate pairs prevented.
- The soonest departure and the two after it, as a countdown inside the hour and a
  clock time beyond it.
- Times marked **Live** come from the bus. Everything else is the published schedule,
  and the panel says which you are looking at.
- How late or early a live bus is running, and how many stops back it currently is.
- GRT's service alerts for your stops and routes, in the panel rather than on a
  website you have to remember to check.
- Find stops near you, or search by the stop number printed on the pole, or walk a
  route's stops in order.
- When the live feed cannot be reached, it falls back to the timetable and tells you
  it has done so instead of showing nothing.
- Light, dark, or follow the system.

The paid build adds three things, and takes nothing away:

- **A countdown on the toolbar icon**, kept current in the background, so the answer
  is there before you open anything.
- **Arrival alerts** 2 to 15 minutes before your bus, with a separate lead time per
  stop. Notifications are an optional permission, requested only when you switch an
  alert on.
- **Closest saved stop first**, using a location you have opted into sharing, which
  also decides which stop the toolbar counts down.

Saved stops and settings live in your Chrome profile and sync with it. Your location,
when you turn it on, is compared against stop coordinates already on your device and
is never transmitted anywhere — there is no reverse-geocoding call, no analytics, and
no server of ours in the middle.

Pricing for the paid build: `TODO: confirm in the ExtensionPay dashboard.` The
extension deliberately does not hard-code a price; it reads the current plans from
ExtensionPay at runtime so the amount in the popup and the amount at checkout come
from one place. Fill in the amounts here from the dashboard before publishing, and
keep them in step with `TERMS_OF_SALE.md`.

Limits worth stating plainly: departures are only as good as the Region's feeds, and
when those are down, stale or wrong, this extension is wrong with them. Background
countdowns and alerts also depend on Chrome choosing to run the extension's timers,
which it may delay on battery or while the machine is asleep. Do not rely on it to
catch a bus you cannot afford to miss.

## Permission justifications

Paid build (`dist/`) — `storage`, `alarms`, `geolocation`, `offscreen`, optional
`notifications`, host access to `webapps.regionofwaterloo.ca` and `extensionpay.com`.

Free build (`dist-free/`) — `storage`, `alarms`, `geolocation`, host access to
`webapps.regionofwaterloo.ca`. No optional permissions.

- **storage** (both): Saved stops, the route chosen at each and the display order go
  in `chrome.storage.sync` so they follow the profile. The location consent flag, the
  cached position and the bookkeeping that stops one bus being announced twice go in
  `chrome.storage.local`. Which stop is currently closest goes in
  `chrome.storage.session`, because Chrome restarts the service worker between ticks
  and it would otherwise be forgotten. The parsed timetable goes in IndexedDB: the
  regional feed is a large download, so it is fetched, parsed once into typed arrays,
  and reused for every service day it covers.
- **alarms** (both): The service worker is stopped and restarted constantly, so
  nothing that has to happen later can be a timer inside it. Both builds use an alarm
  to refresh the timetable every six hours. The paid build adds a half-minute alarm
  that recomputes the toolbar countdown and fires due arrival alerts; that alarm is
  torn down whenever there is no Pro access or no saved stop, so it does not run for
  users it cannot serve.
- **geolocation** (both): "Find stops near me" reads a position and lists the GRT
  stops within two kilometres of it. In the paid build the same position also orders
  saved stops closest-first and decides which stop the toolbar icon counts down. It
  is read only after the rider opts in, compared against coordinates already on the
  device, cached for a few minutes so the GPS is not woken repeatedly, and never sent
  anywhere. Declining is remembered and the extension stops asking.
- **offscreen** (paid build only): `navigator.geolocation` is a DOM API and does not
  exist inside a manifest V3 service worker, so the worker cannot read a position for
  the toolbar countdown on its own. Chrome's documented answer is an offscreen
  document — a hidden page bundled with the extension — which is created on demand,
  answers one question, and is closed again, with a one-minute floor between attempts.
  The free build has no toolbar countdown, so it does not declare this and does not
  ship the document.
- **notifications** (paid build only, optional): Arrival alerts. Requested from the
  click that switches an alert on, never at install, and the extension works fully
  without it. Alerts are computed on the device from timetable and feed data already
  held locally; nothing about an alert is reported anywhere.
- **Host access to `https://webapps.regionofwaterloo.ca/*`** (both): The four public
  Region of Waterloo feeds — the GTFS static timetable, and the GTFS-realtime trip
  updates, vehicle positions and service alerts. No API key, no server of ours.
  Filtering to the rider's stops happens on the device after the whole feed arrives,
  so the request says nothing about which stops they care about.
- **Host access to `https://extensionpay.com/*`** (paid build only): Checking whether
  a subscription is active, and opening the checkout and restore pages. `connect-src`
  in the manifest is limited to exactly these origins, so the extension cannot reach
  anywhere else even by accident; the free build's policy lists only the transit feed.

Neither build declares a content script or the `tabs` permission, so neither can see
the pages you visit.

## Privacy disclosures for the Developer Dashboard

Both builds handle **location**, and only location, from the categories Chrome asks
about. It is read after an explicit opt-in, used on the device to work out which stop
is nearest, cached in `chrome.storage.local` for at most thirty minutes, deleted when
consent is withdrawn, and never transmitted. Declare it, and certify that it is not
sold, not transferred to third parties, not used for advertising or credit decisions,
and used only for the extension's single purpose.

The paid build additionally handles **personally identifiable information — an email
address** and subscription state, and only when a rider chooses to buy Pro.
ExtensionPay and Stripe collect the email and the card details on their own pages; the
extension receives back whether the subscription is paid, its status, the plan, and
the email used at checkout, and keeps that in `chrome.storage.sync`. Declare the email
and certify the same non-sale and limited-use terms.

Answer **no** for website content, web history and browsing activity, health,
financial information, authentication information, personal communications and user
activity. Neither build has a content script, neither requests `tabs`, and neither
sees or handles card details.

Link the publicly hosted contents of `PRIVACY_POLICY.md` in the dashboard for both
listings. Link `TERMS_OF_SALE.md` as the terms for the paid listing only; the free
listing has nothing to sell and should not carry them.

## Required visual assets

Regenerate all of these with `npm run build:all && node scripts/store-shots.mjs`
(`npm install --no-save playwright` once, if it is not already there). They are
rendered from `dist/` and `dist-free/` — the same directories `npm run zip:all`
packages — in a real Chromium with the extension loaded, so they cannot drift from
what is submitted. The script measures every file it writes and fails if any of them
is not exactly the size the store wants.

- Store icon, both listings: `dist/icon.png`.
- Screenshots, 1280x800:
  - `store-assets/01-departures-1280x800.png` — three saved stops with live
    countdowns, delays, stops-away and route selection. Paid listing.
  - `store-assets/02-countdown-1280x800.png` — one stop card enlarged, the countdown
    the toolbar icon repeats. Paid listing.
  - `store-assets/03-alerts-1280x800.png` — an arrival alert armed with its lead
    time, the extension's own confirmation of it, and a GRT service alert expanded.
    Paid listing.
  - `store-assets/04-settings-1280x800.png` — the settings panel, including the age
    and coverage of the cached timetable. Paid listing.
  - `store-assets/05-free-1280x800.png` — the free build's popup, which visibly lacks
    the alert controls, the closest-stop tag and the plan chip. Free listing.
    `01` through `04` are rendered from `dist/` and belong to the paid listing only.
    If the free listing wants a second screenshot, add another capture from
    `dist-free/` rather than reusing a paid one.
- Small promotional tile, both listings: `store-assets/promo-440x280.png`.

Every pixel of extension interface in these files was rendered by the shipped build.
The transit feeds behind them were not: the script generates a small GTFS zip and
three GTFS-realtime protobufs and answers the extension's own requests with them, so
the download, parse, IndexedDB write, realtime decode and departure-board code all run
for real on data that does not change between runs. **The stop codes, coordinates,
route patterns, every departure time, every delay, every "N stops away", the rider's
position and the detour notice are all invented**, and each screenshot carries a
"Sample timetable" stamp saying so. The stop and place names are real Waterloo Region
ones, because a transit extension photographed against "Stop A" tells a buyer nothing.

Do not claim the extension knows where a bus is when GRT is not reporting one, and do
not show a screenshot with a live countdown while describing it as a guaranteed time.
Do not depict Grand River Transit's logo, wordmark or route branding, and do not imply
any relationship with the agency. Do not omit that the free build exists from the paid
listing, or that the paid features exist from the free one — a rider who installs the
free build and then finds the toolbar countdown missing was misled by the listing, not
by the extension. Do not state a price anywhere until the amounts in the ExtensionPay
dashboard have been confirmed and written into the description above.
