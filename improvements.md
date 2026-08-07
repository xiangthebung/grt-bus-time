# GRT Next Bus extension — improvement backlog

Audit date: 2026-08-07  
Method: real Chrome UI pass against both the Pro and Free unpacked builds. I exercised the header actions, settings controls, saved-stop controls, stop picker, search, nearby mode, route browsing, alerts, undo/dismiss, plan management, external map links, refreshes, and keyboard escape paths.

## What already feels strong

- The main departure cards are clear and trustworthy: route, direction, stop code, distance, countdown, clock time, and Live/Scheduled provenance are all visible.
- Pro and Free are meaningfully separated. Free did not expose Pro-only controls; Pro exposed alerts, closest-stop ordering, and plan management in the right places.
- Search uses the physical stop ID to infer its destination; shared platforms show one explicit row per destination, and saved-stop feedback names the route and stop.
- Route lists, nearby sorting, drag/keyboard reorder, alert lead time, remove/undo, test alerts, timetable reload, and Google Maps links all worked in the live pass.
- Focus and native control semantics were generally good: radio groups, selects, disabled Add actions, labels, and alert descriptions were exposed usefully to the accessibility tree.

## Improvements by category

### 0. Stop identity and destination inference — P0

**Feed analysis:** I downloaded the current [GRT static GTFS feed](https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/1) and inspected `routes.txt`, `stops.txt`, `trips.txt`, and `stop_times.txt`. It contains 51 routes, 2,267 boarding stops, and 2,753 route-stop pairs. Of those pairs, 2,747 have exactly one `direction_id`; only six shared-platform pairs have both directions. `route_long_name` is a route family name, not a destination: for example, Route 13 is named **Laurelwood**, while its trip headsigns are **University of Waterloo Station** and **The Boardwalk Station**. Physical stop IDs are the reliable identity even when names repeat.

- [x] Infer the destination from the selected stop ID + route pattern instead of presenting the route-wide direction list for every stop. — Direction fix
- [x] Remove the search result “Choose direction” control; normal stops now show one static **Toward …** destination row. — Direction fix
- [x] Render the six shared-platform cases as separate destination rows, so the rider chooses the actual journey rather than an ambiguous dropdown value. — Direction fix
- [x] Treat older route-only saved entries as **All destinations** and prevent them from duplicating a newly inferred one-way journey. — Direction fix
- [x] Remove the global route-browser destination chooser; browse the complete route and rely on each physical stop ID to determine its destination. — Batch 5
- [x] Keep destination text available only for the rare shared-platform stop that truly serves both directions. — Batch 5

### 1. First-run loading and recovery — P0/P1

**Observed:** In a clean Free-channel popup, the feed stayed on `Loading schedule…` for roughly a minute. The picker could be opened during that period but had no usable results. At the same time, Settings showed a cached timetable note, which made the loading state feel inconsistent. Pressing **Reload schedule** eventually resolved the state.

- [x] Distinguish an initial download from a refresh of a cached timetable in the feed status and Settings note. — Batch 1
- [x] Tell the rider when a download is taking unusually long instead of leaving a static loading label. — Batch 1
- [x] Keep the picker from becoming a dead end while the index is unavailable; show an explicit explanation and keep its Close action usable. — Batch 1
- [x] Show a useful empty state while a cached index is being refreshed, rather than hiding all empty-state guidance. — Batch 1
- [ ] Add background download phases (download, parse, index) if the message protocol later exposes progress. This is a larger architectural change and is deferred.
- [ ] Add an automated clean-profile/empty-cache browser test for this exact first-run path. — QA follow-up

### 2. Stop discovery and route browsing — P1

**Observed:** Search grouped results by physical stop and displayed the stop name well. The Browse routes pane, however, rendered long rows whose visible content was primarily the direction/headsign and Add button; the stop name was only recoverable from the Add button’s accessible label. That is too easy to misread when scanning a route.

- [x] Add the stop name, stop code, and nearby distance to every Browse routes row. — Batch 2
- [x] Make the Search-pane hint accurately describe grouped stop results. — Batch 2
- [x] Group same-name physical locations under one station heading, with each Stop ID kept as a distinct actionable location. — Batch 6
- [x] Render one route badge for a physical stop and stack its destination rows beneath it, so two directions do not look like duplicate routes. — Batch 6
- [x] Add a compact stop-count and nearby-order summary above route lists. — Batch 5
- [ ] Consider collapsible route-stop groups or incremental rendering for routes with very large stop lists. — Deferred performance follow-up

### 3. Panel and keyboard interaction — P1/P2

**Observed:** Opening the picker while Settings was open left both panels visible, producing duplicate Add-stop affordances and a crowded scroll. The main controls otherwise behaved well, but the picker did not have a dedicated Escape close path before the popup itself closed.

- [x] Make Settings and the stop picker mutually exclusive. — Batch 3
- [x] Let Escape close the open picker before the browser closes the extension popup. — Batch 3
- [x] Keep a loading picker’s Close control enabled even when its search controls are unavailable. — Batch 1
- [x] Keep the selected route visible above the list while browsing a long route. — Batch 5
- [ ] Add a full keyboard regression pass to the automated test suite, including plan-dialog focus trapping. — QA follow-up

### 4. Permissions, Pro, and trust surfaces — P2

**Observed:** Location and notification states were explained clearly in Settings, and the Pro plan dialog and ExtensionPay management link worked. The live pass did not encounter a permission prompt because Chrome permissions were already granted in the test profile.

- [ ] Add a compact permission-status affordance near the first action that needs location or notifications, so the user does not have to infer why a control is unavailable. — Deferred UX follow-up
- [ ] Add a post-denial recovery CTA that takes the rider back to the relevant Chrome permission setting when the platform permits it. — Deferred platform follow-up
- [x] Add a visible last-updated timestamp to expanded service-alert content. — Direction fix

### 5. Visual density and scale — P1

**Observed:** The supplied screenshots showed competing header status, duplicated route/headsign information, four visible card controls, and three oversized destination choices. The 420px popup needs a clear primary action and quiet secondary metadata.

- [x] Remove nonessential header disclosure and feed-age text from the default view. — Batch 5
- [x] Collapse reorder, alerts, and remove into one labeled More menu on each saved card. — Batch 5
- [x] Present one primary countdown and plain clock times without repeating the route/headsign inside the departure row. — Batch 5
- [x] Flatten route-browser rows into stop name, stop ID, and Add; preserve destination wording in accessible labels and shared-platform rows. — Batch 5
- [x] Hide the secondary Add-stop toggle while the picker is open so the header has one clear Close action. — Batch 5
- [x] Use a consistent 7–14px vertical rhythm between search controls, location blocks, route groups, and actions. — Batch 6
- [ ] Keep the route filter controls sticky while scanning a long stop list, if Chrome popup scrolling permits it without obscuring content.
- [ ] Re-test at the maximum saved-stop limit and at the longest route names to verify truncation and action discoverability.

### 6. Testability and release QA — P1

- [ ] Keep a repeatable clean-profile browser scenario for Pro and Free first launch, including denied/allowed location and notification permissions.
- [ ] Add UI-level coverage for every header button, picker tab, direction selector, Add/Added/Choose/Limit state, saved-stop menu, alert lead selector, undo/dismiss, and plan dialog action.
- [ ] Add a regression assertion that the unpacked root build and both Vite build outputs use the same popup behavior after a rebuild.

## Implementation batches

### Batch 1 — timetable loading and recovery

Implement the P0/P1 loading findings: slow-load feedback, cache-versus-refresh wording, a usable cached empty state, and a picker that cannot strand the user while the timetable is unavailable.

### Batch 2 — route-browser identity

Implement visible stop identity in route rows and correct the search microcopy.

### Batch 3 — panel and keyboard cleanup

Implement mutually exclusive Settings/picker panels and Escape-to-close for the picker.

### Batch 4 — stop identity and destination clarity — implemented

Implement the feed-backed destination inference, remove the misleading per-result direction
chooser, handle shared platforms explicitly, and make route browsing explain what is shown.

### Batch 5 — visual hierarchy and progressive disclosure — implemented

Reduce the default surface to the next departure, the stop identity, and the one action that matters. Move secondary saved-stop tools behind a labeled More menu, remove the redundant route-wide destination decision, and keep route context visible without repeating it in every row.

### Batch 6 — repeated stop clarity and spacing — implemented

Use the GRT physical stop ID as the visual boundary: same-name locations are grouped under one heading, route badges are not repeated for each destination on the same stop, and search results follow a small, consistent spacing scale.

### Deferred batches

Progress reporting from the background parser, large-route virtualization/collapsing, permission deep links, compact browsing mode, and a full browser automation harness are documented above but intentionally remain separate follow-up work.
