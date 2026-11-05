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

## Easy to use, hands-free

- **First-run setup (2 minutes, all skippable):** one question per screen with big buttons. It asks what work you do; your business name and phone; your crew size and pay (with **+ / −** buttons, no typing); how many of each machine you have; and where your shop is. Your answers build **My Resources**, so the first quote is priced with your own crew and equipment. It ends with a 3-step "how it works" and an offer to open a sample quote.
- **Tips that point at the real buttons** the first time you open each screen, and a **?** help button on every screen to show them again.
- **Big, plain dialogs** instead of tiny browser pop-ups, for example "Delete quote? [Cancel] [Delete]".
- **Step bar on every quote** (Photos → Customer → Details → Price → Send) with ✓ for each finished step. A **Send bar** stays at the bottom with the price and what to do next.
- **Simple screens** (on by default): extra charges, rush or weekend work, and the price details are folded away until needed. **Large and extra-large text** are in Settings → Easy to use.
- **Hands-free quoting:**
  1. Snap photos. The app checks them, fills in the job, and fills in the address from GPS.
  2. If the address matches an earlier customer, it fills in their name and phone ("👋 Returning customer").
  3. If not, it asks **"Who is this quote for?"**: say their name and number, pick from contacts, or type it.
  4. It can **read the price out loud** when the quote is ready.
  5. Say **"send it"** while talking to open Send.
  6. When the customer accepts, it offers **the next open weekday** for the job.
- **Safety:** a far-away GPS fix or mistyped address (over 200 miles from the shop) never fills in the distance; the app warns you instead.

## More features

| Area | What you get |
|---|---|
| Snap & go | One tap opens the camera, photos analyze automatically, the address fills in from GPS, and miles are worked out from your shop |
| 🧠 On-device AI (default) | Runs in the browser: free, private, no API key, works offline. Fills in job type, species, dead/fallen trees, stumps, power lines, house nearby, fence, rough height, access, snow surface, ice and lot size, plus photo captions, what to confirm, and suggested extras. See **On-device AI** below |
| ✨ Claude cloud AI (optional) | Off unless you choose it in Settings. Claude fills in division, every tree (species, height, trunk, condition), access, hazards, debris and stumps, or snow area, sidewalks, roof, salt and obstacles. It also writes photo captions for the PDF, a customer summary, things to check on site, what it couldn't tell, and extra work to offer (one-tap **+ Add**). AI-filled fields are outlined in purple, anything you change is never overwritten, and **Undo** reverts it all. Pricing always comes from your price book |
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

### Photo analysis: nothing to set up

Photo analysis works out of the box with the **on-device AI**: no account, no API key, no cost. The first time the app opens it downloads the AI in the background (about 10 MB of model plus a 14–27 MB runtime, served from this repository), and from then on it works offline.

Also set **Settings → 📍 Location → Set shop from business address** so the distance to each job fills in by itself.

**Optional: Claude cloud AI.** For more detailed analysis (reads your notes, estimates trunk size, writes richer captions), pick **Claude cloud AI** in **Settings → ✨ Automatic photo analysis**, paste an Anthropic API key (<https://platform.claude.com/settings/keys>) and tap **Test key**. This sends photos to Anthropic and costs a few cents per analysis, so it is off unless you choose it. The key stays on that device and is left out of backups. The app never falls back to it on its own.

## On-device AI

The default photo analysis runs entirely on the phone or computer. Photos are never uploaded.

```
photo (existing camera / gallery input, already shrunk to 1280 px)
  → js/localai/manager.js   center-crop, resize to 224×224, normalize, + mirrored copy
  → js/localai/worker.js    Web Worker: ONNX Runtime Web, WebGPU → WebAssembly fallback
                            TinyCLIP image encoder → 512-number image embedding
                            compared with pre-computed text embeddings for 59 answers to 16 questions
  → js/localai/interpret.js scores → quote fields (only what the photo shows; notes always win)
  → existing review card, purple outlines, Undo, pricing engine
```

| | |
|---|---|
| Model | **TinyCLIP ViT-8M/16** image encoder (Microsoft, **MIT license**, commercial use allowed), exported to ONNX, 8-bit weights (`MatMulNBits`): **10.3 MB** at `models/tinyclip-vit-8m-16/` |
| Runtime | ONNX Runtime Web 1.30.0 (MIT), vendored in `js/vendor/ort-1.30.0/`. WebGPU devices load the WebGPU build (26.8 MB, ~6.6 MB compressed); others load the CPU build (14.2 MB, ~3.7 MB compressed). Each device downloads only one |
| Speed | About 0.5 s per photo on a laptop CPU with WebAssembly once loaded |
| Questions | `tools/local-ai-questions.json`: tree vs snow vs not-a-job-photo, standing/fallen/stump/hedge/close-up, healthy/dead/bare/storm-damaged, 9 species, size, over/near the house, power lines, leaning, fence, access, snow surface, paved area, snow depth, ice, parked cars, sidewalks |
| Accuracy | Tested on 96 hand-checked Creative Commons photos: job type 67/70, species 20/23 (misses: spruce read as pine, one birch), dead vs healthy 24/26, stumps 14/15, power lines 0.70–0.77 when present vs 0.04–0.13 when absent. Height, driveway size and snow depth are rough, so the app always asks you to confirm them |
| Privacy | No image, thumbnail, embedding or request leaves the device. The only network use is the one-time download of the model files from this site |
| Offline | Model, labels and runtime are stored with the Cache API (`quotesnap-ai-v1`). `sw.js` serves them cache-first. URLs carry the file's checksum, so an update downloads the new version and old ones are deleted |
| Robustness | Checksums verify downloads; a corrupt or truncated file is deleted and re-downloaded. Out-of-memory, unsupported browser (needs WebAssembly SIMD: iOS 16.4+, Chrome/Edge 91+, Safari 16.4+), offline first run and unreadable photos each show a clear message, and the rest of the app keeps working |

**Rebuilding the AI files** (only if you change the questions or the model): `npm run build:ai` (after `pip install torch transformers onnx onnxruntime onnxscript numpy pillow`). It exports and quantizes the model at a pinned revision, checks it against the original, re-embeds the prompts, and writes `config.json` with checksums.

## How estimating works

Every estimate is planned with **your** company: the people and machines in **My Resources**, the speeds in **Production Rates**, and the costs in **Pricing Settings**. Nothing is hard-coded inside the AI, and the planner never assumes unlimited workers or equipment.

### My Resources (Settings → Business setup, or Resources in the menu)
- **Workers**: name, role, skill level (beginner, intermediate, experienced, expert), hourly cost, overtime rate, active or inactive, and what they can run: heavy equipment, truck, loader, bucket truck, chipper, chainsaw.
- **Equipment**: unlimited items with type (tree and snow categories), quantity owned, quantity available, purchase cost, operating, fuel and maintenance cost per hour, operator required, production rate, availability (available, in the shop, out of season), notes, and **attachments** (plow, salt spreader, snow pusher, snow bucket, grapple).
- A sample crew and fleet ship with the app so estimates work on day one. Edit it or start empty.

### How a job is planned (`js/planner.js`)
1. The job is split into tasks (setup, cutting, chipping, log loading, hauling, stump grinding, cleanup, travel; or plowing, sidewalks, salting, roof, snow hauling).
2. Each task's time = base time + quantity ÷ production rate, adjusted by condition multipliers (difficulty, access, power lines, slope, wet or frozen ground, heavy snow, ice…), tree size and species, removal method and the assigned crew's skill.
3. The crew is picked from **active** workers, making sure someone can run each machine. Machines come only from what's **available**. Fewer people or machines than recommended makes the job take longer, and the quote says why: *"Estimated duration increased because only 1 loader is available."* Missing equipment is either planned around (for example climbing instead of a bucket truck) or priced as a **rental** and flagged.
4. **Labor-hours** (crew × time) and **elapsed time** (clock time, including tasks that overlap) are kept separate.

### Price (`Pricing Settings`)
Labor + equipment + fuel + disposal (brush, logs, leaves, stumps, snow, general debris, per load) + travel (per mile, minimum charge, travel time paid for the crew) + other costs (materials, mobilization) + overhead = **total job cost**. Then the target gross margin, markups (emergency/urgent, storm, weekend, holiday, commercial, residential) and minimum profit give the **recommended selling price**. Overtime rates apply to emergency, storm, weekend and holiday jobs.

### Production Rates
An editable record per task: job type, task, minimum and recommended crew, equipment, production unit, rate, base time, notes, plus how strongly the task is affected by difficulty, access, cleanup, crew experience and weather. All difficulty multipliers (easy 1.00× … extremely difficult 2.00×, and every job condition) are editable on the same page.

### Learning from completed jobs (controlled, never automatic)
When a customer accepts, the original estimate is frozen. After the job, set the quote to **Completed** and fill in **Actual job**: workers, equipment, start and finish, labor and equipment hours, fuel, disposal, travel, materials, total cost, selling price, problems, weather, difficulty and notes. The quote shows **estimated vs actual**. Once 3 or more completed jobs show the same task running 10%+ fast or slow, **Production Rates → Learn from completed jobs** suggests a new rate. It changes only when you tap **Apply**, and every change is logged.

### AI job analysis
Photos produce a structured analysis with **ranges and a confidence for each item**. Tree jobs: number of trees, species, height, trunk and branch size, condition, nearby buildings, power lines, roads and vehicles, front or back yard, access, slope, brush, logs, debris and stump size. Snow jobs: area, driveway or lot size, parking spaces, sidewalks, depth, snow type, ice, existing piles, plowing difficulty, obstacles and tight areas. Required equipment and crew come from the planner. Things a photo can't show (lean direction, gate width, number of entrances) say so instead of guessing.

## Develop

```bash
npm test             # node --test: engine, planner, learning, auto-fill and on-device AI tests
npm run build:ai     # optional: rebuild models/tinyclip-vit-8m-16 (Python, see On-device AI)
```

```
index.html           app shell
css/styles.css       UI + print (PDF) styles, light/dark
js/app.js            views: dashboard, editor, documents, send/sign, price book, settings
js/engine.js         parsing, scope of work, customer options (no DOM)
js/planner.js        resource-aware task planning, bottlenecks, cost and price
js/company.js        workers, equipment, production rates, multipliers (defaults + sample)
js/learning.js       estimated vs actual, rate suggestions
js/views-company.js  My Resources, Production Rates, Pricing Settings pages
js/guide.js          big dialogs, one-time tips, voice (listen / speak)
js/onboarding.js     first-run setup + tutorial
js/pricebook.js      default rates
js/ai.js             optional Claude cloud photo analysis (schema + prompt)
js/localai/          on-device AI: manager (page side), worker (ONNX Runtime), interpret (scores → fields)
models/              on-device AI model, labels and config (+ license)
tools/               build_local_ai.py + the question list used to make models/
js/vendor/ort-1.30.0 ONNX Runtime Web (MIT)
js/geo.js            GPS, address lookup (OpenStreetMap), distance, forecast (Open-Meteo)
js/pdf.js            real PDF files for sharing (vendored jsPDF + html2canvas, MIT)
js/store.js          IndexedDB storage (memory fallback) + image compression
sw.js                offline cache
```
