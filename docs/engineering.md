# Engineering runtime

DS-Hns can drive a computer, supervise its own processes and run a bounded
execution contract. The engineering runtime is the layer above that: it takes
*"here is a repository and a goal"* and works until the goal is verified, the
episode's budget is spent, or an external condition makes continuing impossible.
This document describes what it guarantees and what it deliberately refuses to do.

## 1. What an episode is

One maintenance task is one **episode**: a bounded piece of engineering work with a
deadline, a verified progress trail and a resumable cursor. An episode knows its
workspace, its repository fingerprint, its plan and its evidence. It does not know
who asked for the work, and it remembers nothing across episodes.

```text
RECEIVE TASK → VERIFY WORKSPACE → DISCOVER REPOSITORY → READ INSTRUCTIONS
→ CAPTURE BASELINE → BUILD PLAN → EXECUTE STEP → VERIFY
→ on failure: CLASSIFY → HYPOTHESISE → REPAIR → VERIFY
→ FINAL FULL VERIFICATION → RESULT VALIDATION → COMPLETED
```

## 2. The phases

```text
INITIALIZING       establishing the workspace and the repository snapshot
DISCOVERING        reading the project, its manifests, its instructions and its CI
PLANNING           turning the goal into bounded steps
EDITING            mutating files
BUILDING           running the build
TESTING            running tests
INSPECTING_FAILURE reading a real failure
REPAIRING          changing the code because of one
VERIFYING          re-running the evidence the completion gate needs
RECOVERING         a transient fault, not a code failure
WAITING_PROCESS    an owned process is still running
WAITING_RETRY      parked until a bounded backoff expires
STALLED            repeated rounds with no new evidence
COMPLETED          criteria satisfied with fresh evidence
BLOCKED            an external condition is missing
FAILED             not completable inside this contract and budget
CANCELLED          the caller stopped it
```

The legal transitions are a closed table in `episode.cjs`. A move that is not in
it is refused, and an episode cannot leave a terminal phase: a run that ended has
to be re-issued as a new task rather than quietly re-entering the loop.

## 3. The workspace boundary

`process.cwd()` never becomes a project root by accident. The caller names a
repository; the path is canonicalised with `realpath` and then *verified* to be a
directory (and a git work tree when the contract requires one). Every file, shell,
git, build and test operation stays inside it, and the boundary is re-verified as
the episode runs.

The baseline is captured before anything changes: which branch, which commit, and
which files were **already dirty**. Those files belong to the user. The mutation
log refuses to write them, so "do not overwrite the user's work" is an enforced
rule rather than an intention.

## 4. Repository discovery

Discovery answers what kind of project this is and what commands it declares.

| Adapter | Detected by | Commands from |
| --- | --- | --- |
| Node | `package.json` plus source or test directories | `scripts`, then a declared test config |
| Python | `pyproject.toml`, `setup.py`, `requirements.txt`, `Pipfile`, `tox.ini` | the tool the manifest names (uv, poetry, pipenv, pip) |
| Rust | `Cargo.toml` | cargo |
| Go | `go.mod` | go |
| Java | `pom.xml`, `build.gradle(.kts)` | Maven or the Gradle wrapper |
| .NET | `*.sln`, `*.csproj` | dotnet |
| CMake | `CMakeLists.txt` | cmake |
| Make | `Makefile` | its own targets |
| generic | nothing recognised | only what it can infer, labelled as inferred |

The precedence for a command is fixed:

```text
Execution Contract  >  repository instructions  >  project configuration  >  runtime defaults
```

An inferred command is always recorded with the evidence that produced it. A
command the runtime cannot explain is a command nobody can trust.

## 5. Plans are bounded and ordered

An engineering task does not start by editing code. `plan.cjs` builds a plan whose
steps each finish in minutes or enter `WAITING_PROCESS`, and every step names the
evidence that would settle it.

A goal that describes a bug produces a **reproduce step first**: the failing test
is shown to fail before anything is patched. Without that, a "fix" has no
regression evidence at all.

## 6. Mutations

Every change is a mutation: a bounded set of file writes with a kind, a reason, a
before-hash, an after-hash and the step it belongs to. A write is followed by a
re-read: `writeFile` returning successfully is not evidence that the file holds
what was intended.

A mutation whose verification never happened is *re-checked* after a crash, not
replayed. A file that changed since the mutation was planned and matches neither
version is reported rather than overwritten.

## 7. Failure classification and repair

Every failure lands in one closed class, and the class decides what may happen
next:

```text
syntax compile type unit-test integration-test runtime
    → inspect the evidence, form a hypothesis, patch
timeout resource
    → the response is a bound, not a patch
dependency network
    → bounded retry with backoff, then BLOCKED
filesystem permission workspace
    → BLOCKED with context
ui transport
    → bounded reconnect, then BLOCKED
unknown
    → nothing is assumed; inspect first
```

Two rules are enforced rather than documented:

* **No blind retry.** The same command, the same failure, the same environment and
  no state change is the same attempt, and it is refused.
* **A failed hypothesis is not repeated**, and a failure may only accumulate a
  bounded number of hypotheses before the runtime broadens the investigation
  instead of guessing again.

## 8. Processes

Builds, test suites, dev servers and watchers are supervised by the same registry
the Computer Use runtime uses, so the runtime owns exactly what it started and
kills nothing else. On top of that registry:

* **readiness** is a condition — a port, an HTTP response, a stdout pattern, a file,
  an exit — never a fixed sleep;
* **liveness** is output: a process that is alive and still producing output is
  working, however long it runs, so a 45-minute suite is not a stall;
* **bounds** are a soft timeout (inspect whether it is still progressing) and a hard
  timeout (terminate the owned process);
* **evidence** is recorded either way: exit code, signal, duration and the bounded
  head/tail/error region of its output.

## 9. Verification and the completion gate

Verification runs real commands, at three levels — focused, affected, full — and
every result is timestamped. Passing evidence that predates the last mutation
proves nothing, so it is invalidated by any change.

An episode may only be reported `COMPLETED` when a *fresh* check says so:

```text
criteria          every success criterion the contract stated
tests             the required levels ran and passed after the last change
build / lint      when the contract requires them
failures          no unresolved critical failure remains
workspace         the workspace is still the one the episode was given
leaks             no owned process, watcher or resource was left behind
something ran     an episode that verified nothing is not a completed episode
```

A check that cannot be performed is a refusal, not a pass. A model saying "done" is
not evidence, and neither is code that "looks right".

## 10. Waiting, backoff and the deadline

Waiting is event-, timer- or process-driven; the runtime never busy-loops. An
episode that is waiting is *parked* with a wake reason, so it does not occupy the
active slot, and a transient failure backs off through a bounded ladder.

The deadline bands are relative to the episode's own budget, so a short episode is
not born in its final band:

```text
full        normal work, including starting a new repair round
wrap-up     finish the current safe unit; do not start a large new round
final       run the best verification available and produce the report
expired     stop
```

## 11. Checkpoints and resume

Checkpoints are bounded and written atomically, so a killed process never leaves a
half-written file that a later resume tries to read. Resuming *verifies* the world
before it continues: the workspace, the fingerprint, the pending mutations and the
processes the episode believed it owned. The verdict is `resume`, `restart` when
the world moved too far for the plan to mean anything, or `refuse` when the
workspace itself is unusable.

Resume re-checks state; it does not replay actions. A write that is already on disk
is already complete, and a `git commit` is checked by looking at `HEAD`.

## 12. Git policy

```text
allowed    status, diff, log, add (explicit paths), commit, snapshot hashes
forbidden  reset --hard, clean -fd, push --force, history rewriting,
           branch deletion, discarding the working tree
```

The forbidden commands are **not implemented** rather than checked before use:
there is no code path that can run them. Commits are off by default and require the
contract; pushes and merges require the contract as well. Staging is by explicit
path, never `add -A`, so the runtime never commits somebody else's half-finished
work.

## 13. Bounded context

A 24-hour episode cannot carry its whole history, so context has three layers:

```text
live context      the current error, file, action and plan step
recent evidence   bounded rings of verifications, decisions and process milestones
episode summary   goal, phase, completed work, blockers, files changed, remaining
```

Shell output is bounded by head + tail + the region around the first error, and a
large test suite keeps its summary, failing cases, relevant stack traces, last
lines and artifact paths. Retained bytes stop growing after the rings fill; a
thousand steps do not make the runtime larger.

## 14. Resource bounds

Screenshots, logs, retained output, evidence rings, owned processes and parked
episodes all have ceilings, and the Computer Use resource budget is the single
place they are accounted for. At a ceiling the runtime stops allocating and
degrades or blocks; it does not keep spending.

## 15. Driving it from the dock

The Mega dock carries an **Engineering** panel (`app/extensions/mega/ui/engineering-panel.js`).
Like the Computer Use panel it is a *control surface*: it names a repository and a
goal, and reads the episode's own report. It never decides a command, a path or a
git policy, and it has no filesystem or process access of its own.

```text
workspace      the repository path (verified by the runtime before anything runs)
goal           what the episode is for
deadline       minutes, capped at 24h and by config/app.json
contract       optional JSON: commands, patches, tests, require_build, …
```

The panel offers:

* **识别仓库 / describe** — shows which project the runtime detects, which commands
  it would use (with the confidence and the evidence for each), the git state, the
  instruction files it would read and the CI definitions it found. This is a
  read-only call and it starts nothing, so the commands can be reviewed before an
  episode is allowed to touch the repository.
* **开始 episode / run** — starts the episode. The call returns as soon as the
  episode is *accepted*; the panel then follows it through `engineering:status` on a
  poll. A 24-hour episode cannot be awaited by a renderer, and awaiting it would
  also stop the renderer from being able to cancel it.
* **取消 / cancel** — asks the running episode to stop. The supervisor checks for
  cancellation at every step boundary, so a cancel never lands in the middle of a
  mutation; the episode then disposes its owned processes, writes a checkpoint and
  reports `CANCELLED` with the progress it had verified.
* the phase strip, the live summary (phase, repair rounds, stall level, owned
  processes, remaining budget and deadline band) and the final report (result,
  failed checks, changed files, command exits, failures).

The IPC surface is `engineering:status`, `engineering:describe`,
`engineering:checkpoints`, `engineering:run` and `engineering:cancel`, bridged to
the renderer as `window.megaEngineering`. The shell owns the host
(`app/engineering-host.cjs`) and allows **one active episode at a time**: an episode
mutates a repository, so two of them in the same workspace would be two writers
over the same files. A second start is refused with `EPISODE_ACTIVE`.

The git policy in `config/app.json` is closed by default:

```json
"engineering": {
  "enabled": true,
  "git": { "allowCommit": false, "allowPush": false, "allowMerge": false },
  "limits": { "deadlineMs": 86400000, "maxSteps": 40, "maxRepairRounds": 6, "stepTimeoutMs": 1800000 }
}
```

A renderer cannot open those doors; only the config file or an embedding host can.

## 16. What is out of scope

```text
no application learning        nothing is remembered about an application
no user model                  no preferences, no habits
no cross-episode strategy      a summary is written, a policy is not learned
no long-term planning          the plan is short-lived and belongs to one episode
no permission widening         the contract is the boundary, not a suggestion
no invented success            an unverifiable completion is not a completion
```

The runtime executes engineering work; it does not decide what should be worked on.
