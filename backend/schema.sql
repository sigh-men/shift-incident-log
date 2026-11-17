-- Shift & Incident Log — SQLite schema (self-hosted replacement for Supabase/Postgres).
-- Applied automatically on server startup. Safe to re-run.

CREATE TABLE IF NOT EXISTS shift_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  date             TEXT,
  shift            TEXT,
  time             TEXT,
  staff_name       TEXT,
  campus           TEXT,
  event_type       TEXT,
  narrative        TEXT,
  follow_up_needed TEXT,
  follow_up_notes  TEXT,
  resolved         INTEGER NOT NULL DEFAULT 0,   -- 0/1, surfaced to the app as a boolean
  resolved_by      TEXT,
  resolved_at      TEXT,
  resolution_notes TEXT,
  severity         TEXT,                          -- 'Low' | 'Medium' | 'High' | NULL
  attachments      TEXT NOT NULL DEFAULT '[]',    -- JSON array of {path,name,type,size}
  warning_id       INTEGER,                       -- -> warnings.id when auto-created from an infraction
  deleted_at       TEXT,                          -- soft delete (admin); row kept for retention/audit
  deleted_by       TEXT
);

CREATE INDEX IF NOT EXISTS idx_shift_log_created ON shift_log(created_at DESC);

CREATE TABLE IF NOT EXISTS entry_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id    INTEGER NOT NULL REFERENCES shift_log(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_comments_entry ON entry_comments(entry_id);

-- Per-user "new since last visit" watermark for the unread feature.
CREATE TABLE IF NOT EXISTS read_state (
  user_name TEXT PRIMARY KEY,
  last_seen TEXT NOT NULL
);

-- Per-user notifications (comment on your entry, follow-up resolved, etc.).
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_name  TEXT NOT NULL,             -- recipient
  type       TEXT NOT NULL,             -- 'comment' | 'resolved'
  entry_id   INTEGER,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  read       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_name, read);

-- Edit history: one row per edit of a shift_log entry (admins can review).
CREATE TABLE IF NOT EXISTS entry_edits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id  INTEGER NOT NULL,
  edited_by TEXT NOT NULL,
  edited_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  changes   TEXT NOT NULL             -- JSON: { field: {from, to}, ... }
);
CREATE INDEX IF NOT EXISTS idx_entry_edits_entry ON entry_edits(entry_id);

-- ══════════════════════════════════════════════════════════════════════════════
-- Warnings & Write-Ups (VW/WW/WU)  —  client-level SUD records.
-- NOTE: 42 CFR Part 2 applies to this data. Keep on-prem; do not log client
-- identifiers; no external calls. See docs/warnings-feature-spec.md.
-- ══════════════════════════════════════════════════════════════════════════════

-- Client roster. Standalone for now (census sync is a later step).
CREATE TABLE IF NOT EXISTS clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT NOT NULL,
  client_code   TEXT,                              -- optional EHR/EHR id
  counselor     TEXT,                              -- assigned counselor (for issue-notification routing, spec §9 Q6)
  phase         INTEGER NOT NULL DEFAULT 1,        -- 1 or 2
  campus        TEXT DEFAULT 'North Campus',
  status        TEXT NOT NULL DEFAULT 'active',    -- active | discharged
  admitted_at   TEXT,
  discharged_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

-- Rule catalog. Admin-editable so policy changes don't need a code deploy.
CREATE TABLE IF NOT EXISTS rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT,                                 -- stable key; history survives label edits
  label      TEXT NOT NULL,                        -- what staff see in the picklist
  phase      TEXT NOT NULL DEFAULT 'both',         -- PH1 | PH2 | both
  active     INTEGER NOT NULL DEFAULT 1,           -- retire without losing history
  sort_order INTEGER NOT NULL DEFAULT 100
);

-- Warnings. Numbering is per client, per type, cumulative for the whole stay.
CREATE TABLE IF NOT EXISTS warnings (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id              INTEGER NOT NULL REFERENCES clients(id),
  rule_id                INTEGER REFERENCES rules(id),
  type                   TEXT NOT NULL,            -- VW | WW | WU (chosen by staff)
  seq_number             INTEGER NOT NULL,         -- the "#3" — per client, per type
  rule_detail            TEXT,                     -- free text: what actually happened
  occurred_at            TEXT,
  shift                  TEXT,
  campus                 TEXT,
  phase_at_time          INTEGER,                  -- phase snapshotted at issue
  issued_by              TEXT,
  issued_by_initials     TEXT,
  issued_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  narrative              TEXT,
  consequence_type       TEXT DEFAULT 'none',      -- none | paper | chores
  consequence_detail     TEXT,
  paper_topic_id         INTEGER,                  -- -> paper_topics.id (link enforced in app)
  consequence_due        TEXT,
  status                 TEXT NOT NULL DEFAULT 'issued',
  delivered_at           TEXT,
  signed_at              TEXT,
  EHR_uploaded_at  TEXT,
  EHR_by           TEXT,
  counselor_notified_at  TEXT,
  counselor_notified_by  TEXT,
  census_updated_at      TEXT,
  logbook_entry_id       INTEGER,                  -- FK -> shift_log.id (wired in a later step)
  completed_at           TEXT,
  completed_by           TEXT,
  completion_notes       TEXT,
  voided_at              TEXT,
  voided_by              TEXT,
  void_reason            TEXT,
  attachments            TEXT NOT NULL DEFAULT '[]',
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_warnings_client ON warnings(client_id);
CREATE INDEX IF NOT EXISTS idx_warnings_status ON warnings(status);

-- Edit trail for warnings (mirrors entry_edits; disciplinary records need it).
CREATE TABLE IF NOT EXISTS warning_edits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  warning_id INTEGER NOT NULL,
  edited_by  TEXT NOT NULL,
  edited_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  changes    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_warning_edits_warning ON warning_edits(warning_id);

-- Seed the rule catalog ONCE (only if empty), idempotent + re-run safe.
-- DRAFT placeholder wording from spec §3 topic list — pending open-question 4.
-- Admin-editable in the app; `code` is the stable key so history survives edits.
INSERT INTO rules (code, label, phase, active, sort_order)
  SELECT * FROM (
    SELECT 'chores'     AS code, 'Failing to do chores'                AS label, 'both' AS phase, 1 AS active, 10 AS sort_order UNION ALL
    SELECT 'signinout',      'Sign-in / sign-out violation',                'both', 1, 20  UNION ALL
    SELECT 'roomcheck',      'Failing room check',                          'both', 1, 30  UNION ALL
    SELECT 'meetings',       'Missing a 12-step meeting',                   'both', 1, 40  UNION ALL
    SELECT 'housemtg',       'Missing house meeting',                       'both', 1, 50  UNION ALL
    SELECT 'ua9pm',          'UA after 9pm',                                'both', 1, 60  UNION ALL
    SELECT 'medtimes',       'Missing med times',                           'both', 1, 70  UNION ALL
    SELECT 'kitchen',        'Kitchen duty violation',                      'both', 1, 80  UNION ALL
    SELECT 'ph2hours',       'PH2 campus hours violation',                  'PH2',  1, 90  UNION ALL
    SELECT 'lending',        'Lending / borrowing',                         'both', 1, 100 UNION ALL
    SELECT 'disrespect',     'Disrespect',                                  'both', 1, 110 UNION ALL
    SELECT 'smoking',        'Smoking violation',                           'both', 1, 120 UNION ALL
    SELECT 'devices',        'Electronic devices violation',                'both', 1, 130 UNION ALL
    SELECT 'priorvw',        'Failure to adhere to a prior VW',             'both', 1, 140
  )
  WHERE NOT EXISTS (SELECT 1 FROM rules);

-- ── Forward-looking catalogs for later steps (empty until content supplied) ──

-- WW paper topics (spec §9 Q1) — admin-editable; a warning links via
-- warnings.paper_topic_id. Empty until the topic list is provided.
CREATE TABLE IF NOT EXISTS paper_topics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  topic      TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100
);

-- Standard write-up language for the printed form (spec §9 Q2) — admin-editable.
-- `body` holds template text with placeholders (e.g. {client}, {rule},
-- {number}, {due}) filled at print time. Empty until the wording is supplied.
CREATE TABLE IF NOT EXISTS consequence_templates (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  consequence_type TEXT NOT NULL,                  -- paper | chores | general
  label            TEXT NOT NULL,
  body             TEXT NOT NULL,
  active           INTEGER NOT NULL DEFAULT 1,
  sort_order       INTEGER NOT NULL DEFAULT 100,
  updated_at       TEXT,
  updated_by       TEXT
);

-- Shift handoffs: the outgoing shift "sends" a handoff and the incoming shift
-- acknowledges it ("Received"), recording who read it and when. One row per
-- campus/date/shift; re-sending replaces the summary and clears the receipt.
CREATE TABLE IF NOT EXISTS handoffs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campus      TEXT NOT NULL,                     -- campus name or 'All Campuses'
  date        TEXT NOT NULL,                     -- YYYY-MM-DD of the outgoing shift
  shift       TEXT NOT NULL,                     -- outgoing shift: Day | Evening | Overnight
  sent_by     TEXT NOT NULL,
  sent_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  summary     TEXT NOT NULL,                     -- plain-text handoff as sent
  ack_by      TEXT,
  ack_at      TEXT,
  UNIQUE (campus, date, shift)
);

CREATE INDEX IF NOT EXISTS idx_handoffs_sent ON handoffs(sent_at DESC);

-- Unsent Submit-form drafts, one per user, so a half-written entry survives a
-- refresh / idle sign-out / crash. Kept on the NAS (not in browser storage on
-- shared devices) and deleted when the entry is submitted or discarded.
CREATE TABLE IF NOT EXISTS entry_drafts (
  user_name  TEXT PRIMARY KEY,
  data       TEXT NOT NULL,                      -- JSON: { uuid, fields: {...} }
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Edit trail for roster profiles (mirrors entry_edits / warning_edits).
CREATE TABLE IF NOT EXISTS client_edits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  INTEGER NOT NULL,
  edited_by  TEXT NOT NULL,
  edited_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  changes    TEXT NOT NULL             -- JSON: { field: {from, to}, ... }
);
CREATE INDEX IF NOT EXISTS idx_client_edits_client ON client_edits(client_id);
