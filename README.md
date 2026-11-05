# QuoteSnap

Photo-to-quote estimating for **tree care** and **snow removal** contractors.

Take photos, type (or say) a few words, and get a priced, professional quote:

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
| Capture | Camera photos (auto-compressed), voice dictation, instant auto-fill from notes |
| ✨ AI (optional) | Claude reads your photos and notes and fills in species, height, trunk size, access and hazards, plus site notes to double-check. Pricing always stays with your price book |
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

On a phone, open the hosted URL and choose **Add to Home Screen** to install it. Any static host works: GitHub Pages, Netlify, Cloudflare Pages.

Tip: **Settings → Load sample quotes** fills the app with demo data.

### AI photo analysis

In **Settings → AI photo analysis**, paste an Anthropic API key from <https://platform.claude.com/settings/keys>. The key is stored only on the device. Requests go straight from the browser to Anthropic using the official SDK. The app asks for structured JSON output and turns on server-side refusal fallback. Default model: `claude-opus-5-5`.

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
js/ai.js             optional Claude photo analysis
js/store.js          IndexedDB storage + image compression
sw.js                offline cache
```
