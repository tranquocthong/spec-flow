# spec-flow

**Your coding agent says "done". spec-flow makes it prove it.**

[![release](https://img.shields.io/github/v/release/tranquocthong/spec-flow)](https://github.com/tranquocthong/spec-flow/releases)
[![license](https://img.shields.io/github/license/tranquocthong/spec-flow)](LICENSE)
[![codex release](https://github.com/tranquocthong/spec-flow/actions/workflows/codex-release.yml/badge.svg)](https://github.com/tranquocthong/spec-flow/actions/workflows/codex-release.yml)

A spec-driven workflow plugin for Claude Code and Codex. You approve one design per feature.
The agent breaks it into tasks, writes the code, runs real tests against your running service
(HTTP, Kafka, SQL, Redis), and opens the PR. A feature is not done until a test ran and
asserted something. Every requirement stays linked to its tests, tasks and source files, so a
change or a bug touches only what it should, months later, in a fresh session.

![The API answers 202, but the CHECKLIST checks the database and fails: no delivery log was written. After the fix, the same command passes.](docs/assets/demo.gif)

*The API said 202 and the feature looked done. The CHECKLIST also checked the database, found
no delivery log, and failed it. Same command after the fix: green. This is a real bug class
from a real project, reduced to a small demo service.*

```
/plugin marketplace add tranquocthong/spec-flow
/plugin install sf@claude-spec-flow
```

## The problem it solves

Coding agents are fast. On a real project they fail in the same few ways, and spec-flow is
built around each of them.

| What goes wrong with an agent alone | What spec-flow does about it |
| --- | --- |
| "All tests pass", but the tests mocked everything, and the endpoint returns 500 against the real database. | Each feature gets a `CHECKLIST.yaml` that runs against your live service and checks the side effects in SQL, Redis and Kafka. A test that asserts nothing is reported as **not verified**, never as passed. |
| Context runs out, or you open a new session, and the agent no longer knows what was built or what comes next. | State lives on disk, committed with your code. `/sf:status` prints the exact next command in any session, on any machine, in Claude Code or Codex. |
| Requirements change, and the agent either rewrites too much or quietly misses the part that mattered. | Requirements are diffed against a frozen copy. Only the tasks linked to a changed requirement reopen. |
| A bug gets "fixed" and comes back two weeks later. | `/sf:bug` writes a failing reproduction test first, fixes, and keeps the test in the regression suite. |
| After 30 features nobody can say whether requirement FR-014 was built, or how anyone knows. | Every requirement links to its test cases, its tasks and the files that implemented it. |

## Built with spec-flow

spec-flow is not a weekend experiment. Its author has used it every day since June 2026 to
build and run real products, mostly solo. Counted from the `.spec-flow/` folders in those repos
on 2026-11-08:

| | |
| --- | --- |
| Repositories | 21 |
| Approved designs (one per feature) | 286 |
| Requirements traced to code | about 6,200 |
| Executable test cases in CHECKLISTs | about 9,400 |
| Tasks built and closed | more than 3,200 |
| Bugs fixed, each behind a reproduction test | 343 |
| Changes to already-shipped features | 278 |

The stacks: Go microservices with ConnectRPC, Node.js, Python, Java/Spring, Next.js, Flutter and
React Native, in single repos, Nx monorepos and multi-repo platforms. Some of what that looked
like:

**A self-hosted AI API gateway (Node.js), in production for months.** 38 features and 515 tasks,
built and then kept alive: 122 bugs each fixed behind a repro test, 65 changes to shipped
features, all through the same design documents.

**A dating app: Go microservices, Next.js web, Flutter mobile.** A systems audit was filed as 122
bug records, 33 of them critical, and worked off one by one. One example: NATS JetStream streams
were never created, so 7 services started, logged a warning and then received no events at all.
The fix was verified against a live NATS server (0 streams before, 11 after), not against mocks.

**An online exam platform (Go + Next.js monorepo).** 43 features, every one of them with a
recorded verification run, about 1,800 test cases. 19 of its 24 bugs were in older code that
never had a design, which `/sf:bug` handles without one. One example: the notification service
never saved a single delivery log, because every insert was rejected and the error surfaced as
`DATABASE_CONNECTION_ERROR`. The HTTP calls looked fine. A check on the database caught it.

**A city places app, built as an epic.** One requirements document was split into 22
sub-feature designs (about 1,000 requirements). The sub-features were built in parallel in 11
git worktrees, one agent session each, coordinated through the files on disk: about 200 commits
in five days.

**A payments platform (Java/Spring, more than 15 service repos).** One hub repo holds the
designs, and each design drives code in the service repos it touches, one PR per repo. 26
designs, 645 tasks, and 126 changes as product kept moving the requirements after the code
shipped.

## How it works

```
/sf:init                          # once per repo
/sf:ingest docs/srs/refund.md     # requirements in, one design out (bare /sf:ingest interviews you instead)
                                  #   -> read .spec-flow/specs/refund/SD.md and approve it
/sf:checklist refund              # the design's test cases become runnable tests
/sf:phase refund                  # tasks -> code -> tests -> commit -> PR link
```

Back later, in any session: `/sf:status` reads the disk and prints the exact next command.

**You approve once, then it drives.** After the design is approved you do not type the steps.
Each requirement is scored 1 to 10: small ones go straight to code, bigger ones are broken into
subtasks, the hardest are researched first. It pauses to show you the task list, when a test
fails, and to ask whether you want an independent review of the diff before it ships.

**"Done" means a test ran.** The bundled runner executes `CHECKLIST.yaml` against your running
service: HTTP calls, Kafka events, SQL and Redis checks on the side effects, shell steps. HTTP 200
alone is not a pass. A feature ships only when its regression run is green, and the results are
written to `VERIFICATION.md` next to the design.

**Changes touch only what changed.** Change one requirement and exactly the tasks that built it
reopen. When product sends a new version of the requirements, `/sf:resync` diffs it against the
frozen copy and updates only the affected parts of the design, the tasks and the tests.

**Messy input is fine.** Requirements in prose, tables or bullets, in English or Vietnamese. An
agent turns them into atomic requirements, test cases and error codes, and marks only the
genuinely ambiguous spots for you to resolve. No task is created while one is left open. No
requirements file at all? `/sf:ingest` interviews you and writes one.

**Your rules, enforced.** Write your team's code rules once in `project-author.md`. Every task
reports pass or violated against each rule, and an open violation is sent back to be fixed. Conventions learned
while writing designs are appended to the same committed file, so the next design starts from
them.

**Nothing to run or pay for.** 12 commands, 2 agents and a zero-dependency Node CLI. No API key,
no server, no MCP, no network. Everything it writes is markdown, YAML and JSON, committed next to
your code.

## The process scales with the work

Spec-driven workflows usually cost too much: a small feature becomes a roadmap entry, a research
note, a plan, a summary and a verification report, an hour of documents before the first line
of code. spec-flow keeps the one part that pays for itself, a design a human signs off, and
drops the rest.

| The work | What spec-flow asks of you |
| --- | --- |
| A bug | A one-line description. It writes a failing test first, then fixes. No design document. |
| A small change to a shipped feature | One edited row in the design. |
| A feature | One design document to read and approve. |
| An epic (more than 25 requirements) | Approve a split into sub-features, each with its own design. |

## Is it for you?

**A good fit when:**

- You build backend services and APIs, alone or in a small team, and you want the agent's work
  checked against the real thing.
- The project will live for months. Features get changed, bugs come in, and you need to know
  what was built and why.
- Requirements come from someone else (a client, a product owner, a BA), or you want to write
  them down once and have the agent hold to them.
- One feature spans several service repos. One design drives the code in each, one PR per repo.
- The codebase already exists. You adopt spec-flow from today forward; it never invents a design
  for old code, and `/sf:bug` works on code that never had one.

**Not the right tool when:**

- You are prototyping or exploring. Just prompt the agent.
- The feature is mostly UI and "tested" means looking at the screen. The runner checks behaviour
  through APIs, events and data, not pixels.
- You want long-horizon planning with a roadmap and milestones. GSD and BMAD-METHOD do that well.

## Which command do I run?

| You have or want | Run |
| --- | --- |
| First time in this repo | `/sf:init` |
| A new feature from a requirements file | `/sf:ingest <srs.md>` |
| Just an idea, no file | `/sf:ingest`. It interviews you and writes the requirements |
| Build the approved feature | `/sf:phase <feature>` |
| Product changed the requirements | `/sf:resync <srs_v2.md>` |
| Change or extend a shipped feature | `/sf:change "<description>"` |
| A bug, including in legacy code | `/sf:bug "<description>"` |
| A feature too big for one design | `/sf:split <srs.md>` |
| Run the tests | `/sf:manual-test <feature>` |
| Context is running out mid-task | `/sf:checkpoint`, then `/sf:status` next session |
| Where am I? Is the install healthy? | `/sf:status`, `/sf:doctor` |

## How it compares

[GSD](https://github.com/open-gsd/gsd-core), [spec-kit](https://github.com/github/spec-kit) and
[BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) are strong at turning your own idea
into a plan. spec-flow puts its weight on the other end: proving the code does what the spec
says, and keeping that true as the spec changes.

| | GSD | spec-kit | BMAD-METHOD | spec-flow |
| --- | --- | --- | --- | --- |
| Documents per unit of work | one per step: context, research, plan, summary, UAT, verification | spec, plan and tasks per feature | documents across several planning roles | one design per feature; bugs need none |
| Requirements change after build | add or re-plan phases | refine the artifacts and re-run | re-enter the planning loop | diff against a snapshot; only affected tasks reopen |
| When is it done | verification and UAT documents | convergence loop | verify phase | a test ran against the live service and asserted; empty tests count as not verified |
| Requirement to code | requirements mapped to phases | not a stated goal | not a stated goal | each requirement linked to its tests, tasks and files |

Written from each project's public documentation in September 2026. If something is wrong,
open an issue and it gets fixed.

## Install

**Claude Code**

```
/plugin marketplace add tranquocthong/spec-flow
/plugin install sf@claude-spec-flow
```

Reload Claude Code and run `/sf:doctor`. Needs Node 18 or newer, and Python 3 with PyYAML
(`pip3 install pyyaml`) for the test runner.

**Codex** gets a plugin generated from the same sources. Download `spec-flow-codex.tar.gz` from
a [release](https://github.com/tranquocthong/spec-flow/releases) and see [docs/codex.md](docs/codex.md).
A feature started in one tool continues in the other from the same files.

## Learn more

- [docs/guide.md](docs/guide.md): every flow step by step, the gates, the files it writes,
  configuration and the engine commands.
- [docs/codex.md](docs/codex.md): running under Codex.
- [CHANGELOG.md](CHANGELOG.md): every release, including the bugs real projects found and how
  they were verified.

spec-flow is covered by more than 1,200 engine tests and 89 runner tests. If it helps you, a star helps
other people find it. Issues and contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).
MIT licensed.
