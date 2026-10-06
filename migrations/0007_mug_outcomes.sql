-- What the site predicted when a member tapped Attack, and how it turned out; plus every mug members make,
-- so the site can see how often a player was mugged recently.

ALTER TABLE clicks ADD COLUMN src TEXT;           -- which finder: bazaar, earners, bonus
ALTER TABLE clicks ADD COLUMN predicted INTEGER;  -- predicted mug, dollars
ALTER TABLE clicks ADD COLUMN est_cash INTEGER;   -- estimated cash on hand
ALTER TABLE clicks ADD COLUMN networth INTEGER;
ALTER TABLE clicks ADD COLUMN score INTEGER;      -- mug rating 0-100
ALTER TABLE clicks ADD COLUMN recent_mugs INTEGER; -- mugs of this player in the last 24h, as the site knew then
ALTER TABLE clicks ADD COLUMN hosp INTEGER;       -- 1 if they were in hospital after a mug when opened
ALTER TABLE clicks ADD COLUMN result TEXT;        -- Mugged, or what the attack ended as, or "No attack seen"
ALTER TABLE clicks ADD COLUMN actual INTEGER;     -- money actually mugged
ALTER TABLE clicks ADD COLUMN resolved_at INTEGER;
-- clicks.matched: 0 waiting, 1 mugged and counted, 2 closed without a mug

-- Every outgoing mug of every member that a check saw (amount only known for mugs on opened players)
CREATE TABLE seen_mugs (
  attack_code TEXT PRIMARY KEY,
  target_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mugged_at   INTEGER NOT NULL,
  amount      INTEGER
);
CREATE INDEX idx_seen_target ON seen_mugs(target_id, mugged_at);
