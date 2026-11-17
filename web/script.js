// ── Refresh → clear cache + force re-login ────────────────
// On a page reload we wipe every SW cache, unregister the service worker,
// and sign out of Supabase so the login screen always reappears fresh.
(function handleRefresh() {
  const nav = performance.getEntriesByType?.("navigation")?.[0];
  const isReload = nav ? nav.type === "reload" : performance.navigation?.type === 1;
  if (!isReload) return;

  if ("caches" in window) {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(r => r.unregister()));
  }
  sessionStorage.clear();
})();

// ── Supabase config ── replace these two with your project's values
// (Supabase dashboard → Project Settings → API)
const SUPABASE_URL      = "";   // unused: db-shim.js talks to the self-hosted API
const SUPABASE_ANON_KEY = "";

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SESSION_KEY = "shiftlog_auth";
const NAME_KEY    = "shiftlog_staff_name";

// ── Staff directory — add / edit PINs here ────────────────
// PIN → { name, role }   role: "admin" | "staff"
// Admins can resolve follow-ups. Staff can submit, view, and comment.
const USERS = {
  // DEMO ACCOUNTS ONLY. The production deployment keeps its own PIN table out
  // of source control. Change these before any real use.
  // Administrators
  "1111": { name: "Alex Admin",       role: "admin" },
  "2222": { name: "Jordan Lee",       role: "admin" },
  // Staff — BHTs
  "3333": { name: "Sam Rivera",       role: "staff" },
  "4444": { name: "Taylor Morgan",    role: "staff" },
  "5555": { name: "Casey Brooks",     role: "staff" },
  // Shared basic account
  "6666": { name: "Clinicians",       role: "staff" },
  // Restricted account — can submit + view ONLY "Client Location" entries;
  // Dashboard / Handoff / Rule Infractions tabs are hidden for it.
  "7777": { name: "Front Desk",       role: "staff", onlyEventType: "Client Location" },
};
const CAMPUS_KEY  = "shiftlog_campus";      // remembers the last campus per-device
const CACHE_KEY   = "shiftlog_cache";       // last-fetched entries, for offline viewing

const ATTACH_BUCKET = "attachments";        // Supabase Storage bucket for uploaded files
const IDB_NAME      = "shiftlog-offline";   // IndexedDB database for the offline queue
const IDB_STORE     = "pending";

// AI assist — scoring is served by the app's own backend (same origin, on the
// NAS). No external service and nothing leaves the building. Endpoints live under
// /api/ml (/health, /predict, /anomaly-batch). Set ML_ENABLED = false to hide it.
// The app degrades gracefully if the endpoints are unreachable.
const ML_ENABLED = false;   // off until approved — to enable, set true here AND ML_ENABLED=true in docker-compose
const ML_API = "/api/ml";

// ── Dark mode ─────────────────────────────────────────────
const THEME_KEY = "shiftlog_theme";

function applyTheme(theme, animate) {
  if (animate) {
    document.body.classList.add("theme-transitioning");
    setTimeout(() => document.body.classList.remove("theme-transitioning"), 300);
  }
  document.documentElement.setAttribute("data-theme", theme);

  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";

  // Keep Chart.js tick/grid colours in sync if the library is loaded
  if (typeof Chart !== "undefined") {
    Chart.defaults.color       = theme === "dark" ? "#94a3b8" : "#64748b";
    Chart.defaults.borderColor = theme === "dark" ? "#334155" : "#dde2ea";
    // Re-render the dashboard if it is currently visible so charts pick up new colours
    const dash = document.getElementById("tab-dashboard");
    if (dash && !dash.classList.contains("hidden")) renderDashboard();
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next    = current === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next, true);
}

// Restore saved preference (or respect system preference) immediately on load
(function () {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) {
    applyTheme(saved, false);
  } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    applyTheme("dark", false);
  }
})();

// ── PWA service worker ────────────────────────────────────
// Register for offline support. On refresh the handleRefresh() block above
// already unregisters the old SW and clears caches, so this re-registers
// cleanly and fetches fresh assets from the network.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js")
      .catch(() => {/* offline support unavailable */});
  });
}

// ── PIN Auth ──────────────────────────────────────────────

let currentProfile = null;

function checkPin() {
  const input = document.getElementById("pin-input").value.trim();
  const user  = USERS[input];
  const err   = document.getElementById("pin-error");
  if (user) {
    currentProfile = { full_name: user.name, role: user.role, onlyEventType: user.onlyEventType || null };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(currentProfile));
    err.classList.add("hidden");
    showApp();
  } else {
    err.textContent = "Incorrect PIN. Try again.";
    err.classList.remove("hidden");
    document.getElementById("pin-input").value = "";
    document.getElementById("pin-input").focus();
  }
}

// `idle` = true when the sign-out was triggered by the inactivity timer, so the
// gate explains why the user was signed out.
function logout(idle) {
  if (_activeTab === "log") markLogSeen();   // record what was seen before signing out
  hideIdleWarning();
  // Park this user's unsent entry as their draft, then blank the form — on a
  // shared device the next person to sign in must never see it.
  flushDraft();
  resetEntryForm();
  _activeTab = "submit";
  currentProfile = null;
  stopIdleTimer();
  sessionStorage.removeItem(SESSION_KEY);
  document.getElementById("app").classList.add("hidden");
  document.getElementById("pin-gate").classList.remove("hidden");
  document.getElementById("pin-input").value = "";
  const err = document.getElementById("pin-error");
  if (idle === true) {
    err.textContent = "Signed out after 10 minutes of inactivity. Enter your PIN to continue.";
    err.classList.remove("hidden");
  } else {
    err.classList.add("hidden");
  }
  document.getElementById("user-info").classList.add("hidden");
}

function showApp() {
  document.getElementById("pin-gate").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");

  // Show name + role badge in header
  const name = currentProfile?.full_name || "";
  const role = currentProfile?.role || "staff";
  document.getElementById("user-name").textContent       = name;
  document.getElementById("user-role-badge").textContent = role === "admin" ? "Admin" : "Staff";
  document.getElementById("user-role-badge").className   = `role-badge role-${role}`;
  document.getElementById("user-info").classList.remove("hidden");

  applyRoleUI();
  applyAccessUI();
  setDefaults();
  restoreDraft();      // bring back this user's unsent entry, if any
  updateNetStatus();
  refreshPending();
  flushQueue();
  subscribeRealtime();
  checkApiHealth();
  _activeTab = "submit";
  initUnreadBadge();   // show the unread count on the View Log tab right after login
  loadNotifications(); // populate the notification bell
  startIdleTimer();    // begin the inactivity auto-logout clock
  refreshHandoffBadge(); // flag handoffs waiting for this user to receive
}

// ── Inactivity auto-logout ────────────────────────────────
// Signs a user out after a period of no interaction — important on shared
// stations handling client (42 CFR Part 2) records. Uses a wall-clock deadline
// checked on an interval, so it fires correctly even after the tab was
// backgrounded (where setTimeout is throttled).
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;   // 10 minutes
const IDLE_WARN_MS    = 60 * 1000;        // show a countdown for the last minute
let _idleDeadline = 0;
let _idleInterval = null;
let _idleLastBump = 0;
let _idleTicker   = null;                 // 1s countdown while the warning is up

function bumpIdle() {
  if (!currentProfile) return;
  _idleDeadline = Date.now() + IDLE_TIMEOUT_MS;
}
function startIdleTimer() {
  bumpIdle();
  if (!_idleInterval) _idleInterval = setInterval(checkIdle, 15000);   // check every 15s
}
function stopIdleTimer() {
  if (_idleInterval) { clearInterval(_idleInterval); _idleInterval = null; }
}
function checkIdle() {
  if (!currentProfile) { stopIdleTimer(); hideIdleWarning(); return; }
  const left = _idleDeadline - Date.now();
  if (left <= 0) { logout(true); return; }
  if (left <= IDLE_WARN_MS) showIdleWarning(left);
  else hideIdleWarning();
}
// "Signing out in Ns" banner. Any activity (or the button) pushes the deadline
// out, and the next tick hides it again.
function showIdleWarning(left) {
  const el = document.getElementById("idle-warning");
  if (!el) return;
  document.getElementById("idle-countdown").textContent = Math.max(1, Math.ceil(left / 1000));
  el.classList.remove("hidden");
  if (!_idleTicker) _idleTicker = setInterval(checkIdle, 1000);
}
function hideIdleWarning() {
  const el = document.getElementById("idle-warning");
  if (el) el.classList.add("hidden");
  if (_idleTicker) { clearInterval(_idleTicker); _idleTicker = null; }
}
function stayActive() {
  bumpIdle();
  hideIdleWarning();
}
// Throttled activity handler — any real interaction pushes the deadline out.
function onUserActivity() {
  const now = Date.now();
  if (now - _idleLastBump < 1000) return;
  _idleLastBump = now;
  bumpIdle();
}
["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"].forEach(ev =>
  window.addEventListener(ev, onUserActivity, { passive: true }));
// Coming back to a backgrounded tab re-checks the deadline immediately.
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkIdle(); });

function applyRoleUI() {
  const isAdmin = currentProfile?.role === "admin";
  // Resolving follow-ups is open to all staff (not just admins).
  document.querySelectorAll(".admin-only").forEach(el => {
    el.style.display = isAdmin ? "" : "none";
  });
}

// Restricted accounts (currentProfile.onlyEventType) can only submit + view one
// event type (e.g. "Client Location"). Hide the other tabs, and lock the event
// type on both the Submit form and the Log filter.
function restrictedType() { return currentProfile && currentProfile.onlyEventType; }

function applyAccessUI() {
  const only = restrictedType();
  // Tabs that a restricted user should not see at all.
  const HIDDEN_FOR_RESTRICTED = ["dashboard", "handoff", "warnings"];
  document.querySelectorAll("nav .tab-btn[data-tab]").forEach(btn => {
    const t = btn.getAttribute("data-tab");
    btn.style.display = (only && HIDDEN_FOR_RESTRICTED.includes(t)) ? "none" : "";
  });
  // Lock the Submit form's Event Type to the allowed one.
  const ev = document.getElementById("event-type");
  if (ev) {
    if (only) { ev.value = only; ev.disabled = true; ev.title = "Your account can only log " + only + " entries"; }
    else { ev.disabled = false; ev.title = ""; }
  }
  // Lock the View Log's Event Type filter to the allowed one.
  const fe = document.getElementById("filter-event");
  if (fe) {
    if (only) { fe.value = only; fe.disabled = true; }
    else { fe.disabled = false; }
  }
}

// Allow Enter key on PIN input
document.getElementById("pin-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") checkPin();
});

// Restore session if still active (cleared on refresh by design)
const _saved = sessionStorage.getItem(SESSION_KEY);
if (_saved) { try { currentProfile = JSON.parse(_saved); showApp(); } catch {} }

// ── Tabs ──────────────────────────────────────────────────

let _activeTab = "submit";
function switchTab(tab) {
  // Restricted accounts can only reach Submit + View Log.
  if (restrictedType() && ["dashboard", "handoff", "warnings"].includes(tab)) tab = "log";
  if (_activeTab === "log" && tab !== "log") markLogSeen();  // leaving the log = caught up
  _activeTab = tab;
  document.querySelectorAll(".tab-content").forEach(el => el.classList.add("hidden"));
  document.querySelectorAll(".tab-btn").forEach(el => el.classList.remove("active"));
  document.getElementById(`tab-${tab}`).classList.remove("hidden");
  const btn = document.querySelector(`.tab-btn[onclick*="'${tab}'"]`);
  if (btn) btn.classList.add("active");
  if (tab === "submit")  { checkApiHealth(); applyStaffName(); }
  if (tab === "log")       loadLog();
  if (tab === "dashboard") renderDashboard();
  if (tab === "handoff")   initHandoff();
  if (tab === "warnings")  renderWarnings();
}

// ── Supabase Realtime ─────────────────────────────────────
// Subscribe once after login; re-fetches entries and re-renders live whenever
// any row on shift_log changes (INSERT / UPDATE / DELETE).

let _realtimeChannel = null;

function subscribeRealtime() {
  if (_realtimeChannel) return;
  try {

  _realtimeChannel = db
    .channel("shift_log_live")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "shift_log" },
      async (payload) => {
        // Notification signal: only act if this user is a recipient.
        if (payload && payload.kind === "notification") {
          if (Array.isArray(payload.recipients) && payload.recipients.includes(currentUserKey())) {
            await loadNotifications();
            const newest = _notifs.find(n => !n.read);
            if (newest) showRealtimeToast(newest.message);
          }
          return;
        }

        // Warning changed: refresh the Warnings tab if it's open.
        if (payload && payload.kind === "handoff") {
          if (_activeTab === "handoff") loadHandoffs(); else refreshHandoffBadge();
          return;
        }
        if (payload && payload.kind === "warning") {
          if (_activeTab === "warnings") renderWarnings();
          return;
        }

        await fetchEntries();
        renderUnreadUI();   // keep the unread count fresh even on other tabs

        // Refresh whichever tab is currently visible
        const logVisible  = !document.getElementById("tab-log").classList.contains("hidden");
        const dashVisible = !document.getElementById("tab-dashboard").classList.contains("hidden");
        const hoVisible   = !document.getElementById("tab-handoff").classList.contains("hidden");

        if (logVisible)  applyFilters();
        if (dashVisible) renderDashboard();
        if (hoVisible)   generateHandoff();

        // Toast notification
        if (payload.eventType === "INSERT") {
          const et = payload.new?.event_type ?? "entry";
          showRealtimeToast(`New ${et} entry added`);
        }
      }
    )
    .subscribe();
  } catch (e) {
    // Realtime not configured for this table — live updates silently disabled.
    _realtimeChannel = null;
  }
}

function showRealtimeToast(msg) {
  const toast = document.getElementById("rt-toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3000);
}

// ── ML Assist Panel ───────────────────────────────────────
// Calls the FastAPI service while the user types the narrative.
// Degrades silently when the API is not running.

let _mlDebounce = null;
let _apiOnline   = false;

// Check the ML API health endpoint and update the status badge.
async function checkApiHealth() {
  const el = document.getElementById("ai-status");
  if (!el) return;
  if (!ML_ENABLED) { el.style.display = "none"; return; }  // AI features off in this deployment
  setAiStatus("checking");
  try {
    const res = await fetch(`${ML_API}/health`, { method: "GET", signal: AbortSignal.timeout(2500) });
    _apiOnline = res.ok;
  } catch {
    _apiOnline = false;
  }
  setAiStatus(_apiOnline ? "online" : "offline");
}

function setAiStatus(state) {
  const el = document.getElementById("ai-status");
  if (!el) return;
  el.className = `ai-status ai-${state}`;
  const textMap = { online: "AI online", offline: "AI offline", checking: "AI checking…" };
  const tipMap  = {
    online:   "AI predictions active",
    offline:  "AI server offline — run: cd ml && uvicorn api:app --reload",
    checking: "Connecting to AI server…",
  };
  el.querySelector(".ai-status-text").textContent = textMap[state] ?? state;
  el.title = tipMap[state] ?? "";
}

document.getElementById("narrative").addEventListener("input", (e) => {
  clearTimeout(_mlDebounce);
  const text = e.target.value.trim();
  if (text.length < 10) { hideMlPanel(); return; }
  // Show loading state immediately while waiting for the API
  showMlLoading();
  _mlDebounce = setTimeout(() => callMlApi(text), 600);
});

// Re-run when the event-type selector changes (severity depends on it)
document.getElementById("event-type").addEventListener("change", () => {
  const text = document.getElementById("narrative").value.trim();
  if (text.length >= 10) callMlApi(text);
});

function showMlLoading() {
  if (!ML_ENABLED) return;                                 // AI features off in this deployment
  const panel   = document.getElementById("ml-panel");
  const loading = document.getElementById("ml-loading");
  const sevEl   = document.getElementById("ml-sev-pill");
  const evEl    = document.getElementById("ml-ev-chip");
  if (!panel) return;
  if (sevEl)   { sevEl.className = ""; sevEl.innerHTML = ""; }
  if (evEl)    evEl.classList.add("hidden");
  if (loading) loading.classList.remove("hidden");
  panel.classList.remove("hidden");
}

async function callMlApi(narrative) {
  if (!ML_ENABLED) return;                                 // AI features off in this deployment
  const eventType = document.getElementById("event-type").value || "Other";
  try {
    const res = await fetch(`${ML_API}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ narrative, event_type: eventType }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const d = await res.json();
    _apiOnline = true;
    setAiStatus("online");
    showMlPanel(d);
  } catch {
    _apiOnline = false;
    setAiStatus("offline");
    hideMlPanel();
  }
}

let _mlSeverity = null;   // tracks the last AI-predicted severity for the current form entry

function showMlPanel(d) {
  const loading = document.getElementById("ml-loading");
  if (loading) loading.classList.add("hidden");
  const panel = document.getElementById("ml-panel");
  _mlSeverity = d.severity || null;

  // Severity pill
  const sevEl = document.getElementById("ml-sev-pill");
  if (d.severity) {
    const pct = Math.round(d.severity_confidence * 100);
    sevEl.className = `ml-sev-pill ${d.severity}`;
    sevEl.innerHTML = `${d.severity} <span class="ml-sev-label">${pct}%</span>`;
  } else {
    sevEl.className = "";
    sevEl.innerHTML = "";
  }

  // Event-type suggestion chip
  const evEl = document.getElementById("ml-ev-chip");
  const currentType = document.getElementById("event-type").value;
  if (d.event_suggestion && d.event_confidence > 0.45 && d.event_suggestion !== currentType) {
    const pct = Math.round(d.event_confidence * 100);
    evEl.className = "ml-ev-chip";
    evEl.innerHTML = `Try: <span class="ml-ev-chip-accept">${escapeHtml(d.event_suggestion)}</span> (${pct}%)`;
    evEl.onclick = () => {
      document.getElementById("event-type").value = d.event_suggestion;
      evEl.classList.add("hidden");
      // Re-run with updated event type
      callMlApi(document.getElementById("narrative").value.trim());
    };
    evEl.classList.remove("hidden");
  } else {
    evEl.classList.add("hidden");
  }

  // Anomaly flag
  const anomEl = document.getElementById("ml-anomaly-flag");
  if (d.is_anomaly) {
    anomEl.classList.remove("hidden");
  } else {
    anomEl.classList.add("hidden");
  }

  panel.classList.remove("hidden");
}

function hideMlPanel() {
  _mlSeverity = null;
  document.getElementById("ml-panel")?.classList.add("hidden");
}

// ── Form Submission ───────────────────────────────────────

// Map a time to its shift. Accepts a "HH:MM" string, a Date, or nothing (= now).
// Day 05:30–14:29, Evening 14:30–22:29, Overnight 22:30–05:29
function shiftForTime(input = new Date()) {
  let mins;
  if (input instanceof Date) {
    mins = input.getHours() * 60 + input.getMinutes();
  } else {
    if (!input) return "";
    const [h, m] = String(input).split(":").map(Number);
    if (isNaN(h)) return "";
    mins = h * 60 + (m || 0);
  }
  if (mins >= 330 && mins < 870)  return "Day";       // 05:30–14:29
  if (mins >= 870 && mins < 1350) return "Evening";   // 14:30–22:29
  return "Overnight";                                 // 22:30–05:29
}

// Pre-fill date, current time, and the matching shift.
// Force the Name field to the signed-in account and lock it. Called at login,
// after submit, and whenever the Submit tab is shown — so a browser-autofilled
// or leftover value from a previous user on a shared device can't stick.
function applyStaffName() {
  const nameEl = document.getElementById("staff-name");
  if (!nameEl) return;
  const profileName = currentProfile && currentProfile.full_name;
  if (profileName) {
    nameEl.value    = profileName;
    nameEl.readOnly = true;
    nameEl.title    = "Name is set by your account";
  } else {
    if (!nameEl.value) nameEl.value = localStorage.getItem(NAME_KEY) || "";
    nameEl.readOnly = false;
    nameEl.title    = "";
  }
}

function setDefaults() {
  const now = new Date();

  const yyyy = now.getFullYear();
  const mo   = String(now.getMonth() + 1).padStart(2, "0");
  const da   = String(now.getDate()).padStart(2, "0");
  document.getElementById("date").value = `${yyyy}-${mo}-${da}`;

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const t  = `${hh}:${mm}`;
  document.getElementById("time").value  = t;
  document.getElementById("shift").value = shiftForTime(t);

  applyStaffName();

  // Remember campus preference
  const savedCampus = currentProfile?.campus || localStorage.getItem(CAMPUS_KEY);
  if (savedCampus) document.getElementById("campus").value = savedCampus;
}

// ── Submit-form drafts + duplicate-submit guard ───────────
// Each entry being written gets a client_uuid. It is sent with the insert (and
// kept with offline-queued rows), so retrying the same entry — after an error,
// a refresh, or a queue flush — returns the stored row instead of a duplicate.
// The unsent form is saved as a per-user draft on the NAS (not in browser
// storage, since stations are shared) and restored on next sign-in.
const DRAFT_FIELDS = ["date", "shift", "time", "campus", "event-type", "narrative", "followup", "followup-notes"];
let _entryUuid = newUuid();
let _draftTimer = null;
let _draftDirty = false;

function newUuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function draftHasContent() {
  return !!(document.getElementById("narrative").value.trim() ||
            document.getElementById("followup-notes").value.trim());
}

function fmtClock(d) {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function renderDraftNote(text) {
  const el = document.getElementById("draft-note");
  if (!el) return;
  if (!text) { el.classList.add("hidden"); return; }
  document.getElementById("draft-note-text").textContent = text;
  el.classList.remove("hidden");
}

function scheduleDraftSave() {
  if (!currentProfile) return;
  _draftDirty = true;
  clearTimeout(_draftTimer);
  _draftTimer = setTimeout(flushDraft, 1500);
}

// Save now (debounced saves, sign-out, page hide). Empty form = no draft.
function flushDraft() {
  clearTimeout(_draftTimer);
  const user = currentUserKey();
  if (!user || !_draftDirty) return;
  _draftDirty = false;
  if (!draftHasContent()) {
    fetch(`/api/drafts?user=${encodeURIComponent(user)}`, { method: "DELETE", keepalive: true }).catch(() => {});
    renderDraftNote("");
    return;
  }
  const fields = {};
  DRAFT_FIELDS.forEach(id => { fields[id] = document.getElementById(id).value; });
  fetch("/api/drafts", {
    method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, data: { uuid: _entryUuid, fields } }),
  }).then(r => { if (r.ok) renderDraftNote(`Draft saved ${fmtClock(new Date())}`); })
    .catch(() => { _draftDirty = true; });   // offline — try again on the next change
}

async function restoreDraft() {
  const user = currentUserKey();
  if (!user) return;
  try {
    const r = await fetch(`/api/drafts?user=${encodeURIComponent(user)}`).then(x => x.json());
    const d = r && r.data;
    if (!d || !d.fields || currentUserKey() !== user) return;
    DRAFT_FIELDS.forEach(id => {
      if (id === "event-type" && restrictedType()) return;   // locked for restricted accounts
      if (d.fields[id] != null) document.getElementById(id).value = d.fields[id];
    });
    if (d.uuid) _entryUuid = d.uuid;
    renderDraftNote(`Draft restored from ${fmtClock(new Date(d.updated_at))}`);
  } catch { /* no draft or offline — start fresh */ }
}

function clearDraft() {
  clearTimeout(_draftTimer);
  _draftDirty = false;
  renderDraftNote("");
  const user = currentUserKey();
  if (user) fetch(`/api/drafts?user=${encodeURIComponent(user)}`, { method: "DELETE" }).catch(() => {});
}

// Blank the Submit form and start a new entry id (after submit / discard / sign-out).
function resetEntryForm() {
  document.getElementById("entry-form").reset();
  _entryUuid = newUuid();
  _draftDirty = false;
  clearTimeout(_draftTimer);
  renderDraftNote("");
  hideMlPanel();
}

function discardDraft() {
  if (!confirm("Discard this draft? What you've typed will be cleared.")) return;
  clearDraft();
  resetEntryForm();
  setDefaults();
  applyAccessUI();
}

["input", "change"].forEach(ev =>
  document.getElementById("entry-form").addEventListener(ev, scheduleDraftSave));
// Leaving / hiding the page saves immediately (keepalive lets it finish).
window.addEventListener("pagehide", flushDraft);
document.addEventListener("visibilitychange", () => { if (document.hidden) flushDraft(); });

// Keep the shift in sync if the user edits the time manually.
document.getElementById("time").addEventListener("input", (e) => {
  if (e.target.value) document.getElementById("shift").value = shiftForTime(e.target.value);
});

document.getElementById("entry-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("submit-btn");
  const statusEl = document.getElementById("form-status");

  btn.disabled = true;
  btn.textContent = "Submitting...";
  statusEl.classList.add("hidden");
  statusEl.className = "status-msg hidden";

  const form = e.target;
  const row = {
    date:             form.date.value,
    shift:            form.shift.value,
    time:             form.time.value,
    staff_name:       form.staffName.value.trim(),
    campus:           form.campus.value,
    event_type:       form.eventType.value,
    narrative:        form.narrative.value.trim(),
    follow_up_needed: form.followUpNeeded.value,
    follow_up_notes:  form.followUpNotes.value.trim(),
    severity: _mlSeverity || null,
    client_uuid: _entryUuid,   // same id on every retry of this entry → no duplicates
  };

  const files = Array.from(document.getElementById("attach-input").files || []);

  // Remember campus preference (name comes from auth profile, no need to store it)
  if (row.campus) localStorage.setItem(CAMPUS_KEY, row.campus);

  try {
    if (!navigator.onLine) throw { __offline: true };

    const attachments = await uploadFiles(files);
    const { error } = await db.from("shift_log").insert({ ...row, attachments });
    if (error) throw error;

    statusEl.textContent = files.length
      ? `Entry submitted with ${files.length} attachment${files.length > 1 ? "s" : ""}.`
      : "Entry submitted successfully.";
    statusEl.className = "status-msg success";
    clearDraft();
    resetEntryForm();
    setDefaults();
  } catch (err) {
    if (err && (err.__offline || isNetworkError(err))) {
      // No connection — queue the entry (and its files) locally to sync later.
      try {
        await idbAdd({ row, files });
        await refreshPending();
        statusEl.textContent = "Saved offline — this entry will sync automatically when you're back online.";
        statusEl.className = "status-msg success";
        clearDraft();
        resetEntryForm();
        setDefaults();
      } catch (qerr) {
        statusEl.textContent = `Could not save offline: ${qerr.message}`;
        statusEl.className = "status-msg error-msg";
      }
    } else {
      statusEl.textContent = `Submission failed: ${err.message}. Your entry is still here — submitting again won't create a duplicate.`;
      statusEl.className = "status-msg error-msg";
    }
  } finally {
    statusEl.classList.remove("hidden");
    btn.disabled = false;
    btn.textContent = "Submit Entry";
  }
});

// ── Helpers ───────────────────────────────────────────────

// Escape user-supplied text before inserting into HTML (prevents XSS / broken markup).
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Turn an event type into a safe CSS class suffix, e.g. "General Note" -> "general-note".
function slug(str) {
  return String(str || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function fmtDate(iso) {
  if (!iso) return "";
  const s = String(iso);
  // A plain "YYYY-MM-DD" must be read as a LOCAL date — new Date() treats it as
  // UTC midnight, which displays as the day before in negative-offset zones (MST).
  // Full timestamps (with a time/zone) parse normally.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// True for fetch/connection failures, so we can fall back to the offline queue.
function isNetworkError(err) {
  if (!err) return false;
  if (err.name === "TypeError") return true;            // e.g. "Failed to fetch"
  const m = (err.message || "").toLowerCase();
  return m.includes("failed to fetch") || m.includes("network") || m.includes("load failed");
}

// ── Log View ──────────────────────────────────────────────

let allEntries = [];     // full dataset from the database (or last cached copy)
let currentView = [];    // currently filtered rows (used by CSV export)
let pendingEntries = []; // entries saved offline, awaiting sync

// Initial load is capped to a recent window so the log stays fast as the
// table grows over years. "Load all history" (toggleLoadAll) lifts the cap.
const LOAD_WINDOW_DAYS = 90;
let _loadAllHistory = false;

async function fetchEntries() {
  let query = db
    .from("shift_log")
    .select("*")
    .order("created_at", { ascending: false });
  if (!_loadAllHistory) {
    const cutoff = new Date(Date.now() - LOAD_WINDOW_DAYS * 864e5).toISOString();
    query = query.gte("created_at", cutoff);
  }
  const { data, error } = await query;
  if (error) throw error;

  allEntries = (data || []).map(r => ({
    id:             r.id,
    date:           r.date,
    shift:          r.shift,
    time:           r.time,
    name:           r.staff_name,
    campus:         r.campus,
    eventType:      r.event_type,
    narrative:      r.narrative,
    followUpNeeded: r.follow_up_needed,
    followUpNotes:  r.follow_up_notes,
    resolved:       r.resolved,
    resolvedBy:     r.resolved_by,
    resolvedAt:     r.resolved_at,
    resolutionNotes:r.resolution_notes,
    severity:      r.severity || null,
    attachments:    r.attachments || [],
    createdAt:      r.created_at,
  }));

  // Cache a snapshot so the log is viewable offline.
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(allEntries)); } catch (e) {/* quota */}
  return allEntries;
}

// ── Unread tracking ("new since last visit") ──────────────────────────────────
// Per-user watermark kept on the server. Entries newer than it are "new". The
// watermark advances when the user leaves the Log tab (or taps "Mark all read").
let _lastSeen = null;

function currentUserKey() { return (currentProfile && currentProfile.full_name) || ""; }

async function loadReadState() {
  const u = currentUserKey();
  if (!u) { _lastSeen = null; return; }
  try {
    const res = await fetch(`/api/read_state?user=${encodeURIComponent(u)}`);
    const j = await res.json();
    _lastSeen = (j && j.data && j.data.last_seen) || null;
  } catch { _lastSeen = null; }
}

// A real (non-pending) entry newer than the watermark is unread.
// No watermark yet (first-ever visit) means everything is new.
function isUnread(r) {
  if (r._pending || !r.createdAt) return false;
  if (!_lastSeen) return true;
  return new Date(r.createdAt) > new Date(_lastSeen);
}

function unreadCount() { return allEntries.filter(isUnread).length; }

function newestCreatedAt() {
  let newest = null;
  for (const r of allEntries) {
    if (r.createdAt && (!newest || new Date(r.createdAt) > new Date(newest))) newest = r.createdAt;
  }
  return newest;
}

async function persistSeen(ts) {
  const u = currentUserKey();
  if (!u || !ts) return;
  try {
    await fetch("/api/read_state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: u, last_seen: ts }),
    });
  } catch { /* offline — will re-sync watermark next time */ }
}

// "Mark all as read" button (while viewing the log): clear now and re-render.
async function markAllRead() {
  const ts = newestCreatedAt() || new Date().toISOString();
  _lastSeen = ts;
  await persistSeen(ts);
  applyFilters();
}

// Called when leaving the Log tab: everything up to the newest entry is now "seen".
function markLogSeen() {
  const ts = newestCreatedAt();
  if (!ts) return;
  _lastSeen = ts;
  persistSeen(ts);
  renderUnreadUI();
}

// Update the count badge on the View Log tab + the Mark-all-read button.
function renderUnreadUI() {
  const n = unreadCount();
  const badge = document.getElementById("log-unread-badge");
  if (badge) {
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.classList.toggle("hidden", n === 0);
  }
  const btn = document.getElementById("mark-read-btn");
  if (btn) btn.classList.toggle("hidden", n === 0);
}

// On login: load the watermark + entries so the tab's unread count shows right away.
async function initUnreadBadge() {
  await loadReadState();
  try { await fetchEntries(); } catch { /* offline — badge stays hidden */ }
  renderUnreadUI();
}

// ── Notifications (bell) ──────────────────────────────────────────────────────
let _notifs = [];

function adminNames() {
  return Object.values(USERS).filter(u => u.role === "admin").map(u => u.name);
}

// Everyone in the directory — used so all staff (not just admins) get notified
// of follow-up resolutions.
function allUserNames() {
  return [...new Set(Object.values(USERS).map(u => u.name))];
}

function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function loadNotifications() {
  const u = currentUserKey();
  if (!u) { _notifs = []; renderNotifBell(); return; }
  try {
    const res = await fetch(`/api/notifications?user=${encodeURIComponent(u)}`);
    const j = await res.json();
    _notifs = (j && j.data && j.data.items) || [];
  } catch { _notifs = []; }
  renderNotifBell();
}

function unreadNotifCount() { return _notifs.filter(n => !n.read).length; }

function renderNotifBell() {
  const count = document.getElementById("notif-count");
  const n = unreadNotifCount();
  if (count) {
    count.textContent = n > 99 ? "99+" : String(n);
    count.classList.toggle("hidden", n === 0);
  }
  const bell = document.getElementById("notif-bell");
  if (bell) bell.classList.toggle("has-unread", n > 0);
  renderNotifList();
}

function renderNotifList() {
  const list = document.getElementById("notif-list");
  if (!list) return;
  if (!_notifs.length) {
    list.innerHTML = `<div class="notif-empty">No notifications yet.</div>`;
    return;
  }
  list.innerHTML = _notifs.map(n => `
    <div class="notif-item ${n.read ? "" : "unread"}" onclick="openNotification(${n.id}, ${n.entry_id == null ? "null" : n.entry_id})">
      <div class="notif-msg">${escapeHtml(n.message)}</div>
      <div class="notif-time">${fmtDateTime(n.created_at)}</div>
    </div>`).join("");
}

function toggleNotifPanel() {
  const p = document.getElementById("notif-panel");
  if (!p) return;
  p.classList.toggle("hidden");
  if (!p.classList.contains("hidden")) renderNotifList();
}

async function markAllNotifsRead() {
  const u = currentUserKey();
  _notifs.forEach(n => n.read = true);
  renderNotifBell();
  if (!u) return;
  try {
    await fetch("/api/notifications/read", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: u, all: true }),
    });
  } catch {}
}

async function openNotification(id, entryId) {
  const u = currentUserKey();
  const n = _notifs.find(x => x.id === id);
  if (n) n.read = true;
  renderNotifBell();
  try {
    fetch("/api/notifications/read", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: u, ids: [id] }),
    });
  } catch {}
  const p = document.getElementById("notif-panel");
  if (p) p.classList.add("hidden");
  if (entryId != null) openEntry(entryId);
}

// Jump from a notification to its entry: open the Log, reveal the row + comments.
function openEntry(entryId) {
  switchTab("log");
  setTimeout(() => {
    const row = document.querySelector(`[data-id="${entryId}"]`);
    if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
    try { toggleComments(entryId); } catch {}
  }, 450);
}

// Close the bell panel when clicking outside it.
document.addEventListener("click", (e) => {
  const wrap = document.getElementById("notif-wrap");
  const panel = document.getElementById("notif-panel");
  if (wrap && panel && !panel.classList.contains("hidden") && !wrap.contains(e.target)) {
    panel.classList.add("hidden");
  }
});

async function loadLog() {
  const wrap = document.getElementById("log-table-wrap");
  wrap.innerHTML = "<p class='muted'>Loading entries...</p>";

  let note = "";
  try {
    await fetchEntries();
  } catch (err) {
    // Offline or the request failed: fall back to the last cached snapshot.
    const cached = localStorage.getItem(CACHE_KEY);
    allEntries = cached ? JSON.parse(cached) : [];
    note = navigator.onLine
      ? "Couldn't reach the server — showing the last saved copy."
      : "You're offline — showing the last saved copy.";
  }

  pendingEntries = await getPendingAsEntries();
  await loadReadState();   // refresh this user's "new since last visit" watermark

  const statusEl = document.getElementById("log-status");
  if (statusEl) {
    statusEl.textContent = note;
    statusEl.className = note ? "status-msg error-msg" : "status-msg hidden";
  }

  applyFilters();
}

// Toggle between the recent-window view and the full history, then reload.
async function toggleLoadAll() {
  _loadAllHistory = !_loadAllHistory;
  await loadLog();
}

// Update the "showing last N days / all history" note + button label.
function renderLoadWindowNote() {
  const note = document.getElementById("load-window-note");
  const btn  = document.getElementById("load-window-btn");
  if (!note || !btn) return;
  if (_loadAllHistory) {
    note.textContent = "Showing all history.";
    btn.textContent  = "Show recent only";
  } else {
    note.textContent = `Showing entries from the last ${LOAD_WINDOW_DAYS} days.`;
    btn.textContent  = "Load all history";
  }
}

function isOpen(row)     { return row.followUpNeeded === "Yes" && !row.resolved; }
function isResolved(row) { return row.followUpNeeded === "Yes" &&  row.resolved; }

const ESCALATION_HOURS = 24;
function isEscalated(row) {
  if (!isOpen(row) || !row.createdAt) return false;
  return (Date.now() - new Date(row.createdAt)) / 36e5 >= ESCALATION_HOURS;
}
function hoursOverdue(row) {
  if (!row.createdAt) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(row.createdAt)) / 36e5 - ESCALATION_HOURS));
}

function applyFilters() {
  renderLoadWindowNote();
  renderUnreadUI();
  const search   = document.getElementById("filter-search").value.trim().toLowerCase();
  const campus   = document.getElementById("filter-campus").value;
  // Restricted accounts are hard-locked to their one event type (can't be bypassed).
  const event    = restrictedType() || document.getElementById("filter-event").value;
  const followup = document.getElementById("filter-followup").value;
  const dateFrom = document.getElementById("filter-date-from").value;
  const dateTo   = document.getElementById("filter-date-to").value;

  // Pending (offline) entries appear at the top until they sync.
  currentView = pendingEntries.concat(allEntries).filter(row => {
    if (campus && row.campus    !== campus) return false;
    if (event  && row.eventType !== event)  return false;
    if (followup === "open"     && !isOpen(row))     return false;
    if (followup === "resolved" && !isResolved(row)) return false;
    if (followup === "none"     && row.followUpNeeded !== "No") return false;
    if (dateFrom && row.date < dateFrom)    return false;
    if (dateTo   && row.date > dateTo)      return false;
    if (search) {
      const hay = [row.name, row.narrative, row.followUpNotes, row.campus, row.eventType, row.shift]
        .join(" ").toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  // Order: unsynced (pending) entries first, then escalated open follow-ups,
  // then by the event's OWN date + time (newest first) — so entries read in the
  // order things happened, not the order they synced. (Offline entries can sync
  // in a late batch and share a created_at, which used to clump them at the top.)
  // created_at breaks exact ties.
  const eventKey = r => `${r.date || ""} ${r.time || ""}`;
  currentView.sort((a, b) => {
    if (!!a._pending !== !!b._pending) return a._pending ? -1 : 1;
    const ea = isEscalated(a), eb = isEscalated(b);
    if (ea !== eb) return ea ? -1 : 1;
    const ka = eventKey(a), kb = eventKey(b);
    if (ka !== kb) return ka > kb ? -1 : 1;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });

  renderTable(currentView);
  updateSummary(currentView);
  scoreAnomalies(currentView);
  loadCommentCounts(currentView);
  applyRoleUI();   // keep admin-only controls in sync after each render
}

function clearFilters() {
  ["filter-search","filter-campus","filter-event","filter-followup","filter-date-from","filter-date-to"]
    .forEach(id => { document.getElementById(id).value = ""; });
  applyAccessUI();   // keep the event filter locked for restricted accounts
  applyFilters();
}

function updateSummary(entries) {
  const open = entries.filter(isOpen).length;
  const el = document.getElementById("log-summary");
  el.innerHTML = `
    <span class="summary-pill"><span class="count">${entries.length}</span> entries shown</span>
    <span class="summary-pill ${open ? "alert" : "ok"}">
      <span class="count">${open}</span> open follow-up${open === 1 ? "" : "s"}
    </span>
  `;
}

// ── Anomaly scoring ───────────────────────────────────────
// After the log table renders, batch-score visible entries against the
// IsolationForest model and overlay a warning badge on unusual narratives.
// Only scores the most recent 60 entries to keep the API call fast.

async function scoreAnomalies(entries) {
  if (!ML_ENABLED) return;                                 // AI features off in this deployment
  // Only score real (non-pending) entries that have an id
  const scoreable = entries.filter(e => !e._pending && e.id).slice(0, 60);
  if (!scoreable.length) return;

  try {
    const res = await fetch(`${ML_API}/anomaly-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        narratives: scoreable.map(e => ({ id: e.id, text: e.narrative })),
      }),
    });
    if (!res.ok) return;
    const results = await res.json();

    results.forEach(({ id, is_anomaly }) => {
      // Update both table and card badges (duplicate-ID-safe via data attribute)
      document.querySelectorAll(`[data-anomaly-id="${id}"]`).forEach(badge => {
        if (is_anomaly) {
          badge.className = "anomaly-badge";
          badge.textContent = "⚠ Unusual";
          badge.title = "This narrative looks unusual compared to historical entries";
        } else {
          badge.className = "hidden";
        }
      });
    });
  } catch {
    // API unavailable — no badges shown, no error surfaced
  }
}

function renderTable(entries) {
  const wrap = document.getElementById("log-table-wrap");

  if (!entries.length) {
    wrap.innerHTML = "<div class='no-results'>No entries match your filters.</div>";
    return;
  }

  // Build follow-up cell — escalated entries get a pulsing red badge
  function followHtml(r) {
    if (r._pending) return `<span class="badge badge-pending">Pending sync</span>`;
    if (isEscalated(r)) return `<div class="followup-cell">
        <span class="badge badge-escalated">🚨 Escalated</span>
        <span class="escalated-overdue">${hoursOverdue(r)}h overdue</span>
        <button class="resolve-btn" onclick="openResolveModal(${r.id})">Resolve</button>
      </div>`;
    if (isOpen(r))  return `<div class="followup-cell">
        <span class="badge badge-open">Open</span>
        <button class="resolve-btn" onclick="openResolveModal(${r.id})">Resolve</button>
      </div>`;
    if (isResolved(r)) return `<div class="followup-cell">
        <span class="badge badge-resolved">Resolved</span>
        <span class="resolved-meta">by ${escapeHtml(r.resolvedBy) || "—"}<br>${fmtDate(r.resolvedAt)}</span>
      </div>`;
    return `<span class="badge badge-no">No</span>`;
  }

  // ── Desktop table ──────────────────────────────────────────
  const rows = entries.map(r => {
    const notesRow = r.followUpNotes
      ? `<div class="followup-notes">${escapeHtml(r.followUpNotes)}</div>`
      : "";
    const resolutionRow = isResolved(r) && r.resolutionNotes
      ? `<div class="resolution-note"><strong>Resolution:</strong> ${escapeHtml(r.resolutionNotes)}</div>`
      : "";

    return `
    <tr class="campus-${slug(r.campus)} ${r._pending ? "row-pending" : ""} ${isEscalated(r) ? "row-escalated" : ""} ${isUnread(r) ? "row-unread" : ""}" data-id="${r.id ?? ""}">
      <td class="col-when">
        ${isUnread(r) ? '<span class="new-pill">NEW</span>' : ""}
        <span class="when-date">${escapeHtml(r.date)}</span>
        <span class="when-meta">${escapeHtml(r.shift)} &middot; ${escapeHtml(r.time)}</span>
      </td>
      <td class="col-who">
        <span class="who-name">${escapeHtml(r.name)}</span>
        <span class="who-campus">${escapeHtml(r.campus)}</span>
      </td>
      <td>
        <span class="badge badge-${slug(r.eventType)}">${escapeHtml(r.eventType)}</span>
        ${r.severity ? `<span class="sev-badge sev-${r.severity.toLowerCase()}">${r.severity}</span>` : ""}
        ${r.edit_count > 0 ? `<span class="edited-tag" title="Last edited ${escapeHtml(fmtDateTime(r.last_edited_at))}">edited</span>` : ""}
      </td>
      <td class="col-followup">
        ${followHtml(r)}
        ${notesRow}
        ${resolutionRow}
        ${!r._pending ? `<button class="comment-toggle-btn" onclick="toggleComments(${r.id})" data-entry-id="${r.id}">💬 Comments</button>` : ""}
        ${canEdit(r) ? `<button class="edit-btn" onclick="openEditModal(${r.id})">✏️ Edit</button>` : ""}
        ${(currentProfile && currentProfile.role === "admin" && r.edit_count > 0) ? `<button class="history-btn" onclick="openHistory(${r.id})">🕓 History</button>` : ""}
        ${(currentProfile && currentProfile.role === "admin" && !r._pending) ? `<button class="delete-btn" onclick="deleteEntry(${r.id})">🗑 Delete</button>` : ""}
      </td>
      <td class="col-narrative">
        ${escapeHtml(r.narrative)}
        <span data-anomaly-id="${r.id}" class="hidden"></span>
      </td>
      <td>${attachmentsCell(r)}</td>
    </tr>
    <tr class="comment-tr" data-comment-row="${r.id}" style="display:none">
      <td colspan="6" class="comment-td">
        <div class="comment-panel" data-comment-panel="${r.id}"></div>
      </td>
    </tr>`;
  }).join("");

  // ── Mobile cards ───────────────────────────────────────────
  const cards = entries.map(r => {
    const notesHtml = r.followUpNotes
      ? `<div class="log-card-notes"><span class="log-card-notes-label">Notes:</span> ${escapeHtml(r.followUpNotes)}</div>`
      : "";
    const resolutionHtml = isResolved(r) && r.resolutionNotes
      ? `<div class="log-card-notes log-card-resolution"><span class="log-card-notes-label">Resolution:</span> ${escapeHtml(r.resolutionNotes)}</div>`
      : "";
    const filesHtml = attachmentsCell(r)
      ? `<div class="log-card-files">${attachmentsCell(r)}</div>`
      : "";

    return `
    <div class="log-card campus-${slug(r.campus)} ${r._pending ? "log-card-pending" : ""} ${isEscalated(r) ? "log-card-escalated" : ""} ${isUnread(r) ? "log-card-unread" : ""}" data-id="${r.id ?? ""}">
      <div class="log-card-top">
        ${isUnread(r) ? '<span class="new-pill">NEW</span>' : ""}
        <span class="badge badge-${slug(r.eventType)}">${escapeHtml(r.eventType)}</span>
        ${r.severity ? `<span class="sev-badge sev-${r.severity.toLowerCase()}">${r.severity}</span>` : ""}
        ${r.edit_count > 0 ? `<span class="edited-tag" title="Last edited ${escapeHtml(fmtDateTime(r.last_edited_at))}">edited</span>` : ""}
        <span class="log-card-meta">${escapeHtml(r.date)} &middot; ${escapeHtml(r.shift)} &middot; ${escapeHtml(r.time)}</span>
      </div>
      <div class="log-card-narrative">
        ${escapeHtml(r.narrative)}
        <span data-anomaly-id="${r.id}" class="hidden"></span>
      </div>
      <div class="log-card-footer">
        <span class="log-card-who">${escapeHtml(r.name)} &middot; <span class="campus-tag">${escapeHtml(r.campus)}</span></span>
        <div class="log-card-followup">${followHtml(r)}</div>
      </div>
      ${notesHtml}
      ${resolutionHtml}
      ${filesHtml}
      ${!r._pending ? `
      <div class="log-card-comment-section">
        <button class="comment-toggle-btn" onclick="toggleComments(${r.id})" data-entry-id="${r.id}">💬 Comments</button>
        ${canEdit(r) ? `<button class="edit-btn" onclick="openEditModal(${r.id})">✏️ Edit</button>` : ""}
        ${(currentProfile && currentProfile.role === "admin" && r.edit_count > 0) ? `<button class="history-btn" onclick="openHistory(${r.id})">🕓 History</button>` : ""}
        ${(currentProfile && currentProfile.role === "admin" && !r._pending) ? `<button class="delete-btn" onclick="deleteEntry(${r.id})">🗑 Delete</button>` : ""}
        <div class="comment-panel" data-comment-panel="${r.id}" style="display:none"></div>
      </div>` : ""}
    </div>`;
  }).join("");

  wrap.innerHTML = `
    <div class="log-table-desktop">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Type</th>
            <th>Follow-Up</th>
            <th>Narrative</th>
            <th>Files</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="log-cards-mobile">${cards}</div>
  `;
}

// ── Comment counts ────────────────────────────────────────
// After the log renders, fetch how many comments exist per entry and
// update each toggle button so staff can see activity at a glance.

async function loadCommentCounts(entries) {
  const ids = entries.filter(e => !e._pending && e.id).map(e => e.id);
  if (!ids.length) return;
  try {
    const { data, error } = await db
      .from("entry_comments")
      .select("entry_id")
      .in("entry_id", ids);
    if (error) return;

    const counts = {};
    (data || []).forEach(r => {
      counts[r.entry_id] = (counts[r.entry_id] || 0) + 1;
    });

    document.querySelectorAll(".comment-toggle-btn[data-entry-id]").forEach(btn => {
      const count = counts[btn.dataset.entryId] || 0;
      btn.textContent = count > 0
        ? `💬 ${count} comment${count === 1 ? "" : "s"}`
        : "💬 Comments";
      btn.classList.toggle("has-comments", count > 0);
    });
  } catch {
    // Non-critical — buttons just stay as "💬 Comments"
  }
}

// ── Comment threads ───────────────────────────────────────

function toggleComments(entryId) {
  // Toggle the hidden table row
  const tableRow = document.querySelector(`[data-comment-row="${entryId}"]`);
  if (tableRow) {
    const opening = tableRow.style.display === "none";
    tableRow.style.display = opening ? "table-row" : "none";
  }
  // Toggle and lazy-load all comment panels (table + card share the same data attr)
  document.querySelectorAll(`[data-comment-panel="${entryId}"]`).forEach(panel => {
    const opening = panel.style.display === "none" || panel.style.display === "";
    panel.style.display = opening ? "block" : "none";
    if (opening && !panel.dataset.loaded) {
      panel.dataset.loaded = "1";
      loadComments(entryId, panel);
    }
  });
}

async function loadComments(entryId, container) {
  container.innerHTML = `<p class="comment-loading muted">Loading…</p>`;
  const { data, error } = await db
    .from("entry_comments")
    .select("*")
    .eq("entry_id", entryId)
    .order("created_at", { ascending: true });

  if (error) {
    const isTableMissing = error.code === "42P01" || error.message?.includes("does not exist");
    container.innerHTML = isTableMissing
      ? `<p class="comment-error-msg">⚠️ Run <strong>supabase_comments.sql</strong> in your Supabase SQL Editor to enable comments.</p>`
      : `<p class="comment-error-msg">Could not load comments: ${escapeHtml(error.message)}</p>`;
    return;
  }
  renderCommentPanel(data || [], container, entryId);
}

function renderCommentPanel(comments, container, entryId) {
  const profileName = currentProfile?.full_name || "";
  const savedName   = profileName || localStorage.getItem("shiftlog_comment_name") || "";
  const nameReadOnly = !!profileName;
  const listHtml = comments.length
    ? comments.map(c => `
        <div class="comment">
          <div class="comment-header">
            <span class="comment-author">${escapeHtml(c.author_name)}</span>
            <span class="comment-time">${fmtDate(c.created_at)}</span>
          </div>
          <p class="comment-body">${escapeHtml(c.body)}</p>
        </div>`).join("")
    : `<p class="comment-empty">No comments yet.</p>`;

  container.innerHTML = `
    <div class="comment-thread">
      <div class="comment-list">${listHtml}</div>
      <div class="comment-form">
        <input  type="text"
                class="comment-name-input"
                placeholder="Your name *"
                maxlength="60"
                value="${escapeHtml(savedName)}"
                ${nameReadOnly ? 'readonly title="Name comes from your account"' : ""} />
        <textarea class="comment-body-input"
                  rows="2"
                  placeholder="Add a comment…"
                  maxlength="500"></textarea>
        <div class="comment-form-footer">
          <button class="comment-submit-btn" onclick="submitComment(${entryId}, this)">Post</button>
          <p class="comment-error hidden"></p>
        </div>
      </div>
    </div>`;
}

async function submitComment(entryId, btn) {
  const thread = btn.closest(".comment-thread");
  const nameEl = thread.querySelector(".comment-name-input");
  const bodyEl = thread.querySelector(".comment-body-input");
  const errEl  = thread.querySelector(".comment-error");
  const name   = nameEl.value.trim();
  const body   = bodyEl.value.trim();

  errEl.classList.add("hidden");
  if (!name) {
    errEl.textContent = "Please enter your name before posting.";
    errEl.classList.remove("hidden");
    nameEl.focus();
    return;
  }
  if (!body) {
    errEl.textContent = "Please write a comment.";
    errEl.classList.remove("hidden");
    bodyEl.focus();
    return;
  }

  btn.disabled    = true;
  btn.textContent = "Posting…";

  const { error } = await db.from("entry_comments")
    .insert({ entry_id: entryId, author_name: name, body });

  if (error) {
    errEl.textContent = "Failed to post — please try again.";
    errEl.classList.remove("hidden");
    btn.disabled    = false;
    btn.textContent = "Post";
    return;
  }

  localStorage.setItem("shiftlog_comment_name", name);

  // Reload all panels for this entry so both table + card stay in sync
  document.querySelectorAll(`[data-comment-panel="${entryId}"]`).forEach(panel => {
    panel.dataset.loaded = "";
    loadComments(entryId, panel);
  });
}

// ── Voice-to-text ─────────────────────────────────────────

let _voiceRec    = null;
let _voiceActive = false;

function toggleVoice() {
  _voiceActive ? stopVoice() : startVoice();
}

function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert("Voice to text isn't supported in this browser. Try Chrome or Edge.");
    return;
  }
  _voiceRec                = new SR();
  _voiceRec.continuous     = true;
  _voiceRec.interimResults = true;
  _voiceRec.lang           = "en-US";

  const textarea = document.getElementById("narrative");
  const micBtn   = document.getElementById("mic-btn");
  const preview  = document.getElementById("voice-preview");

  micBtn.classList.add("mic-recording");
  micBtn.title = "Tap to stop recording";
  _voiceActive = true;

  let committed = textarea.value;

  _voiceRec.onresult = (e) => {
    let interim = "", final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      e.results[i].isFinal
        ? (final   += e.results[i][0].transcript)
        : (interim += e.results[i][0].transcript);
    }
    if (final) {
      committed      = (committed + " " + final).trimStart();
      textarea.value = committed;
      scheduleDraftSave();   // dictated text doesn't fire "input"
    }
    if (preview) preview.textContent = interim;
    if (textarea.value.length >= 10) callMlApi(textarea.value);
  };

  _voiceRec.onerror = () => stopVoice();
  _voiceRec.onend   = () => { if (_voiceActive) stopVoice(); };
  _voiceRec.start();
}

function stopVoice() {
  _voiceActive = false;
  const micBtn  = document.getElementById("mic-btn");
  const preview = document.getElementById("voice-preview");
  if (micBtn)  { micBtn.classList.remove("mic-recording"); micBtn.title = "Voice to text"; }
  if (preview) preview.textContent = "";
  try { _voiceRec?.stop(); } catch {}
  _voiceRec = null;
}

// ── Resolve follow-up ─────────────────────────────────────

let pendingResolveId = null;

function openResolveModal(id) {
  pendingResolveId = id;
  const entry = allEntries.find(e => e.id === id);
  document.getElementById("resolve-context").textContent =
    entry ? `${entry.eventType} · ${entry.campus} · ${fmtDate(entry.date)}` : "";
  const nameInput = document.getElementById("resolve-name");
  nameInput.value = localStorage.getItem("shiftlog_resolver") || "";
  document.getElementById("resolve-notes").value = entry && entry.resolutionNotes ? entry.resolutionNotes : "";
  document.getElementById("resolve-error").classList.add("hidden");
  document.getElementById("resolve-modal").classList.remove("hidden");
  nameInput.focus();
}

function closeResolveModal() {
  pendingResolveId = null;
  document.getElementById("resolve-modal").classList.add("hidden");
}

async function confirmResolve() {
  const name = document.getElementById("resolve-name").value.trim();
  const notes = document.getElementById("resolve-notes").value.trim();
  const errEl = document.getElementById("resolve-error");

  if (!name) {
    errEl.textContent = "Please enter your name.";
    errEl.classList.remove("hidden");
    return;
  }

  try {
    const { error } = await db.from("shift_log")
      .update({ resolved: true, resolved_by: name, resolved_at: new Date().toISOString(), resolution_notes: notes, recipients: allUserNames() })
      .eq("id", pendingResolveId);
    if (error) throw error;

    localStorage.setItem("shiftlog_resolver", name);
    closeResolveModal();
    await loadLog();
  } catch (err) {
    errEl.textContent = `Could not resolve: ${err.message}`;
    errEl.classList.remove("hidden");
  }
}

// ── Edit entry + history ──────────────────────────────────────────────────────
let pendingEditId = null;

// You can edit an entry you authored; admins can edit any entry.
function canEdit(r) {
  if (r._pending || !r.id || !currentProfile) return false;
  return currentProfile.role === "admin" || r.name === currentProfile.full_name;
}

function openEditModal(id) {
  const e = allEntries.find(x => x.id === id);
  if (!e) return;
  pendingEditId = id;
  // Copy option lists from the submit form so they stay in sync automatically.
  document.getElementById("edit-shift").innerHTML    = document.getElementById("shift").innerHTML;
  document.getElementById("edit-campus").innerHTML   = document.getElementById("campus").innerHTML;
  document.getElementById("edit-event").innerHTML    = document.getElementById("event-type").innerHTML;
  document.getElementById("edit-followup").innerHTML = document.getElementById("followup").innerHTML;
  document.getElementById("edit-date").value          = e.date || "";
  document.getElementById("edit-shift").value         = e.shift || "";
  document.getElementById("edit-time").value          = e.time || "";
  document.getElementById("edit-campus").value        = e.campus || "";
  document.getElementById("edit-event").value         = e.eventType || "";
  document.getElementById("edit-followup").value      = e.followUpNeeded || "";
  document.getElementById("edit-narrative").value     = e.narrative || "";
  document.getElementById("edit-followup-notes").value = e.followUpNotes || "";
  document.getElementById("edit-context").textContent = `Entry by ${e.name} · ${fmtDate(e.date)}`;
  document.getElementById("edit-error").classList.add("hidden");
  document.getElementById("edit-modal").classList.remove("hidden");
}

function closeEditModal() {
  pendingEditId = null;
  document.getElementById("edit-modal").classList.add("hidden");
}

async function confirmEdit() {
  const id = pendingEditId;
  const errEl = document.getElementById("edit-error");
  const fields = {
    date:             document.getElementById("edit-date").value,
    shift:            document.getElementById("edit-shift").value,
    time:             document.getElementById("edit-time").value,
    campus:           document.getElementById("edit-campus").value,
    event_type:       document.getElementById("edit-event").value,
    follow_up_needed: document.getElementById("edit-followup").value,
    narrative:        document.getElementById("edit-narrative").value.trim(),
    follow_up_notes:  document.getElementById("edit-followup-notes").value.trim(),
  };
  if (!fields.narrative) {
    errEl.textContent = "Narrative can't be empty.";
    errEl.classList.remove("hidden");
    return;
  }
  try {
    const res = await fetch(`/api/shift_log/${id}/edit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editor: currentUserKey() || "Unknown", fields }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    closeEditModal();
    await loadLog();
  } catch (err) {
    errEl.textContent = `Could not save: ${err.message}`;
    errEl.classList.remove("hidden");
  }
}

const FIELD_LABELS = {
  date: "Date", shift: "Shift", time: "Time", campus: "Campus",
  event_type: "Event Type", narrative: "Narrative",
  follow_up_needed: "Follow-Up Needed", follow_up_notes: "Follow-Up Notes",
};

async function openHistory(id) {
  const modal = document.getElementById("history-modal");
  const body = document.getElementById("history-body");
  body.innerHTML = "<p class='muted'>Loading…</p>";
  modal.classList.remove("hidden");
  try {
    const res = await fetch(`/api/shift_log/${id}/history`);
    const j = await res.json();
    const items = (j.data && j.data.items) || [];
    if (!items.length) { body.innerHTML = "<p class='muted'>No edits recorded.</p>"; return; }
    body.innerHTML = items.map(it => {
      let changes = {};
      try { changes = JSON.parse(it.changes); } catch {}
      const rows = Object.entries(changes).map(([f, v]) => `
        <div class="hist-change">
          <span class="hist-field">${escapeHtml(FIELD_LABELS[f] || f)}</span>
          <span class="hist-from">${escapeHtml(String(v.from ?? "—"))}</span>
          <span class="hist-arrow">→</span>
          <span class="hist-to">${escapeHtml(String(v.to ?? "—"))}</span>
        </div>`).join("");
      return `<div class="hist-entry">
          <div class="hist-meta"><b>${escapeHtml(it.edited_by)}</b> · ${fmtDateTime(it.edited_at)}</div>
          ${rows}
        </div>`;
    }).join("");
  } catch (e) {
    body.innerHTML = "<p class='error'>Could not load history.</p>";
  }
}

function closeHistory() { document.getElementById("history-modal").classList.add("hidden"); }

// ── Admin soft delete ─────────────────────────────────────────────────────────
async function deleteEntry(id) {
  if (!confirm("Delete this entry? It will be hidden from the log but kept (recoverable) for records.")) return;
  try {
    await fetch(`/api/shift_log/${id}/delete`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleted_by: currentUserKey() }) });
    await loadLog();
  } catch {}
}

async function openDeletedModal() {
  const modal = document.getElementById("deleted-modal");
  const body = document.getElementById("deleted-body");
  body.innerHTML = "<p class='muted'>Loading…</p>";
  modal.classList.remove("hidden");
  try {
    const j = await fetch("/api/shift_log/deleted").then(r => r.json());
    const items = (j && j.data) || [];
    if (!items.length) { body.innerHTML = "<p class='muted'>No deleted entries.</p>"; return; }
    body.innerHTML = items.map(e => `
      <div class="deleted-item">
        <div class="deleted-meta"><b>${escapeHtml(e.date || "")}</b> · ${escapeHtml(e.event_type || "")} · ${escapeHtml(e.name || e.staff_name || "")}
          <span class="muted">— deleted ${escapeHtml(fmtDateTime(e.deleted_at))}${e.deleted_by ? " by " + escapeHtml(e.deleted_by) : ""}</span></div>
        <div class="deleted-narr">${escapeHtml((e.narrative || "").slice(0, 180))}</div>
        <button class="mini-btn" onclick="restoreEntry(${e.id})">Restore</button>
      </div>`).join("");
  } catch { body.innerHTML = "<p class='error'>Could not load deleted entries.</p>"; }
}
function closeDeletedModal() { document.getElementById("deleted-modal").classList.add("hidden"); }
async function restoreEntry(id) {
  try {
    await fetch(`/api/shift_log/${id}/restore`, { method: "POST" });
    await openDeletedModal();
    if (_activeTab === "log") loadLog();
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// Warnings & Write-Ups (VW/WW/WU) — client-level records (42 CFR Part 2).
// No client identifiers are ever written to the console.
// ══════════════════════════════════════════════════════════════════════════════
let _clients = [];
let _rules = [];
let _warnings = [];
let _wLoaded = false;

function gv(id) { const e = document.getElementById(id); return e ? e.value : ""; }
function todayStr() { const d = new Date(); const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function initialsOf(name) { return name ? name.split(/\s+/).map(w => w[0] || "").join("").toUpperCase().slice(0, 4) : ""; }

const WARNING_STATUS_LABELS = {
  draft: "Draft", pending_delivery: "Pending delivery", issued: "Issued",
  consequence_open: "Consequence open", completed: "Completed", closed: "Closed", voided: "Voided",
};
function warningStatusLabel(s) { return WARNING_STATUS_LABELS[s] || s; }

// An owed consequence whose due date has passed (isConsequenceOwed + localKey are
// hoisted from the dashboard section below).
function isWarningOverdue(w) {
  if (!isConsequenceOwed(w) || !w.consequence_due) return false;
  return String(w.consequence_due).slice(0, 10) < localKey(new Date());
}

// Whole days from today (local, midnight) to a warning's due date; null if none.
// parseLocalDate is hoisted from the dashboard section below.
function daysUntilDue(w) {
  if (!w.consequence_due) return null;
  const due = parseLocalDate(String(w.consequence_due).slice(0, 10));
  if (!due) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((due - today) / 86400000);
}
// An owed consequence coming due within the next 2 days (today/tomorrow/day-after)
// but not yet overdue — the proactive "coming due" cue.
const DUE_SOON_DAYS = 2;
function isWarningDueSoon(w) {
  if (!isConsequenceOwed(w) || isWarningOverdue(w)) return false;
  const d = daysUntilDue(w);
  return d !== null && d >= 0 && d <= DUE_SOON_DAYS;
}

// Plain-text consequence label (used in the Active Consequences table cells).
function warningConsequenceLabel(w) {
  if (!w.consequence_type || w.consequence_type === "none") return '<span class="muted">none</span>';
  const done = w.status === "completed" || w.status === "closed";
  const due = w.consequence_due ? " due " + escapeHtml(fmtDate(w.consequence_due)) : "";
  const overdue = isWarningOverdue(w) ? " <span class='infr-overdue'>overdue</span>" : "";
  return `${escapeHtml(w.consequence_type)}${due}${done ? " ✓" : ""}${overdue}`;
}

// Consequence rendered as a coloured chip for the warning card meta row.
function warningConsequenceChip(w) {
  if (!w.consequence_type || w.consequence_type === "none") return "";
  const done = w.status === "completed" || w.status === "closed";
  const overdue = isWarningOverdue(w);
  const dueSoon = !done && !overdue && isWarningDueSoon(w);
  const type = w.consequence_type.charAt(0).toUpperCase() + w.consequence_type.slice(1);
  // Show the paper topic (or therapeutic detail) right on the chip for easy access.
  const detail = (w.consequence_detail || "").trim();
  const detailStr = detail ? ": " + escapeHtml(detail) : "";
  const due = w.consequence_due ? " · due " + escapeHtml(fmtDate(w.consequence_due)) : "";
  const cls = done ? "wchip-done" : overdue ? "wchip-overdue" : dueSoon ? "wchip-duesoon" : "wchip-cons";
  const icon = done ? "✅" : overdue ? "⚠️" : dueSoon ? "⏰" : "📌";
  const tail = done ? " ✓" : overdue ? " · overdue" : dueSoon ? " · due soon" : "";
  return `<span class="wchip ${cls}">${icon} ${escapeHtml(type)}${detailStr}${due}${tail}</span>`;
}

async function loadWarningsBaseData() {
  try {
    const [cl, ru] = await Promise.all([
      fetch("/api/clients").then(r => r.json()),
      fetch("/api/rules").then(r => r.json()),
    ]);
    _clients = (cl && cl.data) || [];
    _rules = (ru && ru.data) || [];
    _wLoaded = true;
  } catch { _clients = []; _rules = []; }
}

function populateWarningSelects() {
  const wf = document.getElementById("wf-client");
  if (wf) {
    const cur = wf.value;
    wf.innerHTML = '<option value="">All clients</option>' +
      _clients.map(c => `<option value="${c.id}">${escapeHtml(c.full_name)}${c.status === "discharged" ? " (discharged)" : ""}</option>`).join("");
    wf.value = cur;
  }
  const wc = document.getElementById("w-client");
  if (wc) {
    const cur = wc.value;
    wc.innerHTML = '<option value="">— Select client —</option>' +
      _clients.filter(c => c.status === "active").map(c => `<option value="${c.id}">${escapeHtml(c.full_name)}</option>`).join("");
    wc.value = cur;
  }
}

// Rule picklist filtered by the selected client's phase (both + PHx).
function populateRuleSelect(phase) {
  const sel = document.getElementById("w-rule");
  if (!sel) return;
  const cur = sel.value;
  const rules = _rules.filter(r => r.active && (!phase || r.phase === "both" || r.phase === "PH" + phase));
  sel.innerHTML = '<option value="">— Select rule —</option>' +
    rules.map(r => `<option value="${r.id}">${escapeHtml(r.label)}</option>`).join("");
  sel.value = cur;
}

async function renderWarnings() {
  if (!_wLoaded) await loadWarningsBaseData();
  populateWarningSelects();
  const qs = new URLSearchParams();
  if (gv("wf-type")) qs.set("type", gv("wf-type"));
  if (gv("wf-status")) qs.set("status", gv("wf-status"));
  if (gv("wf-client")) qs.set("client_id", gv("wf-client"));
  try {
    const j = await fetch("/api/warnings?" + qs.toString()).then(r => r.json());
    _warnings = (j && j.data) || [];
  } catch { _warnings = []; }
  renderWarningsList();
  renderWarnActivePanel();
}

// "Active Consequences" summary at the top of the tab — always the FULL
// outstanding set (soonest due first, overdue flagged), independent of the
// list filters below. Reuses the dashboard's table renderer.
async function renderWarnActivePanel() {
  let rows = [];
  try {
    const j = await fetch("/api/warnings").then(r => r.json());
    rows = (j && j.data) || [];
  } catch { rows = []; }
  renderWarnStats(rows);
  renderWarnWatchlist(rows);
  renderActiveConsequences(rows, "warn-active");
}

// At-a-glance tiles over the FULL infraction set (not the filtered list).
function renderWarnStats(rows) {
  const el = document.getElementById("warn-stats");
  if (!el) return;
  const active  = rows.filter(w => w.status !== "voided");
  const owed    = active.filter(isConsequenceOwed);
  const overdue = owed.filter(isWarningOverdue);
  const dueWeek = owed.filter(w => {
    if (isWarningOverdue(w)) return false;
    const d = daysUntilDue(w);
    return d !== null && d >= 0 && d <= 7;
  });
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const thisMonth = active.filter(w => warnDateStr(w).slice(0, 7) === ym);
  el.innerHTML = `
    <div class="stat-card"><div class="stat-value">${owed.length}</div><div class="stat-label">Open Consequences</div></div>
    <div class="stat-card ${overdue.length ? "alert" : ""}"><div class="stat-value">${overdue.length}</div><div class="stat-label">Overdue</div></div>
    <div class="stat-card ${dueWeek.length ? "warn-soon" : ""}"><div class="stat-value">${dueWeek.length}</div><div class="stat-label">Due This Week</div></div>
    <div class="stat-card"><div class="stat-value">${thisMonth.length}</div><div class="stat-label">Infractions This Month</div></div>`;
}

// Repeat-pattern callout: clients with 3+ non-voided infractions in the last 30
// days — the escalation pattern the paper system hides. Click to filter the list.
function renderWarnWatchlist(rows) {
  const el = document.getElementById("warn-watchlist");
  if (!el) return;
  const cutoff = localKey(new Date(Date.now() - 30 * 86400000));
  const byClient = {};
  rows.filter(w => w.status !== "voided" && warnDateStr(w) >= cutoff).forEach(w => {
    const k = w.client_id;
    if (!byClient[k]) byClient[k] = { id: k, name: w.client_name, n: 0 };
    byClient[k].n++;
  });
  const flagged = Object.values(byClient).filter(c => c.n >= 3).sort((a, b) => b.n - a.n);
  if (!flagged.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = `<span class="warn-watch-label">⚠️ Repeat pattern — 3+ infractions in 30 days:</span> ` +
    flagged.map(c => `<button class="warn-watch-chip" onclick="filterWarnClient(${c.id})">${escapeHtml(c.name)} <b>${c.n}</b></button>`).join("");
}
function filterWarnClient(id) {
  const el = document.getElementById("wf-client");
  if (el) el.value = String(id);
  renderWarnings();
}

// Sort tier for the list: active/open consequences float to the top (overdue
// first), closed and voided sink to the bottom. Lower = higher up.
function warningSortRank(w) {
  if (w.status === "voided") return 5;
  if (w.status === "closed") return 4;
  if (isWarningOverdue(w))   return 0;   // owed + past due — most urgent
  if (isConsequenceOwed(w))  return 1;   // open consequence, not yet overdue
  if (w.status === "completed") return 2; // done, awaiting close-out
  return 3;                               // issued, no outstanding consequence
}

// Free-text match across a warning's client, rule, narrative, number and issuer.
function warningMatchesSearch(w, q) {
  const hay = [
    w.client_name, w.rule_label, w.rule_detail, w.narrative,
    `${w.type}#${w.seq_number}`, `${w.type}${w.seq_number}`,
    w.issued_by_initials, w.consequence_type, w.consequence_detail,
  ].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q);
}

function renderWarningsList() {
  const box = document.getElementById("warnings-list");
  if (!box) return;
  const countEl = document.getElementById("warn-count");
  const q = gv("wf-search").trim().toLowerCase();
  let rows = q ? _warnings.filter(w => warningMatchesSearch(w, q)) : _warnings.slice();
  // Hide voided (deleted) infractions unless the Status filter is set to "Voided".
  if (gv("wf-status") !== "voided") rows = rows.filter(w => w.status !== "voided");
  if (countEl) {
    const anyFilter = q || gv("wf-type") || gv("wf-status") || gv("wf-client");
    countEl.textContent = `${rows.length} infraction${rows.length === 1 ? "" : "s"}${anyFilter ? " (filtered)" : ""}`;
  }
  if (!rows.length) {
    box.innerHTML = `<div class='no-results'>No infractions match ${q ? "your search" : "your filters"}.</div>`;
    return;
  }
  // Stable sort by tier — keeps the server's issued-date order within each tier.
  const ordered = rows
    .map((w, i) => [w, i])
    .sort((a, b) => (warningSortRank(a[0]) - warningSortRank(b[0])) || (a[1] - b[1]))
    .map(pair => pair[0]);
  box.innerHTML = ordered.map(w => {
    const overdue = isWarningOverdue(w);
    const dueSoon = !overdue && isWarningDueSoon(w);
    const flag = overdue ? " warning-card-overdue" : dueSoon ? " warning-card-duesoon" : "";
    return `
    <div class="warning-card warning-card-${w.type}${flag}">
      <div class="warning-card-head">
        <span class="warning-num warning-${w.type}">${w.type}#${w.seq_number}</span>
        <div class="warning-headline">
          <span class="warning-client">${escapeHtml(w.client_name)}</span>
          <span class="warning-rule">${escapeHtml(w.rule_label || "—")}${w.rule_detail ? " — " + escapeHtml(w.rule_detail) : ""}</span>
        </div>
        <span class="warning-status wstatus-${w.status}">${escapeHtml(warningStatusLabel(w.status))}</span>
      </div>
      ${w.narrative ? `<p class="warning-narrative">${escapeHtml(w.narrative)}</p>` : ""}
      <div class="warning-meta">
        <span class="wchip">📅 ${escapeHtml(fmtDate(w.occurred_at || w.issued_at))}</span>
        ${w.shift ? `<span class="wchip">🕐 ${escapeHtml(w.shift)}</span>` : ""}
        ${w.campus ? `<span class="wchip">🏢 ${escapeHtml(w.campus)}</span>` : ""}
        ${w.client_counselor ? `<span class="wchip">👤 ${escapeHtml(w.client_counselor)}</span>` : ""}
        ${w.issued_by_initials ? `<span class="wchip">✍️ ${escapeHtml(w.issued_by_initials)}</span>` : ""}
        ${warningConsequenceChip(w)}
        ${w.edit_count > 0 ? `<span class="edited-tag" title="Last edited ${escapeHtml(fmtDateTime(w.last_edited_at))}">edited</span>` : ""}
      </div>
      ${warningTimeline(w)}
      ${warningActions(w)}
    </div>`;
  }).join("");
}

// Issued → completed → closed progression shown on each card. The due date lives
// on the consequence chip now, so it's omitted here to avoid duplication.
function warningTimeline(w) {
  const parts = [`Issued ${escapeHtml(fmtDate(w.issued_at))}`];
  if (w.completed_at) parts.push(`Completed ${escapeHtml(fmtDate(w.completed_at))}${w.completed_by ? " by " + escapeHtml(w.completed_by) : ""}`);
  if (w.status === "closed") parts.push("Closed");
  return `<div class="warning-timeline">${parts.join(" → ")}</div>`;
}

// Lifecycle + print buttons available on a warning.
function warningActions(w) {
  const btns = [];
  btns.push(`<button class="mini-btn" onclick="printWarning(${w.id})">🖨 ${w.type === "VW" ? "Print reminder" : "Print write-up"}</button>`);
  const hasCons = w.consequence_type && w.consequence_type !== "none";
  if (w.status === "consequence_open" || (w.status === "issued" && hasCons)) {
    btns.push(`<button class="mini-btn" onclick="completeWarning(${w.id})">✓ Mark consequence completed</button>`);
  } else if (w.status === "completed" || (w.status === "issued" && !hasCons)) {
    btns.push(`<button class="mini-btn" onclick="closeWarning(${w.id})">Close out</button>`);
  }
  if (canEditWarning(w)) btns.push(`<button class="mini-btn" onclick="openWarningEditModal(${w.id})">✏️ Edit</button>`);
  if (currentProfile && currentProfile.role === "admin" && w.edit_count > 0) {
    btns.push(`<button class="mini-btn" onclick="openWarningHistory(${w.id})">🕓 History</button>`);
  }
  if (currentProfile && currentProfile.role === "admin" && w.status !== "voided") {
    btns.push(`<button class="mini-btn mini-btn-danger" onclick="voidWarning(${w.id})">🗑 Delete</button>`);
  }
  return btns.length ? `<div class="warning-card-actions">${btns.join("")}</div>` : "";
}

// Admin delete = soft void (recoverable, audited). Removed from the active list
// and all counts; findable again via the "Voided" status filter.
async function voidWarning(id) {
  if (!confirm("Delete this infraction?\n\nIt will be removed from the list and excluded from all counts. This is logged and recoverable — filter Status to \"Voided\" to find it.")) return;
  try {
    const j = await fetch(`/api/warnings/${id}/void`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voided_by: currentUserKey() }),
    }).then(r => r.json());
    if (j.error) throw new Error(j.error.message);
    await renderWarnings();
  } catch (e) { alert("Could not delete: " + e.message); }
}

async function completeWarning(id) {
  if (!confirm("Mark this consequence as completed? This writes a log-book entry.")) return;
  try {
    await fetch(`/api/warnings/${id}/complete`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed_by: currentUserKey() }) });
    await renderWarnings();
  } catch {}
}
async function closeWarning(id) {
  try {
    await fetch(`/api/warnings/${id}/close`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await renderWarnings();
  } catch {}
}

// ── Edit an infraction (e.g. extend the due date) ─────────────────────────────
let pendingWarnEditId = null;
const WARN_FIELD_LABELS = {
  rule_id: "Rule", occurred_at: "Date", shift: "Shift", narrative: "What happened",
  consequence_type: "Consequence", consequence_detail: "Paper topic", consequence_due: "Consequence due",
};

// You can edit an infraction you issued; admins can edit any.
function canEditWarning(w) {
  return currentProfile && (currentProfile.role === "admin" || w.issued_by === currentProfile.full_name);
}

function openWarningEditModal(id) {
  const w = _warnings.find(x => x.id === id);
  if (!w) return;
  pendingWarnEditId = id;
  document.getElementById("we-rule").innerHTML = '<option value="">—</option>' +
    _rules.filter(r => r.active).map(r => `<option value="${r.id}">${escapeHtml(r.label)}</option>`).join("");
  document.getElementById("we-rule").value = w.rule_id || "";
  document.getElementById("we-due").value = w.consequence_due || "";
  document.getElementById("we-cons-type").value = w.consequence_type || "none";
  document.getElementById("we-cons-detail").value = w.consequence_detail || "";
  onEditConsTypeChange();   // show/label the detail field to match the type
  document.getElementById("we-date").value = w.occurred_at || "";
  document.getElementById("we-shift").value = w.shift || "";
  document.getElementById("we-narrative").value = w.narrative || "";
  document.getElementById("we-context").textContent = `${w.type}#${w.seq_number} · ${w.client_name}`;
  document.getElementById("we-error").classList.add("hidden");
  document.getElementById("warning-edit-modal").classList.remove("hidden");
}
function closeWarningEditModal() { pendingWarnEditId = null; document.getElementById("warning-edit-modal").classList.add("hidden"); }

async function confirmWarningEdit() {
  const id = pendingWarnEditId;
  const errEl = document.getElementById("we-error");
  const fields = {
    rule_id: gv("we-rule") ? Number(gv("we-rule")) : null,
    occurred_at: gv("we-date"),
    shift: gv("we-shift"),
    narrative: gv("we-narrative").trim(),
    consequence_type: gv("we-cons-type"),
    consequence_detail: gv("we-cons-detail").trim(),
    consequence_due: gv("we-due"),
  };
  try {
    const j = await fetch(`/api/warnings/${id}/edit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editor: currentUserKey(), fields }),
    }).then(r => r.json());
    if (j.error) throw new Error(j.error.message);
    closeWarningEditModal();
    await renderWarnings();
  } catch (e) { errEl.textContent = "Could not save: " + e.message; errEl.classList.remove("hidden"); }
}

async function openWarningHistory(id) {
  const modal = document.getElementById("warning-history-modal");
  const body = document.getElementById("warning-history-body");
  body.innerHTML = "<p class='muted'>Loading…</p>";
  modal.classList.remove("hidden");
  try {
    const j = await fetch(`/api/warnings/${id}/history`).then(r => r.json());
    const items = (j.data && j.data.items) || [];
    if (!items.length) { body.innerHTML = "<p class='muted'>No edits recorded.</p>"; return; }
    body.innerHTML = items.map(it => {
      let ch = {};
      try { ch = JSON.parse(it.changes); } catch {}
      const rows = Object.entries(ch).map(([f, v]) => `
        <div class="hist-change">
          <span class="hist-field">${escapeHtml(WARN_FIELD_LABELS[f] || f)}</span>
          <span class="hist-from">${escapeHtml(String(v.from ?? "—"))}</span>
          <span class="hist-arrow">→</span>
          <span class="hist-to">${escapeHtml(String(v.to ?? "—"))}</span>
        </div>`).join("");
      return `<div class="hist-entry"><div class="hist-meta"><b>${escapeHtml(it.edited_by)}</b> · ${fmtDateTime(it.edited_at)}</div>${rows}</div>`;
    }).join("");
  } catch { body.innerHTML = "<p class='error'>Could not load history.</p>"; }
}
function closeWarningHistory() { document.getElementById("warning-history-modal").classList.add("hidden"); }

function clearWarningFilters() {
  ["wf-type", "wf-status", "wf-client", "wf-search"].forEach(id => { const e = document.getElementById(id); if (e) e.value = ""; });
  renderWarnings();
}

// ── Create form ───────────────────────────────────────────────────────────────
// The consequence-detail field is only relevant for paper (topic) and
// therapeutic (free-text) consequences; hidden otherwise.
function consDetailConfig(type) {
  if (type === "paper")
    return { show: true, label: "Paper topic", ph: "Topic for a paper consequence (used in the printed write-up)" };
  if (type === "therapeutic")
    return { show: true, label: "Describe the therapeutic consequence", ph: "What is the therapeutic consequence? (shown on the printed write-up)" };
  return { show: false, label: "", ph: "" };
}
function applyConsDetail(typeVal, wrapId, labelId, inputId) {
  const c = consDetailConfig(typeVal);
  const wrap = document.getElementById(wrapId);
  if (wrap) wrap.hidden = !c.show;
  const lbl = document.getElementById(labelId);
  if (lbl) lbl.textContent = c.label || "Detail";
  const inp = document.getElementById(inputId);
  if (inp) inp.placeholder = c.ph;
}
function onWarnConsTypeChange() {
  applyConsDetail(gv("w-cons-type"), "w-cons-detail-wrap", "w-cons-detail-label", "w-cons-detail");
  // The due date is only required once a consequence is chosen.
  const due = document.getElementById("w-cons-due-label");
  if (due) due.classList.toggle("req", gv("w-cons-type") !== "none");
}

// Required-field check: returns "" when all present, else a message naming each
// missing field. checks = [[label, value], ...]; also marks the inputs red.
function missingFieldsMsg(checks) {
  const missing = checks.filter(([, v]) => !String(v ?? "").trim()).map(([label]) => label);
  return missing.length ? `Please fill in: ${missing.join(", ")}.` : "";
}
function markInvalid(ids) {
  ids.forEach(([id, bad]) => { const e = document.getElementById(id); if (e) e.classList.toggle("field-invalid", !!bad); });
}
function onEditConsTypeChange() {
  applyConsDetail(gv("we-cons-type"), "we-cons-detail-wrap", "we-cons-detail-label", "we-cons-detail");
}

function openWarningForm() {
  document.getElementById("warning-modal").classList.remove("hidden");
  document.getElementById("w-quickclient").hidden = true;   // collapse the quick-add panel
  document.getElementById("w-date").value = todayStr();
  document.getElementById("w-shift").value = shiftForTime();                        // default shift by current time
  const savedCampus = localStorage.getItem(CAMPUS_KEY);                             // this station's usual campus
  if (savedCampus) document.getElementById("w-campus").value = savedCampus;
  document.getElementById("w-initials").value = (currentProfile && currentProfile.full_name) || "";
  document.getElementById("w-cons-type").value = "none";
  onWarnConsTypeChange();                                                           // hide the detail field for "none"
  document.getElementById("w-error").classList.add("hidden");
  document.querySelectorAll("#warning-modal .field-invalid").forEach(e => e.classList.remove("field-invalid"));
  populateRuleSelect(null);
}

function closeWarningForm() {
  document.getElementById("warning-modal").classList.add("hidden");
  ["w-client", "w-type", "w-rule", "w-rule-detail", "w-narrative", "w-cons-detail", "w-cons-due", "w-shift"].forEach(id => {
    const e = document.getElementById(id); if (e) e.value = "";
  });
  document.getElementById("w-cons-type").value = "none";
  document.getElementById("w-seq-preview").textContent = "—";
  document.getElementById("w-history").innerHTML = "";
  ["qc-name", "qc-counselor", "qc-admitted", "qc-campus"].forEach(id => { const e = document.getElementById(id); if (e) e.value = ""; });
  document.getElementById("w-quickclient").hidden = true;
}

// Quick-add a client to the roster from inside the New Infraction form.
function toggleQuickAddClient() {
  const el = document.getElementById("w-quickclient");
  el.hidden = !el.hidden;
  if (!el.hidden) {
    document.getElementById("qc-error").classList.add("hidden");
    document.getElementById("qc-name").focus();
  }
}

async function quickAddClient() {
  const err = document.getElementById("qc-error");
  const name = gv("qc-name").trim();
  const checks = [["qc-name", "Full name", name], ["qc-counselor", "Clinician", gv("qc-counselor")],
                  ["qc-campus", "Campus", gv("qc-campus")], ["qc-admitted", "Admitted", gv("qc-admitted")]];
  markInvalid(checks.map(([id, , v]) => [id, !String(v ?? "").trim()]));
  const missingMsg = missingFieldsMsg(checks.map(([, label, v]) => [label, v]));
  if (missingMsg) { err.textContent = missingMsg; err.classList.remove("hidden"); return; }
  const body = {
    full_name: name,
    counselor: gv("qc-counselor").trim(),
    phase: Number(gv("qc-phase")) || 1,
    campus: gv("qc-campus"),
    admitted_at: gv("qc-admitted"),
  };
  try {
    const j = await fetch("/api/clients", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(r => r.json());
    if (j.error) throw new Error(j.error.message);
    const created = j.data && j.data[0];
    await loadWarningsBaseData();        // refresh the roster list
    populateWarningSelects();            // rebuild the client dropdowns
    if (created) {
      document.getElementById("w-client").value = String(created.id);
      await onWarningClientChange();      // load the phase-filtered rules + history + number
    }
    ["qc-name", "qc-counselor", "qc-admitted", "qc-campus"].forEach(id => { document.getElementById(id).value = ""; });
    document.getElementById("qc-phase").value = "1";
    err.classList.add("hidden");
    document.getElementById("w-quickclient").hidden = true;
  } catch (e) { err.textContent = "Could not add: " + e.message; err.classList.remove("hidden"); }
}

async function onWarningClientChange() {
  const cid = gv("w-client");
  const client = _clients.find(c => String(c.id) === String(cid));
  populateRuleSelect(client ? client.phase : null);
  updateSeqPreview();
  await renderWarningHistory(cid);
}

async function updateSeqPreview() {
  const cid = gv("w-client"), type = gv("w-type");
  const el = document.getElementById("w-seq-preview");
  if (!cid || !type) { el.textContent = "—"; return; }
  try {
    const j = await fetch(`/api/warnings/next?client_id=${encodeURIComponent(cid)}&type=${encodeURIComponent(type)}`).then(r => r.json());
    const n = j && j.data && j.data.next;
    el.textContent = n ? `${type}#${n}` : "—";
  } catch { el.textContent = "—"; }
}

// Full client history shown inline while writing — the pattern the paper hides.
async function renderWarningHistory(clientId) {
  const box = document.getElementById("w-history");
  if (!box) return;
  if (!clientId) { box.innerHTML = ""; return; }
  box.innerHTML = "<p class='muted'>Loading history…</p>";
  try {
    const j = await fetch(`/api/warnings/client/${encodeURIComponent(clientId)}`).then(r => r.json());
    const items = (j && j.data) || [];
    if (!items.length) {
      box.innerHTML = "<div class='warning-history-inner'><h4>Warning history</h4><p class='muted'>No prior warnings for this client.</p></div>";
      return;
    }
    const counts = items.reduce((a, w) => { a[w.type] = (a[w.type] || 0) + 1; return a; }, {});
    const summary = ["VW", "WW", "WU"].filter(t => counts[t]).map(t => `${t}: ${counts[t]}`).join(" · ");
    const rows = items.map(w => `
      <tr>
        <td><b>${w.type}#${w.seq_number}</b></td>
        <td>${escapeHtml(w.rule_label || w.rule_detail || "—")}</td>
        <td>${escapeHtml(fmtDate(w.occurred_at || w.issued_at))}</td>
        <td>${warningConsequenceLabel(w)}</td>
        <td>${escapeHtml(warningStatusLabel(w.status))}</td>
      </tr>`).join("");
    box.innerHTML = `<div class='warning-history-inner'>
      <h4>Warning history <span class="muted">(${escapeHtml(summary)})</span></h4>
      <table class="warning-history-table">
        <thead><tr><th>#</th><th>Rule</th><th>Date</th><th>Consequence</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  } catch { box.innerHTML = "<p class='error'>Could not load history.</p>"; }
}

async function submitWarning() {
  const errEl = document.getElementById("w-error");
  const warnErr = (m) => { errEl.textContent = m; errEl.classList.remove("hidden"); };
  const client_id = gv("w-client"), type = gv("w-type"), rule_id = gv("w-rule");
  const consType = gv("w-cons-type");
  const needsDetail = consType === "paper" || consType === "therapeutic";
  const checks = [
    ["w-client", "Client", client_id], ["w-type", "Type", type], ["w-rule", "Rule", rule_id],
    ["w-date", "Date", gv("w-date")], ["w-shift", "Shift", gv("w-shift")],
    ["w-narrative", "What happened", gv("w-narrative")],
  ];
  if (consType !== "none") checks.push(["w-cons-due", "Consequence due", gv("w-cons-due")]);
  if (needsDetail) checks.push(["w-cons-detail", consDetailConfig(consType).label, gv("w-cons-detail")]);
  markInvalid(checks.map(([id, , v]) => [id, !String(v ?? "").trim()]));
  const missingMsg = missingFieldsMsg(checks.map(([, label, v]) => [label, v]));
  if (missingMsg) return warnErr(missingMsg);
  errEl.classList.add("hidden");
  const body = {
    client_id: Number(client_id),
    rule_id: rule_id ? Number(rule_id) : null,
    type,
    rule_detail: null,
    occurred_at: gv("w-date"),
    shift: gv("w-shift"),
    campus: gv("w-campus") || "North Campus",
    narrative: gv("w-narrative").trim(),
    consequence_type: gv("w-cons-type"),
    consequence_detail: gv("w-cons-detail").trim(),
    consequence_due: gv("w-cons-due"),
    issued_by: currentUserKey(),
    issued_by_initials: gv("w-initials").trim(),
  };
  if (body.campus) localStorage.setItem(CAMPUS_KEY, body.campus);   // remember this station's campus
  try {
    const j = await fetch("/api/warnings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(r => r.json());
    if (j.error) throw new Error(j.error.message);
    const created = j.data && j.data[0];
    closeWarningForm();
    // Reset the list filters so the new infraction is shown (and loaded for printing).
    ["wf-type", "wf-status", "wf-client", "wf-search"].forEach(id => { const e = document.getElementById(id); if (e) e.value = ""; });
    await renderWarnings();   // _warnings now holds the new infraction (with client/rule for printing)
    // Written warnings & write-ups get a printout — remind the issuer to print and hand it over now.
    if (created && (created.type === "WW" || created.type === "WU")) {
      if (confirm(`${created.type}#${created.seq_number} saved. Print it now to give to the client?`)) {
        printWarning(created.id);
      }
    }
  } catch (e) { warnErr("Could not save: " + e.message); }
}

// ── Manage roster (all staff) ────────────────────────────────────────────────────
async function openRosterModal() {
  document.getElementById("roster-modal").classList.remove("hidden");
  const s = document.getElementById("roster-search"); if (s) s.value = "";
  await renderRosterList();
}
function closeRosterModal() { document.getElementById("roster-modal").classList.add("hidden"); }

let _rosterCounts = {};   // client_id -> number of (non-voided) infractions

async function renderRosterList() {
  await loadWarningsBaseData();
  populateWarningSelects();
  _rosterCounts = {};
  try {
    const warns = await fetch("/api/warnings").then(r => r.json()).then(j => (j && j.data) || []);
    warns.forEach(w => { if (w.status !== "voided") _rosterCounts[w.client_id] = (_rosterCounts[w.client_id] || 0) + 1; });
  } catch {}
  drawRosterList();
}

// Re-render just the table (the search box lives in the modal, so it keeps focus).
function drawRosterList() {
  const box = document.getElementById("roster-list");
  if (!box) return;
  const q = (document.getElementById("roster-search")?.value || "").trim().toLowerCase();
  // Active clients first, discharged at the bottom (each group stays alphabetical,
  // as the API returns it — Array.sort is stable).
  const isOut = (c) => (c.status === "discharged" ? 1 : 0);
  const rows = _clients
    .filter(c => !q || `${c.full_name} ${c.counselor || ""}`.toLowerCase().includes(q))
    .sort((a, b) => isOut(a) - isOut(b));
  const nOut = rows.filter(isOut).length;
  if (!rows.length) {
    box.innerHTML = `<p class='muted'>${q ? "No clients match your search." : "No clients yet."}</p>`;
    return;
  }
  box.innerHTML =
    `<table class="mini-table"><thead><tr><th>Name</th><th>Clinician</th><th>Phase</th><th>Status</th><th>Infractions</th><th></th></tr></thead><tbody>${
      rows.map((c, i) => {
        const n = _rosterCounts[c.id] || 0;
        const divider = isOut(c) && (i === 0 || !isOut(rows[i - 1]))
          ? `<tr class="roster-divider"><td colspan="6">Discharged (${nOut})</td></tr>` : "";
        const infr = n > 0
          ? `<b>${n}</b> <button class="mini-btn" onclick="viewClientInfractions(${c.id})">View</button>`
          : `<span class="muted">None</span>`;
        return `${divider}<tr class="${isOut(c) ? "roster-discharged" : ""}">
          <td>${escapeHtml(c.full_name)}</td>
          <td>${escapeHtml(c.counselor || "—")}</td>
          <td>P${c.phase}</td>
          <td>${escapeHtml(c.status)}</td>
          <td>${infr}</td>
          <td>
            <button class="mini-btn" onclick="openClientEditModal(${c.id})">Edit</button>
            <button class="mini-btn" onclick="setClientPhase(${c.id}, ${c.phase === 2 ? 1 : 2})">Move to PH${c.phase === 2 ? 1 : 2}</button>
            ${c.status === "discharged"
              ? `<button class="mini-btn" onclick="reactivateClient(${c.id})">Reactivate</button>`
              : `<button class="mini-btn" onclick="dischargeClient(${c.id})">Discharge</button>`}
          </td>
        </tr>`;
      }).join("")
    }</tbody></table>`;
}

function filterRosterList() { drawRosterList(); }

// From the roster, jump to a client's infractions (closes the roster modal).
function viewClientInfractions(id) {
  closeRosterModal();
  const el = document.getElementById("wf-client");
  if (el) el.value = String(id);
  renderWarnings();
}

// Move a client between Phase 1 and Phase 2.
async function setClientPhase(id, phase) {
  try {
    await fetch(`/api/clients/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phase }) });
    await renderRosterList();
  } catch {}
}

// Discharge keeps all of the client's data — it just removes them from the
// New Infraction picker. Reactivate reverses it.
async function dischargeClient(id) {
  if (!confirm("Discharge this client? Their full history stays accessible; they're only removed from the New Infraction list.")) return;
  try {
    await fetch(`/api/clients/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "discharged", discharged_at: new Date().toISOString() }) });
    await renderRosterList();
  } catch {}
}
async function reactivateClient(id) {
  try {
    await fetch(`/api/clients/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active", discharged_at: null }) });
    await renderRosterList();
  } catch {}
}

// ── Edit a roster profile ──
let _editClientId = null;
const CLIENT_FIELD_LABELS = {
  full_name: "Name", counselor: "Clinician", phase: "Phase", campus: "Campus",
  client_code: "Client ID", admitted_at: "Admitted", discharged_at: "Discharged",
};
const dateOnly = (v) => (v ? String(v).slice(0, 10) : "");

async function openClientEditModal(id) {
  const c = _clients.find(x => x.id === id);
  if (!c) return;
  _editClientId = id;
  document.getElementById("ce-context").textContent =
    `${c.full_name} · ${c.status === "discharged" ? "Discharged" : "Active"}`;
  document.getElementById("ce-name").value = c.full_name || "";
  document.getElementById("ce-counselor").value = c.counselor || "";
  document.getElementById("ce-phase").value = String(c.phase || 1);
  document.getElementById("ce-campus").value = c.campus || "North Campus";
  document.getElementById("ce-admitted").value = dateOnly(c.admitted_at);
  document.getElementById("ce-code").value = c.client_code || "";
  document.getElementById("ce-discharged").value = dateOnly(c.discharged_at);
  document.getElementById("ce-discharged-field").classList.toggle("hidden", c.status !== "discharged");
  document.getElementById("ce-error").classList.add("hidden");
  document.getElementById("ce-history").innerHTML = "";
  document.querySelectorAll("#client-edit-modal .field-invalid").forEach(e => e.classList.remove("field-invalid"));
  document.getElementById("client-edit-modal").classList.remove("hidden");
  document.getElementById("ce-name").focus();
  loadClientHistory(id);
}

function closeClientEditModal() {
  document.getElementById("client-edit-modal").classList.add("hidden");
  _editClientId = null;
}

async function loadClientHistory(id) {
  const box = document.getElementById("ce-history");
  try {
    const j = await fetch(`/api/clients/${id}/history`).then(r => r.json());
    const rows = (j && j.data) || [];
    if (_editClientId !== id || !rows.length) return;
    const fmtVal = (f, v) => (v == null || v === "" ? "—" : f.endsWith("_at") ? fmtDate(dateOnly(v)) : String(v));
    box.innerHTML = `<h4>Edit history</h4>` + rows.map(r =>
      `<div class="ce-hist-row"><span class="muted">${escapeHtml(fmtDateTime(r.edited_at))} · ${escapeHtml(r.edited_by)}</span>` +
      Object.entries(r.changes).map(([f, ch]) =>
        `<div>${escapeHtml(CLIENT_FIELD_LABELS[f] || f)}: ${escapeHtml(fmtVal(f, ch.from))} → <b>${escapeHtml(fmtVal(f, ch.to))}</b></div>`).join("") +
      `</div>`).join("");
  } catch { /* history is optional */ }
}

async function confirmClientEdit() {
  const c = _clients.find(x => x.id === _editClientId);
  if (!c) return;
  const err = document.getElementById("ce-error");
  const name = gv("ce-name").trim();
  const checks = [["ce-name", "Full name", name], ["ce-counselor", "Clinician", gv("ce-counselor")],
                  ["ce-campus", "Campus", gv("ce-campus")], ["ce-admitted", "Admitted", gv("ce-admitted")]];
  markInvalid(checks.map(([id, , v]) => [id, !String(v ?? "").trim()]));
  const missingMsg = missingFieldsMsg(checks.map(([, label, v]) => [label, v]));
  if (missingMsg) { err.textContent = missingMsg; err.classList.remove("hidden"); return; }
  const fields = {
    full_name: name,
    counselor: gv("ce-counselor").trim(),
    phase: Number(gv("ce-phase")) || 1,
    campus: gv("ce-campus"),
    client_code: gv("ce-code").trim(),
    admitted_at: gv("ce-admitted"),
  };
  // discharged_at is a full timestamp; only send it if the DATE was changed.
  if (c.status === "discharged" && gv("ce-discharged") !== dateOnly(c.discharged_at)) {
    fields.discharged_at = gv("ce-discharged");
  }
  try {
    const j = await fetch(`/api/clients/${c.id}/edit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editor: currentUserKey(), fields }),
    }).then(r => r.json());
    if (j.error) throw new Error(j.error.message);
    closeClientEditModal();
    await renderRosterList();
  } catch (e) { err.textContent = "Could not save: " + e.message; err.classList.remove("hidden"); }
}

async function addClient() {
  const err = document.getElementById("rc-error");
  const name = gv("rc-name").trim();
  const checks = [["rc-name", "Full name", name], ["rc-counselor", "Clinician", gv("rc-counselor")],
                  ["rc-campus", "Campus", gv("rc-campus")], ["rc-admitted", "Admitted", gv("rc-admitted")]];
  markInvalid(checks.map(([id, , v]) => [id, !String(v ?? "").trim()]));
  const missingMsg = missingFieldsMsg(checks.map(([, label, v]) => [label, v]));
  if (missingMsg) { err.textContent = missingMsg; err.classList.remove("hidden"); return; }
  const body = { full_name: name, counselor: gv("rc-counselor").trim(), phase: Number(gv("rc-phase")) || 1,
                 campus: gv("rc-campus"), admitted_at: gv("rc-admitted") };
  try {
    const j = await fetch("/api/clients", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
    if (j.error) throw new Error(j.error.message);
    ["rc-name", "rc-counselor", "rc-admitted", "rc-campus"].forEach(id => { document.getElementById(id).value = ""; });
    err.classList.add("hidden");
    await renderRosterList();
  } catch (e) { err.textContent = "Could not add: " + e.message; err.classList.remove("hidden"); }
}

// ── Manage rule catalog (all staff) ──────────────────────────────────────────────
async function openRulesModal() { document.getElementById("rules-modal").classList.remove("hidden"); await renderRulesList(); }
function closeRulesModal() { document.getElementById("rules-modal").classList.add("hidden"); }

async function renderRulesList() {
  try { const j = await fetch("/api/rules").then(r => r.json()); _rules = (j && j.data) || []; } catch {}
  const box = document.getElementById("rules-list");
  box.innerHTML = _rules.length
    ? `<table class="mini-table"><thead><tr><th>Label</th><th>Phase</th><th>Active</th><th></th></tr></thead><tbody>${
        _rules.map(r => `<tr>
          <td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.phase)}</td><td>${r.active ? "yes" : "no"}</td>
          <td><button class="mini-btn" onclick="toggleRule(${r.id}, ${r.active ? 0 : 1})">${r.active ? "Retire" : "Restore"}</button></td>
        </tr>`).join("")
      }</tbody></table>`
    : "<p class='muted'>No rules.</p>";
}

async function addRule() {
  const err = document.getElementById("rl-error");
  const label = gv("rl-label").trim();
  if (!label) { err.textContent = "Label required."; err.classList.remove("hidden"); return; }
  const body = { label, phase: gv("rl-phase") || "both", sort_order: Number(gv("rl-sort")) || 100 };
  try {
    const j = await fetch("/api/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
    if (j.error) throw new Error(j.error.message);
    document.getElementById("rl-label").value = "";
    err.classList.add("hidden");
    await renderRulesList();
  } catch (e) { err.textContent = "Could not add: " + e.message; err.classList.remove("hidden"); }
}

async function toggleRule(id, active) {
  try {
    await fetch(`/api/rules/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: !!active }) });
    await renderRulesList();
  } catch {}
}

// ── Printed write-up (WW / WU only) ───────────────────────────────────────────
function warningTypeLabel(t) { return ({ VW: "Verbal Warning", WW: "Written Warning", WU: "Write-Up" })[t] || t; }

// Browser-print (print stylesheet). Renders ONE copy for the client into
// #print-root and opens the print dialog — the file record lives in the log,
// so we don't print a second copy.
function printWarning(id) {
  const w = _warnings.find(x => x.id === id);
  if (!w) return;
  const root = document.getElementById("print-root");
  root.innerHTML = warningPrintCopy(w);
  window.print();
}

// Standard write-up language, filled in at print time.
function warningConsequenceText(w) {
  const due = w.consequence_due ? fmtDate(w.consequence_due) : "____";
  if (w.consequence_type === "chores") {
    return `Two hours of chores to be completed by ${due}, Sunday at 8pm. Chore must be checked off by a BHT. Failure to do so will result in write up. Your chore will be given to you Saturday morning.`;
  }
  if (w.consequence_type === "paper") {
    const topic = (w.consequence_detail || "").trim() || "____";
    return `Two page paper, 8x11, handwritten, on the topic of "${topic}" paper is due ${due} at 8pm. Paper needs to be turned into BHT office. Failure to do so will result in write up.`;
  }
  if (w.consequence_type === "therapeutic") {
    const detail = (w.consequence_detail || "").trim() || "____";
    const by = w.consequence_due ? ` To be completed by ${due} at 8pm.` : "";
    return `Therapeutic consequence: ${detail}.${by} Failure to do so will result in write up.`;
  }
  return "None";
}

// Top-left subtitle per type.
function warningSubtitle(type) {
  if (type === "VW") return "Rule Infraction — Verbal Warning";
  return type === "WW" ? "Rule Infraction — Written Warning" : "Rule Infraction Write-Up";
}

function warningPrintCopy(w, copyLabel) {
  const phase = w.phase_at_time || w.client_phase || "";
  const clinician = w.client_counselor || "";
  return `
    <div class="print-copy">
      <div class="print-head">
        <div class="print-head-left">
          <div class="print-org">Demo Recovery Center</div>
          <div class="print-subtitle">${escapeHtml(warningSubtitle(w.type))}</div>
        </div>
        <div class="print-head-right">
          <div class="print-badge">${w.type}#${w.seq_number}</div>
          ${clinician ? `<div class="print-clinician"><span class="print-clinician-label">Clinician</span>${escapeHtml(clinician)}</div>` : ""}
        </div>
      </div>
      ${copyLabel ? `<div class="print-copylabel">${escapeHtml(copyLabel)}</div>` : ""}
      <table class="print-fields">
        <tr><td>Client</td><td>${escapeHtml(w.client_name || "")}</td><td>Phase</td><td>${escapeHtml(String(phase))}</td></tr>
        <tr><td>Date</td><td>${escapeHtml(fmtDate(w.occurred_at || w.issued_at))}</td><td>Shift</td><td>${escapeHtml(w.shift || "")}</td></tr>
        <tr><td>Campus</td><td>${escapeHtml(w.campus || "")}</td><td>Type</td><td>${escapeHtml(warningTypeLabel(w.type))}</td></tr>
      </table>
      <div class="print-section"><span class="print-label">Rule Violated</span><div>${escapeHtml(w.rule_label || "—")}</div></div>
      <div class="print-section"><span class="print-label">What Happened</span><div class="print-narrative">${escapeHtml(w.narrative || "")}</div></div>
      ${w.type === "VW"
        ? `<div class="print-section"><span class="print-label">Note</span><div>Verbal warning — a reminder of the rule above. No consequence is attached.</div></div>`
        : `<div class="print-section"><span class="print-label">Consequence &amp; Due Date</span><div>${escapeHtml(warningConsequenceText(w))}</div></div>`}
      <div class="print-signatures">
        <div class="sig"><div class="sig-line"></div>Client signature / date</div>
        <div class="sig"><div class="sig-line"></div>Staff signature / date</div>
      </div>
      <div class="print-footer">Record #${w.id}</div>
    </div>`;
}

// ── Attachments (photos / documents) ──────────────────────

// Upload each File to Supabase Storage; return metadata to store on the row.
async function uploadFiles(files) {
  if (!files || !files.length) return [];
  const folder = crypto.randomUUID ? crypto.randomUUID()
    : String(Date.now()) + Math.random().toString(36).slice(2);
  const out = [];
  for (const f of files) {
    const safe = (f.name || "file").replace(/[^\w.\-]+/g, "_");
    const path = `${folder}/${Date.now()}_${safe}`;
    const { error } = await db.storage.from(ATTACH_BUCKET).upload(path, f, {
      contentType: f.type || undefined,
      upsert: false,
    });
    if (error) throw error;
    out.push({ path, name: f.name, type: f.type || "", size: f.size || 0 });
  }
  return out;
}

// Build the table cell that lists an entry's attachments.
function attachmentsCell(r) {
  if (r._pending) {
    const n = (r._files && r._files.length) || 0;
    return n ? `<span class="attach-pending">${n} file${n > 1 ? "s" : ""} (pending)</span>` : "";
  }
  const list = r.attachments || [];
  if (!list.length) return "";
  return `<div class="attach-list">` + list.map((a, i) => {
    const name  = a.name || "file";
    const label = name.length > 20 ? name.slice(0, 18) + "…" : name;
    return `<button class="attach-chip" title="${escapeHtml(name)}" onclick="openAttachment(${r.id}, ${i})">📎 ${escapeHtml(label)}</button>`;
  }).join("") + `</div>`;
}

// Open a private file via a short-lived signed URL.
async function openAttachment(id, idx) {
  const entry = allEntries.find(e => String(e.id) === String(id));
  if (!entry || !entry.attachments || !entry.attachments[idx]) return;
  try {
    const { data, error } = await db.storage
      .from(ATTACH_BUCKET)
      .createSignedUrl(entry.attachments[idx].path, 120);
    if (error) throw error;
    window.open(data.signedUrl, "_blank", "noopener");
  } catch (err) {
    alert("Could not open attachment: " + err.message);
  }
}

// ── CSV export ────────────────────────────────────────────

function exportCsv() {
  if (!currentView.length) { alert("No entries to export."); return; }

  const headers = ["Date","Shift","Time","Name","Campus","Event Type","Narrative",
                   "Follow-Up Needed","Follow-Up Notes/Assigned To","Resolved","Resolved By","Resolved At","Resolution Notes","Attachments"];

  const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;

  const lines = [headers.join(",")];
  currentView.forEach(r => {
    const attachNames = (r.attachments || []).map(a => a.name).join("; ");
    lines.push([
      r.date, r.shift, r.time, r.name, r.campus, r.eventType, r.narrative,
      r.followUpNeeded, r.followUpNotes,
      r.resolved ? "Yes" : "No", r.resolvedBy, r.resolvedAt ? fmtDate(r.resolvedAt) : "", r.resolutionNotes,
      attachNames
    ].map(cell).join(","));
  });

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = `shift-log-${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Offline queue & sync ──────────────────────────────────
// Entries logged without a connection are stored in IndexedDB (with their
// files) and pushed to Supabase when the connection returns.

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const dbi = req.result;
      if (!dbi.objectStoreNames.contains(IDB_STORE)) {
        dbi.createObjectStore(IDB_STORE, { keyPath: "key", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbAdd(value) {
  return idbOpen().then(dbi => new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).add({ value, ts: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbGetAll() {
  return idbOpen().then(dbi => new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_STORE, "readonly");
    const out = [];
    tx.objectStore(IDB_STORE).openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { out.push({ key: cur.key, value: cur.value.value }); cur.continue(); }
      else resolve(out);
    };
    tx.onerror = () => reject(tx.error);
  }));
}

function idbDelete(key) {
  return idbOpen().then(dbi => new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbCount() {
  return idbOpen().then(dbi => new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  })).catch(() => 0);
}

// Map queued records into the same shape the log table renders.
async function getPendingAsEntries() {
  let items = [];
  try { items = await idbGetAll(); } catch (e) { items = []; }
  return items.map(it => {
    const r = (it.value && it.value.row) || {};
    return {
      id: "pending-" + it.key,
      _pending: true,
      _files: (it.value && it.value.files) || [],
      date: r.date, shift: r.shift, time: r.time,
      name: r.staff_name, campus: r.campus, eventType: r.event_type,
      narrative: r.narrative, followUpNeeded: r.follow_up_needed,
      followUpNotes: r.follow_up_notes,
      resolved: false, attachments: [],
    };
  });
}

// Show "Offline" in the header when there's no connection.
function updateNetStatus() {
  const el = document.getElementById("net-status");
  if (el) el.classList.toggle("hidden", navigator.onLine);
}

// Show "N pending sync" in the header.
async function refreshPending() {
  const n = await idbCount();
  const badge = document.getElementById("pending-badge");
  if (!badge) return;
  badge.textContent = `${n} pending sync`;
  badge.classList.toggle("hidden", n === 0);
}

// Push queued entries to Supabase. Stops on the first failure and retries later.
let syncing = false;
async function flushQueue() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  let synced = 0;
  try {
    const items = await idbGetAll();
    for (const it of items) {
      try {
        const attachments = await uploadFiles(it.value.files || []);
        const { error } = await db.from("shift_log").insert({ ...it.value.row, attachments });
        if (error) throw error;
        await idbDelete(it.key);
        synced++;
      } catch (e) {
        break;   // leave this and the rest queued for the next attempt
      }
    }
  } finally {
    syncing = false;
    await refreshPending();
    const logVisible = !document.getElementById("tab-log").classList.contains("hidden");
    if (synced > 0 && logVisible) loadLog();
  }
}

// React to connectivity changes.
window.addEventListener("online", () => { updateNetStatus(); flushQueue(); });
window.addEventListener("offline", updateNetStatus);

// ── Shift handoff summary ─────────────────────────────────

let lastHandoffText = "";

function fmtFullDate(s) {
  const d = parseLocalDate(s);
  if (!d) return s || "";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

// Rough age of an open follow-up, for triage ("3d open", "5h open").
function ageLabel(entry) {
  const base = entry.createdAt ? new Date(entry.createdAt) : parseLocalDate(entry.date);
  if (!base || isNaN(base)) return "";
  const ms = Date.now() - base.getTime();
  if (ms < 0) return "new";
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days}d open`;
  return `${Math.max(1, Math.floor(ms / 3600000))}h open`;
}

async function initHandoff() {
  const dateEl = document.getElementById("ho-date");
  if (!dateEl.value) {
    const now = new Date();
    dateEl.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    document.getElementById("ho-shift").value = shiftForTime(t);
  }
  const byEl = document.getElementById("ho-by");
  if (!byEl.value) byEl.value = currentUserKey() || localStorage.getItem(NAME_KEY) || localStorage.getItem("shiftlog_resolver") || "";

  try {
    if (!allEntries.length) await fetchEntries();
  } catch (e) {
    const cached = localStorage.getItem(CACHE_KEY);
    allEntries = cached ? JSON.parse(cached) : [];
  }
  generateHandoff();
  loadHandoffs();
}

function generateHandoff() {
  const out = document.getElementById("handoff-output");
  if (!out) return;

  const campus = document.getElementById("ho-campus").value;
  const date   = document.getElementById("ho-date").value;
  const shift  = document.getElementById("ho-shift").value;
  const by     = document.getElementById("ho-by").value.trim();

  if (!date) {
    out.innerHTML = `<p class="handoff-empty">Pick a date to generate the summary.</p>`;
    lastHandoffText = "";
    return;
  }

  const inScope = (e) => !campus || e.campus === campus;
  const shiftEntries = allEntries
    .filter(e => e.date === date && e.shift === shift && inScope(e))
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  const openItems = allEntries
    .filter(e => isOpen(e) && inScope(e))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));   // oldest first = most urgent

  const byType    = countBy(shiftEntries, "eventType");
  const incidents = byType["Incident"] || 0;
  const medical   = byType["Medical"] || 0;
  const behavioral = byType["Behavioral"] || 0;
  const campusLabel = campus || "All Campuses";
  const generatedAt = new Date().toLocaleString();

  // On-screen HTML report.
  const statHtml = `
    <div class="ho-stats">
      <span class="ho-stat"><b>${shiftEntries.length}</b> entries this shift</span>
      <span class="ho-stat ${incidents ? "alert" : ""}"><b>${incidents}</b> incident${incidents === 1 ? "" : "s"}</span>
      <span class="ho-stat"><b>${medical}</b> medical</span>
      <span class="ho-stat ${openItems.length ? "alert" : ""}"><b>${openItems.length}</b> open follow-up${openItems.length === 1 ? "" : "s"}</span>
    </div>`;

  const openHtml = openItems.length
    ? `<ol class="ho-list">` + openItems.map(e => `
        <li class="ho-item">
          <div class="ho-item-head">${escapeHtml(e.eventType)} — ${escapeHtml(e.campus)} <span class="ho-meta">· ${escapeHtml(fmtDate(e.date))} · ${escapeHtml(e.name) || "—"} · <span class="ho-age">${ageLabel(e)}</span></span></div>
          <div class="ho-item-action"><b>Action:</b> ${escapeHtml(e.followUpNotes) || "—"}</div>
          <div class="ho-item-note">${escapeHtml(e.narrative)}</div>
        </li>`).join("") + `</ol>`
    : `<p class="ho-none">No open follow-ups — nothing outstanding.</p>`;

  const shiftHtml = shiftEntries.length
    ? `<ul class="ho-list">` + shiftEntries.map(e => {
        const status = isOpen(e) ? "Follow-up OPEN" : isResolved(e) ? "Follow-up resolved" : "No follow-up";
        return `
        <li class="ho-item">
          <div class="ho-item-head">${escapeHtml(e.time)} · ${escapeHtml(e.eventType)} · ${escapeHtml(e.campus)} <span class="ho-meta">· ${escapeHtml(e.name) || "—"}</span></div>
          <div class="ho-item-note">${escapeHtml(e.narrative)}</div>
          <div class="ho-item-action"><b>${status}</b></div>
        </li>`;
      }).join("") + `</ul>`
    : `<p class="ho-none">No entries were logged for this shift.</p>`;

  out.innerHTML = `
    <div class="ho-report">
      <div class="ho-title">Shift Handoff — ${escapeHtml(campusLabel)}</div>
      <div class="ho-sub">${escapeHtml(fmtFullDate(date))} · ${escapeHtml(shift)} shift · Prepared by ${escapeHtml(by) || "—"} · Generated ${escapeHtml(generatedAt)}</div>
      ${statHtml}
      <div class="ho-section">
        <h4>Open follow-ups requiring attention (${openItems.length})</h4>
        ${openHtml}
      </div>
      <div class="ho-section">
        <h4>Entries this shift (${shiftEntries.length})</h4>
        ${shiftHtml}
      </div>
    </div>`;

  // Plain-text version for copy / print.
  const L = [];
  L.push("SHIFT HANDOFF SUMMARY");
  L.push(`${campusLabel} — ${fmtFullDate(date)} — ${shift} shift`);
  L.push(`Prepared by: ${by || "—"}`);
  L.push(`Generated: ${generatedAt}`);
  L.push("");
  L.push("SNAPSHOT");
  L.push(`- Entries this shift: ${shiftEntries.length}`);
  L.push(`- Incidents: ${incidents}   Medical: ${medical}   Behavioral: ${behavioral}`);
  L.push(`- Open follow-ups (all dates): ${openItems.length}`);
  L.push("");
  L.push(`OPEN FOLLOW-UPS REQUIRING ATTENTION (${openItems.length})`);
  if (openItems.length) {
    openItems.forEach((e, i) => {
      L.push(`${i + 1}. ${fmtDate(e.date)} · ${e.campus} · ${e.eventType} (${ageLabel(e)}, logged by ${e.name || "—"})`);
      L.push(`   Action: ${e.followUpNotes || "—"}`);
      L.push(`   Note: ${e.narrative}`);
    });
  } else {
    L.push("None outstanding.");
  }
  L.push("");
  L.push(`ENTRIES THIS SHIFT (${shiftEntries.length})`);
  if (shiftEntries.length) {
    shiftEntries.forEach(e => {
      const status = isOpen(e) ? "Follow-up OPEN" : isResolved(e) ? "Follow-up resolved" : "No follow-up";
      L.push(`- ${e.time} · ${e.eventType} · ${e.campus} · ${e.name || "—"}`);
      L.push(`  ${e.narrative}`);
      L.push(`  ${status}`);
    });
  } else {
    L.push("No entries were logged for this shift.");
  }
  lastHandoffText = L.join("\n");
  renderHandoffStatus();
}

async function copyHandoff() {
  if (!lastHandoffText) { alert("Generate a summary first."); return; }
  try {
    await navigator.clipboard.writeText(lastHandoffText);
    const btn = window.event && window.event.target;
    if (btn) { const o = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = o; }, 1500); }
  } catch (e) {
    alert("Copy failed — you can select the summary text manually.");
  }
}

function printHandoff() {
  if (!lastHandoffText) { alert("Generate a summary first."); return; }
  const w = window.open("", "_blank");
  if (!w) { alert("Allow pop-ups to print the summary."); return; }
  w.document.write(`<pre style="font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;white-space:pre-wrap;padding:24px;margin:0">${escapeHtml(lastHandoffText)}</pre>`);
  w.document.title = "Shift Handoff Summary";
  w.document.close();
  w.focus();
  w.print();
}

// ── Handoff send + acknowledgement ────────────────────────
// The outgoing shift sends the generated summary; the incoming shift opens the
// Handoff tab, reads it and taps "Received", which records who and when and
// notifies the sender. Admins see a log of recent handoffs and their receipts.
let _handoffs = [];
const HANDOFF_PENDING_HOURS = 18;   // older un-received handoffs drop off "waiting for you"
const HANDOFF_LATE_HOURS    = 2;    // un-received after this long = flagged in the admin log

function handoffCampus() { return document.getElementById("ho-campus").value || "All Campuses"; }
function hoursSince(iso) { return (Date.now() - new Date(iso).getTime()) / 3600000; }
function fmtStamp(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Handoffs someone else sent that nobody has received yet (recent only).
function pendingHandoffs() {
  const me = currentUserKey();
  return _handoffs.filter(h => !h.ack_at && h.sent_by !== me && hoursSince(h.sent_at) <= HANDOFF_PENDING_HOURS);
}

async function fetchHandoffs() {
  const r = await fetch("/api/handoffs?limit=40").then(x => x.json());
  _handoffs = (r && r.data) || [];
}

async function loadHandoffs() {
  try { await fetchHandoffs(); } catch { return; }
  renderIncomingHandoffs();
  renderHandoffStatus();
  renderHandoffLog();
  renderHandoffBadge();
}

async function refreshHandoffBadge() {
  if (!currentProfile || restrictedType()) return;
  try { await fetchHandoffs(); } catch { return; }
  renderHandoffBadge();
}

function renderHandoffBadge() {
  const b = document.getElementById("ho-badge");
  if (!b) return;
  const n = pendingHandoffs().length;
  b.textContent = n;
  b.classList.toggle("hidden", n === 0);
}

// "Waiting for you" — handoffs the incoming shift still needs to receive.
function renderIncomingHandoffs() {
  const box = document.getElementById("ho-incoming");
  if (!box) return;
  const list = pendingHandoffs();
  if (!list.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="ho-incoming-title">Waiting for you to receive (${list.length})</div>` +
    list.map(h => `
      <div class="ho-in-item">
        <div class="ho-in-head">
          <span><b>${escapeHtml(h.campus)}</b> · ${escapeHtml(h.shift)} shift, ${escapeHtml(fmtDate(h.date))}
            <span class="ho-meta">· from ${escapeHtml(h.sent_by)} at ${escapeHtml(fmtStamp(h.sent_at))}</span></span>
          <span class="ho-in-actions">
            <button class="mini-btn" onclick="toggleHandoffText(${h.id})">View</button>
            <button class="mini-btn ho-ack-btn" onclick="ackHandoff(${h.id})">✓ Received</button>
          </span>
        </div>
        <pre id="ho-text-${h.id}" class="ho-sent-text hidden">${escapeHtml(h.summary)}</pre>
      </div>`).join("");
}

function toggleHandoffText(id) {
  const el = document.getElementById(`ho-text-${id}`);
  if (el) el.classList.toggle("hidden");
}

// Sent / received status of the handoff for the campus/date/shift picked above.
function renderHandoffStatus() {
  const box = document.getElementById("ho-status");
  if (!box) return;
  const date = document.getElementById("ho-date").value;
  const shift = document.getElementById("ho-shift").value;
  const h = _handoffs.find(x => x.campus === handoffCampus() && x.date === date && x.shift === shift);
  const btn = document.getElementById("ho-send-btn");
  if (btn) btn.textContent = h ? "Re-send handoff" : "Send handoff";
  if (!h) { box.innerHTML = `<span class="muted">Not sent yet. Send it so the next shift can mark it received.</span>`; return; }
  const sent = `Sent by ${escapeHtml(h.sent_by)} at ${escapeHtml(fmtStamp(h.sent_at))}`;
  if (h.ack_at) {
    box.innerHTML = `<span class="ho-pill ok">Received</span> ${sent} · received by <b>${escapeHtml(h.ack_by)}</b> at ${escapeHtml(fmtStamp(h.ack_at))}`;
  } else {
    const canAck = h.sent_by !== currentUserKey();
    box.innerHTML = `<span class="ho-pill wait">Awaiting receipt</span> ${sent}` +
      (canAck ? ` <button class="mini-btn ho-ack-btn" onclick="ackHandoff(${h.id})">✓ Received — I've read this handoff</button>` : "");
  }
}

function renderHandoffLog() {
  const box = document.getElementById("ho-log");
  if (!box) return;
  if (!_handoffs.length) { box.innerHTML = `<p class="ho-none">No handoffs have been sent yet.</p>`; return; }
  box.innerHTML = _handoffs.map(h => {
    const status = h.ack_at
      ? `<span class="ho-pill ok">Received · ${escapeHtml(h.ack_by)} ${escapeHtml(fmtStamp(h.ack_at))}</span>`
      : hoursSince(h.sent_at) > HANDOFF_LATE_HOURS
        ? `<span class="ho-pill late">Not received</span>`
        : `<span class="ho-pill wait">Waiting</span>`;
    return `<div class="ho-log-row">
      <span>${escapeHtml(fmtDate(h.date))} · ${escapeHtml(h.campus)} · ${escapeHtml(h.shift)} shift
        <span class="ho-meta">· sent by ${escapeHtml(h.sent_by)} ${escapeHtml(fmtStamp(h.sent_at))}</span></span>
      ${status}</div>`;
  }).join("");
}

async function sendHandoff() {
  if (!lastHandoffText) { alert("Generate a summary first."); return; }
  const date = document.getElementById("ho-date").value;
  const shift = document.getElementById("ho-shift").value;
  const existing = _handoffs.find(x => x.campus === handoffCampus() && x.date === date && x.shift === shift);
  if (existing && existing.sent_by !== currentUserKey() &&
      !confirm(`${existing.sent_by} already sent this handoff. Replace it with yours?`)) return;
  if (existing && existing.ack_at &&
      !confirm(`${existing.ack_by} already received this handoff. Re-send it? They'll need to receive the updated version.`)) return;
  try {
    const r = await fetch("/api/handoffs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campus: handoffCampus(), date, shift, sent_by: currentUserKey(), summary: lastHandoffText }),
    }).then(x => x.json());
    if (r.error) throw new Error(r.error.message);
    await loadHandoffs();
  } catch (e) {
    alert(`Could not send the handoff: ${e.message}`);
  }
}

async function ackHandoff(id) {
  try {
    const r = await fetch(`/api/handoffs/${id}/ack`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by: currentUserKey() }),
    }).then(x => x.json());
    if (r.error) throw new Error(r.error.message);
    await loadHandoffs();
  } catch (e) {
    alert(`Could not mark the handoff received: ${e.message}`);
  }
}

// ── Dashboard ─────────────────────────────────────────────

const charts = {};

function countBy(entries, key) {
  const out = {};
  entries.forEach(e => { const k = e[key] || "—"; out[k] = (out[k] || 0) + 1; });
  return out;
}

// Turn a {label: count} object into sorted top-N {labels, data} (descending).
function topN(counts, n) {
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
  return { labels: sorted.map(x => x[0]), data: sorted.map(x => x[1]) };
}

function drawChart(id, type, labels, data, colors, onLabelClick) {
  if (charts[id]) charts[id].destroy();
  const isLine = type === "line";
  const options = {
    responsive: true,
    plugins: { legend: { display: type === "doughnut" } },
    scales: (type === "bar" || isLine)
      ? { y: { beginAtZero: true, ticks: { precision: 0 } } }
      : {},
  };
  if (onLabelClick) {
    // Click a bar/slice to drill into the Log, pre-filtered.
    options.onClick = (evt, els, chart) => {
      if (els && els.length) onLabelClick(chart.data.labels[els[0].index]);
    };
    options.onHover = (evt, els) => {
      if (evt.native && evt.native.target) evt.native.target.style.cursor = els && els.length ? "pointer" : "default";
    };
  }
  charts[id] = new Chart(document.getElementById(id), {
    type,
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: isLine ? "rgba(37,99,235,.12)" : colors,
        borderColor:     isLine ? "#2563eb" : undefined,
        borderWidth:     isLine ? 2 : 0,
        fill:            isLine,
        tension:         isLine ? 0.3 : 0,
        pointRadius:     isLine ? 2 : undefined,
        pointBackgroundColor: isLine ? "#2563eb" : undefined,
      }],
    },
    options,
  });
}

// Multi-dataset bar chart — grouped (default) or stacked.
function drawMultiChart(id, labels, datasets, opts = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  if (charts[id]) charts[id].destroy();
  const stacked = !!opts.stacked;
  charts[id] = new Chart(el, {
    type: "bar",
    data: {
      labels,
      datasets: datasets.map(d => ({ label: d.label, data: d.data, backgroundColor: d.color, borderWidth: 0, borderRadius: 3 })),
    },
    options: {
      responsive: true,
      plugins: { legend: { display: true, position: "bottom", labels: { boxWidth: 12, padding: 12, font: { size: 11 } } } },
      scales: { x: { stacked }, y: { stacked, beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

// Monday-of-week local key for a "YYYY-MM-DD" date (for weekly bucketing).
function weekKey(dateStr) {
  const d = parseLocalDate(dateStr);
  if (!d) return null;
  const mon = new Date(d);
  mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localKey(mon);
}

// Click-through from a dashboard chart into the pre-filtered Log view.
function filterLogBy(kind, value) {
  ["filter-search", "filter-campus", "filter-event", "filter-followup", "filter-date-from", "filter-date-to"]
    .forEach(fid => { const el = document.getElementById(fid); if (el) el.value = ""; });
  const map = { event: "filter-event", campus: "filter-campus", search: "filter-search" };
  const el = document.getElementById(map[kind]);
  if (el) el.value = value;
  switchTab("log");   // loadLog() runs applyFilters() with the filter now set
}

// Tiny inline-SVG trend line for the stat cards.
function sparkline(values, color) {
  if (!values || values.length < 2) return "";
  const w = 100, h = 26;
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) =>
    `${(i * step).toFixed(1)},${(h - ((v - min) / range) * (h - 3) - 1.5).toFixed(1)}`).join(" ");
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
         `<polyline points="${pts}" fill="none" stroke="${color || "#2563eb"}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

// Parse a "YYYY-MM-DD" string as a LOCAL date (avoids the UTC off-by-one).
function parseLocalDate(s) {
  if (!s) return null;
  const [y, m, d] = String(s).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

// Counts of entries per weekday, Monday-first.
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function weekdayCounts(entries) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  entries.forEach(e => {
    const d = parseLocalDate(e.date);
    if (d) counts[(d.getDay() + 6) % 7]++;   // getDay: 0=Sun -> Mon-first index
  });
  return counts;
}

// Counts of entries per hour (0-23) from the "HH:MM" time field.
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => (h % 12 || 12) + (h < 12 ? "a" : "p"));
function hourCounts(entries) {
  const counts = new Array(24).fill(0);
  entries.forEach(e => {
    const h = e.time ? parseInt(e.time.split(":")[0], 10) : NaN;
    if (!isNaN(h) && h >= 0 && h < 24) counts[h]++;
  });
  return counts;
}
function formatHour(h) {
  const ampm = h < 12 ? "AM" : "PM";
  return `${h % 12 || 12} ${ampm}`;
}

// Index of the largest value, or -1 if every bucket is empty.
function peakIndex(arr) {
  const max = Math.max(...arr);
  return max > 0 ? arr.indexOf(max) : -1;
}

// Format a Date as a local "YYYY-MM-DD" key.
function localKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Daily entry counts across [from, to] inclusive (continuous series, capped at 90 days).
function dailyTrendRange(entries, from, to) {
  const byDate = {};
  entries.forEach(e => { if (e.date) byDate[e.date] = (byDate[e.date] || 0) + 1; });

  let start = from ? new Date(from) : null;
  let end   = to   ? new Date(to)   : new Date();
  if (!start) {
    const dates = entries.map(e => parseLocalDate(e.date)).filter(Boolean).sort((a, b) => a - b);
    start = dates.length ? new Date(dates[0]) : new Date();
  }
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  const DAY = 86400000, MAX_DAYS = 90;
  let days = Math.round((end - start) / DAY) + 1;
  if (days > MAX_DAYS) { start = new Date(end.getTime() - (MAX_DAYS - 1) * DAY); days = MAX_DAYS; }
  if (days < 1) days = 1;

  const labels = [], data = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    labels.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    data.push(byDate[localKey(d)] || 0);
  }
  return { labels, data };
}

// Count-based metrics shown on the stat cards.
function metrics(entries) {
  return {
    total:     entries.length,
    open:      entries.filter(isOpen).length,
    resolved:  entries.filter(isResolved).length,
    incidents: entries.filter(e => e.eventType === "Incident").length,
  };
}

// Keep entries whose date falls within [from, to]; either bound may be null (unbounded).
function entriesInRange(entries, from, to) {
  if (!from && !to) return entries.slice();
  return entries.filter(e => {
    const d = parseLocalDate(e.date);
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to)     return false;
    return true;
  });
}

// Resolve the dashboard's selected period into current + previous date ranges.
function getDashRange() {
  const sel = document.getElementById("dash-range").value;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let from = null, to = null, label = "", title = "";

  if (sel === "all") {
    return { from: null, to: null, prevFrom: null, prevTo: null, label: "", title: "all time" };
  } else if (sel === "custom") {
    const f = document.getElementById("dash-from").value;
    const t = document.getElementById("dash-to").value;
    from = f ? parseLocalDate(f) : null;
    to   = t ? parseLocalDate(t) : new Date(today);
    label = "vs prev period";
    title = (from ? from.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "start")
          + " – " + to.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } else if (sel === "month") {
    from = new Date(today.getFullYear(), today.getMonth(), 1);
    to   = new Date(today);
    label = "vs prev period";
    title = "this month";
  } else {
    const n = parseInt(sel, 10);   // 7 or 30
    to   = new Date(today);
    from = new Date(today); from.setDate(today.getDate() - (n - 1));
    label = n === 7 ? "vs last week" : `vs prev ${n} days`;
    title = `last ${n} days`;
  }

  let prevFrom = null, prevTo = null;
  if (from && to) {
    const DAY = 86400000;
    const lenDays = Math.round((to - from) / DAY) + 1;
    prevTo   = new Date(from.getTime() - DAY);
    prevFrom = new Date(prevTo.getTime() - (lenDays - 1) * DAY);
    prevFrom.setHours(0, 0, 0, 0); prevTo.setHours(0, 0, 0, 0);
  }
  return { from, to, prevFrom, prevTo, label, title };
}

// Small ▲/▼ badge comparing a metric to the previous period.
// good = "up" | "down" sets the green/red sense; omit for neutral coloring.
function deltaBadge(cur, prev, label, good) {
  if (!label) return "";
  const diff = cur - prev;
  let cls = "flat";
  if (diff !== 0 && good) cls = ((diff > 0 && good === "up") || (diff < 0 && good === "down")) ? "good" : "bad";
  else if (diff !== 0)    cls = "neutral";
  const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "▬";
  const sign  = diff > 0 ? "+" : "";
  return `<div class="stat-delta ${cls}">${arrow} ${sign}${diff}<span class="stat-delta-label"> ${label}</span></div>`;
}

// Dashboard filter controls.
function onDashRangeChange() {
  const custom = document.getElementById("dash-range").value === "custom";
  ["dash-from", "dash-dash", "dash-to"].forEach(id =>
    document.getElementById(id).classList.toggle("hidden", !custom));
  renderDashboard();
}
function onDashCustom() {
  document.getElementById("dash-range").value = "custom";
  ["dash-from", "dash-dash", "dash-to"].forEach(id =>
    document.getElementById(id).classList.remove("hidden"));
  renderDashboard();
}

// Average time between submission and resolution, in ms (null if none resolved).
function avgResolutionMs(entries) {
  const rows = entries.filter(e => e.resolved && e.resolvedAt && e.createdAt);
  if (!rows.length) return null;
  const sum = rows.reduce((s, e) => s + Math.max(0, new Date(e.resolvedAt) - new Date(e.createdAt)), 0);
  return sum / rows.length;
}
function fmtDuration(ms) {
  if (ms == null) return "—";
  const hrs = ms / 3600000;
  if (hrs < 1)  return `${Math.round(ms / 60000)} min`;
  if (hrs < 24) return `${Math.round(hrs * 10) / 10} hr`;
  return `${Math.round(hrs / 24 * 10) / 10} days`;
}

// ── Incident-spike alerts ─────────────────────────────────────────────────
// Transparent statistics (no ML): flag any series — all campuses, each campus,
// incidents overall — whose entry volume is unusually high vs the facility's own
// recent baseline. Stays dormant until there is enough history for a stable
// baseline, so it never cries wolf in the first days of use.
function _dateKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dayCountsBy(entries, keyFn) {
  const m = new Map();                      // seriesKey -> Map(dateStr -> count)
  for (const e of entries) {
    if (!e.date) continue;
    const k = keyFn(e);
    if (!m.has(k)) m.set(k, new Map());
    const d = m.get(k);
    d.set(e.date, (d.get(e.date) || 0) + 1);
  }
  return m;
}
function spikeForSeries(dateCounts, label) {
  const DAY = 86400000, today = new Date();
  const days = [];                          // continuous 30-day daily series ending today
  for (let i = 29; i >= 0; i--) {
    const key = _dateKey(new Date(today.getTime() - i * DAY));
    days.push(dateCounts.get(key) || 0);
  }
  const baseline = days.slice(0, -1);       // everything except today
  const activeDays = baseline.filter((c) => c > 0).length;
  if (baseline.length < 10 || activeDays < 5) return null;   // baseline still building
  const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const std = Math.sqrt(baseline.reduce((a, b) => a + (b - mean) ** 2, 0) / baseline.length);
  const todayN = days[days.length - 1];
  const last7 = days.slice(-7).reduce((a, b) => a + b, 0);
  const exp7 = mean * 7;
  const z = std ? (todayN - mean) / std : 0;
  if (todayN >= 3 && z >= 2 && todayN >= mean + 3)
    return { level: "high", label, text: `${todayN} entries today vs a daily average of ${mean.toFixed(1)} (±${std.toFixed(1)}).` };
  if (last7 >= 6 && exp7 > 0 && last7 >= exp7 * 1.5 && last7 - exp7 >= 4)
    return { level: "warn", label, text: `${last7} in the last 7 days vs ~${Math.round(exp7)} typical.` };
  return null;
}
const SPIKE_ALERTS_ENABLED = false;   // built but not yet approved for production
function renderSpikeAlerts(entries) {
  const box = document.getElementById("spike-alerts");
  if (!box) return;
  const CAMPUSES = ["North Campus", "Desert View", "Riverside"];
  const found = [];
  const overall = dayCountsBy(entries, () => "all").get("all") || new Map();
  const oa = spikeForSeries(overall, "All campuses"); if (oa) found.push(oa);
  const byCampus = dayCountsBy(entries, (e) => e.campus || "—");
  for (const c of CAMPUSES) { const a = spikeForSeries(byCampus.get(c) || new Map(), c); if (a) found.push(a); }
  const inc = dayCountsBy(entries.filter((e) => e.eventType === "Incident"), () => "inc").get("inc") || new Map();
  const ia = spikeForSeries(inc, "Incidents (all campuses)"); if (ia) found.push(ia);

  if (!found.length) {
    box.className = "spike-alerts calm";
    box.innerHTML = overall.size >= 10
      ? `<span class="spike-ok">✓ No unusual activity — entry volume is within the normal range.</span>`
      : `<span class="spike-building">Spike alerts activate once there are ~10 days of data to set a baseline.</span>`;
    return;
  }
  box.className = "spike-alerts";
  box.innerHTML = found.map((a) =>
    `<div class="spike-card spike-${a.level}"><span class="spike-icon">${a.level === "high" ? "▲" : "↗"}</span>` +
    `<span class="spike-body"><strong>${escapeHtml(a.label)}</strong> — ${escapeHtml(a.text)}</span></div>`).join("");
}

async function renderDashboard() {
  try {
    if (!allEntries.length) await fetchEntries();
    await fetchDashWarnings();
    await fetchDashClients();
  } catch (err) {
    document.getElementById("stat-grid").innerHTML =
      `<p class='muted' style='color:#dc2626'>Failed to load: ${escapeHtml(err.message)}</p>`;
    return;
  }

  // Volume-spike alerts use the full history (not the selected period) for baselines.
  if (SPIKE_ALERTS_ENABLED) renderSpikeAlerts(allEntries);

  // Scope every stat and chart to the selected period, and compare to the
  // previous equal-length period for the delta badges.
  const { from, to, prevFrom, prevTo, label, title } = getDashRange();
  const cur  = entriesInRange(allEntries, from, to);
  const prev = entriesInRange(allEntries, prevFrom, prevTo);
  const m = metrics(cur);
  const p = metrics(prev);

  const wd = weekdayCounts(cur);
  const hc = hourCounts(cur);
  const wdPeak = peakIndex(wd);
  const hcPeak = peakIndex(hc);
  const busiestDay = wdPeak >= 0 ? WEEKDAYS[wdPeak] : "—";
  const peakTime   = hcPeak >= 0 ? formatHour(hcPeak) : "—";
  const avgResStr  = fmtDuration(avgResolutionMs(cur));

  // Daily series for the stat-card sparklines.
  const totalSeries    = dailyTrendRange(cur, from, to).data;
  const incidentSeries = dailyTrendRange(cur.filter(e => e.eventType === "Incident"), from, to).data;

  document.getElementById("stat-grid").innerHTML = `
    <div class="stat-card"><div class="stat-value">${m.total}</div><div class="stat-label">Total Entries</div>${deltaBadge(m.total, p.total, label)}${sparkline(totalSeries, "#2563eb")}</div>
    <div class="stat-card ${m.open ? "alert" : ""}"><div class="stat-value">${m.open}</div><div class="stat-label">Open Follow-Ups</div>${deltaBadge(m.open, p.open, label, "down")}</div>
    <div class="stat-card"><div class="stat-value">${m.resolved}</div><div class="stat-label">Resolved Follow-Ups</div>${deltaBadge(m.resolved, p.resolved, label, "up")}</div>
    <div class="stat-card"><div class="stat-value">${m.incidents}</div><div class="stat-label">Incidents Logged</div>${deltaBadge(m.incidents, p.incidents, label, "down")}${sparkline(incidentSeries, "#dc2626")}</div>
    <div class="stat-card"><div class="stat-value">${busiestDay}</div><div class="stat-label">Busiest Day</div></div>
    <div class="stat-card"><div class="stat-value">${peakTime}</div><div class="stat-label">Peak Time</div></div>
    <div class="stat-card"><div class="stat-value">${avgResStr}</div><div class="stat-label">Avg. Resolution Time</div></div>
  `;

  const palette = ["#2563eb","#ea580c","#9333ea","#ca8a04","#16a34a","#dc2626","#0891b2","#64748b"];

  const ev = countBy(cur, "eventType");
  drawChart("chart-event", "bar", Object.keys(ev), Object.values(ev), palette, (l) => filterLogBy("event", l));

  const ca = countBy(cur, "campus");
  drawChart("chart-campus", "bar", Object.keys(ca), Object.values(ca), palette, (l) => filterLogBy("campus", l));

  const us = topN(countBy(cur, "name"), 8);   // top staff by number of entries
  drawChart("chart-users", "bar", us.labels, us.data, "#2563eb", (l) => filterLogBy("search", l));

  const none = cur.filter(e => e.followUpNeeded === "No").length;
  drawChart("chart-followup", "doughnut",
    ["Open","Resolved","Not needed"], [m.open, m.resolved, none],
    ["#dc2626","#16a34a","#cbd5e1"]);

  const sh = countBy(cur, "shift");
  drawChart("chart-shift", "bar", Object.keys(sh), Object.values(sh), palette);

  drawChart("chart-weekday", "bar", WEEKDAYS, wd, "#2563eb");
  drawChart("chart-hour", "bar", HOUR_LABELS, hc, "#0891b2");

  document.getElementById("trend-title").textContent = `Entries Over Time (${title})`;
  const trend = dailyTrendRange(cur, from, to);
  drawChart("chart-trend", "line", trend.labels, trend.data);

  // Top Resolvers — who closes the most follow-ups.
  const resolvers = topN(countBy(cur.filter(e => e.resolved), "resolvedBy"), 8);
  drawChart("chart-resolvers", "bar", resolvers.labels, resolvers.data, "#16a34a", (l) => filterLogBy("search", l));

  // Busiest Day × Time heatmap.
  renderHeatmap(cur);

  // Campus comparison — entries vs incidents side by side per campus.
  const CAMPUSES = ["North Campus", "Desert View", "Riverside"];
  drawMultiChart("chart-campus-compare", CAMPUSES, [
    { label: "All entries", data: CAMPUSES.map(c => cur.filter(e => e.campus === c).length), color: "#2563eb" },
    { label: "Incidents",   data: CAMPUSES.map(c => cur.filter(e => e.campus === c && e.eventType === "Incident").length), color: "#dc2626" },
  ]);

  // Follow-up resolution speed — of the entries that needed follow-up, how fast they closed.
  const DAY_MS = 86400000;
  const needF = cur.filter(e => e.followUpNeeded === "Yes");
  const resIn24  = needF.filter(e => e.resolved && e.resolvedAt && e.createdAt && (new Date(e.resolvedAt) - new Date(e.createdAt)) <= DAY_MS).length;
  const resOver  = needF.filter(e => e.resolved && e.resolvedAt && e.createdAt && (new Date(e.resolvedAt) - new Date(e.createdAt)) >  DAY_MS).length;
  const stillOpen = needF.filter(e => !e.resolved).length;
  drawChart("chart-followup-sla", "doughnut",
    ["Closed ≤ 24h", "Closed > 24h", "Still open"], [resIn24, resOver, stillOpen],
    ["#16a34a", "#ca8a04", "#dc2626"]);
  const totalRes = resIn24 + resOver;
  const pct24 = totalRes ? Math.round(100 * resIn24 / totalRes) : 0;
  const openAges = cur.filter(isOpen).map(e => e.createdAt ? Date.now() - new Date(e.createdAt) : 0);
  const oldest = openAges.length ? Math.max(...openAges) : 0;
  const sl="followup-sla-caption", slEl = document.getElementById(sl);
  if (slEl) slEl.textContent = totalRes
    ? `${pct24}% of resolved follow-ups closed within 24h` + (oldest ? ` · oldest still open: ${fmtDuration(oldest)}` : "")
    : (stillOpen ? `${stillOpen} open, none resolved yet` : "No follow-ups in this period");

  // Event types over time — stacked weekly mix of the top event types.
  renderEventMix(cur, title);

  // Rule Infractions section (aggregate SUD data — counts only).
  renderInfractionCharts(from, to, prevFrom, prevTo, label, title);
}

// Stacked bar: for each week in range, counts of the top event types (+ Other).
function renderEventMix(entries, title) {
  const t = document.getElementById("event-mix-title");
  if (t) t.textContent = `Event Types Over Time (${title})`;
  // Weeks present in the data, chronological, capped to the most recent 14.
  let weeks = [...new Set(entries.map(e => weekKey(e.date)).filter(Boolean))].sort();
  if (weeks.length > 14) weeks = weeks.slice(-14);
  const weekSet = new Set(weeks);
  const inWeeks = entries.filter(e => weekSet.has(weekKey(e.date)));
  // Top 5 event types by volume, the rest folded into "Other".
  const top = topN(countBy(inWeeks, "eventType"), 5).labels;
  const cats = [...top, "Other"];
  const colors = ["#2563eb", "#ea580c", "#9333ea", "#16a34a", "#0891b2", "#94a3b8"];
  const datasets = cats.map((cat, i) => ({
    label: cat, color: colors[i],
    data: weeks.map(wk => inWeeks.filter(e => weekKey(e.date) === wk &&
      (cat === "Other" ? !top.includes(e.eventType) : e.eventType === cat)).length),
  }));
  const labels = weeks.map(wk => { const d = parseLocalDate(wk); return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : wk; });
  drawMultiChart("chart-event-mix", labels, datasets, { stacked: true });
}

// 7 weekdays (Mon-first) × 24 hours matrix of entry counts.
function dayHourMatrix(entries) {
  const m = Array.from({ length: 7 }, () => new Array(24).fill(0));
  entries.forEach(e => {
    const d = parseLocalDate(e.date);
    if (!d) return;
    const wd = (d.getDay() + 6) % 7;                 // Mon-first
    const hh = parseInt((e.time || "").split(":")[0], 10);
    if (isNaN(hh) || hh < 0 || hh > 23) return;
    m[wd][hh]++;
  });
  return m;
}

// Render the heatmap as a coloured HTML grid (no Chart.js dependency needed).
function renderHeatmap(entries) {
  const el = document.getElementById("heatmap");
  if (!el) return;
  const m = dayHourMatrix(entries);
  let max = 0;
  m.forEach(row => row.forEach(v => { if (v > max) max = v; }));
  const header = `<tr><th></th>${HOUR_LABELS.map(h => `<th>${h}</th>`).join("")}</tr>`;
  const rows = WEEKDAYS.map((wd, i) => {
    const cells = m[i].map((v, h) => {
      const alpha = max ? v / max : 0;
      const style = v
        ? `background: rgba(37,99,235,${(0.12 + alpha * 0.85).toFixed(3)}); color:${alpha > 0.55 ? "#fff" : "#1e293b"}`
        : "";
      return `<td class="hm-cell" style="${style}" title="${wd} ${HOUR_LABELS[h]} — ${v}">${v || ""}</td>`;
    }).join("");
    return `<tr><th class="hm-day">${wd}</th>${cells}</tr>`;
  }).join("");
  el.innerHTML = `<div class="hm-scroll"><table class="hm-table">${header}${rows}</table></div>`;
}

// ── Dashboard: Rule Infractions ───────────────────────────
// Aggregate infraction charts. Client-level SUD data (42 CFR Part 2): counts and
// aggregates only — never write client names to the console.

let _dashWarnings = [];

// The calendar date an infraction belongs to, as a local "YYYY-MM-DD" string.
// Prefer occurred_at (when it happened); fall back to the issued_at date part.
function warnDateStr(w) {
  if (w.occurred_at) return String(w.occurred_at).slice(0, 10);
  if (w.issued_at)   return String(w.issued_at).slice(0, 10);
  return "";
}

// Does this warning still have an outstanding (owed, not yet done) consequence?
// Mirrors the "Mark completed" button logic in warningActions().
function isConsequenceOwed(w) {
  if (w.status === "voided") return false;
  const hasCons = w.consequence_type && w.consequence_type !== "none";
  return w.status === "consequence_open" || (w.status === "issued" && hasCons);
}

// Phase label snapshotted at issue (falls back to the client's current phase).
function warnPhaseLabel(w) {
  const p = w.phase_at_time || w.client_phase;
  return p ? `Phase ${p}` : "—";
}

// Click an infraction chart to drill into the Rule Infractions tab, pre-filtered.
function filterWarningsBy(kind, value) {
  const map = { type: "wf-type", status: "wf-status", client: "wf-client" };
  ["wf-type", "wf-status", "wf-client"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  const el = document.getElementById(map[kind]);
  if (el) el.value = value;
  switchTab("warnings");   // renderWarnings() runs on tab switch, reading the filter
}

// Fetch every warning for the dashboard aggregates (fresh each render so the
// charts reflect infractions created since the tab was first opened).
async function fetchDashWarnings() {
  try {
    const j = await fetch("/api/warnings").then(r => r.json());
    _dashWarnings = (j && j.data) || [];
  } catch { _dashWarnings = []; }
  return _dashWarnings;
}

// Client roster (for the "days since admission" infraction chart).
let _dashClients = [];
async function fetchDashClients() {
  try {
    const j = await fetch("/api/clients").then(r => r.json());
    _dashClients = (j && j.data) || [];
  } catch { _dashClients = []; }
  return _dashClients;
}

// Infraction stat-card counts for a set of warnings.
function infractionMetrics(rows) {
  const owed = rows.filter(isConsequenceOwed);
  const todayKey = localKey(new Date());
  const overdue = owed.filter(w => w.consequence_due && String(w.consequence_due).slice(0, 10) < todayKey);
  const activeClients = new Set(owed.map(w => w.client_id));
  return {
    total:   rows.filter(w => w.status !== "voided").length,
    written: rows.filter(w => (w.type === "WW" || w.type === "WU") && w.status !== "voided").length,
    owed:    owed.length,
    overdue: overdue.length,
    clients: activeClients.size,
  };
}

// Render the "Clients With Active Consequences" table (owed consequences, soonest
// due first) into the element `elId`. Shared by the dashboard and the Rule
// Infractions tab.
function renderActiveConsequences(rows, elId = "infr-active") {
  const el = document.getElementById(elId);
  if (!el) return;
  const owed = rows.filter(isConsequenceOwed).sort((a, b) => {
    const da = a.consequence_due || "9999", dbb = b.consequence_due || "9999";
    return da < dbb ? -1 : da > dbb ? 1 : 0;
  });
  if (!owed.length) {
    el.innerHTML = "<p class='muted'>No outstanding consequences. 🎉</p>";
    return;
  }
  const todayKey = localKey(new Date());
  const body = owed.map(w => {
    const dueKey = w.consequence_due ? String(w.consequence_due).slice(0, 10) : "";
    const overdue = dueKey && dueKey < todayKey;
    const dueSoon = !overdue && isWarningDueSoon(w);
    const badge = overdue ? " <span class='infr-overdue'>overdue</span>"
                : dueSoon ? " <span class='infr-duesoon'>due soon</span>" : "";
    const dueCell = w.consequence_due
      ? `${escapeHtml(fmtDate(w.consequence_due))}${badge}`
      : "<span class='muted'>—</span>";
    return `<tr>
      <td>${escapeHtml(w.client_name || "—")}</td>
      <td>${escapeHtml(w.client_counselor || "—")}</td>
      <td><span class="warning-num warning-${w.type}">${w.type}#${w.seq_number}</span></td>
      <td>${escapeHtml(w.consequence_type || "—")}${w.consequence_detail ? " — " + escapeHtml(w.consequence_detail) : ""}</td>
      <td>${dueCell}</td>
    </tr>`;
  }).join("");
  el.innerHTML =
    `<div class="infr-active-scroll"><table class="mini-table">` +
    `<thead><tr><th>Client</th><th>Clinician</th><th>Infraction</th><th>Owed</th><th>Due</th></tr></thead>` +
    `<tbody>${body}</tbody></table></div>`;
}

// Build the whole Rule Infractions dashboard section for the selected period.
function renderInfractionCharts(from, to, prevFrom, prevTo, label, title) {
  // Normalize each warning with a `.date` field so the shared range/trend helpers work.
  const all  = _dashWarnings.map(w => ({ ...w, date: warnDateStr(w) }));
  const cur  = entriesInRange(all, from, to);
  const prev = entriesInRange(all, prevFrom, prevTo);
  const m = infractionMetrics(cur);
  const p = infractionMetrics(prev);

  const totalSeries = dailyTrendRange(cur.filter(w => w.status !== "voided"), from, to).data;

  const grid = document.getElementById("infr-stat-grid");
  if (grid) grid.innerHTML = `
    <div class="stat-card"><div class="stat-value">${m.total}</div><div class="stat-label">Infractions</div>${deltaBadge(m.total, p.total, label)}${sparkline(totalSeries, "#ea580c")}</div>
    <div class="stat-card"><div class="stat-value">${m.written}</div><div class="stat-label">Written (WW + WU)</div>${deltaBadge(m.written, p.written, label)}</div>
    <div class="stat-card ${m.owed ? "alert" : ""}"><div class="stat-value">${m.owed}</div><div class="stat-label">Open Consequences</div>${deltaBadge(m.owed, p.owed, label, "down")}</div>
    <div class="stat-card ${m.overdue ? "alert" : ""}"><div class="stat-value">${m.overdue}</div><div class="stat-label">Overdue</div></div>
    <div class="stat-card"><div class="stat-value">${m.clients}</div><div class="stat-label">Clients w/ Active Consequences</div></div>
  `;

  const active = cur.filter(w => w.status !== "voided");
  const palette = ["#2563eb","#ea580c","#9333ea","#ca8a04","#16a34a","#dc2626","#0891b2","#64748b"];

  // By type — fixed VW/WW/WU order and their badge colours; click drills into the list.
  const TYPES = ["VW", "WW", "WU"];
  const typeCounts = TYPES.map(t => active.filter(w => w.type === t).length);
  drawChart("chart-infr-type", "bar", TYPES, typeCounts,
    ["#64748b", "#ca8a04", "#dc2626"], (l) => filterWarningsBy("type", l));

  // Top rules broken.
  const rr = topN(countBy(active, "rule_label"), 10);
  drawChart("chart-infr-rule", "bar", rr.labels, rr.data, "#9333ea");

  // By shift.
  const sh = countBy(active, "shift");
  drawChart("chart-infr-shift", "bar", Object.keys(sh), Object.values(sh), palette);

  // By phase (snapshot at issue).
  const ph = {};
  active.forEach(w => { const k = warnPhaseLabel(w); ph[k] = (ph[k] || 0) + 1; });
  drawChart("chart-infr-phase", "bar", Object.keys(ph), Object.values(ph), ["#2563eb", "#0891b2", "#64748b"]);

  // Consequence state — click a slice to filter the list by status.
  const owedN      = active.filter(isConsequenceOwed).length;
  const completedN = active.filter(w => w.status === "completed").length;
  const closedN    = active.filter(w => w.status === "closed").length;
  const noneN      = active.filter(w => !w.consequence_type || w.consequence_type === "none")
                          .filter(w => !isConsequenceOwed(w) && w.status !== "completed" && w.status !== "closed").length;
  drawChart("chart-infr-cons", "doughnut",
    ["Open", "Completed", "Closed", "No consequence"],
    [owedN, completedN, closedN, noneN],
    ["#dc2626", "#0891b2", "#16a34a", "#cbd5e1"],
    (l) => { if (l === "Open") filterWarningsBy("status", "consequence_open");
             else if (l === "Completed") filterWarningsBy("status", "completed");
             else if (l === "Closed") filterWarningsBy("status", "closed"); });

  // Consequence follow-through — completion rate, speed, overdue rate.
  const withCons   = active.filter(w => w.consequence_type && w.consequence_type !== "none");
  const doneCons   = withCons.filter(w => w.status === "completed" || w.status === "closed");
  const compRate   = withCons.length ? Math.round(100 * doneCons.length / withCons.length) : 0;
  const compDays   = doneCons.filter(w => w.completed_at).map(w => {
    const a = parseLocalDate(warnDateStr(w)) || new Date(w.issued_at);
    return (new Date(w.completed_at) - a) / 86400000;
  }).filter(x => x >= 0);
  const avgCompDays = compDays.length ? (compDays.reduce((s, x) => s + x, 0) / compDays.length) : null;
  const overdueRate = withCons.length ? Math.round(100 * active.filter(isWarningOverdue).length / withCons.length) : 0;
  const ftGrid = document.getElementById("infr-stat-grid");
  if (ftGrid) ftGrid.insertAdjacentHTML("beforeend", `
    <div class="stat-card"><div class="stat-value">${compRate}%</div><div class="stat-label">Consequences Completed</div></div>
    <div class="stat-card"><div class="stat-value">${avgCompDays == null ? "—" : (Math.round(avgCompDays * 10) / 10)}</div><div class="stat-label">Avg Days to Complete</div></div>
    <div class="stat-card ${overdueRate ? "alert" : ""}"><div class="stat-value">${overdueRate}%</div><div class="stat-label">Consequences Overdue</div></div>
  `);

  // By campus.
  const ic = countBy(active, "campus");
  drawChart("chart-infr-campus", "bar", Object.keys(ic), Object.values(ic), palette);

  // When infractions happen — by days since the client was admitted.
  const admit = {};
  _dashClients.forEach(c => { if (c.admitted_at) admit[c.id] = String(c.admitted_at).slice(0, 10); });
  const tenure = { "0–7 days": 0, "8–14 days": 0, "15–30 days": 0, "31+ days": 0 };
  active.forEach(w => {
    const a = admit[w.client_id] ? parseLocalDate(admit[w.client_id]) : null;
    const occ = parseLocalDate(warnDateStr(w));
    if (!a || !occ) return;
    const d = Math.floor((occ - a) / 86400000);
    if (d < 0) return;
    if (d <= 7) tenure["0–7 days"]++; else if (d <= 14) tenure["8–14 days"]++;
    else if (d <= 30) tenure["15–30 days"]++; else tenure["31+ days"]++;
  });
  drawChart("chart-infr-tenure", "bar", Object.keys(tenure), Object.values(tenure), "#0891b2");

  // Infractions per client (distribution) + how many escalated to a write-up.
  const perClient = {}, clientTypes = {};
  active.forEach(w => {
    perClient[w.client_id] = (perClient[w.client_id] || 0) + 1;
    (clientTypes[w.client_id] = clientTypes[w.client_id] || new Set()).add(w.type);
  });
  const dist = { "1": 0, "2": 0, "3": 0, "4+": 0 };
  Object.values(perClient).forEach(n => { dist[n >= 4 ? "4+" : String(n)]++; });
  drawChart("chart-infr-repeat", "bar", Object.keys(dist), Object.values(dist), "#9333ea");
  const reachedWU = Object.values(clientTypes).filter(s => s.has("WU")).length;
  const rc = document.getElementById("infr-repeat-caption");
  if (rc) rc.textContent = `${reachedWU} client${reachedWU === 1 ? "" : "s"} escalated to a write-up (WU)`;

  // Over time.
  const trendTitle = document.getElementById("infr-trend-title");
  if (trendTitle) trendTitle.textContent = `Infractions Over Time (${title})`;
  const trend = dailyTrendRange(active, from, to);
  drawChart("chart-infr-trend", "line", trend.labels, trend.data, "#ea580c");

  // Clients with active consequences (across the whole roster, not just the period —
  // an owed consequence is owed regardless of the selected window).
  renderActiveConsequences(all.filter(w => w.status !== "voided"));
}

// Typing in / changing a field flagged as missing clears its red outline.
["input", "change"].forEach(ev => document.addEventListener(ev, (e) => {
  if (e.target && e.target.classList && e.target.classList.contains("field-invalid")) e.target.classList.remove("field-invalid");
}));
