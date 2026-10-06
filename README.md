# Clubs Deuce Mugger

A members-only mug finder for Torn. Plain HTML, CSS and JavaScript in `public/`, one Cloudflare Worker in
`src/`, a D1 database, and no build step. Setup and deploy steps for the Cloudflare dashboard are in
[`SETUP.md`](SETUP.md).

## Where things are

```
wrangler.jsonc          Worker config: name, bindings (D1, email), public variables
migrations/             Database changes, applied in order (0001, 0002, ...). Never edit an old one.

src/                    THE SERVER (Cloudflare Worker, ES modules)
  index.js              Entry point and the route table: every /api URL is listed here
  config.js             Constants: limits, formats, outside service addresses
  lib/                  Shared helpers
    http.js             json(), errors, security headers
    crypto.js           password hashing, tokens, encrypted key storage
    auth.js             sessions, current user, owner check
    ratelimit.js        per-IP and per-member limits (stored in D1)
    mail.js             email sending
    upstream.js         calls to Torn and other outside services
    db.js               small database helpers and cleanup of expired rows
  routes/               One file per area
    auth.js             sign up (invite + name your inviter), sign in, password recovery
    account.js          profile, email change, optional saved API key (locked with the member's password)
    invites.js          make, list and close invite links
    admin.js            owner-only account list and actions
    proxies.js          Weav3r, Torn (profiles, companies) and FF Scouter pass-throughs
    leaderboard.js      Attack-tap log, mug verification against Torn, rankings

public/                 THE WEBSITE (served as is)
  index.html            Sign in / apply          recover.html, reset.html   password recovery
  css/style.css         The only stylesheet, in labelled sections
  js/core/              Helpers shared by every page (api, dom, format, storage, async)
  js/pages/             Scripts for the public pages
  app/                  Signed-in pages (the Worker only serves these to members)
    index.html          Mug Finder (bazaars)    earners.html   Inactive Earners    bonus.html   Bonus Weapon Sellers    settings.html   Settings    leaderboard.html   Leaderboard
    js/state.js         The shared state of the Mug Finder and its defaults
    js/features/        One file per feature (see below)
    js/earners/         The Inactive Earners tab: state, scan, cards, filters, cache (see below)
    js/bonus/           The Bonus Weapon Sellers tab (see below)
    js/settings/        One file per Settings section
    js/pages/           The script each app page loads (main, settings, leaderboard)
  img/sprite.svg        Pixel suit and symbol art (original)
  fonts/                Fontstuck font and its license (CC BY-SA 3.0, keep the credit in the footers)
  icons/, manifest.webmanifest, apple-touch-icon.png   Home screen app

tests/                  Automated checks (see Tests)
```

### Mug Finder features (`public/app/js/features/`)

| File | Job |
| --- | --- |
| `scan.js` | One scan in stages: choose items, read bazaars (single items and stacks, grouped per seller, or added up to the minimum price), estimates, filter, status |
| `status-stage.js` | The Torn status and account age stage shared by the Inactive Earners and Bonus Weapon Sellers scans |
| `weav3r.js`, `torncall.js` | Shared readers: Weav3r with a "busy" gate (all reads wait together), and Torn calls under the 80 a minute limit |
| `rules.js` | Pure rules: what is a good mug, expected profit and the good/mediocre/bad rating (`mugOutlook`), why a listing was filtered out, sorting |
| `filters.js`, `watchlist.js` | The Hunt controls (3 basic, the rest under "More options") and the watchlist |
| `cards.js`, `results.js` | A result card, the results grid, the once-a-second tick |
| `feed.js`, `alerts.js` | The auto hunt mug feed and the jackpot banners |
| `status.js`, `refresh.js` | Torn status records, and the background re-check that keeps statuses on screen true between scans |
| `runner.js` | Scan, auto hunt and cancel buttons |
| `limits.js` | Keeps Torn calls under the per-minute limit |
| `tracking.js` | Logs Attack taps and checks for new mugs (leaderboard) |
| `admin.js` | The owner panel, built only for the owner |
| `ui.js` | Message line, progress bar stages, run buttons |

### Bonus Weapon Sellers tab (`public/app/js/bonus/`)

Weapons and armor with bonuses for sale in bazaars, by sellers inside your battle stat range. Source: Weav3r's
ranked weapons data, `GET https://weav3r.dev/api/ranked-weapons` (public JSON, no key; it is not formally documented,
its own error message lists the filters it takes: tab, weaponType, rarity, bonus1, minBonus1Value, minPrice,
maxPrice, page, limit up to 100). Each result has a `source`: `bazaar` names the seller, `market` (item market) is
anonymous and is dropped by the server (`weav3rRanked` in `src/routes/proxies.js`). Weav3r offers no auction house
listings in this data, and torn.bzimor.dev has no API, so there is no auction house source; Torn's own API only
lists finished auctions. Weav3r takes one weapon type, rarity and bonus per search, so several choices become
several searches (at most 24); each reads up to 5 pages of 100. Searches are kept in the browser for 5 minutes, the
server allows 30 searches a minute per member and caches answers for a minute.

### Inactive Earners tab (`public/app/js/earners/`)

Finds players who have been offline a while at well starred companies, since their wages pile up as cash.
It uses Torn API v2 with the member's own key (public access is enough): `/torn/companies` (company types),
`/company/{typeId}/companies` (100 per page, with star `rating`), and `/company/{id}/employees` (position, days in
company, last action, status). Torn does not show wages, so **estimated cash is a rough guess**:
`wage x min(days inactive, days in company)`. The wage is a fixed number per company type if you set one in Settings
(for a 10 star company, scaled by stars / 10), otherwise 60% of the company's real daily income split between its
employees (capped at Torn's $25m a day pay limit). Company lists and employees are cached in the browser for 3 hours
(`data.js`); every Torn call goes through the shared 80 a minute limiter (`features/limits.js`).

**Mug rating and predicted mug.** Each player gets a 0 to 100 score from: estimated cash (30), net worth (25, Torn's
public personal stats: a high net worth means they have held money for a long time), account age (15), weak stats (15,
against your own stats from Settings when set), days inactive (10) and company stars (5); hover the rating for the
breakdown. Parts that are not known yet are left out and the rest scaled up. Labels: 75+ Excellent, 55+ Good, 35+ Fair.
The predicted mug is the estimated cash times your mug rate (5%, plus merits and Plunder from More options).

**Mug tracking (why a mug took what it did).** Tapping Attack on a card saves a prediction with the tap (predicted mug,
estimated cash, net worth, rating, recent mugs; `pred` in `features/tracking.js`, stored on `clicks`, migration 0007).
While a finder page is open, `startMugWatch` checks your Torn attack log once a minute for 20 minutes after a tap
(`/api/leaderboard/sync`). A matching mug fills in `result` and `actual`; a tap with no mug is closed after 3 hours with
what the fight ended as. The Leaderboard page lists predicted against actual with a likely reason
(`features/outcomes.js`): other members' mugs in the 24 hours before, a mug the site already knew about, "Mugged by" in
the hospital status, or no known cause. **Recently mugged** lowers the rating on the Inactive earners tab: every mug a
member made is remembered (`seen_mugs`), each one in the last 24 hours takes about 18% off, older ones this week a
little, a mug in the last hour and a "Mugged by" hospital status extra (`recentDrain` in `earners/rules.js`).

**Mugging bonuses.** Merits (0 to 10, each adding 5% by default) and Plunder are set once in Settings
(`settings/mugbonus.js`) and read by every finder through `features/mugrate.js`: rate = 5% x (1 + merits x boost + Plunder).

**Attacks by anyone, not just members.** The site only knows mugs members made. For the best matches on the Inactive earners
tab it also reads Torn's public stat snapshots (`/user/{id}/personalstats?stat=defendslost,networth&timestamp=`) for now, a day
ago and a week ago (3 Torn calls each; `earners/history.js`, "Check recent attacks for the best N matches", default 10).
Fights they lost as the defender beyond the members' mugs, and a net worth fall of 20% or more in a day, lower the rating
and predicted mug. Snapshots are daily, so "~24h" is approximate, and it counts every lost defend (mugs, hospitalisations),
not only mugs.

**Your Torn key.** Everything the site calls with a member's key is listed in `public/js/core/keyneeds.js`; the "Make
my Torn key" link in Settings is built from it and "Check my key" (Torn's `/key/info`) compares a key against it.
Add a new selection there when a feature starts using one.

## How it fits together

- **Every request goes through the Worker** (`run_worker_first`). `/api/*` goes to a route handler; anything
  else is a file from `public/`, and `/app/*` needs a signed-in session.
- **Handlers** get `{ request, env, url, user }`. Public routes are marked in the table in `src/index.js`.
- **API keys** (Torn, FF Scouter) live in the browser's localStorage and are sent in headers for one request
  at a time. If a member ticks "keep it on my account", the key is also stored encrypted with a key made from
  their password (`src/lib/crypto.js`). The server can read it only while they are signed in, and a password
  reset clears it. There is no server secret to manage.
- **Passwords** use PBKDF2. Sessions, invite links and reset links are random tokens; only their hashes are stored.
- **The browser code** is plain ES modules (`<script type="module">`), so there is nothing to build.

## Common changes

| I want to... | Edit |
| --- | --- |
| Change a limit or a format (password length, invite lifetime) | `src/config.js` |
| Add an API route | write a handler in `src/routes/`, add one line to the table in `src/index.js` |
| Change a database column | add a new file in `migrations/` (next number), then use it in the route code |
| Change the scan or filters | `public/app/js/features/scan.js`, `rules.js`, `filters.js` |
| Change what counts as a good mug | `isMug` in `public/app/js/features/rules.js` |
| Change how "trade activity" is measured | `readBazaars` in `public/app/js/features/scan.js` (it counts listings changed in the last hour) |
| Change defaults (filters, alert rules) | `public/app/js/state.js` |
| Change colours or the look | `public/css/style.css` (colours are at the top) |
| Add a Settings section | a new file in `public/app/js/settings/`, call it from `pages/settings.js` |

## Rules this project follows

- No build step. Keep files small and plain; one job per file.
- Everything the browser shows from outside services is set with `textContent` (never `innerHTML`).
- The Content Security Policy allows only same-site scripts and styles. Do not add inline scripts or
  style attributes (set styles from JavaScript with `element.style.x = ...` if needed).
- Never log or store API keys on the server unless the member chose to save them (encrypted).
- Keep the Fontstuck credit and license files with the font.

## Tests

`tests/run.mjs` checks every server feature end to end, and `tests/ui.mjs` drives the real pages in a browser.
Both start a local copy of the Worker, a local database, and fake Torn, Weav3r and FF Scouter servers,
so they never touch your real Cloudflare account, database, email, or any real API.

```
node tests/run.mjs                 # server checks (needs Node 20+; npx fetches wrangler)
node tests/ui.mjs                  # browser checks (needs Playwright, see the top of the file)
```

Run `tests/run.mjs` after changing anything in `src/`, and `tests/ui.mjs` after changing `public/app/`.
