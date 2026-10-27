-- Flipper (Hypixel SkyBlock Bazaar and Auction House flip finder): collected snapshots, price history, sales, watchlists.

-- Key/value store for the latest data: the Bazaar snapshot ("bz"), item info ("items"), auction flips ("ah"), run status ("status").
CREATE TABLE fl_kv (
  k       TEXT PRIMARY KEY,
  v       TEXT NOT NULL,
  updated INTEGER NOT NULL
);

-- Price history of the tracked Bazaar items, one sample every ~15 minutes (bid = best buy order, ask = best sell offer).
CREATE TABLE fl_hist (
  product  TEXT    NOT NULL,
  ts       INTEGER NOT NULL,
  bid      REAL,
  ask      REAL,
  buyweek  INTEGER,
  sellweek INTEGER,
  PRIMARY KEY (product, ts)
) WITHOUT ROWID;
CREATE INDEX idx_fl_hist_ts ON fl_hist(ts);

-- Recent Auction House BIN sales per item identity ("core" variant key): data = JSON [[seconds, price, fullVariantKey], ...], newest first.
CREATE TABLE fl_sales (
  core    TEXT PRIMARY KEY,
  item    TEXT NOT NULL,
  data    TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX idx_fl_sales_updated ON fl_sales(updated);

-- Each member's watched items (Bazaar product ids).
CREATE TABLE fl_watch (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item)
);
