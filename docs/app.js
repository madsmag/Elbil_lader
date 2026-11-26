'use strict';
/* Elbil-lader webapp. Ingen server: prognose og tariffer ligger som JSON (data/), ladeplanen regnes her. */

const H = 3600e3, TZ = 'Europe/Copenhagen', MOMS = 1.25, MIN_BES = 5;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (n, d = 2) => Number(n).toFixed(d).replace('.', ',');
const kr0 = (n) => Math.round(n).toLocaleString('da-DK');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pad = (n) => String(n).padStart(2, '0');

const store = {
  get(k, d) { try { const v = localStorage.getItem('el.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('el.' + k, JSON.stringify(v)); } catch (e) { /* privat tilstand */ } },
};
const dagUge = (km, away) => ({ km, away, fra: '07:00', til: '17:00' });
const DEF = { omraade: 'DK2', net: null, eff: 11, tillaeg: 0, moms: true, bat: 60, soc: 50, socTs: 0, minP: 20, maxP: 80,
  fk: 18, uge: [dagUge(60, true), dagUge(60, true), dagUge(60, true), dagUge(60, true), dagUge(60, true), dagUge(40, false), dagUge(40, false)] };
const S = { prog: null, tar: null, D: null, err: null, route: 'lad', netFilter: '',
  s: Object.assign({}, DEF, store.get('settings', {})), lad: store.get('ladninger', []).filter((x) => x.v === 2) };
if (!Array.isArray(S.s.uge) || S.s.uge.length !== 7) S.s.uge = DEF.uge;
if (!S.s.socTs) { S.s.socTs = Date.now(); store.set('settings', S.s); }
S.s.uge.forEach((u) => { if (u.km == null) u.km = Math.round((u.kwh || 0) / (S.s.fk / 100) / 5) * 5; delete u.kwh; });
const dagKwh = (u) => u.km * S.s.fk / 100;
const saveSettings = () => store.set('settings', S.s);
const saveLad = () => store.set('ladninger', S.lad);

/* ---------- tid ---------- */
const dtf = (o) => new Intl.DateTimeFormat('da-DK', Object.assign({ timeZone: TZ }, o));
const F = { wd: dtf({ weekday: 'short' }), wdl: dtf({ weekday: 'long' }), dm: dtf({ day: 'numeric', month: 'short' }),
  hm: dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), h: dtf({ hour: '2-digit', hourCycle: 'h23' }) };
const wd = (ms) => F.wd.format(ms).replace('.', '');
const hmf = (ms) => F.hm.format(ms).replace('.', ':');
const hh = (ms) => F.h.format(ms).slice(0, 2);
const PF = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function lp(ms) { const o = {}; for (const p of PF.formatToParts(ms)) o[p.type] = +p.value; return o; }
function addDays(y, m, d, n) { const t = new Date(Date.UTC(y, m - 1, d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; }
function localToUtc(y, m, d, h, mi) {
  const want = Date.UTC(y, m - 1, d, h, mi); let t = want;
  for (let i = 0; i < 2; i++) { const p = lp(t); t -= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - want; }
  return t;
}
function isoWeek(ms) {
  const p = lp(ms), d = new Date(Date.UTC(p.year, p.month - 1, p.day)), dn = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dn + 3);
  const fy = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return { y: d.getUTCFullYear(), w: 1 + Math.round(((d - fy) / 864e5 - 3 + ((fy.getUTCDay() + 6) % 7)) / 7) };
}
const dayKey = (ms) => { const p = lp(ms); return p.year + '-' + p.month + '-' + p.day; };
function dayName(ms) {
  const n = lp(Date.now()), p = lp(ms);
  const diff = Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(n.year, n.month - 1, n.day)) / 864e5);
  if (diff === 0) return 'I dag';
  if (diff === 1) return 'I morgen';
  return cap(F.wdl.format(ms)) + ' ' + F.dm.format(ms);
}

/* ---------- data ---------- */
async function load() {
  try {
    const [p, t] = await Promise.all([
      fetch('data/prognose.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error('prognose ' + r.status); return r.json(); }),
      fetch('data/tariffer.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error('tariffer ' + r.status); return r.json(); }),
    ]);
    S.prog = p; S.tar = t; S.err = null;
  } catch (e) { S.err = 'Kunne ikke hente priser. Tjek din forbindelse og prøv igen. (' + e.message + ')'; }
  prep(); render();
}

function kendtFlags(a, shiftedT0, N, demo) {
  if (!demo) return a.kendt.slice();
  // Demo: priser for i morgen er kendt efter kl. 13, ellers kun resten af i dag
  const n = lp(Date.now()), off = n.hour >= 13 ? 2 : 1, d = addDays(n.year, n.month, n.day, off);
  const lim = localToUtc(d.y, d.m, d.d, 0, 0);
  return Array.from({ length: N }, (_, i) => (shiftedT0 + i * H < lim ? 1 : 0));
}

function prep() {
  S.D = null;
  const p = S.prog, t = S.tar;
  if (!p || !t) return;
  const base = Date.parse(p.fra), nowH = Math.floor(Date.now() / H) * H;
  const shift = p.demo ? Math.floor((nowH - base) / (24 * H)) * 24 * H : 0;
  const t0 = base + shift, N = Math.min(p.timer, Math.floor((nowH - base - shift) / H) + 96);
  const a = p.omraader[S.s.omraade] || p.omraader.DK2;
  const nets = t.netselskaber;
  const netObj = nets.find((n) => n.navn === S.s.net) || nets.find((n) => n.navn === 'Cerius A/S') || nets[0];
  if (!netObj) { S.err = 'Ingen netselskaber i data.'; return; }
  const kendt = kendtFlags(a, t0, N, p.demo);
  const lav = a.lav.slice(), med = a.median.slice(), hoej = a.hoej.slice();
  if (p.demo) for (let i = 0; i < N; i++) if (kendt[i]) { lav[i] = med[i]; hoej[i] = med[i]; }
  const D = { t0, N, shift, demo: !!p.demo, kendt, netObj, histFra: Date.parse(a.hist_fra) + shift, hist: a.hist,
    net: netObj.pris, fixed: t.energinet, T: { lo: [], md: [], hi: [] } };
  const mom = S.s.moms ? MOMS : 1;
  for (let i = 0; i < N; i++) {
    const add = (D.net[i] ?? 0) + (D.fixed[i] ?? 0) + S.s.tillaeg;
    D.T.lo[i] = ((lav[i] ?? med[i]) + add) * mom;
    D.T.md[i] = (med[i] + add) * mom;
    D.T.hi[i] = ((hoej[i] ?? med[i]) + add) * mom;
  }
  D.med = med;
  S.D = D;
}
const idxOf = (ms) => Math.floor((ms - S.D.t0) / H);

/* ---------- ladeplan ---------- */
const UGEDAGE = ['Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag', 'Søndag'];
const hmMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const sumMap = (m) => { let a = 0; m.forEach((k) => { a += k; }); return a; };
const costOf = (m, arr) => { let c = 0; m.forEach((k, i) => { c += k * arr[i]; }); return c; };
const dowOf = (ms) => { const p = lp(ms); return (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7; };

/* Batteriniveau nu: sidste aflæsning minus forbrug på ture siden da. Fratrækket vises, når bilen er hjemme igen
   (ugeplanens "hjemme"-tid). Planlægningen trækker turen fra, så snart bilen er kørt. */
function effSoc(now) {
  const s = S.s, bat = Math.max(10, s.bat), t0 = s.socTs || now;
  let shown = 0, drive = 0;
  const p0 = lp(t0);
  for (let k = 0; k <= 14; k++) {
    const d = addDays(p0.year, p0.month, p0.day, k), ms0 = localToUtc(d.y, d.m, d.d, 12, 0), u = s.uge[dowOf(ms0)];
    if (!(u.km > 0)) continue;
    const [fh, fm] = (u.away ? u.fra : '12:00').split(':').map(Number), [th, tm] = (u.away ? u.til : '12:00').split(':').map(Number);
    const dep = localToUtc(d.y, d.m, d.d, fh, fm), home = localToUtc(d.y, d.m, d.d, th, tm);
    if (dep <= t0 || dep > now) continue;
    drive += dagKwh(u);
    if (home <= now) shown += dagKwh(u);
  }
  const cur = Math.max(0, bat * s.soc / 100 - shown);
  return { kwh: cur, pct: Math.round(cur / bat * 100), shown, plan: Math.max(0, cur - (drive - shown)) };
}

/* Ture og tidspunkter, hvor bilen er hjemme, ud fra ugeplanen. */
function buildSchedule(startI) {
  const D = S.D, uge = S.s.uge, ev = {}, away = new Set(), info = [];
  for (let i = startI; i < D.N; i++) {
    const ms = D.t0 + i * H, p = lp(ms), u = uge[dowOf(ms)], m = p.hour * 60, fra = hmMin(u.fra), til = hmMin(u.til);
    if (u.away && fra < til) {
      if (m < til && m + 60 > fra) away.add(i);
      if (m <= fra && fra < m + 60 && u.km > 0) ev[i] = (ev[i] || 0) + dagKwh(u);
    } else if (p.hour === 12 && u.km > 0) ev[i] = (ev[i] || 0) + dagKwh(u);
  }
  return { ev, away };
}

function nightLabel(ms) {
  const n = lp(Date.now()), p = lp(ms), diff = Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(n.year, n.month - 1, n.day)) / 864e5);
  if ((diff === 0 && p.hour >= 22) || (diff === 1 && p.hour < 6) || (diff === 0 && p.hour < 6)) return 'i nat';
  const dn = dayName(ms);
  return dn === 'I dag' ? 'i dag' : dn === 'I morgen' ? 'i morgen' : F.wdl.format(ms);
}
function runs(plan, startI, N) {
  const out = []; let cur = null;
  for (let i = startI; i < N; i++) {
    const k = plan.get(i) || 0;
    if (k > 1e-9) { if (cur && cur.to === i) { cur.to = i + 1; cur.kwh += k; } else { cur = { from: i, to: i + 1, kwh: k }; out.push(cur); } }
  }
  return out;
}

function planCalc() {
  const D = S.D, s = S.s, now = Date.now(), P = {};
  const startI = Math.max(0, Math.ceil((now - D.t0) / H)), N = D.N;
  if (N - startI < 8) { P.err = 'Prognosen rækker for kort frem. Prøv igen om lidt.'; return P; }
  const bat = Math.max(10, s.bat), minK = bat * s.minP / 100, maxK = Math.max(minK, bat * s.maxP / 100);
  const avg = s.uge.reduce((a, u) => a + dagKwh(u), 0) / 7;
  const { ev, away } = buildSchedule(startI);
  const cfg = { startI, N, price: D.T.md, eff: s.eff, bat, soc: Math.min(bat, effSoc(now).plan), minK, maxK,
    endK: Math.min(maxK, minK + avg), ev, avail: (i) => !away.has(i) };
  const plan = Planner.optimize(cfg), base = Planner.rolling(cfg);
  const simP = Planner.simulate(cfg, plan), simB = Planner.simulate(cfg, base), T = D.T;
  const cP = costOf(plan, T.md), cB = costOf(base, T.md), sav = cB - cP;
  const s1 = costOf(base, T.lo) - costOf(plan, T.lo), s2 = costOf(base, T.hi) - costOf(plan, T.hi);
  const lim = startI + 24, in24 = (m) => { let a = 0; m.forEach((k, i) => { if (i < lim) a += k; }); return a; };
  const p24 = in24(plan), b24 = in24(base), d24 = b24 - p24;
  const rp = runs(plan, startI, N), first = rp[0];
  Object.assign(P, { cfg, startI, N, ev, away, plan, base, simP, simB, cP, cB, sav, lo: Math.min(s1, s2), hi: Math.max(s1, s2),
    p24, b24, runs: rp, first, kwhP: sumMap(plan), kwhB: sumMap(base), minK, maxK, bat });
  P.known = [...plan.keys()].every((i) => D.kendt[i]);
  const short = simP.short;
  if (short.length) {
    const x = short[0], ms = D.t0 + x.i * H;
    P.verdict = 'Kan ikke nås'; P.headline = 'Mangler ca. ' + Math.ceil(short.reduce((a, q) => a + q.kwh, 0)) + ' kWh';
    P.text = 'Selv med fuld ladning kan planen ikke dække turen ' + dayName(ms).toLowerCase() + ' kl. ' + hh(ms) + ':00. Tjek ladeeffekt, ladetider eller forbrug i ugeplanen.';
    P.tip = 'Brug fuld ladning, så meget som muligt, indtil da.'; P.range = '';
    return P;
  }
  const sess = (r) => nightLabel(D.t0 + r.from * H) + ' kl. ' + pad(Number(hh(D.t0 + r.from * H))) + '–' + pad(Number(hh(D.t0 + r.to * H)) % 24);
  const pctAt = (i) => Math.round(simP.soc[i] / bat * 100);
  const f24 = rp.filter((r) => r.from < lim);
  if (sav < MIN_BES) {
    P.verdict = 'Følg Clever';
    P.headline = p24 < 0.5 ? 'Ingen ladning de næste 24 timer' : 'Lad som Clever planlægger';
    P.text = 'Der er ingen reel gevinst ved at vente: planen sparer kun ca. ' + nf(sav, 1) + ' kr over de næste dage.';
  } else if (d24 >= 1) {
    P.verdict = 'Udskyd ladningen';
    P.headline = p24 < 0.5 ? 'Lad ikke de næste 24 timer' : 'Lad kun ' + Math.round(p24) + ' kWh de næste 24 timer';
    const later = rp.find((r) => r.from >= lim);
    P.text = 'Clever vil lade ' + Math.round(b24) + ' kWh. Planen venter med resten' + (later ? ' til ' + sess(later) : '') + ', hvor strømmen er billigere. Du sparer ca. ' + kr0(sav) + ' kr over ' + Math.round((N - startI) / 24) + ' dage.';
  } else if (d24 <= -1) {
    P.verdict = 'Lad mere nu';
    P.headline = 'Lad ' + Math.round(p24) + ' kWh de næste 24 timer';
    P.text = 'Clever vil kun lade ' + Math.round(b24) + ' kWh. Det er billigere at lade mere nu end senere. Du sparer ca. ' + kr0(sav) + ' kr.';
  } else {
    P.verdict = 'Følg Clever';
    P.headline = 'Lad ' + Math.round(p24) + ' kWh de næste 24 timer';
    P.text = 'Dagens ladning er den samme som Clever vælger. Gevinsten ligger på de senere dage: ca. ' + kr0(sav) + ' kr.';
  }
  if (f24.length) {
    P.text += ' Lad ' + f24.map(sess).join(' og ') + '.';
    P.tip = 'Sæt ladegrænsen til ca. ' + pctAt(f24[f24.length - 1].to - 1) + ' %.';
  }
  P.range = P.known ? 'Priserne er kendte, så besparelsen er sikker.' : kr0(P.lo) === kr0(P.hi) ? 'Besparelse ca. ' + kr0(P.lo) + ' kr, afhængigt af prognosen.' : 'Besparelse mellem ' + kr0(P.lo) + ' og ' + kr0(P.hi) + ' kr, afhængigt af prognosen.';
  return P;
}

/* ---------- visninger ---------- */
const ICON = {
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>',
};
function banner() {
  const p = S.prog; if (!p) return '';
  if (p.demo) return '<div class="banner">Eksempeldata. Appen viser en demo, indtil den første rigtige prognose er hentet.</div>';
  const age = (Date.now() - Date.parse(p.genereret)) / H;
  if (age > 30) return '<div class="banner">Prognosen er ' + Math.round(age) + ' timer gammel. Priserne kan være forældede.</div>';
  return '';
}
function head(title, right) { return '<div class="head"><div><div class="eyebrow">Elbil-lader · ' + esc(S.s.omraade) + '</div><h1>' + title + '</h1></div>' + (right || '') + '</div>'; }

function socChart(P) {
  const D = S.D, n = P.N - P.startI, W = 320, Hh = 110, x = (k) => (k / n * W).toFixed(1), y = (kwh) => (Hh - 6 - kwh / P.bat * (Hh - 12)).toFixed(1);
  const line = (sim) => {
    let d = 'M0 ' + y(sim.soc[P.startI] - 0), prev = P.cfg.soc;
    d = 'M0 ' + y(prev);
    for (let i = P.startI; i < P.N; i++) { const k = i - P.startI; d += ' L' + x(k + 1) + ' ' + y(sim.soc[i]); }
    return d;
  };
  let bands = '';
  for (let i = P.startI; i < P.N; i++) if (P.away.has(i)) bands += '<rect x="' + x(i - P.startI) + '" y="0" width="' + (W / n + 0.3).toFixed(1) + '" height="' + Hh + '" class="away"/>';
  let seps = '', lab = '';
  for (let i = P.startI + 1; i < P.N; i++) if (lp(D.t0 + i * H).hour === 0) seps += '<line x1="' + x(i - P.startI) + '" x2="' + x(i - P.startI) + '" y1="0" y2="' + Hh + '" class="dsep"/>';
  return '<svg viewBox="0 0 ' + W + ' ' + Hh + '" class="soc" role="img" aria-label="Batteriniveau de næste dage. Planen er markeret, Clever-metoden er stiplet.">' + bands + seps +
    '<line x1="0" x2="' + W + '" y1="' + y(P.minK) + '" y2="' + y(P.minK) + '" class="minl"/>' +
    '<path d="' + line(P.simB) + '" class="lb"/><path d="' + line(P.simP) + '" class="lp"/></svg>';
}

function dayRows(P) {
  const D = S.D, groups = new Map();
  for (let i = P.startI; i < P.N; i++) { const k = dayKey(D.t0 + i * H); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  return [...groups.values()].map((g) => {
    const ms0 = D.t0 + g[0] * H, u = S.s.uge[dowOf(ms0)];
    const kp = g.reduce((a, i) => a + (P.plan.get(i) || 0), 0), kb = g.reduce((a, i) => a + (P.base.get(i) || 0), 0);
    const rs = runs(P.plan, g[0], g[g.length - 1] + 1).map((r) => pad(Number(hh(D.t0 + r.from * H))) + '–' + pad(Number(hh(D.t0 + r.to * H)) % 24)).join(', ');
    const use = u.away ? 'Væk ' + u.fra + '–' + u.til + ', ' + u.km + ' km' : 'Hjemme, ' + u.km + ' km';
    const c = g.reduce((a, i) => a + (P.plan.get(i) || 0) * D.T.md[i], 0);
    return '<div class="item"><div class="l"><b>' + esc(dayName(ms0)) + '</b><span class="small">' + esc(use) + '</span></div>' +
      '<div class="r"><span class="big num">' + (kp > 0.05 ? nf(kp, kp % 1 ? 1 : 0) + ' kWh' : 'Ingen') + '</span><span class="small num">' +
      (kp > 0.05 ? 'kl. ' + rs + ' · ' + kr0(c) + ' kr' : '') + (Math.abs(kb - kp) >= 0.5 ? (kp > 0.05 ? ' · ' : '') + 'Clever ' + nf(kb, kb % 1 ? 1 : 0) + ' kWh' : '') + '</span></div></div>';
  }).join('');
}

function viewLad() {
  const D = S.D, s = S.s, P = planCalc(), now = Date.now();
  const when = cap(F.wdl.format(now)) + ' ' + F.dm.format(now) + ', ' + hmf(now);
  let h = head(when, '<a class="icon-btn" href="#/indstillinger" aria-label="Indstillinger">' + ICON.gear + '</a>') + banner();
  if (P.err) {
    h += '<div class="errbox">' + esc(P.err) + '</div>';
  } else {
    h += '<section class="rec"><div class="verdict">' + P.verdict + '</div><div class="headline">' + esc(P.headline) + '</div>' +
      '<div class="text">' + esc(P.text) + '</div>' + (P.range ? '<div class="range">' + esc(P.range) + '</div>' : '') +
      (P.tip ? '<div class="text">' + esc(P.tip) + '</div>' : '') + '</section>';
    h += '<div class="tiles"><div class="tile"><span class="label">Clever-metode</span><b class="num">' + kr0(P.cB) + ' kr</b></div>' +
      '<div class="tile"><span class="label">Ladeplan</span><b class="num">' + kr0(P.cP) + ' kr</b></div>' +
      '<div class="tile good"><span class="label">Du sparer</span><b class="num">' + kr0(P.sav) + ' kr</b></div></div>';
  }
  const es = effSoc(now), kwhNow = Math.round(es.kwh);
  const stale = es.shown > 0.05 ? '<p class="sub" style="margin:0">Aflæst for ' + Math.round((now - s.socTs) / H) + ' timer siden, minus ' + nf(es.shown, 1) + ' kWh til ture siden. Justér skyderen, hvis bilen har ladet.</p>'
    : s.socTs && now - s.socTs > 12 * H ? '<p class="warn">Niveauet er ' + Math.round((now - s.socTs) / H) + ' timer gammelt. Opdater det for en rigtig plan.</p>' : '';
  h += '<section class="card"><div class="row"><h2>Batteri nu</h2><output class="num big-out" id="socout">' + es.pct + ' % · ' + kwhNow + ' kWh</output></div>' +
    '<input type="range" min="0" max="100" step="1" value="' + es.pct + '" data-in="soc" aria-label="Batteriniveau i procent">' + stale +
    '<div class="row"><span class="sub">Ladegrænse ' + s.maxP + ' %, reserve ' + s.minP + ' %, ' + s.bat + ' kWh</span><a class="link-btn" href="#/uge">Uge og ladetider</a></div></section>';
  if (!P.err && !P.verdict.startsWith('Kan ikke')) {
    const T = D.T.md, idx = []; for (let i = P.startI; i < P.N; i++) idx.push(i);
    const lo = Math.min(...idx.map((i) => T[i])), hi = Math.max(...idx.map((i) => T[i]));
    const bars = idx.map((i) => {
      const pct = 14 + (hi > lo ? (T[i] - lo) / (hi - lo) : 0.5) * 86, on = P.plan.has(i), aw = P.away.has(i);
      return '<i style="height:' + pct.toFixed(0) + '%;background:' + (on ? 'var(--sel)' : 'var(--off)') + ';opacity:' + (aw ? 0.3 : 1) + '"></i>';
    }).join('');
    h += '<section class="card"><div class="row"><h2>Ladeplan</h2><span class="label">' + P.runs.length + (P.runs.length === 1 ? ' ladning' : ' ladninger') + ', ' + nf(P.kwhP, 0) + ' kWh</span></div>' +
      '<div class="strip" role="img" aria-label="Pris pr. time, valgte timer er markeret, lyse søjler er tider hvor bilen er væk">' + bars + '</div>' +
      '<div class="axis"><span>' + esc(wd(D.t0 + P.startI * H)) + ' ' + hh(D.t0 + P.startI * H) + ':00</span><span>' + esc(wd(D.t0 + (P.N - 1) * H)) + ' ' + hh(D.t0 + (P.N - 1) * H) + ':00</span></div>' +
      '<div class="legend"><span><i style="background:var(--sel)"></i>Lad</span><span><i style="background:var(--off);opacity:.3"></i>Bilen er væk</span></div></section>' +
      '<section class="card list" style="gap:0;padding-top:12px;padding-bottom:6px"><h2 style="padding-bottom:6px">Dag for dag</h2>' + dayRows(P) + '</section>' +
      '<section class="card"><div class="row"><h2>Batteriniveau</h2><span class="legend" style="margin:0"><span><i style="background:var(--sel)"></i>Plan</span><span><i style="background:var(--mute)"></i>Clever</span></span></div>' + socChart(P) +
      '<div class="axis"><span>' + esc(wd(D.t0 + P.startI * H)) + ' ' + hh(D.t0 + P.startI * H) + ':00</span><span>Stiplet gul: reserve ' + s.minP + ' %. Grå: bilen er væk</span></div></section>';
    const saved = S.lad.some((x) => x.ts > now - H && x.kwh === Math.round(P.kwhP * 10) / 10);
    h += '<div style="margin-top:12px"><button class="btn" style="width:100%" data-act="gem"' + (saved ? ' disabled' : '') + '>' + (saved ? 'Gemt under Besparelse' : 'Jeg følger planen') + '</button></div>' +
      '<p class="hint">Priser ' + (s.moms ? 'inkl.' : 'ekskl.') + ' moms, afgifter og nettarif hos ' + esc(D.netObj.navn) + '.' +
      (s.tillaeg ? '' : ' Tilføj dit leverandørtillæg under Indstillinger.') + ' Clever-metoden er en antagelse: billigste timer et døgn ad gangen.</p>';
  }
  return h;
}

function viewUge() {
  const s = S.s;
  const dow0 = dowOf(Date.now());
  const days = Array.from({ length: 7 }, (_, k) => (dow0 + k) % 7).map((d, k) => {
    const u = s.uge[d], titel = UGEDAGE[d] + (k === 0 ? ' · i dag' : k === 1 ? ' · i morgen' : '');
    const t = (f, v) => '<input type="time" value="' + esc(v) + '" data-in="uge" data-day="' + d + '" data-f="' + f + '" aria-label="' + UGEDAGE[d] + (f === 'fra' ? ' kører' : ' hjemme igen') + '">';
    return '<section class="card"><div class="row"><h2>' + titel + '</h2><div class="stepper"><button data-act="ukm" data-v="' + d + ':-5" aria-label="Mindre">−</button>' +
      '<output class="num">' + u.km + ' km</output><button data-act="ukm" data-v="' + d + ':5" aria-label="Mere">+</button></div></div>' +
      '<div class="row" style="min-height:44px"><div><div style="font-weight:500">Bilen er væk</div><div class="small label" style="font-weight:400">' + (u.away ? 'Der lades ikke i dette tidsrum' : 'Hjemme hele dagen, kan lade når som helst') + '</div></div>' +
      '<button class="switch" role="switch" aria-checked="' + u.away + '" aria-label="' + UGEDAGE[d] + ' væk" data-act="away" data-v="' + d + '"></button></div>' +
      (u.away ? '<div class="tider"><label><span class="label">Kører kl.</span>' + t('fra', u.fra) + '</label><label><span class="label">Hjemme kl.</span>' + t('til', u.til) + '</label></div>' : '') + '</section>';
  }).join('');
  const num = (id, label, sub, val, min, max, step) => '<div class="row"><div><label for="' + id + '">' + label + '</label><div class="small label" style="font-weight:400">' + sub + '</div></div>' +
    '<input id="' + id + '" type="number" inputmode="decimal" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '" data-in="' + id + '"></div>';
  return '<h1 style="padding:0 4px">Uge og ladetider</h1>' +
    '<div class="sub" style="padding:0 4px">Hvor langt du kører pr. dag, og hvornår bilen ikke kan lade. Strømmen til turen trækkes, når du kører hjemmefra.</div>' + banner() +
    '<section class="card"><h2>Bil</h2>' + num('bat', 'Batteristørrelse (kWh)', 'Brugbar kapacitet', s.bat, 10, 200, 1) +
    num('fk', 'Forbrug (kWh pr. 100 km)', 'Se bilens computer, fx 18', s.fk, 8, 60, 0.5) +
    num('minP', 'Reserve (%)', 'Må helst ikke gå under', s.minP, 0, 90, 1) + num('maxP', 'Ladegrænse (%)', 'Lad ikke højere', s.maxP, 20, 100, 1) + '</section>' + days;
}

function pctile(arr, q) { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; }

function viewPriser() {
  const D = S.D, P = planCalc(), i0 = Math.max(0, Math.floor((Date.now() - D.t0) / H)), M = D.N - i0;
  const idx = Array.from({ length: M }, (_, k) => i0 + k), T = D.T;
  const chosen = new Set(P.chosen || []);
  const ymax = Math.max(3, Math.ceil(Math.max(...idx.map((i) => T.hi[i])) * 2) / 2);
  const thr = { c: pctile(idx.map((i) => T.md[i]), 0.33), a: pctile(idx.map((i) => T.md[i]), 0.66), p: pctile(idx.map((i) => T.md[i]), 0.88) };
  const col = (v) => v <= thr.c ? 'var(--c-cheap)' : v >= thr.p ? 'var(--c-peak)' : v >= thr.a ? 'var(--c-amber)' : 'var(--c-mid)';
  const cols = idx.map((i) => {
    const hgt = T.md[i] / ymax * 100, lo = T.lo[i] / ymax * 100, bd = (T.hi[i] - T.lo[i]) / ymax * 100;
    return '<div class="col' + (chosen.has(i) ? ' sel' : '') + '"><i class="bar" style="height:' + hgt.toFixed(1) + '%;background:' + col(T.md[i]) + ';opacity:' + (D.kendt[i] ? 1 : 0.62) + '"></i>' +
      (bd > 0.3 ? '<i class="band" style="bottom:' + lo.toFixed(1) + '%;height:' + bd.toFixed(1) + '%"></i>' : '') + '</div>';
  }).join('');
  let grid = '';
  for (let v = 1; v < ymax; v++) grid += '<div class="grid" style="bottom:' + (v / ymax * 100).toFixed(2) + '%"></div><div class="gl" style="bottom:' + (v / ymax * 100).toFixed(2) + '%">' + v + (v === 1 ? ' kr' : '') + '</div>';
  // dagsskift og dagsnavne
  let seps = '', labels = '', segStart = 0;
  const marks = [];
  idx.forEach((i, k) => { if (k > 0 && lp(D.t0 + i * H).hour === 0) marks.push(k); });
  marks.forEach((k) => { seps += '<div class="sep" style="left:' + (k / M * 100).toFixed(2) + '%"></div>'; });
  [0, ...marks].forEach((a, n, arr) => {
    const b = arr[n + 1] ?? M;
    if (b - a >= 6) labels += '<span style="left:' + (((a + b) / 2) / M * 100).toFixed(2) + '%">' + esc(wd(D.t0 + idx[a] * H)) + '</span>';
  });
  const firstUnknown = idx.findIndex((i) => !D.kendt[i]);
  let top = '';
  if (firstUnknown > 0) {
    seps += '<div class="sep known" style="left:' + (firstUnknown / M * 100).toFixed(2) + '%"></div>';
    const bp = firstUnknown / M * 100;
    top = (bp >= 24 ? '<span style="left:0">Kendte priser</span>' : bp >= 9 ? '<span style="left:0">Kendt</span>' : '') + '<span style="left:' + bp.toFixed(2) + '%;padding-left:5px">Prognose</span>';
  } else if (firstUnknown === 0) top = '<span style="left:0">Prognose</span>';
  else top = '<span style="left:0">Kendte priser</span>';
  let iMin = idx[0], iMax = idx[0], sum = 0;
  idx.forEach((i) => { if (T.md[i] < T.md[iMin]) iMin = i; if (T.md[i] > T.md[iMax]) iMax = i; sum += T.md[i]; });
  const lbl = (i) => wd(D.t0 + i * H) + ' ' + hh(D.t0 + i * H) + ':00';
  // pr. dag
  const groups = new Map();
  idx.forEach((i) => { const k = dayKey(D.t0 + i * H); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  const rows = [...groups.values()].map((g) => {
    const avg = g.reduce((a, i) => a + T.md[i], 0) / g.length;
    let best = null, bs = Infinity;
    for (let k = 0; k + 2 < g.length; k++) { const sm = T.md[g[k]] + T.md[g[k + 1]] + T.md[g[k + 2]]; if (sm < bs) { bs = sm; best = g[k]; } }
    const allK = g.every((i) => D.kendt[i]), anyK = g.some((i) => D.kendt[i]);
    const h0 = best == null ? null : Number(hh(D.t0 + best * H));
    return '<div class="item"><div class="l"><b>' + esc(dayName(D.t0 + g[0] * H)) + '</b><span class="pill' + (allK ? ' good' : '') + '">' + (allK ? 'Kendt' : anyK ? 'Delvist kendt' : 'Prognose') + '</span></div>' +
      '<div class="r"><span class="big num">' + nf(avg) + ' kr</span><span class="small">' + (h0 == null ? 'gennemsnit' : 'billigst kl. ' + pad(h0) + '–' + pad((h0 + 3) % 24)) + '</span></div></div>';
  }).join('');
  return '<h1 style="padding:0 4px">Priser</h1><div class="sub" style="padding:0 4px">Pris pr. kWh ' + (S.s.moms ? 'inkl.' : 'ekskl.') + ' moms og nettarif, 4 dage frem.</div>' + banner() +
    '<div class="legend"><span><i style="background:var(--c-cheap)"></i>Billig</span><span><i style="background:var(--c-peak)"></i>Dyr</span><span><i style="background:var(--band);border:1px solid var(--mute)"></i>Usikkerhed</span>' +
    (chosen.size ? '<span><i style="background:var(--chosen-bg);border:1px solid var(--sel)"></i>Din ladning</span>' : '') + '</div>' +
    '<div class="chart"><div class="top">' + top + '</div><div class="plot" role="img" aria-label="Timepriser de næste 4 dage">' + grid + '<div class="cols">' + cols + '</div>' + seps + '</div><div class="days">' + labels + '</div></div>' +
    '<div class="tiles"><div class="tile good"><span class="label">Billigste time</span><b class="num">' + nf(T.md[iMin]) + ' kr</b><small>' + esc(lbl(iMin)) + '</small></div>' +
    '<div class="tile"><span class="label">Gennemsnit</span><b class="num">' + nf(sum / M) + ' kr</b><small>' + Math.round(M / 24) + ' dage</small></div>' +
    '<div class="tile bad"><span class="label">Dyreste time</span><b class="num">' + nf(T.md[iMax]) + ' kr</b><small>' + esc(lbl(iMax)) + '</small></div></div>' +
    '<section class="card list" style="gap:0;padding-top:6px;padding-bottom:6px">' + rows + '</section>';
}

/* ---------- besparelse ---------- */
function spotAt(ms, area) {
  const D = S.D, a = S.prog.omraader[area]; if (!a) return null;
  const hi = Math.floor((ms - D.histFra) / H);
  if (hi >= 0 && hi < a.hist.length && a.hist[hi] != null) return { v: a.hist[hi], est: false };
  const j = idxOf(ms);
  if (j >= 0 && j < D.N && a.median[j] != null) return { v: a.median[j], est: !D.kendt[j] };
  return null;
}
function evalItem(it) {
  const D = S.D; let paid = 0, straks = 0, est = false, kP = 0, kB = 0;
  const mom = it.moms ? MOMS : 1;
  const price = (ms) => {
    const sp = spotAt(ms, it.area); if (!sp) return null;
    if (sp.est) est = true;
    const j = idxOf(ms), k = ((j % 24) + 24) % 24, ok = j >= 0 && j < D.N;
    return (sp.v + (ok ? D.net[j] : D.net[k]) + (ok ? D.fixed[j] : D.fixed[k]) + it.tillaeg) * mom;
  };
  for (const [ms, k] of it.plan) { const p = price(ms); if (p == null) return null; paid += p * k; kP += k; }
  for (const [ms, k] of it.straks) { const p = price(ms); if (p == null) return null; straks += p * k; kB += k; }
  // Er planen afbrudt (ny plan gemt), har den leveret en anden mængde strøm end Clever-metoden. Forskellen
  // værdisættes til planens egen gennemsnitspris for de timer, der blev afløst, så besparelsen ikke skyldes udskudt ladning.
  let rk = 0, rc = 0;
  for (const [ms, k] of (it.rest || [])) { const p = price(ms); if (p == null) continue; rk += k; rc += p * k; }
  const pi = rk > 0 ? rc / rk : kP > 0 ? paid / kP : 0;
  const adj = (kB - kP) * pi;
  return { paid, straks, save: straks - paid - adj, est };
}
function viewBesparelse() {
  const items = S.lad.map((it) => ({ it, r: evalItem(it) })).filter((x) => x.r);
  const total = items.reduce((a, x) => a + x.r.save, 0);
  const wk = Array.from({ length: 8 }, (_, k) => isoWeek(Date.now() - (7 - k) * 7 * 864e5));
  const vals = wk.map((w) => items.filter((x) => { const q = isoWeek(x.it.ts); return q.y === w.y && q.w === w.w; }).reduce((a, x) => a + x.r.save, 0));
  const mx = Math.max(1, ...vals);
  let h = '<h1 style="padding:0 4px">Besparelse</h1><div class="sub" style="padding:0 4px">Beregnet ud fra de ladeplaner, du har gemt, i forhold til Clever-metoden</div>' + banner();
  if (!items.length) {
    return h + '<section class="card"><h2>Ingen ladninger endnu</h2><p class="sub" style="margin:0">Når du trykker "Jeg følger planen" på Lad-skærmen, gemmer appen planen her. Den regner derefter ud, hvor meget du sparer i forhold til Clever-metoden (billigste timer et døgn ad gangen), med de faktiske timepriser, efterhånden som de bliver kendt.</p></section>';
  }
  h += '<section class="hero"><div class="eyebrow">Sparet i alt</div><div class="total num">' + kr0(total) + ' kr</div><div class="text">' + items.length + ' ' + (items.length === 1 ? 'ladning' : 'ladninger') + ' gemt, sammenlignet med Clever-metoden</div>' +
    '<div class="weeks">' + vals.map((v, k) => '<div' + (k === 7 ? ' class="now"' : '') + '><span class="v num">' + (v ? kr0(v) : '') + '</span><span class="b" style="height:' + Math.max(4, Math.round(Math.max(0, v) / mx * 64)) + 'px"></span><span class="w">u' + wk[k].w + '</span></div>').join('') + '</div></section>';
  h += '<section class="card list" style="gap:0;padding-bottom:6px"><h2 style="padding-bottom:6px">Seneste ladninger</h2>' +
    items.slice(0, 12).map(({ it, r }) => {
      const a = (it.plan[0] || it.straks[0])[0], kw = it.plan.reduce((q, x) => q + x[1], 0);
      return '<div class="item"><div class="l"><b>' + esc(dayName(a)) + '</b><span class="small">' + nf(kw, 0) + ' kWh, ' + it.plan.length + ' timer' + (r.est ? ' · foreløbig' : '') + '</span></div>' +
        '<div class="r"><span class="big good-t num">' + (r.save >= 0 ? '+' : '−') + kr0(Math.abs(r.save)) + ' kr</span><span class="small num">' + kr0(r.paid) + ' mod ' + kr0(r.straks) + ' kr</span></div></div>';
    }).join('') + '</section>' +
    '<p class="hint">Sparet er prisen med Clever-metoden minus prisen for din plan. Det regnes med timepriser og er ikke målt på din måler. Ladninger, hvor priserne endnu er prognoser, er markeret foreløbige.</p>';
  return h;
}

/* ---------- indstillinger ---------- */
function netListHtml() {
  const f = S.netFilter.trim().toLowerCase(), cur = S.D ? S.D.netObj.navn : S.s.net;
  const list = S.tar.netselskaber.filter((n) => !f || n.navn.toLowerCase().includes(f));
  if (!list.length) return '<p class="sub" style="margin:8px">Ingen netselskaber matcher.</p>';
  return list.map((n) => '<button class="radio" role="radio" aria-checked="' + (n.navn === cur) + '" data-act="net" data-v="' + esc(n.navn) + '"><span class="dot"></span>' + esc(n.navn) + '</button>').join('');
}
function viewIndstillinger() {
  const s = S.s, D = S.D, p = S.prog;
  const nowI = Math.max(0, Math.floor((Date.now() - D.t0) / H));
  const tv = Array.from({ length: 24 }, (_, k) => D.net[Math.min(D.N - 1, nowI + k)] ?? 0), mx = Math.max(...tv, 0.01), mn = Math.min(...tv);
  const tar = tv.map((v) => '<i style="height:' + Math.round(8 + v / mx * 92) + '%;background:' + (v <= mn + 0.02 ? 'var(--c-cheap)' : v >= mx - 0.02 ? 'var(--c-peak)' : 'var(--c-mid)') + '"></i>').join('');
  const area = (v, t) => '<button class="chip" data-act="omraade" data-v="' + v + '" aria-pressed="' + (s.omraade === v) + '">' + t + '</button>';
  const sw = (key, label, sub) => '<div class="row" style="min-height:52px"><div><div style="font-weight:500">' + label + '</div><div class="small label" style="font-weight:400">' + sub + '</div></div>' +
    '<button class="switch" role="switch" aria-checked="' + s[key] + '" aria-label="' + label + '" data-act="sw" data-v="' + key + '"></button></div>';
  return '<a class="back" href="#/lad">' + ICON.back + 'Tilbage</a><h1 style="padding:0 4px">Indstillinger</h1>' + banner() +
    '<section class="card"><h2>Prisområde</h2><div class="seg">' + area('DK1', 'DK1 · Vest') + area('DK2', 'DK2 · Øst') + '</div><p class="sub" style="margin:0">Vest er Jylland og Fyn. Øst er Sjælland, Lolland-Falster og Bornholm.</p></section>' +
    '<section class="card"><h2><label for="netsog">Netselskab</label></h2><input id="netsog" type="search" placeholder="Søg, fx Cerius" value="' + esc(S.netFilter) + '" data-in="netfilter" autocomplete="off">' +
    '<div id="netlist" role="radiogroup" aria-label="Netselskab">' + netListHtml() + '</div><p class="sub" style="margin:0">Står på din elregning.</p></section>' +
    '<section class="card"><div class="row"><h2>Din nettarif nu</h2><span class="label">' + nf(mn, 2) + ' til ' + nf(mx, 2) + ' kr/kWh</span></div><div class="tar" role="img" aria-label="Nettarif de næste 24 timer">' + tar + '</div>' +
    '<div class="axis"><span>nu</span><span>om 12 timer</span><span>om 24 timer</span></div><p class="sub" style="margin:0">Hentes dagligt fra Energi Data Service, uden moms.</p></section>' +
    '<section class="card"><div class="row"><label for="eff">Ladeeffekt (kW)</label><input id="eff" type="number" inputmode="decimal" min="1" max="50" step="0.1" value="' + s.eff + '" data-in="eff"></div>' +
    '<div class="row"><div><label for="til">Leverandørtillæg (kr/kWh)</label><div class="small label" style="font-weight:400">Ekskl. moms, fra din regning</div></div><input id="til" type="number" inputmode="decimal" min="0" max="5" step="0.01" value="' + s.tillaeg + '" data-in="tillaeg"></div>' +
    sw('moms', 'Priser inkl. moms', '25 % moms lægges oveni') + '</section>' +
    '<section class="card"><h2>Data</h2><p class="sub" style="margin:0">Prognose genereret ' + esc(cap(F.wd.format(Date.parse(p.genereret)).replace('.', '')) + ' ' + hmf(Date.parse(p.genereret))) + '. Kilder: Energi Data Service og Open-Meteo. Prognosen er et skøn, og kun priserne for i dag og i morgen er endelige.</p>' +
    '<button class="link-btn danger" data-act="nulstil">Slet gemte ladninger (' + S.lad.length + ')</button></section>';
}

/* ---------- render og hændelser ---------- */
function render() {
  const v = document.getElementById('view'), r = S.route;
  document.body.classList.toggle('subpage', r === 'indstillinger');
  document.querySelectorAll('#tabs a').forEach((a) => { if (a.dataset.tab === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (S.err) { v.innerHTML = '<p class="err">' + esc(S.err) + '</p><button class="btn plain" data-act="retry">Prøv igen</button>'; return; }
  if (!S.D) { v.innerHTML = '<p class="loading">Henter priser ...</p>'; return; }
  const views = { lad: viewLad, priser: viewPriser, besparelse: viewBesparelse, indstillinger: viewIndstillinger, uge: viewUge };
  v.innerHTML = (views[r] || viewLad)();
}
function route() {
  const r = (location.hash.replace(/^#\/?/, '') || 'lad');
  S.route = ['lad', 'priser', 'besparelse', 'indstillinger', 'uge'].includes(r) ? r : 'lad';
  render(); window.scrollTo(0, 0);
}
function gem() {
  const P = planCalc(), D = S.D; if (P.err || P.verdict === 'Kan ikke nås') return;
  const pl = (m) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([i, k]) => [D.t0 + i * H, k]);
  const from = D.t0 + P.startI * H;
  // Ældre gemte planer afløses fra nu af: de timer flyttes til "rest", så de ikke tælles to gange.
  for (const it of S.lad) {
    const gone = it.plan.filter(([ms]) => ms >= from);
    it.rest = (it.rest || []).concat(gone);
    it.plan = it.plan.filter(([ms]) => ms < from);
    it.straks = it.straks.filter(([ms]) => ms < from);
  }
  S.lad = S.lad.filter((it) => it.plan.length || it.straks.length);
  S.lad.unshift({ id: Date.now(), v: 2, ts: Date.now(), kwh: Math.round(P.kwhP * 10) / 10, area: S.s.omraade, tillaeg: S.s.tillaeg, moms: S.s.moms, plan: pl(P.plan), straks: pl(P.base), rest: [] });
  S.lad = S.lad.slice(0, 200); saveLad(); render();
}
function act(a, v) {
  const s = S.s;
  if (a === 'ukm') { const [d, dl] = v.split(':').map(Number); s.uge[d].km = Math.max(0, Math.min(1000, s.uge[d].km + dl)); saveSettings(); }
  else if (a === 'away') { s.uge[Number(v)].away = !s.uge[Number(v)].away; saveSettings(); }
  else if (a === 'gem') { gem(); return; }
  else if (a === 'omraade') { s.omraade = v; saveSettings(); prep(); }
  else if (a === 'net') { s.net = v; saveSettings(); prep(); }
  else if (a === 'sw') { s[v] = !s[v]; saveSettings(); prep(); }
  else if (a === 'nulstil') { S.lad = []; saveLad(); }
  else if (a === 'retry') { S.err = null; load(); return; }
  render();
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && !b.disabled) act(b.dataset.act, b.dataset.v); });
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.in === 'netfilter') { S.netFilter = t.value; const l = document.getElementById('netlist'); if (l) l.innerHTML = netListHtml(); }
  else if (t.dataset.in === 'soc') { S.s.soc = Number(t.value); const o = document.getElementById('socout'); if (o) o.textContent = S.s.soc + ' % · ' + Math.round(S.s.bat * S.s.soc / 100) + ' kWh'; }
});
document.addEventListener('change', (e) => {
  const t = e.target, s = S.s;
  if (t.dataset.in === 'soc') { s.soc = Number(t.value); s.socTs = Date.now(); saveSettings(); render(); }
  else if (t.dataset.in === 'uge') {
    const u = s.uge[Number(t.dataset.day)], f = t.dataset.f, old = u[f];
    if (/^\d{2}:\d{2}$/.test(t.value)) u[f] = t.value;
    if (hmMin(u.fra) >= hmMin(u.til)) u[f] = old;
    saveSettings(); render();
  }
  else if (['bat', 'minP', 'maxP', 'fk'].includes(t.dataset.in)) {
    const v = parseFloat(String(t.value).replace(',', '.')), k = t.dataset.in;
    if (v >= Number(t.min) && v <= Number(t.max)) { s[k] = v; if (s.minP >= s.maxP) { if (k === 'minP') s.minP = Math.max(0, s.maxP - 5); else s.maxP = Math.min(100, s.minP + 5); } saveSettings(); }
    render();
  }
  else if (t.dataset.in === 'eff') { const v = parseFloat(String(t.value).replace(',', '.')); if (v >= 1 && v <= 50) { s.eff = v; saveSettings(); } render(); }
  else if (t.dataset.in === 'tillaeg') { const v = parseFloat(String(t.value).replace(',', '.')); if (v >= 0 && v <= 5) { s.tillaeg = v; saveSettings(); prep(); } render(); }
});
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.prog) { prep(); if (S.route !== 'indstillinger' && S.route !== 'uge') render(); } });
setInterval(() => { if (S.prog && S.route !== 'indstillinger' && S.route !== 'uge' && !document.hidden) { prep(); render(); } }, 60000);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
route();
load();
