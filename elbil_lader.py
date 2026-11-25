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
Kroner:      --kroner-backtest (simulér dit ladebehov og se besparelsen i kroner)
             --sim-kwh 25 --sim-klar 07:00 --sim-tid 22:00 --sim-dage 1,2,3 --backtest-dage 60
             --min-besparelse 5 (kr, grænse for at anbefale at vente)
Tariffer:    --netselskaber (liste)   --netselskab "radius" eller nummer   --vis-tariffer
             --tarifkode KODE (vælg en anden nettarif)   --tillaeg 0.05 (leverandør, kr/kWh ekskl. moms)

Datakilder (gratis, ingen nøgle):
  - Priser:  Energi Data Service (Energinet)
  - Vejr:    Open-Meteo (vind, sol, temperatur: historik + 7 dages prognose)
"""
import argparse
import json
import re
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
    r = hent_med_genforsoeg(f"https://api.energidataservice.dk/dataset/{datasaet}", params)
    return pd.DataFrame(r.json()["records"])


def hent_priser(refresh):
    """Timepriser i kr/kWh (spot, ekskl. afgifter/moms), UTC-indeks."""
    fil = CACHE / f"priser_{OMRAADE}.csv"
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
# TARIFFER: netselskab, Energinet og elafgift fra Energi Data Service (DatahubPricelist)
# ----------------------------------------------------------------------------
ENERGINET_GLN = "5790000432752"
ENERGINET_KODER = {"systemtarif": "41000", "nettarif (Energinet)": "40000", "elafgift": "EA-001"}
# Reserveværdier (kr/kWh ekskl. moms, 2026-satser), hvis satserne ikke kan hentes
RESERVE = {"systemtarif": 0.072, "nettarif (Energinet)": 0.043, "elafgift": 0.008}
PRISKOL = [f"Price{i}" for i in range(1, 25)]
TARIF_KOL = ["ChargeOwner", "GLN_Number", "ChargeType", "ChargeTypeCode", "Note",
             "ValidFrom", "ValidTo"] + PRISKOL
NOTE_C = r"tarif\s*c\b|\bc[- ]?(?:kunde|forbrug|tarif)"   # almindelig forbrugstarif for husholdninger
NOTE_UDE = r"produc|produk|flex|egen|abo|rabat|refusion|reduc"  # springes over, medmindre --tarifkode bruges


def laes_tariffer(df):
    df = df.copy()
    df["ChargeTypeCode"] = df["ChargeTypeCode"].astype(str)
    df["GLN_Number"] = df["GLN_Number"].astype(str)
    df["Note"] = df["Note"].fillna("").astype(str)
    for c in PRISKOL:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["fra"] = pd.to_datetime(df["ValidFrom"], errors="coerce")
    df["til"] = pd.to_datetime(df["ValidTo"], errors="coerce").fillna(pd.Timestamp("2100-01-01"))
    return df.dropna(subset=["fra"])


def hent_med_genforsoeg(url, params, forsoeg=6):
    """GET med ventetid og nyt forsøg ved 429 (rate limit) og midlertidige serverfejl."""
    for i in range(forsoeg):
        r = requests.get(url, params=params, timeout=180)
        if r.status_code not in (429, 500, 502, 503, 504):
            r.raise_for_status()
            return r
        if i == forsoeg - 1:
            break
        try:
            vent = float(r.headers.get("Retry-After", ""))
        except ValueError:
            vent = 10 * 2 ** i          # 10, 20, 40, 80, 160 sek.
        vent = min(max(vent, 5), 180)
        print(f"Energi Data Service svarede {r.status_code}. Venter {vent:.0f} sek. og prøver igen "
              f"({i + 1}/{forsoeg - 1}) ...")
        time.sleep(vent)
    sys.exit(f"Energi Data Service afviser stadig ({r.status_code}). Vent et par minutter og prøv igen.")


def hent_tariffer(refresh):
    fil = CACHE / "tariffer.csv"
    if frisk(fil, refresh, 12):
        return laes_tariffer(pd.read_csv(fil, dtype=str))
    idag = pd.Timestamp.now(tz=TZ).normalize().tz_localize(None)
    start = (idag - pd.Timedelta(days=3 * 365)).strftime("%Y-%m-%d")
    slut = (idag + pd.Timedelta(days=200)).strftime("%Y-%m-%d")
    dele = []
    for filt in ({"ChargeType": ["D03"]}, {"ChargeTypeCode": list(ENERGINET_KODER.values())}):
        params = {"start": start, "end": slut, "filter": json.dumps(filt),
                  "columns": ",".join(TARIF_KOL), "limit": 0}
        r = hent_med_genforsoeg("https://api.energidataservice.dk/dataset/DatahubPricelist", params)
        dele.append(pd.DataFrame(r.json()["records"]))
        time.sleep(2)  # skån API'et mellem de to kald
    dele = [d for d in dele if len(d)]
    if not dele:
        sys.exit("Kunne ikke hente tariffer fra Energi Data Service (DatahubPricelist).")
    df = pd.concat(dele).drop_duplicates()
    df.to_csv(fil, index=False)
    return laes_tariffer(df)


def gyldige(df, lokal_naiv):
    return df[(df["fra"] <= lokal_naiv) & (df["til"] > lokal_naiv)]


def netselskaber(df):
    nu = pd.Timestamp.now(tz=TZ).tz_localize(None)
    g = gyldige(df, nu)
    g = g[(g["ChargeType"] == "D03") & (g["GLN_Number"] != ENERGINET_GLN)
          & g["ChargeOwner"].notna() & g["Price1"].notna()]
    return sorted(g["ChargeOwner"].unique())


def find_netselskab(df, navn):
    liste = netselskaber(df)
    if navn.strip().isdigit():
        i = int(navn) - 1
        if 0 <= i < len(liste):
            return liste[i]
        sys.exit(f"Nummer {navn} findes ikke. Kør med --netselskaber for at se listen.")
    fund = [n for n in liste if navn.lower() in n.lower()]
    exact = [n for n in liste if n.lower() == navn.lower()]
    if len(exact) == 1:
        return exact[0]
    if len(fund) == 1:
        return fund[0]
    if not fund:
        sys.exit(f"Intet netselskab matcher '{navn}'. Kør med --netselskaber for at se listen.")
    sys.exit("Flere netselskaber matcher: " + "; ".join(fund) + ". Skriv navnet mere præcist.")


def vaelg_nettarif_raekker(df, ejer, kode=None):
    r = df[(df["ChargeOwner"] == ejer) & (df["ChargeType"] == "D03")]
    if kode:
        return r[r["ChargeTypeCode"] == str(kode)]
    c = r[r["Note"].str.contains(NOTE_C, case=False, regex=True)
          & ~r["Note"].str.contains(NOTE_UDE, case=False, regex=True)]
    if c.empty:
        c = r[~r["Note"].str.contains(NOTE_UDE, case=False, regex=True)]
    # Rækker med kun 0 i priserne er typisk rabat-/dummyrækker, ikke den rigtige tarif
    ikke_nul = c[c[PRISKOL].max(axis=1) > 0]
    return ikke_nul if not ikke_nul.empty else c


def pris_paa(raekker, lokal_naiv):
    """Pris (kr/kWh) for hver lokal time. PriceN gælder lokal time N-1; en dagspris fylder alle timer."""
    ud = np.full(len(lokal_naiv), np.nan)
    brugte = set()
    for i, ts in enumerate(lokal_naiv):
        g = gyldige(raekker, ts)
        if g.empty:
            continue
        g = g.assign(_tim=g["Price24"].notna().astype(int)).sort_values(
            ["_tim", "fra", "ChargeTypeCode"], ascending=[False, False, True])
        r = g.iloc[0]
        p = r[f"Price{ts.hour + 1}"]
        if pd.isna(p):
            p = r["Price1"]
        ud[i] = p
        brugte.add((r["ChargeTypeCode"], r["Note"]))
    return ud, brugte


def vis_tariffer(df, navn):
    ejer = find_netselskab(df, navn)
    nu = pd.Timestamp.now(tz=TZ).tz_localize(None)
    g = gyldige(df[(df["ChargeOwner"] == ejer) & (df["ChargeType"] == "D03")], nu)
    print(f"\nTariffer for {ejer} (gyldige nu, kr/kWh ekskl. moms):")
    print(f"{'Kode':<10}{'Beskrivelse':<38}{'Laveste':>9}{'Højeste':>9}")
    valgt = vaelg_nettarif_raekker(df, ejer)
    valgte = set(valgt["ChargeTypeCode"])
    for _, r in g.sort_values("ChargeTypeCode").iterrows():
        p = r[PRISKOL].dropna()
        if p.empty:
            continue
        mark = "  <- bruges som standard" if r["ChargeTypeCode"] in valgte else ""
        print(f"{r['ChargeTypeCode']:<10}{r['Note'][:36]:<38}{p.min():>9.3f}{p.max():>9.3f}{mark}")
    print("\nTjek mod din faktura. Vælg en anden med --tarifkode KODE.")


def lav_tillaeg(df, navn, idx_utc, kode, leverandoer):
    """Samlet tillæg til spotprisen (kr/kWh ekskl. moms) for hver time: nettarif + Energinet + afgift + leverandør."""
    ejer = find_netselskab(df, navn)
    lokal = idx_utc.tz_convert(TZ).tz_localize(None)
    net, brugte = pris_paa(vaelg_nettarif_raekker(df, ejer, kode), lokal)
    if np.isnan(net).any():
        sys.exit(f"Fandt ikke nettarif for hele perioden hos {ejer}. Brug --vis-tariffer og --tarifkode.")
    if net.max() < 0.05:
        print(f"\nADVARSEL: nettariffen hos {ejer} er under 0,05 kr/kWh, hvilket ser forkert ud. "
              "Kør med --vis-tariffer og vælg rigtig række med --tarifkode.\n")
    dele = {}
    for navn_, k in ENERGINET_KODER.items():
        e = df[df["ChargeTypeCode"] == k]
        if (e["GLN_Number"] == ENERGINET_GLN).any():
            e = e[e["GLN_Number"] == ENERGINET_GLN]
        v = pris_paa(e, lokal)[0] if len(e) else np.full(len(lokal), np.nan)
        if np.isnan(v).any():
            print(f"Advarsel: kunne ikke finde {navn_} i data, bruger reserveværdi {RESERVE[navn_]:.3f} kr/kWh.")
            v = np.where(np.isnan(v), RESERVE[navn_], v)
        dele[navn_] = v
    print(f"\nTariffer (kr/kWh ekskl. moms) for {ejer}:")
    for kd, note in sorted(brugte):
        print(f"  Nettarif, kode {kd} '{note}': {net.min():.3f} - {net.max():.3f}")
    for navn_, v in dele.items():
        print(f"  {navn_}: {v.mean():.3f}")
    print(f"  Leverandørtillæg: {leverandoer:.3f}" + ("  (sæt med --tillaeg)" if leverandoer == 0 else ""))
    total = net + sum(dele.values()) + leverandoer
    return pd.Series(total, index=idx_utc)


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


def kroner_backtest(df, X, tillaeg_fn, dage, halvering, kalibrer, kwh, effekt, klar, beslut_tid,
                    horisonter, min_bes):
    """Simulerer et ladebehov hver dag og sammenligner i kroner: lad straks, følg modellens råd
    og perfekt (kender facit). Modellen bruger kun priser, der var kendt på beslutningstidspunktet."""
    y = df["pris"]
    kendt = y.notna()
    slut = y.dropna().index.max()
    cut = slut - pd.Timedelta(days=dage)
    calstart = cut - pd.Timedelta(days=KALIBRERING_DAGE)
    tr = kendt & (X.index < calstart)
    cal = kendt & (X.index >= calstart) & (X.index < cut)
    ald = tr | cal
    k = None
    if kalibrer:
        m1 = traen(X[tr], y[tr], vaegte(X.index[tr.to_numpy()], halvering))
        k = kalibrering(m1, X[cal], y[cal])
    m2 = traen(X[ald], y[ald], vaegte(X.index[ald.to_numpy()], halvering))
    idx = X.index[(X.index >= cut) & (X.index <= slut)]
    pred = forudsig(m2, X.loc[idx])
    if k:
        pred = anvend_kalibrering(pred, k)
    tillaeg = tillaeg_fn(idx) if tillaeg_fn else None
    pris_akt = samlet_pris(y.loc[idx], tillaeg)
    pris_pred = samlet_pris(pred["median"], tillaeg)

    th, tm = (int(v) for v in beslut_tid.split(":"))
    kh, km = (int(v) for v in klar.split(":"))
    cut_l = cut.tz_convert(TZ).tz_localize(None).normalize()
    slut_l = slut.tz_convert(TZ).tz_localize(None).normalize()

    def utc(naiv):
        return naiv.tz_localize(TZ, ambiguous=True, nonexistent="shift_forward").tz_convert("UTC")

    raekker = {h: [] for h in horisonter}
    for d in pd.date_range(cut_l + pd.Timedelta(days=1), slut_l, freq="D"):
        start = utc(d + pd.Timedelta(hours=th, minutes=tm)).ceil("h")
        # Day-ahead-priser for næste døgn offentliggøres ca. kl. 13
        kendt_til = utc(d + pd.Timedelta(days=2 if th >= 13 else 1))
        for h in horisonter:
            dl = utc(d + pd.Timedelta(days=h, hours=kh, minutes=km))
            vindue = idx[(idx >= start) & (idx < dl)]
            if start < cut or dl > slut + pd.Timedelta(hours=1) or len(vindue) * effekt < kwh:
                continue
            pa = pris_akt.loc[vindue]
            if pa.isna().any():
                continue
            pm = pa.where(vindue < kendt_til, pris_pred.loc[vindue])  # kendt pris, ellers prognose
            b = [(dl, kwh)]
            straks = lav_plan(pm, start, b, effekt, "straks")
            bedst = lav_plan(pm, start, b, effekt, "billigst")
            facit = lav_plan(pa, start, b, effekt, "billigst")
            forv = pris_for_plan(straks, pm) - pris_for_plan(bedst, pm)
            venter = forv >= min_bes
            raekker[h].append((pris_for_plan(straks, pa),
                               pris_for_plan(bedst if venter else straks, pa),
                               pris_for_plan(facit, pa), venter))

    print(f"\nKroner-backtest: {kwh:g} kWh skal være klar kl. {klar}, beslutning kl. {beslut_tid}, "
          f"hver dag de seneste {dage} dage.")
    print(f"Anbefalingen følger planen kun, hvis forventet besparelse er mindst {min_bes:g} kr.")
    print(f"{'Klar om':<10}{'Dage':>5}{'Straks':>9}{'Råd':>9}{'Perfekt':>9}{'Spar':>8}{'Af mulig':>10}"
          f"{'Ventede':>9}{'Dyrere':>8}")
    for h, rs in raekker.items():
        navn = f"{h} dag" if h == 1 else f"{h} dage"
        if not rs:
            print(f"{navn:<10}{0:>5}  (ingen dage kunne simuleres)")
            continue
        tal = np.array([r[:3] for r in rs])
        s, r_, p = tal.sum(axis=0)
        mulig = s - p
        andel = f"{(s - r_) / mulig:.0%}" if mulig > 1e-9 else "-"
        venter = sum(r[3] for r in rs)
        dyrere = int(np.sum(tal[:, 1] > tal[:, 0] + 1e-9))
        print(f"{navn:<10}{len(rs):>5}{s:>9.0f}{r_:>9.0f}{p:>9.0f}{s - r_:>8.0f}{andel:>10}"
              f"{venter:>9}{dyrere:>8}")
    print("Kolonner: kr samlet over perioden. Straks = lad med det samme. Råd = følg modellen. "
          "Perfekt = kender facit (øvre grænse).")
    print("Spar = Straks - Råd. Af mulig = andel af den mulige besparelse, modellen fanger. "
          "Ventede = dage hvor rådet var at vente. Dyrere = dage hvor rådet blev dyrere end straks.")
    print("OBS: Testen bruger det faktiske vejr, ikke vejrprognoser, så den er lidt for optimistisk, "
          "især for 2-3 dage frem.")


# ----------------------------------------------------------------------------
# LADEPLAN
# ----------------------------------------------------------------------------
def samlet_pris(spot, tillaeg=None):
    if tillaeg is not None:  # rigtige tariffer fra Energi Data Service
        return (spot + tillaeg.reindex(spot.index)) * MOMS
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
EKSPORT_TIMER = 100   # timer frem fra nuværende hele time (4 dage + lidt luft)


def energinet_vektor(df, lokal):
    """Sum af Energinets systemtarif, nettarif og elafgift for hver time (kr/kWh ekskl. moms)."""
    total = np.zeros(len(lokal))
    for navn_, k in ENERGINET_KODER.items():
        e = df[df["ChargeTypeCode"] == k]
        if (e["GLN_Number"] == ENERGINET_GLN).any():
            e = e[e["GLN_Number"] == ENERGINET_GLN]
        v = pris_paa(e, lokal)[0] if len(e) else np.full(len(lokal), np.nan)
        if np.isnan(v).any():
            print(f"Advarsel: {navn_} mangler for nogle timer, bruger reserveværdi {RESERVE[navn_]:.3f}.")
            v = np.where(np.isnan(v), RESERVE[navn_], v)
        total += v
    return total


def afrund(arr, nd=4):
    return [None if pd.isna(v) else round(float(v), nd) for v in arr]


def byg_prognose(df, X, halvering, kalibrer, start, timer):
    """Prognose pr. time fra `start` (UTC). Kendte priser erstatter prognosen."""
    y = df["pris"]
    kendt_y = y.notna()
    korr = None
    if kalibrer:
        calstart = y.dropna().index.max() - pd.Timedelta(days=KALIBRERING_DAGE)
        tr1 = kendt_y & (X.index < calstart)
        cal = kendt_y & (X.index >= calstart)
        m1 = traen(X[tr1], y[tr1], vaegte(X.index[tr1.to_numpy()], halvering))
        korr = kalibrering(m1, X[cal], y[cal])
    modeller = traen(X[kendt_y], y[kendt_y], vaegte(X.index[kendt_y.to_numpy()], halvering))
    idx = pd.date_range(start, periods=timer, freq="h")
    Xf = X.reindex(idx)
    pred = forudsig(modeller, Xf)
    if korr:
        pred = anvend_kalibrering(pred, korr)
    kendt = y.reindex(idx)
    er = kendt.notna()
    for k in ("lav", "median", "hoej"):
        pred.loc[er, k] = kendt[er]
    pred["kendt"] = er.astype(int)
    return pred, korr, y


def eksport(mappe, refresh, halvering, kalibrer):
    """Skriver prognose.json og tariffer.json, som webappen læser."""
    global OMRAADE
    mappe = Path(mappe)
    mappe.mkdir(parents=True, exist_ok=True)
    nu = pd.Timestamp.now(tz="UTC")
    start = nu.floor("h")
    genereret = nu.strftime("%Y-%m-%dT%H:%M:%SZ")
    fra = start.strftime("%Y-%m-%dT%H:%M:%SZ")

    vejr = hent_vejr(refresh)
    omraader = {}
    for omr in ("DK1", "DK2"):
        OMRAADE = omr
        print(f"\n=== Prognose for {omr} ===")
        priser = hent_priser(refresh)
        df, X = lav_features(vejr.join(priser.rename("pris"), how="outer"))
        pred, korr, y = byg_prognose(df, X, halvering, kalibrer, start, EKSPORT_TIMER)
        hidx = pd.date_range(start - pd.Timedelta(days=21), start - pd.Timedelta(hours=1), freq="h")
        hist = y.reindex(hidx)
        omraader[omr] = {
            "lav": afrund(pred["lav"]), "median": afrund(pred["median"]), "hoej": afrund(pred["hoej"]),
            "kendt": [int(v) for v in pred["kendt"]],
            "hist_fra": hidx[0].strftime("%Y-%m-%dT%H:%M:%SZ"), "hist": afrund(hist),
            "kalibrering": {k: round(v, 4) for k, v in korr.items()} if korr else None,
        }
    prog = {"version": 1, "demo": False, "genereret": genereret, "fra": fra, "timer": EKSPORT_TIMER,
            "enhed": "kr/kWh, spotpris uden tariffer, afgifter og moms", "omraader": omraader}
    (mappe / "prognose.json").write_text(json.dumps(prog, separators=(",", ":")), encoding="utf-8")

    print("\n=== Tariffer ===")
    tdf = hent_tariffer(refresh)
    idx = pd.date_range(start, periods=EKSPORT_TIMER, freq="h")
    lokal = idx.tz_convert(TZ).tz_localize(None)
    net, sprunget = [], []
    for ejer in netselskaber(tdf):
        rk = vaelg_nettarif_raekker(tdf, ejer, None)
        v, brugte = pris_paa(rk, lokal) if len(rk) else (np.full(len(lokal), np.nan), set())
        if np.isnan(v).any() or float(np.nanmax(v)) < 0.02:
            sprunget.append(ejer)
            continue
        kode, note = sorted(brugte)[0] if brugte else ("", "")
        net.append({"navn": ejer, "kode": kode, "note": note, "pris": afrund(v)})
    if sprunget:
        print("Sprunget over (ingen brugbar nettarif fundet): " + "; ".join(sprunget))
    tar = {"version": 1, "demo": False, "genereret": genereret, "fra": fra, "timer": EKSPORT_TIMER,
           "enhed": "kr/kWh ekskl. moms", "energinet": afrund(energinet_vektor(tdf, lokal)),
           "netselskaber": net}
    (mappe / "tariffer.json").write_text(json.dumps(tar, separators=(",", ":")), encoding="utf-8")
    print(f"Skrev {len(net)} netselskaber og prognose for DK1 og DK2 til {mappe}/")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eksport", metavar="MAPPE",
                    help="skriv prognose.json og tariffer.json (til webappen) og afslut")
    ap.add_argument("--behov", action="append",
                    help='"YYYY-MM-DD HH:MM=kWh", fx "2026-11-23 07:00=25". Kan gentages.')
    ap.add_argument("--netselskaber", action="store_true",
                    help="vis liste over netselskaber (og afslut)")
    ap.add_argument("--netselskab", help="navn (eller del af navn) eller nummer fra listen")
    ap.add_argument("--vis-tariffer", action="store_true",
                    help="vis netselskabets tariffer til kontrol (kræver --netselskab)")
    ap.add_argument("--tarifkode", help="vælg en bestemt nettarif-kode (se --vis-tariffer)")
    ap.add_argument("--tillaeg", type=float, default=0.0,
                    help="leverandørens tillæg i kr/kWh ekskl. moms (default 0)")
    ap.add_argument("--effekt", type=float, default=11.0)
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--backtest", action="store_true")
    ap.add_argument("--sammenlign", action="store_true",
                    help="backtest med forskellige vægtninger af nyere data")
    ap.add_argument("--halvering", type=float, default=HALVERING_DAGE,
                    help="halveringstid i dage for datavægt (0 = ens vægt)")
    ap.add_argument("--ingen-kalibrering", action="store_true")
    ap.add_argument("--min-besparelse", type=float, default=MIN_BESPARELSE_KR,
                    help="mindste forventede besparelse (kr) før der anbefales at vente")
    ap.add_argument("--backtest-dage", type=int, default=60, help="antal dage i backtest")
    ap.add_argument("--kroner-backtest", action="store_true",
                    help="simulér dit ladebehov hver dag og se besparelsen i kroner")
    ap.add_argument("--sim-kwh", type=float, default=25.0, help="kWh der skal lades pr. behov")
    ap.add_argument("--sim-klar", default="07:00", help="klar-tidspunkt, fx 07:00")
    ap.add_argument("--sim-tid", default="22:00", help="tidspunkt du beslutter dig, fx 22:00")
    ap.add_argument("--sim-dage", default="1,2,3",
                    help="hvor mange dage frem klar-tidspunktet ligger, fx 1,2,3")
    a = ap.parse_args()

    if a.eksport:
        eksport(a.eksport, a.refresh, a.halvering, not a.ingen_kalibrering)
        return

    if a.netselskaber or a.vis_tariffer:
        tarif_df = hent_tariffer(a.refresh)
        if a.netselskaber:
            print("\nNetselskaber (brug navn eller nummer med --netselskab):")
            for i, n in enumerate(netselskaber(tarif_df), 1):
                print(f"  {i:>2}. {n}")
        if a.vis_tariffer:
            if not a.netselskab:
                ap.error("--vis-tariffer kræver --netselskab")
            vis_tariffer(tarif_df, a.netselskab)
        return
    if not a.behov and not a.kroner_backtest:
        ap.error("--behov mangler (fx --behov \"2026-11-23 07:00=25\")")

    behov = []
    for b in (a.behov or []):
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
        sammenlign(df, X, dage=a.backtest_dage)
    if a.backtest:
        backtest(df, X, dage=a.backtest_dage, halvering=a.halvering, kalibrer=kalibrer)
    if a.kroner_backtest:
        tarif_df = hent_tariffer(a.refresh) if a.netselskab else None
        fn = ((lambda idx: lav_tillaeg(tarif_df, a.netselskab, idx, a.tarifkode, a.tillaeg))
              if a.netselskab else None)
        kroner_backtest(df, X, fn, a.backtest_dage, a.halvering, kalibrer, a.sim_kwh, a.effekt,
                        a.sim_klar, a.sim_tid, [int(v) for v in a.sim_dage.split(",")], a.min_besparelse)
        if not behov:
            return

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

    tillaeg = None
    if a.netselskab:
        tillaeg = lav_tillaeg(hent_tariffer(a.refresh), a.netselskab, pred.index, a.tarifkode, a.tillaeg)
    tot = {k: samlet_pris(pred[k], tillaeg) for k in ("lav", "median", "hoej")}
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
    forste_txt = forste.tz_convert(TZ).strftime("%a %d/%m kl. %H:%M")
    if forste == start:
        print("\nAnbefaling: START NU - planen starter allerede i næste hele time.")
    elif besparelse < 0.5:
        print("\nAnbefaling: LAD NU (ingen gevinst ved at vente).")
    elif besparelse < a.min_besparelse:
        print(f"\nAnbefaling: MARGINAL GEVINST. Du kan spare ca. {besparelse:.1f} kr ved at starte "
              f"{forste_txt}, hvis du kan bruge en timer. Ellers: lad nu.")
    else:
        print(f"\nAnbefaling: VENT. Første ladetime er {forste.tz_convert(TZ).strftime('%a %d/%m kl. %H:%M')}.")

    print("\nLadeplan (timer med opladning):")
    print(f"{'Tid':<16}{'kWh':>6}{'kr/kWh':>9}  Kilde")
    for ts in plan_bedst[plan_bedst > 0].index:
        print(f"{ts.tz_convert(TZ).strftime('%a %d/%m %H:%M'):<16}{plan_bedst[ts]:>6.1f}"
              f"{tot['median'][ts]:>9.2f}  {pred.loc[ts, 'kilde']}")
    if tillaeg is None:
        print("\nHusk: tariffer/afgifter er PLACEHOLDERS. Vælg dit netselskab med --netselskaber / --netselskab.")
    else:
        print("\nTariffer er hentet fra Energi Data Service. Tjek dem mod din faktura med --vis-tariffer.")


if __name__ == "__main__":
    main()
