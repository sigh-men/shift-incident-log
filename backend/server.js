/**
 * Shift & Incident Log — self-hosted backend.
 *
 * Replaces the four Supabase services the app used:
 *   • Postgres tables (shift_log, entry_comments)  -> SQLite
 *   • Storage (attachments bucket)                 -> files on the NAS volume
 *   • Realtime (postgres_changes)                  -> Server-Sent Events (/api/events)
 *   • Auto REST API                                -> the routes below
 *
 * The browser talks to this through db-shim.js, which mimics the supabase-js
 * surface the app already uses, so script.js is essentially unchanged.
 *
 * Trust model: LAN/VLAN-isolated + client-side PIN. No per-request API auth
 * (by decision) — the network boundary is the gate.
 */
"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const Database = require("better-sqlite3");

const PORT = parseInt(process.env.PORT || "3000", 10);
const WEB_DIR = process.env.WEB_DIR || path.join(__dirname, "..", "web");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const ATTACH_DIR = path.join(DATA_DIR, "attachments");
const DB_PATH = path.join(DATA_DIR, "shiftlog.db");

// ── Storage dirs ──────────────────────────────────────────────────────────────
fs.mkdirSync(ATTACH_DIR, { recursive: true });

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

// Re-run-safe column adds for tables that already exist on deployed DBs
// (SQLite has no ADD COLUMN IF NOT EXISTS, so guard with PRAGMA table_info).
function ensureColumn(table, column, defSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${defSql}`);
  }
}
ensureColumn("shift_log", "warning_id", "INTEGER");
ensureColumn("shift_log", "deleted_at", "TEXT");
ensureColumn("shift_log", "deleted_by", "TEXT");
// Duplicate-submit guard: each Submit form / offline-queued entry carries a
// client-generated id, so a retry of the same entry can never create a 2nd row.
ensureColumn("shift_log", "client_uuid", "TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_log_client_uuid ON shift_log(client_uuid) WHERE client_uuid IS NOT NULL");

// Columns the app is allowed to write, per table (whitelist — ignore anything else).
const SHIFT_INSERT_COLS = [
  "date", "shift", "time", "staff_name", "campus", "event_type",
  "narrative", "follow_up_needed", "follow_up_notes", "severity", "attachments", "client_uuid",
];
const SHIFT_UPDATE_COLS = ["resolved", "resolved_by", "resolved_at", "resolution_notes"];

// Convert a DB row into the shape the frontend expects (booleans, parsed JSON).
function shiftRowOut(r) {
  if (!r) return r;
  let attachments = [];
  try { attachments = JSON.parse(r.attachments || "[]"); } catch { attachments = []; }
  return { ...r, resolved: !!r.resolved, attachments };
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// ── Realtime via Server-Sent Events ──────────────────────────────────────────
const sseClients = new Set();

app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write("retry: 3000\n\n");
  sseClients.add(res);
  const keepAlive = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
  req.on("close", () => { clearInterval(keepAlive); sseClients.delete(res); });
});

// Broadcast a shift_log change to every connected client.
// Payload shape mirrors Supabase Realtime: { eventType, new }.
function broadcast(eventType, row) {
  const msg = `data: ${JSON.stringify({ kind: "shift_log", eventType, new: row })}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch {} }
}

// Tell connected clients that new notifications exist for these recipients.
// Each client shows a toast / updates its bell only if it's one of the recipients.
function broadcastNotification(recipients) {
  const msg = `data: ${JSON.stringify({ kind: "notification", recipients })}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch {} }
}

// Tell connected clients a handoff was sent or received, so the Handoff tab refreshes.
function broadcastHandoff() {
  const msg = `data: ${JSON.stringify({ kind: "handoff" })}

`;
  for (const res of sseClients) { try { res.write(msg); } catch {} }
}

// Tell connected clients a warning changed, so the Warnings tab can refresh.
function broadcastWarning() {
  const msg = `data: ${JSON.stringify({ kind: "warning" })}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch {} }
}

// Auto-create a shift_log entry linked to a warning, and broadcast it so it
// shows in the feed / unread / handoff without anyone re-typing it.
function createLinkedLogEntry({ date, time, shift, campus, staff_name, narrative, warning_id }) {
  // Always stamp a date AND time (local) so the entry sorts correctly in the
  // View Log (which orders by the entry's own date + time). Missing time used to
  // drop these auto-entries to the bottom of the day. TZ is set to America/Denver so
  // `new Date()` matches the local times staff enter. SQLite's created_at stays UTC.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const localDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const localTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const info = db.prepare(
    "INSERT INTO shift_log (date, time, shift, staff_name, campus, event_type, narrative, follow_up_needed, warning_id) " +
    "VALUES (?, ?, ?, ?, ?, 'VW/WW/WU', ?, 'No', ?)"
  ).run(date || localDate, time || localTime, shift || null, staff_name || null, campus || null,
        narrative || null, warning_id || null);
  const row = db.prepare("SELECT * FROM shift_log WHERE id = ?").get(info.lastInsertRowid);
  broadcast("INSERT", shiftRowOut(row));
  return info.lastInsertRowid;
}

// Insert one notification row per recipient, then signal them over SSE.
// recips: [{ user, message }]
function notify(recips, type, entryId) {
  if (!recips.length) return;
  const stmt = db.prepare(
    "INSERT INTO notifications (user_name, type, entry_id, message) VALUES (?, ?, ?, ?)"
  );
  const insertMany = db.transaction((list) => {
    for (const r of list) stmt.run(r.user, type, entryId, r.message);
  });
  insertMany(recips);
  broadcastNotification([...new Set(recips.map(r => r.user))]);
}

// ── shift_log ─────────────────────────────────────────────────────────────────
app.get("/api/shift_log", (req, res) => {
  try {
    const EDIT_META =
      "(SELECT COUNT(*) FROM entry_edits e WHERE e.entry_id = s.id) AS edit_count, " +
      "(SELECT MAX(edited_at) FROM entry_edits e WHERE e.entry_id = s.id) AS last_edited_at";
    let rows;
    if (req.query.since) {
      rows = db.prepare(
        `SELECT s.*, ${EDIT_META} FROM shift_log s WHERE s.deleted_at IS NULL AND s.created_at >= ? ORDER BY s.created_at DESC`
      ).all(String(req.query.since));
    } else {
      rows = db.prepare(`SELECT s.*, ${EDIT_META} FROM shift_log s WHERE s.deleted_at IS NULL ORDER BY s.created_at DESC`).all();
    }
    res.json({ data: rows.map(shiftRowOut), error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: { message: err.message } });
  }
});

app.post("/api/shift_log", (req, res) => {
  try {
    const body = req.body || {};
    const cols = SHIFT_INSERT_COLS.filter((c) => body[c] !== undefined);
    const vals = cols.map((c) => (c === "attachments" ? JSON.stringify(body[c] ?? []) : body[c]));
    // A retry of an entry we already stored (same client_uuid) returns the
    // existing row instead of inserting a duplicate.
    const findDup = () => body.client_uuid
      ? db.prepare("SELECT * FROM shift_log WHERE client_uuid = ?").get(String(body.client_uuid))
      : null;
    const dup = findDup();
    if (dup) return res.json({ data: [shiftRowOut(dup)], error: null, duplicate: true });
    const placeholders = cols.map(() => "?").join(", ");
    const stmt = db.prepare(`INSERT INTO shift_log (${cols.join(", ")}) VALUES (${placeholders})`);
    let info;
    try {
      info = stmt.run(...vals);
    } catch (e) {
      // Two copies raced past the check above — the unique index caught the 2nd.
      const raced = e.code === "SQLITE_CONSTRAINT_UNIQUE" && findDup();
      if (raced) return res.json({ data: [shiftRowOut(raced)], error: null, duplicate: true });
      throw e;
    }
    const row = shiftRowOut(db.prepare("SELECT * FROM shift_log WHERE id = ?").get(info.lastInsertRowid));
    broadcast("INSERT", row);
    res.json({ data: [row], error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: { message: err.message } });
  }
});

app.patch("/api/shift_log/:id", (req, res) => {
  try {
    const body = req.body || {};
    const cols = SHIFT_UPDATE_COLS.filter((c) => body[c] !== undefined);
    if (!cols.length) return res.json({ data: null, error: null });
    const setClause = cols.map((c) => `${c} = ?`).join(", ");
    const vals = cols.map((c) => (c === "resolved" ? (body[c] ? 1 : 0) : body[c]));
    db.prepare(`UPDATE shift_log SET ${setClause} WHERE id = ?`).run(...vals, req.params.id);
    const row = shiftRowOut(db.prepare("SELECT * FROM shift_log WHERE id = ?").get(req.params.id));
    broadcast("UPDATE", row);

    // On resolution: notify the entry's author + all admins (client supplies the
    // admin name list), minus whoever did the resolving.
    if (body.resolved) {
      const resolver = body.resolved_by || "Someone";
      const authorName = row ? row.staff_name : null;
      // `recipients` = everyone to notify (all users). Falls back to `admins` for
      // backward compatibility with older clients.
      const extra = Array.isArray(body.recipients) ? body.recipients
                  : (Array.isArray(body.admins) ? body.admins : []);
      const recipients = new Set(extra);
      if (authorName) recipients.add(authorName);
      recipients.delete(resolver);
      const et = row ? row.event_type : "";
      const dt = row && row.date ? ` (${row.date})` : "";
      const recips = [...recipients].map((u) => ({
        user: u,
        message: `${resolver} resolved ${u === authorName ? "your" : (authorName ? authorName + "'s" : "a")} ${et} follow-up${dt}`,
      }));
      notify(recips, "resolved", Number(req.params.id));
    }

    res.json({ data: row ? [row] : [], error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: { message: err.message } });
  }
});

// ── entry_comments ────────────────────────────────────────────────────────────
app.get("/api/entry_comments", (req, res) => {
  try {
    if (req.query.entry_ids !== undefined) {
      // Count query: .in("entry_id", ids) — returns just entry_id per comment.
      const ids = String(req.query.entry_ids).split(",").map((s) => s.trim()).filter(Boolean);
      if (!ids.length) return res.json({ data: [], error: null });
      const placeholders = ids.map(() => "?").join(", ");
      const rows = db.prepare(
        `SELECT entry_id FROM entry_comments WHERE entry_id IN (${placeholders})`
      ).all(...ids);
      return res.json({ data: rows, error: null });
    }
    // Full thread for one entry: .eq("entry_id", id).order("created_at", asc)
    const entryId = req.query.entry_id;
    const rows = db.prepare(
      "SELECT * FROM entry_comments WHERE entry_id = ? ORDER BY created_at ASC"
    ).all(entryId);
    res.json({ data: rows, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: { message: err.message } });
  }
});

app.post("/api/entry_comments", (req, res) => {
  try {
    const { entry_id, author_name, body } = req.body || {};
    if (!entry_id || !author_name || !body) {
      return res.status(400).json({ data: null, error: { message: "entry_id, author_name and body are required" } });
    }
    const info = db.prepare(
      "INSERT INTO entry_comments (entry_id, author_name, body) VALUES (?, ?, ?)"
    ).run(entry_id, author_name, body);
    const row = db.prepare("SELECT * FROM entry_comments WHERE id = ?").get(info.lastInsertRowid);

    // Notify the entry's author + everyone else who commented on it (not the commenter).
    const entry = db.prepare("SELECT staff_name, event_type, date FROM shift_log WHERE id = ?").get(entry_id);
    const authorName = entry && entry.staff_name;
    const others = db.prepare(
      "SELECT DISTINCT author_name FROM entry_comments WHERE entry_id = ? AND author_name <> ?"
    ).all(entry_id, author_name).map(r => r.author_name);
    const recipients = new Set(others);
    if (authorName) recipients.add(authorName);
    recipients.delete(author_name);
    const et = entry ? entry.event_type : "";
    const dt = entry && entry.date ? ` (${entry.date})` : "";
    const recips = [...recipients].map((u) => ({
      user: u,
      message: `${author_name} commented on ${u === authorName ? "your" : (authorName ? authorName + "'s" : "an")} ${et} entry${dt}`,
    }));
    notify(recips, "comment", entry_id);

    res.json({ data: [row], error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: { message: err.message } });
  }
});

// ── Read state (per-user "new since last visit" watermark) ────────────────────
app.get("/api/read_state", (req, res) => {
  try {
    const u = req.query.user;
    if (!u) return res.json({ data: { last_seen: null }, error: null });
    const row = db.prepare("SELECT last_seen FROM read_state WHERE user_name = ?").get(String(u));
    res.json({ data: { last_seen: row ? row.last_seen : null }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: { message: err.message } });
  }
});

app.post("/api/read_state", (req, res) => {
  try {
    const { user, last_seen } = req.body || {};
    if (!user || !last_seen) {
      return res.status(400).json({ error: { message: "user and last_seen required" } });
    }
    db.prepare(
      "INSERT INTO read_state (user_name, last_seen) VALUES (?, ?) " +
      "ON CONFLICT(user_name) DO UPDATE SET last_seen = excluded.last_seen"
    ).run(String(user), String(last_seen));
    res.json({ error: null });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Submit-form drafts ────────────────────────────────────────────────────────
// One unsent draft per user. Drafts older than 24h are ignored (stale shift).
app.get("/api/drafts", (req, res) => {
  try {
    const u = req.query.user;
    if (!u) return res.json({ data: null, error: null });
    const r = db.prepare(
      "SELECT data, updated_at FROM entry_drafts WHERE user_name = ? AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')"
    ).get(String(u));
    let data = null;
    if (r) { try { data = { ...JSON.parse(r.data), updated_at: r.updated_at }; } catch { data = null; } }
    res.json({ data, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: { message: err.message } });
  }
});

app.put("/api/drafts", (req, res) => {
  try {
    const { user, data } = req.body || {};
    if (!user || !data) return res.status(400).json({ error: { message: "user and data required" } });
    db.prepare(
      "INSERT INTO entry_drafts (user_name, data) VALUES (?, ?) ON CONFLICT (user_name) DO UPDATE SET " +
      "data = excluded.data, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
    ).run(String(user), JSON.stringify(data));
    res.json({ error: null });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Drafts are scratch work, not records — removing one on submit/discard is expected.
app.delete("/api/drafts", (req, res) => {
  try {
    const u = req.query.user;
    if (u) db.prepare("DELETE FROM entry_drafts WHERE user_name = ?").run(String(u));
    res.json({ error: null });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Shift handoffs ────────────────────────────────────────────────────────────
// The outgoing shift sends a handoff; the incoming shift acknowledges it.
app.get("/api/handoffs", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "40", 10) || 40, 200);
    const rows = db.prepare("SELECT * FROM handoffs ORDER BY sent_at DESC LIMIT ?").all(limit);
    res.json({ data: rows, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: { message: err.message } });
  }
});

app.post("/api/handoffs", (req, res) => {
  try {
    const { campus, date, shift, sent_by, summary } = req.body || {};
    if (!date || !shift || !sent_by || !summary) {
      return res.status(400).json({ data: null, error: { message: "date, shift, sent_by and summary are required" } });
    }
    const c = campus || "All Campuses";
    // Re-sending the same campus/date/shift replaces the summary and clears any
    // earlier receipt — the incoming shift must acknowledge the updated version.
    db.prepare(
      "INSERT INTO handoffs (campus, date, shift, sent_by, summary) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT (campus, date, shift) DO UPDATE SET sent_by = excluded.sent_by, summary = excluded.summary, " +
      "sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ack_by = NULL, ack_at = NULL"
    ).run(c, String(date), String(shift), String(sent_by), String(summary));
    const row = db.prepare("SELECT * FROM handoffs WHERE campus = ? AND date = ? AND shift = ?").get(c, String(date), String(shift));
    broadcastHandoff();
    res.json({ data: row, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: { message: err.message } });
  }
});

app.post("/api/handoffs/:id/ack", (req, res) => {
  try {
    const by = (req.body && req.body.by) || "";
    if (!by) return res.status(400).json({ data: null, error: { message: "by required" } });
    const h = db.prepare("SELECT * FROM handoffs WHERE id = ?").get(req.params.id);
    if (!h) return res.status(404).json({ data: null, error: { message: "Handoff not found" } });
    if (h.sent_by === by) return res.status(400).json({ data: null, error: { message: "You can't acknowledge your own handoff." } });
    if (h.ack_at) return res.json({ data: h, error: null });   // already received — keep the first receipt
    db.prepare("UPDATE handoffs SET ack_by = ?, ack_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(String(by), h.id);
    const row = db.prepare("SELECT * FROM handoffs WHERE id = ?").get(h.id);
    notify([{ user: h.sent_by, message: `${by} received your ${h.campus} ${h.shift} shift handoff.` }], "handoff", null);
    broadcastHandoff();
    res.json({ data: row, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: { message: err.message } });
  }
});

// ── Notifications ─────────────────────────────────────────────────────────────
app.get("/api/notifications", (req, res) => {
  try {
    const u = req.query.user;
    if (!u) return res.json({ data: { items: [], unread: 0 }, error: null });
    const items = db.prepare(
      "SELECT id, type, entry_id, message, created_at, read FROM notifications WHERE user_name = ? ORDER BY id DESC LIMIT 40"
    ).all(String(u)).map((i) => ({ ...i, read: !!i.read }));
    const unread = db.prepare(
      "SELECT COUNT(*) AS c FROM notifications WHERE user_name = ? AND read = 0"
    ).get(String(u)).c;
    res.json({ data: { items, unread }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: { message: err.message } });
  }
});

app.post("/api/notifications/read", (req, res) => {
  try {
    const { user, ids, all } = req.body || {};
    if (!user) return res.status(400).json({ error: { message: "user required" } });
    if (all) {
      db.prepare("UPDATE notifications SET read = 1 WHERE user_name = ?").run(String(user));
    } else if (Array.isArray(ids) && ids.length) {
      const q = ids.map(() => "?").join(",");
      db.prepare(`UPDATE notifications SET read = 1 WHERE user_name = ? AND id IN (${q})`)
        .run(String(user), ...ids);
    }
    res.json({ error: null });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Entry edits + history ─────────────────────────────────────────────────────
const EDITABLE_COLS = [
  "date", "shift", "time", "campus", "event_type",
  "narrative", "follow_up_needed", "follow_up_notes",
];

app.post("/api/shift_log/:id/edit", (req, res) => {
  try {
    const id = req.params.id;
    const editor = (req.body && req.body.editor) || "Unknown";
    const fields = (req.body && req.body.fields) || {};
    const cur = db.prepare("SELECT * FROM shift_log WHERE id = ?").get(id);
    if (!cur) return res.status(404).json({ data: null, error: { message: "Entry not found" } });

    const changes = {};
    const setCols = [];
    const vals = [];
    for (const f of EDITABLE_COLS) {
      if (fields[f] === undefined) continue;
      const nv = fields[f];
      const ov = cur[f];
      if (String(nv ?? "") !== String(ov ?? "")) {
        changes[f] = { from: ov, to: nv };
        setCols.push(`${f} = ?`);
        vals.push(nv);
      }
    }
    if (!setCols.length) return res.json({ data: [shiftRowOut(cur)], error: null }); // no-op

    db.prepare(`UPDATE shift_log SET ${setCols.join(", ")} WHERE id = ?`).run(...vals, id);
    db.prepare("INSERT INTO entry_edits (entry_id, edited_by, changes) VALUES (?, ?, ?)")
      .run(id, editor, JSON.stringify(changes));
    const row = shiftRowOut(db.prepare("SELECT * FROM shift_log WHERE id = ?").get(id));
    broadcast("UPDATE", row);
    res.json({ data: [row], error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: { message: err.message } });
  }
});

app.get("/api/shift_log/:id/history", (req, res) => {
  try {
    const items = db.prepare(
      "SELECT id, edited_by, edited_at, changes FROM entry_edits WHERE entry_id = ? ORDER BY id DESC"
    ).all(req.params.id);
    res.json({ data: { items }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: { message: err.message } });
  }
});

// Admin soft delete — hide the entry but keep the row (+ who/when) for
// 42 CFR retention and audit. Recoverable via restore.
app.get("/api/shift_log/deleted", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM shift_log WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").all();
    res.json({ data: rows.map(shiftRowOut), error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

app.post("/api/shift_log/:id/delete", (req, res) => {
  try {
    const by = (req.body && req.body.deleted_by) || "Unknown";
    db.prepare("UPDATE shift_log SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ? WHERE id = ?")
      .run(by, req.params.id);
    broadcast("DELETE", { id: Number(req.params.id) });
    res.json({ error: null });
  } catch (err) { res.status(500).json({ error: { message: err.message } }); }
});

app.post("/api/shift_log/:id/restore", (req, res) => {
  try {
    db.prepare("UPDATE shift_log SET deleted_at = NULL, deleted_by = NULL WHERE id = ?").run(req.params.id);
    const row = db.prepare("SELECT * FROM shift_log WHERE id = ?").get(req.params.id);
    if (row) broadcast("INSERT", shiftRowOut(row));
    res.json({ error: null });
  } catch (err) { res.status(500).json({ error: { message: err.message } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Warnings & Write-Ups (VW/WW/WU) — client-level records (42 CFR Part 2).
// No client identifiers are ever logged; no external calls.
// ══════════════════════════════════════════════════════════════════════════════

// ── Clients (roster) ──────────────────────────────────────────────────────────
app.get("/api/clients", (req, res) => {
  try {
    const rows = req.query.status
      ? db.prepare("SELECT * FROM clients WHERE status = ? ORDER BY full_name COLLATE NOCASE").all(String(req.query.status))
      : db.prepare("SELECT * FROM clients ORDER BY full_name COLLATE NOCASE").all();
    res.json({ data: rows, error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

app.post("/api/clients", (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.full_name || "").trim();
    if (!name) {
      return res.status(400).json({ error: { message: "full_name required" } });
    }
    const missing = [["counselor", "Clinician"], ["campus", "Campus"], ["admitted_at", "Admitted"]]
      .filter(([f]) => !String(b[f] ?? "").trim()).map(([, label]) => label);
    if (missing.length) return res.status(400).json({ error: { message: `Please fill in: ${missing.join(", ")}.` } });
    // Prevent a second roster profile for the same person (case-insensitive name match).
    const dup = db.prepare("SELECT full_name, status FROM clients WHERE lower(trim(full_name)) = lower(?)").get(name);
    if (dup) {
      const msg = dup.status === "discharged"
        ? `A client named "${dup.full_name}" already exists but is discharged. Reactivate them in Manage Roster instead of adding a new profile.`
        : `A client named "${dup.full_name}" is already on the roster — no need to add them again.`;
      return res.status(409).json({ error: { message: msg } });
    }
    const info = db.prepare(
      "INSERT INTO clients (full_name, client_code, counselor, phase, campus, status, admitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(name, b.client_code || null, b.counselor || null, Number(b.phase) || 1,
          b.campus || "North Campus", b.status || "active", b.admitted_at || null);
    res.json({ data: [db.prepare("SELECT * FROM clients WHERE id = ?").get(info.lastInsertRowid)], error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

app.patch("/api/clients/:id", (req, res) => {
  try {
    const b = req.body || {};
    const cols = ["full_name", "client_code", "counselor", "phase", "campus", "status", "admitted_at", "discharged_at"]
      .filter((c) => b[c] !== undefined);
    if (!cols.length) return res.json({ data: null, error: null });
    db.prepare(`UPDATE clients SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
      .run(...cols.map((c) => b[c]), req.params.id);
    res.json({ data: [db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id)], error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

// Edit a roster profile (fix a typo, missing clinician, wrong admit date…).
// Records what changed in client_edits. Infractions show the client's CURRENT
// name/clinician (joined live), so a correction carries through to history.
const CLIENT_EDITABLE = ["full_name", "counselor", "phase", "campus", "client_code", "admitted_at", "discharged_at"];
app.post("/api/clients/:id/edit", (req, res) => {
  try {
    const b = req.body || {};
    const editor = b.editor || "Unknown";
    const fields = { ...(b.fields || {}) };
    const cur = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ data: null, error: { message: "Client not found" } });

    if (fields.full_name !== undefined) {
      fields.full_name = String(fields.full_name || "").trim();
      if (!fields.full_name) return res.status(400).json({ data: null, error: { message: "Name can't be empty." } });
      const dup = db.prepare("SELECT full_name FROM clients WHERE lower(trim(full_name)) = lower(?) AND id <> ?").get(fields.full_name, cur.id);
      if (dup) return res.status(409).json({ data: null, error: { message: `Another client is already named "${dup.full_name}".` } });
    }
    const blanked = [["counselor", "Clinician"], ["campus", "Campus"], ["admitted_at", "Admitted"]]
      .filter(([f]) => fields[f] !== undefined && !String(fields[f] ?? "").trim()).map(([, label]) => label);
    if (blanked.length) return res.status(400).json({ data: null, error: { message: `Please fill in: ${blanked.join(", ")}.` } });
    if (fields.phase !== undefined) {
      fields.phase = Number(fields.phase);
      if (![1, 2].includes(fields.phase)) return res.status(400).json({ data: null, error: { message: "Phase must be 1 or 2." } });
    }

    const changes = {}, setCols = [], vals = [];
    for (const f of CLIENT_EDITABLE) {
      if (fields[f] === undefined) continue;
      const nv = fields[f] === "" ? null : fields[f], ov = cur[f];
      if (String(nv ?? "") !== String(ov ?? "")) {
        changes[f] = { from: ov, to: nv };
        setCols.push(`${f} = ?`);
        vals.push(nv);
      }
    }
    if (!setCols.length) return res.json({ data: [cur], error: null });

    db.prepare(`UPDATE clients SET ${setCols.join(", ")} WHERE id = ?`).run(...vals, cur.id);
    db.prepare("INSERT INTO client_edits (client_id, edited_by, changes) VALUES (?, ?, ?)")
      .run(cur.id, editor, JSON.stringify(changes));
    broadcastWarning();   // infraction lists show the client's name/clinician — refresh them
    res.json({ data: [db.prepare("SELECT * FROM clients WHERE id = ?").get(cur.id)], error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

app.get("/api/clients/:id/history", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM client_edits WHERE client_id = ? ORDER BY id DESC").all(req.params.id);
    res.json({ data: rows.map((r) => ({ ...r, changes: JSON.parse(r.changes || "{}") })), error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

// ── Rule catalog (admin-editable) ─────────────────────────────────────────────
app.get("/api/rules", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM rules ORDER BY sort_order, label COLLATE NOCASE").all();
    res.json({ data: rows.map((r) => ({ ...r, active: !!r.active })), error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

app.post("/api/rules", (req, res) => {
  try {
    const b = req.body || {};
    if (!b.label || !String(b.label).trim()) return res.status(400).json({ error: { message: "label required" } });
    const info = db.prepare("INSERT INTO rules (code, label, phase, active, sort_order) VALUES (?, ?, ?, ?, ?)")
      .run(b.code || null, String(b.label).trim(), b.phase || "both", b.active === false ? 0 : 1, Number(b.sort_order) || 100);
    const row = db.prepare("SELECT * FROM rules WHERE id = ?").get(info.lastInsertRowid);
    res.json({ data: [{ ...row, active: !!row.active }], error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

app.patch("/api/rules/:id", (req, res) => {
  try {
    const b = req.body || {};
    const cols = ["code", "label", "phase", "active", "sort_order"].filter((c) => b[c] !== undefined);
    if (!cols.length) return res.json({ data: null, error: null });
    const vals = cols.map((c) => (c === "active" ? (b[c] ? 1 : 0) : b[c]));
    db.prepare(`UPDATE rules SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...vals, req.params.id);
    const row = db.prepare("SELECT * FROM rules WHERE id = ?").get(req.params.id);
    res.json({ data: [{ ...row, active: !!row.active }], error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

// ── Warnings ──────────────────────────────────────────────────────────────────
function warningOut(r) {
  if (!r) return r;
  let attachments = [];
  try { attachments = JSON.parse(r.attachments || "[]"); } catch { attachments = []; }
  return { ...r, attachments };
}

// Numbering is per client, per type, cumulative for the whole stay. Voided
// warnings KEEP their number (spec open-Q5: preserve the gap), so COUNT includes
// every warning of that type — nothing is renumbered.
// Next number = highest NON-voided number + 1, so a voided infraction doesn't use
// up a number (WW#1 voided → the next WW is #1 again). Uses MAX, not COUNT: with
// WW#1 active, WW#2 voided, WW#3 active a count would hand out #3 twice. Numbers
// already issued are never renumbered (they may be printed / signed).
function nextSeq(clientId, type) {
  const row = db.prepare(
    "SELECT MAX(seq_number) AS m FROM warnings WHERE client_id = ? AND type = ? AND status <> 'voided'"
  ).get(clientId, type);
  return (row.m || 0) + 1;
}

app.get("/api/warnings", (req, res) => {
  try {
    const where = [], params = [];
    if (req.query.type)      { where.push("w.type = ?");      params.push(String(req.query.type)); }
    if (req.query.status)    { where.push("w.status = ?");    params.push(String(req.query.status)); }
    if (req.query.client_id) { where.push("w.client_id = ?"); params.push(Number(req.query.client_id)); }
    const rows = db.prepare(
      `SELECT w.*, c.full_name AS client_name, c.phase AS client_phase, c.counselor AS client_counselor,
              r.label AS rule_label, r.code AS rule_code,
              (SELECT COUNT(*) FROM warning_edits we WHERE we.warning_id = w.id) AS edit_count,
              (SELECT MAX(edited_at) FROM warning_edits we WHERE we.warning_id = w.id) AS last_edited_at
       FROM warnings w JOIN clients c ON c.id = w.client_id LEFT JOIN rules r ON r.id = w.rule_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY w.issued_at DESC`
    ).all(...params);
    res.json({ data: rows.map(warningOut), error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

// Full warning history for one client (inline on the create form + counting).
app.get("/api/warnings/client/:clientId", (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT w.*, r.label AS rule_label, r.code AS rule_code
       FROM warnings w LEFT JOIN rules r ON r.id = w.rule_id
       WHERE w.client_id = ? ORDER BY w.issued_at DESC`
    ).all(req.params.clientId);
    res.json({ data: rows.map(warningOut), error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

// Preview the number a new warning would get (shown before saving).
app.get("/api/warnings/next", (req, res) => {
  try {
    const { client_id, type } = req.query;
    if (!client_id || !type) return res.json({ data: { next: null }, error: null });
    res.json({ data: { next: nextSeq(Number(client_id), String(type)) }, error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

app.post("/api/warnings", (req, res) => {
  try {
    const b = req.body || {};
    if (!b.client_id || !b.type) return res.status(400).json({ error: { message: "client_id and type are required" } });
    // Required on every new infraction (set 2026-10-26). Consequence fields are
    // required only when a consequence is chosen.
    const blank = (v) => !String(v ?? "").trim();
    const missing = [];
    if (!b.rule_id) missing.push("Rule");
    if (blank(b.occurred_at)) missing.push("Date");
    if (blank(b.shift)) missing.push("Shift");
    if (blank(b.narrative)) missing.push("What happened");
    const ct = b.consequence_type || "none";
    if (ct !== "none" && blank(b.consequence_due)) missing.push("Consequence due");
    if ((ct === "paper" || ct === "therapeutic") && blank(b.consequence_detail)) missing.push("Consequence detail");
    if (missing.length) return res.status(400).json({ error: { message: `Please fill in: ${missing.join(", ")}.` } });
    const type = String(b.type);
    if (!["VW", "WW", "WU"].includes(type)) return res.status(400).json({ error: { message: "type must be VW, WW or WU" } });

    // Count + insert atomically so two warnings can't grab the same number.
    const create = db.transaction((body) => {
      const seq = nextSeq(body.client_id, type);
      let phaseAtTime = body.phase_at_time;
      if (phaseAtTime === undefined || phaseAtTime === null) {
        const c = db.prepare("SELECT phase FROM clients WHERE id = ?").get(body.client_id);
        phaseAtTime = c ? c.phase : null;
      }
      const status = body.status ||
        (body.consequence_type && body.consequence_type !== "none" ? "consequence_open" : "issued");
      const cols = ["client_id", "rule_id", "type", "seq_number", "rule_detail", "occurred_at", "shift",
        "campus", "phase_at_time", "issued_by", "issued_by_initials", "narrative",
        "consequence_type", "consequence_detail", "consequence_due", "status", "attachments"];
      const vals = [
        body.client_id, body.rule_id || null, type, seq, body.rule_detail || null,
        body.occurred_at || null, body.shift || null, body.campus || null, phaseAtTime,
        body.issued_by || null, body.issued_by_initials || null, body.narrative || null,
        body.consequence_type || "none", body.consequence_detail || null, body.consequence_due || null,
        status, JSON.stringify(body.attachments || []),
      ];
      const info = db.prepare(`INSERT INTO warnings (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
      return db.prepare("SELECT * FROM warnings WHERE id = ?").get(info.lastInsertRowid);
    });
    const row = warningOut(create(b));

    // Auto log-book entry, linked both ways (appears in feed / unread / handoff).
    const client = db.prepare("SELECT full_name FROM clients WHERE id = ?").get(row.client_id);
    const rule = row.rule_id ? db.prepare("SELECT label FROM rules WHERE id = ?").get(row.rule_id) : null;
    const clientName = client ? client.full_name : "client";
    const ruleLabel = rule ? rule.label : "(rule)";
    const logNarr = `${row.type}#${row.seq_number} for ${clientName} — ${ruleLabel}` +
      (row.narrative ? `: ${row.narrative}` : "");
    const logId = createLinkedLogEntry({
      date: row.occurred_at, shift: row.shift, campus: row.campus,
      staff_name: row.issued_by, narrative: logNarr, warning_id: row.id,
    });
    db.prepare("UPDATE warnings SET logbook_entry_id = ? WHERE id = ?").run(logId, row.id);
    row.logbook_entry_id = logId;

    // Census reminder for written warnings / write-ups (verbal warnings skip it).
    if (row.type === "WW" || row.type === "WU") {
      notify(
        [{ user: row.issued_by, message: `Reminder: update the census for ${clientName} — ${row.type}#${row.seq_number}` }],
        "census_reminder", logId
      );
    }

    broadcastWarning();
    res.json({ data: [row], error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

// Advance a warning's consequence to completed — writes an auto log-book entry.
app.post("/api/warnings/:id/complete", (req, res) => {
  try {
    const b = req.body || {};
    const w = db.prepare("SELECT * FROM warnings WHERE id = ?").get(req.params.id);
    if (!w) return res.status(404).json({ error: { message: "Warning not found" } });
    db.prepare(
      "UPDATE warnings SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), completed_by = ?, completion_notes = ? WHERE id = ?"
    ).run(b.completed_by || null, b.completion_notes || null, w.id);

    const client = db.prepare("SELECT full_name FROM clients WHERE id = ?").get(w.client_id);
    const clientName = client ? client.full_name : "client";
    const cons = w.consequence_type && w.consequence_type !== "none" ? ` (${w.consequence_type})` : "";
    createLinkedLogEntry({
      date: null, shift: null, campus: w.campus, staff_name: b.completed_by || null,
      narrative: `Completed ${w.type}#${w.seq_number} consequence${cons} for ${clientName}`,
      warning_id: w.id,
    });
    broadcastWarning();
    res.json({ data: [warningOut(db.prepare("SELECT * FROM warnings WHERE id = ?").get(w.id))], error: null });
  } catch (err) { res.status(500).json({ error: { message: err.message } }); }
});

// Edit a warning (e.g. extend the consequence due date). Audited in
// warning_edits; a due-date change also drops a log-book entry so the
// extension is visible in the feed/handoff.
const WARNING_EDITABLE = ["rule_id", "occurred_at", "shift", "narrative",
  "consequence_type", "consequence_detail", "consequence_due"];

app.post("/api/warnings/:id/edit", (req, res) => {
  try {
    const b = req.body || {};
    const editor = b.editor || "Unknown";
    const fields = b.fields || {};
    const cur = db.prepare("SELECT * FROM warnings WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ data: null, error: { message: "Warning not found" } });

    const changes = {}, setCols = [], vals = [];
    for (const f of WARNING_EDITABLE) {
      if (fields[f] === undefined) continue;
      const nv = fields[f], ov = cur[f];
      if (String(nv ?? "") !== String(ov ?? "")) {
        changes[f] = { from: ov, to: nv };
        setCols.push(`${f} = ?`);
        vals.push(nv);
      }
    }
    if (!setCols.length) return res.json({ data: [warningOut(cur)], error: null });

    db.prepare(`UPDATE warnings SET ${setCols.join(", ")} WHERE id = ?`).run(...vals, cur.id);
    db.prepare("INSERT INTO warning_edits (warning_id, edited_by, changes) VALUES (?, ?, ?)")
      .run(cur.id, editor, JSON.stringify(changes));

    if (changes.consequence_due) {
      const client = db.prepare("SELECT full_name FROM clients WHERE id = ?").get(cur.client_id);
      const clientName = client ? client.full_name : "client";
      createLinkedLogEntry({
        date: null, shift: null, campus: cur.campus, staff_name: editor,
        narrative: `Due date for ${cur.type}#${cur.seq_number} (${clientName}) changed to ${changes.consequence_due.to || "—"}`,
        warning_id: cur.id,
      });
    }
    broadcastWarning();
    res.json({ data: [warningOut(db.prepare("SELECT * FROM warnings WHERE id = ?").get(cur.id))], error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

app.get("/api/warnings/:id/history", (req, res) => {
  try {
    const items = db.prepare(
      "SELECT id, edited_by, edited_at, changes FROM warning_edits WHERE warning_id = ? ORDER BY id DESC"
    ).all(req.params.id);
    res.json({ data: { items }, error: null });
  } catch (err) { res.status(500).json({ data: null, error: { message: err.message } }); }
});

// Close out a warning (final state).
app.post("/api/warnings/:id/close", (req, res) => {
  try {
    db.prepare("UPDATE warnings SET status = 'closed' WHERE id = ?").run(req.params.id);
    broadcastWarning();
    res.json({ data: [warningOut(db.prepare("SELECT * FROM warnings WHERE id = ?").get(req.params.id))], error: null });
  } catch (err) { res.status(500).json({ error: { message: err.message } }); }
});

// Void an infraction (admin delete) — soft + recoverable. Keeps the row and its
// seq number (the gap is preserved, per spec) and records who/when/why in the
// audit trail. The linked log-book entry is left as-is (historical record).
app.post("/api/warnings/:id/void", (req, res) => {
  try {
    const b = req.body || {};
    const cur = db.prepare("SELECT * FROM warnings WHERE id = ?").get(req.params.id);
    if (!cur) return res.status(404).json({ data: null, error: { message: "Warning not found" } });
    db.prepare("UPDATE warnings SET status = 'voided', voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?")
      .run(new Date().toISOString(), b.voided_by || null, b.void_reason || null, cur.id);
    db.prepare("INSERT INTO warning_edits (warning_id, edited_by, changes) VALUES (?, ?, ?)")
      .run(cur.id, b.voided_by || "Unknown",
        JSON.stringify({ status: { from: cur.status, to: "voided" }, reason: b.void_reason || null }));
    broadcastWarning();
    res.json({ data: [warningOut(db.prepare("SELECT * FROM warnings WHERE id = ?").get(cur.id))], error: null });
  } catch (err) { res.status(500).json({ error: { message: err.message } }); }
});

// ── Storage (attachments) ─────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Resolve a client-supplied relative path safely inside ATTACH_DIR (no traversal).
function safeAttachPath(rel) {
  const full = path.resolve(ATTACH_DIR, rel);
  if (full !== ATTACH_DIR && !full.startsWith(ATTACH_DIR + path.sep)) return null;
  return full;
}

app.post("/api/storage/attachments", upload.single("file"), (req, res) => {
  try {
    const rel = req.body.path;
    if (!rel || !req.file) {
      return res.status(400).json({ data: null, error: { message: "path and file are required" } });
    }
    const full = safeAttachPath(rel);
    if (!full) return res.status(400).json({ data: null, error: { message: "invalid path" } });
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, req.file.buffer);
    // Sidecar records the content-type so downloads open with the right MIME.
    const ct = req.body.contentType || req.file.mimetype || "application/octet-stream";
    fs.writeFileSync(full + ".type", ct);
    res.json({ data: { path: rel }, error: null });
  } catch (err) {
    res.status(500).json({ data: null, error: { message: err.message } });
  }
});

// Serve an attachment. The app reaches this via the "signed URL" the shim builds.
app.get("/api/storage/attachments/*", (req, res) => {
  const rel = decodeURIComponent(req.params[0] || "");
  const full = safeAttachPath(rel);
  if (!full || !fs.existsSync(full)) return res.status(404).send("Not found");
  let ct = "application/octet-stream";
  try { ct = fs.readFileSync(full + ".type", "utf8").trim() || ct; } catch {}
  res.set("Content-Type", ct);
  res.set("Content-Disposition", "inline");
  fs.createReadStream(full).pipe(res);
});

// ── On-prem scoring: anomaly flag · severity hint · event-type suggestion ─────
// No external services and no ML container. These are transparent, explainable
// statistics computed in-process from the facility's OWN historical narratives,
// so nothing ever leaves the NAS (42 CFR Part 2). They back the AI-assist hooks
// the frontend was written for (`/health`, `/predict`, `/anomaly-batch`).
const ML_STOP = new Set((
  "the a an and or of to in on at for with was were is are be been being has have had did do does " +
  "from by as that this then than so but not no yes about into out up down over under after before " +
  "while who whom which what when where why how he she they them his her their it its we you client staff"
).split(/\s+/));

function mlTokenize(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !ML_STOP.has(t));
}

// Severity hint — safety-first lexicon. Only ever RAISES a flag (High/Medium);
// it never returns "Low", so it can never falsely reassure staff that a serious
// incident is minor. Purely advisory; staff still set the real severity.
const SEV_HIGH = /\b(suicid\w*|overdose\w*|narcan|naloxone|unconscious|unrespons\w*|not breathing|seizure\w*|weapon\w*|knife|gun|assault\w*|strangl\w*|chok(?:e|ing)|collaps\w*|chest pain|ambulance|hospital\w*|911|self[\s-]?harm|cutting|died|death|fatal\w*|relaps\w*)/gi;
const SEV_MED = /\b(altercation\w*|argument\w*|verbal|agitat\w*|confront\w*|threat\w*|fight\w*|awol|elope\w*|left ama|left without|missing|contraband|theft|stole|stolen|curfew|intoxicat\w*|withdraw\w*|positive\s+(?:ua|uds|test))/gi;

function severityHint(text) {
  const s = String(text || "");
  const high = (s.match(SEV_HIGH) || []).length;
  if (high) return { severity: "High", severity_confidence: Math.min(0.6 + 0.1 * high, 0.95) };
  const med = (s.match(SEV_MED) || []).length;
  if (med) return { severity: "Medium", severity_confidence: Math.min(0.5 + 0.08 * med, 0.8) };
  return { severity: null, severity_confidence: 0 };
}

// Corpus model over all live narratives, rebuilt at most once a minute.
let _corpus = null, _corpusAt = 0;
function getCorpus() {
  if (_corpus && Date.now() - _corpusAt < 60000) return _corpus;
  const rows = db.prepare(
    "SELECT event_type, narrative FROM shift_log WHERE deleted_at IS NULL AND narrative IS NOT NULL AND narrative <> ''"
  ).all();
  const docFreq = new Map();   // token -> # narratives containing it
  const typeTok = new Map();   // event_type -> Map(token -> count)
  const typeTotal = new Map(); // event_type -> total tokens
  const typeDocs = new Map();  // event_type -> # narratives (prior)
  const vocab = new Set();
  const lengths = [];
  for (const r of rows) {
    const toks = mlTokenize(r.narrative);
    lengths.push(toks.length);
    for (const t of new Set(toks)) { docFreq.set(t, (docFreq.get(t) || 0) + 1); vocab.add(t); }
    const et = r.event_type || "Other";
    typeDocs.set(et, (typeDocs.get(et) || 0) + 1);
    if (!typeTok.has(et)) typeTok.set(et, new Map());
    const tm = typeTok.get(et);
    for (const t of toks) { tm.set(t, (tm.get(t) || 0) + 1); typeTotal.set(et, (typeTotal.get(et) || 0) + 1); vocab.add(t); }
  }
  const n = rows.length;
  const mean = n ? lengths.reduce((a, b) => a + b, 0) / n : 0;
  const varr = n ? lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0;
  _corpus = { n, docFreq, typeTok, typeTotal, typeDocs, V: vocab.size, lenMean: mean, lenStd: Math.sqrt(varr) };
  _corpusAt = Date.now();
  return _corpus;
}

// Multinomial Naive Bayes over the facility's own labelled narratives.
function suggestEventType(tokens, c) {
  if (c.n < 20 || c.typeDocs.size < 2 || !tokens.length) return { event_suggestion: null, event_confidence: 0 };
  const logs = [];
  for (const [et, tm] of c.typeTok) {
    const total = c.typeTotal.get(et) || 0;
    let lp = Math.log((c.typeDocs.get(et) || 0) / c.n);               // prior
    for (const t of tokens) lp += Math.log(((tm.get(t) || 0) + 1) / (total + c.V)); // add-1 smoothing
    logs.push([et, lp]);
  }
  logs.sort((a, b) => b[1] - a[1]);
  const max = logs[0][1];
  const denom = logs.reduce((s, [, lp]) => s + Math.exp(lp - max), 0);  // softmax over classes
  return { event_suggestion: logs[0][0], event_confidence: 1 / denom };
}

// Anomaly: dominated by words rarely seen before, or an extreme length outlier.
// Dormant until there is enough history, so it never cries wolf early.
function anomalyScore(tokens, c) {
  if (c.n < 30 || tokens.length < 6) return false;
  const rareCut = Math.max(1, Math.round(c.n * 0.02));
  const rareRatio = tokens.filter((t) => (c.docFreq.get(t) || 0) <= rareCut).length / tokens.length;
  const lenZ = c.lenStd ? (tokens.length - c.lenMean) / c.lenStd : 0;
  return rareRatio >= 0.65 || lenZ >= 3;
}

// Off unless ML_ENABLED=true is set in docker-compose (built 2026-10-12, not yet
// approved for production). While off, every /api/ml route answers 404.
app.use("/api/ml", (req, res, next) =>
  process.env.ML_ENABLED === "true" ? next() : res.status(404).json({ error: { message: "AI scoring is disabled" } }));
app.get("/api/ml/health", (req, res) => res.json({ ok: true }));

app.post("/api/ml/predict", (req, res) => {
  try {
    const narrative = String((req.body && req.body.narrative) || "");
    const c = getCorpus();
    const tokens = mlTokenize(narrative);
    const sev = severityHint(narrative);
    const ev = suggestEventType(tokens, c);
    res.json({
      severity: sev.severity,
      severity_confidence: sev.severity_confidence,
      event_suggestion: ev.event_suggestion,
      event_confidence: ev.event_confidence,
      is_anomaly: anomalyScore(tokens, c),
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.post("/api/ml/anomaly-batch", (req, res) => {
  try {
    const items = Array.isArray(req.body && req.body.narratives) ? req.body.narratives : [];
    const c = getCorpus();
    res.json(items.map((it) => ({ id: it.id, is_anomaly: anomalyScore(mlTokenize(it.text), c) })));
  } catch (err) {
    res.status(500).json([]);
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ ok: true, clients: sseClients.size }));

// ── Static frontend (served by this same container) ──────────────────────────
app.use(express.static(WEB_DIR, { extensions: ["html"] }));
// SPA-style fallback: any non-API GET returns the app shell.
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(WEB_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Shift Log backend on :${PORT}  (web=${WEB_DIR}, data=${DATA_DIR})`);
});
