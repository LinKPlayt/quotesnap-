// First-run setup and tutorial. One question per screen, big buttons, everything optional.
// The answers build My Resources (crew + equipment), the business details and the shop location,
// so the very first quote is already priced with the company's own numbers.

import { newWorker, newEquipment } from './company.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TREE_EQ = [
  ['bucket_truck', 'Bucket truck', '🚚', 1], ['chipper', 'Chipper', '🌿', 1], ['stump_grinder', 'Stump grinder', '⚙', 1],
  ['dump_truck', 'Dump truck', '🚛', 1], ['skid_steer', 'Skid steer / loader', '🚜', 1], ['chainsaw', 'Chainsaws', '🪚', 3],
  ['climbing_gear', 'Climbing gear', '🧗', 1], ['crane', 'Crane', '🏗', 0],
];
const SNOW_EQ = [
  ['plow_truck', 'Plow truck', '🚙', 1], ['salt_spreader', 'Salt spreader', '🧂', 1], ['loader', 'Wheel loader', '🚜', 0],
  ['skid_steer', 'Skid steer / pusher', '🚜', 0], ['walk_blower', 'Snow blower', '❄', 1], ['dump_truck', 'Dump truck', '🚛', 0],
];

export function runOnboarding(ctx) {
  const { S } = ctx;
  const st = S.settings;
  const a = {
    work: st.work || 'both',
    name: st.business.name === 'Your Tree & Snow Co.' ? '' : st.business.name,
    owner: st.business.owner, phone: st.business.phone,
    crew: Math.max(1, S.company.sample ? 3 : S.company.workers.filter((w) => w.active !== false).length || 3),
    pay: 22,
    eq: {},
    keepSample: false,
    speak: !!st.voice?.speak,
    big: st.textSize === 'large',
  };
  for (const [k, , , n] of [...TREE_EQ, ...SNOW_EQ]) a.eq[k] = a.eq[k] ?? n;

  const el = document.createElement('div');
  el.className = 'onb';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  document.body.appendChild(el);
  document.body.classList.add('noscroll');

  let step = 0;
  const steps = ['welcome', 'work', 'business', 'crew', 'equipment', 'shop', 'comfort', 'how'];
  const stepper = (key, label, icon, min = 0, max = 20) => `
    <div class="stepper-row"><span class="st-label">${icon} ${esc(label)}</span>
      <div class="stepper"><button class="st-btn" data-dec="${key}" aria-label="Less">−</button><span class="st-val" id="v-${key}">${getv(key)}</span><button class="st-btn" data-inc="${key}" aria-label="More">+</button></div></div>`;
  function getv(key) { return key === 'crew' ? a.crew : key === 'pay' ? `$${a.pay}` : a.eq[key]; }

  return new Promise((resolve) => {
    const finish = async (goal) => {
      apply();
      await ctx.saveSettings();
      await ctx.saveCompany();
      el.remove();
      document.body.classList.remove('noscroll');
      resolve(goal);
    };

    function apply() {
      st.onboarded = true;
      st.work = a.work;
      if (a.name) st.business.name = a.name;
      if (a.owner) st.business.owner = a.owner;
      if (a.phone) st.business.phone = a.phone;
      st.voice = { ...(st.voice || {}), speak: a.speak };
      st.textSize = a.big ? 'large' : 'normal';
      ctx.applyTextSize();
      if (a.keepSample || !a.sawEquipment) return;
      // build the company's real crew and equipment from the answers
      const C = S.company;
      const has = (k) => (a.eq[k] || 0) > 0;
      C.workers = Array.from({ length: a.crew }, (_, i) => newWorker({
        name: i === 0 ? (a.owner || 'Crew lead') : `Worker ${i + 1}`,
        role: i === 0 ? 'Crew lead' : 'Crew',
        skill: i === 0 ? 'expert' : i === 1 ? 'experienced' : 'intermediate',
        rate: i === 0 ? Math.round(a.pay * 1.3) : a.pay,
        otRate: Math.round((i === 0 ? a.pay * 1.3 : a.pay) * 1.5),
        can: { chainsaw: true, truck: i < 3, chipper: true, bucket: i < 2 && has('bucket_truck'), loader: i < 2, heavy: i < 2 },
      }));
      const eq = [];
      const add = (type, n, over = {}) => { if (n > 0) eq.push(newEquipment(type, { quantity: n, available: n, ...over })); };
      if (a.work !== 'snow') {
        for (const [k, label, , ] of TREE_EQ) if (k !== 'dump_truck' && k !== 'skid_steer') add(k, a.eq[k], { name: label });
      }
      add('dump_truck', a.eq.dump_truck, { name: 'Dump truck' });
      add('skid_steer', a.eq.skid_steer, { name: 'Skid steer', attachments: [...(a.work !== 'snow' ? [{ type: 'grapple', name: 'Grapple' }] : []), ...(a.work !== 'tree' ? [{ type: 'snow_pusher', name: 'Snow pusher' }] : [])] });
      if (a.work !== 'tree') {
        const spreaders = a.eq.salt_spreader || 0;
        for (let i = 0; i < (a.eq.plow_truck || 0); i++) {
          eq.push(newEquipment('pickup', { name: `Plow truck #${i + 1}`, attachments: [{ type: 'plow', name: 'Plow' }, ...(i < spreaders ? [{ type: 'salt_spreader', name: 'Salt spreader' }] : [])] }));
        }
        if (spreaders > (a.eq.plow_truck || 0)) add('salt_spreader', spreaders - (a.eq.plow_truck || 0), { name: 'Salt spreader' });
        add('loader', a.eq.loader, { name: 'Wheel loader', attachments: [{ type: 'snow_pusher', name: 'Snow pusher' }] });
        add('walk_blower', a.eq.walk_blower, { name: 'Snow blower' });
      }
      C.equipment = eq;
      C.sample = false;
    }

    const screens = {
      welcome: () => `<div class="onb-hero">📸</div><h1>Welcome to QuoteSnap</h1>
        <p class="onb-lead">Take a picture of the job. QuoteSnap works out the work and the price. You check it, then send it to the customer.</p>
        <p class="muted">Let's set it up for your company. It takes about 2 minutes and you can change anything later.</p>
        <button class="btn primary big block" data-next>Let's set it up</button>
        <button class="btn big block" data-skipall style="margin-top:.6rem">Skip, just show me around</button>`,
      work: () => `<h1>What work do you do?</h1><p class="onb-lead">Tap one.</p>
        <div class="choices">${[['tree', '🌳', 'Tree work', 'Removal, trimming, stumps'], ['snow', '❄', 'Snow removal', 'Plowing, shoveling, salting'], ['both', '🌳❄', 'Both', 'Trees in summer, snow in winter']].map(([k, i, l, sub]) => `<button class="choice ${a.work === k ? 'on' : ''}" data-work="${k}"><span class="choice-icon">${i}</span><span><b>${l}</b><br><span class="small muted">${sub}</span></span></button>`).join('')}</div>`,
      business: () => `<h1>Your business</h1><p class="onb-lead">This goes at the top of every quote.</p>
        <label class="f big-f">Business name<input id="o-name" value="${esc(a.name)}" placeholder="e.g. Smith Tree & Snow" autocomplete="organization"></label>
        <label class="f big-f">Your name<input id="o-owner" value="${esc(a.owner)}" placeholder="e.g. Joe Smith" autocomplete="name"></label>
        <label class="f big-f">Phone number<input id="o-phone" type="tel" inputmode="tel" value="${esc(a.phone)}" placeholder="e.g. 555-123-4567" autocomplete="tel"></label>`,
      crew: () => `<h1>Your crew</h1><p class="onb-lead">Tap + and − to change the numbers.</p>
        ${stepper('crew', 'People who work on jobs (including you)', '👷', 1, 30)}
        ${stepper('pay', 'Usual pay per hour', '💵', 10, 80)}
        <p class="muted small">You can add names and who can drive or run which machine later in <b>My Resources</b>.</p>`,
      equipment: () => (a.sawEquipment = true) && `<h1>Your equipment</h1><p class="onb-lead">How many of each do you have? Leave 0 if you don't have it.</p>
        ${a.work !== 'snow' ? `<h3>Tree work</h3>${TREE_EQ.map(([k, l, i]) => stepper(k, l, i)).join('')}` : ''}
        ${a.work !== 'tree' ? `<h3>Snow</h3>${SNOW_EQ.filter(([k]) => a.work === 'snow' || !['dump_truck', 'skid_steer'].includes(k)).map(([k, l, i]) => stepper(k, l, i)).join('')}` : ''}
        <button class="btn block" data-keep style="margin-top:.6rem">Keep the sample list instead</button>`,
      shop: () => `<h1>Where is your shop?</h1><p class="onb-lead">So the app can work out driving distance to each job by itself.</p>
        <div class="choices">
          <button class="choice" data-shop="here"><span class="choice-icon">📍</span><span><b>I'm at the shop right now</b><br><span class="small muted">Use this phone's location</span></span></button>
          <button class="choice" data-shop="type"><span class="choice-icon">⌨</span><span><b>Type the address</b></span></button>
        </div>
        <div id="o-shopbox" class="hidden" style="margin-top:.6rem"><label class="f big-f">Shop address<input id="o-shopaddr" placeholder="123 Main St, Town"></label><button class="btn primary big block" data-shopsave>Save address</button></div>
        <p class="small" id="o-shopmsg">${S.settings.geo.shop ? '✓ Shop location saved' : ''}</p>`,
      comfort: () => `<h1>Make it easy to use</h1>
        <div class="choices">
          <button class="choice ${a.big ? 'on' : ''}" data-toggle="big"><span class="choice-icon">🔎</span><span><b>Bigger text</b><br><span class="small muted">${a.big ? 'On' : 'Off'}: easier to read</span></span></button>
          <button class="choice ${a.speak ? 'on' : ''}" data-toggle="speak"><span class="choice-icon">🔊</span><span><b>Read prices out loud</b><br><span class="small muted">${a.speak ? 'On' : 'Off'}: the phone says the price when a quote is ready</span></span></button>
        </div>
        <p class="muted small">The app will ask for the camera, location and microphone the first time it needs them. Tap <b>Allow</b>.</p>`,
      how: () => `<h1>How it works</h1>
        <div class="how"><div class="how-n">1</div><div><b>Tap 📸 Snap a job</b><br>Take 2 or 3 photos: the whole tree (or driveway), and how you'd get to it.</div></div>
        <div class="how"><div class="how-n">2</div><div><b>Check what the app filled in</b><br>Boxes with a <span class="purple">purple outline</span> were filled in for you. Tap any of them to change it.</div></div>
        <div class="how"><div class="how-n">3</div><div><b>Tap the big Send button</b><br>The customer gets a PDF quote by text or email. Done.</div></div>
        <p class="muted small">Need help later? Tap the <b>?</b> button at the top of any screen.</p>
        <button class="btn primary big block" data-done="snap">📸 Snap my first job</button>
        <button class="btn big block" data-done="sample" style="margin-top:.6rem">Show me a sample quote first</button>`,
    };

    const draw = () => {
      const name = steps[step];
      el.innerHTML = `<div class="onb-inner">
        ${step ? `<div class="onb-dots">${steps.slice(1).map((_, i) => `<span class="${i + 1 <= step ? 'on' : ''}"></span>`).join('')}</div>` : ''}
        ${screens[name]()}
        ${step && name !== 'how' ? `<div class="onb-nav"><button class="btn big" data-back>← Back</button><button class="btn primary big" data-next>Next →</button></div>` : ''}
        ${step && name !== 'how' ? '<button class="linkbtn" data-skipall>Skip setup</button>' : ''}
      </div>`;
      wire(name);
      el.scrollTop = 0;
    };
    const save = () => {
      const g = (id) => el.querySelector(id)?.value.trim();
      if (el.querySelector('#o-name')) { a.name = g('#o-name'); a.owner = g('#o-owner'); a.phone = g('#o-phone'); }
    };
    function wire(name) {
      const q = (s) => [...el.querySelectorAll(s)];
      q('[data-next]').forEach((b) => (b.onclick = () => { save(); step = Math.min(steps.length - 1, step + 1); draw(); }));
      q('[data-back]').forEach((b) => (b.onclick = () => { save(); step = Math.max(0, step - 1); draw(); }));
      q('[data-skipall]').forEach((b) => (b.onclick = () => { save(); finish('tour'); }));
      q('[data-work]').forEach((b) => (b.onclick = () => { a.work = b.dataset.work; a.touched = true; step++; draw(); }));
      q('[data-inc],[data-dec]').forEach((b) => (b.onclick = () => {
        const k = b.dataset.inc || b.dataset.dec;
        const d = b.dataset.inc ? 1 : -1;
        a.touched = true;
        if (k === 'crew') a.crew = Math.max(1, Math.min(30, a.crew + d));
        else if (k === 'pay') a.pay = Math.max(10, Math.min(80, a.pay + d));
        else a.eq[k] = Math.max(0, Math.min(20, (a.eq[k] || 0) + d));
        el.querySelector(`#v-${k}`).textContent = getv(k);
      }));
      const keep = el.querySelector('[data-keep]');
      if (keep) keep.onclick = () => { a.keepSample = true; step++; draw(); };
      q('[data-toggle]').forEach((b) => (b.onclick = () => { a[b.dataset.toggle] = !a[b.dataset.toggle]; if (b.dataset.toggle === 'big') { st.textSize = a.big ? 'large' : 'normal'; ctx.applyTextSize(); } if (b.dataset.toggle === 'speak' && a.speak) ctx.speak('Prices will be read out loud.'); draw(); }));
      q('[data-shop]').forEach((b) => (b.onclick = async () => {
        const msg = el.querySelector('#o-shopmsg');
        if (b.dataset.shop === 'type') { el.querySelector('#o-shopbox').classList.remove('hidden'); el.querySelector('#o-shopaddr').focus(); return; }
        msg.textContent = 'Finding your location…';
        try {
          const p = await ctx.getPosition();
          const label = await ctx.reverseGeocode(p.lat, p.lon).catch(() => '');
          S.settings.geo.shop = { lat: p.lat, lon: p.lon, label };
          if (label && !S.settings.business.address) S.settings.business.address = label;
          msg.textContent = `✓ Shop saved${label ? `: ${label}` : ''}`;
        } catch (err) { msg.textContent = err.message; }
      }));
      const ss = el.querySelector('[data-shopsave]');
      if (ss) ss.onclick = async () => {
        const v = el.querySelector('#o-shopaddr').value.trim();
        const msg = el.querySelector('#o-shopmsg');
        if (!v) return;
        S.settings.business.address = v;
        msg.textContent = 'Looking up the address…';
        try { const g = await ctx.geocode(v); S.settings.geo.shop = g; msg.textContent = '✓ Shop saved'; } catch { msg.textContent = 'Saved the address. Distance will be worked out when you have a connection.'; }
      };
      q('[data-done]').forEach((b) => (b.onclick = () => finish(b.dataset.done)));
    }
    draw();
  });
}
