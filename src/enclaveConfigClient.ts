/**
 * Multi-tenant enclave routing config client (smart-wallet side).
 *
 * When a request carries a `projectId`, this module fetches that
 * project's enclave routing config from the backend's
 * /internal/projects/:projectId/enclave-config endpoint and caches the
 * result in-process for 60 s to keep the hot path fast.
 *
 * When there is no `projectId`, or the backend returns 404, we return
 * null and the caller falls back to the env-based defaults
 * (`PARENT_PROXY_URL`, `PARENT_PROXY_AUTH_TOKEN`, `KMS_KEY_ARN` passed
 * per-request in the sign payload). That preserves the current single-
 * tenant Rift-hosted sandbox / prod behaviour byte-for-byte.
 *
 * Auth: the smart-wallet process holds a `INTERNAL_SERVICE_TOKEN` that
 * matches the backend's env of the same name. Backend gates the
 * /internal endpoint with it. Rotate this on the backend and here at
 * the same time (or fetch it from a shared secret store).
 */

export interface EnclaveChainConfig {
  chainId: number;
  bundlerUrl: string;
  bundlerBearer: string | null;
  rpcUrl: string;
  paymasterUrl: string | null;
}

export interface EnclaveConfig {
  projectId: string;
  parentProxyUrl: string;
  parentProxyBearer: string;
  kmsKeyArn: string;
  kmsRegion: string;
  pcr0: string;
  enclaveRef: string;
  chains: EnclaveChainConfig[];
}

interface CacheEntry {
  value: EnclaveConfig | null;
  fetchedAt: number;
}

const TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 15_000;
const cache = new Map<string, CacheEntry>();

function backendUrl(): string {
  const url = process.env.RIFT_BACKEND_URL;
  if (!url) throw new Error("RIFT_BACKEND_URL not set");
  return url.replace(/\/$/, "");
}

function internalToken(): string {
  const t = process.env.INTERNAL_SERVICE_TOKEN;
  if (!t) throw new Error("INTERNAL_SERVICE_TOKEN not set");
  return t;
}

/**
 * Resolve an enclave routing config for a project.
 *
 * Returns null when:
 *   * projectId is empty
 *   * the backend has no config row for that project (404)
 *   * the backend is unreachable and we have no valid cache
 *
 * Callers MUST treat null as "use env defaults" — that's how backward
 * compatibility with the current single-tenant Rift-hosted flow works.
 */
export async function resolveEnclaveConfig(
  projectId: string | null | undefined
): Promise<EnclaveConfig | null> {
  if (!projectId) return null;

  const cached = cache.get(projectId);
  const now = Date.now();
  if (cached) {
    const ttl = cached.value ? TTL_MS : NEGATIVE_TTL_MS;
    if (now - cached.fetchedAt < ttl) return cached.value;
  }

  let backend: string;
  let token: string;
  try {
    backend = backendUrl();
    token = internalToken();
  } catch (err: any) {
    // Env not configured for multi-tenant — return null so the caller
    // falls back to env defaults. Don't cache; env may be added later.
    console.warn(`[enclaveConfigClient] multi-tenant not configured: ${err?.message || err}`);
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(
      `${backend}/internal/projects/${encodeURIComponent(projectId)}/enclave-config`,
      {
        headers: { "x-internal-token": token },
        signal: controller.signal,
      }
    );
    if (response.status === 404) {
      cache.set(projectId, { value: null, fetchedAt: now });
      return null;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "<no body>");
      console.error(
        `[enclaveConfigClient] backend returned ${response.status} for ${projectId}: ${text}`
      );
      // Serve stale-if-error when we can, otherwise null → env fallback.
      return cached?.value ?? null;
    }
    const raw = (await response.json()) as EnclaveConfig;
    cache.set(projectId, { value: raw, fetchedAt: now });
    return raw;
  } catch (err: any) {
    console.error(
      `[enclaveConfigClient] fetch failed for ${projectId}: ${err?.message || err}`
    );
    return cached?.value ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Look up the bundler + RPC config the smart-wallet should submit
 * through for a given (projectId, chainId). Returns null when the
 * project has no override for that chain — callers fall back to the
 * env-configured Pimlico URL etc.
 */
export async function resolveChainConfig(
  projectId: string | null | undefined,
  chainId: number
): Promise<EnclaveChainConfig | null> {
  const cfg = await resolveEnclaveConfig(projectId);
  if (!cfg) return null;
  return cfg.chains.find((c) => c.chainId === chainId) ?? null;
}

/**
 * Test hook: nuke a single project's cache entry. Never called from
 * production; useful in tests and admin flows.
 */
export function invalidateCache(projectId?: string): void {
  if (projectId) cache.delete(projectId);
  else cache.clear();
}
