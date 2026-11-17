/**
 * db-shim.js — drop-in replacement for the supabase-js client.
 *
 * Exposes a global `supabase.createClient()` that returns an object mimicking
 * the exact subset of the supabase-js API the Shift Log app uses:
 *
 *   db.from(table).select().order().eq().in().gte()   -> awaitable {data,error}
 *   db.from(table).insert(obj)                         -> awaitable {data,error}
 *   db.from(table).update(obj).eq('id', id)            -> awaitable {data,error}
 *   db.storage.from(bucket).upload(path, file, opts)   -> {data,error}
 *   db.storage.from(bucket).createSignedUrl(path, ttl) -> {data:{signedUrl},error}
 *   db.channel(name).on('postgres_changes', filter, cb).subscribe()
 *
 * Backed by the self-hosted API on the same origin (see backend/server.js).
 * Network failures reject (so the app's offline-queue path still triggers);
 * server-level problems resolve as {error} — same contract as supabase-js.
 */
(function () {
  "use strict";

  const API = ""; // same-origin; requests go to /api/...

  // ── Query builder (thenable) ───────────────────────────────────────────────
  class Query {
    constructor(table) {
      this.table = table;
      this._method = "select";
      this._payload = null;
      this._filters = {}; // col -> {op, val}
      this._order = null;
      this._select = "*";
    }
    select(cols) { this._method = "select"; this._select = cols || "*"; return this; }
    insert(obj) { this._method = "insert"; this._payload = obj; return this; }
    update(obj) { this._method = "update"; this._payload = obj; return this; }
    order(col, opts) { this._order = { col, ascending: opts ? opts.ascending !== false : true }; return this; }
    eq(col, val) { this._filters[col] = { op: "eq", val }; return this; }
    in(col, arr) { this._filters[col] = { op: "in", val: arr }; return this; }
    gte(col, val) { this._filters[col] = { op: "gte", val }; return this; }

    then(onFulfilled, onRejected) { return this._run().then(onFulfilled, onRejected); }
    catch(onRejected) { return this._run().catch(onRejected); }

    async _run() {
      const t = this.table;

      // shift_log --------------------------------------------------------------
      if (t === "shift_log") {
        if (this._method === "insert") {
          return jsonFetch("/api/shift_log", { method: "POST", body: this._payload });
        }
        if (this._method === "update") {
          const id = this._filters.id && this._filters.id.val;
          return jsonFetch(`/api/shift_log/${encodeURIComponent(id)}`, { method: "PATCH", body: this._payload });
        }
        // select
        const qs = new URLSearchParams();
        if (this._filters.created_at && this._filters.created_at.op === "gte") {
          qs.set("since", this._filters.created_at.val);
        }
        const q = qs.toString();
        return jsonFetch(`/api/shift_log${q ? "?" + q : ""}`);
      }

      // entry_comments ---------------------------------------------------------
      if (t === "entry_comments") {
        if (this._method === "insert") {
          return jsonFetch("/api/entry_comments", { method: "POST", body: this._payload });
        }
        // select — either .in('entry_id', ids) (counts) or .eq('entry_id', id) (thread)
        if (this._filters.entry_id && this._filters.entry_id.op === "in") {
          const ids = (this._filters.entry_id.val || []).join(",");
          return jsonFetch(`/api/entry_comments?entry_ids=${encodeURIComponent(ids)}`);
        }
        const id = this._filters.entry_id && this._filters.entry_id.val;
        return jsonFetch(`/api/entry_comments?entry_id=${encodeURIComponent(id)}`);
      }

      return { data: null, error: { message: `Unknown table: ${t}` } };
    }
  }

  // Resolves to {data,error}; rejects only on network failure (TypeError),
  // which the app treats as "offline" and queues the write.
  async function jsonFetch(url, opts) {
    opts = opts || {};
    const init = { method: opts.method || "GET", headers: {} };
    if (opts.body !== undefined && opts.body !== null) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(API + url, init); // network error -> throws -> offline path
    let json;
    try { json = await res.json(); } catch { json = { data: null, error: { message: `HTTP ${res.status}` } }; }
    if (!res.ok && !json.error) json.error = { message: `HTTP ${res.status}` };
    return json;
  }

  // ── Storage ────────────────────────────────────────────────────────────────
  function storageFrom(_bucket) {
    return {
      async upload(filePath, file, opts) {
        opts = opts || {};
        const fd = new FormData();
        fd.append("path", filePath);
        if (opts.contentType) fd.append("contentType", opts.contentType);
        fd.append("file", file, (file && file.name) || "file");
        const res = await fetch(API + "/api/storage/attachments", { method: "POST", body: fd });
        let json;
        try { json = await res.json(); } catch { json = { data: null, error: { message: `HTTP ${res.status}` } }; }
        if (!res.ok && !json.error) json.error = { message: `HTTP ${res.status}` };
        return json;
      },
      // No round-trip needed: the file is served directly by path.
      async createSignedUrl(filePath, _expiresIn) {
        const enc = String(filePath).split("/").map(encodeURIComponent).join("/");
        return { data: { signedUrl: `${location.origin}/api/storage/attachments/${enc}` }, error: null };
      },
    };
  }

  // ── Realtime via Server-Sent Events ────────────────────────────────────────
  function channel(_name) {
    const handlers = [];
    let es = null;
    const ch = {
      on(_event, _filter, cb) { handlers.push(cb); return ch; },
      subscribe() {
        try {
          es = new EventSource(API + "/api/events");
          es.onmessage = (e) => {
            let payload;
            try { payload = JSON.parse(e.data); } catch { return; }
            handlers.forEach((h) => { try { h(payload); } catch {} });
          };
        } catch { /* realtime unavailable — app degrades to manual refresh */ }
        return ch;
      },
      unsubscribe() { if (es) es.close(); es = null; return Promise.resolve({ error: null }); },
    };
    return ch;
  }

  // ── Client factory (matches supabase.createClient signature) ───────────────
  function createClient(_url, _key) {
    return {
      from(table) { return new Query(table); },
      storage: { from: storageFrom },
      channel,
      removeChannel(ch) { return ch && ch.unsubscribe ? ch.unsubscribe() : Promise.resolve({ error: null }); },
    };
  }

  window.supabase = { createClient };
})();
