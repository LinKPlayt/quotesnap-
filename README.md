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
- **Customer quote** with **Good / Better / Best options** (Cut down & logs left, Cut down & haul away, Everything + stump for trees; Each snowfall, Each snowfall + salt, Whole winter for snow).
- **Profit estimate**: cost breakdown, gross profit, margin, profit per crew hour, break-even price, live margin slider.
- **Professional PDF**: branded quote with photos, options, pricing, deposit, terms and signature. Also an **invoice** and an internal **crew job sheet** (equipment checklist, safety briefing, no prices).
- **Send**: email, text or share sheet with a ready-written message, plus one-tap follow-ups.

## Easy to use, hands-free

- **First-run setup (2 minutes, all skippable):** one question per screen with big buttons. It asks what work you do; your business name and phone; your crew size and pay (with **+ / −** buttons, no typing); how many of each machine you have; and where your shop is. Your answers build **My Resources**, so the first quote is priced with your own crew and equipment. It ends with a 3-step "how it works" and an offer to open a sample quote.
- **Tips that point at the real buttons** the first time you open each screen, and a **?** help button on every screen to show them again.
- **Big, plain dialogs** instead of tiny browser pop-ups, for example "Delete quote? [Cancel] [Delete]".
- **Step bar on every quote** (Photos → Customer → Details → Price → Send) with ✓ for each finished step. A **Send bar** stays at the bottom with the price and what to do next.
- **Simple screens** (on by default): the fewest questions and fields. The Details card shows only what moves the price: what, how tall, how many, can a truck get to it, how it comes down, what happens to the wood, the stump, and anything risky. Everything rare (lawn, firewood, extra conditions, snow depth, roof, obstacles, equipment) is folded under **More options**, which counts what's set inside. Turn it off in Settings → Easy to use for every field. **Large and extra-large text** are in Settings → Easy to use.
- **Hands-free quoting:**
  1. Snap photos. The app checks them, fills in the job, and fills in the address from GPS.
  2. If the address matches an earlier customer, it fills in their name and phone ("👋 Returning customer").
  3. If not, it asks **"Who is this quote for?"**: say their name and number, pick from contacts, or type it.
  4. Then it asks the **pricing questions** a photo can't answer (see below), one tap each.
  5. It can **read the price out loud** when the quote is ready.
  6. Say **"send it"** while talking to open Send.
  7. When the customer accepts, it offers **the next open weekday** for the job.
- **Pricing questions (`js/questions.js`):** one question per screen, big buttons, plain words, the live price and a progress bar. With simple screens a tree quote asks at most 9 questions, about 7 once the photo and GPS have filled in the job type and distance: how many trees, what needs doing, how tall (5 sizes), can a truck get to it, anything risky (power lines, a building, a fence or garden, dead wood), **how it comes down** (in one piece, or in sections), what happens after (wood and stump in one question), and how far. A snow quote asks home or business, size, sidewalks, salt, how they pay, and distance. Turning simple screens off adds trunk, kind of tree, extra conditions, firewood, lawn, permit, timing, snow depth, ice, obstacles, roof, hauling, priority and storms per season. Questions follow the answers, the AI's guess is shown as the starting answer to confirm, and a field you already changed by hand is never asked again. **Back**, **Skip** and **Done for now** work on every question. The Details card shows how many are left, the Details step is ✓ only when they are answered, and Send warns if any are still open. Turn off the automatic start in Settings → Easy to use.
- **Cut down from the ground, in one piece:** when there's room for the tree to fall, pick "In one piece" (or say "room to fall" / "drop it in one piece" in your notes). The crew drops it whole, cuts it up on the ground and hauls it: no climbing, no bucket truck, no crane, and usually the lowest price. It's offered only when nothing is in the way. If power lines, a building, a fence or garden, parked cars or a road are there, or no truck can get in, it isn't offered, and if those are added later the quote says why and prices the tree in sections instead.
- **Customer options in plain words:** *Cut down, logs left* · *Cut down & haul away* · *Everything + stump* for trees; *Each snowfall* · *Each snowfall + salt* · *Whole winter* for snow.
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
5. **Auto equipment is the lowest-cost safe way to do the job** with your machines, renting only when that is cheaper. For trees the planner prices climbing, your bucket truck, a spider lift and a crane, and keeps the cheapest one that is safe. Cutting a tree down from the ground in one piece is never picked on its own, because only you can see whether there is room for it to fall; choose it with "How it comes down". Safety comes first: a crane over 75 ft or for a big dead tree over a house, dead wood 25 ft+ is never climbed, a bucket truck needs the driveway, and only compact machines go through a backyard gate. For snow it prices your plow trucks, skid steer, loader, blower and shovels the same way. A commercial lot always gets at least one unit per 1.5 acres so it's clear in time, plus one more when that costs less. The quote says why: *"Bucket truck: faster than climbing and the lowest-cost safe way to do this job."*
6. **Crew and trucks are sized like a contractor would:** small trees (about 2 hours of cutting) are a 2-person job, and so is cabling. Chips and logs share one truck when they fit, and each truck's last load goes to the dump on the way home, so the crew never waits for it. A second loader or dump truck comes only when it saves more than it costs to bring. On snow visits the operator clears short home walks after plowing. Longer or commercial walks get a sidewalk crew, and everyone (plow operators, truck drivers) helps with walks and roof once their own part is done. Shoveling goes to the lowest-cost people, machines to the most skilled.
7. **Bigger, harder or more work is never cheaper.** Every choice above is the cheapest of a fixed set of safe options, and that set only shrinks as a job gets bigger or harder. So a taller tree, a thicker trunk, worse access, an extra hazard, a bigger lot or more sidewalk can only raise the price. `tests/pricing-sense.test.mjs` checks this on every input and thousands of random jobs.

### Price (`Pricing Settings`)
Labor + equipment + fuel + disposal (brush, logs, leaves, stumps, snow, general debris, per load) + travel (per mile, minimum charge, travel time paid for the crew) + other costs (materials, mobilization) + overhead = **total job cost**. Then the target gross margin, markups (emergency/urgent, storm, weekend, holiday, commercial, residential) and minimum profit give the **recommended selling price**. Overtime rates apply to emergency, storm, weekend and holiday jobs.

### Production Rates
An editable record per task: job type, task, minimum and recommended crew, equipment, production unit, rate, base time, notes, plus how strongly the task is affected by difficulty, access, cleanup, crew experience and weather. All difficulty multipliers (easy 1.00× … extremely difficult 2.00×, and every job condition) are editable on the same page.

### Learning from completed jobs (controlled, never automatic)
When a customer accepts, the original estimate is frozen. After the job, set the quote to **Completed** and fill in **Actual job**: workers, equipment, start and finish, labor and equipment hours, fuel, disposal, travel, materials, total cost, selling price, problems, weather, difficulty and notes. The quote shows **estimated vs actual**. Once 3 or more completed jobs show the same task running 10%+ fast or slow, **Production Rates → Learn from completed jobs** suggests a new rate. It changes only when you tap **Apply**, and every change is logged.

### AI job analysis
Photos produce a structured analysis with **ranges and a confidence for each item**. Tree jobs: number of trees, species, height, trunk and branch size, condition, nearby buildings, power lines, roads and vehicles, front or back yard, access, slope, brush, logs, debris and stump size. Snow jobs: area, driveway or lot size, parking spaces, sidewalks, depth, snow type, ice, existing piles, plowing difficulty, obstacles and tight areas. Required equipment and crew come from the planner. Things a photo can't show (lean direction, gate width, number of entrances) say so instead of guessing.

## Auto pricing and live fuel prices

**Pricing → 🤖 Auto pricing** works out costs from your company and today's fuel prices, with no AI service and no API key:

- **Fuel prices, every day.** `.github/workflows/fuel.yml` runs daily on GitHub (free on a public repo) and saves the U.S. Energy Information Administration's weekly retail prices for regular gas and diesel to `data/fuel.json`. The app picks the most local price there is for your shop: a nearby city (Boston, Chicago, Denver…), then your state, then your region (New England, Midwest…), then the U.S. average. EIA publishes regional averages once a week, not the price at one station, so you can type your own price (a fleet card, for example) to replace it.
- **Updates by themselves, once a day:** each machine's fuel cost per hour (its gallons per hour × today's price; set your own gal/hr per machine in My Resources), the fuel cost of rental machines, and the travel cost per mile (vehicles × fuel ÷ mpg + wear). A number you type in yourself is never overwritten.
- **Suggestions you approve:** your smallest tree job and snow visit, raised if they don't cover a short visit plus your margin; overhead %, from your yearly overhead, crew size and hours; the default pay, from your workers' average; and machine ownership cost, from the purchase price, only when your number looks too low. Every change is logged under *Recent price changes*.
- **Locked prices on sent quotes.** When a quote leaves Draft, it keeps the prices it was made with, so a fuel change never moves a number the customer already has. The quote shows what today's costs would give, and **Use today's prices** re-prices it on purpose.

**Distance to the job** is filled in from where the photo was taken (its EXIF location, when the phone saved one), otherwise from where you're standing, or from the address. It is driving distance by road from your shop (OSRM, free, no key), with a straight-line estimate when offline. Many phones and photo pickers strip the location from photos, so the phone's own location is the usual fallback.

Run the fuel update by hand: `python3 tools/fetch_fuel.py` (or **Actions → Update fuel prices → Run workflow** on GitHub).

## Develop

```bash
npm test             # node --test: engine, planner, learning, auto-fill, on-device AI, auto pricing, pricing questions, pricing sense, logic and fuzz tests
SENSE_SEED=7 SENSE_N=20000 node --test tests/pricing-sense.test.mjs   # more random "more work never cheaper" pairs
FUZZ_SEED=42 FUZZ_N=5000 node --test tests/fuzz.test.mjs   # heavier fuzz run; any failure replays from its seed
npm run build:ai     # optional: rebuild models/tinyclip-vit-8m-16 (Python, see On-device AI)
```

**Logic tests** (`tests/logic.test.mjs`) pin exact business rules: discounts never go negative, tax after discount, debris and stump options, travel radius, minimum charges, rental minimums, emergency and commercial markups, seasonal contract math, inactive workers and equipment in the shop never scheduled, and safety limits.

**Fuzz tests** (`tests/fuzz.test.mjs`, helpers in `tests/helpers/fuzzgen.mjs`) throw thousands of random and broken jobs, companies and price books at the planner (typos like `1000000000`, `abc`, negatives, unknown choices). They check that every quote stays finite, profit = price − cost, the cost lines add up, price is at least cost + minimum profit, the crew never exceeds active workers, equipment in the shop is never used, and no "NaN" or "undefined" reaches the customer. Metamorphic rules: a higher margin never lowers the price, adding a tree never makes the same crew cheaper, and more skilled workers never make the same plan both slower and dearer.

**Pricing sense tests** (`tests/pricing-sense.test.mjs`) sweep every input on four companies (the sample, a tiny 2-person one, an empty one and a double-size one). Each sweep runs from less work to more: height, trunk, count, access, distance, debris, trim level, extras, every hazard and condition, timing, snow area across every equipment threshold, depth, walks, roof, salt, hauling, priority, obstacles, home vs business. The price may never drop, and depth tiers and Good/Better/Best options stay in order. Random pairs (one extra bit of work) check the same. Also pinned: auto equipment is never dearer than any safe manual pick, nothing is billed for 0 hours, no wheel loader goes through a gate, seasonal contracts follow the salt answer, and typical jobs land in realistic price ranges.

**Safety limits:** typo values are capped and the quote says so: trees per row 100, height 400 ft, pay $500/hr, machine cost $1,500/hr per line, production rates within 10%–10× of the standard rate.

```
index.html           app shell
css/styles.css       UI + print (PDF) styles, light/dark
js/app.js            views: dashboard, editor, documents, send/sign, price book, settings
js/engine.js         parsing, scope of work, customer options (no DOM)
js/planner.js        resource-aware task planning, bottlenecks, cost and price
js/autoprice.js      auto pricing: local fuel prices, fuel per machine, cost per mile, suggestions
js/exif.js           where and when a photo was taken (EXIF GPS), no library
data/fuel.json       weekly EIA gas and diesel prices, refreshed daily by .github/workflows/fuel.yml
tools/fetch_fuel.py  the daily fuel price fetcher (standard library Python)
js/company.js        workers, equipment, production rates, multipliers (defaults + sample)
js/learning.js       estimated vs actual, rate suggestions
js/views-company.js  My Resources, Production Rates, Pricing Settings pages
js/guide.js          big dialogs, one-time tips, voice (listen / speak)
js/onboarding.js     first-run setup + tutorial
js/questions.js      the pricing questions: which are still open, and writing answers into the job
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
