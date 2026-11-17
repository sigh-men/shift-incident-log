# Warnings & Write-Ups — Feature Spec (draft)

Status: **design only, nothing built.** Open questions at the end must be answered
before implementation starts.

## 1. Purpose

Replace the paper VW/WW/WU process and its scattered documentation with a single
tracked record. Today one warning is written on paper, copied into the census, the
log book, EHR, and an 8x8 message to the counselor — five places, no shared
state, and no reliable way to know what a client's history is or which consequences
are still outstanding.

This adds a Warnings tab that owns the whole lifecycle: issue → deliver → sign →
consequence → close, with the escalation level computed rather than guessed.

## 2. Decisions locked

| Decision | Choice |
|---|---|
| Client identity | Full roster table; warnings link to client ID |
| Numbering | Per type, per client (`VW#2`, `WW#1`, `WU#3` can coexist) |
| Signature | Print only; signature tracked as a checkbox + timestamp, no image stored |
| Workflow | Full checklist with reminders (EHR, 8x8, census, consequence) |
| Log book | This app — issuing a warning auto-creates a linked `shift_log` entry |
| Visibility | All staff see all warnings |
| Consequence sign-off | Any staff on shift can close it out; their name is recorded |
| Census source | Shared spreadsheet exists; roster standalone for now, sync later |
| Offense counts | Never reset — cumulative for the client's entire stay |
| Phase change | Counts carry from Phase 1 to Phase 2 |
| Level chosen by | **Staff.** The system counts and numbers; it does not decide |
| Rule capture | Picklist of ~14 rules + free-text detail |
| History shown | Full client history inline on the form while writing |
| Discharge | Warnings stay visible indefinitely |

## 3. Counting and numbering

The BHT decides whether something is a VW, WW or WU. The system's job is to know what
number it is and to make sure the person writing it can see the full picture first.

**Staff pick the client, the rule, and the level. The system numbers it.**

The number is per client, per type, cumulative for the whole stay:

```
next number = count of that client's existing warnings of that type + 1
```

So a client can be on VW#4, WW#2 and WU#1 simultaneously — three independent counters.
The number is assigned when the warning is issued (not while drafting), and is shown
before saving so the BHT sees `WW#2` and can put it on the paper.

### History on the form

While writing a warning, the form shows that client's **complete warning history** —
type, number, rule, date, and whether the consequence was completed. Everything the
old ladder would have enforced is visible as context, and the decision stays with the
BHT.

This matters most for the pattern the paper system hides: a client with one chore
miss, one meeting miss and one late kitchen duty looks clean on any single rule but
has three offenses in a fortnight.

### Rule capture

A picklist of the ~14 house rules (chores, sign-in/out, room check, 12-step meetings,
house meeting, UA after 9pm, med times, kitchen duty, PH2 campus hours,
lending/borrowing, disrespect, smoking, electronic devices, failure to adhere to a
prior VW) plus a free-text field for what actually happened.

The picklist is what makes violations countable later — free-text alone can't be
charted, since "missed chores" and "didn't do chores" would never group together. The
free-text field is what keeps staff from picking a nearly-right option.

The catalog is admin-editable, so rule changes don't require a code deploy. Rules can
be retired without losing the history attached to them.

## 4. Data model

New tables. Existing tables are untouched except for a link from `shift_log`.

### `clients`

| Column | Notes |
|---|---|
| `id` | PK |
| `full_name` | Display name |
| `client_code` | Optional EHR/EHR identifier |
| `phase` | 1 or 2 |
| `campus` | "North Campus" for now |
| `status` | `active` / `discharged` |
| `admitted_at`, `discharged_at` | |
| `created_at` | |

### `rules` (catalog, admin-editable)

| Column | Notes |
|---|---|
| `id`, `code`, `label` | |
| `phase` | `PH1` / `PH2` / `both` — filters the picklist by client phase |
| `active` | Retire a rule without losing history |
| `sort_order` | Controls picklist order; put the common ones first |

Seeded from the ~14 rules. Editable so policy changes don't need a code deploy.

### `warnings`

| Column | Notes |
|---|---|
| `id`, `client_id`, `rule_id` | |
| `type` | `VW` / `WW` / `WU` — chosen by staff |
| `seq_number` | The `#3` — per client, per type, assigned at issue |
| `rule_detail` | Free text: what actually happened |
| `occurred_at`, `shift`, `campus`, `phase_at_time` | Phase snapshotted at issue |
| `issued_by`, `issued_by_initials`, `issued_at` | |
| `narrative` | What happened |
| `consequence_type` | `none` / `paper` / `chores` |
| `consequence_detail` | Paper topic, or chore assignment |
| `consequence_due` | Date |
| `status` | See lifecycle below |
| `delivered_at`, `signed_at` | Checkbox + timestamp |
| `EHR_uploaded_at`, `EHR_by` | |
| `counselor_notified_at`, `counselor_notified_by` | 8x8 message sent |
| `census_updated_at` | |
| `logbook_entry_id` | FK → `shift_log.id` |
| `completed_at`, `completed_by`, `completion_notes` | |
| `voided_at`, `voided_by`, `void_reason` | Admin only |
| `attachments` | JSON, same shape as `shift_log` |

### `warning_edits`

Mirrors the existing `entry_edits` pattern — one row per edit, JSON diff,
admin-visible. Warning records are disciplinary; every change needs a trail.

## 5. Lifecycle

```
draft
  └→ pending_delivery   (written, not yet given to client)
       └→ issued        (delivered + signed)
            ├→ closed              (VW — no consequence)
            └→ consequence_open
                 └→ completed      (paper turned in / chores done)
                      └→ closed    (uploaded, filed, paper shredded)
```

`voided` is reachable from any state, admin only, reason required.

**`pending_delivery` is restricted.** Per policy, a warning must be handed to the
client on the issuing shift — except for sign-in/out violations. The system enforces
this: selecting "deliver next shift" is only available when the rule is sign-in/out.
For every other rule the option is disabled with the policy reason shown.

This is the clearest example of the app turning written policy into something that
actually holds.

## 6. The printed form

Generated for **WW and WU only** — verbal warnings produce no paper and no signature.

Recommended approach: a **print-stylesheet view in the browser**, not server-side PDF
generation. Reasons: no new backend dependency, works from any device on the LAN,
works offline through the existing service worker, and prints two copies in one job.
`docs/*.py` stays as-is for the handoff/IT documents.

Layout follows current practice:

- **Top right:** `WU#3 SS` — type, number, issuing counselor initials
- Client name, date, time, shift, campus, phase
- Rule violated (catalog label) + narrative
- Consequence and due date, in the standard language (to be supplied)
- Signature lines: client and staff
- Small record ID footer so the paper maps back to the database row

Two copies per print: one to the client, one for the file.

## 7. Integration with the existing app

**Log book entry.** Issuing a warning writes a `shift_log` entry automatically —
infraction and `WW#`/`WU#` in the narrative, linked both ways. The warning appears in
the normal feed and the existing unread tracking without anyone typing it twice.

**Shift handoff.** New section: open consequences, with client, type, what's owed and
when it's due. This is the "who owes chores this weekend?" problem solved as a side
effect.

**Dashboard.** New charts: violations by rule, by shift, by campus, by time of day;
open vs closed consequences; clients with active consequences. The rule catalog is
what makes this countable — free-text violations could never be analysed.

**Notifications.** Reuse the existing per-user notification table:
counselor notified on issue; issuing staff notified when a consequence is completed;
escalating reminders on overdue consequences and on checklist steps left undone
(EHR upload, 8x8 message) past a threshold.

**Realtime.** Warnings broadcast over the existing SSE channel — no new plumbing.

## 8. Permissions and compliance

Uses the existing PIN roles.

| Action | Staff | Admin |
|---|---|---|
| View warnings | ✓ | ✓ |
| Issue warning, choose level | ✓ | ✓ |
| Close out consequence | ✓ | ✓ |
| Edit an issued warning | own only | any |
| Void a warning | ✗ | ✓ |
| Manage roster / rule catalog | ✗ | ✓ |

### Compliance note

This is the first time client-level records live in the app. SUD treatment records fall
under **42 CFR Part 2**, which is stricter than HIPAA — it restricts redisclosure even
to parties HIPAA would allow.

The current setup already does most of the work: on-premises, LAN/VLAN-only, no cloud
dependency, TLS internally. Three gaps worth closing alongside this feature:

1. **Backups are unencrypted.** `backup.sh` writes plain SQLite snapshots and
   attachment tarballs to `/volume1/docker/shiftlog-backups/`. Once those contain
   client disciplinary records, they should be encrypted at rest.
2. **PINs are shared knowledge and live in `web/script.js`.** Fine for staff-attributed
   log entries; weaker for client records. Worth deciding whether it stays acceptable.
3. **Access logging.** Who *viewed* a client's warning history isn't recorded, only who
   changed it. Part 2 audits generally want read access logged too.

None of these block the build. They should be conscious decisions rather than defaults.

## 9. Open questions

**Content — supplied later, per your note**

1. WW paper topic list, and how a topic gets chosen.
2. Standard consequence language for the printed write-up.
3. Chore assignment: specific task or generic "2 hours"? Always the upcoming
   weekend, or schedulable?
4. Final rule picklist — confirm the ~14 rules and the wording staff should see.
   The original list was written as offense levels ("PH1 second offense of failing
   to do chores"); the picklist needs the plain rule ("Failing to do chores").

**System**

5. Do voided warnings consume a sequence number? *Recommendation: yes — keep the
   gap. Renumbering rewrites history that already exists on paper.*
6. Do counselors need individual PIN accounts to receive notifications? Currently
   there's one shared `Clinicians` login.
7. Can the census spreadsheet be shared for a look, to see if roster import is
   worth building?
8. Should the form warn — not block — when the chosen level looks out of step with
   history, e.g. a first-ever offense written straight to WU? *Recommendation: no,
   at least not at first. It re-introduces the ladder through the back door and
   there are legitimate immediate write-ups (disrespect, smoking, devices).*

## 10. Suggested build order

1. **Roster + rule catalog + warnings table + counter.** Tab lists, filters and
   creates warnings; auto-numbering and inline client history. The foundation — and
   testable on its own.
2. **Print view.** WW/WU form, two copies, standard language.
3. **Checklist + reminders.** EHR, 8x8, census, consequence completion, plus
   the restricted `pending_delivery` state.
4. **Integrations.** Auto log-book entry, handoff section, dashboard charts.
5. **Analytics.** Violation trends by rule, shift, campus, time.

Steps 1–2 alone replace the paper form. Steps 3–4 are what eliminate the
double-documentation.
