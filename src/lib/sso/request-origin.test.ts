import { beforeEach, describe, expect, it, vi } from "vitest";

const headersMock = vi.hoisted(() => ({ get: vi.fn<(name: string) => string | null>() }));
vi.mock("next/headers", () => ({ headers: async () => headersMock }));

import { DEFAULT_REQUEST_ORIGIN, requestOrigin } from "./request-origin";

function requestHeaders(values: Record<string, string>) {
  headersMock.get.mockImplementation((name) => values[name.toLowerCase()] ?? null);
}

describe("requestOrigin", () => {
  beforeEach(() => {
    headersMock.get.mockReset();
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("APP_ORIGINS", "");
  });

  it("falls back instead of trusting an unconfigured forwarded host", async () => {
    requestHeaders({ "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" });
    expect(await requestOrigin()).toBe(DEFAULT_REQUEST_ORIGIN);
  });

  it("prefers the configured APP_URL over a poisoned header", async () => {
    vi.stubEnv("APP_URL", "https://app.example.com");
    requestHeaders({ host: "evil.example" });
    expect(await requestOrigin()).toBe("https://app.example.com");
  });

  it("accepts an explicitly configured APP_ORIGINS host", async () => {
    vi.stubEnv("APP_ORIGINS", "app.example.com");
    requestHeaders({ "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https" });
    expect(await requestOrigin()).toBe("https://app.example.com");
  });

  it("accepts this machine's loopback address", async () => {
    requestHeaders({ host: "127.0.0.1:3000" });
    expect(await requestOrigin()).toBe("http://127.0.0.1:3000");
  });

  it("rejects a host with an embedded authority", async () => {
    requestHeaders({ "x-forwarded-host": "app.example.com@evil.example" });
    expect(await requestOrigin()).toBe(DEFAULT_REQUEST_ORIGIN);
  });
});
