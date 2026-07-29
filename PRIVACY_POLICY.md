# GRT Next Bus Privacy Policy

Effective: July 28, 2026

GRT Next Bus shows Grand River Transit departures for the stops you save. It talks to exactly two servers: the Region of Waterloo's transit feed, and — in the Pro build only — ExtensionPay for the subscription. It has no server of its own, no analytics, and no account beyond the one ExtensionPay needs to bill you.

This policy covers both builds: **GRT Next Bus** (with Pro features) and **GRT Next Bus Free**.

## Your location

This is the part worth reading carefully, so it comes first.

Location is **off until you turn it on.** The extension keeps its own consent flag and reads nothing until you set it. What it is for:

- ordering your saved stops so the one you are standing at is first
- finding stops near you when you are adding one

What happens to a position once read:

- it is compared against stop coordinates that are already on your device, using straight-line distance
- the latitude, longitude, accuracy radius and a timestamp are cached in `chrome.storage.local` so the extension does not have to wake the GPS again for a few minutes
- the cache is ignored after 30 minutes and discarded if you withdraw consent
- **it is never transmitted anywhere.** No coordinates are sent to the transit feed, to ExtensionPay, or to any other server. There is no endpoint to send them to.

If you deny the browser permission, the extension records that and stops asking.

In the Pro build, the service worker needs a position to keep the toolbar countdown pointed at the stop you are actually at. Service workers have no `navigator`, so Chrome's documented answer is an offscreen document — a hidden page bundled with the extension. That is what the `offscreen` permission is for. It is created on demand, answers one question, and is closed again, with a one-minute floor between attempts.

## What is stored, and where

`chrome.storage.sync` — synchronised through your Google account if Chrome Sync is on:

- your saved stops: stop id, stop code, stop name, route and direction selection, alert preferences, display order
- your settings: how many departures to show per stop, theme, and similar preferences

Because this uses `chrome.storage.sync`, a list of the stops you travel from is part of your Chrome sync data, like a bookmark would be. If you would rather it were not, turn off extension syncing in Chrome's settings; the extension keeps working.

`chrome.storage.local`:

- your last known position and its accuracy, as described above
- the location consent flag
- alert bookkeeping, so the same bus is not announced twice

`chrome.storage.session` — memory-only, discarded when Chrome exits:

- which saved stop is currently treated as closest
- when a background location attempt was last made, so the cooldown survives a service worker restart

IndexedDB (database `grt-next-bus`):

- the parsed timetable. The regional GTFS feed is a large download, so it is fetched, parsed into typed arrays once, and kept locally until it expires. This is public schedule data, not anything about you.

## Network requests

`https://webapps.regionofwaterloo.ca/*` — the static GTFS timetable and the GTFS-realtime feed. These are ordinary public requests for a published schedule. They carry no identifier the extension invented; the request tells the Region that someone asked for the feed, and nothing about which stops you care about, because filtering happens on your device after the whole feed arrives.

`https://extensionpay.com/*` — Pro build only. Used to check whether your subscription is active and to open the checkout and login pages. See below.

`connect-src` in the manifest is restricted to exactly these two origins, so the extension cannot reach anywhere else even by accident. The Free build's policy lists only the transit feed.

## Payments (Pro build only)

Pro is sold through [ExtensionPay](https://extensionpay.com), which uses Stripe for card processing. When you buy or restore Pro:

- you enter your email and payment details on ExtensionPay's and Stripe's pages, not in this extension
- the extension never sees or handles your card details
- the extension receives back only whether you have paid, when, your subscription status, the plan you are on, and the email you used

ExtensionPay and Stripe process that data as their own privacy policies describe. The developer can see subscription status and the billing email in the ExtensionPay dashboard, which is what makes support and refunds possible.

The Free build contains no payment code and never contacts ExtensionPay.

## Notifications

`notifications` is an **optional** permission, requested only when you switch arrival alerts on for a stop. Alerts are generated on your device from the timetable and live feed you already have. Nothing about an alert is reported anywhere.

## What is never collected

No browsing history, no page content, no tab URLs, no analytics, no advertising identifiers, no device fingerprint, no telemetry, no crash reporting. The extension declares no content scripts and no `tabs` permission, so it cannot see the pages you visit even if it wanted to.

## Retention and deletion

Saved stops and settings stay until you remove them or uninstall. The cached position expires after 30 minutes and is deleted the moment you withdraw location consent. The cached timetable is replaced when it expires. Uninstalling the extension removes all local data.

For data held by ExtensionPay about a Pro purchase, email **xiangli3625@gmail.com** with the address you used at checkout.

## Limited Use

GRT Next Bus's use of information received from Chrome APIs complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. Location is used only to provide the features described above, is not transferred off the device, is not sold, and is not used for advertising or credit assessment.

## Changes

Material changes to this policy will be disclosed before they take effect, and the effective date above will be updated.

## Contact

Questions, privacy concerns, or deletion requests: **xiangli3625@gmail.com**.
