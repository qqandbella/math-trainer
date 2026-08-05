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

Daily Practice fills its 60 problems as ~55% weakest skills (weighted by
`100 − mastery`), ~25% spaced review of skills untouched for 3+ days, and ~20%
next-rung skills not yet seen — with a per-skill cap so no session degenerates
into one drill, and a pass that stops the same skill appearing three times in a
row.

### Sessions

Per-problem timing runs from when a problem appears to submit, with paused time
subtracted, so the clock measures thinking rather than the interruption that
made her put the iPad down. Pauses are budgeted (3 by default).

Feedback defaults to **quiet**: correct answers flash green, wrong ones advance
without comment, and every mistake is listed at the end with the right answer.
For an already-cautious solver, flagging errors mid-session tends to slow her
down further. Switch to immediate right/wrong in Parent → Settings.

### Mental Challenge

2–5 minutes, no paper. Correct earns the skill's difficulty weight, wrong earns
zero, and **skipping costs points — more for easier problems**, so the incentive
is to attempt everything rather than cherry-pick.

### Parent mode

Reached by pressing and holding the dashboard title for 3 seconds. There is no
visible entry point, and the gate is a **TOTP code** from your authenticator app
rather than a password — a password is memorised the first time a kid watches
you type it; a 30-second code is worthless once seen.

The implementation is verified against the RFC 6238 published test vectors, so
it interoperates with Google Authenticator, 1Password, etc. The secret is
generated on-device and never committed.

### Storage and sync

Everything lives in IndexedDB on the device. Attempts are immutable and
UUID-keyed, so Parent → *Export / import* merges by set-union: importing the
same file twice is a no-op, and two devices merge to the same result in either
order. Real cross-device sync is a v1 job, and this shape makes it a small one.

## Configuration

`src/curriculum/curriculum.json` is the tuning surface — skills, reference
times, difficulty weights, session presets, selection shares, scoring
constants. It is hand-edited (by you or by an agent) and validated at startup:
a typo raises a specific error rather than silently producing a skill that never
generates.

**Skill ids are stable keys into practice history.** Renaming one orphans its
data.

## Deployment

Hosted on Cloudflare Pages (GitHub Pages cannot serve a private repo on the free
plan). One-time setup in the Cloudflare dashboard:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node version | 20 or newer |

After that, every push to `main` builds and deploys automatically, and branches
get preview URLs.

The service worker is registered with `registerType: 'prompt'` plus an in-app
"new version is ready" banner. Without that, an installed PWA happily serves a
cached build forever — on a device that mostly gets opened in the car, fixes
would silently never land.

## Git identity

This repo pushes as the personal **qqandbella** account, never the work account.
Both are configured **repo-locally**; nothing global is modified.

```bash
./scripts/qq-gh.sh repo view      # gh as qqandbella (isolated GH_CONFIG_DIR)
```

Git uses a repo-local credential helper that reads `$QQBELLA_GH_TOKEN`. Note
that a system-level `credential.helper=osxkeychain` would otherwise offer the
work credential first and make this private repo 404; the local config resets
the inherited helper list before adding its own.

## Layout

```
src/core/          generator, arithmetic predicates, mastery, selection, mental scoring
src/curriculum/    curriculum.json + startup validation
src/storage/       IndexedDB access, export/import merge
src/parent/        TOTP
src/app/           state provider, session engine, hash router
src/ui/            pages and components
scripts/           icon generation, smoke test, gh wrapper
```

## Roadmap

- **v0 (shipped)** — Daily / Custom / Timed / Mental practice, reports, hidden
  parent mode, calibration, offline install, export/import.
- **v0.1** — printable worksheet mode; 速算技巧 strategy drills (11 × abcd,
  a² − b², 通分, ×5 via ÷2×10, near-100 products).
- **v1** — real cross-device sync, richer adaptation, strategy library.
- **Later** — elementary olympiad topics (鸡兔同笼, 抽屉原理, 容斥) as she grows
  into them.
