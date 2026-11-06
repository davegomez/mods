# Enrollment correctness review

Repository: `/Users/dave/Development/personal/mods`, branch `feat/blindfold`.
Scope: `enroll.ts`, its registration and tests, against R1–R10 and Q22/Q23. Known finding F24 is excluded. Finding numbers continue after F24.

## Path rules: R1 and R2

### F25. High: trimming the root can change a POSIX directory name

Location: `blindfold/hooks/enroll.ts:155–156`, `:168`, `:179`.

Input: a POSIX session root whose last directory component is `project` followed by one literal backslash, with separate `.env` files in that directory and its sibling named `project`. Load `.env`.

What happens: `rootOf` removes the backslash even though it is part of the POSIX filename, not a separator. The code stats and reads the sibling's `.env`, then validates it against the already altered root. The probe returned an active file and active shield, enrolled the outside sibling's fabricated value, and did not enroll the actual project's value.

Evidence: `verified-real-fs.ts`, case `POSIX_LAST_COMPONENT_BACKSLASH_NODE_ADAPTER`. The root stat preserved the literal backslash, but the subsequent read ended in `/project/.env` rather than `/project\/.env`. This probe executes enrollment under Bun with Node-backed filesystem calls. Bun 1.3.13's own `realpath` also incorrectly strips the trailing backslash, so it cannot independently validate this fixture.

Fix: trim only the separator appropriate to the resolved root, preserving literal backslashes in POSIX directory names.

### F26. High: replacing a validated file with a symlink bypasses confinement

Location: `blindfold/hooks/enroll.ts:177–183`, `:195–200`.

Input: load `.env` as a regular file inside the root, then replace it with a symlink to a fabricated env file outside the root after stat completes but before the filesystem read opens it.

What happens: the original stat passes every check. `$.fs.read(place.realPath)` subsequently follows the replacement symlink and reads the outside file. Enrollment returns an active file and active shield and keeps the outside file's value. Resolving a pathname before reading it does not bind the read to the validated file.

Evidence: `repro.ts`, case `TOCTOU`, uses actual filesystem replacement. The pre-read stat reported `isLink: false`; at read time the same requested path was a symlink whose resolved target was outside the session root. `outsideValueEnrolled` was `true`.

Fix: require an atomic root-confined, no-follow read of the same validated file handle, including ancestor confinement, or fail closed if the host cannot provide it.

### F27. Medium: a missing leaf bypasses an outside-root parent check in addFile

Location: `blindfold/hooks/enroll.ts:171–179`, `:327–332`.

Input: inside the project, create directory symlink `linked` pointing to a separate directory outside the project. Leave `linked/new.env` absent, then call `addFile(..., "linked/new.env")`.

What happens: stat rejects and exists returns false, so `locate` returns `missing` before checking real-path confinement. `addFile` accepts that state, persists `blindfold.envFiles=linked/new.env`, and returns `added`. The existing-file control, `linked/existing.env`, is correctly refused. R9's missing-file allowance therefore accepts an outside-root destination that the same path validation rejects once it exists. The probe did not perform a write or an outside-file read.

Evidence: `verified-real-fs.ts`, case `MISSING_DESTINATION_SYMLINK_PARENT_NODE_ADAPTER`, verifies the actual directory symlink and captures the configuration set.

Fix: before accepting a missing destination, resolve its nearest existing ancestor and verify that the eventual destination remains inside the real root.

## State and confidentiality: R4–R6 and R10

### F28. High: a kept value reused as a variable name leaves through Status

Location: `blindfold/hooks/enroll.ts:82–94`, `:103`, `:206–207`, `:275–276`, `:294–295`.

Input: load a fabricated `.env` containing:

```dotenv
API_KEY=madeup_token_123456789
madeup_token_123456789=plain
```

What happens: the first entry feeds `madeup_token_123456789` into the known-value set. The second entry copies that same text into `NameState.name`. Both the `load` return and a subsequent `status()` expose it at `files[0].state.names[1].name`. Meanwhile, scanning that string with `knownSet()` correctly returns `[secret: API_KEY]`. A status without a `value` property is therefore not sufficient to enforce R10.

Evidence: `probe.mts` asserts the exact public field, that both serialized statuses contain the kept value, and that the detector masks the same value.

Fix: redact known values from status metadata, including names and paths, while retaining raw identifiers only in private state.

## Concurrency: R5 and R8

### F29. Medium: a pending load restores a file after forget

Location: `blindfold/hooks/enroll.ts:226–228`, `:239–240`, `:253–256`.

Input: load `.env`, start another load and pause its read, call `forget(".env")`, then release the pending read.

What happens: immediately after forget, the value is absent and the file's status is gone. Forget does not invalidate pending results, so the earlier load subsequently applies its feed and file state. The forgotten value becomes known again and the file reappears as active without a new load being requested after forget.

Evidence: `repro.ts`, case `FORGET_PENDING_LOAD`, gates execution after the read has actually begun. `known` changes from `false` after forget to `true` after the pending load finishes.

Fix: invalidate pre-forget load results for that file before deleting its bucket and status.

### F30. Medium: a late refresh can repopulate enrollment after session end

Location: `blindfold/hooks/enroll.ts:259–264`, `:304–306`.

Input: start a gated load of `.env`, call `drop()` as session end does, then let an outstanding tool operation invoke `refreshIfNamed(..., { command: "cat .env" })` before releasing the reads.

What happens: drop invalidates the original load but leaves `listed()` equal to `.env`. The late refresh starts a newer generation using that retained list and successfully restores the value and active file state after drop. This is distinct from F24 and does not require a clear or an addFile call.

Evidence: `repro.ts`, case `REFRESH_AFTER_DROP`. Immediately after drop, `known` is false and status is empty. After the late refresh, `known` is true and `.env` is active again.

Fix: clear the refresh list on drop, or gate refreshes with a session-lifetime token so callbacks from an ended session cannot start another load.

## addFile and lifecycle: R9 and R7

### F31. Medium: addFile overwrites newer list changes from a stale snapshot

Location: `blindfold/hooks/enroll.ts:320`, `:325–336`.

Input A: starting from `.env`, run `addFile("a.env")` and `addFile("b.env")` concurrently.

What happens: both return `added`, but the configuration writes are `.env,a.env` and `.env,b.env`. The final list is `.env,b.env`; the successful first addition is lost.

Input B: start `addFile("a.env")`, pause its stat, run `load(..., "replacement.env")`, then release the add.

What happens: the add persists and installs its old snapshot `.env,a.env`, discarding `replacement.env`. Status still describes `replacement.env`, while `listed()` and future refreshes use `.env,a.env`. Unlike F24, this occurs entirely inside enrollment without restarting the session.

Evidence: `repro.ts`, cases `CONCURRENT_ADDFILE` and `ADDFILE_RACES_LOAD`, assert both the captured configuration writes and the final list.

Fix: serialize additions and make their list updates revision-aware, rebasing or retrying when a load changes the list during an awaited operation.

## Tests that do not establish their named behavior

### F32. Low: the session.start test does not check that loading precedes next

Location: `blindfold/tests/smoke.test.ts:28–35`, `:63–77`.

Input: the existing session.start test fixture, but with a scratch-only hook that awaits `next(e)` before calling `load`.

What happens: all five assertions from the named test still pass. The helper records only the passed event and return value, and the test inspects enrollment only after the hook finishes. It never checks protection at the moment `next` runs. The real hook currently has the correct order, but this test would not catch its reversal.

Evidence: `probe.mts`, the scratch-only negative control, reports `events: ["next", "load"]`, `hiddenAtNext: false`, and `assertions: "5/5 pass"`. No repository hook or test was mutated.

Fix: assert inside the fake next callback that the expected value is already known, or hold the read behind a gate and assert next has not run.

## Verification and limits

`cd blindfold && claude plugin test` completed with exit 0: 579 passed, 0 failed, across four files. Scratch scripts were independently rerun with Bun and exited 0:

```sh
TMPDIR=/tmp/blindfold-enroll-review-zKBM0s bun /tmp/blindfold-enroll-review-zKBM0s/repro.ts
TMPDIR=/tmp/blindfold-enroll-review-zKBM0s bun /tmp/blindfold-enroll-review-zKBM0s/verified-real-fs.ts
TMPDIR=/tmp/blindfold-enroll-review-zKBM0s bun /tmp/blindfold-enroll-review-zKBM0s/probe.mts
```

Windows drive, drive-relative, UNC, rooted-backslash and parent-segment spellings, plus Unicode names and roots, were exercised with host fakes. No native Windows filesystem run was performed. Existing reviewed detector/parser internals were not re-audited. No production fixes or commits were made, and no files under `/var/folders/` were read.

Verdict: not ready for the next module, because confirmed root-confinement failures, a Status value leak, and state/list races remain despite the passing suite.
