#!/usr/bin/env python3
"""
Elbil-lader: forudsiger elprisen (DK2) 4 dage frem og finder billigste ladeplan.

Installer:   pip install pandas numpy requests lightgbm
Eksempel:    python elbil_lader.py --behov "2026-11-23 07:00=25" --behov "2026-11-25 07:00=30"
             (--behov "klar-tidspunkt=kWh der skal tilføjes inden da", kan gentages)
Flag:        --effekt 11   --refresh (hent data igen)   --backtest (vis modelkvalitet)

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
    X["dag_aar"] = lokal.dayofyear
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


def traen(Xtr, ytr):
    modeller = {}
    for navn, alpha in (("lav", 0.2), ("median", 0.5), ("hoej", 0.8)):
        m = lgb.LGBMRegressor(
            objective="quantile", alpha=alpha, n_estimators=400, learning_rate=0.05,
            num_leaves=31, min_child_samples=30, subsample=0.8, subsample_freq=1,
            colsample_bytree=0.8, verbose=-1,
        )
        m.fit(Xtr, ytr)
        modeller[navn] = m
    return modeller


def forudsig(modeller, X):
    P = np.column_stack([modeller[n].predict(X) for n in ("lav", "median", "hoej")])
    P = np.sort(P, axis=1)  # sikrer lav <= median <= hoej
    return pd.DataFrame(P, index=X.index, columns=["lav", "median", "hoej"])


def backtest(df, X, dage=60):
    y = df["pris"]
    kendt = y.dropna().index
    cut = kendt.max() - pd.Timedelta(days=dage)
    tr = X[(y.notna()) & (X.index < cut)]
    te = X[(y.notna()) & (X.index >= cut)]
    modeller = traen(tr, y.loc[tr.index])
    pr = forudsig(modeller, te)
    yt = y.loc[te.index]
    mae_model = (pr["median"] - yt).abs().mean()
    base = te["pris_lag168"]
    mae_base = (base - yt).abs()[base.notna()].mean()
    daekning = ((yt >= pr["lav"]) & (yt <= pr["hoej"])).mean()
    print(f"\nBacktest (sidste {dage} dage):")
    print(f"  MAE model:    {mae_model:.3f} kr/kWh")
    print(f"  MAE baseline: {mae_base:.3f} kr/kWh (samme time sidste uge)")
    print(f"  Faktisk pris i 20-80%-intervallet: {daekning:.0%} (ideelt ca. 60%)")


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

    if a.backtest:
        backtest(df, X)

    y = df["pris"]
    tr = X[y.notna()]
    modeller = traen(tr, y.loc[tr.index])

    nu = pd.Timestamp.now(tz="UTC")
    start = nu.ceil("h")
    slut = min(start + pd.Timedelta(days=HORISONT_DAGE), df.index.max())
    fremtid = X[(X.index >= start) & (X.index <= slut)]
    pred = forudsig(modeller, fremtid)
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
