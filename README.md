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
    account.js          profile, email change, optional saved API keys
    invites.js          make, list and close invite links
    admin.js            owner-only account list and actions
    proxies.js          Weav3r, Torn, TornStats and FF Scouter pass-throughs
    leaderboard.js      Attack-tap log, mug verification against Torn, rankings

public/                 THE WEBSITE (served as is)
  index.html            Sign in / apply          recover.html, reset.html   password recovery
  css/style.css         The only stylesheet, in labelled sections
  js/core/              Helpers shared by every page (api, dom, format, storage, async)
  js/pages/             Scripts for the public pages
  app/                  Signed-in pages (the Worker only serves these to members)
    index.html          Mug Finder        settings.html   Settings        leaderboard.html   Leaderboard
    js/state.js         The shared state of the Mug Finder and its defaults
    js/features/        One file per feature (see below)
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
| `scan.js` | One scan in stages: choose items, read bazaars, estimates, filter, spies, status |
| `rules.js` | Pure rules: what is a good mug, why a listing was filtered out, sorting |
| `filters.js`, `watchlist.js` | The Filters panel and the watchlist |
| `cards.js`, `results.js` | A result card, the results grid, the once-a-second tick |
| `feed.js`, `alerts.js` | The auto hunt mug feed and the jackpot banners |
| `runner.js` | Scan, auto hunt and cancel buttons |
| `limits.js` | Keeps Torn and TornStats calls under their per-minute limits |
| `tracking.js` | Logs Attack taps and checks for new mugs (leaderboard) |
| `admin.js` | The owner panel, built only for the owner |
| `ui.js` | Message line, progress bar stages, run buttons |

## How it fits together

- **Every request goes through the Worker** (`run_worker_first`). `/api/*` goes to a route handler; anything
  else is a file from `public/`, and `/app/*` needs a signed-in session.
- **Handlers** get `{ request, env, url, user }`. Public routes are marked in the table in `src/index.js`.
- **API keys** (Torn, FF Scouter, TornStats) live in the browser's localStorage and are sent in headers for one
  request at a time. If a member ticks "save to my account", they are also stored encrypted with the
  `KEY_SECRET` secret.
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
Both start a local copy of the Worker, a local database, and fake Torn, Weav3r, FF Scouter and TornStats servers,
so they never touch your real Cloudflare account, database, email, or any real API.

```
node tests/run.mjs                 # server checks (needs Node 20+; npx fetches wrangler)
node tests/ui.mjs                  # browser checks (needs Playwright, see the top of the file)
```

Run `tests/run.mjs` after changing anything in `src/`, and `tests/ui.mjs` after changing `public/app/`.
