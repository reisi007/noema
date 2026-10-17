# AGENTS.md

Rules for work in **this fork** (`reisi007/noema`). The upstream project lives at
`upstream/noema`; anything that belongs upstream is a separate change on a
branch that tracks it, never a rewrite of the fork's own rules.

## What this fork is

A working copy of Noema used for security work and local features. The fork
carries its own `fix/b*` branches; `main` follows upstream and is merged, not
rebased.

## Gates

Regeln dieser Ebene. Was nur ein Verzeichnis betrifft, gehört in die
`AGENTS.md` **dieses** Verzeichnisses — sie wird geladen, wenn eine Datei
daraus gelesen wird.

Ein Plan in `docs/plans/` beginnt mit `**Status:** Plan | In Arbeit | Done |
Empfehlung, nicht implementiert`.

Die kanonischen Agent-Regeln laufen über `ratchet` (Preset `agent-rules`):
`ratchet check` vor jedem Commit und in der CI.

## The upstream hook

`.githooks/pre-commit` is upstream's: an authoring-window check and a secret
gate, both fail-closed. It is enabled per clone with
`git config core.hooksPath .githooks` — the repository cannot switch it on for
anyone else. The agent-rule gates run in front of it, so a commit that violates
either is refused before anything is written.
