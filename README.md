# FitMatch – Chrome extension (MVP)

Finder din rigtige tøjstørrelse ved at læse produktsidens størrelsestabel og
sammenligne med dine egne mål. Mindre returneringer for butikken, rigtigt valg
for kunden.

## Sådan installerer du den (load unpacked)

1. Åbn Chrome → `chrome://extensions`
2. Slå **Developer mode** til (øverst til højre)
3. Klik **Load unpacked** og vælg denne mappe (`fitmatch/`)
4. Klik på FitMatch-ikonet i værktøjslinjen
5. Gå til **Min profil**, udfyld dine mål, tryk **Gem profil**
6. Åbn en produktside (fx Zalando, ASOS, H&M, Uniqlo) → tryk **Analysér denne side**

## Hvordan det virker

```
Produktside ─▶ scrape.js (læser tabel + model-info i DOM)
                     │
                     ▼
              engine.js (matcher dine mål → størrelse + sikkerhed)
                     │
                     ▼
              popup.js (viser anbefaling + pasform-barer)
```

- **`scrape.js`** kører i sidens kontekst. Finder størrelsestabeller (begge
  orienteringer, flere sprog), gætter tøjtype, og fanger "model er 180 cm / bruger M".
  Hvis ingen tabel findes, bruges en generisk standardtabel (markeret lav sikkerhed).
- **`engine.js`** er ren matematik (ingen DOM) — kan genbruges i en backend.
  Vælger størrelse ud fra dit primære mål + ønsket pasform, og giver en
  sikkerhedsscore baseret på datakvalitet.
- **`background.js`** er hvor den rigtige Claude-AI kobles på til de svære sider
  (kun model-info, ingen tabel). Se nedenfor.

## AI-backend (til ASOS/Zalando m.fl.)

Sider som ASOS og Zalando har ingen mål-tabel på produktsiden. Her sender
extensionen produktets billeder + tekst + model/fit til en serverless-funktion,
hvor Claude (multimodal) estimerer målene. Læg ALDRIG en Anthropic-nøgle i
selve extensionen — kun som env-variabel i backend'en.

### Deploy på Netlify

```bash
# i repoets rod
npm install @anthropic-ai/sdk      # tilføjer SDK'en til package.json
```

1. Push repoet til GitHub.
2. Netlify → **Add new site → Import from Git** → vælg repoet.
3. Netlify læser `netlify.toml` automatisk (functions-mappe + publish).
4. Site settings → **Environment variables** → tilføj `ANTHROPIC_API_KEY`.
5. Deploy. Funktionen ligger nu på
   `https://<dit-site>.netlify.app/.netlify/functions/estimate`.
6. I FitMatch → **Min profil → AI-analyse (avanceret)** → indsæt URL'en → Gem.

Filer: funktionen i [`netlify/functions/estimate.js`](netlify/functions/estimate.js),
config i [`netlify.toml`](netlify.toml).

## Roadmap

- [x] Visuel pasform pr. kropszone (skala med markør + faktiske mål)
- [x] Inches/tommer-understøttelse + automatisk enheds-detektion
- [x] Numeriske størrelsessystemer (EU 38, W32, 32/34, 8/10)
- [x] Køn-bevidst generisk fallback-tabel
- [ ] AI-fallback live (backend + Claude)
- [ ] Brand-specifikke adaptere (Zalando/ASOS har stabile DOM-strukturer)
- [ ] Cache af tolkede produkter (hurtigere + billigere)
- [ ] Login + sky-sync af profil på tværs af enheder
- [ ] 3D-avatar (v2)
- [ ] Indsaml (anonymt) hvad folk faktisk beholdt → forbedr modellen
