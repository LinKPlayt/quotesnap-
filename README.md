# QuoteSnap

Photo-to-quote estimating for **tree care** and **snow removal** contractors.

**Snap photos, get a quote.** Tap **📸 Snap a job**, take a few pictures, and AI fills in the job: tree height, trunk size, species, hazards, access, snow area and more. The job address comes from your location and the drive distance from your shop. Review it, tap **Send**, and the customer gets a PDF quote. No typing needed.

You can still type or say it if you prefer:

> “Tree removal. 45-foot oak. Backyard access. Requires bucket truck.”

QuoteSnap builds:

- **Scope of work**: customer-ready bullet points (ANSI A300 wording for pruning).
- **Labor estimate**: crew size, on-site hours, person-hours, loaded wage, days.
- **Equipment**: bucket truck, crane, spider lift, chipper, loader, grinder, plow, skid steer and more, with hours, cost and *why* it was picked.
- **Materials**: fuel and wear, dump fees by load, cabling hardware, salt by the pound, permits, lawn restoration.
- **Customer quote** with **Good / Better / Best options** (Essential, Standard, Complete for trees; Per Push, Clear + Salt, Seasonal for snow).
- **Profit estimate**: cost breakdown, gross profit, margin, profit per crew hour, break-even price, live margin slider.
- **Professional PDF**: branded quote with photos, options, pricing, deposit, terms and signature. Also an **invoice** and an internal **crew job sheet** (equipment checklist, safety briefing, no prices).
- **Send**: email, text or share sheet with a ready-written message, plus one-tap follow-ups.

## More features

| Area | What you get |
|---|---|
| Snap & go | One tap opens the camera, photos analyze automatically, the address fills in from GPS, and miles are worked out from your shop |
| ✨ AI photo analysis | Claude fills in division, every tree (species, height, trunk, condition), access, hazards, debris and stumps, or snow area, sidewalks, roof, salt and obstacles. It also writes photo captions for the PDF, a customer summary, things to check on site, what it couldn't tell, and extra work to offer (one-tap **+ Add**). AI-filled fields are outlined in purple, anything you change is never overwritten, and **Undo** reverts it all. Pricing always comes from your price book |
| Hands-free | 🎤 Talk instead of typing. Notes are read as you go: tree size, species, access, hazards, plus the customer's name, phone, email and street address. Quick-pick chips for heights, species and driveway sizes. 📇 Pick from contacts on Android |
| Weather | 7-day snow and wind forecast on the home screen with storm alerts ("6" Saturday", "gusts 52 mph: expect storm calls"). Snow quotes offer to price at the forecast depth |
| Send | **Send PDF + message** opens the share sheet with a real PDF already attached (Messages, Mail, WhatsApp). Quote, follow-up, invoice and review-request messages. Online payment link on quotes and invoices |
| Schedule | Pick a job date after the customer signs, add it to your phone calendar (.ics), and see jobs coming up on the home screen |
| Tree jobs | Multiple trees per quote, remove / trim / stump / cable, 40+ species hardness factors, access levels, hazards (power lines, over house, dead, leaning…), debris options, stump grinding, lawn restore, firewood, emergency/storm rates, permits, travel |
| Snow jobs | Driveways and commercial lots, sidewalks, roof snow, salt, obstacles, priority service, price-by-snowfall tiers (2–4", 4–8", 8–12", 12"+), seasonal contracts with monthly payment plans |
| Close the deal | On-device customer signature and option pick; status pipeline (draft → sent → accepted → scheduled → completed → paid / declined) with history |
| Business | Dashboard (pipeline, won this month, win rate, average margin), follow-up reminders, customer list built automatically, CSV export, quote numbering, your logo and brand color |
| Price book | Wages, burden, crew sizes, overhead, target margin, tax, minimums, deposit, every equipment rate and minimum, materials, snow-contract settings, terms |
| Offline | Installable PWA. Works with no signal on the job site; all data stays on the device (IndexedDB) with backup and restore |

## Run it

No build step. Serve the folder over HTTP (ES modules don't load from `file://`):

```bash
npm start            # python3 -m http.server 8080
# open http://localhost:8080
```

### Use it on your phone (GitHub Pages)

1. On GitHub, open the repo's **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**. Pick the branch with the app and the **/ (root)** folder, then click **Save**.
3. After about a minute the app is live at **https://linkplayt.github.io/quotesnap-/**.
4. Open that link on your phone and tap **Share → Add to Home Screen** (iPhone, Safari) or **⋮ → Install app** (Android, Chrome).

Each phone keeps its own quotes. Use **Settings → Backup / Restore** to move data between devices.

Tip: **Settings → Load sample quotes** fills the app with demo data.

### Turn on automatic photo analysis

1. Get an API key at <https://platform.claude.com/settings/keys>.
2. In the app: **Settings → ✨ Automatic photo analysis**, paste the key, then tap **Test key**.
3. Leave **Analyze photos automatically** on. Every photo you snap now fills in the quote.

Do this on each phone that will snap jobs. The key is stored only on that device and goes straight to Anthropic. It is left out of backups. Each analysis is a few cents of API usage. Opus 5.5 is the most accurate; Sonnet 5.5 and Haiku 5.5 are faster and cheaper.

Also set **Settings → 📍 Location → Set shop from business address** so the distance to each job fills in by itself.

Under the hood, the app uses the official Anthropic SDK with structured JSON output (a strict schema) and server-side refusal fallback. The default model is `claude-opus-5-5`.

## How pricing works

`js/engine.js` is a pure, tested estimating engine:

1. **Hours**: base crew hours come from height and trunk diameter. They are then multiplied by species hardness, access, hazards and the removal method (crane < bucket < lift < climbing). Cleanup time is added for the debris option chosen.
2. **Cost** = labor (person-hours × wage × burden) + equipment (hours × rate, with minimums) + materials + travel, plus overhead %.
3. **Price** = cost ÷ (1 − target margin), rounded, with your minimum job charge applied.

Every rate lives in the Price Book, so the numbers match *your* business.

## Develop

```bash
npm test             # node --test: engine unit tests
```

```
index.html           app shell
css/styles.css       UI + print (PDF) styles, light/dark
js/app.js            views: dashboard, editor, documents, send/sign, price book, settings
js/engine.js         parsing + estimating engine (no DOM)
js/pricebook.js      default rates
js/ai.js             Claude photo analysis (schema + prompt)
js/geo.js            GPS, address lookup (OpenStreetMap), distance, forecast (Open-Meteo)
js/pdf.js            real PDF files for sharing (vendored jsPDF + html2canvas, MIT)
js/store.js          IndexedDB storage (memory fallback) + image compression
sw.js                offline cache
```
