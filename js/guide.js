// Friendly UI helpers: big dialogs, one-time tips that point at the real buttons, the
// first-run setup + tutorial, and voice (listen / speak). Made for people who don't use
// phones much: one question per screen, big buttons, plain words, everything skippable.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function dialog() {
  let d = document.getElementById('askdlg');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'askdlg';
    d.className = 'modal ask';
    document.body.appendChild(d);
  }
  return d;
}

// Yes/no question with big buttons. Resolves true/false.
export function ask(message, { title = '', ok = 'Yes', cancel = 'Cancel', danger = false, icon = '' } = {}) {
  const d = dialog();
  d.innerHTML = `<div class="mb">
    ${icon ? `<div class="ask-icon">${icon}</div>` : ''}
    ${title ? `<h2>${esc(title)}</h2>` : ''}
    <p class="ask-msg">${esc(message).replace(/\n/g, '<br>')}</p>
    <div class="ask-btns">
      ${cancel ? `<button class="btn big" data-r="0">${esc(cancel)}</button>` : ''}
      <button class="btn big ${danger ? 'dangerfill' : 'primary'}" data-r="1">${esc(ok)}</button>
    </div></div>`;
  return new Promise((resolve) => {
    const done = (v) => { d.close(); resolve(v); };
    d.querySelectorAll('[data-r]').forEach((b) => (b.onclick = () => done(b.dataset.r === '1')));
    d.oncancel = (e) => { e.preventDefault(); done(false); };
    d.showModal();
  });
}

// Pick one of several big choices. options: [{ id, label, sub, icon }]. Resolves id or null.
export function choose(title, options, { message = '', cancel = 'Not now' } = {}) {
  const d = dialog();
  d.innerHTML = `<div class="mb">
    <h2>${esc(title)}</h2>${message ? `<p class="ask-msg">${esc(message)}</p>` : ''}
    <div class="choices">${options.map((o) => `<button class="choice" data-id="${esc(o.id)}"><span class="choice-icon">${o.icon || ''}</span><span><b>${esc(o.label)}</b>${o.sub ? `<br><span class="small muted">${esc(o.sub)}</span>` : ''}</span></button>`).join('')}</div>
    ${cancel ? `<button class="btn block" data-none style="margin-top:.6rem">${esc(cancel)}</button>` : ''}</div>`;
  return new Promise((resolve) => {
    const done = (v) => { d.close(); resolve(v); };
    d.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => done(b.dataset.id)));
    const n = d.querySelector('[data-none]');
    if (n) n.onclick = () => done(null);
    d.oncancel = (e) => { e.preventDefault(); done(null); };
    d.showModal();
  });
}

// One pricing question per screen, with big buttons, a progress bar and the live price.
// q: { title, sub, why, kind: 'one'|'yesno'|'many', options: [{ id, label, icon, sub }], noneLabel, auto }
// Resolves { action: 'answer', value } | { action: 'skip' } | { action: 'back' } | { action: 'done' }.
// One-choice questions answer on the first tap; "tick all" questions answer with Next.
export function questionStep(q, { step = 1, total = 1, selected = null, guessed = false, price = '', canBack = false } = {}) {
  const d = dialog();
  const many = q.kind === 'many';
  const on = new Set(many ? selected || [] : selected != null ? [selected] : []);
  const pct = Math.round(((step - 1) / Math.max(1, total)) * 100);
  const optBtn = (o) => `<button class="choice ${on.has(o.id) ? 'on' : ''}" data-id="${esc(o.id)}" ${many ? `aria-pressed="${on.has(o.id)}"` : ''}>
      ${many ? `<span class="tick" aria-hidden="true">${on.has(o.id) ? '✓' : ''}</span>` : ''}
      ${o.icon ? `<span class="choice-icon">${o.icon}</span>` : ''}<span><b>${esc(o.label)}</b>${o.sub ? `<br><span class="small muted">${esc(o.sub)}</span>` : ''}</span></button>`;
  d.innerHTML = `<div class="mb qstep">
    <div class="q-top"><span class="tiny muted">Question ${step} of ${total}</span>${price ? `<span class="q-price" id="qprice">${esc(price)}</span>` : ''}</div>
    <div class="q-bar"><span style="width:${pct}%"></span></div>
    <h2>${esc(q.title)}</h2>
    ${q.sub ? `<p class="ask-msg center">${esc(q.sub)}</p>` : ''}
    ${guessed ? '<p class="tiny purple center">✨ The photo AI picked the outlined answer. Tap to confirm or change it.</p>' : ''}
    <div class="choices${q.options.length > 5 && !many ? ' two' : ''}">
      ${q.auto ? optBtn(q.auto) : ''}${q.options.map(optBtn).join('')}
      ${many ? `<button class="choice none ${on.size ? '' : 'on'}" data-none><span class="choice-icon">👍</span><span><b>${esc(q.noneLabel || 'None of these')}</b></span></button>` : ''}
    </div>
    ${q.why ? `<p class="tiny muted q-why">💡 ${esc(q.why)}</p>` : ''}
    ${many ? '<button class="btn big primary block" data-next style="margin-top:.6rem">Next →</button>' : ''}
    <div class="q-nav">
      <button class="btn" data-back ${canBack ? '' : 'disabled'}>← Back</button>
      <button class="btn" data-skip>Skip</button>
      <button class="btn" data-done>Done for now</button>
    </div></div>`;
  return new Promise((resolve) => {
    const done = (v) => { d.close(); resolve(v); };
    d.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => {
      const id = b.dataset.id;
      if (!many) { done({ action: 'answer', value: id }); return; }
      if (on.has(id)) on.delete(id); else on.add(id);
      b.classList.toggle('on', on.has(id));
      b.setAttribute('aria-pressed', on.has(id));
      b.querySelector('.tick').textContent = on.has(id) ? '✓' : '';
      d.querySelector('[data-none]').classList.toggle('on', !on.size);
    }));
    const none = d.querySelector('[data-none]');
    if (none) none.onclick = () => done({ action: 'answer', value: [] });
    const next = d.querySelector('[data-next]');
    if (next) next.onclick = () => done({ action: 'answer', value: [...on] });
    d.querySelector('[data-back]').onclick = () => done({ action: 'back' });
    d.querySelector('[data-skip]').onclick = () => done({ action: 'skip' });
    d.querySelector('[data-done]').onclick = () => done({ action: 'done' });
    d.oncancel = (e) => { e.preventDefault(); done({ action: 'done' }); };
    d.showModal();
    d.querySelector('.choice.on, .choice')?.focus({ preventScroll: true });
  });
}

// ---------- one-time tips that point at a part of the screen ----------

// steps: [{ el: '#selector', text, title }]. Shown once per `key` unless force.
export async function coach(key, steps, seen, save, { force = false } = {}) {
  if (!force && seen[key]) return;
  const list = steps.filter((s) => document.querySelector(s.el));
  if (!list.length) return;
  seen[key] = true;
  save();
  coach.stop?.(); // only one set of tips at a time
  const layer = document.createElement('div');
  layer.className = 'coach-layer';
  document.body.appendChild(layer);
  try {
    for (let i = 0; i < list.length; i++) {
      const target = document.querySelector(list[i].el);
      if (!target) continue;
      target.scrollIntoView({ block: 'center', behavior: 'instant' in document.documentElement.style ? 'instant' : 'auto' });
      await new Promise((r) => setTimeout(r, 120));
      const r = target.getBoundingClientRect();
      const H = window.innerHeight;
      const top = Math.max(4, r.top - 6);
      const bottom = Math.min(H - 4, r.bottom + 6);
      layer.innerHTML = `<div class="coach-ring" style="top:${top}px;left:${r.left - 6}px;width:${r.width + 12}px;height:${Math.max(20, bottom - top)}px"></div>
        <div class="coach-pop" style="top:0;visibility:hidden">
          <div class="tiny muted">Tip ${i + 1} of ${list.length}</div>
          ${list[i].title ? `<b>${esc(list[i].title)}</b><br>` : ''}${esc(list[i].text)}
          <div class="row" style="margin-top:.7rem"><button class="btn" data-skip>Skip tips</button><div class="spacer"></div><button class="btn primary" data-next>${i === list.length - 1 ? 'Got it' : 'Next'}</button></div>
        </div>`;
      // place the tip below the highlighted part, else above it, else at the bottom of the screen
      const pop = layer.querySelector('.coach-pop');
      const ph = pop.offsetHeight;
      let y = bottom + 10;
      if (y + ph > H - 8) y = top - ph - 10;
      if (y < 8) y = H - ph - 12;
      pop.style.top = `${Math.max(8, y)}px`;
      pop.style.visibility = 'visible';
      const go = await new Promise((resolve) => {
        layer.querySelector('[data-next]').onclick = () => resolve(true);
        layer.querySelector('[data-skip]').onclick = () => resolve(false);
        // leaving the screen (back button, menu) ends the tips
        coach.stop = () => resolve(false);
        window.addEventListener('hashchange', coach.stop, { once: true });
      });
      window.removeEventListener('hashchange', coach.stop);
      if (!go) break;
    }
  } finally {
    layer.remove();
    coach.stop = null;
  }
}

// ---------- voice ----------

export const canListen = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);
export const canSpeak = () => 'speechSynthesis' in window;

export function speak(text) {
  if (!canSpeak()) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    speechSynthesis.speak(u);
  } catch { /* ignore */ }
}

// Listen once; resolves the whole transcript ('' if nothing heard). Shows a big "listening" sheet.
export function listen({ prompt = 'Listening…', hint = '' } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return Promise.resolve(null);
  const d = dialog();
  d.innerHTML = `<div class="mb center"><div class="mic-pulse">🎤</div><h2>${esc(prompt)}</h2>${hint ? `<p class="ask-msg">${esc(hint)}</p>` : ''}
    <p class="heard small" id="heard"></p><button class="btn big primary block" data-stop>Done</button></div>`;
  d.showModal();
  return new Promise((resolve) => {
    const rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = true;
    let final = '';
    let finished = false;
    const finish = () => { if (finished) return; finished = true; try { rec.stop(); } catch { /* ignore */ } d.close(); resolve(final.trim()); };
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) final += ev.results[i][0].transcript + ' ';
        else interim += ev.results[i][0].transcript;
      }
      const h = d.querySelector('#heard');
      if (h) h.textContent = (final + interim).trim();
    };
    rec.onerror = () => finish();
    rec.onend = () => finish();
    d.querySelector('[data-stop]').onclick = finish;
    d.oncancel = (e) => { e.preventDefault(); finish(); };
    try { rec.start(); } catch { finish(); }
  });
}

// Say a price the way people say it.
export function sayMoney(n) {
  const v = Math.round(n);
  return v >= 1000 ? `${v.toLocaleString('en-US')} dollars` : `${v} dollars`;
}
