DROP TABLE IF EXISTS reservations;
CREATE TABLE reservations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  phone      TEXT    NOT NULL,
  date       TEXT    NOT NULL,                                              -- YYYY-MM-DD
  slot       TEXT    NOT NULL CHECK (slot IN ('11:30','12:30','17:30','18:30')), -- BR-05
  guests     INTEGER NOT NULL CHECK (guests BETWEEN 1 AND 10),              -- BR-03
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (phone, date, slot)                                                -- BR-07
);
CREATE INDEX idx_reservations_date_slot ON reservations (date, slot);
