#!/usr/bin/env python3
"""
Elbil-lader: forudsiger elprisen (DK2) 4 dage frem og finder billigste ladeplan.

Installer:   pip install pandas numpy requests lightgbm
Eksempel:    python elbil_lader.py --behov "2026-11-23 07:00=25" --behov "2026-11-25 07:00=30"
             (--behov "klar-tidspunkt=kWh der skal tilføjes inden da", kan gentages)
Flag:        --effekt 11   --refresh (hent data igen)   --backtest (vis modelkvalitet)
             --sammenlign (backtest med forskellige vægtninger af nyere data)
             --halvering 180 (halveringstid i dage for datavægt, 0 = fra)
             --ingen-kalibrering (slå justering af intervallerne fra)

Datakilder (gratis, ingen nøgle):
  - Priser:  Energi Data Service (Energinet)
  - Vejr:    Open-Meteo (vind, sol, temperatur: historik + 7 dages prognose)
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

try:
    import lightgbm as lgb
except ImportError:
    sys.exit("Mangler lightgbm. Kør: pip install pandas numpy requests lightgbm")

# ----------------------------------------------------------------------------
# INDSTILLINGER - TILPAS DISSE
# ----------------------------------------------------------------------------
OMRAADE = "DK2"
TZ = "Europe/Copenhagen"
HISTORIK_DAGE = 730          # træningsdata
HORISONT_DAGE = 4            # hvor langt frem vi planlægger
MIN_BESPARELSE_KR = 5.0      # under dette anbefales bare at lade straks
HALVERING_DAGE = 180         # nyere data vægtes højere; data halveres i vægt pr. X dage (0 = fra)
KALIBRERING_DAGE = 30        # de seneste dage bruges til at justere bias og intervaller
CACHE = Path("cache")
CACHE.mkdir(exist_ok=True)

# !!! PLACEHOLDERS - SKAL ERSTATTES MED DINE EGNE TAL (kr/kWh, ekskl. moms) !!!
# Nettarif fra dit netselskab (varierer over døgnet). Kig på din seneste faktura/netselskabets hjemmeside.
TARIF_PR_TIME = {h: 0.40 for h in range(24)}
TARIF_PR_TIME.update({h: 0.20 for h in range(0, 6)})     # nat (PLACEHOLDER)
TARIF_PR_TIME.update({h: 1.00 for h in range(17, 21)})   # spidslast (PLACEHOLDER)
# Faste tillæg pr. kWh: Energinet-tariffer + elafgift + leverandørens tillæg (PLACEHOLDER)
EKSTRA_PR_KWH = 0.30
MOMS = 1.25

# Vejrpunkter, der gennemsnitliges (Sjælland, Vestjylland, Lolland-Falster)
PUNKTER = [(55.68, 12.57), (55.48, 8.45), (54.90, 11.00)]
VEJR_VAR = "temperature_2m,wind_speed_100m,shortwave_radiation"


# ----------------------------------------------------------------------------
# DATA
# ----------------------------------------------------------------------------
def frisk(fil, refresh, max_timer):
    return (not refresh) and fil.exists() and (time.time() - fil.stat().st_mtime) < max_timer * 3600


def eds_hent(datasaet, kolonner, start, slut):
    params = {
        "start": start.strftime("%Y-%m-%dT%H:%M"),
        "end": slut.strftime("%Y-%m-%dT%H:%M"),
        "filter": json.dumps({"PriceArea": [OMRAADE]}),
        "columns": ",".join(kolonner),
        "sort": f"{kolonner[0]} asc",
        "limit": 0,
    }
    r = requests.get(f"https://api.energidataservice.dk/dataset/{datasaet}", params=params, timeout=90)
    r.raise_for_status()
    return pd.DataFrame(r.json()["records"])


def hent_priser(refresh):
    """Timepriser i kr/kWh (spot, ekskl. afgifter/moms), UTC-indeks."""
    fil = CACHE / "priser.csv"
    if frisk(fil, refresh, 3):
        s = pd.read_csv(fil, index_col=0, parse_dates=True)["pris"]
        s.index = pd.to_datetime(s.index, utc=True)
        return s

    nu = pd.Timestamp.now(tz="UTC").tz_localize(None)
    start = nu - pd.Timedelta(days=HISTORIK_DAGE)
    slut = nu + pd.Timedelta(days=2)
    skift = pd.Timestamp("2025-10-01")  # day-ahead gik over til 15-min opløsning
    dele = []

    if start < skift:
        try:
            d = eds_hent("Elspotprices", ["HourUTC", "SpotPriceDKK"], start, min(slut, skift))
            dele.append(d.rename(columns={"HourUTC": "tid", "SpotPriceDKK": "pris"}))
        except Exception as e:
            print(f"Advarsel: kunne ikke hente Elspotprices ({e})")
    try:
        d = eds_hent("DayAheadPrices", ["TimeUTC", "DayAheadPriceDKK"], max(start, skift), slut)
        dele.append(d.rename(columns={"TimeUTC": "tid", "DayAheadPriceDKK": "pris"}))
    except Exception as e:
        print(f"Advarsel: kunne ikke hente DayAheadPrices ({e})")

    dele = [d for d in dele if len(d)]
    if not dele:
        sys.exit("Kunne ikke hente priser. Tjek internet/datasætnavne på energidataservice.dk")
    df = pd.concat(dele)
    df["tid"] = pd.to_datetime(df["tid"], utc=True)
    df["pris"] = pd.to_numeric(df["pris"], errors="coerce") / 1000.0  # DKK/MWh -> kr/kWh
    s = df.dropna().set_index("tid")["pris"].sort_index()
    s = s.resample("h").mean().dropna()  # 15-min -> time
    s.rename("pris").to_csv(fil)
    return s


def hent_vejr(refresh):
    fil = CACHE / "vejr.csv"
    if frisk(fil, refresh, 3):
        v = pd.read_csv(fil, index_col=0, parse_dates=True)
        v.index = pd.to_datetime(v.index, utc=True)
        return v

    idag = pd.Timestamp.now(tz="UTC").normalize()
    start = (idag - pd.Timedelta(days=HISTORIK_DAGE)).strftime("%Y-%m-%d")
    arkiv_slut = (idag - pd.Timedelta(days=7)).strftime("%Y-%m-%d")
    frames = []
    for lat, lon in PUNKTER:
        basis = {"latitude": lat, "longitude": lon, "hourly": VEJR_VAR, "timezone": "UTC", "wind_speed_unit": "ms"}
        a = requests.get("https://archive-api.open-meteo.com/v1/archive",
                         params={**basis, "start_date": start, "end_date": arkiv_slut}, timeout=90)
        p = requests.get("https://api.open-meteo.com/v1/forecast",
                         params={**basis, "past_days": 10, "forecast_days": 7}, timeout=90)
        a.raise_for_status()
        p.raise_for_status()
        dfs = []
        for r in (a, p):
            d = pd.DataFrame(r.json()["hourly"])
            d["time"] = pd.to_datetime(d["time"], utc=True)
            dfs.append(d.set_index("time"))
        frames.append(dfs[0].combine_first(dfs[1]))  # arkiv hvor muligt, ellers prognose
    v = pd.concat(frames).groupby(level=0).mean().sort_index()
    v = v.rename(columns={"temperature_2m": "temp", "wind_speed_100m": "vind", "shortwave_radiation": "sol"})
    v.to_csv(fil)
    return v


# ----------------------------------------------------------------------------
# MODEL
# ----------------------------------------------------------------------------
def lav_features(df):
    """df: UTC-indeks med kolonner pris (NaN i fremtiden), temp, vind, sol."""
    df = df.reindex(pd.date_range(df.index.min(), df.index.max(), freq="h"))
    lokal = df.index.tz_convert(TZ)
    X = pd.DataFrame(index=df.index)
    X["time"] = lokal.hour
    X["ugedag"] = lokal.dayofweek
    X["maaned"] = lokal.month
    # Glat årstid (i stedet for dag på året, som kan få modellen til at "huske" bestemte datoer)
    vinkel = 2 * np.pi * (lokal.dayofyear.to_numpy() - 1) / 365.25
    X["aar_sin"] = np.sin(vinkel)
    X["aar_cos"] = np.cos(vinkel)
    X["temp"] = df["temp"]
    X["vind"] = df["vind"]
    X["sol"] = df["sol"]
    X["vind_24t"] = df["vind"].rolling(24, min_periods=12).mean()
    p = df["pris"]
    # Kun lags >= 96 timer, så de altid er kendt for mål op til 4 dage efter seneste kendte pris
    X["pris_lag96"] = p.shift(96)
    X["pris_lag168"] = p.shift(168)
    X["pris_niveau"] = p.shift(96).rolling(168, min_periods=48).mean()
    return df, X


def vaegte(index, halvering):
    """Vægt pr. træningsrække: nyere data tæller mere. None = ens vægt."""
    if halvering <= 0:
        return None
    alder_dage = np.asarray((index.max() - index) / pd.Timedelta(days=1), dtype=float)
    return 0.5 ** (alder_dage / halvering)


def traen(Xtr, ytr, vaegt=None):
    modeller = {}
    for navn, alpha in (("lav", 0.2), ("median", 0.5), ("hoej", 0.8)):
        m = lgb.LGBMRegressor(
            objective="quantile", alpha=alpha, n_estimators=400, learning_rate=0.05,
            num_leaves=31, min_child_samples=30, subsample=0.8, subsample_freq=1,
            colsample_bytree=0.8, verbose=-1,
        )
        m.fit(Xtr, ytr, sample_weight=vaegt)
        modeller[navn] = m
    return modeller


def forudsig(modeller, X):
    P = np.column_stack([modeller[n].predict(X) for n in ("lav", "median", "hoej")])
    P = np.sort(P, axis=1)  # sikrer lav <= median <= hoej
    return pd.DataFrame(P, index=X.index, columns=["lav", "median", "hoej"])


def kalibrering(modeller, Xcal, ycal):
    """Måler bias og interval-fejl på nyere data, som modellen ikke er trænet på.
    Returnerer korrektioner (kr/kWh), der lægges på prognoserne bagefter."""
    ycal = np.asarray(ycal, dtype=float)
    p = forudsig(modeller, Xcal)
    bias = float(np.median(ycal - p["median"].to_numpy()))
    p = p + bias
    n = len(ycal)
    niveau = min(1.0, 0.8 * (1 + 1 / n))
    # Hver side af intervallet må ramme ved siden af 20 % af gangene (20-80 %-interval)
    q_lav = float(np.quantile(p["lav"].to_numpy() - ycal, niveau))
    q_hoej = float(np.quantile(ycal - p["hoej"].to_numpy(), niveau))
    return {"bias": bias, "q_lav": q_lav, "q_hoej": q_hoej}


def anvend_kalibrering(p, k):
    out = p + k["bias"]
    out["lav"] = np.minimum(out["lav"] - k["q_lav"], out["median"])
    out["hoej"] = np.maximum(out["hoej"] + k["q_hoej"], out["median"])
    return out


def maal(p, yt):
    yt = np.asarray(yt, dtype=float)
    lav, med, hoej = (p[c].to_numpy() for c in ("lav", "median", "hoej"))
    return {
        "mae": float(np.mean(np.abs(med - yt))),
        "bias": float(np.mean(med - yt)),
        "daekning": float(np.mean((yt >= lav) & (yt <= hoej))),
        "under": float(np.mean(yt < lav)),
        "over": float(np.mean(yt > hoej)),
    }


def koer_backtest(df, X, dage, halvering, kalibrer):
    """Træner på alt før testperioden, kalibrerer på KALIBRERING_DAGE dage lige før den,
    og tester på de seneste `dage` dage. Returnerer målinger og prognoser."""
    y = df["pris"]
    kendt = y.notna()
    cut = y.dropna().index.max() - pd.Timedelta(days=dage)
    calstart = cut - pd.Timedelta(days=KALIBRERING_DAGE)
    tr = kendt & (X.index < calstart)
    cal = kendt & (X.index >= calstart) & (X.index < cut)
    te = kendt & (X.index >= cut)
    ald = tr | cal

    k = None
    if kalibrer:
        m1 = traen(X[tr], y[tr], vaegte(X.index[tr.to_numpy()], halvering))
        k = kalibrering(m1, X[cal], y[cal])
    # Som i den rigtige kørsel: endelig model trænes på alle data før testperioden
    m2 = traen(X[ald], y[ald], vaegte(X.index[ald.to_numpy()], halvering))
    raa = forudsig(m2, X[te])
    kal = anvend_kalibrering(raa, k) if k else None
    yt = y[te]
    base = X.loc[te, "pris_lag168"]
    ok = base.notna().to_numpy()
    mae_base = float(np.mean(np.abs(base.to_numpy()[ok] - yt.to_numpy()[ok])))
    return {"raa": maal(raa, yt), "kal": maal(kal, yt) if k else None,
            "mae_base": mae_base, "korr": k, "kal_p": kal if k else raa, "yt": yt}


def backtest(df, X, dage=60, halvering=HALVERING_DAGE, kalibrer=True):
    r = koer_backtest(df, X, dage, halvering, kalibrer)

    def linje(navn, m):
        print(f"  {navn:<14} MAE {m['mae']:.3f} | bias {m['bias']:+.3f} | "
              f"dækning {m['daekning']:.0%} | pris under interval {m['under']:.0%}, over {m['over']:.0%}")

    print(f"\nBacktest (sidste {dage} dage, datavægt-halvering {halvering} dage):")
    print(f"  MAE baseline:  {r['mae_base']:.3f} kr/kWh (samme time sidste uge)")
    linje("Uden kalibrering", r["raa"])
    if r["kal"]:
        linje("Kalibreret", r["kal"])
        k = r["korr"]
        print(f"  Korrektion fundet: bias {k['bias']:+.3f}, nedre {k['q_lav']:+.3f}, øvre {k['q_hoej']:+.3f} kr/kWh")
    print("  Ideel dækning er ca. 60 %, og 'under' og 'over' bør hver ligge omkring 20 %.")
    ugentlig = ((r["yt"] >= r["kal_p"]["lav"]) & (r["yt"] <= r["kal_p"]["hoej"])).astype(float)
    ugentlig = ugentlig.resample("W").mean()
    print("  Dækning pr. uge: " + ", ".join(f"{v:.0%}" for v in ugentlig.to_numpy()))


def sammenlign(df, X, dage=60):
    print(f"\nSammenligning af datavægt (backtest sidste {dage} dage, kalibreret):")
    print(f"  {'Halvering':<12}{'MAE':>8}{'Bias':>9}{'Dækn. uden':>12}{'Dækn. med':>11}")
    for h in (0, 90, 180, 365):
        r = koer_backtest(df, X, dage, h, True)
        navn = "ingen" if h == 0 else f"{h} dage"
        print(f"  {navn:<12}{r['kal']['mae']:>8.3f}{r['kal']['bias']:>+9.3f}"
              f"{r['raa']['daekning']:>12.0%}{r['kal']['daekning']:>11.0%}")


# ----------------------------------------------------------------------------
# LADEPLAN
# ----------------------------------------------------------------------------
def samlet_pris(spot):
    timer = spot.index.tz_convert(TZ).hour
    tarif = np.array([TARIF_PR_TIME[h] for h in timer])
    return (spot + tarif + EKSTRA_PR_KWH) * MOMS


def lav_plan(pris, start, behov, effekt, strategi):
    """strategi: 'billigst' eller 'straks'. Returnerer kWh pr. time (Series)."""
    brugt = pd.Series(0.0, index=pris.index)
    for deadline, kwh in sorted(behov):
        vindue = pris[(pris.index >= start) & (pris.index < deadline)]
        raekkefoelge = vindue.sort_values().index if strategi == "billigst" else vindue.index
        rest = kwh
        for ts in raekkefoelge:
            tag = min(effekt - brugt[ts], rest)
            if tag <= 0:
                continue
            brugt[ts] += tag
            rest -= tag
            if rest <= 1e-9:
                break
        if rest > 1e-9:
            lokal = deadline.tz_convert(TZ).strftime("%d/%m %H:%M")
            sys.exit(f"Umuligt: {kwh} kWh kan ikke nås inden {lokal} med {effekt} kW.")
    return brugt


def pris_for_plan(brugt, pris):
    return float((brugt * pris).sum())


# ----------------------------------------------------------------------------
# MAIN
# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--behov", action="append", required=True,
                    help='"YYYY-MM-DD HH:MM=kWh", fx "2026-11-23 07:00=25". Kan gentages.')
    ap.add_argument("--effekt", type=float, default=11.0)
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--backtest", action="store_true")
    ap.add_argument("--sammenlign", action="store_true",
                    help="backtest med forskellige vægtninger af nyere data")
    ap.add_argument("--halvering", type=float, default=HALVERING_DAGE,
                    help="halveringstid i dage for datavægt (0 = ens vægt)")
    ap.add_argument("--ingen-kalibrering", action="store_true")
    a = ap.parse_args()

    behov = []
    for b in a.behov:
        tid, kwh = b.split("=")
        ts = pd.Timestamp(tid.strip()).tz_localize(TZ).tz_convert("UTC")
        behov.append((ts, float(kwh)))

    print("Henter priser og vejr ...")
    priser = hent_priser(a.refresh)
    vejr = hent_vejr(a.refresh)
    df = vejr.join(priser.rename("pris"), how="outer")
    df, X = lav_features(df)

    kalibrer = not a.ingen_kalibrering
    if a.sammenlign:
        sammenlign(df, X)
    if a.backtest:
        backtest(df, X, halvering=a.halvering, kalibrer=kalibrer)

    y = df["pris"]
    kendt_y = y.notna()
    korr = None
    if kalibrer:
        # Find bias og intervalkorrektion på de seneste dage (modellen er ikke trænet på dem)
        calstart = y.dropna().index.max() - pd.Timedelta(days=KALIBRERING_DAGE)
        tr1 = kendt_y & (X.index < calstart)
        cal = kendt_y & (X.index >= calstart)
        m1 = traen(X[tr1], y[tr1], vaegte(X.index[tr1.to_numpy()], a.halvering))
        korr = kalibrering(m1, X[cal], y[cal])
    modeller = traen(X[kendt_y], y[kendt_y], vaegte(X.index[kendt_y.to_numpy()], a.halvering))

    nu = pd.Timestamp.now(tz="UTC")
    start = nu.ceil("h")
    slut = min(start + pd.Timedelta(days=HORISONT_DAGE), df.index.max())
    fremtid = X[(X.index >= start) & (X.index <= slut)]
    pred = forudsig(modeller, fremtid)
    if korr:
        pred = anvend_kalibrering(pred, korr)
    pred["kilde"] = "forudsagt"
    kendt = y.reindex(pred.index)
    er_kendt = kendt.notna()
    for k in ("lav", "median", "hoej"):
        pred.loc[er_kendt, k] = kendt[er_kendt]
    pred.loc[er_kendt, "kilde"] = "kendt"

    if max(d for d, _ in behov) > pred.index.max() + pd.Timedelta(hours=1):
        sys.exit(f"Et klar-tidspunkt ligger uden for {HORISONT_DAGE}-dages prognosen.")

    tot = {k: samlet_pris(pred[k]) for k in ("lav", "median", "hoej")}
    plan_straks = lav_plan(tot["median"], start, behov, a.effekt, "straks")
    plan_bedst = lav_plan(tot["median"], start, behov, a.effekt, "billigst")

    def omk(plan, k):
        return pris_for_plan(plan, tot[k])

    straks = omk(plan_straks, "median")
    bedst = omk(plan_bedst, "median")
    # Samme plan vurderet i et billigt/dyrt scenarie, så du ser usikkerheden
    bes_lav = omk(plan_straks, "lav") - omk(plan_bedst, "lav")
    bes_hoej = omk(plan_straks, "hoej") - omk(plan_bedst, "hoej")
    besparelse = straks - bedst

    print("\n=== Resultat ===")
    print(f"Lad straks:        {straks:7.1f} kr")
    print(f"Optimeret plan:    {bedst:7.1f} kr")
    print(f"Forventet besparelse: {besparelse:.1f} kr (usikkerhed: {min(bes_lav, bes_hoej):.1f} til {max(bes_lav, bes_hoej):.1f} kr)")

    forste = plan_bedst[plan_bedst > 0].index.min()
    if besparelse < MIN_BESPARELSE_KR or forste == start:
        print("\nAnbefaling: LAD NU (ingen væsentlig gevinst ved at vente)."
              if besparelse < MIN_BESPARELSE_KR else
              "\nAnbefaling: START NU - planen starter allerede i denne time.")
    else:
        print(f"\nAnbefaling: VENT. Første ladetime er {forste.tz_convert(TZ).strftime('%a %d/%m kl. %H:%M')}.")

    print("\nLadeplan (timer med opladning):")
    print(f"{'Tid':<16}{'kWh':>6}{'kr/kWh':>9}  Kilde")
    for ts in plan_bedst[plan_bedst > 0].index:
        print(f"{ts.tz_convert(TZ).strftime('%a %d/%m %H:%M'):<16}{plan_bedst[ts]:>6.1f}"
              f"{tot['median'][ts]:>9.2f}  {pred.loc[ts, 'kilde']}")
    print("\nHusk: tariffer/afgifter i scriptet er PLACEHOLDERS - tilpas dem øverst i filen.")


if __name__ == "__main__":
    main()
