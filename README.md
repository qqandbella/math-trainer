# Math Trainer

An offline-first arithmetic fluency trainer. It measures execution speed and
accuracy per micro-skill, then spends practice minutes where the measurement
says they are worth most.

It is deliberately **not** a concept tutor — it complements Beast Academy rather
than competing with it. The thing it targets is the gap between understanding a
method and executing it quickly and correctly.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
npm run dev:lan      # same, reachable from an iPad on the same wifi
```

```bash
npm test             # unit tests (generator contracts, mastery, TOTP, scoring)
npm run typecheck
npm run build        # typecheck + production build into dist/
npm run smoke        # end-to-end browser test against a preview server
npm run offline      # cold-start-with-no-network test (install, quit, relaunch offline)
npm run privilege    # what works signed out, and that parent tools need an account
npm run migration    # seed a real v1 database and check the upgrade preserves it
npm run scratch      # scratch pad: drawing, erasing, folding, reset per problem
npm run correct      # going back to fix a mistyped answer
```

## How it works

### Skills are structural, not enumerated

A skill is a `(operation, digit widths, structural features)` tuple —
`mul_4x2`, `sub_4x4_zero`, `div_3x1_rem`. The generator is *targeted*: asking
for `sub_4x4_zero` produces a subtraction that provably forces a borrow to
propagate through a zero, instead of hoping a random draw happens to.

That is what makes coverage uniform and per-skill diagnosis meaningful. Random
`n-digit × m-digit` problems cover the micro-skills, but not evenly, so a
weakness in one shape hides inside an average.

`src/core/generator.test.ts` asserts, for every skill and 400 samples each, that
the generated problem satisfies its declared features *and* its digit widths.

### Mastery score

Per skill, over a rolling window:

```
mastery = 100 × accuracy^1.5 × clamp(targetTime / medianTime, 0, 1.25)
```

- **100** means "at the calibrated reference time, with no mistakes".
- Accuracy is super-linear, so 90% reads visibly below 100%.
- The speed term is capped so racing cannot offset errors.
- Timing accumulates from **correct attempts only** — the time spent producing a
  wrong answer says nothing about how fast the skill can be executed.
- A skill stays **unrated** (`—`, no bar) below 8 attempts. No bar is drawn for
  an unrated skill, because a filled grey bar next to "—" reads as a score.

Reference times ship as estimates and are meant to be replaced: Parent →
*Calibrate* runs 40 problems at an adult pace and rewrites the targets from your
own medians. Calibration attempts are never written to the learner's history.

### Adaptive selection

Daily Practice fills its problems as ~55% weakest skills (weighted by
`100 − mastery`), ~25% spaced review of skills untouched for 3+ days, and ~20%
next-rung skills not yet seen — with a per-skill cap so no session degenerates
into one drill, and a pass that stops the same skill appearing three times in a
row.

Session length is 30 by default and configurable in parent settings
(20/30/40/50/60). The operation mix is a ratio rather than a set of counts, so
the shape of a session is the same whichever length is chosen — a shorter
session done daily beats a longer one done occasionally.

### Sessions

Per-problem timing runs from when a problem appears to submit, with paused time
subtracted, so the clock measures thinking rather than the interruption that
made the learner put the device down. Pauses are budgeted (3 by default).

Feedback defaults to **quiet**: correct answers flash green, wrong ones advance
without comment, and every mistake is listed at the end with the right answer.
For an already-cautious solver, flagging errors mid-session tends to slow them
down further. Switch to immediate right/wrong in Parent → Settings.

### Scratch pad

One screen. The problem, the answer box and the keypad are always there; the
scratch pad folds open between the answer box and the keypad when it is wanted,
and folds away when it is not. Opening it never takes the keypad away.

Write and erase, plus clear. The eraser removes whole strokes it is dragged
over, which is why strokes are kept as point lists rather than being painted
straight onto the canvas — that also makes a resize redraw rather than stretch a
bitmap. Once a stylus is seen, touch is ignored for the rest of that problem: on
a tablet the palm lands before the pen does.

The pad stays open across problems while the paper resets for each one. Mental
Challenge has no pad at all, since working it out is exactly what that mode
excludes.

**Handwriting recognition was tried and removed.** A small MLP trained on MNIST
scored 97.4% on held-out MNIST and was unusable in practice: MNIST is
pen-on-paper, size-normalised and centred, and a finger on glass is a different
distribution entirely. The lesson is recorded here rather than repeated — see
`docs/design/` if it is ever revisited.

### Session history

Progress lists every session on its own — Daily Practice and a Mental Challenge
on the same day are different things and a daily total hides that. Tap one to
see each problem in it: what was answered, the correct value, how long it took,
which skill it exercised, and the working out for anything wrong.

Parent mode shows the same list with selection, so a session that should never
have counted — a parent trying the app — can be deleted rather than averaged
into the learner's record. Deletion goes through the same tombstone mechanism as
a full erase, so it propagates to other devices and cannot come back from an
older backup, and it takes the working-out pictures with it.

### Reviewing the working out

For a wrong answer, the scratch pad is saved as a picture and offered in the
session review — so a mistake can be diagnosed from *how* it was worked out,
not just that the answer was wrong. Right answers are not kept: there is nothing
to diagnose.

The image is cropped to what was actually written and scaled down, which is a
fraction of the size of a full-canvas screenshot, and it never leaves the
device: not exported, not synced. Erasing practice data removes the pictures
too, and parent mode reports how much space they occupy so the cost is visible
rather than accumulating silently.

An account feature, like sync.

### Correcting an answer

**↩ back** returns to the previous problem with the answer pre-filled to edit. A
typo would otherwise be recorded as a wrong answer and become a false data point
in the very measurements the app exists to produce. A correction replaces the
original record rather than appending, and keeps the original time: a typo does
not mean the thinking was quicker. Not offered in Mental Challenge, where second
thoughts are the thing being measured.

### Mental Challenge

2–5 minutes, no paper. Correct earns the skill's difficulty weight, wrong earns
zero, and **skipping costs points — more for easier problems**, so the incentive
is to attempt everything rather than cherry-pick.

### Accounts and parent mode

Practice needs no account. Signing in with Google is what unlocks the advanced
features: cross-device sync, parent settings, calibration, export/import, and
reviewing scratch work.

Parent mode is reached by pressing and holding the dashboard title for 3
seconds, and is gated by a **TOTP code** from your authenticator app rather than
a password — a password is memorised the first time a child watches you type it;
a 30-second code is worthless once seen.

**The secret belongs to the account, not the device.** Held per device it had to
be enrolled once per device *and* per browser profile, which across a few
laptops and tablets is unworkable. It now lives in the household document and is
cached on each device, so it is enrolled once, accepted everywhere, and still
works offline.

Signing in is deliberately not sufficient on its own: the learner's own tablet
must be signed in for sync, so a code is still required to get past the gate.

Enrollment shows a **QR code** to scan with a phone authenticator, with a
tap-through `otpauth://` link for setting up on the same device and the raw
secret behind a disclosure as a last resort. `npm run qr` rasterises the
rendered QR and decodes it the way a camera would, asserting it carries the
expected secret, algorithm, digit count and period.

The TOTP implementation is verified against the RFC 6238 published test vectors,
so it interoperates with Google Authenticator, 1Password, etc. The secret is
generated on-device and never committed.

Inside parent mode, **Export / import → Erase all practice data** clears every
attempt and session on that device, behind a two-step confirmation. It keeps the
parent secret, calibrated reference times, and settings, so wiping trial data
before handing the app to a learner does not mean setting parent access up
again. `npm run parent` verifies that whole path, including that a wrong code is
rejected and that access survives the erase.

### Storage and sync

Everything lives in IndexedDB on the device. Attempts are immutable and
UUID-keyed, so Parent → *Export / import* merges by set-union: importing the
same file twice is a no-op, and two devices merge to the same result in either
order. Real cross-device sync is a later job, and this shape makes it a small one
(see `docs/design/cloud-sync.md`).

**Deletion is recorded, not implied.** A set union has no way to express "this is
gone", so erasing rows alone would be undone by the next merge with any copy that
predates the erase — including a backup from last week. Erasing therefore writes
a *tombstone*, which travels in exports and is enforced on every merge in both
directions: incoming records covered by a local erase are refused, and local rows
covered by an imported erase are removed. Because that would otherwise make
restoring a backup silently do nothing, a blocked import says how many records it
withheld and offers to restore them anyway.

Practice is scoped to a **learner**. There is one today and no UI for it; the
scoping exists so that adding a second child later does not require migrating
history a second time. While a device tracks exactly one learner, an imported
bundle is adopted into it — different devices mint different learner ids for the
same child, and without reconciliation an erase from one device would not match
the other's records.

**Browser account sync does not move this data.** Chrome Sync covers bookmarks,
history, passwords and open tabs — not IndexedDB, localStorage or Cache Storage.
Signing the same account in on another device gets you the bookmark, not the
practice history. Export / import is the only transfer path, and `npm run
transfer` verifies it across two separate browser profiles, including that a
repeated import does not double-count.

## Configuration

`src/curriculum/curriculum.json` is the tuning surface — skills, reference
times, difficulty weights, session presets, selection shares, scoring
constants. It is hand-edited (by you or by an agent) and validated at startup:
a typo raises a specific error rather than silently producing a skill that never
generates.

**Skill ids are stable keys into practice history.** Renaming one orphans its
data.

## Deployment

Hosted on GitHub Pages. Every push to `main` runs the tests, builds, and
deploys via `.github/workflows/deploy.yml` — no manual step.

Because this is a project site, the app is served from a sub-path, so
`vite.config.ts` sets `base: '/math-trainer/'`. Routing is hash-based, so the
sub-path does not affect navigation.

The service worker is registered with `registerType: 'prompt'` plus an in-app
"new version is ready" banner. Without that, an installed PWA happily serves a
cached build forever, and a fix would silently never reach an offline device.

### Working offline

The app is designed to be used with no connectivity at all. `npm run offline`
verifies this the hard way: it installs the app in a persistent browser profile,
**fully quits the browser**, relaunches it with the network disabled, and then
completes a whole session from a cold start.

Three things make that work, and each is checked by that test:

- **No external requests.** No CDN, web font, or analytics call — anything
  third-party would simply fail once offline. System fonts only.
- **Answers are written to disk as they happen**, not at the end of the session,
  with an extra flush on `pagehide` / `visibilitychange`. A backgrounded tab can
  be discarded at any moment, and without this a half-finished 60-problem
  session would evaporate.
- **Persistent storage is requested at startup**, because iOS clears site data
  after roughly a week of inactivity. Installing to the home screen makes
  eviction much less likely; `navigator.storage.persist()` makes it explicit.

## Layout

```
src/core/          generator, arithmetic predicates, mastery, selection, mental scoring
src/curriculum/    curriculum.json + startup validation
src/storage/       IndexedDB access, export/import merge
src/parent/        TOTP
src/app/           state provider, session engine, hash router
src/ui/            pages and components
scripts/           icon generation, end-to-end smoke test
```

## Roadmap

- **v0 (shipped)** — Daily / Custom / Timed / Mental practice, reports, hidden
  parent mode, calibration, offline install, export/import.
- **v0.1** — printable worksheet mode; 速算技巧 strategy drills (11 × abcd,
  a² − b², 通分, ×5 via ÷2×10, near-100 products).
- **v1** — real cross-device sync, richer adaptation, strategy library.
- **Later** — elementary olympiad topics (鸡兔同笼, 抽屉原理, 容斥).
