<!-- Calibration: Medium complexity | Single-maintainer project | Significant tradeoff — lay out honestly -->

# Cloud Sync for Math Trainer

## Background & Motivation

Practice history lives in IndexedDB, scoped to one browser profile on one device.
That was the right call for v0 — it made the app work in a car with no
connectivity and kept a child's practice data off anyone's infrastructure. It
does not survive contact with a household that has two laptops and two tablets.

Today the only transfer path is Parent → Export / Import: a JSON file moved by
hand. It works and is verified, but it requires a person in the loop for every
transfer, which means in practice it will not happen.

**Goals**

- Practice on any signed-in device; history converges without manual steps.
- Offline remains fully functional. Sync is opportunistic, never load-bearing.
- Deletion propagates correctly rather than being silently undone by a merge.
- Support multiple learners, and eventually multiple independent households.
- No running cost, and no possibility of an unexpected bill.

**Non-Goals**

- Real-time collaboration. Convergence within seconds of coming online is ample.
- Server-side analytics, leaderboards, or any cross-household visibility.
- Syncing parent authentication material (see *Security Model*).

**Terms**

- **Household** — a billing/ownership boundary containing one or more parent
  accounts and one or more learners. Households are fully isolated from each other.
- **Learner** — a child whose practice history is tracked. Not an auth identity.
- **Device** — one browser profile on one machine. Identified by a locally
  generated UUID, not by the user agent.
- **Cursor** — the point in server-time up to which a device has already pulled.

## Proposal Overview

Four decisions carry the design:

1. **Nothing is ever mutated.** Devices only create documents. Attempts are
   immutable and UUID-keyed, so merging is a set union — commutative, idempotent,
   and free of write conflicts by construction. Firestore security rules enforce
   append-only at the server, so even a compromised client cannot rewrite history.
2. **Deletion is data.** An erase writes a *tombstone*, not an absence. This is
   the only way a delete survives a union with a device that was offline when it
   happened.
3. **Reads are incremental.** Every device keeps a cursor and pulls only what it
   has not seen. The cursor — not any batching scheme — is what keeps cost flat
   as history grows. One document per attempt, keyed by the attempt's own UUID,
   makes pushing idempotent with no mutable bookkeeping.
4. **Local storage stays the source of truth.** The sync layer is an adapter
   behind a narrow interface. The app never blocks on the network, and swapping
   the backend later does not touch the merge logic.

```mermaid
flowchart LR
    subgraph Device["Device (offline-capable)"]
        UI[Practice UI] --> IDB[(IndexedDB<br/>source of truth)]
        IDB <--> Engine[Sync engine]
    end
    Engine -->|push unsynced records| FS[(Firestore)]
    FS -->|pull records + tombstones<br/>since cursor| Engine
    Auth[Firebase Auth] -.identity.-> Engine
```

Sync is a loop over an append-only log, not a diff of two states:

```mermaid
sequenceDiagram
    participant A as Device A
    participant F as Firestore
    participant B as Device B
    A->>F: set attempts, keyed by attempt id
    B->>F: set attempts, keyed by attempt id
    B->>F: read where syncedAt > cursorB
    F-->>B: A's attempts
    Note over B: union into IndexedDB,<br/>apply tombstone filter
    A->>F: create tombstone {kind: purge, before: T}
    B->>F: read tombstones where syncedAt > cursorB
    F-->>B: purge T
    Note over B: drop attempts with at <= T
```

## Detailed Design

### Identity and tenancy

Firebase Auth provides identity. Google, Apple, and email+password all resolve to
one `uid`, which is why this is chosen over an approach tied to a single provider
(see *Alternatives*).

A `uid` is a **parent account**. Learners are records inside a household, not auth
identities — children never sign in. This matters: it avoids creating accounts for
minors, and it means a shared family tablet does not need account switching.

### Data model

```
households/{householdId}
  members:   { <uid>: "owner" | "parent" }
  invitedEmails: [ "..." ]
  createdAt

households/{householdId}/learners/{learnerId}
  name, createdAt
  targetOverrides: { <skillId>: seconds }   // calibrated reference times

households/{householdId}/learners/{learnerId}/attempts/{attemptId}
  ...Attempt fields, deviceId
  syncedAt: <server timestamp>              // cursor ordering only

households/{householdId}/learners/{learnerId}/sessions/{sessionId}
  ...SessionRecord fields, deviceId, syncedAt

households/{householdId}/learners/{learnerId}/tombstones/{tombstoneId}
  kind: "purge" | "record"
  before: <server timestamp>                // kind = purge
  targetIds: [ ... ]                        // kind = record
  createdAt, deviceId
```

The document id **is** the attempt's local UUID. That single choice removes a
whole class of bug: a push is `set(attemptId, attempt)`, so a retried, duplicated,
or interrupted push converges to the same state with no deduplication logic and no
high-water mark to corrupt.

Local IndexedDB gains a `learnerId` on every attempt and session, plus two new
stores: `tombstones` and `syncState` (per learner: pull cursor and device id).

### Sync protocol

**Push.** Write any locally-unsynced attempts as documents keyed by their own id,
in chunks of up to 500 via `writeBatch` (an atomicity and round-trip convenience,
not a storage layout). Because the id is the payload's id, a push is idempotent:
interrupted, retried, or duplicated pushes all converge. A local `synced` flag is
an optimization to avoid re-sending, never a correctness requirement — losing it
costs bandwidth, not data.

**Pull.** Query `attempts`, `sessions`, and `tombstones` where
`syncedAt > cursor - overlap`, ordered by `syncedAt`. Union into IndexedDB, apply
tombstones, advance the cursor.

The `overlap` deserves explanation: a document committed concurrently can land
with a server timestamp marginally behind a cursor the reader has already passed,
which would leave it permanently unseen. Re-reading a trailing window (five
minutes) closes that gap. It is safe precisely because the merge is idempotent —
re-reading costs a few reads and changes nothing.

**Trigger points.** App open, session end, and on regaining connectivity. No
polling.

### Deletion semantics

The parent-mode erase is **global**: it wipes every synced device. This is the
decision recorded for v1; the button must say so plainly.

An erase writes `{kind: "purge", before: T}` and clears local rows. Any device
materializing history drops attempts with `at <= T`. Applying a purge twice is
identical to applying it once, so it composes with the union without special
casing.

`T` is a Firestore server timestamp rather than a device clock, so all devices
compare against the same authority. The residual hazard is a device whose own
clock is badly wrong, since attempt timestamps are still stamped locally: such a
device could keep records a purge should have removed, or vice versa. Mitigation:
on each sync, compare the device clock against the server timestamp and surface a
warning in parent mode if they differ by more than five minutes. This is a real
but narrow window and is accepted rather than solved.

A generation counter was considered instead, and rejected: it is clock-independent
but wrongly discards work produced *after* a purge by a device that was offline
and could not have known the generation changed. Timestamps handle that case
correctly, which is the more likely one.

### Security model

Rules enforce three invariants:

- A household is readable and writable only by its members.
- `attempts`, `sessions` and `tombstones` allow `create` but never `update` or
  `delete`. History is append-only at the server, not merely by client
  convention. Note this means a client cannot overwrite an existing attempt id,
  so idempotent re-pushes must tolerate a permission error on records the server
  already holds.
- A user may add themselves to `members` only if their verified email appears in
  `invitedEmails`.

That last rule is what makes multi-household invites work **without server-side
code**, which matters because Cloud Functions require the paid Blaze plan.

The parent TOTP secret is deliberately **not** synced. It is per-device by design;
syncing it would mean one compromised device unlocks parent mode everywhere.
Consequence: each device enrolls separately, which the enrollment flow already
supports via per-device labels.

### Cost Model

Attempt records are ~200 bytes. Sixty problems a day is ~4.4 MB per learner-year.

| Firestore Spark quota | Limit | Steady state (one household, 3 devices) |
|---|---|---|
| Storage | 1 GB | ~4 MB / learner-year |
| Writes / day | 20,000 | ~60 (one per attempt) |
| Reads / day | 50,000 | ~180 (60 new attempts x 3 devices) |

Steady-state cost depends on *daily volume*, not accumulated history, because
every device reads from a cursor. Practising twice as much, on twice as many
devices, is still under 1% of quota.

The one case that scales with history is **cold start** — a new device pulling
everything:

| History | Cold-start reads |
|---|---|
| 1 year (~22k attempts) | ~22,000 |
| 2 years | ~44,000 |
| 5 years | ~110,000 — exceeds the 50,000/day quota |

A device added to a multi-year history would fail to complete its first sync. The
fix is compaction — periodically folding old attempts into snapshot documents of
~500 records each, reducing a five-year cold start to a few hundred reads — and it
can be added later without changing the protocol, since a snapshot is just another
immutable document. Building it now would be optimising for a problem that is
years away and may never arrive.

Staying on the Spark plan means the system **cannot generate a bill** — it fails
closed when a quota is exhausted rather than billing. That is a deliberate choice
over Blaze's smoother degradation.

Staying on the Spark plan means the system **cannot generate a bill** — it fails
closed when a quota is exhausted rather than billing. That is a deliberate choice
over Blaze's smoother degradation.

## Rollout Plan

Phased so each step is independently useful and nothing is built speculatively.

| Phase | Scope | Ships |
|---|---|---|
| 0 | Local `learnerId` scoping + tombstones. No auth, no network. | Correct erase semantics and a sync-ready schema, with zero new surface area. |
| 1 | Firebase Auth (Google) + Firestore sync, one household, one learner. | The actual problem being solved. |
| 2 | Multiple learners per household; learner picker. | Second child. |
| 3 | Invites, additional auth providers. | Other households. |

**Migration.** Existing local records predate `learnerId`. On first launch after
Phase 0, create a default learner and assign every existing attempt and session to
it. Local, one-time, no network, idempotent.

Phase 0 is worth shipping even if the rest is never built: today's erase is
already wrong the moment a second device exists, and the export/import path has
the same resurrection bug.

## Alternatives Considered

**Google Drive `appDataFolder`.** Half the effort, no backend, data in the user's
own Drive, and the `drive.appdata` scope is non-sensitive so it avoids Google's
sensitive-scope review. Rejected because the storage *is* the Google identity:
there is no appDataFolder for an email+password user, so it cannot reach
multi-provider auth or multi-household sharing without a full migration. Still the
right answer for a single family that will never leave Google accounts.

**Supabase.** Postgres and row-level security are a good fit, but free-tier
projects pause after a week of inactivity — precisely the usage pattern of a
household app used in bursts.

**Cloudflare Workers + D1.** Generous free tier with no pausing, but requires
writing and operating auth and API surface that Firebase provides directly.

**Status quo (export/import).** Zero cost and zero risk, but requires a human for
every transfer, which means convergence will not happen in practice.

## Risks

**Custody of other children's data.** Phase 3 puts other families' children's
practice records in this project's Firestore, under one person's Google Cloud
account. That is a real obligation — data-protection expectations around minors,
deletion requests, and a sign-up surface open to strangers. This is a policy
decision, not a technical one, and it should be made deliberately before Phase 3
rather than discovered afterward. Phases 0–2 carry none of it.

**Silent token renewal on Safari.** Browser OAuth issues short-lived tokens
renewed silently while the provider session is alive; Safari's tracking prevention
can break this, producing periodic re-sign-in prompts on tablets. Sync must treat
an expired token as "offline" and never interrupt practice.

**Sync bugs are data-loss bugs.** Append-only writes keyed by the record's own id
make the failure modes mild: the plausible failure is stale data, not lost data,
and there is no mutable server-side bookkeeping to corrupt. The remaining sharp
edge is the pull cursor — advancing it past unread documents would lose them
silently — which is why it carries an overlap window and needs direct test
coverage, including interrupted pulls and concurrent writes from two devices.

**Cold-start read cost is a cliff, not a curve.** Deferred by design, but a device
added to a several-year history fails its first sync outright rather than
degrading gracefully. Compaction needs to exist before that point is reachable,
and the trigger is measurable in advance: total attempts approaching ~40,000.

**Public repository.** Firebase client config is public by design; the security
rules are the boundary, so they must be tested rather than assumed. Rules unit
tests belong in CI alongside the existing suites.

**Scope creep against a working app.** The app currently does its job. Sync adds
auth, a backend, a data migration, and a new class of bug. Phase 0 is cheap and
strictly corrective; Phases 1+ should be justified by actually feeling the
multi-device pain, not by anticipating it.

## Open Questions

1. **Is multi-household actually wanted?** It is the single largest driver of
   complexity and the only source of legal exposure. If the answer is "probably
   not", Drive `appDataFolder` becomes the better design and this document
   shrinks by half.
2. **Should calibrated reference times and settings sync?** They are
   household-level rather than device-level, so probably yes — but calibration is
   parent-specific, and a second parent calibrating would overwrite the first.
3. **Does a shared family tablet need a learner picker on the dashboard**, or
   should learner selection live behind parent mode to stop siblings recording
   into each other's history?
