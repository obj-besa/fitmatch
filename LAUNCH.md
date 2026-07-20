# Launch kit — copy/paste texts

Everything you need for the Chrome Web Store submission and the Skimlinks
application. Copy straight from here.

---

## 1. Chrome Web Store listing

**Category:** Shopping
**Language:** English (the listing name/description auto-translate via `_locales`)

### Short description (max 132 chars — already set in `_locales/en/messages.json`)
```
Get an AI size recommendation on any webshop, based on your own measurements. Fewer returns, less guessing.
```

### Detailed description
```
Stop guessing your size.

FitMatch reads the product page you're already on, compares the garment against
your own body measurements, and tells you which size to pick — with an honest
confidence score so you know how much to trust it.

HOW IT WORKS
FitMatch uses the most reliable source available, in this order:

1. The store's own size chart. If the page lists real measurements, they're
   matched exactly against your body. Highest confidence.

2. AI estimate. Many shops publish no measurements at all. FitMatch then reads
   the product photos and the model reference ("model is 181 cm and wears M")
   and works out how the garment will actually sit on you. Estimated numbers are
   clearly marked as estimates — never presented as fact.

3. Generic chart. If nothing readable exists, it falls back to a standard chart
   and tells you plainly that it's only a rough guide.

WHAT MAKES IT DIFFERENT
• Anchored to the model — it reasons from the model's height and size and how
  the garment drapes in the photos, instead of inventing numbers.
• Fit shown per body zone — see how it sits on chest, shoulders, waist and hips.
• You vs the model — compare your measurements directly against the model's.
• Honest about uncertainty — every result carries a confidence score.
• Consistent — the same garment always gives the same answer.
• Fit preference — tell it whether you like things tighter or roomier, and it
  only changes size when your measurements actually allow it.

YOUR PRIVACY
Your measurements are stored locally in your browser. There are no accounts, no
sign-up, no advertising, and nothing is sold. FitMatch only reads a page when you
click the button — it never runs in the background.

Available in English, Danish, German, French and Spanish.

Affiliate disclosure: FitMatch may earn a commission if you choose to click a
link to a retailer from the extension. This never affects the size recommended.

Privacy policy: https://findfitmatch.netlify.app/privacy.html
```

### Screenshots to take (1280×800, need at least 1, ideally 4)
1. The result card on a real product page — recommendation + confidence + fit bars
2. The "You vs the model" comparison
3. The profile tab with measurements filled in
4. The "How it works" overlay (shows the priority order)

---

## 2. Permissions justification (Chrome asks for this in review)

**`storage`**
> Used to save the user's body measurements, fit preference and language locally
> in their own browser, so they don't have to re-enter them. Nothing is sent to a
> server for storage.

**`activeTab`**
> Used to read the product page the user is currently viewing, and only at the
> moment they click the extension and press "Analyse". The extension never reads
> pages in the background or without an explicit user action.

**`scripting`**
> Used to run a single reader script in the active tab that extracts the
> garment's size information (size charts, model reference, product images) so a
> size can be recommended. It only reads; it never modifies the page or performs
> actions on the user's behalf.

**Host permission `https://findfitmatch.netlify.app/*`**
> Our own backend. When a page has no readable size chart, the product's text and
> image links are sent here so an AI model can estimate the fit. This is the only
> external host the extension contacts.

**Remote code**
> No remote code is used. All logic ships inside the extension package.

**Data usage disclosures — tick these:**
- Personally identifiable information: **No**
- Health information: **No** (body measurements are used solely for sizing and
  are stored locally — declare "User activity: No", "Website content: Yes")
- Website content: **Yes** — product page text and image links are sent to our
  backend to generate the size assessment.
- Confirm: not sold to third parties, not used for unrelated purposes, not used
  for creditworthiness/lending.

---

## 3. Skimlinks application

**Site domain:** `findfitmatch.netlify.app`
**Site type:** AI Agent/App

### Additional information
```
FitMatch is an AI-powered Chrome extension that helps shoppers choose the correct
clothing size. It reads a product page, compares the garment's measurements
against the user's own saved body measurements, and shows a recommended size with
a confidence score.

After seeing the recommendation, the user can click a clearly labelled "Go to
your size" link that takes them to the product. There is no automatic redirect,
and no reward or incentive for clicking — the link is offered purely as a
convenience. The affiliate relationship is disclosed both in the extension's
interface and on our website.

Could you confirm that a browser extension is an accepted property type, and that
this flow — a user-initiated click on a clearly labelled link, with no incentive
and no auto-redirect — complies with your program policies?
```

**Get the answer in writing before building on the affiliate model.**
If Skimlinks declines, the next option to try is Sovrn Commerce.
