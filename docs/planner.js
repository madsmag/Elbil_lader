'use strict';
/* Ladeplanlægger. Ren beregning uden DOM, så den kan testes i Node.
   Tilstanden er batteriniveauet i trin af STEP kWh. Dynamisk programmering over timerne finder den billigste plan,
   der opfylder: ladeeffekt, ladegrænse, kun lade når bilen er hjemme, og nok strøm til hver tur. */
(function (root) {
  const STEP = 0.5;          // kWh pr. tilstand
  const PEN_EV = 1000;       // kr/kWh hvis en tur ikke kan nås (bruges kun til at finde "mindst dårlig" plan)
  const PEN_END = 5;         // kr/kWh under slutniveauet (højere end normale priser, så slutniveauet nås)

  /* c: { i0, i1, lastCharge, price[], eff, j0, jMax, capJ, minJ, endJ|null, avail(i), ev: {i: kWh} }
     Timerne i0..i1-1 simuleres. Der lades kun i timer < lastCharge. Returnerer ladning pr. time og tilstand pr. time. */
  function dp(c) {
    const J = c.jMax + 1, n = c.i1 - c.i0, maxX = Math.floor(c.eff / STEP + 1e-9);
    let cur = new Float64Array(J).fill(Infinity), nxt = new Float64Array(J);
    cur[Math.min(c.j0, c.jMax)] = 0;
    const prev = new Int16Array(n * J);
    const es = (i) => Math.round((c.ev[i] || 0) / STEP);
    for (let k = 0; k < n; k++) {
      const i = c.i0 + k, e = es(i), can = i < c.lastCharge && c.avail(i), px = c.price[i];
      nxt.fill(Infinity);
      for (let j = 0; j < J; j++) {
        const base = cur[j];
        if (base === Infinity) continue;
        let j1 = j - e, pen = 0;
        if (e > 0) { if (j1 < c.minJ) pen = (c.minJ - Math.max(j1, 0)) * STEP * PEN_EV; j1 = Math.max(j1, 0); }
        const top = can ? Math.min(c.jMax, Math.max(c.capJ, j1), j1 + maxX) : j1;
        for (let j2 = j1; j2 <= top; j2++) {
          const cost = base + pen + (j2 - j1) * STEP * px;
          if (cost < nxt[j2] - 1e-12) { nxt[j2] = cost; prev[k * J + j2] = j; }
        }
      }
      const t = cur; cur = nxt; nxt = t;
    }
    let best = 0, bv = Infinity;
    for (let j = 0; j < J; j++) {
      if (cur[j] === Infinity) continue;
      const v = cur[j] + (c.endJ != null ? Math.max(0, c.endJ - j) * STEP * PEN_END : 0);
      if (v < bv - 1e-12) { bv = v; best = j; }
    }
    const x = new Array(n).fill(0), path = new Array(n + 1);
    let j = best; path[n] = best;
    for (let k = n - 1; k >= 0; k--) {
      const pj = prev[k * J + j], e = es(c.i0 + k), j1 = Math.max(pj - e, 0);
      x[k] = (j - j1) * STEP; path[k] = pj; j = pj;
    }
    return { x, path };
  }

  function setup(cfg) {
    const bat = cfg.bat;
    return {
      price: cfg.price, eff: cfg.eff, jMax: Math.floor(bat / STEP + 1e-9), capJ: Math.floor(cfg.maxK / STEP + 1e-9),
      minJ: Math.ceil(cfg.minK / STEP - 1e-9), endJ: Math.round(cfg.endK / STEP), j0: Math.round(cfg.soc / STEP),
      avail: cfg.avail, ev: cfg.ev,
    };
  }

  /* Billigste plan over hele horisonten startI..N-1. Returnerer Map time -> kWh. */
  function optimize(cfg) {
    const b = setup(cfg);
    const r = dp(Object.assign({}, b, { i0: cfg.startI, i1: cfg.N, lastCharge: cfg.N }));
    const m = new Map();
    r.x.forEach((k, q) => { if (k > 1e-9) m.set(cfg.startI + q, k); });
    return m;
  }

  /* "Clever-metoden": planlæg et døgn ad gangen. I hvert vindue lades kun i vinduets timer, men ture lidt længere
     ude (LOOK timer) skal kunne nås. Vinduet efter næste døgn kender man ikke endnu. */
  function rolling(cfg, win = 24, look = 6) {
    const b = setup(cfg), m = new Map();
    let s = cfg.startI, j = b.j0;
    while (s < cfg.N) {
      const e = Math.min(s + win, cfg.N), last = e >= cfg.N, i1 = last ? cfg.N : Math.min(cfg.N, e + look);
      const r = dp(Object.assign({}, b, { i0: s, i1, lastCharge: e, j0: j, endJ: last ? b.endJ : null }));
      r.x.forEach((k, q) => { if (k > 1e-9) m.set(s + q, k); });
      j = r.path[e - s];
      s = e;
    }
    return m;
  }

  /* Forløb af batteriet for en plan. soc[i] = kWh ved timens slutning. short = ture, der ikke kan nås. */
  function simulate(cfg, plan) {
    const soc = [], short = [];
    let s = cfg.soc;
    for (let i = cfg.startI; i < cfg.N; i++) {
      const e = cfg.ev[i] || 0;
      if (e > 0) {
        s -= e;
        if (s < cfg.minK - 1e-6) { short.push({ i, kwh: cfg.minK - Math.max(s, 0) }); }
        s = Math.max(s, 0);
      }
      s = Math.min(cfg.bat, s + (plan.get(i) || 0));
      soc[i] = s;
    }
    return { soc, short };
  }

  const api = { STEP, optimize, rolling, simulate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Planner = api;
})(typeof self !== 'undefined' ? self : this);
