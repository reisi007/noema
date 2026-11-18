/**
 * The public origin of the current request, for the copyable SAML SP URLs.
 *
 * Next's request-store APIs throw outside a request scope (static rendering,
 * unit tests), so the same guarded pattern the root layout uses applies here:
 * degrade to a local default instead of taking the settings page down.
 *
 * The Host / x-forwarded-host header is *input*, not trust: a proxy that
 * forwards a forged host must not be able to poison the ACS URL, the SP
 * metadata or a SAML logout redirect. The header is used only when it names a
 * configured or local origin; otherwise the configured APP_URL wins.
 */

import { headers } from "next/headers";
import { allowedOrigins } from "../../../scripts/desktop/allowed-origins.cjs";

export const DEFAULT_REQUEST_ORIGIN = "http://localhost:3000";

function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first ? first : null;
}

/** The configured public origin, which is trusted without reading a header. */
function configuredOrigin(): string | null {
  for (const value of [process.env.APP_URL, process.env.NEXT_PUBLIC_APP_URL]) {
    if (!value?.trim()) continue;
    try {
      const parsed = new URL(value.trim());
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.origin !== "null"
      ) {
        return parsed.origin;
      }
    } catch {
      // A malformed deployment URL is not trusted.
    }
  }
  return null;
}

/** Whether a forwarded host is one this deployment explicitly trusts. */
function trustedHost(host: string, proto: string): boolean {
  if (!host || /[/?#@\s]/.test(host)) return false;
  let authority: string;
  try {
    authority = new URL(`${proto}://${host}`).host;
  } catch {
    return false;
  }

  // The same local addresses Server Actions trust (loopback plus this
  // machine's own addresses), without inheriting APP_ORIGINS here — the
  // explicit entries are checked below so an absolute URL keeps its scheme.
  if (
    allowedOrigins({ env: { ...process.env, APP_ORIGINS: "" } }).some((entry) => {
      try {
        return new URL(`http://${entry}`).host === authority;
      } catch {
        return false;
      }
    })
  ) {
    return true;
  }

  for (const configured of (process.env.APP_ORIGINS ?? "").split(",")) {
    const value = configured.trim();
    if (!value) continue;
    try {
      if (/^https?:\/\//i.test(value)) {
        const parsed = new URL(value);
        if (
          (parsed.protocol === "http:" || parsed.protocol === "https:") &&
          parsed.origin === `${proto}://${authority}`
        ) {
          return true;
        }
      } else if (new URL(`http://${value}`).host === authority) {
        return true;
      }
    } catch {
      // A malformed allow-list entry is not trusted.
    }
  }
  return false;
}

export async function requestOrigin(): Promise<string> {
  const fallback = configuredOrigin() ?? DEFAULT_REQUEST_ORIGIN;
  try {
    const values = await headers();
    const host =
      firstHeaderValue(values.get("x-forwarded-host")) ??
      firstHeaderValue(values.get("host"));
    const proto =
      firstHeaderValue(values.get("x-forwarded-proto")) === "https" ? "https" : "http";
    if (host && trustedHost(host, proto)) return `${proto}://${new URL(`${proto}://${host}`).host}`;
  } catch {
    // No request scope: fall through to the configured origin.
  }
  return fallback;
}
