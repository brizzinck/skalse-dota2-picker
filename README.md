# Counter Picker — Dota 2

A Dota 2 counter picker with position-aware suggestions and item builds, based on
[Dotabuff](https://www.dotabuff.com) statistics (with [OpenDota](https://www.opendota.com) as a live fallback).
A modern rewrite of [mnmistake/DotaBuffCP](https://github.com/mnmistake/DotaBuffCP).

**Live site:** https://brizzinck.github.io/dota-analysis/ — Ukrainian by default, Russian and English selectable.
No server needed: it is a static site, you can also just open `index.html`.

## Features

### Draft
- 5 enemies, 5 allies, bans. Allies and bans are never suggested.
- Hero grid grouped by attribute, as in the game client. Once enemies are picked, every portrait shows its total
  advantage (green border — good pick, red — bad).
- Fast search with aliases (`am`, `qop`, `sf`, `wk`, `kotl`…). Type anywhere: `Enter` → enemies,
  `Shift/Alt+Enter` → your team, `Ctrl+Enter` → ban, `Backspace` in an empty search removes the last enemy.
- Left click → enemies, right click → your team, `Shift`+click → ban. Every removal / clear / reset can be undone
  from the notification.
- While picking enemies the grid stays neutral; in "your team" mode it shows each hero's advantage. The mode switches
  to your team once 5 enemies are picked, and holding `Alt` turns it on temporarily.
- Shareable draft links: `#e=pudge,antimage&a=axe.3,lion.5&b=invoker` (`hero.position` for manually set positions).
  Links of the original DotaBuffCP (`#Pudge/Axe`) still work.

### Positions
- Every hero of both teams has a **1–5** position switch. Positions are assigned automatically from Dotabuff lane data
  (lane share + GPM: on the same lane a core farms far more than a support); a click fixes a position.
- **Picking for**:
  - *Any* (default) — pure counter-pick against the chosen enemies;
  - *1–5* — only heroes that actually play the position (≥10% of their games). Score = counter-pick +
    0.5 × (hero win rate on the position − 50%): counter-picks matter more, the meta tips the balance. The meta weight
    grows with how often the hero plays the position, so rare off-role picks are not inflated. Your lane opponents
    weigh ×1.5. Each hero shows a "counter · meta · WR on position" breakdown;
  - a position without enemies shows that position's meta in the current patch.

### Item builds
For every hero of your team — what to buy and by which minute:
- **Timeline** (laning / until 20' / 20–30' / 30–40' / late game). Dotabuff gives patch-wide item statistics
  (millions of games per hero) but no per-position split; that split exists only in Dotabuff Guides (~20 recent
  top-player matches per hero). Therefore:
  - item popularity and win rate always come from the whole patch;
  - with ≥10 guide matches on the position, items and timings come from those matches;
  - otherwise the patch statistics are filtered by position rules (`ITEM_POS` in `knowledge.js`); items top players
    bought on that position in at least 3 matches are always included; timings come from the guides where available,
    otherwise from OpenDota or a GPM estimate (marked `≈`).
- **Against this team**: counter-items for the actual enemy draft (illusions → Mjollnir/BFury, invisibility →
  Dust/Sentry, evasion → MKB, targeted ultimates → Linken/Lotus, healing → Vessel/Shiva…) with the reason and the enemy
  icons. Attack items are suggested only to heroes who build them. The best two go into the timeline (⚑).
- **Team items** (Vessel, Pipe, Crimson, Mekansm, Greaves, Lotus, Gem…) are suggested to one ally — whoever builds it
  as a core item, otherwise the best-fitting position.

## Data

| Source | What | How it is refreshed |
|---|---|---|
| **Stratz** (default) | per-position hero share and win rate, matchups, item purchases per position with minutes — all ranked games of the current patch | `stratz.js`, collected by `scripts/stratz.mjs` in GitHub Actions every 6 hours (plain API requests, no browser) |
| **Dotabuff** | counters, lanes, item stats, guides for the current patch | `data.js`, collected by `scraper.js` in a real browser on a home PC |
| **OpenDota** | hero list and images, item constants, purchase timings; live counter fallback | fetched by the browser, cached for a day |

Every visit loads the latest data files (bypassing the cache). The source can be switched in the header; if the
selected data is older than 3 days, the site falls back to the next source by itself.

### Keeping the data fresh

- **Stratz — GitHub Actions** (`.github/workflows/update-data.yml`): every 6 hours, needs the repository secret
  `STRATZ` with a free token from https://stratz.com/api. Locally: put the token into `.stratz-token`
  (gitignored) and run `node scripts/stratz.mjs`.
- **Dotabuff — a home Windows PC**: Dotabuff is behind Cloudflare, which blocks browsers on GitHub's datacenter IPs
  (tested with Playwright and Patchright). `update-data.ps1 -Push` runs a headless Microsoft Edge on your machine,
  collects the data and pushes `data.js`. Schedule it every 6 hours and at log on:

  ```powershell
  powershell -ExecutionPolicy Bypass -File install-autoupdate.ps1          # install
  powershell -ExecutionPolicy Bypass -File install-autoupdate.ps1 -Remove  # remove
  ```

  The log is in `update.log`.
- **Manually**: “Update manually” in the site footer → copy the script → paste it into the console on dotabuff.com →
  drop the downloaded `data.js` onto the page.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | markup and styles |
| `app.js` | draft, positions, counter-pick suggestions, URL state |
| `builds.js` | item builds and timings |
| `knowledge.js` | hero threats, counter-items, position rules for items, team items |
| `i18n.js` | translations (uk / ru / en) |
| `scraper.js` | Dotabuff collector (runs inside a browser on dotabuff.com) |
| `scripts/update-data.mjs` | collector runner for CI (Node + Chrome) |
| `update-data.ps1`, `install-autoupdate.ps1` | collector runner and scheduler for Windows |
| `data.js` | collected Dotabuff data |

## License

MIT — see `COPYING`. Based on DotaBuffCP by Onur Aslan.
