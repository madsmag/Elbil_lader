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
const DEF = { omraade: 'DK2', net: null, eff: 11, tillaeg: 0, moms: true, kwh: 40, dag: 1, tid: '07:00' };
const S = { prog: null, tar: null, D: null, err: null, route: 'lad', netFilter: '',
  s: Object.assign({}, DEF, store.get('settings', {})), lad: store.get('ladninger', []) };
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
function deadlineMs(off, tid) {
  const n = lp(Date.now()), d = addDays(n.year, n.month, n.day, off), [h, m] = tid.split(':').map(Number);
  return localToUtc(d.y, d.m, d.d, h, m);
}
function fill(order, kwh, eff) {
  const m = new Map(); let rest = kwh;
  for (const i of order) { if (rest <= 1e-9) break; const k = Math.min(eff, rest); m.set(i, k); rest -= k; }
  return m;
}
const costOf = (m, arr) => { let c = 0; m.forEach((k, i) => { c += k * arr[i]; }); return c; };

function planCalc() {
  const D = S.D, s = S.s, now = Date.now();
  const opts = [0, 1, 2, 3].map((off) => { const dl = deadlineMs(off, s.tid); return { off, dl, ok: dl > now + H && idxOf(dl) <= D.N }; });
  const cur = opts.find((o) => o.off === s.dag && o.ok) || opts.find((o) => o.ok);
  const P = { opts, cur };
  if (!cur) { P.err = 'Klar-tidspunktet ligger uden for prognosen. Vælg et andet tidspunkt.'; return P; }
  const startI = Math.max(0, Math.ceil((now - D.t0) / H)), endI = Math.min(D.N, Math.floor((cur.dl - D.t0) / H));
  const win = []; for (let i = startI; i < endI; i++) win.push(i);
  const kwh = s.kwh, eff = s.eff;
  if (!win.length) { P.err = 'Der er ingen hele timer inden klar-tidspunktet.'; return P; }
  if (win.length * eff < kwh - 1e-9) { P.err = kwh + ' kWh kan ikke nås med ' + nf(eff, 1) + ' kW inden da. Der er ' + win.length + ' timer, og det kræver ' + nf(kwh / eff, 1) + '.'; return P; }
  const T = D.T;
  const now_ = fill(win, kwh, eff);
  const cheap = fill([...win].sort((a, b) => T.md[a] - T.md[b] || a - b), kwh, eff);
  const cNow = costOf(now_, T.md), cBest = costOf(cheap, T.md), sav = cNow - cBest;
  const s1 = costOf(now_, T.lo) - costOf(cheap, T.lo), s2 = costOf(now_, T.hi) - costOf(cheap, T.hi);
  const chosen = [...cheap.keys()].sort((a, b) => a - b);
  Object.assign(P, { startI, endI, win, now_, cheap, cNow, cBest, sav, lo: Math.min(s1, s2), hi: Math.max(s1, s2), chosen, first: chosen[0] });
  const ms0 = D.t0 + P.first * H, hrs = nf(kwh / eff, 1);
  const dn = dayName(ms0), early = Number(hh(ms0)) < 6;
  const when = dn === 'I dag' ? 'i dag' : dn === 'I morgen' ? (early ? 'i nat' : 'i morgen') : F.wdl.format(ms0);
  if (P.first === startI) {
    P.verdict = 'Lad nu'; P.headline = 'Start ladningen nu';
    P.text = kwh + ' kWh på ' + hrs + ' timer. Planen starter allerede i næste hele time.';
  } else if (sav < 0.5) {
    P.verdict = 'Lad nu'; P.headline = 'Start ladningen nu';
    P.text = 'Der er ingen gevinst ved at vente. ' + kwh + ' kWh tager ' + hrs + ' timer.';
  } else if (sav < MIN_BES) {
    P.verdict = 'Marginal gevinst'; P.headline = 'Start ' + when + ' kl. ' + hh(ms0) + ':00';
    P.text = 'Du sparer kun ca. ' + nf(sav, 1) + ' kr. Vent kun, hvis du kan bruge en timer på laderen.';
  } else {
    P.verdict = 'Vent med at lade'; P.headline = 'Start ' + when + ' kl. ' + hh(ms0) + ':00';
    P.text = kwh + ' kWh på ' + hrs + ' timer. Ca. ' + kr0(sav) + ' kr billigere end at lade nu.';
  }
  P.known = chosen.every((i) => D.kendt[i]);
  P.range = P.known ? 'Priserne er kendte, så besparelsen er sikker.' : kr0(P.lo) === kr0(P.hi) ? 'Besparelse ca. ' + kr0(P.lo) + ' kr, afhængigt af prognosen.' : 'Besparelse mellem ' + kr0(P.lo) + ' og ' + kr0(P.hi) + ' kr, afhængigt af prognosen.';
  P.tip = P.first === startI || sav < 0.5 ? '' : 'Sæt bilens eller laderens timer til kl. ' + hh(ms0) + ':00.';
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

function viewLad() {
  const D = S.D, s = S.s, P = planCalc(), now = Date.now();
  const when = cap(F.wdl.format(now)) + ' ' + F.dm.format(now) + ', ' + hmf(now);
  let h = head(when, '<a class="icon-btn" href="#/indstillinger" aria-label="Indstillinger">' + ICON.gear + '</a>') + banner();
  if (P.err) {
    h += '<div class="errbox">' + esc(P.err) + '</div>';
  } else {
    h += '<section class="rec"><div class="verdict">' + P.verdict + '</div><div class="headline">' + esc(P.headline) + '</div>' +
      '<div class="text">' + esc(P.text) + '</div><div class="range">' + esc(P.range) + '</div>' +
      (P.tip ? '<div class="text">' + esc(P.tip) + '</div>' : '') + '</section>';
    h += '<div class="tiles"><div class="tile"><span class="label">Lad nu</span><b class="num">' + kr0(P.cNow) + ' kr</b></div>' +
      '<div class="tile"><span class="label">Ladeplan</span><b class="num">' + kr0(P.cBest) + ' kr</b></div>' +
      '<div class="tile good"><span class="label">Du sparer</span><b class="num">' + kr0(P.sav) + ' kr</b></div></div>';
  }
  const chips = P.opts.map((o) => {
    const lbl = o.off === 0 ? 'I dag' : o.off === 1 ? 'I morgen' : wd(o.dl);
    const on = P.cur && o.off === P.cur.off;
    return '<button class="chip" data-act="dag" data-v="' + o.off + '" aria-pressed="' + on + '"' + (o.ok ? '' : ' disabled') + '>' + esc(cap(lbl)) + '</button>';
  }).join('');
  h += '<section class="card"><div class="row"><h2>Energi</h2><div class="stepper">' +
    '<button data-act="kwh" data-v="-5" aria-label="Mindre">−</button><output class="num">' + s.kwh + ' kWh</output>' +
    '<button data-act="kwh" data-v="5" aria-label="Mere">+</button></div></div>' +
    '<div class="row"><label class="label" for="tid">Klar kl.</label><input id="tid" type="time" value="' + esc(s.tid) + '" data-in="tid"></div>' +
    '<div class="chips" role="group" aria-label="Dag">' + chips + '</div></section>';
  if (!P.err) {
    const T = D.T.md, lo = Math.min(...P.win.map((i) => T[i])), hi = Math.max(...P.win.map((i) => T[i])), set = new Set(P.chosen);
    const bars = P.win.map((i) => {
      const pct = 14 + (hi > lo ? (T[i] - lo) / (hi - lo) : 0.5) * 86;
      return '<i style="height:' + pct.toFixed(0) + '%;background:' + (set.has(i) ? 'var(--sel)' : 'var(--off)') + '"></i>';
    }).join('');
    h += '<section class="card"><div class="row"><h2>Ladeplan</h2><span class="label">' + P.chosen.length + ' timer valgt</span></div>' +
      '<div class="strip" role="img" aria-label="Pris pr. time frem til klar-tidspunktet, valgte timer er markeret">' + bars + '</div>' +
      '<div class="axis"><span>' + esc(wd(D.t0 + P.startI * H)) + ' ' + hh(D.t0 + P.startI * H) + ':00</span><span>Klar ' + esc(wd(P.cur.dl)) + ' ' + hmf(P.cur.dl) + '</span></div></section>';
    const saved = S.lad.some((x) => x.dl === P.cur.dl && x.kwh === s.kwh);
    h += '<div style="margin-top:12px"><button class="btn" style="width:100%" data-act="gem"' + (saved ? ' disabled' : '') + '>' + (saved ? 'Gemt under Besparelse' : 'Jeg følger planen') + '</button></div>' +
      '<p class="hint">Priser ' + (s.moms ? 'inkl.' : 'ekskl.') + ' moms, afgifter og nettarif hos ' + esc(D.netObj.navn) + '.' +
      (s.tillaeg ? '' : ' Tilføj dit leverandørtillæg under Indstillinger.') + '</p>';
  }
  return h;
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
  const D = S.D; let paid = 0, straks = 0, est = false;
  const mom = it.moms ? MOMS : 1;
  const price = (ms) => {
    const sp = spotAt(ms, it.area); if (!sp) return null;
    if (sp.est) est = true;
    const j = idxOf(ms), k = ((j % 24) + 24) % 24, ok = j >= 0 && j < D.N;
    return (sp.v + (ok ? D.net[j] : D.net[k]) + (ok ? D.fixed[j] : D.fixed[k]) + it.tillaeg) * mom;
  };
  for (const [ms, k] of it.plan) { const p = price(ms); if (p == null) return null; paid += p * k; }
  for (const [ms, k] of it.straks) { const p = price(ms); if (p == null) return null; straks += p * k; }
  return { paid, straks, save: straks - paid, est };
}
function viewBesparelse() {
  const items = S.lad.map((it) => ({ it, r: evalItem(it) })).filter((x) => x.r);
  const total = items.reduce((a, x) => a + x.r.save, 0);
  const wk = Array.from({ length: 8 }, (_, k) => isoWeek(Date.now() - (7 - k) * 7 * 864e5));
  const vals = wk.map((w) => items.filter((x) => { const q = isoWeek(x.it.ts); return q.y === w.y && q.w === w.w; }).reduce((a, x) => a + x.r.save, 0));
  const mx = Math.max(1, ...vals);
  let h = '<h1 style="padding:0 4px">Besparelse</h1><div class="sub" style="padding:0 4px">Beregnet ud fra de ladeplaner, du har gemt</div>' + banner();
  if (!items.length) {
    return h + '<section class="card"><h2>Ingen ladninger endnu</h2><p class="sub" style="margin:0">Når du trykker "Jeg følger planen" på Lad-skærmen, gemmer appen planen her. Den regner derefter ud, hvor meget du sparer i forhold til at lade med det samme, med de faktiske timepriser, efterhånden som de bliver kendt.</p></section>';
  }
  h += '<section class="hero"><div class="eyebrow">Sparet i alt</div><div class="total num">' + kr0(total) + ' kr</div><div class="text">' + items.length + ' ' + (items.length === 1 ? 'ladning' : 'ladninger') + ' gemt, sammenlignet med at lade med det samme</div>' +
    '<div class="weeks">' + vals.map((v, k) => '<div' + (k === 7 ? ' class="now"' : '') + '><span class="v num">' + (v ? kr0(v) : '') + '</span><span class="b" style="height:' + Math.max(4, Math.round(Math.max(0, v) / mx * 64)) + 'px"></span><span class="w">u' + wk[k].w + '</span></div>').join('') + '</div></section>';
  h += '<section class="card list" style="gap:0;padding-bottom:6px"><h2 style="padding-bottom:6px">Seneste ladninger</h2>' +
    items.slice(0, 12).map(({ it, r }) => {
      const a = it.plan[0][0];
      return '<div class="item"><div class="l"><b>' + esc(dayName(a)) + '</b><span class="small">' + it.kwh + ' kWh, start kl. ' + hh(a) + ':00, ' + it.plan.length + ' timer' + (r.est ? ' · foreløbig' : '') + '</span></div>' +
        '<div class="r"><span class="big good-t num">' + (r.save >= 0 ? '+' : '−') + kr0(Math.abs(r.save)) + ' kr</span><span class="small num">' + kr0(r.paid) + ' mod ' + kr0(r.straks) + ' kr</span></div></div>';
    }).join('') + '</section>' +
    '<p class="hint">Sparet er prisen for at lade med det samme minus prisen i de timer, du valgte. Det regnes med timepriser og er ikke målt på din måler. Ladninger, hvor priserne endnu er prognoser, er markeret foreløbige.</p>';
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
  const views = { lad: viewLad, priser: viewPriser, besparelse: viewBesparelse, indstillinger: viewIndstillinger };
  v.innerHTML = (views[r] || viewLad)();
}
function route() {
  const r = (location.hash.replace(/^#\/?/, '') || 'lad');
  S.route = ['lad', 'priser', 'besparelse', 'indstillinger'].includes(r) ? r : 'lad';
  render(); window.scrollTo(0, 0);
}
function gem() {
  const P = planCalc(), D = S.D, s = S.s; if (P.err) return;
  const pl = (m) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([i, k]) => [D.t0 + i * H, k]);
  S.lad.unshift({ id: Date.now(), ts: Date.now(), kwh: s.kwh, eff: s.eff, dl: P.cur.dl, area: s.omraade, tillaeg: s.tillaeg, moms: s.moms, plan: pl(P.cheap), straks: pl(P.now_) });
  S.lad = S.lad.slice(0, 200); saveLad(); render();
}
function act(a, v) {
  const s = S.s;
  if (a === 'kwh') { s.kwh = Math.max(5, Math.min(100, s.kwh + Number(v))); saveSettings(); }
  else if (a === 'dag') { s.dag = Number(v); saveSettings(); }
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
});
document.addEventListener('change', (e) => {
  const t = e.target, s = S.s;
  if (t.dataset.in === 'tid' && /^\d{2}:\d{2}$/.test(t.value)) { s.tid = t.value; saveSettings(); render(); }
  else if (t.dataset.in === 'eff') { const v = parseFloat(String(t.value).replace(',', '.')); if (v >= 1 && v <= 50) { s.eff = v; saveSettings(); } render(); }
  else if (t.dataset.in === 'tillaeg') { const v = parseFloat(String(t.value).replace(',', '.')); if (v >= 0 && v <= 5) { s.tillaeg = v; saveSettings(); prep(); } render(); }
});
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.prog) { prep(); if (S.route !== 'indstillinger') render(); } });
setInterval(() => { if (S.prog && S.route !== 'indstillinger' && !document.hidden) { prep(); render(); } }, 60000);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
route();
load();
