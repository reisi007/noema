import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B13: `/api/ai/skills` must not resolve another workspace's provider.
 *
 * The route used to resolve the provider config from a client-supplied
 * `workspaceId` without any membership check, so any signed-in account could
 * make the server call another workspace's provider with that workspace's
 * key. The route now resolves through `resolveAiConfigForUser`: the
 * workspace's own provider is used only when the caller has access to it,
 * otherwise the environment defaults apply.
 *
 * The database and the provider transport are mocked; the body validation,
 * the membership check and the config resolution run for real.
 */

const db = vi.hoisted(() => ({
  aiProviderConfig: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  workspace: { findUnique: vi.fn() },
}));
const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const guard = vi.hoisted(() => ({ rateLimit: vi.fn() }));
const ai = vi.hoisted(() => ({ chatComplete: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: auth.getCurrentUser }));
vi.mock("@/lib/api-guard", () => ({ rateLimit: guard.rateLimit }));
vi.mock("@/lib/ai-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-provider")>();
  return { ...actual, chatComplete: ai.chatComplete };
});

import { POST } from "./route";
import { encryptSecret } from "@/lib/secrets";

/** A workspace id in the shape Prisma's `cuid()` produces. */
const WORKSPACE_ID = "clx1a2b3c4d5e6f7g8h9i0jkl";

/** The provider stored for the workspace the caller does not belong to. */
function storedProvider(apiKey: string) {
  return {
    provider: "openai",
    baseUrl: "https://foreign.example/v1",
    model: "gpt-4o",
    apiKeyEncrypted: encryptSecret(apiKey),
    enabled: true,
  };
}

const ENV_KEYS = [
  "AI_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "AUTH_SECRET",
] as const;

const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

const runSkill = (body: unknown) =>
  POST(
    new Request("http://test/api/ai/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = "test-secret-that-is-long-enough-for-encryption";
  process.env.AI_API_KEY = "env-key";
  process.env.AI_BASE_URL = "https://env.example/v1";
  process.env.AI_MODEL = "env-model";
  auth.getCurrentUser.mockResolvedValue({ id: "u1" });
  guard.rateLimit.mockReturnValue(null);
  ai.chatComplete.mockResolvedValue({ ok: true, text: "MODEL OUTPUT" });
  db.aiProviderConfig.findUnique.mockResolvedValue(null);
  db.workspaceMember.findUnique.mockResolvedValue(null);
  db.workspace.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("workspace scoping of the provider config", () => {
  it("does not use the provider of a workspace the caller has no access to", async () => {
    db.workspaceMember.findUnique.mockResolvedValue(null);
    db.workspace.findUnique.mockResolvedValue({ ownerId: "someone-else" });
    db.aiProviderConfig.findUnique.mockResolvedValue(storedProvider("sk-foreign"));

    const response = await runSkill({ skillId: "proofread", text: "hi", workspaceId: WORKSPACE_ID });

    expect(response.status).toBe(200);
    const config = ai.chatComplete.mock.calls[0]?.[1] as { apiKey: string; source: string };
    expect(config.apiKey).toBe("env-key");
    expect(config.source).toBe("env");
    // The foreign provider row is never even read.
    expect(db.aiProviderConfig.findUnique).not.toHaveBeenCalled();
  });

  it("uses the workspace's own provider for a member", async () => {
    db.workspaceMember.findUnique.mockResolvedValue({ role: "MEMBER" });
    db.aiProviderConfig.findUnique.mockResolvedValue(storedProvider("sk-workspace"));

    const response = await runSkill({ skillId: "proofread", text: "hi", workspaceId: WORKSPACE_ID });

    expect(response.status).toBe(200);
    const config = ai.chatComplete.mock.calls[0]?.[1] as { apiKey: string; source: string };
    expect(config.apiKey).toBe("sk-workspace");
    expect(config.source).toBe("workspace");
  });
});

describe("authentication and validation", () => {
  it("rejects an unauthenticated request", async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    expect((await runSkill({ skillId: "proofread", text: "hi" })).status).toBe(401);
  });

  it("rejects a body that does not match the schema", async () => {
    // The workspace id format is not part of the schema's shape check — an
    // unknown id is answered by the access check. A body whose *type* does
    // not fit is refused.
    expect((await runSkill({ skillId: "proofread", text: 42 })).status).toBe(400);
    expect(ai.chatComplete).not.toHaveBeenCalled();
  });

  it("answers a workspace id it does not know with the environment config", async () => {
    db.workspaceMember.findUnique.mockResolvedValue(null);
    db.workspace.findUnique.mockResolvedValue(null);
    db.aiProviderConfig.findUnique.mockResolvedValue(storedProvider("sk-foreign"));

    const response = await runSkill({ skillId: "proofread", text: "hi", workspaceId: "not-a-cuid" });

    expect(response.status).toBe(200);
    const config = ai.chatComplete.mock.calls[0]?.[1] as { apiKey: string; source: string };
    expect(config.apiKey).toBe("env-key");
    expect(db.aiProviderConfig.findUnique).not.toHaveBeenCalled();
  });
});
