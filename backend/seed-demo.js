/**
 * Fill an EMPTY Shift Log instance with realistic, entirely fictional demo data
 * (clients, ~6 weeks of shift-log entries, comments, rule infractions with
 * consequences, and shift handoffs) so the dashboard and every tab have
 * something to show. Goes through the public API, so all validation applies.
 *
 *   node seed-demo.js [baseUrl]        (default http://localhost:3000)
 *
 * Every name below is made up. Never point this at a production instance.
 */
"use strict";

const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");

// Small deterministic PRNG so every run produces the same demo dataset.
let seed = 20261117;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;

const CAMPUSES = ["North Campus", "Desert View", "Riverside"];
const STAFF = ["Alex Admin", "Jordan Lee", "Sam Rivera", "Taylor Morgan", "Casey Brooks"];
const CLINICIANS = ["Dr. Ellis", "M. Ortega, LPC", "R. Chen, LISAC", "K. Patel, LCSW"];
const CLIENTS = [
  "Aaron Pike", "Bella Marsh", "Cody Wren", "Dana Holt", "Eli Stroud", "Fiona Lake",
  "Gabe Nolan", "Hana Price", "Ivan Cole", "Jade Moreno", "Kyle Dunn", "Lena Ford",
  "Miles Grant", "Nora Shaw", "Owen Blake", "Paige Reid", "Quinn Hart", "Rosa Vega",
];

const pad = (n) => String(n).padStart(2, "0");
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const shiftFor = (h, m) => { const t = h * 60 + m; return t >= 330 && t < 870 ? "Day" : t >= 870 && t < 1350 ? "Evening" : "Overnight"; };
const short = (full) => { const [f, l] = full.split(" "); return `${f} ${l[0]}.`; };

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`${method} ${path}: ${(j.error && j.error.message) || res.status}`);
  return j.data;
}

// Narrative templates per event type. {c} = a client's short name.
const T = {
  "Medications": ["AM med pass completed. All scheduled clients received meds; {c} refused vitamin, education provided.",
                  "PM med pass completed, count verified with second staff. No discrepancies.",
                  "{c} requested PRN for headache; administered per protocol and documented on MAR."],
  "Client Updates": ["{c} attended all groups today and participated actively in process group.",
                     "{c} met with clinician re: discharge planning. Family session scheduled for Friday.",
                     "{c} completed step work assignment and shared in community meeting."],
  "Behavioral": ["{c} became argumentative with a peer during chores; de-escalated verbally, both separated.",
                 "{c} isolating in room most of the evening. Checked in twice; reports feeling homesick.",
                 "Raised voices between {c} and a peer in the dayroom. Staff mediated; resolved without incident."],
  "Incident": ["{c} returned 25 minutes past curfew. Breathalyzer negative. Write-up issued per policy.",
               "Unauthorized vape device found during room check in {c}'s room. Item confiscated and logged.",
               "{c} reported feeling lightheaded after group; vitals taken and within normal limits, monitored."],
  "Medical": ["{c} transported to scheduled dental appointment, returned 1430.",
              "{c} reports mild flu symptoms; temp 99.8F. Encouraged fluids, will recheck at shift change."],
  "Client Location": ["{c} signed out on approved pass to outpatient appointment, expected back 1600.",
                      "{c} returned from pass on time; belongings checked, no concerns."],
  "Visitor": ["Approved family visit for {c} in the courtyard, 1300–1500. Visitor signed in and out."],
  "Maintenance": ["Shower drain slow in the men's wing; work order submitted.",
                  "Laundry dryer #2 not heating. Posted out-of-order sign, maintenance notified."],
  "BHT Updates": ["Reminder: new sign-out sheet in use starting today, please initial each entry.",
                  "Shift ran smoothly. Room checks completed hourly, all clients accounted for."],
  "Other": ["Fire drill conducted at 1015; building cleared in 3 minutes.", "Weekly house meeting held; chore chart rotated."],
};
const TYPE_WEIGHTS = [["Medications", 18], ["Client Updates", 16], ["Other", 8], ["Behavioral", 9], ["Incident", 6],
  ["Medical", 5], ["Client Location", 8], ["Visitor", 3], ["Maintenance", 4], ["BHT Updates", 5]];
function weightedType() {
  const total = TYPE_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let r = rnd() * total;
  for (const [t, w] of TYPE_WEIGHTS) { if ((r -= w) < 0) return t; }
  return "Other";
}

async function main() {
  const health = await fetch(BASE + "/api/health").then((r) => r.json()).catch(() => null);
  if (!health || !health.ok) throw new Error(`No Shift Log API at ${BASE}`);
  const existing = await api("GET", "/api/clients");
  if (existing.length) throw new Error("This instance already has clients — the seeder only runs on an empty demo database.");

  // Clients
  const clients = [];
  for (const [i, name] of CLIENTS.entries()) {
    const c = (await api("POST", "/api/clients", {
      full_name: name, counselor: CLINICIANS[i % CLINICIANS.length], phase: chance(0.35) ? 2 : 1,
      campus: CAMPUSES[i % CAMPUSES.length], admitted_at: dayStr(daysAgo(10 + Math.floor(rnd() * 60))),
    }))[0];
    clients.push(c);
  }
  // Two discharged clients, to show the roster grouping
  for (const c of clients.slice(-2)) {
    await api("PATCH", `/api/clients/${c.id}`, { status: "discharged", discharged_at: daysAgo(3).toISOString() });
  }
  const active = clients.slice(0, -2);

  // ~6 weeks of shift-log entries, busier on Main/North Campus
  let entries = 0;
  for (let d = 42; d >= 0; d--) {
    const perDay = 4 + Math.floor(rnd() * 5) + (d % 7 === 5 ? 3 : 0);   // a busier weekday
    for (let k = 0; k < perDay; k++) {
      const h = Math.floor(rnd() * 24), m = Math.floor(rnd() * 60);
      const type = weightedType();
      const cl = pick(active);
      const followUp = (type === "Incident" || type === "Maintenance" || (type === "Medical" && chance(0.5))) ? "Yes" : "No";
      const row = (await api("POST", "/api/shift_log", {
        date: dayStr(daysAgo(d)), time: `${pad(h)}:${pad(m)}`, shift: shiftFor(h, m),
        staff_name: pick(STAFF), campus: chance(0.5) ? "North Campus" : pick(CAMPUSES), event_type: type,
        narrative: pick(T[type]).replace("{c}", short(cl.full_name)),
        follow_up_needed: followUp,
        follow_up_notes: followUp === "Yes" ? pick(["Shift lead to review", "Maintenance notified", "Clinician to follow up"]) : "",
        client_uuid: `demo-${d}-${k}`,
      }))[0];
      entries++;
      if (followUp === "Yes" && d > 1 && chance(0.75)) {
        await api("PATCH", `/api/shift_log/${row.id}`, {
          resolved: true, resolved_by: pick(STAFF), resolved_at: daysAgo(d - 1).toISOString(),
          resolution_notes: "Addressed and closed.",
        });
      }
      if (chance(0.08)) {
        await api("POST", "/api/entry_comments", { entry_id: row.id, author_name: pick(STAFF), body: "Thanks — passed this on to the clinical team." });
      }
    }
  }

  // Rule infractions with consequences
  const rules = (await api("GET", "/api/rules")).filter((r) => r.active);
  let infractions = 0;
  for (let i = 0; i < 26; i++) {
    const c = pick(active);
    const type = pick(["VW", "VW", "VW", "WW", "WW", "WU"]);
    const d = Math.floor(rnd() * 35);
    const h = 8 + Math.floor(rnd() * 14);
    const cons = type === "VW" ? "none" : pick(["paper", "chores", "chores", "therapeutic"]);
    const w = (await api("POST", "/api/warnings", {
      client_id: c.id, type, rule_id: pick(rules).id,
      occurred_at: dayStr(daysAgo(d)), shift: shiftFor(h, 0), campus: c.campus,
      narrative: pick(["Reminded of house rule after repeated issue.", "Did not complete assigned chore by deadline.",
                       "Left group early without staff approval.", "Signed out without recording destination."]),
      consequence_type: cons,
      consequence_detail: cons === "paper" ? pick(["Accountability", "Respecting community", "Honesty in recovery"])
                        : cons === "therapeutic" ? "Lead next morning check-in on the topic of responsibility" : "",
      consequence_due: cons === "none" ? "" : dayStr(daysAgo(d - 3)),
      issued_by: pick(STAFF), issued_by_initials: "",
    }))[0];
    infractions++;
    if (cons !== "none" && d > 6 && chance(0.7)) {
      await api("POST", `/api/warnings/${w.id}/complete`, { completed_by: pick(STAFF), completion_notes: "Completed and reviewed." });
    }
    if (i === 3) await api("POST", `/api/warnings/${w.id}/void`, { voided_by: "Alex Admin", void_reason: "Issued to the wrong client" });
  }

  // Shift handoffs: most received, the latest still waiting
  const shifts = ["Day", "Evening", "Overnight"];
  for (let d = 3; d >= 0; d--) {
    for (const [si, s] of shifts.entries()) {
      if (d === 0 && si > 0) break;
      const h = (await api("POST", "/api/handoffs", {
        campus: "North Campus", date: dayStr(daysAgo(d)), shift: s, sent_by: STAFF[(d + si) % STAFF.length],
        summary: `SHIFT HANDOFF SUMMARY\nNorth Campus — ${s} shift\n\n(Demo handoff text.)`,
      }));
      if (!(d === 0 && si === 0)) await api("POST", `/api/handoffs/${h.id}/ack`, { by: STAFF[(d + si + 1) % STAFF.length] });
    }
  }

  console.log(`Seeded ${clients.length} clients, ${entries} log entries, ${infractions} infractions and demo handoffs at ${BASE}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
