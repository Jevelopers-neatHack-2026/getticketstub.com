/* eslint-disable */
// @ts-nocheck
// The landing page script, ported from the landing-page repo (site/index.html) into one mountable module.
// mountLanding() runs on mount and returns a cleanup that stops every loop, listener, timer, observer and the WebGL context.
// Everything the page owns is looked up inside the landing roots (never document-wide), so the studio start section that sits
// between the hero and the rest of the page is left alone. Scrolling is native: the landing's smooth scroll (Lenis) is not ported.
import { animate, inView, scroll, stagger } from "motion";

export function mountLanding(ctx) {
  const lpRoot = ctx.root, hosts = ctx.hosts;
  let disposed = false;
  const disposers = [];
  // every global the page listens or schedules with goes through these, so cleanup can undo it
  const addEventListener = (t, f, o) => { window.addEventListener(t, f, o); disposers.push(() => window.removeEventListener(t, f, o)); };
  const removeEventListener = (t, f, o) => window.removeEventListener(t, f, o);
  const rafs = new Set(), timers = new Set();
  const requestAnimationFrame = cb => { if (disposed) return 0; const id = window.requestAnimationFrame(t => { rafs.delete(id); if (!disposed) cb(t); }); rafs.add(id); return id; };
  const setTimeout = (fn, ms, ...a) => { const id = window.setTimeout(() => { timers.delete(id); if (!disposed) fn(...a); }, ms); timers.add(id); return id; };
  const clearTimeout = id => { timers.delete(id); window.clearTimeout(id); };
  const setInterval = (fn, ms, ...a) => { const id = window.setInterval(() => { if (!disposed) fn(...a); }, ms); timers.add(id); return id; };
  const clearInterval = id => { timers.delete(id); window.clearInterval(id); };
  // lookups: the landing hosts first (the studio start lives outside them), then the whole landing root
  const qs = sel => { for (const h of hosts) { const r = h.querySelector(sel); if (r) return r; } return lpRoot.querySelector(sel); };
  const qsa = sel => hosts.flatMap(h => [...h.querySelectorAll(sel)]);
  const byId = id => qs('#' + id);
  const docTop = el => el.getBoundingClientRect().top + window.scrollY;
  // Motion, with the stoppers it hands back collected for cleanup
  const M = { animate, stagger,
    inView: (...a) => { const stop = inView(...a); disposers.push(stop); return stop; },
    scroll: (...a) => { const stop = scroll(...a); disposers.push(stop); return stop; } };
  // the hero stub's intro and spin: driven by Motion springs (TSMotion), read by the 3D frame loop
  const hs = { intro: undefined, spin: 0, spinV: 0 };

  async function run() {

    /* ---------- TicketStub cards: one component for the studio, the gallery ribbon and the checkout preview ---------- */
    const TS = (() => {
      const fine = matchMedia('(hover:hover) and (pointer:fine)').matches;
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const buzz = p => { try { if (!still && navigator.vibrate) navigator.vibrate(p); } catch (e) {} };
      const esc = v => String(v).replace(/[&<>"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[ch]));
      // brand motion: foil and tilt never step. Targets are eased every frame (tilt tau 110ms, glow in 400ms / out 600ms), max 11deg.
      const live = new Map(); let raf = 0, lastT = 0;
      const paintTilt = (t, c) => { t.style.setProperty('--rx', (-c.y * 22).toFixed(2) + 'deg'); t.style.setProperty('--ry', (c.x * 22).toFixed(2) + 'deg');
        t.style.setProperty('--px', c.x.toFixed(3)); t.style.setProperty('--py', c.y.toFixed(3));
        t.style.setProperty('--lx', (50 + c.x * 60).toFixed(1) + '%'); t.style.setProperty('--ly', (35 + c.y * 60).toFixed(1) + '%'); t.style.setProperty('--glow', c.g.toFixed(3)); };
      function step(now){
        const dt = Math.min(50, now - (lastT || now)); lastT = now; let busy = false;
        live.forEach((c, t) => { const kt = 1 - Math.exp(-dt / 110), kg = 1 - Math.exp(-dt / (c.tg > c.g ? 400 : 600));
          c.x += (c.tx - c.x) * kt; c.y += (c.ty - c.y) * kt; c.g += (c.tg - c.g) * kg; paintTilt(t, c);
          if (Math.abs(c.tx - c.x) + Math.abs(c.ty - c.y) + Math.abs(c.tg - c.g) > .002) busy = true; });
        raf = busy ? requestAnimationFrame(step) : (lastT = 0, 0);
      }
      const set = (t, x, y, g) => { if (!t) return; x = Math.max(-.5, Math.min(.5, x)); y = Math.max(-.5, Math.min(.5, y));
        if (still){ paintTilt(t, { x: 0, y: 0, g: .45 }); return; }
        const c = live.get(t) || { x: 0, y: 0, g: .12 }; c.tx = x; c.ty = y; c.tg = g; live.set(t, c); if (!raf) raf = requestAnimationFrame(step); };
      function wire(st){
        if (st.dataset.wired) return; st.dataset.wired = 1;
        if (fine && !still){
          st.addEventListener('pointermove', e => { const r = st.getBoundingClientRect(); set(st.querySelector('.ts-tilt'), (e.clientX - r.left) / r.width - .5, (e.clientY - r.top) / r.height - .5, .9); });
          st.addEventListener('pointerleave', () => set(st.querySelector('.ts-tilt'), 0, 0, .12));
        }
        const flip = () => { st.classList.toggle('flipped'); buzz([8]); };
        st.addEventListener('click', flip);
        st.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); flip(); } });
      }
      // d = { kind, no, ol, fl, meta, a, vs, b, sub, boxes:[[label,value]], back:[[label,value]], c1, c2 }
      function inner(d){
        const boxes = d.boxes.map(([i, b]) => b === '?' ? `<span class="tc-chip">${esc(i)} TBC</span>` : `<span class="tc-box"><i>${esc(i)}</i><b>${esc(b)}</b></span>`).join('');
        const title = `<span class="tc-a">${esc(d.a)}</span>` + (d.b ? `<span class="tc-vs">vs</span><span class="tc-b">${esc(d.b)}</span>` : '');
        const back = d.back.map(([k, v]) => `<li><span>${esc(k)}</span><span>${esc(v)}</span></li>`).join('');
        return `<div class="ts-tilt"><div class="ts-flip">
          <div class="ts-face ts-front">
            <div class="tc-art"><span class="tc-kind">${esc(d.kind)}</span><span class="tc-no">No. ${esc(d.no)}</span><span class="tc-word"><span class="ol">${esc(d.ol)}</span><span class="fl">${esc(d.fl)}</span></span><span class="tc-band"></span></div>
            <div class="tc-main"><span class="tc-meta">${esc(d.meta)}</span><span class="tc-title">${title}</span>${d.sub ? `<span class="tc-sub">${esc(d.sub)}</span>` : ''}</div>
            <div class="tc-perf" aria-hidden="true"></div>
            <div class="tc-stub"><div class="tc-boxes">${boxes}</div><div class="tc-foot"><span>Keepsake · not for entry</span><span class="tc-code"></span></div></div>
            <div class="ts-grain"></div><div class="ts-sheen"></div><div class="ts-glare"></div>
          </div>
          <div class="ts-face ts-back"><div class="tb-body">
            <span class="tb-kicker">${esc(d.kind)} · stub no. ${esc(d.no)}</span>
            <span class="tb-title">${esc(d.a)}${d.b ? '<br>vs ' + esc(d.b) : ''}</span>
            <ul class="tb-list">${back}</ul>
            <div class="tb-foot"><span class="tb-mark">getticketstub</span><span class="tb-line">Commemorative keepsake · not valid for entry</span></div>
          </div><div class="ts-grain"></div></div>
        </div></div><i class="ts-pin" aria-hidden="true"></i>`;
      }
      function paint(st, d){
        st.style.setProperty('--c1', d.c1); st.style.setProperty('--c2', d.c2);
        st.setAttribute('aria-label', `${d.a}${d.b ? ' vs ' + d.b : ''} stub. Press to flip it over.`);
        st.innerHTML = inner(d);
      }
      function card(d){
        const st = document.createElement('figure'); st.className = 'ts-stub'; st.tabIndex = 0; st.setAttribute('role', 'button');
        paint(st, d); wire(st); return st;
      }
      // the page's own nights, shared by the studio wall and the checkout demos
      const NIGHTS = {
        gulls: { kind:'Football', no:'000112', ol:'GAME', fl:'DAY', meta:'Lakefront Field · Sun Nov 23 2025', a:'Harbor City Gulls', b:'Ironhill Miners', boxes:[['Final','31–28'],['Day','Sun'],['Year','25']], back:[['Venue','Lakefront Field'],['Seat','Sec 112 · Row 8 · 14'],['Date','Sun Nov 23 2025'],['Final','31 – 28']], c1:'#0f5c3d', c2:'#f2b33d' },
        nova: { kind:'Concert', no:'000421', ol:'SOLD', fl:'OUT', meta:'The Marigold Arena · Sat Jul 12 2025', a:'Nova Riot', sub:'Afterglow World Tour', boxes:[['Encores','2'],['Temp','81°'],['Sky','Clear']], back:[['Venue','The Marigold Arena'],['Seat','Floor · GA · 0421'],['Date','Sat Jul 12 2025'],['Encores','two']], c1:'#1a0620', c2:'#ff4fc0' },
        wolves: { kind:'Hockey', no:'000220', ol:'OVER', fl:'TIME', meta:'Frost Arena · Tue Jan 20 2026', a:'Ice Harbor Wolves', b:'Summit Storm', boxes:[['Final','3–2'],['Period','OT'],['Year','26']], back:[['Venue','Frost Arena'],['Seat','Sec 220 · Row 4 · 9'],['Date','Tue Jan 20 2026'],['Winner','sudden death']], c1:'#0d2236', c2:'#e4572e' }
      };
      // the studio section: the three nights pinned on cork, plus the tear-off control
      const sec = byId('studio');
      if (sec){
        const cork = byId('tsCork');
        [['gulls','-4deg','14px'],['nova','1.5deg','-6px'],['wolves','-1.5deg','10px']].forEach(([k, rot, dy]) => { const c = card(NIGHTS[k]); c.dataset.k = k; c.style.setProperty('--rot', rot); c.style.setProperty('--dy', dy); cork.appendChild(c); });
        const stubs = [...sec.querySelectorAll('.ts-stub')];
        if (!fine && !still) addEventListener('scroll', () => { const r = sec.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) return;
          const q = Math.max(-1, Math.min(1, (innerHeight / 2 - (r.top + r.height / 2)) / innerHeight)); stubs.forEach((st, i) => set(st.querySelector('.ts-tilt'), q * .5 * (i % 2 ? -1 : 1), q * .3, .6)); }, { passive: true });
        const tear = sec.querySelector('.ts-tear'), label = tear.querySelector('.ts-tear-t');
        let dragged = false;
        const setTorn = torn => { tear.classList.toggle('torn', torn); tear.setAttribute('aria-pressed', torn);
          label.textContent = torn ? 'Torn · turn them back' : 'Drag to tear ✂';
          stubs.forEach((st, i) => setTimeout(() => { st.classList.toggle('flipped', torn); if (torn && TSMotion) TSMotion.pin(st); }, still ? 0 : i * 140));
          if (torn) buzz([30, 30, 60]); };
        tear.addEventListener('click', () => { if (dragged){ dragged = false; return; } setTorn(!tear.classList.contains('torn')); });
        // signature move: drag along the perforation; past 60% it rips free
        if (!still) tear.addEventListener('pointerdown', e => {
          if (tear.classList.contains('torn')) return;
          const r = tear.getBoundingClientRect(), x0 = e.clientX; let last = 0, p = 0; tear.setPointerCapture(e.pointerId);
          const move = ev => { p = Math.max(0, Math.min(1, (ev.clientX - x0) / (r.width * .7))); if (Math.abs(ev.clientX - x0) > 8) dragged = true;
            tear.style.setProperty('--tp', p.toFixed(3)); const tick = Math.floor(p * 12); if (tick > last){ buzz([4]); last = tick; }
            if (p >= .6){ end(); setTorn(true); } };
          const end = () => { tear.removeEventListener('pointermove', move); tear.removeEventListener('pointerup', end); tear.removeEventListener('pointercancel', end);
            if (p < .6) M.animate(tear, { '--tp': 0 }, { duration: .38, ease: [.45, 0, .55, 1] }); else tear.style.setProperty('--tp', 0); };
          tear.addEventListener('pointermove', move); tear.addEventListener('pointerup', end); tear.addEventListener('pointercancel', end);
        });
      }
      return { card, paint, wire, set, fine, still, NIGHTS, buzz };
    })();

    /* ---------- the one checkout: link or event in, live stub preview, straight to the studio ---------- */
    (() => {
      const form = byId('maker'), ev = byId('ev'), slot = byId('finCard'), note = byId('finNote'), fin = byId('finale');
      if (!form) return;
      const NOTE_DEFAULT = note.textContent;
      const setNote = (text, err) => { note.textContent = text; note.classList.toggle('err', !!err); if (err){ ev.setAttribute('aria-invalid', 'true'); } else ev.removeAttribute('aria-invalid'); };
      const PALS = [['#17140f','#f2b33d'],['#7a0b1d','#e0b25a'],['#1b3fd1','#ffffff'],['#3a1c71','#ff5fa2'],['#0f5c3d','#f2b33d'],['#101820','#7ef0d3'],['#e4572e','#17140f']];
      const DEMOS = TS.NIGHTS;
      const DEMO_TEXT = { gulls:'Harbor City Gulls vs Ironhill Miners, Lakefront Field, Sun Nov 23 2025', nova:'Nova Riot, The Marigold Arena, Sat Jul 12 2025', wolves:'Ice Harbor Wolves vs Summit Storm, Frost Arena, Tue Jan 20 2026' };
      const BLANK = { kind:'Keepsake', no:'000001', ol:'YOUR', fl:'NIGHT', meta:'Your venue · your city · the date', a:'Your night here', sub:'Made to keep', boxes:[['Stub','01'],['Day','—'],['Year','—']], back:[['Venue','yours'],['Date','the night you went'],['Edition','Digital keepsake'],['Print','Preview']], c1:'#17140f', c2:'#e4572e' };
      const hash = str => [...str].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
      const cap = w => w.replace(/\b([a-z])/g, m => m.toUpperCase()).replace(/\b(Fc|Afc|Sc|Cf|Nyc|La|Ufc|Usa|Uk)\b/g, m => m.toUpperCase());
      function fromText(raw){
        const h = hash(raw.toLowerCase()); const [c1, c2] = PALS[h % PALS.length];
        let title = raw, meta = '', where = '', when = '', host = '';
        if (/^(https?:\/\/|www\.)|^[\w-]+\.(com|co\.uk|net|org|io|ie|ca|com\.au)\b/i.test(raw)){
          // a ticket link: name the night from the address
          let u; try { u = new URL(/^https?:/i.test(raw) ? raw : 'https://' + raw); } catch (e) {}
          host = u ? u.hostname.replace(/^www\./, '') : raw.split('/')[0];
          const segs = u ? u.pathname.split('/').filter(x => /[a-z]{3}/i.test(x) && !/^(event|events|e|tickets?|buy|en|us|gb)$/i.test(x)) : [];
          let slug = (segs.sort((a, b) => b.length - a.length)[0] || '').replace(/[-_+]+/g, ' ');
          const sd = slug.match(/\b(\d{1,2}) (\d{1,2}) (20\d\d)\b/); if (sd){ when = `${sd[3]}-${sd[2].padStart(2,'0')}-${sd[1].padStart(2,'0')}`; slug = slug.replace(sd[0], ''); }
          slug = slug.replace(/\b\d{3,}\b/g, '').replace(/\s+/g, ' ').trim();
          title = slug ? cap(slug.toLowerCase()) : 'Your night';
          meta = 'From ' + host;
        } else {
          const parts = raw.split(',').map(x => x.trim()).filter(Boolean);
          title = parts[0] || raw; where = parts[1] || ''; when = parts.slice(2).join(' ');
          meta = [where || 'Your venue', when || 'the date you were there'].join(' · ');
        }
        const all = raw + ' ' + title;
        let dt = when ? new Date(when.replace(/·/g, ' ').replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i, '').trim()) : null; if (dt && isNaN(dt)) dt = null;
        const year = dt ? String(dt.getFullYear()).slice(2) : ((all.match(/\b(19|20)(\d\d)\b/) || [])[2] || '');
        const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const day = dt ? DAYS[dt.getDay()] : (all.match(/\b(mon|tue|wed|thu|fri|sat|sun)/i) || [])[1];
        if (dt && !where) meta = meta.replace(/^From /, 'From ') + ' · ' + dt.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
        const vs = title.match(/^(.+?)\s+(?:vs?\.?|versus)\s+(.+)$/i);
        let city = '';
        if (vs && host){ const w = vs[2].split(' '); if (w.length >= 3){ city = w.pop(); vs[2] = w.join(' '); } }
        if (city && !where){ where = city; meta = `${city} · from ${host}` + (dt ? ' · ' + dt.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : ''); }
        let kind = 'Keepsake', ol = 'YOUR', fl = 'NIGHT', a = title.slice(0, 40), b = '', boxes;
        const dayBox = day ? ['Day', cap(day.toLowerCase())] : null, yearBox = year ? ['Year', year] : null;
        const dateBoxes = dayBox && yearBox ? [dayBox, yearBox] : dayBox || yearBox ? [dayBox || yearBox, ['Date','?']].slice(0, 2) : [['Date','?']];
        if (vs || /\b(fc|united|city|rovers|athletic|cup|final|derby|game|match|bowl|series)\b/i.test(all)){
          kind = 'Live sport'; ol = 'FULL'; fl = 'TIME'; if (vs){ a = vs[1].slice(0, 26); b = vs[2].slice(0, 26); }
          boxes = [['Score','?'], ...dateBoxes];
        } else if (/\b(theatre|theater|musical|opera|ballet|play|premiere|opening)\b/i.test(all)){
          kind = 'Stage'; ol = 'OPENING'; fl = 'NIGHT'; boxes = [['Act','I'], ...dateBoxes];
        } else if (/\b(fest|festival|weekender)\b/i.test(all)){
          kind = 'Festival'; ol = 'FEST'; fl = 'PASS'; boxes = [['Days','3'], ...dateBoxes];
        } else {
          kind = host ? 'Your ticket' : 'Live music'; ol = host ? 'YOUR' : 'LIVE'; fl = 'NIGHT'; boxes = [['Stub','01'], ...dateBoxes];
        }
        return { kind, no: String(100000 + h % 900000).slice(0, 6), ol, fl, meta: meta.slice(0, 60), a, b, sub: b ? '' : (host ? 'From your ticket' : 'Your night'), boxes,
          back:[['Venue', where || (host ? 'from your ticket' : 'yours')],['Date', dt ? dt.toDateString() : (when || 'from your ticket')],['Edition','Digital keepsake'],['Print','Preview']], c1, c2 };
      }
      const st = TS.card(BLANK); slot.appendChild(st);
      let t0 = 0;
      const status = byId('finStatus'); let printT = 0;
      let proofs = 0;
      const show = (d, loud) => { st.classList.remove('flipped'); TS.paint(st, d); st.insertAdjacentHTML('beforeend', '<i class="ts-sweep" aria-hidden="true"></i>');
        if (TS.still){ return; }
        st.classList.add('printing'); status.classList.add('on'); status.lastChild.textContent = 'Printing proof…';
        clearTimeout(printT); printT = setTimeout(() => { st.classList.remove('printing'); status.classList.remove('on'); status.lastChild.textContent = 'Proof ready';
          if (loud || proofs === 0){ TSMotion && TSMotion.shutter(st); TS.buzz([18, 40, 28]); }
          proofs++; }, 900); };
      const upd = () => { const v = ev.value.trim(); fin.classList.toggle('typing', !!v); show(v ? fromText(v) : BLANK); };
      ev.addEventListener('input', () => { clearTimeout(t0); t0 = setTimeout(upd, 60); });
      ev.addEventListener('change', upd);
      const chips = [...qsa('.fin-try button')];
      chips.forEach(btn => {
        const k = btn.dataset.demo, d = DEMOS[k];
        btn.addEventListener('click', () => { ev.value = DEMO_TEXT[k]; fin.classList.add('typing'); show(d, true); setNote(NOTE_DEFAULT); chips.forEach(c => c.setAttribute('aria-pressed', c === btn)); ev.focus({ preventScroll: true }); });
        if (TS.fine){ btn.addEventListener('pointerenter', () => show(d)); btn.addEventListener('pointerleave', () => { const v = ev.value.trim(); const hit = Object.keys(DEMO_TEXT).find(x => DEMO_TEXT[x] === v); show(hit ? DEMOS[hit] : v ? fromText(v) : BLANK); }); }
      });
      ev.addEventListener('input', () => { chips.forEach(c => c.setAttribute('aria-pressed', 'false')); if (ev.hasAttribute('aria-invalid')) setNote(NOTE_DEFAULT); });
      if (matchMedia('(max-width:760px)').matches) ev.placeholder = 'Event link or the night';
      // same origin: a pasted link or a typed night goes to /new, where the studio researches it (ctx.submit picks url or q)
      let sent = false;
      form.addEventListener('submit', e => {
        e.preventDefault();
        const v = ev.value.trim();
        if (!v){ setNote('Add an event link or the night, like Nova Riot, Marigold Arena, Jul 12.', true); ev.focus(); TSMotion && TSMotion.shake(ev); return; }
        if (sent) return; sent = true;
        TSMotion && TSMotion.sent(form.querySelector('button'), st);
        setNote('Opening the studio with your night…');
        st.classList.add('flipped');
        setTimeout(() => { sent = false; ctx.submit(v); }, TS.still ? 0 : 650);
      });
      TS.fromText = fromText;
    })();

    /* ---------- brand motion, driven by Motion (motion.dev) with the brand-kit timings ---------- */
    const TSMotion = (() => {
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const ENTER = [.16, 1, .3, 1], STD = [.2, .8, .2, 1], FLIP = [.45, 0, .55, 1];
      const ok = !!(M && M.animate && !still);
      // print-complete shutter: an RGB split that fades out with (1-p)^2.6 over 320ms, plus a paper snap of scale
      function shutter(el){
        if (!ok) return;
        M.animate(0, 1, { duration: .32, ease: 'linear', onUpdate: p => { const k = Math.pow(1 - p, 2.6), d = (6 * k).toFixed(2);
          el.style.filter = k > .01 ? `drop-shadow(${d}px 0 0 rgba(228,87,46,${(.85 * k).toFixed(2)})) drop-shadow(-${d}px 0 0 rgba(124,198,210,${(.85 * k).toFixed(2)})) brightness(${(1 + .25 * k).toFixed(3)})` : ''; } });
        el.animate([{ scale: '1.04' }, { scale: '1' }], { duration: 380, easing: 'cubic-bezier(.45,0,.55,1)' });   // the independent scale property keeps the card's own rotate
      }
      // pin to the wall: lands with the reveal curve at a random angle between -4 and 4 degrees
      function pin(el){
        if (!ok) return;
        const a = (Math.random() * 8 - 4).toFixed(2);
        el.style.setProperty('--rot', a + 'deg');   // the card's own transform eases to the new angle
        M.animate(el, { translate: ['0px -18px', '0px 0px'] }, { duration: .6, ease: ENTER });
        setTimeout(() => TS.buzz([20]), 600);
      }
      if (ok){
        // reveal on scroll: headings wipe up from a press slot, copy follows on a stagger
        const groups = [
          ['.statement h2', '.statement .cols p'], ['.scenes-intro h2', '.scenes-intro p'], ['.interlude h2', '.interlude p'],
          ['.how h2', '.how .step'], ['.studio h2', '.studio-copy>p, .ts-reads li, .ts-next'], ['.gallery h2', '.gallery .head p'], ['footer .bigmark', 'footer .fwrap>div', true]
        ];
        const watchers = []; let pending = 0;
        const once = (el, fn) => { if (!el) return; let done = false; pending++; const go = () => { if (!done){ done = true; pending--; fn(); } };
          M.inView(el, go, { margin: '0px 0px -22% 0px' }); watchers.push(() => { if (!done && el.getBoundingClientRect().top < innerHeight * .78) go(); }); };
        groups.forEach(([head, rest, fade]) => {
          const h = qs(head), items = [...qsa(rest)];
          if (!h) return;
          const from = fade ? { opacity: 0, transform: 'translateY(.2em)' } : { clipPath: 'inset(0 0 100% 0)', transform: 'translateY(.28em)' };
          Object.assign(h.style, from);
          const settle = () => { [h, ...items].forEach(el => { el.getAnimations().forEach(an => { try { an.finish(); } catch (e) { an.cancel(); } }); el.style.clipPath = ''; el.style.transform = ''; el.style.opacity = ''; }); };
          items.forEach(el => { el.style.opacity = 0; el.style.transform = 'translateY(26px)'; });
          // watch the section, not the clipped heading (a clipped target never reports as visible)
          const host = h.closest('section, footer') || h.parentElement; let done = false;
          pending++;
          const play = () => { if (done) return; done = true; pending--;
            setTimeout(settle, 1800);   // never leave copy hidden, whatever the browser does with the animation
            M.animate(h, fade ? { opacity: [0, 1], transform: ['translateY(.2em)', 'translateY(0em)'] } : { clipPath: ['inset(0 0 100% 0)', 'inset(0 0 -12% 0)'], transform: ['translateY(.28em)', 'translateY(0em)'] }, { duration: .6, ease: ENTER })
              .then(() => { h.style.clipPath = ''; h.style.transform = ''; h.style.opacity = ''; });
            if (items.length) M.animate(items, { opacity: [0, 1], transform: ['translateY(26px)', 'translateY(0px)'] }, { duration: .6, ease: ENTER, delay: M.stagger(.07, { startDelay: .18 }) })
              .then(() => items.forEach(el => { el.style.opacity = ''; el.style.transform = ''; }));
          };
          M.inView(host, play, { margin: '0px 0px -22% 0px' });
          watchers.push(() => { if (!done && host.getBoundingClientRect().top < innerHeight * .78) play(); });   // backup for big jumps (anchor links)
        });
        addEventListener('scroll', () => watchers.forEach(w => w()), { passive: true });
        const watchT = setInterval(() => { watchers.forEach(w => w()); if (pending <= 0) clearInterval(watchT); }, 700);   // stops once every reveal has played
        // the studio's three proofs drop onto the print bed
        const bed = qs('.ts-bed');
        if (bed){ const cards = [...bed.querySelectorAll('.ts-stub')]; cards.forEach(c => { c.style.opacity = 0; });
          once(bed, () => { setTimeout(() => cards.forEach(c => { c.getAnimations().forEach(an => { try { an.finish(); } catch (e) { an.cancel(); } }); c.style.opacity = ''; }), 1800); cards.forEach((c, i) => { M.animate(c, { opacity: [0, 1], translate: ['0px -40px', '0px 0px'] }, { duration: .6, ease: ENTER, delay: .12 + i * .1 }); });
            M.animate(bed.querySelectorAll('.ts-crop'), { opacity: [0, .7], scale: ['1.8', '1'] }, { duration: .38, ease: STD, delay: M.stagger(.05) }); }); }
        // the ribbon cards settle as they arrive
        once(qs('.gallery'), () => { const rib = [...qsa('.ribbon > *')]; M.animate(rib, { opacity: [0, 1] }, { duration: .6, ease: ENTER, delay: M.stagger(.03) });
          setTimeout(() => rib.forEach(c => c.getAnimations().forEach(an => { if (an.playState !== 'finished') try { an.finish(); } catch (e) {} })), 2400); });
      }

      /* ---- hero line, stub and checkout button (Emil-style: custom ease-out, short, interruptible; springs for anything you touch) ---- */
      const OUT = [.23, 1, .32, 1];
      const h1 = qs('.hero h1');
      if (ok && h1){
        // split each word into letters so they can rise out of the press slot one after another
        h1.classList.add('m-split');
        h1.querySelectorAll('.l>span').forEach(w => { const t = w.textContent; w.textContent = '';
          [...t].forEach(c => { const ch = document.createElement('span'); ch.className = 'ch'; ch.textContent = c; ch.setAttribute('aria-hidden', 'true'); w.appendChild(ch); }); });
        const chars = [...h1.querySelectorAll('.ch')];
        chars.forEach(c => { c.style.opacity = 0; c.style.transform = 'translateY(.55em) rotate(4deg)'; c.style.filter = 'blur(10px)'; });
        // a cyan swash draws under "there." once the letters land
        const third = h1.querySelector('.l:nth-child(3)');
        third.insertAdjacentHTML('beforeend', '<svg class="swash" viewBox="0 0 400 40" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M6 26 C 90 8, 190 34, 270 18 S 370 10, 394 22" style="stroke-dasharray:1;stroke-dashoffset:1"/></svg>');
        const swash = third.querySelector('.swash path');
        hs.intro = 0;   // the 3D stub waits above the frame until the loader lifts
      }
      const heroIn = () => {
        if (!ok || !h1) return;
        const chars = [...h1.querySelectorAll('.ch')];
        const settleChars = () => chars.forEach(c => { c.getAnimations().forEach(a => { try { a.finish(); } catch (e) {} }); c.style.opacity = ''; c.style.transform = ''; c.style.filter = ''; });
        setTimeout(settleChars, 2600);
        M.animate(chars, { opacity: [0, 1], transform: ['translateY(.55em) rotate(4deg)', 'translateY(0em) rotate(0deg)'], filter: ['blur(10px)', 'blur(0px)'] },
          { duration: .9, ease: OUT, delay: M.stagger(.045, { startDelay: .15 }) }).then(settleChars);
        const sw = h1.querySelector('.swash path');
        if (sw){ const done = () => { sw.getAnimations().forEach(an => { try { an.finish(); } catch (e) {} }); sw.style.strokeDashoffset = '0'; };
          M.animate(sw, { strokeDashoffset: [1, 0] }, { duration: .7, ease: [.65, 0, .35, 1], delay: 1.05 }).then(done); setTimeout(done, 2400); }
        // the stub drops onto the disc on a spring, overshoots a touch and settles
        M.animate(0, 1, { type: 'spring', stiffness: 70, damping: 11, mass: 1, delay: .45, onUpdate: v => { hs.intro = v; } });
        setTimeout(() => { if ((hs.intro ?? 1) < .9) hs.intro = 1; }, 4500);   // never strand the stub off-screen
        // scroll-linked parting of the three lines as the hero leaves
        if (M.scroll){ const ls = [...h1.querySelectorAll('.l')];
          [[-7, 0], [3, -2], [9, 3]].forEach(([x, r], i) => { if (ls[i]) M.scroll(M.animate(ls[i], { transform: ['translateX(0vw) rotate(0deg)', `translateX(${x}vw) rotate(${r}deg)`] }, { ease: 'linear' }), { target: byId('hero'), offset: ['start start', 'end start'] }); }); }
      };
      // flick the stub: press the disc and it spins on a spring (velocity from how hard you drag)
      const disc = byId('disc');
      if (ok && disc){
        let spin = 0, ctrl = null, x0 = 0, t0 = 0;
        disc.addEventListener('pointerdown', e => { x0 = e.clientX; t0 = performance.now(); if (ctrl) ctrl.stop(); try { disc.setPointerCapture(e.pointerId); } catch (err) {} });
        disc.addEventListener('pointerup', e => {
          const dx = e.clientX - x0, dt = Math.max(16, performance.now() - t0), vel = Math.max(-40, Math.min(40, dx / dt * 18));
          const turns = Math.abs(dx) < 6 ? 1 : Math.max(1, Math.round(Math.abs(vel) / 8));
          const target = Math.round(spin / (Math.PI * 2)) * Math.PI * 2 + Math.sign(dx || 1) * turns * Math.PI * 2;
          ctrl = M.animate(spin, target, { type: 'spring', stiffness: 60, damping: 12, velocity: vel || 8,
            onUpdate: v => { hs.spinV = v - spin; spin = v; hs.spin = v; }, onComplete: () => { hs.spinV = 0; } });
          TS.buzz([12]);
        });
      }
      // checkout button: magnetic on fine pointers (spring via CSS translate, so :active scale still composes), gleam when the finale opens
      const btn = qs('.maker button');
      if (ok && btn && matchMedia('(hover:hover) and (pointer:fine)').matches){
        let mag = null;
        const go = (x, y) => { if (mag) mag.stop(); mag = M.animate(btn, { translate: `${x}px ${y}px` }, { type: 'spring', stiffness: 320, damping: 22 }); };
        btn.addEventListener('pointermove', e => { const r = btn.getBoundingClientRect(); go(Math.max(-8, Math.min(8, (e.clientX - r.left - r.width / 2) * .18)), Math.max(-6, Math.min(6, (e.clientY - r.top - r.height / 2) * .3))); });
        btn.addEventListener('pointerleave', () => go(0, 0));
      }
      // every "Make yours" stub leans toward the cursor on a spring (the CSS translate property, so hover tilt and press scale still compose)
      if (ok && matchMedia('(hover:hover) and (pointer:fine)').matches){
        qsa('.cta').forEach(c => { let m = null;
          const go = (x, y) => { if (m) m.stop(); m = M.animate(c, { translate: `${x}px ${y}px` }, { type: 'spring', stiffness: 320, damping: 22 }); };
          c.addEventListener('pointermove', e => { const r = c.getBoundingClientRect(); go(Math.max(-7, Math.min(7, (e.clientX - r.left - r.width / 2) * .16)), Math.max(-5, Math.min(5, (e.clientY - r.top - r.height / 2) * .3))); });
          c.addEventListener('pointerleave', () => go(0, 0)); });
      }
      const fin = byId('finale');
      if (fin && btn){ let seen = false;
        const mo = new MutationObserver(() => { if (fin.classList.contains('on') && !seen){ seen = true; if (ok){ btn.classList.add('gleam'); setTimeout(() => btn.classList.remove('gleam'), 1600); } } }); mo.observe(fin, { attributes: true, attributeFilter: ['class'] }); disposers.push(() => mo.disconnect()); }
      // empty submit: a short horizontal shake (never a modal)
      function shake(el){ if (!ok){ return; } M.animate(el, { translate: ['0px 0px', '-7px 0px', '6px 0px', '-4px 0px', '3px 0px', '0px 0px'] }, { duration: .42, ease: 'easeOut' }); TS.buzz([10, 30, 10]); }
      // sent: the label blurs out and the confirmation blurs in; the preview stub gets stamped
      function sent(b, card){
        const lbl = b && b.querySelector('.lbl'); if (!lbl) return;
        const swap = txt => { lbl.innerHTML = txt; };
        if (!ok){ swap('Opening the studio…'); setTimeout(() => swap('Try the studio <span class="arr">→</span>'), 3000); return; }
        M.animate(lbl, { opacity: [1, 0], filter: ['blur(0px)', 'blur(4px)'], transform: ['translateY(0px)', 'translateY(-8px)'] }, { duration: .14, ease: [.4, 0, 1, 1] }).then(() => {
          swap('Opening the studio…');
          M.animate(lbl, { opacity: [0, 1], filter: ['blur(4px)', 'blur(0px)'], transform: ['translateY(8px)', 'translateY(0px)'] }, { duration: .26, ease: OUT });
        });
        // spring-shaped easing (overshoot then settle), played on the independent scale property so rotations survive
        const springEase = 'linear(0, 0.35 8%, 0.82 18%, 1.06 30%, 1.1 38%, 1.04 52%, 0.99 66%, 1 100%)';
        b.animate([{ scale: '0.94' }, { scale: '1' }], { duration: 520, easing: springEase });
        if (card) card.animate([{ scale: '1.06' }, { scale: '1' }], { duration: 620, easing: springEase });
        setTimeout(() => M.animate(lbl, { opacity: [1, 0] }, { duration: .14 }).then(() => { swap('Try the studio <span class="arr">→</span>'); M.animate(lbl, { opacity: [0, 1] }, { duration: .2, ease: OUT }); }), 3200);
      }
      // hero press marks register once the loader lifts
      const marks = () => {
        const els = [...qsa('.hero .crop')], reg = byId('reg'), line = qs('.hero .proofline');
        if (!ok){ [...els, reg, line].forEach(e => e && (e.style.opacity = 1)); return; }
        M.animate(els, { opacity: [0, 1], scale: ['1.6', '1'] }, { duration: .38, ease: STD, delay: M.stagger(.06, { startDelay: .5 }) });
        if (reg) M.animate(reg, { opacity: [0, .9], rotate: ['-90deg', '0deg'], scale: ['.4', '1'] }, { duration: .6, ease: ENTER, delay: .75 });
        if (line) M.animate(line, { opacity: [0, 1], clipPath: ['inset(0 100% 0 0)', 'inset(0 0% 0 0)'] }, { duration: .6, ease: STD, delay: .9 });
      };
      const wait = () => lpRoot.classList.contains('ready') ? (marks(), heroIn()) : setTimeout(wait, 120); wait();
      // the 3D stub arrived after the reveal: drop it onto the disc where the printed one was
      function drop(){
        if (!ok){ hs.intro = 1; return; }
        hs.intro = 0;
        M.animate(0, 1, { type: 'spring', stiffness: 70, damping: 11, mass: 1, onUpdate: v => { hs.intro = v; } });
        setTimeout(() => { if ((hs.intro ?? 1) < .9) hs.intro = 1; }, 3000);
      }
      return { shutter, pin, ok, shake, sent, drop };
    })();



    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const loaderEl = byId('loader');
    function dismissLoader(){ if (loaderEl.classList.contains('done')) return; loaderEl.classList.add('done'); lpRoot.classList.add('ready'); setTimeout(() => { loaderEl.hidden = true; }, 1200); }
    const safety = setTimeout(() => { lpRoot.classList.add('no3d'); dismissLoader(); }, 8000);   // last resort if fonts or art stall

    /* =============================== DATA =============================== */
    // scene order matches the Blender flights S0..S7 (even = performer on the left, throws right)
    const SCENES = [
      { key:'football', word:'Gameday', kind:'Football', title:'Harbor City Gulls vs. Ironhill Miners', venue:'Lakefront Field', date:'Sun · Nov 23 · 2025',
        sec:'112', row:'8', seat:'14', line:'The fourth-quarter comeback you still tell people about.', img:'/landing/qb-clean.webp', anchor:[.96,.17],
        bg:'#06281d', fg:'#eaf6ec', g1:'#1f8a55', g2:'#0d4f37', beam:'#d8ffe6', stroke:'rgba(234,246,236,.55)', fillc:'#2fae6d', tpl:'sport', c1:'#0f5c3d', c2:'#f2b33d', team2:'#5b6b7a' },
      { key:'baseball', word:'First pitch', kind:'Baseball', title:'Riverside Owls vs. Canyon Rattlers', venue:'Old Mill Park', date:'Thu · Apr 03 · 2025',
        sec:'9', row:'21', seat:'3', line:'Opening day, a cold hot dog and extra innings.', img:'/landing/pitcher-clean.webp', anchor:[.03,.2],
        bg:'#0c1630', fg:'#f3ecdc', g1:'#2c4a8f', g2:'#7a2232', beam:'#fff1cc', stroke:'rgba(243,236,220,.5)', fillc:'#f3ecdc', tpl:'sport', c1:'#1b2d5c', c2:'#c8343c', team2:'#c56a2c' },
      { key:'concert', word:'Encore', kind:'Concert', title:'Nova Riot — Afterglow World Tour', venue:'The Marigold Arena', date:'Sat · Jul 12 · 2025',
        sec:'FLR', row:'GA', seat:'0421', line:'Two encores. No voice left by Sunday.', img:'/landing/singer-clean.webp', anchor:[.96,.11],
        bg:'#24062a', fg:'#ffe9fb', g1:'#c0148a', g2:'#4b1aa8', beam:'#ff9be6', stroke:'rgba(255,233,251,.5)', fillc:'#ff4fc0', tpl:'gig', c1:'#1a0620', c2:'#ff4fc0' },
      { key:'basketball', word:'Tip-off', kind:'Basketball', title:'Bayside Comets vs. Desert Kings', venue:'Harbor Dome', date:'Fri · Feb 14 · 2025',
        sec:'104', row:'C', seat:'7', line:'Courtside enough to hear the sneakers.', img:'/landing/hoops-clean.webp', anchor:[.03,.025],
        bg:'#3a1404', fg:'#fff0e0', g1:'#e86a1a', g2:'#7a2a08', beam:'#ffd2a1', stroke:'rgba(255,240,224,.5)', fillc:'#ff8a2b', tpl:'sport', c1:'#d4561a', c2:'#17140f', team2:'#3f2a7a' },
      { key:'soccer', word:'Derby day', kind:'Soccer', title:'Northgate FC vs. Southport United', venue:'Northgate Stadium', date:'Sat · Mar 08 · 2025',
        sec:'N4', row:'17', seat:'230', line:'A ninety-third-minute save, and the keeper threw it to the stands.', img:'/landing/keeper-clean.webp', anchor:[.5,.5],
        bg:'#061a5c', fg:'#eaf0ff', g1:'#2a5cff', g2:'#00a3a3', beam:'#cfe0ff', stroke:'rgba(234,240,255,.5)', fillc:'#5d86ff', tpl:'sport', c1:'#1b3fd1', c2:'#ffffff', team2:'#b3122e' },
      { key:'festival', word:'Festival', kind:'Festival', title:'Sunflare Festival — Weekend One', venue:'Desert Bloom Grounds', date:'Apr 11–13 · 2025',
        sec:'3DAY', row:'GA', seat:'88213', line:'Lawn games between sets, and a stub tossed into the crowd.', img:'/landing/fan-clean.webp', anchor:[.02,.6], layout:'wide',
        bg:'#2a0f3d', fg:'#fff4e8', g1:'#ff7a3d', g2:'#8a2bd1', beam:'#ffd9a8', stroke:'rgba(255,244,232,.5)', fillc:'#ffb347', tpl:'fest', c1:'#ff6a3d', c2:'#7b2ff7' },
      { key:'theater', word:'Curtain up', kind:'Ballet', title:'Swan Lake — Bluebird Ballet', venue:'Royal Crescent Opera House', date:'Wed · Oct 01 · 2025',
        sec:'ORCH', row:'F', seat:'101', line:'Opening night. The whole room stood up.', img:'/landing/ballet-clean.webp', anchor:[.6,-.03],
        bg:'#2a0409', fg:'#fbe9d6', g1:'#a3122a', g2:'#5a0712', beam:'#ffd7a0', stroke:'rgba(251,233,214,.5)', fillc:'#e0b25a', tpl:'theater', c1:'#7a0b1d', c2:'#e0b25a' },
      { key:'hockey', word:'Overtime', kind:'Hockey', title:'Ice Harbor Wolves vs. Summit Storm', venue:'Frost Arena', date:'Tue · Jan 20 · 2026',
        sec:'220', row:'4', seat:'9', line:'Sudden death. The stub came off the stick with the winner.', img:'/landing/hockey-clean.webp', anchor:[.03,.16],
        bg:'#d9ebf5', fg:'#0d2236', g1:'#ffffff', g2:'#8ec3e6', beam:'#ffffff', stroke:'rgba(13,34,54,.45)', fillc:'#0d2236', tpl:'sport', c1:'#0d2236', c2:'#e4572e', team2:'#2b7bb9' },
    ];
    // more events for the wall (ticket art only) — fictional names
    const EXTRA = [
      ['gig','Kira Vale','Ghost Lights Tour','The Lyric Hall','Sep 19 · 2025','#101820','#7ef0d3'],
      ['sport','Mountain Kings','Delta Herons','Summit Bowl','Dec 06 · 2025','#2d1e5c','#ffc531','#2e8b57'],
      ['theater','The Glass Lantern','A new musical','The Majestic Theatre','Mar 22 · 2025','#16243d','#d9b56c'],
      ['fest','Neon Pulse','All-night rave','Pier 9 Warehouse','Aug 30 · 2025','#ff2e88','#28e0ff'],
      ['sport','Coastal Open','Centre Court Final','Seaside Tennis Club','Jun 29 · 2025','#0b5d3b','#f4f1e8','#7a4ab8'],
      ['gig','The Velvet Hour','Jazz at midnight','Blue Door Club','Nov 07 · 2025','#2b1a10','#e8b04a'],
      ['sport','Port Avalon Grand Prix','Grandstand B','Avalon Circuit','May 18 · 2025','#c8102e','#ffffff','#111111'],
      ['theater','Midnight Comedy Hour','Late show','The Basement','Jan 10 · 2026','#141414','#ffd400'],
      ['fest','Copperline Rodeo','Championship night','Copperline Arena','Jul 04 · 2025','#7a3e12','#f6d28b'],
      ['gig','Harbour Lights','Orchestra under the stars','Bayfront Amphitheatre','Aug 16 · 2025','#0f1f3a','#ffd88a'],
      ['sport','Tidewater Regatta','Finals · Riverbank','Tidewater Basin','Apr 26 · 2025','#0a3d62','#ffffff','#e55039'],
      ['gig','Saint Ember','Loud Quiet Tour','Union Ballroom','Oct 24 · 2025','#3b0d0d','#ff6b3d'],
      ['fest','Glowfield','Lantern night','Glowfield Meadow','Sep 06 · 2025','#1d3b2a','#ffe27a'],
      ['theater','La Traviata','Season gala','Grand Opera House','Feb 08 · 2026','#3d0f2a','#e9c38a'],
      ['sport','City Derby','Boxing main event','Ironworks Hall','Mar 15 · 2025','#111111','#e4572e','#f2b33d'],
      ['gig','Paper Moons','Small Rooms Tour','Corner Stage','Jun 12 · 2025','#e9e2d0','#2b2b6e'],
      ['sport','Granite Bay Rams','Lowell Foxes','Granite Field','Oct 12 · 2025','#5c1a1a','#e8c547','#1f3b73'],
      ['gig','Marlowe & The Tides','Homecoming Show','Riverside Bowl','May 03 · 2025','#0e3b43','#ffcf6e'],
      ['fest','Bloomwave','Spring sessions','Lakeside Park','Mar 29 · 2025','#ff8fb1','#3a1c71'],
      ['theater','Hamlet','The Rep Season','Old Vic Lane Theatre','Nov 14 · 2025','#1c1c1c','#c9a96e'],
      ['sport','Westshore Pumas','Northridge Elks','Westshore Arena','Jan 31 · 2026','#2a0a4a','#ffb000','#0b8f6a'],
      ['gig','DJ Halcyon','Sunrise Set','The Glasshouse','Jul 27 · 2025','#091a2f','#ff5ec4'],
      ['sport','Cross City Marathon','Finish line grandstand','Cross City','Apr 13 · 2025','#f05a28','#ffffff','#17140f'],
      ['fest','Lantern Market','Night of lights','Old Town Square','Dec 13 · 2025','#2b1608','#ffbe3d'],
      ['theater','Cirque Lumière','Big top premiere','Waterfront Big Top','Aug 02 · 2025','#5a0b4d','#ffd36b'],
      ['gig','The Orchard Choir','Christmas at the Hall','St. Cecilia Hall','Dec 20 · 2025','#0b3d2c','#e6c06a'],
      ['sport','Pine Valley Open','Final round','Pine Valley Links','Sep 14 · 2025','#1e5631','#f6f1e1','#9b2226'],
      ['gig','Echo Arcade','Synth City Tour','The Warehouse','Feb 21 · 2026','#14002e','#00f0ff'],
      ['sport','Summit Classic','Ski jump finals','Summit Ridge','Jan 17 · 2026','#e7f1f7','#d7263d','#1b263b'],
      ['theater','The Magic Flute','Opera in the park','Greenhill Park','Jun 21 · 2025','#21305a','#f2c14e'],
    ];

    /* =============================== DOM: scenes =============================== */
    function rnd(seed){ let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
    const MOTIF = {
      football: '<g fill="none" stroke-width="3">' + Array.from({length:11},(_,k)=>`<line x1="${800+(k-5)*60}" y1="380" x2="${800+(k-5)*360}" y2="900"/>`).join('') + '<line x1="0" y1="900" x2="1600" y2="900"/><line x1="560" y1="380" x2="1040" y2="380"/></g><g font-family="Big Shoulders Display" font-weight="900" font-size="64" fill-opacity=".8" stroke="none"><text x="200" y="860">2 0</text><text x="1310" y="860">4 0</text></g>',
      baseball: '<g fill="none" stroke-width="4"><path d="M800 860 L1120 560 L800 260 L480 560 Z"/><path d="M160 560 Q800 -260 1440 560"/><circle cx="800" cy="560" r="46"/></g><g stroke="none"><rect x="788" y="848" width="24" height="24" transform="rotate(45 800 860)"/><rect x="1108" y="548" width="24" height="24" transform="rotate(45 1120 560)"/><rect x="788" y="248" width="24" height="24" transform="rotate(45 800 260)"/><rect x="468" y="548" width="24" height="24" transform="rotate(45 480 560)"/></g>',
      concert: '<g stroke-width="2">' + Array.from({length:26},(_,k)=>`<line x1="800" y1="-40" x2="${-300+k*88}" y2="900"/>`).join('') + '</g>',
      basketball: '<g fill="none" stroke-width="4"><rect x="560" y="420" width="480" height="480"/><circle cx="800" cy="420" r="160"/><path d="M180 900 L180 640 Q800 120 1420 640 L1420 900"/><circle cx="800" cy="860" r="34"/></g>',
      soccer: '<g fill="none" stroke-width="4"><line x1="800" y1="0" x2="800" y2="900"/><circle cx="800" cy="450" r="190"/><circle cx="800" cy="450" r="8" fill="currentColor"/><rect x="-10" y="210" width="260" height="480"/><rect x="1350" y="210" width="260" height="480"/><path d="M250 340 A120 120 0 0 1 250 560"/><path d="M1350 340 A120 120 0 0 0 1350 560"/></g>',
      festival: '<g stroke="none" opacity=".9"><path d="M0 900 L0 760 ' + Array.from({length:40},(_,k)=>{const x=k*41; const h=700+((k*37)%60); return `Q${x+10} ${h-40} ${x+20} ${h} Q${x+30} ${h+30} ${x+41} ${h-10}`;}).join(' ') + ' L1600 900 Z"/></g><g fill="none" stroke-width="5"><path d="M180 900 L180 160 L1420 160 L1420 900"/><path d="M180 160 L260 240 M340 160 L260 240 M500 160 L580 240 M660 160 L580 240 M940 160 L1020 240 M1100 160 L1020 240 M1260 160 L1340 240 M1420 160 L1340 240"/></g><g stroke="none">' + Array.from({length:24},(_,k)=>{const a=k*Math.PI/12; return `<path d="M800 980 L${800+Math.cos(a)*2000-20} ${980-Math.sin(a)*2000} L${800+Math.cos(a)*2000+60} ${980-Math.sin(a)*2000} Z"/>`;}).join('') + '</g><circle cx="800" cy="980" r="260" fill="none" stroke-width="6"/>',
      theater: '<g fill="none" stroke-width="4"><path d="M0 0 Q200 300 0 900"/><path d="M1600 0 Q1400 300 1600 900"/>' + Array.from({length:8},(_,k)=>`<path d="M${k*200} 0 Q${k*200+100} 120 ${k*200+200} 0"/>`).join('') + '</g><g stroke="none">' + Array.from({length:22},(_,k)=>`<circle cx="${60+k*70}" cy="884" r="7"/>`).join('') + '</g>',
      hockey: '<g fill="none" stroke-width="4"><rect x="40" y="60" width="1520" height="800" rx="220"/><line x1="800" y1="60" x2="800" y2="860" stroke="#e4572e" stroke-width="10"/><line x1="520" y1="60" x2="520" y2="860" stroke="#2b7bb9" stroke-width="10"/><line x1="1080" y1="60" x2="1080" y2="860" stroke="#2b7bb9" stroke-width="10"/><circle cx="800" cy="460" r="120" stroke="#2b7bb9"/><circle cx="260" cy="260" r="100" stroke="#e4572e"/><circle cx="260" cy="660" r="100" stroke="#e4572e"/><circle cx="1340" cy="260" r="100" stroke="#e4572e"/><circle cx="1340" cy="660" r="100" stroke="#e4572e"/></g>',
    };
    const list = byId('scene-list');
    const SHOWN = SCENES.map(s => s.key);   // the events that get a full thrown scene
    let shownN = 0;
    SCENES.forEach((s, i) => {
      if (!SHOWN.includes(s.key)) return; const num = String(++shownN).padStart(2,'0');
      const side = i % 2 === 0 ? 'left' : 'right';
      const infoSide = side === 'left' ? 'right' : 'left';
      const el = document.createElement('section');
      el.className = 'scene' + ({ concert: ' v-wide', festival: ' v-wide', hockey: ' v-top' }[s.key] || ''); el.dataset.i = i; el.dataset.nav = s.fg;
      el.setAttribute('aria-label', `${s.kind}: ${s.title}`);
      el.innerHTML = `
      <div class="stage" style="--bg:${s.bg};--fg:${s.fg};--g1:${s.g1};--g2:${s.g2};--beam:${s.beam};--stroke:${s.stroke};--fillc:${s.fillc};--gx:${side==='left'?'25%':'75%'}">
        <div class="glow"></div>${s.key === 'concert' ? '<div class="beams"></div>' : ''}
        <div class="bokeh" aria-hidden="true">${Array.from({length:18},(_,k)=>{const r=rnd(i*97+k*13); const sz=20+r()*150; return `<i style="left:${(r()*100).toFixed(1)}%;top:${(r()*80).toFixed(1)}%;width:${sz.toFixed(0)}px;height:${sz.toFixed(0)}px;background:${[s.g1,s.beam,s.g2][k%3]};opacity:${(.12+r()*.3).toFixed(2)};filter:blur(${(2+r()*14).toFixed(0)}px)"></i>`;}).join('')}</div>
        <canvas class="stub2d" data-scene="${i}" width="600" height="220" aria-hidden="true"></canvas>
        <div class="burst" aria-hidden="true"><svg viewBox="-60 -60 120 120" style="transform:scaleX(${side === 'left' ? 1 : -1})"><path d="M-10 -26 Q22 -34 52 -14"/><path d="M-16 -6 Q24 -10 58 4"/><path d="M-10 14 Q20 16 46 30"/></svg></div>
        <svg class="motif" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${MOTIF[s.key] || ''}</svg>
        <div class="bigword ${side === 'left' ? 'pr' : 'pl'}" aria-hidden="true" style="--chars:${Math.max(...s.word.split(' ').map(w => w.length))}"><span class="ol">${s.word}</span><span class="fill">${s.word}</span></div>
        ${s.panel
          ? `<figure class="panel ${side}"><img src="${s.img}" alt="Festival crowd, a fan on someone's shoulders with both arms raised" loading="eager"></figure><span class="credit mono">Photo · ${s.credit} / Unsplash</span>`
          : `<img class="athlete" src="${s.img}" alt="${s.kind} performer releasing a ticket stub" loading="eager">`}
        <div class="info">
          <div class="idx"><b>${num}</b><span class="chip mono">${s.kind}</span></div>
          <div class="ttl"><h3>${s.title}</h3><p>${s.line}</p></div>
          <div class="mt"><dl class="meta"><div><dt>Sec</dt><dd>${s.sec}</dd></div><div><dt>Row</dt><dd>${s.row}</dd></div><div><dt>Seat</dt><dd>${s.seat}</dd></div></dl>
          <span class="mono" style="opacity:.75">${s.venue} · ${s.date}</span></div>
        </div>
        <div class="counter mono"><span>Stub ${num}</span><span class="bar"><i></i></span><span>${String(SHOWN.length).padStart(2,'0')}</span></div>
      </div>`;
      list.appendChild(el);
    });
    var navSections = [...qsa('[data-nav]')];
    const words = ['Game 7','Encore','Opening night','Final whistle','Sold out','Front row','Overtime','Curtain call','Extra innings','Headliner'];
    byId('mq').innerHTML = [...words, ...words].map(w => `<span>${w}</span>`).join('');

    /* =============================== ticket art (canvas) =============================== */
    const TW = 1200, TH = 440, PERF = (1.5 + 0.88) / 3;          // perforation position in UV (matches Blender XP)
    function barcode(ctx, x, y, w, h, seed, color, vertical){
      const r = rnd(seed); ctx.fillStyle = color; let p = 0; const len = vertical ? h : w;
      while (p < len){ const bw = 1 + Math.floor(r()*4)*1.6; if (r() > .35){ vertical ? ctx.fillRect(x, y+p, w, bw) : ctx.fillRect(x+p, y, bw, h); } p += bw + 1.5; }
    }
    function grainOver(ctx, seed, amt=0.07){
      const r = rnd(seed);
      for (let i=0;i<2600;i++){ ctx.fillStyle = `rgba(${r()>.5?255:40},${r()>.5?240:30},${r()>.5?220:20},${r()*amt})`; ctx.fillRect(r()*TW, r()*TH, 1+r()*2, 1+r()*2); }
      const g = ctx.createRadialGradient(TW/2, TH/2, TH*.3, TW/2, TH/2, TW*.7);
      g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,'rgba(60,40,10,.18)'); ctx.fillStyle = g; ctx.fillRect(0,0,TW,TH);
    }
    function perforation(ctx, color){ const x = PERF * TW; ctx.fillStyle = color; for (let y = 14; y < TH - 10; y += 14){ ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI*2); ctx.fill(); } }
    function fitText(ctx, text, maxW, size, font){ let s = size; ctx.font = font(s); while (ctx.measureText(text).width > maxW && s > 10){ s -= 2; ctx.font = font(s); } return s; }
    function stubSide(ctx, d, ink){
      const x0 = PERF*TW + 18, w = TW - x0 - 22;
      ctx.save(); ctx.translate(x0 + w/2, TH/2); ctx.rotate(-Math.PI/2);
      ctx.fillStyle = ink; ctx.textAlign='center';
      ctx.font = '600 22px "IBM Plex Mono"'; ctx.fillText('KEEPSAKE', 0, -w/2 + 48);
      fitText(ctx, `${d.sec}·${d.row}·${d.seat}`, TH - 60, 64, s => `900 ${s}px "Big Shoulders Display"`); ctx.fillText(`${d.sec}·${d.row}·${d.seat}`, 0, 22);
      ctx.font = '500 16px "IBM Plex Mono"'; ctx.fillText('SEC · ROW · SEAT', 0, 52);
      ctx.restore();
      barcode(ctx, TW - 58, 40, 30, TH - 80, d.seed, ink, true);
    }
    function shade(hex, amt){ const n = parseInt(hex.replace('#','').padEnd(6,'0').slice(0,6),16); const c = v => Math.max(0, Math.min(255, v)); return `rgb(${c((n>>16)+amt)},${c(((n>>8)&255)+amt)},${c((n&255)+amt)})`; }
    // one stub language for the whole page: the studio card (halftone art panel, outline/fill word, stamp) laid out landscape
    const STAMP = new Path2D(qs('#tsStamp path').getAttribute('d'));
    const WORDPAIR = { football:['GAME','DAY'], baseball:['FIRST','PITCH'], concert:['SOLD','OUT'], basketball:['TIP','OFF'], soccer:['DERBY','DAY'], festival:['FEST','PASS'], theater:['CURTAIN','UP'], hockey:['OVER','TIME'],
      sport:['FULL','TIME'], gig:['LIVE','NIGHT'], fest:['FEST','PASS'], theater_:['OPENING','NIGHT'] };
    const lum = hex => { const n = parseInt(hex.replace('#','').padEnd(6,'0').slice(0,6),16); return (.299*(n>>16) + .587*((n>>8)&255) + .114*(n&255)) / 255; };
    function drawTicket(d, canvas){
      const c = canvas || document.createElement('canvas'); c.width = TW; c.height = TH;
      const ctx = c.getContext('2d'); const INK = '#17140f', STOCK = '#f4ecdb';
      const [ol, fl] = d.ol ? [d.ol, d.fl] : (WORDPAIR[d.key] || (d.tpl === 'theater' ? WORDPAIR.theater_ : WORDPAIR[d.tpl]) || WORDPAIR.gig);
      const AW = 404, PX = PERF * TW;
      // card stock
      ctx.fillStyle = STOCK; ctx.fillRect(0, 0, TW, TH);
      // art panel: colour, halftone that swells toward the top corner, a dark fall-off at the foot
      ctx.fillStyle = d.c1; ctx.fillRect(0, 0, AW, TH);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, AW, TH); ctx.clip();
      ctx.fillStyle = d.c2; ctx.globalAlpha = .55;
      for (let y = 9; y < TH; y += 17) for (let x = 9 + (y / 17 % 2) * 8.5; x < AW; x += 17){ const r = Math.max(0, 4.4 - Math.hypot(x - AW * .95, y - 0) / 95); if (r > .5){ ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); } }
      ctx.globalAlpha = 1;
      const glow = ctx.createRadialGradient(AW * .9, 0, 0, AW * .9, 0, AW * .9); glow.addColorStop(0, d.c2 + '55'); glow.addColorStop(1, d.c2 + '00'); ctx.fillStyle = glow; ctx.fillRect(0, 0, AW, TH);
      const foot = ctx.createLinearGradient(0, TH * .35, 0, TH); foot.addColorStop(0, 'rgba(0,0,0,0)'); foot.addColorStop(1, lum(d.c1) > .6 ? 'rgba(80,60,30,.18)' : 'rgba(0,0,0,.38)'); ctx.fillStyle = foot; ctx.fillRect(0, 0, AW, TH);
      // kind pill + number
      ctx.font = '600 17px "IBM Plex Mono"'; const kind = (d.kind || '').toUpperCase(); const kw = ctx.measureText(kind).width + 34;
      ctx.strokeStyle = d.c2; ctx.fillStyle = d.c2; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.roundRect(28, 28, kw, 34, 17); ctx.stroke(); ctx.textAlign = 'left'; ctx.fillText(kind, 45, 51);
      ctx.font = '500 15px "IBM Plex Mono"'; ctx.textAlign = 'right'; ctx.globalAlpha = .85; ctx.fillText('No. ' + String(d.seed).padStart(6, '0').slice(-6), AW - 28, 51); ctx.globalAlpha = 1;
      // outline word over filled word
      ctx.textAlign = 'left'; try { ctx.fontStretch = 'ultra-expanded'; } catch (e) {}
      const wf = s => `900 ${s}px Archivo`; const ws = Math.min(fitText(ctx, ol, AW - 56, 112, wf), fitText(ctx, fl, AW - 56, 112, wf)); ctx.font = wf(ws);
      ctx.lineWidth = Math.max(2, ws * .035); ctx.strokeStyle = d.c2; ctx.strokeText(ol, 26, TH - 40 - ws * .82);
      ctx.fillStyle = d.c2; ctx.fillText(fl, 26, TH - 40);
      ctx.restore();
      ctx.fillStyle = d.c2 === '#ffffff' || lum(d.c2) > .9 ? INK : d.c2; ctx.fillRect(AW, 0, 12, TH);
      // the night itself
      try { ctx.fontStretch = 'semi-expanded'; } catch (e) {}
      const mx = AW + 42, mw = PX - mx - 34;
      ctx.fillStyle = '#4d4232'; ctx.font = '600 17px "IBM Plex Mono"'; ctx.textAlign = 'left';
      fitText(ctx, `${d.venue}  ·  ${d.date}`.toUpperCase(), mw, 17, s => `600 ${s}px "IBM Plex Mono"`); ctx.fillText(`${d.venue}  ·  ${d.date}`.toUpperCase(), mx, 62);
      const vs = d.title.split(/ vs\. /), dash = vs[0].split(' — '); const a = dash[0], b = vs[1], sub = dash[1] || d.sub || '';
      const head = lum(d.c1) > .62 ? INK : d.c1; const hf = s => d.tpl === 'theater' ? `${s}px "Abril Fatface"` : `900 ${s}px Archivo`;
      const A = d.tpl === 'theater' ? a : a.toUpperCase();
      fitText(ctx, A, mw, b ? 58 : 66, hf); ctx.fillStyle = head; ctx.fillText(A, mx, 128);
      if (b){ ctx.fillStyle = INK; ctx.font = '900 30px "Big Shoulders Display"'; ctx.fillText('VS', mx, 172); fitText(ctx, b.toUpperCase(), mw - 52, 50, hf); ctx.fillText(b.toUpperCase(), mx + 50, 174); }
      else if (sub){ ctx.fillStyle = INK; fitText(ctx, sub, mw, 32, s => `italic 800 ${s}px Archivo`); ctx.fillText(sub, mx, 172); }
      try { ctx.fontStretch = 'normal'; } catch (e) {}
      // number boxes
      const bw = (mw - 36) / 3;
      [['SEC', d.sec], ['ROW', d.row], ['SEAT', d.seat]].forEach(([l, v], k) => {
        const bx = mx + k * (bw + 18), by = 222;
        ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.strokeRect(bx, by, bw, 104);
        ctx.fillStyle = INK; ctx.font = '500 15px "IBM Plex Mono"'; ctx.fillText(l, bx + 14, by + 26);
        fitText(ctx, v, bw - 26, 60, s => `900 ${s}px "Big Shoulders Display"`); ctx.fillText(v, bx + 14, by + 88);
      });
      ctx.fillStyle = '#6d604b'; ctx.font = '600 14px "IBM Plex Mono"'; ctx.fillText('KEEPSAKE · NOT FOR ENTRY', mx, 380);
      barcode(ctx, PX - 34 - 150, 362, 150, 24, d.seed, INK, false);
      // perforation + tear-off stub: stamp, seat, barcode
      perforation(ctx, '#bfb193');
      const sx = PX + 22, sw = TW - sx - 20;
      ctx.save(); ctx.translate(sx + 8, 30); ctx.scale(.52, .52); ctx.fillStyle = '#e4572e'; ctx.fill(STAMP, 'evenodd'); ctx.restore();
      ctx.save(); ctx.translate(sx + sw / 2 - 14, TH / 2 + 34); ctx.rotate(-Math.PI / 2); ctx.fillStyle = INK; ctx.textAlign = 'center';
      ctx.font = '600 18px "IBM Plex Mono"'; ctx.fillText('KEEPSAKE', 0, -60);
      fitText(ctx, `${d.sec}·${d.row}·${d.seat}`, TH - 150, 60, s => `900 ${s}px "Big Shoulders Display"`); ctx.fillText(`${d.sec}·${d.row}·${d.seat}`, 0, 2);
      ctx.font = '500 14px "IBM Plex Mono"'; ctx.fillText('SEC · ROW · SEAT', 0, 30); ctx.restore();
      barcode(ctx, TW - 56, 40, 28, TH - 80, d.seed, INK, true);
      grainOver(ctx, d.seed);
      return c;
    }
    function drawBack(){
      const c = document.createElement('canvas'); c.width = TW; c.height = TH; const ctx = c.getContext('2d');
      ctx.fillStyle = '#e9dcc0'; ctx.fillRect(0,0,TW,TH);
      ctx.save(); ctx.rotate(-0.18); ctx.fillStyle = 'rgba(120,80,40,.10)'; ctx.font = '900 34px Archivo';
      for (let y = -80; y < TH + 260; y += 52) for (let x = -200 + (y % 104 ? 90 : 0); x < TW + 200; x += 260) ctx.fillText('getticketstub', x, y);
      ctx.restore();
      ctx.fillStyle = '#e4572e'; ctx.fillRect(0, 0, TW, 18); ctx.fillRect(0, TH - 18, TW, 18);
      ctx.fillStyle = 'rgba(40,30,20,.75)'; ctx.font = '600 16px "IBM Plex Mono"';
      ['KEEP THIS STUB · PROOF YOU WERE THERE','Commemorative keepsake · not valid for entry','Designed in the getticketstub.com studio'].forEach((l, k) => ctx.fillText(l, 60, 92 + k*30));
      ctx.save(); ctx.translate(60, 220); ctx.scale(.62, .62); ctx.fillStyle = '#e4572e'; ctx.fill(STAMP, 'evenodd'); ctx.restore();
      ctx.font = '900 64px Archivo'; ctx.fillStyle = 'rgba(30,22,14,.9)'; ctx.fillText('getticketstub', 124, 300);
      ctx.font = '600 20px "IBM Plex Mono"'; ctx.fillText('.com', 502, 300);
      barcode(ctx, 60, 330, 520, 52, 99, 'rgba(30,22,14,.85)', false);
      ctx.save(); ctx.translate(TW, 0); ctx.scale(-1, 1); perforation(ctx, '#b9a985'); ctx.restore();
      grainOver(ctx, 7, .06); return c;
    }
    const heroDesign = { tpl:'gig', ol:'YOUR', fl:'NIGHT', c1:'#17140f', c2:'#e4572e', title:'Your night here — Made to keep', venue:'Your venue · your city', date:'The date you were there', sec:'A', row:'1', seat:'01', seed:777, kind:'Keepsake' };
    const sceneDesigns = SCENES.map((s, i) => ({ ...s, seed: 1000 + i*37 }));
    const extraDesigns = EXTRA.map((e, k) => {
      const [tpl, a, b, venue, date, c1, c2, team2] = e;
      const isMatch = tpl === 'sport' && /^[A-Z]/.test(b) && !/[·]|Final|Grandstand|grandstand|main|round|finals|Finals/.test(b);
      return { tpl, title: tpl === 'sport' ? (isMatch ? `${a} vs. ${b}` : a) : `${a} — ${b}`, sub: b, venue, date, c1, c2, team2: team2 || '#333',
               kind: tpl === 'sport' ? 'Live sport' : tpl === 'gig' ? 'Live music' : tpl === 'fest' ? 'Festival' : 'Stage',
               sec: String(100 + (k*37)%180), row: String.fromCharCode(65 + k%20), seat: String(1 + (k*7)%30), seed: 5000 + k*91 };
    });

    /* =============================== static art (works with or without WebGL) =============================== */
    const fontsReady = Promise.race([
      Promise.all(['900 40px Archivo','italic 800 40px Archivo','italic 500 30px Archivo','500 16px "IBM Plex Mono"','600 16px "IBM Plex Mono"','900 40px "Big Shoulders Display"','40px "Abril Fatface"'].map(f => document.fonts.load(f))),
      new Promise(r => setTimeout(r, 6000))
    ]).catch(()=>{});
    const pct = byId('lpct'), strip = byId('strip');
    let progress = 0;
    const lbar = byId('lbar');
    function setProgress(p){ progress = Math.max(progress, p); pct.textContent = Math.round(progress*100); lbar.setAttribute('aria-valuenow', Math.round(progress*100)); strip.style.transform = `translateY(${-100 + progress*100}%)`; }
    setProgress(0.03);
    await fontsReady;
    if (disposed) return;
    const texCache = new Map();
    // full size only where the art is seen up close (the eight scene stubs and the hero); everything else is kept small
    const scratch = document.createElement('canvas');
    function drawSmall(d, w){ drawTicket(d, scratch); const c = document.createElement('canvas'); c.width = w; c.height = Math.round(w * TH / TW); c.getContext('2d').drawImage(scratch, 0, 0, c.width, c.height); return c; }
    [...sceneDesigns, heroDesign].forEach(d => texCache.set(d, drawTicket(d)));
    extraDesigns.forEach(d => texCache.set(d, drawSmall(d, 600)));
    function mini(d, w = 600){ const src = texCache.get(d); const c = document.createElement('canvas'); c.width = w; c.height = Math.round(w * TH / TW); c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); return c; }
    // statement: a used QR next to the stub you keep
    { const q = byId('qr').getContext('2d'); const r = rnd(9); q.fillStyle = '#111';
      for (let y=0;y<29;y++) for (let x=0;x<29;x++){ const finder = (x<8&&y<8)||(x>20&&y<8)||(x<8&&y>20); if (finder){ const lx = x>20?x-21:x, ly = y>20?y-21:y; if (lx===0||ly===0||lx===6||ly===6||(lx>1&&lx<5&&ly>1&&ly<5)) q.fillRect(x,y,1,1); } else if (r() > .5) q.fillRect(x,y,1,1); }
      byId('proofstub').getContext('2d').drawImage(texCache.get(sceneDesigns[0]), 0, 0); }
    // how-it-works visuals
    { const st = byId('styles'); [sceneDesigns[0], sceneDesigns[2], sceneDesigns[3]].forEach(d => st.appendChild(mini(d, 420)));
      byId('framed').appendChild(mini(sceneDesigns[2], 520)); }
    // gallery ribbon
    const ribbon = byId('ribbon');
    const WORDS = { sport: ['FULL','TIME','Live sport'], gig: ['LIVE','NIGHT','Live music'], fest: ['FEST','PASS','Festival'], theater: ['OPENING','NIGHT','Stage'] };
    const asCard = (d, k) => { const [ol, fl, kind] = WORDS[d.tpl] || WORDS.gig; const vs = d.title.split(/ vs\. /); const yr = (d.date.match(/(\d\d)$/) || [])[1] || '25';
      return TS.card({ kind, no: String(400000 + k * 7919).slice(0, 6), ol, fl, meta: `${d.venue} · ${d.date}`, a: vs[0].split(' — ')[0], b: vs[1] || '', sub: vs[1] ? '' : d.sub,
        boxes: [['Sec', d.sec], ['Row', d.row], ['Year', yr]], back: [['Venue', d.venue], ['Date', d.date], ['Sec · row · seat', `${d.sec} · ${d.row} · ${d.seat}`], ['Edition', 'Digital keepsake']], c1: d.c1, c2: d.c2 }); };
    [...extraDesigns.slice(0, 14), ...sceneDesigns].forEach((d, k) => {
      if (k % 3 === 1) ribbon.appendChild(asCard(extraDesigns[(k * 5 + 2) % extraDesigns.length], k));
      const c = mini(d); c.setAttribute('role','img'); c.setAttribute('aria-label', `Ticket art: ${d.title}`); ribbon.appendChild(c); });
    [...ribbon.children].slice(0, 12).forEach(c => { let k; if (c.tagName === 'CANVAS'){ k = c.cloneNode(); k.getContext('2d').drawImage(c, 0, 0); } else { k = c.cloneNode(true); delete k.dataset.wired; TS.wire(k); k.tabIndex = -1; }
      k.setAttribute('aria-hidden','true'); ribbon.appendChild(k); });
    // floating stubs at different depths in the quieter sections
    for (const [id, spots, off] of [['fl4', [[78,58,260,-9,.9],[88,30,170,12,.5],[70,84,150,-4,.4]], 2], ['fl2', [[44,4,150,-12,.45],[93,40,120,10,.35],[40,88,170,6,.6]], 11], ['fl3', [[70,6,190,-8,.55],[92,30,130,14,.4],[56,2,110,22,.3]], 19]]){
      const fl = byId(id);
      spots.forEach(([x,y,w,rot,depth], k) => { const c = mini(id === 'fl4' ? sceneDesigns[[0,2,7][k]] : extraDesigns[(k*7+off) % extraDesigns.length], 420); Object.assign(c.style, { left: x + '%', top: y + '%', width: w + 'px', filter: depth < .5 ? `blur(${(1-depth)*3}px)` : 'none', opacity: .35 + depth*.6 }); c.dataset.depth = depth; c.dataset.rot = rot; fl.appendChild(c); });
    }
    { const fl = byId('fl1'); const spots = [[4,12,180,-14,.6],[78,8,240,9,1],[88,62,150,-6,.45],[2,70,220,12,.8],[60,82,120,-20,.35],[30,4,130,6,.4]];
      spots.forEach(([x,y,w,rot,depth], k) => { const c = mini(extraDesigns[(k*5+3) % extraDesigns.length], 420); Object.assign(c.style, { left: x + '%', top: y + '%', width: w + 'px', filter: depth < .5 ? `blur(${(1-depth)*3}px)` : 'none', opacity: .5 + depth*.5 }); c.dataset.depth = depth; c.dataset.rot = rot; fl.appendChild(c); }); }
    // 2D stubs for the no-WebGL version
    byId('heroStub2d').getContext('2d').drawImage(texCache.get(heroDesign), 0, 0, 600, 220);
    qsa('.stage .stub2d').forEach(c => c.getContext('2d').drawImage(texCache.get(sceneDesigns[+c.dataset.scene]), 0, 0, 600, 220));
    // fallback wall
    // built only if the static version is needed
    let fallbackBuilt = false;
    function buildFallbackWall(){ if (fallbackBuilt) return; fallbackBuilt = true; const fb = byId('fallback'); [...sceneDesigns, ...extraDesigns].forEach(d => fb.appendChild(mini(d, 300))); }


    /* =============================== the loop: past the footer, stubs fly up and the page wraps back to the hero =============================== */
    // The hero (and the marquee under it) is copied to the very end of the page. When that copy reaches the top of the screen,
    // the page jumps to the same spot on the real hero, so the wrap is invisible; the 3D stub then drops back onto the disc.
    const loopZone = byId('loopzone'), loopLayer = byId('loopStubs'), cloneWrap = byId('heroClone');
    let cloneHero = null, cloneW = 0, zoneTop = 0, cloneTop = 0, loopItems = [], loopOn = false, nearLoop = false, readyAt = 0;
    function buildHeroClone(){
      const hero = byId('hero'), mq = qs('.marquee');
      if (cloneHero){ const i = navSections.indexOf(cloneHero); if (i > -1) navSections.splice(i, 1); }
      const h = hero.cloneNode(true), m = mq.cloneNode(true);
      for (const n of [h, m]){ n.removeAttribute('id'); n.querySelectorAll('[id]').forEach(e => e.removeAttribute('id')); n.querySelectorAll('.cta-in').forEach(e => e.classList.remove('cta-in', 'cta-late')); }
      h.querySelectorAll('.l').forEach(l => { l.style.transform = ''; });   // the scroll-linked parting is at rest at the top of the page
      // the copy always shows the hero as it looks once its intro has finished (letters set, press marks and swash drawn)
      h.querySelectorAll('.ch').forEach(c => c.removeAttribute('style'));
      h.querySelectorAll('.crop, .proofline').forEach(c => { c.style.opacity = '1'; c.style.transform = 'none'; c.style.clipPath = 'none'; });
      h.querySelectorAll('.reg').forEach(c => { c.style.opacity = '.9'; c.style.transform = 'none'; });
      h.querySelectorAll('.swash path').forEach(c => { c.style.strokeDashoffset = '0'; });
      const s2d = h.querySelector('canvas.stub2d'); if (s2d) s2d.getContext('2d').drawImage(byId('heroStub2d'), 0, 0);
      cloneWrap.replaceChildren(h, m);
      // keep the spinning ring and the marquee in step with the real ones
      const sync = (o, c) => { const a = o && o.getAnimations()[0], b = c && c.getAnimations()[0]; if (a && b && a.currentTime != null) b.currentTime = a.currentTime; };
      sync(hero.querySelector('.disc svg'), h.querySelector('.disc svg')); sync(mq.querySelector('.track'), m.querySelector('.track'));
      cloneHero = h; navSections.push(h); cloneW = innerWidth; measureLoop();
    }
    function measureLoop(){ zoneTop = docTop(loopZone); cloneTop = docTop(cloneWrap); streamTop = docTop(qs('footer')); }
    let streamTop = 0, lastSY = scrollY, lastT = performance.now();
    function buildLoopStubs(){
      loopLayer.replaceChildren(); loopItems = [];
      const phone = innerWidth < 760, n = phone ? 10 : 18, r = rnd(4242), vh = innerHeight;
      const pool = [...sceneDesigns.filter(d => SHOWN.includes(d.key)), ...extraDesigns];
      for (let k = 0; k < n; k++){
        const c = mini(pool[(k * 7) % pool.length], phone ? 360 : 480); c.className = 'loop-stub';
        const w = phone ? 100 + r() * 70 : 140 + r() * 130; c.style.width = w + 'px'; loopLayer.appendChild(c);
        loopItems.push({ el: c, w, h: w * TH / TW, x: (k + .2 + r() * .6) / n, y: vh + 40 + r() * vh * 1.4,   // start just under the footer's top edge
          rise: 55 + r() * 70, rz: r() * 40 - 20, spin: (r() * 2 - 1) * 70, fx: .5 + r() * .7, sway: 16 + r() * 40, ph: r() * 6.283, age: r() * 10 });
      }
    }
    function respawn(it, vh, below){ it.y = below ? vh + 40 + Math.random() * vh * .5 : -it.h - 60 - Math.random() * 200; it.x = .05 + Math.random() * .9; }
    function jumpTo(y){ window.scrollTo({ top: y, behavior: 'instant' }); }
    function loopTick(){
      const sy = scrollY, vh = innerHeight, vw = innerWidth;
      const p = (sy + vh - zoneTop) / Math.max(1, cloneTop - zoneTop + vh);   // progress through the fade (used to prepare the hero copy)
      if (!readyAt && root.classList.contains('ready')) readyAt = performance.now();
      // a fresh copy is taken every time the visitor heads for the end (the intro has long settled by then, and the copy is off screen)
      const near = p > -.6 && readyAt && performance.now() - readyAt > 3000;
      if (near && (!nearLoop || !cloneHero || cloneW !== vw)) buildHeroClone();
      nearLoop = near;
      // the stream runs from the moment the footer's top edge comes up the screen until the wrap
      const q = (sy + vh - streamTop) / Math.max(1, cloneTop + vh - streamTop);   // 0 when the footer's top edge reaches the bottom of the screen, 1 at the wrap
      const on = q > 0 && q < 1 && !reduced;
      const now = performance.now(), dt = Math.min(.05, (now - lastT) / 1000), dsy = sy - lastSY; lastT = now; lastSY = sy;
      if (on !== loopOn){ loopOn = on; loopLayer.classList.toggle('on', on); if (on){ if (!loopItems.length || loopItems.phone !== (vw < 760)) { buildLoopStubs(); loopItems.phone = vw < 760; } else loopItems.forEach(it => { it.y = vh + 40 + Math.random() * vh * 1.4; }); } }
      if (on){
        const CUT = .74, closing = q > CUT;
        // near the end every stub is pushed up and out, so none is on screen when the page wraps
        const ceil = closing ? vh + 60 - ((q - CUT) / (1 - CUT)) * (vh + 420) : Infinity;
        for (const it of loopItems){
          it.age += dt;
          it.y -= it.rise * dt + (Math.abs(dsy) < vh ? dsy * .85 : 0);   // drifts up on its own and rides the scroll
          if (it.y < -it.h - 260){ if (!closing) respawn(it, vh, true); }
          else if (it.y > vh + vh * 1.6) respawn(it, vh, false);
          if (it.y > ceil) it.y = ceil;
          const t = it.age;
          const x = it.x * vw - it.w / 2 + Math.sin(t * it.fx * 1.9 + it.ph) * it.sway;
          // paper in an updraft: flutter (X), yaw (Y) and a slow turn
          it.el.style.transform = `translate3d(${x.toFixed(1)}px,${it.y.toFixed(1)}px,0) rotateZ(${(it.rz + it.spin * t).toFixed(1)}deg) rotateX(${(Math.sin(t * it.fx * 3.1 + it.ph) * 52).toFixed(1)}deg) rotateY(${(Math.cos(t * it.fx * 1.7 + it.ph) * 34).toFixed(1)}deg)`;
        }
      }
      if (cloneHero && cloneTop > 0 && sy >= cloneTop){   // the copy is at the top of the screen: swap in the real hero
        // the real ring and marquee pick up exactly where the copy's are, so nothing jumps
        const step = (from, to) => { const a = from && from.getAnimations()[0], b = to && to.getAnimations()[0]; if (a && b && a.currentTime != null) b.currentTime = a.currentTime; };
        step(cloneHero.querySelector('.disc svg'), qs('#hero .disc svg'));
        step(cloneWrap.querySelector('.marquee .track'), byId('mq'));
        jumpTo(Math.max(0, sy - cloneTop));
        if (TSMotion && TSMotion.drop) TSMotion.drop();
      }
      requestAnimationFrame(loopTick);
    }
    measureLoop();
    addEventListener('resize', () => { measureLoop(); if (loopItems.length){ buildLoopStubs(); loopItems.phone = innerWidth < 760; } });
    if (window.ResizeObserver){ const ro = new ResizeObserver(measureLoop); ro.observe(document.body); disposers.push(() => ro.disconnect()); }
    requestAnimationFrame(loopTick);

    /* =============================== board state (shared by the 3D and static versions) =============================== */
    const root = lpRoot;
    const boardEl = byId('wall'), boardUI = byId('boardUI'), finale = byId('finale'), bh1 = byId('bh1');
    const WALL = { heroesEnd: .40, swarmEnd: .76, finaleAt: .78 };   // progress through the 560vh wall: heroes land, the swarm fills it, then "Make yours!"
    let bhState = -1;
    finale.inert = true;   // never focusable while it can't be seen
    function boardState(br, Hh){
      const show = br.top < Hh * .2 && br.bottom > Hh * .98;
      if (boardUI.hidden === show) boardUI.hidden = !show;
      const P = Math.max(0, Math.min(1, -br.top / (br.height - Hh)));
      const on = show && P > WALL.finaleAt;
      if (finale.classList.contains('on') !== on){ finale.classList.toggle('on', on); finale.inert = !on; }
      boardUI.classList.toggle('fin', P > WALL.finaleAt - .04);
      if (!root.classList.contains('no3d')){
        boardUI.classList.toggle('swarm', P > WALL.heroesEnd);
        const state = P < WALL.heroesEnd ? 0 : P < WALL.swarmEnd ? 1 : 2;
        if (state !== bhState){ bhState = state; bh1.textContent = state === 0 ? 'Pin the nights that mattered.' : 'Then all of them, at once.'; bh1.classList.toggle('out', state === 2); }
      }
      return P;
    }
    // nav colour follows whatever section sits under it (read and write are split so the frame loop can batch them)
    let navCol = '';
    function navColour(){ for (const s of navSections){ const r = s.getBoundingClientRect(); if (r.top <= 40 && r.bottom > 40) return s.dataset.nav; } return '#17140f'; }
    function paintNav(nav, col){ if (col === navCol) return; navCol = col; nav.style.setProperty('--navc', col); nav.style.setProperty('--navbg', col === '#17140f' ? '#f4ecdd' : '#17140f'); }

    /* ---------- in-page links: a short glide, and "Make yours" lands focus in the form ---------- */
    const ev = byId('ev');
    function focusMaker(){   // wait until the finale is actually showing, then put the cursor in the field
      const t0 = performance.now(); let stopped = false; const stop = () => { stopped = true; };
      addEventListener('wheel', stop, { once: true, passive: true }); addEventListener('touchstart', stop, { once: true, passive: true });
      const tryFocus = () => { if (stopped) return; if (!finale.inert){ ev.focus({ preventScroll: true }); return; } if (performance.now() - t0 < 2500) requestAnimationFrame(tryFocus); };
      requestAnimationFrame(tryFocus);
    }
    qsa('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
      const id = a.getAttribute('href'); const t = qs(id); if (!t) return; e.preventDefault();
      const make = id === '#make';
      const y = make ? docTop(boardEl) + boardEl.offsetHeight - innerHeight * 1.02 : t.getBoundingClientRect().top + scrollY;
      try { history.replaceState(history.state, '', id); } catch (err) {}
      scrollTo({ top: y, behavior: reduced ? 'auto' : 'smooth' });
      if (make) focusMaker();
    }));

    // Progress follows native scroll events in both 3D and fallback modes.
    const rail = qs('.rail');
    function updateRail(){
      const max = document.documentElement.scrollHeight - innerHeight;
      rail.style.setProperty('--rp', (max > 0 ? Math.max(0, Math.min(1, scrollY / max)) : 0).toFixed(4));
    }
    addEventListener('scroll', updateRail, { passive: true });
    addEventListener('resize', updateRail);
    updateRail();

    /* =============================== 3D, with the printed (2D) version standing in =============================== */
    let staticLoop = null, dead3d = false;
    function useStatic(){
      if (disposed) return;
      root.classList.add('no3d');
      // A failed 3D frame may have hidden entering scene copy; restore its CSS defaults.
      sceneEls.forEach(el => el.querySelector('.info').style.removeProperty('--ia'));
      if (!staticLoop) staticLoop = startStaticLoop();
    }
    function leaveStatic(){ if (staticLoop){ staticLoop.stop(); staticLoop = null; } root.classList.remove('no3d'); }
    const threeP = build3D().then(start => start, err => { console.warn('3D unavailable, showing the static version', err); return null; });
    // reveal as soon as the 3D hero is ready, or after a short wait with the printed stub on the disc instead
    const first = await Promise.race([threeP, new Promise(r => setTimeout(() => r('wait'), 3500))]);
    clearTimeout(safety);
    if (disposed) return;
    if (typeof first !== 'function') useStatic();
    dismissLoader();
    threeP.then(start => {
      if (disposed) return;
      if (start && !dead3d){
        const late = root.classList.contains('no3d');
        leaveStatic(); start();
        if (late && TSMotion && TSMotion.drop) TSMotion.drop();   // the 3D stub drops onto the disc in place of the printed one
      } else useStatic();
    });

    // sizes and positions a scene's performer (or photo panel); returns the hand point [x, y] the stub leaves from
    function placeFigure(sceneEl, i, left, W, H, phone){
      const s = SCENES[i]; const stage = sceneEl.querySelector('.stage');
      let hx, hy;
      if (s.panel){
        const fig = stage.querySelector('.panel'); const img = fig.querySelector('img');
        const ar = (img.naturalWidth / img.naturalHeight) || .667;
        const pw = Math.min(W * (phone ? .9 : .5), H * ar * 1.05), ph = H;
        const lx = left ? 0 : W - pw;
        Object.assign(fig.style, { width: pw + 'px', left: lx + 'px' });
        const sc = Math.max(pw / img.naturalWidth, ph / img.naturalHeight);
        const dx = (pw - img.naturalWidth * sc) / 2, dy = (ph - img.naturalHeight * sc) / 2;
        hx = lx + dx + s.anchor[0] * img.naturalWidth * sc; hy = dy + s.anchor[1] * img.naturalHeight * sc;
      } else {
        const img = stage.querySelector('.athlete'); const [u, v] = s.anchor;
        const ar = (img.naturalWidth / img.naturalHeight) || .8;
        const big = s.key === 'hockey' ? .9 : s.key === 'festival' ? .66 : s.key === 'theater' ? .68 : s.key === 'soccer' ? .9 : .95;
        let h = H * (phone ? big * .5 : big);
        let w = h * ar; const maxW = W * (phone ? .92 : .56); if (w > maxW){ w = maxW; h = w / ar; }
        let top = phone ? H * .24 : H - h * .97;
        if (s.key === 'hockey') top = H - h - H * (phone ? .3 : .08);
        if (s.key === 'festival') top = H - h - H * (phone ? .3 : .02);
        if (s.key === 'basketball' && !phone) top = H * .12;
        if (s.key === 'theater') top = phone ? H * .26 : H * .04;   // keep her back foot clear of the info panel
        if (s.key === 'soccer') top = phone ? H * .22 : H * .05;
        hx = left ? W * (phone ? .8 : .42) : W * (phone ? .2 : .58);
        if (s.key === 'hockey') hx = W * (phone ? .16 : .4);   // the stick blade: the player follows through to the right of it
        if (s.key === 'festival') hx = W * (phone ? .12 : .5);
        if (s.key === 'theater') hx = W * (phone ? .5 : .3);
        if (s.key === 'soccer') hx = W * (phone ? .5 : .27);
        hy = top + v * h;
        Object.assign(img.style, { width: w + 'px', height: h + 'px', left: (hx - u * w) + 'px', top: top + 'px' });
        img.style.setProperty('--ox', (u*100) + '%'); img.style.setProperty('--oy', (v*100) + '%');
      }
      stage.style.setProperty('--hx', hx + 'px'); stage.style.setProperty('--hy', hy + 'px');
      return [hx, hy];
    }

    function startStaticLoop(){
      const nav = byId('nav'); let lastY = scrollY, live = true;
      const scenes = [...qsa('.scene')].map(el => ({ el, st: el.querySelector('.stage'), hand: [0, 0] }));
      // without the 3D layout the performers still need placing (even scenes = performer on the left)
      const place = () => { const W = innerWidth, H = innerHeight; scenes.forEach(s => { const i = +s.el.dataset.i; s.hand = placeFigure(s.el, i, i % 2 === 0, W, H, W < 760); }); };
      place(); addEventListener('resize', place);
      scenes.forEach(s => s.el.querySelectorAll('.athlete,.panel img').forEach(im => { if (!im.complete) im.addEventListener('load', place, { once: true }); }));
      const tick = () => {
        if (!live) return;
        const sy = scrollY, Hh = innerHeight, Ww = innerWidth;
        // reads
        const col = navColour(); const rs = scenes.map(s => s.el.getBoundingClientRect()); const b = boardEl.getBoundingClientRect();
        // writes
        paintNav(nav, col); const onWall = b.top < Hh * .9 && b.bottom > Hh;
        if ((sy > lastY + 2 && sy > 400) || onWall) nav.classList.add('hide'); else if (sy < lastY - 2) nav.classList.remove('hide'); lastY = sy;
        scenes.forEach(({ st, hand }, i) => { const r = rs[i]; if (r.top > Hh || r.bottom < 0) return;
          const p = Math.max(0, Math.min(1, -r.top / (r.height - Hh))); const t = Math.max(0, Math.min(1, (p - .1) / .8)); const dir = i % 2 ? -1 : 1;
          st.style.setProperty('--hx', hand[0] + 'px'); st.style.setProperty('--hy', hand[1] + 'px');
          st.style.setProperty('--tx', (dir * t * Ww * .8) + 'px'); st.style.setProperty('--ty', (Math.sin(t * Math.PI) * -80 + t * 120) + 'px'); st.style.setProperty('--tr', (dir * t * 220) + 'deg'); });
        if (!fallbackBuilt && b.top < Hh * 3) buildFallbackWall();
        boardState(b, Hh);
        requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      return { stop(){ live = false; removeEventListener('resize', place); } };
    }

    async function build3D(){
      const THREE = await import('three');
      if (disposed) throw new Error('unmounted');
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
      const canvas = byId('gl');
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(devicePixelRatio, innerWidth < 760 ? 1.6 : 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.VSMShadowMap;
      canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); if (disposed) return; dead3d = true; useStatic(); }, { once: true });
      disposers.push(() => { try { renderer.dispose(); renderer.forceContextLoss(); } catch (e) {} });
      const scene = new THREE.Scene();
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 0.75;
      const fill = new THREE.DirectionalLight(0xffe7cc, 0.45); fill.position.set(8, -6, 10); scene.add(fill);
      const camera = new THREE.PerspectiveCamera(30, innerWidth/innerHeight, 0.1, 200);
      const D = 32; camera.position.set(0, 0, D);
      scene.add(new THREE.HemisphereLight(0xfff4e0, 0x2a1a10, 0.35));
      const key = new THREE.DirectionalLight(0xfff1dc, 1.5);
      key.position.set(-7, 9, 16); key.castShadow = true;
      const smallScreen = innerWidth < 760;
      key.shadow.mapSize.set(smallScreen ? 1024 : 2048, smallScreen ? 1024 : 2048);
      renderer.shadowMap.autoUpdate = false;   // shadows only change when the wall moves; tick() asks for an update then Object.assign(key.shadow.camera, { left: -12, right: 12, top: 9, bottom: -9, near: 1, far: 60 });
      key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02; key.shadow.radius = 9; key.shadow.blurSamples = 16;
      scene.add(key); scene.add(key.target);

      const loadWithTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
      const gltfP = new Promise((res, rej) => new GLTFLoader().load('/landing/ticketstub.gltf.json', res, e => { if (e.total) setProgress(0.1 + 0.6 * e.loaded / e.total); }, rej));
      const flightP = fetch('/landing/flight.json').then(r => { if (!r.ok) throw new Error('flight'); return r.json(); });
      const [gltf, flight] = await loadWithTimeout(Promise.all([gltfP, flightP]), 25000);
      if (disposed) throw new Error('unmounted');
      setProgress(0.85);

      const META = flight.meta, WEIGHTS = flight.weights, FPS = META.fps;
      const backTex = new THREE.CanvasTexture(drawBack()); backTex.colorSpace = THREE.SRGBColorSpace; backTex.anisotropy = 8; backTex.flipY = false;
      const backMat = new THREE.MeshStandardMaterial({ map: backTex, roughness: .8, emissive: 0x2a2116, emissiveIntensity: 1 });
      const edgeMat = new THREE.MeshStandardMaterial({ color: 0xe6dac2, roughness: .9 });
      const texFor = new Map();
      function tex(design){ if (!texFor.has(design)){ const t = new THREE.CanvasTexture(texCache.get(design)); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.flipY = false; texFor.set(design, t); } return texFor.get(design); }
      const PALS = [['#17140f','#f2b33d'],['#7a0b1d','#e0b25a'],['#1b3fd1','#ffffff'],['#0f5c3d','#f2b33d'],['#3a1c71','#ffaf7b'],['#0e3b43','#ffcf6e'],['#c8102e','#ffffff'],['#2b1608','#ffbe3d']];
      const TPLS = ['sport','gig','theater','fest'];
      function variant(d, j){
        const v = Math.floor(j / EXTRA.length); if (!v) return d;
        const r = rnd(j * 977); const pal = PALS[Math.floor(r() * PALS.length)];
        const tpl = v % 2 ? TPLS[(TPLS.indexOf(d.tpl) + 1 + Math.floor(r()*2)) % 4] : d.tpl;
        const A = ['Juniper','Westbound','Lowlight','Marigold','Ironwood','Saltwater','Northern','Velvet','Copper','Bright Lights','Halfmoon','Riverside','Sundown','Glasshouse','Paper Kites','Midnight'];
        const B = ['Revue','Sessions','Tour','Live','Showcase','Classic','Open','Gala','Weekender','Cup'];
        const fresh = `${A[Math.floor(r()*A.length)]} ${B[Math.floor(r()*B.length)]}`;
        const title = tpl === 'sport' ? fresh : `${fresh} — ${d.sub}`;
        const nd = { ...d, tpl, title, c1: pal[0], c2: pal[1], seed: d.seed + j * 13, sec: String(100 + (j*29)%200), row: String.fromCharCode(65 + (j*3)%22), seat: String(1 + (j*11)%40) };
        texCache.set(nd, drawSmall(nd, 480)); return nd;   // swarm stubs are small on screen; 480 px keeps them crisp at a quarter of the memory
      }
      const frontMat = (design, opts = {}) => new THREE.MeshStandardMaterial({ map: tex(design), roughness: .6, envMapIntensity: .55, ...opts });
      const sceneMats = sceneDesigns.map(d => frontMat(d));

      function dress(node, fMat, bMat = backMat, eMat = edgeMat){
        node.traverse(o => {
          if (!o.isMesh) return;
          o.castShadow = true; o.receiveShadow = true;
          const n = o.material.name;
          o.material = n === 'TicketFront' ? fMat : n === 'TicketBack' ? bMat : n === 'TicketEdge' ? eMat : o.material;
          o.frustumCulled = false;
        });
      }
      const morphMeshes = node => { const out = []; node.traverse(o => { if (o.isMesh && o.morphTargetInfluences) out.push(o); }); return out; };

      const root = gltf.scene;
      const nodes = {}; root.traverse(o => { if (o.name) nodes[o.name] = o; });
      const tracks = {};
      for (const clip of gltf.animations) for (const tr of clip.tracks){ const [nodeName, prop] = tr.name.split('.'); (tracks[nodeName] ||= {})[prop] = tr.createInterpolant(); }
      function applyFrame(name, frame){
        const n = nodes[name], tr = tracks[name]; if (!n || !tr) return;
        const t = frame / FPS;
        if (tr.position) n.position.fromArray(tr.position.evaluate(t));
        if (tr.quaternion) n.quaternion.fromArray(tr.quaternion.evaluate(t));
        if (tr.scale) n.scale.fromArray(tr.scale.evaluate(t));
        const W = WEIGHTS[name];
        if (W && n.userData.morph){
          const f = Math.round(frame); const w = f < W.start ? null : W.w[Math.max(0, Math.min(W.w.length - 1, f - W.start))];
          for (const m of n.userData.morph) for (let k = 0; k < 5; k++) m.morphTargetInfluences[k] = w ? w[k] : 0;
        }
      }

      const throwGroup = new THREE.Group(); scene.add(throwGroup);
      const boardGroup = new THREE.Group(); scene.add(boardGroup);
      const throwNames = META.throws.map(t => t.name);
      const throwWraps = throwNames.map((nm, i) => { const n = nodes[nm]; dress(n, sceneMats[i]); n.userData.morph = morphMeshes(n); const w = new THREE.Group(); w.add(n); throwGroup.add(w); n.visible = false; return w; });

      // walnut moulding grain for the frame (runs along each mitred bar via the Blender UVs)
      function woodCanvas(){
        const c = document.createElement('canvas'); c.width = 1024; c.height = 256; const x = c.getContext('2d');
        x.fillStyle = '#4b2c17'; x.fillRect(0, 0, 1024, 256); const r = rnd(7);
        for (let i = 0; i < 140; i++){ const y0 = r() * 256, a = .04 + r() * .12, ph = r() * 6, amp = 2 + r() * 6;
          x.strokeStyle = r() > .5 ? `rgba(20,9,3,${a})` : `rgba(140,90,50,${a * .8})`; x.lineWidth = .6 + r() * 2.2; x.beginPath();
          for (let X = 0; X <= 1024; X += 16) x.lineTo(X, y0 + Math.sin(X / 140 + ph) * amp + Math.sin(X / 37 + ph * 2) * amp * .25); x.stroke(); }
        return c;
      }
      // cork: fine granules, soft contrast, slow tonal drift. Drawn in slices during idle time, off the critical path.
      const corkC = document.createElement('canvas'); corkC.width = 2048; corkC.height = 1280;
      function* corkSteps(){
        const x = corkC.getContext('2d');
        const g = x.createLinearGradient(0, 0, 2048, 1280); g.addColorStop(0, '#b0814f'); g.addColorStop(.5, '#a57546'); g.addColorStop(1, '#b38552');
        x.fillStyle = g; x.fillRect(0, 0, 2048, 1280);
        const r = rnd(42);
        for (let i = 0; i < 160000; i++){
          const v = r(); x.fillStyle = v < .5 ? `rgba(110,72,38,${.15 + r()*.3})` : v < .85 ? `rgba(205,162,110,${.15 + r()*.3})` : `rgba(70,42,20,${.2 + r()*.35})`;
          const sz = .6 + r()*r()*3.2; x.beginPath(); x.ellipse(r()*2048, r()*1280, sz, sz*(0.45+r()*.6), r()*3, 0, 7); x.fill();
          if (i % 8000 === 7999) yield;
        }
        for (let i = 0; i < 380; i++){ x.fillStyle = `rgba(60,35,15,${.25 + r()*.25})`; x.beginPath(); x.arc(r()*2048, r()*1280, .8 + r()*1.2, 0, 7); x.fill(); } // old pin holes
        const corkTex = new THREE.CanvasTexture(corkC); corkTex.colorSpace = THREE.SRGBColorSpace; corkTex.anisotropy = 8; corkTex.flipY = false;
        corkMat.map = corkTex; corkMat.bumpMap = corkTex; corkMat.color.set(0xffffff); corkMat.needsUpdate = true;
      }
      const corkMat = new THREE.MeshStandardMaterial({ color: 0xab7c4b, bumpScale: 1.4, roughness: .95 });   // plain cork colour until the texture is ready
      nodes['Cork'].traverse(o => { if (o.isMesh){ o.material = corkMat; o.receiveShadow = true; } });
      const woodTex = new THREE.CanvasTexture(woodCanvas()); woodTex.colorSpace = THREE.SRGBColorSpace; woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping; woodTex.anisotropy = 8;
      nodes['Frame'].traverse(o => { if (o.isMesh){ o.material = new THREE.MeshStandardMaterial({ map: woodTex, bumpMap: woodTex, bumpScale: .6, roughness: .5, metalness: .02 }); o.castShadow = true; o.receiveShadow = true; } });
      boardGroup.add(nodes['Cork'], nodes['Frame']);

      const pinSrc = nodes['Pin'];
      const pinMats = [0xd8432c, 0xe2a83c, 0xece4d2].map(c => new THREE.MeshPhysicalMaterial({ color: c, roughness: .5, clearcoat: .15 }));
      // backs and edges look the same on every stub, so they share one material per depth layer (only the front art differs)
      const layerMats = new Map();
      const matsForLayer = (layer, po) => { if (!layerMats.has(layer)) layerMats.set(layer, {
        back: new THREE.MeshStandardMaterial({ map: backTex, roughness: .8, emissive: 0x2a2116, emissiveIntensity: 1, ...po }),
        edge: new THREE.MeshStandardMaterial({ color: 0xe6dac2, roughness: .9, ...po }) }); return layerMats.get(layer); };
      // two walls from Blender: landscape (B..) for wide screens, portrait (P..) for phones. Only the one this screen needs is built,
      // a few stubs at a time during idle moments; if the visitor reaches the wall first, the rest is finished on the spot.
      const WALLSRC = { B: [META.heroes, META.swarm], P: [META.heroesP, META.swarmP] };
      const walls = { B: null, P: null }, wallJobs = {};
      let corkJob = corkSteps();
      function* wallSteps(key){
        const [hs, sw] = WALLSRC[key], boardItems = [];
        const list = [...hs.map(h => ({ ...h, hero: true })), ...sw];
        for (let j = 0; j < list.length; j++){
          const b = list[j], n = nodes[b.name];
          const layer = Math.round((b.slot[2] - 0.006) / 0.008);
          const po = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -(layer + 1) * 4 };
          const design = b.hero ? sceneDesigns[SCENES.findIndex(sc => sc.key === b.event)] : variant(extraDesigns[(j * 7) % extraDesigns.length], j);
          const lm = matsForLayer(layer, po);
          dress(n, frontMat(design, po), lm.back, lm.edge);
          n.userData.morph = morphMeshes(n); n.visible = false; boardGroup.add(n);
          let pin = null;
          if (b.pin){
            pin = pinSrc.clone(true);
            const pm = b.hero ? pinMats[0] : pinMats[j % 3];
            pin.traverse(o => { if (o.isMesh){ o.material = pm; o.castShadow = true; } });
            const [sx, sy, sz] = b.slot, a = b.angle, [ox, oy] = b.pin;
            pin.position.set(sx + ox*Math.cos(a) - oy*Math.sin(a), sy + ox*Math.sin(a) + oy*Math.cos(a), sz + 0.008);
            pin.rotation.z = j; pin.scale.setScalar(0.0001); pin.visible = false; boardGroup.add(pin);
          }
          const meshes = []; n.traverse(o => { if (o.isMesh) meshes.push(o); });
          boardItems.push({ name: b.name, start: b.frames[0], land: b.land, end: b.frames[1] + 1, pin, slot: b.slot, hero: !!b.hero, meshes, cast: true });
          if (j % 4 === 3) yield;
        }
        walls[key] = boardItems;
      }
      const wallKeyNow = () => innerWidth < 760 ? 'P' : 'B';
      function drain(job){ if (job) while (!job.next().done); }
      function ensureWall(key){ drain(corkJob); corkJob = null; if (!walls[key]){ drain(wallJobs[key] ||= wallSteps(key)); } return walls[key]; }
      // idle pump: about 10 ms of building per slice so scrolling never stalls
      const idle = window.requestIdleCallback ? cb => requestIdleCallback(cb, { timeout: 200 }) : cb => setTimeout(() => cb({ timeRemaining: () => 10 }), 16);
      function pump(deadline){
        if (disposed) return;
        const key = wallKeyNow(); const t0 = performance.now(); const budget = () => Math.min(12, deadline.timeRemaining ? Math.max(4, deadline.timeRemaining()) : 10);
        while (performance.now() - t0 < budget()){
          if (corkJob){ if (corkJob.next().done) corkJob = null; continue; }
          if (walls[key]) return;
          const job = wallJobs[key] ||= wallSteps(key);
          if (job.next().done) return;
        }
        idle(pump);
      }
      let activeWall = null;

      // hero ticket: the Blender mesh, black and gold, on the punched red disc
      const heroTicket = new THREE.Group();
      const heroMesh = nodes['Ticket'].clone(true); heroMesh.position.set(0,0,0); heroMesh.quaternion.identity(); heroMesh.scale.setScalar(1);
      dress(heroMesh, new THREE.MeshPhysicalMaterial({ map: tex(heroDesign), roughness: .45, clearcoat: .6, clearcoatRoughness: .3, envMapIntensity: .5 }));
      heroMesh.traverse(o => { if (o.isMesh) o.castShadow = false; });
      heroTicket.add(heroMesh); scene.add(heroTicket);

      const heroMorph = morphMeshes(heroMesh);
      setProgress(1);

      /* ---------- layout ---------- */
      const sceneEls = [...qsa('.scene')];
      const heroEl = byId('hero'), boardEl = byId('wall'), discEl = byId('disc');
      let W = innerWidth, H = innerHeight, stageScale = 1, visW = 1, visH = 1;
      const visibleAt = dist => { const h = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov/2)); return [h * camera.aspect, h]; };
      function screenToWorld(x, y, zPlane){
        const v = new THREE.Vector3((x / W) * 2 - 1, -(y / H) * 2 + 1, .5).unproject(camera);
        const dir = v.sub(camera.position).normalize(); const t = (zPlane - camera.position.z) / dir.z;
        return camera.position.clone().add(dir.multiplyScalar(t));
      }
      const heroBase = new THREE.Vector3(); let heroW = 1; const throwOffsets = [];
      function layout(){
        W = innerWidth; H = innerHeight; const phone = W < 760;
        renderer.setSize(W, H, false); camera.aspect = W/H; camera.updateProjectionMatrix();
        camera.position.set(0, 0, D); camera.lookAt(0,0,0); camera.updateMatrixWorld();
        [visW, visH] = visibleAt(D);
        stageScale = Math.min(visW / (phone ? 8.5 : 15.5), visH / 9);
        throwGroup.scale.setScalar(stageScale); throwGroup.updateMatrixWorld(true);
        META.throws.forEach((t, i) => {
          const sceneEl = qs(`.scene[data-i="${i}"]`); if (!sceneEl) return;
          const [hx, hy] = placeFigure(sceneEl, i, t.side < 0, W, H, phone);
          const startW = new THREE.Vector3(...t.start).multiplyScalar(stageScale);
          throwOffsets[i] = screenToWorld(hx, hy, startW.z).sub(startW).divideScalar(stageScale);
        });
        const prevT = discEl.style.transform, prevTr = discEl.style.transition;
        discEl.style.transition = 'none'; discEl.style.transform = phone ? 'none' : 'translateY(-46%)';
        const dr = discEl.getBoundingClientRect();
        discEl.style.transform = prevT; void discEl.offsetWidth; discEl.style.transition = prevTr;
        const cx = dr.left + dr.width / 2, cy = dr.top + dr.height / 2 + scrollY;   // document coords
        heroBase.copy(screenToWorld(cx, cy, 2.4));
        const a = screenToWorld(dr.left, cy, 2.4), b = screenToWorld(dr.right, cy, 2.4);
        heroW = a.distanceTo(b);
      }
      layout();
      addEventListener('resize', layout);
      qsa('.athlete,.panel img').forEach(im => { if (!im.complete) im.addEventListener('load', layout, { once: true }); });

      /* ---------- scroll engine ---------- */
      // Read native scrolling; page input must never depend on an animation frame.
      const clamp = (x, a=0, b=1) => Math.max(a, Math.min(b, x));
      const ease = t => t*t*(3 - 2*t);
      let mouseX = 0, mouseY = 0;
      addEventListener('pointermove', e => { mouseX = e.clientX / W - .5; mouseY = e.clientY / H - .5; });
      const tallyEl = byId('tally'), nav = byId('nav');
      const ribbonSec = qs('.gallery'); const flAll = ['fl1','fl2','fl3','fl4'].map(id => byId(id));
      let shownTally = 0, panS = 0, lastF = -1, camFx = 0, camFy = 0;
      let clock = 0, last = performance.now(), lastY = scrollY, lastTally = -1, drewLast = true, shadowKey = '', ribbonSpan = 0, navHidden = false;
      // per-scene nodes looked up once, never inside the frame loop
      const sceneParts = sceneEls.map(el => { const st = el.querySelector('.stage'); return { el, i: +el.dataset.i, st, bar: st.querySelector('.counter .bar i'), info: st.querySelector('.info'), fig: st.querySelector('.athlete, .panel'), bokeh: st.querySelector('.bokeh') }; });
      const measureRibbon = () => { ribbonSpan = ribbon.scrollWidth * .5 - innerWidth * .2; }; measureRibbon(); addEventListener('resize', measureRibbon);
      const BF = META.frames;
      const heroLandEnd = META.heroes[META.heroes.length-1].land + 14;
      const HE = .40, SE = .76;   // wall timeline: heroes land one by one until HE, the swarm fills it by SE, then the CTA
      const keyOff = new THREE.Vector3(-7, 9, 16);

      function tick(now){
        if (dead3d || disposed) return;   // WebGL context lost: the static version has taken over
        try {
        const dt = Math.min(.05, (now - last) / 1000); last = now; clock += reduced ? 0 : dt;
        /* ---- reads: every measurement for this frame, before any style is written ---- */
        const sy = scrollY;
        const navCol = navColour();
        const wb = boardEl.getBoundingClientRect(), hr = heroEl.getBoundingClientRect();
        const srs = sceneParts.map(sp => sp.el.getBoundingClientRect());
        const frs = flAll.map(f => f.getBoundingClientRect());
        const gr = ribbonSec.getBoundingClientRect();
        /* ---- writes ---- */
        paintNav(nav, navCol);
        { const onWall = wb.top < H * .9 && wb.bottom > H;
          if ((sy > lastY + 2 && sy > 400) || onWall){ if (!navHidden){ nav.classList.add('hide'); navHidden = true; } }
          else if (sy < lastY - 2 && navHidden){ nav.classList.remove('hide'); navHidden = false; } }
        nav.classList.toggle('solid', sy > 60);
        lastY = sy;

        /* hero ticket */
        const hq = clamp(-hr.top / (hr.height * 1.6));
        heroTicket.visible = hq < 1;
        if (heroTicket.visible){
          const s = heroW * 1.02 / 3;
          const ip = hs.intro ?? 1, drop = 1 - ip, spin = hs.spin || 0;   // driven by Motion springs (see TSMotion)
          heroTicket.scale.setScalar(s * (1 - Math.pow(hq, 3) * .95) * (.72 + .28 * Math.min(ip, 1.15)));
          // ride along with the disc as the page scrolls, then lift off and drift toward the camera
          // it lags behind the page (drifts down with you), sweeps toward centre and spins away
          heroTicket.position.set(heroBase.x + Math.sin(clock*.6)*.06*s - clamp((hq - .3) / .7) * (heroBase.x * 1.1),
                                  heroBase.y + (sy / H) * visH * ((D - 2.4) / D) * .9 + Math.sin(clock*.9)*.05*s + drop * visH * .62,
                                  2.4 + hq * 7);
          heroTicket.rotation.set(-.42 + mouseY*.3 + hq * 1.4 + drop * .9, -.55 + mouseX*.5 + Math.sin(clock*.5)*.12 + hq * 2.2 + spin, -.16 + Math.sin(clock*.4)*.04 + hq * 1.1 - drop * 1.3);

          const breathe = Math.sin(clock*1.3);
          for (const m of heroMorph){ m.morphTargetInfluences[0] = .22 + breathe*.06 + hq*.35; m.morphTargetInfluences[2] = Math.sin(clock*.8)*.07 + hq*.25; m.morphTargetInfluences[3] = Math.sin(clock*2.1)*.04 + Math.sin(clock*9)*Math.min(.5, Math.abs(drop) * .9 + Math.abs(hs.spinV || 0) * .02); m.morphTargetInfluences[4] = .05 + Math.sin(clock*1.7+1)*.05; }
        }

        /* scenes */
        let anyThrow = false;
        sceneParts.forEach((sp, k) => { const i = sp.i, r = srs[k], st = sp.st;
          const nm = throwNames[i]; const n = nodes[nm];
          if (!(r.top < H && r.bottom > 0)){ n.visible = false; return; }
          const p = clamp(-r.top / (r.height - H));
          const enter = clamp((H - r.top) / H);
          st.style.setProperty('--fp', (clamp((p - .05) / .75) * 100).toFixed(1) + '%');
          sp.bar.style.width = (p*100).toFixed(1) + '%';
          sp.info.style.setProperty('--ia', ease(clamp((enter - .45) / .5)).toFixed(3));
          const fig = sp.fig;
          const throwP = clamp((p - .1) / .8);   // held in the hand until .1, then released
          const lean = Math.sin(throwP * Math.PI) * (i % 2 ? 1 : -1);
          const release = Math.sin(clamp(throwP / .3) * Math.PI) * (i % 2 ? -1 : 1) * 26;   // body follows through on the release
          const slide = (1 - ease(enter)) * (i % 2 ? 120 : -120);
          fig.style.transform = fig.classList.contains('panel') ? `translate3d(${slide}px,0,0) scale(${1.04 - throwP * .04})`
            : `translate3d(${slide + release}px, ${(1 - ease(enter)) * 60 - Math.abs(release) * .3}px,0) rotate(${lean * 2.6}deg) scale(${1 + throwP * .03})`;
          const bp = clamp(throwP / .18);
          st.style.setProperty('--bo', (Math.sin(bp * Math.PI) * .9).toFixed(3)); st.style.setProperty('--bs', (.4 + bp * 1.3).toFixed(3)); st.style.setProperty('--br', (bp * 40).toFixed(1) + 'deg');
          sp.bokeh.style.transform = `translate3d(0, ${((p - .5) * -140).toFixed(1)}px, 0)`;
          const frame = META.throws[i].frames[0] + 0.6 + Math.pow(throwP, 1.35) * (BF.throw - 0.6);   // gentle speed ramp: a steady glide across the screen
          n.visible = enter > .5 && throwP < 1;
          if (n.visible){ applyFrame(nm, frame); anyThrow = true; throwWraps[i].position.copy(throwOffsets[i]).multiplyScalar(1 - ease(clamp(throwP * 1.7)));
            { const keeper = SCENES[i].key === 'soccer'; n.scale.multiplyScalar((keeper ? 1 : .7) + (keeper ? 0 : .3) * ease(clamp(throwP / .3))); } }   // hand-sized in the grip, full size once it is airborne
        });
        throwGroup.visible = anyThrow;

        /* interlude floaters */
        flAll.forEach((flx, k) => { const fr = frs[k]; if (fr.top < H && fr.bottom > 0){ const q = (H - fr.top) / (H + fr.height) - .5; for (const c of flx.children){ const d = +c.dataset.depth; c.style.transform = `translate3d(0, ${(-q * 420 * d).toFixed(1)}px, 0) rotate(${(+c.dataset.rot + q * 30 * d).toFixed(1)}deg)`; } } });
        /* gallery drift */
        if (gr.top < H && gr.bottom > 0){ const gp = (H - gr.top) / (H + gr.height); ribbon.style.transform = `translateX(${(-gp * ribbonSpan).toFixed(1)}px)`; }

        /* corkboard */
        const br = wb;
        const boardOn = br.top < H && br.bottom > 0;
        boardGroup.visible = boardOn;
        if (boardOn){
          const P = clamp(-br.top / (br.height - H));
          let f;
          if (P < .03) f = BF.board_start - 1;
          else if (P < HE) f = BF.board_start - 1 + (P - .03) / (HE - .03) * (heroLandEnd - BF.board_start + 1);
          else if (P < SE) f = heroLandEnd + (P - HE) / (SE - HE) * (BF.end - heroLandEnd);
          else f = BF.end;
          const phone = W < 760;
          const wallKey = phone ? 'P' : 'B';
          if (activeWall !== wallKey){
            activeWall = wallKey; ensureWall(wallKey);   // normally already built during idle time
            for (const k of ['B', 'P']) for (const it of walls[k] || []){ nodes[it.name].visible = false; if (it.pin) it.pin.visible = k === wallKey; }
            nodes['Cork'].rotation.z = nodes['Frame'].rotation.z = phone ? Math.PI / 2 : 0;
            lastF = -1;
          }
          const boardItems = walls[wallKey], HEROES = phone ? META.heroesP : META.heroes;
          const [bw, bh] = phone ? [11.6, 17.6] : [17.6, 11.6]; const tf = 2 * Math.tan(THREE.MathUtils.degToRad(15));
          const fullD = Math.max(bh / tf, bw / (tf * camera.aspect));
          const pull = ease(clamp((P - (HE - .04)) / (SE - HE + .04)));
          let dist, panX = 0;
          if (phone){
            // a portrait wall: fit its width, lean in on each landing and pan up and down with it
            const fitW = bw / (tf * camera.aspect) * 1.03;
            const intro = 1 - ease(clamp((P - .02) / .08));
            dist = fitW * (1 - .3 * (1 - Math.max(pull, intro)));
            const halfVis = (dist * tf) / 2, maxPan = Math.max(0, bh / 2 - halfVis);
            let target = 0;
            if (P < HE && P > .05){ let k = 0; HEROES.forEach((h, j) => { if (f >= h.frames[0] + 10) k = j; }); target = HEROES[k].slot[1]; }
            panS += (clamp(target, -maxPan, maxPan) - panS) * (Math.abs(f - lastF) > 40 ? 1 : .08); panS = clamp(panS, -maxPan, maxPan); panX = panS;
          } else {
            const closeD = fullD * .8;
            const intro = 1 - ease(clamp((P - .02) / .08));   // starts on the whole empty board, then leans in
            dist = closeD + (fullD - closeD) * Math.max(pull, intro) + (P > SE ? (P - SE) * 6 : 0);
            let k = 0; HEROES.forEach((h, j) => { if (f >= h.frames[0] + 10) k = j; });
            const tgt = P < .05 ? [0, 0] : HEROES[k].slot;
            const kf = Math.abs(f - lastF) > 40 ? 1 : .07;   // snap after a jump (anchor link, fast fling)
            camFx += (tgt[0] * .75 * (1 - pull) - camFx) * kf; camFy += (tgt[1] * .75 * (1 - pull) - camFy) * kf;
            { const mx = Math.max(0, (bw - dist * tf * camera.aspect) / 2), my = Math.max(0, (bh - dist * tf) / 2); camFx = clamp(camFx, -mx, mx); camFy = clamp(camFy, -my, my); }   // the frame always fills the screen
          }
          const exitPx = Math.max(0, H - br.bottom), entryPx = Math.max(0, br.top);   // the wall scrolls in and out with its section
          const worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(15))) / H;
          const topAlign = phone ? Math.max(0, (dist * tf - bh) / 2 - .25) * (1 - pull) : 0;   // phones: wall at the top, labels in the space below
          boardGroup.position.set(phone ? 0 : -camFx, (exitPx - entryPx) * worldPerPx + (phone ? -panX + topAlign : -camFy), -(dist - D));
          key.target.position.copy(boardGroup.position); key.position.copy(boardGroup.position).add(keyOff);
          boardGroup.rotation.set(-.05*(1-pull) + mouseY*.03, mouseX*.05, 0);
          let pinned = 0;
          for (const it of boardItems){
            const n0 = nodes[it.name];
            if (f < it.start - 1){ n0.visible = false; if (it.pin) it.pin.scale.setScalar(.0001); continue; } n0.visible = true;
            if (!(f > it.end && lastF > it.end)) applyFrame(it.name, f);
            if (it.hero){ const up = ease(clamp((f - (BF.end - 40)) / 30)) * .24; n0.position.z = it.slot[2] + up; if (it.pin) it.pin.position.z = it.slot[2] + .008 + up; if (up > 0 && f > it.end) applyFrame(it.name, it.end), n0.position.z = it.slot[2] + up; }
            if (it.pin){ const k = clamp((f - it.land - 2) / 5); it.pin.scale.setScalar(k < .001 ? .0001 : .78 * (1 + (1-k)*.8) * ease(Math.min(1, k*1.6))); }
            const n = nodes[it.name]; const cast = n.position.z < 4; if (cast !== it.cast){ it.cast = cast; for (const m of it.meshes) m.castShadow = cast; }
            if (f >= (it.hero ? it.land - 8 : it.start + (it.land - it.start) * .45)) pinned++;   // swarm: counted once it is committed to the wall
          }
          if (pinned !== lastTally){ tallyEl.textContent = pinned; lastTally = pinned; } lastF = f;
        }
        boardState(wb, H);
        // draw only while something 3D is on screen (plus one clearing frame after it leaves)
        const anything = heroTicket.visible || anyThrow || boardOn;
        if (anything || drewLast){
          if (boardOn){ const k = `${activeWall}|${lastF.toFixed(2)}|${boardGroup.position.x.toFixed(3)}|${boardGroup.position.y.toFixed(3)}|${boardGroup.position.z.toFixed(3)}|${boardGroup.rotation.x.toFixed(4)}|${boardGroup.rotation.y.toFixed(4)}`;
            if (k !== shadowKey){ shadowKey = k; renderer.shadowMap.needsUpdate = true; } }
          renderer.render(scene, camera);
        }
        drewLast = anything;
        requestAnimationFrame(tick);
        } catch (err){
          dead3d = true;
          console.warn('3D animation unavailable, showing the static version', err);
          useStatic();
        }
      }
      disposers.push(() => {
        scene.traverse(o => { if (o.geometry) o.geometry.dispose(); const ms = o.material ? [].concat(o.material) : []; ms.forEach(m => { for (const k in m){ const v = m[k]; if (v && v.isTexture) v.dispose(); } m.dispose(); }); });
        [backTex, woodTex, ...texFor.values()].forEach(t => t.dispose()); if (scene.environment) scene.environment.dispose(); pmrem.dispose();
      });
      // start the loop when the page hands over to 3D; build the wall in idle time from then on
      return () => { requestAnimationFrame(tick); idle(pump); };
    }

  }

  run().catch(err => { if (!disposed) console.error("landing", err); });
  return () => {
    disposed = true;
    rafs.forEach(id => window.cancelAnimationFrame(id));
    timers.forEach(id => { window.clearTimeout(id); window.clearInterval(id); });
    disposers.splice(0).reverse().forEach(f => { try { f(); } catch (e) {} });
  };
}
