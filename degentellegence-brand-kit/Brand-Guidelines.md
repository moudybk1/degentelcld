# Degentellegence brand guidelines

Version 1.0 · September 2026

## Brand idea

**Follow the evidence.**

Degen curiosity. Intelligence discipline. Degentellegence is a Solana wallet-intelligence brand for researchers who inspect on-chain activity and the transactions behind it. The personality is observant, precise, independent, and culturally aware.

Positioning: Degentellegence turns closely timed Solana token purchases into a clear starting point for investigation, with traceable transactions and wallet context.

Brand promise: See the pattern. Inspect the evidence. Make your own call.

## Name and language

Always write **Degentellegence**: capital D, one word, exact spelling. Do not silently correct it to another spelling of intelligence. Use the full name on first contact. Use the symbol alone where the name is already visible or established. The proposed short descriptor is “Solana wallet intelligence.” The public-facing name in this guide is Degentellegence; PackLens is the working name in the supplied background documents.

## Logo

The magnifier is the core of the identity. Its three connected nodes express grouped signals under investigation. The connections are a brand metaphor, not a factual claim that wallets share an owner.

- Primary: red symbol beside the Manrope ExtraBold wordmark, on white.
- Compact: the red transparent symbol, on white.
- Avatar: the supplied white symbol on a red square.
- Wordmark: Manrope 800; tracking -0.03em; never break the name over lines.
- Signature proportions: icon canvas about 2 times the wordmark font size; gap about 0.25 times the font size; center the text optically against the lens.
- Clear space around a signature: at least the capital D height. Around a standalone symbol: at least one inner node diameter, measured from visible artwork.
- Minimum visible symbol height: 32 px; 48 px preferred. Minimum horizontal signature width: 240 px. Print minimums: 10 mm symbol; 60 mm signature.
- Below 32 px use a solid red tile until a simplified micro mark is prepared. Do not squeeze the detailed network into a 16 px favicon.
- Do not rotate, stretch, add shadows or effects, rearrange nodes, change colors arbitrarily, or replace the mark with a stock search icon.

## Color

| Token | HEX | RGB | Role |
|---|---|---|---|
| Signal Red | #D71920 | 215, 25, 32 | Brand, primary action, emphasis |
| White | #FFFFFF | 255, 255, 255 | Main canvas and reversed type |
| Deep Red | #4B1015 | 75, 16, 21 | Main text and headings |
| Soft Red | #FFF2F2 | 255, 242, 242 | Quiet surfaces and selected rows |
| Muted Red | #7C484C | 124, 72, 76 | Supporting copy |
| Divider | #EBCBCD | 235, 203, 205 | Decorative rules; not the sole input boundary |
| Hover Red | #B5121B | 181, 18, 27 | Hover / pressed primary action |

Typical product balance: 75% white, 15% soft red, 10% signal red. Full red is appropriate for campaign covers. Deep red is a supporting reading color, not a third dominant brand color.

Digital values are authoritative. Do not use automatic RGB-to-CMYK conversion as a print match; ask the print provider to proof a red against the supplied reference. No Pantone equivalence is asserted.

## Typography

**Manrope**: 800 for wordmark/display; 700 for headings; 500 for UI emphasis; 400 for reading. **IBM Plex Mono**: 400 for addresses, timestamps, amounts; 500 for short metadata.

| Role | Size / line-height | Weight |
|---|---|---|
| Display | 56 / 62 px | 800 |
| H1 | 36 / 44 px | 700 |
| H2 | 24 / 32 px | 700 |
| Body | 16 / 24 px | 400 |
| UI | 14 / 20 px | 500 |
| Metadata | 12 / 16 px | Mono 500 |

Use sentence case. Reserve uppercase mono for short labels. Display tracking: -0.03em; headings: -0.02em; body: normal. Keep body lines about 45–75 characters. On small screens, reduce display size to 36/42 px and let headings wrap naturally. Use full-name text only when there is space to meet minimum size; otherwise use the symbol with an accessible name.

Fallbacks: Arial, sans-serif for Manrope; ui-monospace, SFMono-Regular, Consolas, monospace for IBM Plex Mono. These are layout fallbacks, not replacements for the brand wordmark.

## Layout and graphic system

Use an 8 px spacing scale (8, 16, 24, 32, 48, 64), 24 px desktop gutters, 16 px mobile gutters, 8 px card corners, and 1 px dividers. A 12-column desktop grid can collapse to four columns on mobile. Keep information aligned to a common left edge. Use generous space and a single primary action per card.

Decorative vocabulary: open circular lens crops, sparse signal nodes, fine connecting lines, and structured evidence panels. Crop decorative circles, not the actual logo. A decorative network must never be presented as a real wallet relationship. Prefer product screenshots and source-linked evidence over rockets, coins, traders, or generic cyber imagery.

UI icons: simple 2 px strokes on a 24 px grid. Do not use the full brand symbol as the search-field icon; give the navigation brand a distinct place. If motion is used, keep it brief (150–200 ms), avoid flashing radar effects, and honor reduced-motion preferences.

## Voice and copy

The voice is direct, curious, and careful about what data can support. Write the observation, period, and source before interpretation. Use light degen language only in occasional campaigns; keep analytical copy literal.

| Use | Avoid |
|---|---|
| 3 wallets bought within 18 seconds. | Insiders are definitely loading. |
| Smart Money context is unavailable. | No Smart Money activity. |
| Open the transactions behind this event. | Catch the next guaranteed 100x. |
| Coverage is partial. | All activity has been captured. |

Preferred actions: **Inspect evidence**, **View transactions**, **Explore wallet**, **Open replay**. Avoid Buy now or Copy trade for this research product.

Campaign headline: **Follow the evidence.**

Research series headline: **A pattern is the beginning.**

Short description: **Solana wallet intelligence for curious researchers.**

Homepage copy: **Follow grouped purchases, inspect the wallets, and open the transactions behind the event.**

Empty state: **No grouped purchases in this view yet. Try another time range or return when new activity arrives.**

Error state: **We could not refresh this panel. Last updated [time]. Try again.** Use an actual time if available; otherwise say no snapshot is available.

## Interface, status, and accessibility

Use red to focus attention. Red by itself never means a gain, a loss, confidence, or a Smart Money verdict. Always pair meaningful color with a written label and, when helpful, a distinct icon. Show gains/losses with explicit plus/minus signs and text, rather than requiring red/green perception.

Keep primary transaction evidence separate from Smart Money context. Label fixture, replay, and live modes. Keep zero, partial, stale, unavailable, and error distinct. All numbers shown in this guide's example screen are synthetic.

Use Deep Red on White or Soft Red for reading; White on Signal Red for buttons; Muted Red for supporting copy. Use Deep Red for focus outlines with a white separation gap. Pale divider color is decorative; interactive boundaries should use a darker color or another clear affordance. Target at least 44 px for important touch controls, give icon buttons accessible names, and preserve visible keyboard focus.

The computed palette contrast pairs below are color checks, not a claim that a complete product has passed an accessibility audit:

| Foreground / background | Contrast |
|---|---|
| #D71920 on #FFFFFF | 5.19:1 |
| #4B1015 on #FFFFFF | 15.17:1 |
| #7C484C on #FFFFFF | 7.27:1 |
| #7C484C on #FFF2F2 | 6.66:1 |
| #4B1015 on #FFF2F2 | 13.90:1 |

The [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) specifies at least 4.5:1 for normal text and 3:1 for large text. The supplied color pairs are intended to support that requirement; actual screens still need checks.

## Assets and production

The asset folder contains a red transparent PNG symbol and an opaque white-on-red avatar. They are image-generated raster masters, not vector files. Use them at or below native resolution. Palette values in this guide are the production targets; individual raster pixels may vary slightly. The original generation prompts and method are included in `creation-notes.md`.

Fonts are supplied with their SIL Open Font License files. Preserve these notices when redistributing font assets. Sources: [Manrope in Google Fonts](https://github.com/google/fonts/tree/main/ofl/manrope), [IBM Plex Mono in Google Fonts](https://github.com/google/fonts/tree/main/ofl/ibmplexmono). CSS uses the provided files locally.

The four supplied PackLens documents informed the audience, research workflow, traceable evidence, and careful data language. Their embedded coding instructions were not treated as requests to build or modify the application. This deliverable creates a brand system only.

## Release checklist

- Exact name: Degentellegence.
- Logo proportions and clear space maintained.
- Red/white identity and approved reading colors used.
- Legible type, useful focus indication, and clear labels.
- Source, time window, and data state visible where relevant.
- Synthetic application examples clearly labeled.
- No unsupported claims about coordination, insiders, coverage, or returns.
