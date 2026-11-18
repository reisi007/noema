// B34 — the secret gate (scripts/check-secrets.mjs).
//
// The gate has two halves, and both are pinned here:
//
//   1. The **tree** scan. A live key pasted into a fixture is published like
//      any other file, so the test files are scanned with the rest of the
//      tree. The skip that exempted them wholesale is gone; the fake values
//      the fixtures need are exempted by *value* instead — and only where the
//      value is a fixture, so the same literal in a source file is reported.
//   2. The **history** scan. A credential that was committed and later
//      removed is still in the published history — the commit is the
//      publication, not the current tree — so the gate walks the blobs of the
//      ref under review.
//
// A gate is only as good as the holes it is pinned against, so the cases
// below are the shapes that matter: the exploit of the finding (a key in a
// test file), the leak that cannot be undone (a key that was removed again),
// and the cases that have to stay green — a documented example and a fixture
// literal are not credentials.
//
// The gate runs over a throwaway repository via its --root option.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("./check-secrets.mjs", import.meta.url));

/**
 * A key in the shape a provider issues.
 *
 * The literal is assembled at runtime: the gate scans this file as well, and
 * a committed key-shaped literal would be a finding of its own — the very
 * thing the gate is there to report.
 */
const LIVE_KEY = ["sk-live", "REALKEY1234567890"].join("-");

/** A fixture literal of the test suites — exempt in a test file, nowhere else. */
const FIXTURE_KEY = "sk-live-abcdef1234567890";

/** A documented example — exempt everywhere. */
const DOCUMENTED_KEY = "sk-example-0000000000000000";

/**
 * Run the gate over a throwaway repository.
 *
 * `commits` is one file set per commit: the files the commit holds, and a
 * `null` source for a file the commit removes. The gate is run twice — once
 * over the tree, once with `--history` — and both answers are returned, so a
 * case can hold that the tree is green while the history is not.
 */
function gateOver(commits) {
  const dir = mkdtempSync(join(tmpdir(), "noema-secrets-"));
  try {
    const git = (...args) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.name", "Tester");
    git("config", "user.email", "tester@example.com");
    for (const files of commits) {
      for (const [name, source] of Object.entries(files)) {
        const path = join(dir, name);
        if (source === null) {
          rmSync(path, { force: true });
          continue;
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, source, "utf8");
      }
      git("add", "-A");
      git("commit", "--quiet", "--allow-empty", "-m", "probe");
    }

    return { tree: runRoot(dir, []), history: runRoot(dir, ["--history"]) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runRoot(dir, args) {
  return runGate(["--root", dir, ...args]);
}

function runGate(args, cwd = process.cwd()) {
  try {
    const output = execFileSync("node", [GATE, ...args], {
      cwd, encoding: "utf8", stdio: "pipe",
    });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** The gate has to report the value, and name where it is. */
function assertReported(result, expected) {
  assert.equal(result.code, 1, `the gate must fail\n${result.output}`);
  for (const needle of expected) {
    assert.ok(result.output.includes(needle), `the gate must name "${needle}"\n${result.output}`);
  }
}

/** The gate has to stay green. */
function assertAccepted(result) {
  assert.equal(result.code, 0, `the gate must stay green\n${result.output}`);
}

const CASES = [
  {
    name: "a live key in a test file is reported",
    commits: [{ "src/lib/example.test.ts": `const API_KEY = "${LIVE_KEY}";\n` }],
    reported: ["src/lib/example.test.ts:1", "OpenAI / DeepSeek key"],
  },
  {
    name: "a live key in a source file is reported",
    commits: [{ "src/lib/example.ts": `const API_KEY = "${LIVE_KEY}";\n` }],
    reported: ["src/lib/example.ts:1", "OpenAI / DeepSeek key"],
  },
  {
    name: "a documented example stays green",
    commits: [{ "src/lib/example.ts": `const API_KEY = "${DOCUMENTED_KEY}";\n` }],
    accepted: true,
  },
  {
    name: "a fixture literal in a test file stays green",
    commits: [{ "src/lib/example.test.ts": `const API_KEY = "${FIXTURE_KEY}";\n` }],
    accepted: true,
  },
  {
    name: "the same fixture literal outside a test file is reported",
    commits: [{ "src/lib/example.ts": `const API_KEY = "${FIXTURE_KEY}";\n` }],
    reported: ["src/lib/example.ts:1", "OpenAI / DeepSeek key"],
  },
  {
    name: "a credential that was committed and removed again is reported by the history scan",
    commits: [
      { "src/lib/leaked.ts": `const API_KEY = "${LIVE_KEY}";\n` },
      { "src/lib/leaked.ts": null },
    ],
    // The tree is clean again — the file is gone. The history is not: the
    // commit is the publication, and the value is still in it.
    treeGreen: true,
    historyReported: ["src/lib/leaked.ts:1", "OpenAI / DeepSeek key"],
  },
  {
    name: "the history scan stays green on a clean repository",
    commits: [{ "src/lib/example.test.ts": `const API_KEY = "${FIXTURE_KEY}";\n` }],
    treeGreen: true,
    historyGreen: true,
  },
];

function runCase(testCase) {
  const result = gateOver(testCase.commits);
  if (testCase.reported) assertReported(result.tree, testCase.reported);
  if (testCase.accepted) assertAccepted(result.tree);
  if (testCase.treeGreen) assertAccepted(result.tree);
  if (testCase.historyReported) assertReported(result.history, testCase.historyReported);
  if (testCase.historyGreen) assertAccepted(result.history);
}


if (process.env.VITEST) {
  const { describe, it, expect, beforeEach, afterEach } = await import("vitest");
  describe("the secret gate (B34)", () => {
    for (const testCase of CASES) {
      // Each case builds a temporary repository and runs the gate over it.
      // That is a handful of subprocesses; under a full parallel suite the
      // default 5 s is not enough on a loaded Windows machine.
      it(testCase.name, () => runCase(testCase), 30_000);
    }
    it("rejects a missing --root value", () => {
      const result = runGate(["--root"]);
      assert.equal(result.code, 2);
      assert.match(result.output, /--root requires exactly one directory path/);
    });
    it("rejects an option in place of the --root value", () => {
      const result = runGate(["--root", "--history"]);
      assert.equal(result.code, 2);
      assert.match(result.output, /--root requires exactly one directory path/);
    });
    it("rejects a non-Git root", () => {
      const dir = mkdtempSync(join(tmpdir(), "noema-secrets-not-git-"));
      try {
        const result = runGate(["--root", dir]);
        assert.equal(result.code, 2);
        assert.match(result.output, /root is not a git repository/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    it("rejects duplicate --root options", () => {
      const result = runGate(["--root", process.cwd(), "--root", process.cwd()]);
      assert.equal(result.code, 2);
      assert.match(result.output, /--root requires exactly one directory path/);
    });
    it("rejects unsupported options", () => {
      const result = runGate(["--unsupported"]);
      assert.equal(result.code, 2);
      assert.match(result.output, /unknown option --unsupported/);
    });
    it("uses the script's repository as the default root", () => {
      const result = runGate([], tmpdir());
      assert.notEqual(result.code, 2, result.output);
      assert.match(result.output, /secret gate — \d+ tracked file\(s\) scanned/);
    });
    it("does not interpret the --root value as a Git ref", () => {
      const dir = mkdtempSync(join(tmpdir(), "noema-secrets-root-ref-"));
      try {
        const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
        git("init", "--quiet", "--initial-branch=main");
        git("config", "user.name", "Tester");
        git("config", "user.email", "tester@example.com");
        writeFileSync(join(dir, "clean.txt"), "clean\n");
        git("add", "clean.txt");
        git("commit", "--quiet", "-m", "clean");
        assertAccepted(runGate(["--root", dir, "--history"]));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });


  let repo;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "noema-secrets-"));
    const git = (...args) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
    git("init", "--quiet", "--initial-branch=main");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function gateFor(files) {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(repo, name), content);
    }
    execFileSync("git", ["add", "--all"], { cwd: repo, encoding: "utf8", stdio: "pipe" });
    try {
      const output = execFileSync("node", [GATE, "--root", repo], {
        encoding: "utf8",
        stdio: "pipe",
      });
      return { code: 0, output };
    } catch (error) {
      return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  }

  const joined = (...parts) => parts.join("");
  const hex = (bytes) => randomBytes(bytes).toString("hex");
  const THIS_FILE = fileURLToPath(new URL("./check-secrets.test.mjs", import.meta.url));

describe("the secret gate (B61)", () => {
  it("flags a connection string that carries a password", () => {
    const url = joined("postgresql://user:", hex(12), "@db:5432/noema");
    const { code, output } = gateFor({ "config.txt": `DATABASE_URL="${url}"\n` });
    expect(code, output).toBe(1);
    expect(output).toContain("config.txt:1");
    expect(output).toContain("connection string with password");
  });

  it("flags a connection string whose password carries a colon or a slash", () => {
    // The password of a URL runs up to the **last** `@` — it may contain a
    // colon and a slash, and a rule that stops at the first one misses the
    // credential.
    for (const password of ["pa:ss", "pa/ss", "pa:ss/word"]) {
      const url = joined("postgresql://user:", password, "@host/db");
      const { code, output } = gateFor({ "url.txt": `${url}\n` });
      expect(code, output).toBe(1);
      expect(output).toContain("url.txt:1");
      expect(output).toContain("connection string with password");
    }
  });

  it("flags a JSON Web Token", () => {
    const token = [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ sub: "1234567890" })).toString("base64url"),
      randomBytes(32).toString("base64url"),
    ].join(".");
    const { code, output } = gateFor({ "session.txt": `token = ${token}\n` });
    expect(code, output).toBe(1);
    expect(output).toContain("session.txt:1");
    expect(output).toContain("JSON Web Token");
  });

  it("flags an AWS secret access key", () => {
    const key = randomBytes(30).toString("base64");
    const { code, output } = gateFor({
      "aws.txt": `aws_secret_access_key = "${key}"\n`,
    });
    expect(code, output).toBe(1);
    expect(output).toContain("aws.txt:1");
    expect(output).toContain("AWS secret access key");
  });

  it("flags the provider tokens", () => {
    const tokens = {
      "npm token": joined("npm_", hex(18)),
      "GitHub token": joined("ghs_", hex(18)),
      "GitLab token": joined("glpat-", hex(12)),
      "Anthropic key": joined("sk-ant-api03-", hex(24)),
      "Slack app token": joined("xapp-1-", hex(12)),
      "Doppler token": joined("dop_v1_", hex(12)),
      "GitHub fine-grained token": joined("github_pat_", hex(20)),
      "Slack token": joined("xoxb-", hex(12)),
      "Google API key": joined("AIza", hex(30)),
      "OpenAI / DeepSeek key": joined("sk-", hex(24)),
      // The access key id is **upper case** (the pattern wants it) — the
      // secret key next to it is base64.
      "AWS access key id": joined("AKIA", hex(8).toUpperCase()),
    };
    for (const [pattern, value] of Object.entries(tokens)) {
      const { code, output } = gateFor({ "token.txt": `${value}\n` });
      expect(code, output).toBe(1);
      expect(output, pattern).toContain("token.txt:1");
      expect(output, pattern).toContain(pattern);
    }
  });

  it("flags a PGP private key block", () => {
    const block = joined("-----BEGIN PGP ", "PRIVATE KEY BLOCK-----");
    const { code, output } = gateFor({ "key.txt": `${block}\n` });
    expect(code, output).toBe(1);
    expect(output).toContain("key.txt:1");
    expect(output).toContain("private key block");
  });

  it("flags a password value that carries no digit", () => {
    const line = joined("password=", '"supersecretpassword"');
    const { code, output } = gateFor({ "pw.txt": `${line}\n` });
    expect(code, output).toBe(1);
    expect(output).toContain("pw.txt:1");
    expect(output).toContain("password value");
  });

  it("does not flag a connection string without a password", () => {
    const line = 'DATABASE_URL="postgresql://db:5432/app"';
    const { code, output } = gateFor({ "config.txt": `${line}\n` });
    expect(code, output).toBe(0);
    expect(output).toContain("0 finding(s)");
  });

  it("flags the placeholder of the repository everywhere but in .env.example", () => {
    // The literal is **assembled** here: the gate scans every tracked file of
    // the repository, and this file is tracked — a literal that looks like a
    // secret in the **source** would be found by the gate (and by the case
    // below). The parts are therefore separate strings; the value is the same.
    //
    // The placeholder is **not** allowed any more: since B55 it is no valid
    // `AUTH_SECRET`, so a copy of it outside `.env.example` is a finding.
    const line = 'AUTH_SECRET="' + "replace-me-with-a-32-" + "byte-hex-" + 'secret"';
    const { code, output } = gateFor({ "config.txt": `${line}\n` });
    expect(code, output).toBe(1);
    expect(output).toContain("configured secret value");
  });

  it("does not flag a call that produces the secret", () => {
    const line = "process.env.AUTH_SECRET = ensureAuthSecret();";
    const { code, output } = gateFor({ "config.txt": `${line}\n` });
    expect(code, output).toBe(0);
    expect(output).toContain("0 finding(s)");
  });

  it("does not flag a certificate", () => {
    const line = "-----BEGIN CERTIFICATE-----";
    const { code, output } = gateFor({ "cert.txt": `${line}\n` });
    expect(code, output).toBe(0);
    expect(output).toContain("0 finding(s)");
  });

  it("keeps this file free of credential-shaped literals", () => {
    const { code, output } = gateFor({
      "check-secrets.test.mjs": readFileSync(THIS_FILE, "utf8"),
    });
    expect(code, output).toBe(0);
    expect(output).toContain("0 finding(s)");
  });
});

} else {
  let failed = 0;
  for (const testCase of CASES) {
    try {
      runCase(testCase);
      console.log(`ok — ${testCase.name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok — ${testCase.name}\n  ${error.message}`);
    }
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} case(s) passed`);
  if (failed > 0) process.exit(1);
}
