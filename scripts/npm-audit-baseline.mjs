/**
 * The advisories the dependency tree is allowed to carry — and the reason
 * behind every pin of the `overrides` block in `package.json`.
 *
 * Why the reason cannot live in `package.json`: the file is JSON, and npm
 * refuses a comment in it (measured on npm 12.2.0 — a commented
 * `package.json` fails with `EJSONPARSE`: "package.json must be actual
 * JSON, not just JavaScript"). The pin and its reason therefore live in two
 * files, and this is the second half.
 *
 * What the gate does with this list: `scripts/check-npm-audit.mjs` runs
 * `npm audit --audit-level=high --json` and compares the report with it.
 *
 *   · An advisory that is **not** in the list is a finding and fails the
 *     build. That is what catches a *new* advisory — the reason this gate
 *     exists at all.
 *   · An entry that the audit **no longer** reports is a finding as well.
 *     The list may only shrink: when upstream ships the fix, the entry has
 *     to be deleted here in the same change that removes the advisory.
 *
 * The `overrides` block in `package.json`, entry by entry:
 *
 *   · `deepmerge-ts` `^8.0.0` — pinned in d3da779 ("pin patched deps"). It
 *     is the merge helper `prisma`'s CLI pulls in, and that CLI runs in
 *     `postinstall` (`prisma generate`), so it is code that runs on every
 *     install. The audit of 2026-10-21 reports no advisory for it.
 *
 *   · `postcss` `^8.5.18` — pinned in the same commit. It is the CSS
 *     transformer `next` builds with. The audit of 2026-10-21 reports no
 *     advisory for it.
 *
 *   · `argparse` `^2.0.1` — **added with this gate.** `argparse` is the
 *     command-line parser `mammoth` uses, and `mammoth` is a direct
 *     dependency: it converts the `.docx` files a user uploads. The version
 *     `mammoth` asks for (`~1.0.3`, resolved to 1.0.10) pulls `sprintf-js`
 *     1.0.3, which carries GHSA-hp3w-g68c-fv3c (moderate — a denial of
 *     service through unbounded precision specifiers). That advisory has
 *     **no patched version**: `sprintf-js` 1.1.3 is the latest release on the
 *     registry and is still affected, so pinning `sprintf-js` cannot lift the
 *     tree out of it. The only way out of the chain is `argparse` itself:
 *     2.0.1 is outside the affected range (`1.0.0 - 1.0.10`) and has no
 *     dependency on `sprintf-js` at all, so the whole `argparse` →
 *     `sprintf-js` chain leaves the tree.
 *
 *     Does the higher version fit? `argparse` 2.0.1 is what `js-yaml`
 *     already resolves to in this tree, so the version is in the tree
 *     anyway; the pin only removes the second, older copy. Its API did
 *     change — 2.x is a port of Python's argparse (`add_argument` /
 *     `parse_args` instead of `addArgument` / `parseArgs`) — but it keeps
 *     the old names as aliases, so the one caller of the old API in the
 *     tree, `mammoth`'s own command-line wrapper `mammoth/bin/mammoth`,
 *     still runs (measured on npm 12.2.0 / node 26.10.0: the CLI converts a
 *     .docx and exits 0, and prints seven `DeprecationWarning` lines on
 *     stderr). The library API this application uses
 *     (`mammoth.convertToMarkdown`, in `src/server/actions/import.ts`) never
 *     touches `argparse` at all: `mammoth/lib` does not require it (measured
 *     — the only `require("argparse")` in the package is in `bin/mammoth`).
 */

/**
 * @typedef {object} AcceptedAdvisory
 * @property {string} id       The advisory id (the GHSA id, as npm prints it
 *                             in the report's `url`).
 * @property {string} package  The package the advisory is about.
 * @property {string} severity The severity npm reports (`high`, …).
 * @property {string} reason   Why the advisory is accepted for now.
 */

/**
 * Accepted on 2026-11-18. Two pre-existing advisories are present in the
 * lockfile and cannot be lifted in this ratchet-migration maintenance change:
 *
 *   · GHSA-238p-pmpm-9mq7 (`katex`, low) — prototype pollution that can bypass
 *     trust restrictions. The affected copy is the nested `katex` under
 *     `mermaid` (the direct `^0.18.10` dependency already resolves outside the
 *     affected `>=0.11.0 <0.18.2` range). Clearing it needs the semver-major
 *     bump `mermaid` 11 → 12, which is out of scope here.
 *
 *   · GHSA-g3hv-75wg-m249 (`minimatch`, moderate) — denial of service via
 *     globparts amplification. The affected copy is nested under
 *     `@typescript-eslint/typescript-estree`, i.e. dev-only ESLint tooling, not
 *     part of the shipped application. A patched `minimatch` 11.0.1 exists, but
 *     it is pulled through a range pinned by the `@typescript-eslint` toolchain;
 *     overriding a third-party pin is left to that chain / dependabot.
 *
 * A new advisory still fails the gate; a fixed one makes the entry stale and it
 * has to be deleted from this list in the same change that removes the advisory.
 *
 * @type {AcceptedAdvisory[]}
 */
export const ACCEPTED_ADVISORIES = [
  {
    id: "GHSA-238p-pmpm-9mq7",
    package: "katex",
    severity: "low",
    reason:
      "affected copy is mermaid's nested katex; the direct katex ^0.18.10 dependency already resolves outside the vulnerable range. Fixing it needs the semver-major mermaid 11 -> 12 bump, out of scope in this maintenance change.",
  },
  {
    id: "GHSA-g3hv-75wg-m249",
    package: "minimatch",
    severity: "moderate",
    reason:
      "dev-only transitive dependency of the @typescript-eslint toolchain (nested under typescript-estree), not part of the shipped app. A patched 11.0.1 exists but sits behind a third-party pinned range; lifting it is left to that chain / dependabot rather than this maintenance change.",
  },
];
