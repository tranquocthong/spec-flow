# spec-flow

**Approve one design. The agent builds it, tests it for real, and opens the PR.**

[![release](https://img.shields.io/github/v/release/tranquocthong/spec-flow)](https://github.com/tranquocthong/spec-flow/releases)
[![license](https://img.shields.io/github/license/tranquocthong/spec-flow)](LICENSE)
[![codex release](https://github.com/tranquocthong/spec-flow/actions/workflows/codex-release.yml/badge.svg)](https://github.com/tranquocthong/spec-flow/actions/workflows/codex-release.yml)

Lightweight spec-driven development for Claude Code and Codex. You read and approve one
document per feature. Tasks, code, tests, commit and PR follow from it, and nothing is called
done until a real test ran and checked something.

```
/plugin marketplace add tranquocthong/spec-flow
/plugin install sf@claude-spec-flow
```

## Why it exists

Spec-driven workflows are a good idea that usually costs too much. A small feature becomes a
roadmap entry, a discussion, a research note, a plan, a summary and a verification report: an
hour of documents before the first line of code, and sometimes more markdown than code.

spec-flow keeps the one part of a spec that pays for itself, a design a human signs off, and
drops the rest. The rule it is built on: **the process scales with the work.**

| The work | What spec-flow asks of you |
| --- | --- |
| A bug | A description. It writes a failing test first, then fixes. No design document. |
| A small change to a shipped feature | One edited row in the design. |
| A feature | One design document to read and approve. |
| An epic (more than 25 requirements) | Approve a split into sub-features, each with its own design. |

## What it looks like

```
/sf:init                          # once per repo
/sf:ingest docs/srs/refund.md     # requirements in, one design out (bare /sf:ingest interviews you instead)
                                  #   -> read .spec-flow/specs/refund/SD.md and approve it
/sf:checklist refund              # the design's test cases become runnable tests
/sf:phase refund                  # tasks -> code -> tests -> commit -> PR link
```

Back later, in any session: `/sf:status` reads the disk and prints the exact next command.

## What it is good at

**You approve once, then it drives.** After the design is approved you do not type the steps.
Each requirement is scored 1 to 10: small ones go straight to code, bigger ones are broken into
subtasks, the hardest are researched first. It pauses to show you the task list, when a test
fails, and to ask whether you want an independent review of the diff before it ships.

**"Done" means a test ran.** Each feature gets a `CHECKLIST.yaml` that the bundled runner
executes against your running service: HTTP calls, Kafka events, SQL and Redis checks on the
side effects. HTTP 200 alone is not a pass, and a test that asserted nothing is reported as
not verified, never as passed. A feature ships only when its regression run is green.

**Changes touch only what changed.** Every requirement is linked to its tests, its tasks and
the source files that implemented it. Change one requirement and exactly the tasks that built
it reopen. When product sends a new version of the requirements, spec-flow diffs it against a
frozen copy and updates only the affected parts.

**Bugs start with a failing test.** `/sf:bug` writes a reproduction test and confirms it fails
before any fix is attempted. After the fix it stays in the suite for good. It works on legacy
code that never had a design.

**It picks up where you left off.** The state lives on disk, not in the chat. Context runs out,
a new session, another machine, Claude Code to Codex and back: `/sf:status` knows the next step.

**Messy input is fine.** Requirements in prose, tables or bullets, in English or Vietnamese. An
agent turns them into atomic requirements, test cases and error codes, and marks only the
genuinely ambiguous spots for you to resolve. No task is created while one is left open.

**Nothing to run or pay for.** 12 commands, 2 agents and a zero-dependency Node CLI. No API key,
no server, no MCP, no network. Everything it writes is markdown and JSON, committed next to
your code.

## Is it for you?

**A good fit when:**

- You build backend services and APIs. The test runner speaks HTTP, Kafka, SQL, Redis and shell.
- Requirements come from someone else (a BA, a product owner, a client), and someone will ask
  later whether requirement 14 was built and how you know.
- One feature spans several service repos. One design drives the code in each, one PR per repo.
- The codebase already exists. You adopt spec-flow from today forward; it never invents a
  design for old code.

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
into a plan. spec-flow is for the other case: the spec came from someone else, you want the
feature shipped today, and you will have to show later what happened to each requirement.

| | GSD | spec-kit | BMAD-METHOD | spec-flow |
| --- | --- | --- | --- | --- |
| Documents per unit of work | one per step: context, research, plan, summary, UAT, verification | spec, plan and tasks per feature | documents across several planning roles | one design per feature; bugs need none |
| Requirements change after build | add or re-plan phases | refine the artifacts and re-run | re-enter the planning loop | diff against a snapshot; only affected tasks reopen |
| When is it done | verification and UAT documents | convergence loop | verify phase | a test ran and asserted; empty tests count as not verified |
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
- [CHANGELOG.md](CHANGELOG.md): every release, including the bugs it found and how they were
  verified.

spec-flow is in active use on real multi-repo projects and covered by 961 engine tests and 82
runner tests. Contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
