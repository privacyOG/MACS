# MACS LawnQuote

MACS LawnQuote is the website, PWA-style operations app, and Android WebView app for lawn mowing, gardening maintenance, and small landscaping quotes.

It gives MACS a single place to quote jobs, manage saved customers, schedule recurring work, handle invoices, manage crew profiles, and publish Android APK downloads for field use.

## Run

```bash
npm start
```

By default the app listens on `0.0.0.0:18890`, so another device on the same LAN can open:

```text
http://<this-computer-ip>:18890
```

## Current Scope

- Browser/PWA style frontend for desktop and mobile
- Android app wrapper that opens the live MACS field schedule
- No paid map, satellite, or AI API dependency
- Local quote history via browser storage
- Photo preview in the browser
- Time-based pricing engine for mowing, edging, cleanup, travel, and difficulty
- Adjustable business rates
- Manual map/polygon lawn measurement using Leaflet and OpenStreetMap tiles
- Address autocomplete via OpenStreetMap Nominatim
- NSW Spatial Services cadastre overlay for lot/property boundary and lot labels
- SIX Maps PropertyAddress overlay for street address/property numbers
- Map layer controls are outside the map viewport so they do not cover the area being measured
- Device/browser detection for mobile, tablet, and desktop layouts
- Printable/customer-facing quote sheet using the browser's built-in print-to-PDF
- Itemized price breakdown for labour, waste, margin, and estimated time components
- Saved quote management with view, edit, print, and delete actions
- Admin, customer, crew, schedule, invoice, profile, reporting, and security screens
- Optional PostgreSQL storage for shared server data
- Server-side account, roster, login activity, security audit, and encrypted backup support

## Android

The Android app lives in `android/` and loads:

```text
https://macs.rctrusts.com/schedule.html
```

Debug build:

```bash
cd android
./gradlew assembleDebug
```

Release signing uses environment variables listed in `.env.example`.

## Next Useful Steps

- Add offline install/service worker
- Add PDF quote export
- Add offline vendor copies for Leaflet assets if you want the app to load without CDN access
- Add optional satellite imagery source if a free/compliant provider is chosen
- Consider replacing Nominatim with an address search service you control if usage grows
- Cadastral lot numbers are not the same as street/property address numbers; use the Street address numbers overlay when matching an address like `94 Little Road`
- Add business branding fields for the printable quote once the business name/ABN/contact details are known
- Add SQLite or server-side storage when multiple devices need shared data
