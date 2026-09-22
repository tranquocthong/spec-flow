# Contributing to spec-flow

Thanks for taking the time. spec-flow is small, deliberately dependency-free, and easy to work on.

## Getting set up

```sh
git clone https://github.com/tranquocthong/spec-flow.git
cd spec-flow
git config core.hooksPath .githooks     # once — enforces the engine's per-file line ceiling
```

There is nothing to install. The engine is plain Node 18+ with zero runtime dependencies.
The manual-test runner needs Python 3 with PyYAML (`pip3 install pyyaml`).

## Running the tests

All three suites must be green before a change lands:

```sh
node --test test/*.test.cjs                                     # engine
cd skills/manual-test/scripts && python3 -m unittest checklist_lib.tests.test_checklist_lib
node scripts/build-codex.cjs && node scripts/validate-codex.cjs # Codex distribution
```

## Working on the engine

`bin/flow-tools.cjs` is the deterministic workflow engine and dispatches into `lib/`.
Two rules matter more than style here:

1. **Engine commands stay deterministic.** Anything that needs a model belongs in a command
   doc or an agent, never in `lib/`. The engine validates AI output; it never produces it.
2. **Disk is the source of truth.** `/sf:status` reconstructs everything from `.spec-flow/`.
   A result that exists only in a transcript is lost next session, so it has to land in a file.

Every file in `bin/` and `lib/` has a hard ceiling of 3000 lines, enforced by the pre-commit
hook. If a module is growing past it, that is the signal to split it, not to raise the limit.

## Good first contributions

- A stack detector for a build system `init-project` does not recognise yet.
- A language pack in `templates/lang/` so SRS harvesting understands another language.
- A manual-test runner adapter beyond the bundled HTTP, Kafka, SQL, Redis and shell ones.
- Anything in the issue tracker labelled `good first issue`.

## Pull requests

Branch off `main`, keep the change focused, and add a test that fails without it.
Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).

Add a `CHANGELOG.md` entry under `## [Unreleased]` for anything a user would notice.
The changelog is candid about what was broken and how it was verified — please keep that tone.

## Reporting a bug

Open an issue with the output of `/sf:doctor`, the command you ran, what you expected and what
happened. If it involves an SRS or SD, a reduced excerpt helps far more than a description.

## License

By contributing you agree your work is released under the [MIT License](LICENSE).
