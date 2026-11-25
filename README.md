# Elbil-lader

Find de billigste timer at lade din elbil, op til 4 dage frem. Appen siger, om du skal lade nu eller vente, og hvor meget du sparer.

Den består af to dele:

1. **`elbil_lader.py`** henter spotpriser (Energi Data Service) og vejr (Open-Meteo), træner en prognosemodel og regner ladeplaner. Kan bruges direkte fra terminalen.
2. **`docs/`** er en webapp (PWA) uden server og uden build-trin. Den læser to JSON-filer og regner ladeplanen i telefonen.

```
GitHub Action (3 gange i døgnet)
   └─ python elbil_lader.py --eksport docs/data
        ├─ docs/data/prognose.json   spotpris pr. time for DK1 og DK2, 100 timer frem
        └─ docs/data/tariffer.json   nettarif pr. time for hvert netselskab + Energinet og elafgift
GitHub Pages serverer docs/
   └─ appen henter de to filer og regner ladeplanen lokalt
```

Prognosen er den samme for alle i samme prisområde, og tariffer ligger i filen for alle netselskaber. Derfor skalerer det til mange brugere uden en server. Indstillinger og gemte ladninger ligger kun i brugerens egen browser (localStorage).

## Sæt det op

1. **Slå GitHub Pages til:** Settings → Pages → *Build and deployment*: Source = *Deploy from a branch*, Branch = `main`, mappe = `/docs`. Appen ligger så på `https://<brugernavn>.github.io/<repo>/`.
2. **Kør opdateringen første gang:** Actions → *Opdater prognose og tariffer* → *Run workflow*. Det tager et par minutter. Derefter kører den automatisk. Indtil da viser appen eksempeldata og et gult banner.
3. **Åbn appen på telefonen** og vælg *Føj til startskærm* i browserens menu.

Hvis workflowen fejler med 429 fra Energi Data Service, er det en midlertidig grænse hos dem. Scriptet venter og prøver igen. Kør den igen senere, hvis det ikke lykkes.

## Brug scriptet fra terminalen

```
pip install -r requirements.txt
python elbil_lader.py --netselskaber                       # liste over netselskaber
python elbil_lader.py --netselskab "Cerius" --vis-tariffer  # tjek tariffer mod din regning
python elbil_lader.py --behov "2026-11-26 07:00=40" --netselskab "Cerius" --tillaeg 0.05
python elbil_lader.py --backtest --sammenlign               # hvor god er prognosen?
python elbil_lader.py --kroner-backtest --netselskab "Cerius" --sim-kwh 25
python elbil_lader.py --eksport docs/data                   # skriv filerne til appen
```

## Kør appen lokalt

```
cd docs
python -m http.server 8000
```

Åbn `http://localhost:8000`. De medfølgende filer i `docs/data/` er eksempeldata (`"demo": true`), som appen flytter, så de altid starter nu.

## Det skal du vide

- **Prognosen er et skøn.** Kun priserne for i dag og i morgen er endelige. Resten er en model med et usikkerhedsinterval. Vurder selv modellen med `--backtest`.
- **Besparelsen i appen er beregnet, ikke målt.** Den sammenligner dine valgte timer med at lade med det samme, med timepriser. Den læser ikke din bil eller måler.
- **Tariffer vælges automatisk** som den almindelige "Nettarif C" hos dit netselskab. Netselskaber navngiver forskelligt, så tjek mod din regning. Netselskaber uden en tydelig forbrugstarif er sprunget over.
- **Leverandørens tillæg** står ikke i de åbne data. Det skal du selv skrive ind under Indstillinger.
- Appen sender ikke notifikationer. Sæt bilens eller laderens timer efter anbefalingen.

Kilder: [Energi Data Service](https://www.energidataservice.dk) og [Open-Meteo](https://open-meteo.com).
