import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type ProviderKey = "codex" | "claude" | "zai" | "gemini" | "antigravity";
export type OAuthProviderId = "openai-codex" | "anthropic" | "google-gemini-cli" | "google-antigravity";

export interface AuthData {
  "openai-codex"?: { access?: string; refresh?: string; expires?: number };
  anthropic?: { access?: string; refresh?: string; expires?: number };
  zai?: { key?: string; access?: string; refresh?: string; expires?: number };
  "google-gemini-cli"?: { access?: string; refresh?: string; projectId?: string; expires?: number };
  "google-antigravity"?: { access?: string; refresh?: string; projectId?: string; expires?: number };
}

export interface UsageData {
  session: number;
  weekly: number;
  sessionResetsIn?: string;
  weeklyResetsIn?: string;
  sessionResetsAt?: string;
  weeklyResetsAt?: string;
  extraSpend?: number;
  extraLimit?: number;
  warning?: string;
  stale?: boolean;
  fetchedAt?: number;
  error?: string;
}

export type UsageByProvider = Record<ProviderKey, UsageData | null>;

export interface UsageEndpoints {
  zai: string;
  gemini: string;
  antigravity: string;
  googleLoadCodeAssistEndpoints: string[];
}

export interface HeadersLike {
  get(name: string): string | null;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers?: HeadersLike;
  json(): Promise<any>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponseLike>;

export interface RequestConfig {
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export interface FetchConfig extends RequestConfig {
  endpoints?: UsageEndpoints;
  env?: NodeJS.ProcessEnv;
}

export interface OAuthApiKeyResult {
  newCredentials: Record<string, any>;
  apiKey: string;
}

export type OAuthApiKeyResolver = (
  providerId: OAuthProviderId,
  credentials: Record<string, Record<string, any>>,
) => Promise<OAuthApiKeyResult | null>;

export interface EnsureFreshAuthConfig {
  auth?: AuthData | null;
  authFile?: string;
  oauthResolver?: OAuthApiKeyResolver;
  nowMs?: number;
  persist?: boolean;
  forceRefreshProviders?: OAuthProviderId[];
}

export interface FreshAuthResult {
  auth: AuthData | null;
  changed: boolean;
  refreshErrors: Partial<Record<OAuthProviderId, string>>;
}

export interface FetchAllUsagesConfig extends FetchConfig, EnsureFreshAuthConfig {
  auth?: AuthData | null;
  authFile?: string;
  cacheFile?: string;
}

export interface ClaudeUsageFetchConfig extends RequestConfig, EnsureFreshAuthConfig {
  auth?: AuthData | null;
  authFile?: string;
  cacheFile?: string;
}

export interface ClaudeUsageFetchResult {
  usage: UsageData;
  auth: AuthData | null;
  changed: boolean;
}

interface JsonRequestSuccess {
  ok: true;
  data: any;
  status: number;
  headers?: HeadersLike;
}

interface JsonRequestError {
  ok: false;
  error: string;
  status: number | null;
  headers?: HeadersLike;
}

type JsonRequestResult = JsonRequestSuccess | JsonRequestError;

interface ClaudeUsageAttemptResult {
  usage: UsageData;
  status: number | null;
  retryAfterMs: number | null;
}

interface ClaudeUsageCacheState {
  lastSuccess?: UsageData;
  lastSuccessAt?: number;
  cooldownUntil?: number;
  consecutive429s?: number;
  lastError?: string;
}

interface UsageBarsCacheFile {
  version: 1;
  claude?: ClaudeUsageCacheState;
}

const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const CLAUDE_SHARED_FRESH_TTL_MS = 2 * 60 * 1000;
const CLAUDE_BASE_BACKOFF_MS = 2 * 60 * 1000;
const CLAUDE_MAX_BACKOFF_MS = 30 * 60 * 1000;
const CLAUDE_LOCK_WAIT_MS = 4_000;
const CLAUDE_LOCK_POLL_MS = 125;
const CLAUDE_LOCK_STALE_MS = 20_000;

export const DEFAULT_AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");
export const DEFAULT_USAGE_CACHE_FILE = path.join(os.tmpdir(), "pi", "usage-bars-cache.json");
export const DEFAULT_ZAI_USAGE_ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";
export const GOOGLE_QUOTA_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
export const GOOGLE_LOAD_CODE_ASSIST_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
];

export function resolveUsageEndpoints(env: NodeJS.ProcessEnv = process.env): UsageEndpoints {
  const configured = (value: string | undefined, fallback: string) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : fallback;
  };

  return {
    zai: configured(env.PI_ZAI_USAGE_ENDPOINT, DEFAULT_ZAI_USAGE_ENDPOINT),
    gemini: configured(env.PI_GEMINI_USAGE_ENDPOINT, GOOGLE_QUOTA_ENDPOINT),
    antigravity: configured(env.PI_ANTIGRAVITY_USAGE_ENDPOINT, GOOGLE_QUOTA_ENDPOINT),
    googleLoadCodeAssistEndpoints: GOOGLE_LOAD_CODE_ASSIST_ENDPOINTS,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "request timeout";
    return error.message || String(error);
  }
  return String(error);
}

function asObject(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, any>;
}

function normalizeUsagePair(session: number, weekly: number): { session: number; weekly: number } {
  const clean = (v: number) => {
    if (!Number.isFinite(v)) return 0;
    return Number(v.toFixed(2));
  };
  return { session: clean(session), weekly: clean(weekly) };
}

function getHeader(headers: HeadersLike | undefined, name: string): string | null {
  if (!headers) return null;
  try {
    return headers.get(name);
  } catch {
    return null;
  }
}

async function requestJson(url: string, init: RequestInit, config: RequestConfig = {}): Promise<JsonRequestResult> {
  const fetchFn = config.fetchFn ?? ((fetch as unknown) as FetchLike);
  const timeoutMs = config.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}`, status: response.status, headers: response.headers };
    }

    try {
      const data = await response.json();
      return { ok: true, data, status: response.status, headers: response.headers };
    } catch {
      return { ok: false, error: "invalid JSON response", status: response.status, headers: response.headers };
    }
  } catch (error) {
    return { ok: false, error: toErrorMessage(error), status: null };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0 && h > 0) return `${d}d ${h}h`;
  if (d > 0) return `${d}d`;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

export function formatResetsAt(isoDate: string, nowMs = Date.now()): string {
  const resetTime = new Date(isoDate).getTime();
  if (!Number.isFinite(resetTime)) return "";
  const diffSeconds = Math.max(0, (resetTime - nowMs) / 1000);
  return formatDuration(diffSeconds);
}

export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | null {
  if (!value) return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric * 1000;
  }

  const dateMs = new Date(value).getTime();
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

export function readAuth(authFile = DEFAULT_AUTH_FILE): AuthData | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile, "utf-8"));
    return asObject(parsed) as AuthData;
  } catch {
    return null;
  }
}

export function writeAuth(auth: AuthData, authFile = DEFAULT_AUTH_FILE): boolean {
  try {
    const dir = path.dirname(authFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${authFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(auth, null, 2));
    fs.renameSync(tmpPath, authFile);
    return true;
  } catch {
    return false;
  }
}

function readUsageCache(cacheFile = DEFAULT_USAGE_CACHE_FILE): UsageBarsCacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    if (parsed?.version === 1 && typeof parsed === "object") {
      return parsed as UsageBarsCacheFile;
    }
  } catch {
    // Ignore invalid or missing cache.
  }
  return { version: 1 };
}

function writeUsageCache(cache: UsageBarsCacheFile, cacheFile = DEFAULT_USAGE_CACHE_FILE): boolean {
  try {
    const dir = path.dirname(cacheFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${cacheFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2));
    fs.renameSync(tmpPath, cacheFile);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureParentDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeUnlink(filePath: string) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore races.
  }
}

async function acquireFileLock(lockFile: string): Promise<(() => void) | null> {
  ensureParentDir(lockFile);
  const startedAt = Date.now();

  while (Date.now() - startedAt <= CLAUDE_LOCK_WAIT_MS) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      fs.closeSync(fd);
      return () => safeUnlink(lockFile);
    } catch (error: any) {
      if (error?.code !== "EEXIST") return null;

      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs >= CLAUDE_LOCK_STALE_MS) {
          safeUnlink(lockFile);
          continue;
        }
      } catch {
        continue;
      }

      await sleep(CLAUDE_LOCK_POLL_MS);
    }
  }

  return null;
}

let cachedOAuthResolver: OAuthApiKeyResolver | null = null;

async function getDefaultOAuthResolver(): Promise<OAuthApiKeyResolver> {
  if (cachedOAuthResolver) return cachedOAuthResolver;

  const mod = await import("@earendil-works/pi-ai/oauth");
  if (typeof (mod as any).getOAuthApiKey !== "function") {
    throw new Error("oauth resolver unavailable");
  }

  cachedOAuthResolver = (providerId, credentials) =>
    (mod as any).getOAuthApiKey(providerId, credentials) as Promise<OAuthApiKeyResult | null>;

  return cachedOAuthResolver;
}

function isCredentialExpired(creds: { expires?: number } | undefined, nowMs: number): boolean {
  if (!creds) return false;
  if (typeof creds.expires !== "number") return false;
  return nowMs + TOKEN_REFRESH_SKEW_MS >= creds.expires;
}

export async function ensureFreshAuthForProviders(
  providerIds: OAuthProviderId[],
  config: EnsureFreshAuthConfig = {},
): Promise<FreshAuthResult> {
  const authFile = config.authFile ?? DEFAULT_AUTH_FILE;
  const auth = config.auth ?? readAuth(authFile);
  if (!auth) {
    return { auth: null, changed: false, refreshErrors: {} };
  }

  const nowMs = config.nowMs ?? Date.now();
  const uniqueProviders = Array.from(new Set(providerIds));
  const forcedProviders = new Set(config.forceRefreshProviders ?? []);
  const nextAuth: AuthData = { ...auth };
  const refreshErrors: Partial<Record<OAuthProviderId, string>> = {};

  let changed = false;

  for (const providerId of uniqueProviders) {
    const creds = (nextAuth as any)[providerId] as { access?: string; refresh?: string; expires?: number } | undefined;
    if (!creds?.refresh) continue;

    const needsRefresh = forcedProviders.has(providerId) || !creds.access || isCredentialExpired(creds, nowMs);
    if (!needsRefresh) continue;

    try {
      const resolver = config.oauthResolver ?? (await getDefaultOAuthResolver());
      const resolved = await resolver(providerId, nextAuth as any);
      if (!resolved?.newCredentials) {
        refreshErrors[providerId] = "missing OAuth credentials";
        continue;
      }

      (nextAuth as any)[providerId] = {
        ...(nextAuth as any)[providerId],
        ...resolved.newCredentials,
      };
      changed = true;
    } catch (error) {
      refreshErrors[providerId] = toErrorMessage(error);
    }
  }

  if (changed && config.persist !== false) {
    writeAuth(nextAuth, authFile);
  }

  return { auth: nextAuth, changed, refreshErrors };
}

export function readPercentCandidate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;

  if (value >= 0 && value <= 1) {
    if (Number.isInteger(value)) return value;
    return value * 100;
  }

  if (value >= 0 && value <= 100) return value;
  return null;
}

export function readLimitPercent(limit: any): number | null {
  const direct = [
    limit?.percentage,
    limit?.utilization,
    limit?.used_percent,
    limit?.usedPercent,
    limit?.usagePercent,
    limit?.usage_percent,
  ]
    .map(readPercentCandidate)
    .find((v) => v != null);

  if (direct != null) return direct;

  const current = typeof limit?.currentValue === "number" ? limit.currentValue : null;
  const remaining = typeof limit?.remaining === "number" ? limit.remaining : null;

  if (current != null && remaining != null && current + remaining > 0) {
    return (current / (current + remaining)) * 100;
  }

  return null;
}

export function extractUsageFromPayload(data: any): { session: number; weekly: number } | null {
  const limitArrays = [data?.data?.limits, data?.limits, data?.quota?.limits, data?.data?.quota?.limits];
  const limits = limitArrays.find((arr) => Array.isArray(arr)) as any[] | undefined;

  if (limits) {
    const byType = (types: string[]) =>
      limits.find((l) => {
        const t = String(l?.type || "").toUpperCase();
        return types.some((x) => t === x);
      });

    const sessionLimit = byType(["TIME_LIMIT", "SESSION_LIMIT", "REQUEST_LIMIT", "RPM_LIMIT", "RPD_LIMIT"]);
    const weeklyLimit = byType(["TOKENS_LIMIT", "TOKEN_LIMIT", "WEEK_LIMIT", "WEEKLY_LIMIT", "TPM_LIMIT", "DAILY_LIMIT"]);

    const s = readLimitPercent(sessionLimit);
    const w = readLimitPercent(weeklyLimit);
    if (s != null && w != null) return normalizeUsagePair(s, w);
  }

  const sessionCandidates = [
    data?.session,
    data?.sessionPercent,
    data?.session_percent,
    data?.five_hour?.utilization,
    data?.rate_limit?.primary_window?.used_percent,
    data?.limits?.session?.utilization,
    data?.usage?.session,
    data?.data?.session,
    data?.data?.sessionPercent,
    data?.data?.session_percent,
    data?.data?.usage?.session,
    data?.quota?.session?.percentage,
    data?.data?.quota?.session?.percentage,
  ];

  const weeklyCandidates = [
    data?.weekly,
    data?.weeklyPercent,
    data?.weekly_percent,
    data?.seven_day?.utilization,
    data?.rate_limit?.secondary_window?.used_percent,
    data?.limits?.weekly?.utilization,
    data?.usage?.weekly,
    data?.data?.weekly,
    data?.data?.weeklyPercent,
    data?.data?.weekly_percent,
    data?.data?.usage?.weekly,
    data?.quota?.weekly?.percentage,
    data?.data?.quota?.weekly?.percentage,
    data?.quota?.daily?.percentage,
    data?.data?.quota?.daily?.percentage,
  ];

  const session = sessionCandidates.map(readPercentCandidate).find((v) => v != null);
  const weekly = weeklyCandidates.map(readPercentCandidate).find((v) => v != null);

  if (session == null || weekly == null) return null;
  return normalizeUsagePair(session, weekly);
}

export function googleMetadata(projectId?: string) {
  return {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
    ...(projectId ? { duetProject: projectId } : {}),
  };
}

export function googleHeaders(token: string, projectId?: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "X-Goog-Api-Client": "gl-node/22.17.0",
    "Client-Metadata": JSON.stringify(googleMetadata(projectId)),
  };
}

export async function discoverGoogleProjectId(token: string, config: FetchConfig = {}): Promise<string | undefined> {
  const env = config.env ?? process.env;
  const envProjectId = env.GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT_ID;
  if (envProjectId) return envProjectId;

  const endpoints = config.endpoints ?? resolveUsageEndpoints(env);

  for (const endpoint of endpoints.googleLoadCodeAssistEndpoints) {
    const result = await requestJson(
      endpoint,
      {
        method: "POST",
        headers: googleHeaders(token),
        body: JSON.stringify({ metadata: googleMetadata() }),
      },
      config,
    );

    if (!result.ok) continue;

    const data = result.data;
    if (typeof data?.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
      return data.cloudaicompanionProject;
    }
    if (data?.cloudaicompanionProject && typeof data.cloudaicompanionProject === "object") {
      const id = data.cloudaicompanionProject.id;
      if (typeof id === "string" && id) return id;
    }
  }

  return undefined;
}

export function usedPercentFromRemainingFraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const remaining = Math.max(0, Math.min(1, value));
  return (1 - remaining) * 100;
}

export function pickMostUsedBucket(buckets: any[]): any | null {
  let best: any | null = null;
  let bestUsed = -1;
  for (const bucket of buckets) {
    const used = usedPercentFromRemainingFraction(bucket?.remainingFraction);
    if (used == null) continue;
    if (used > bestUsed) {
      bestUsed = used;
      best = bucket;
    }
  }
  return best;
}

export function parseGoogleQuotaBuckets(data: any, provider: "gemini" | "antigravity"): { session: number; weekly: number } | null {
  const allBuckets = Array.isArray(data?.buckets) ? data.buckets : [];
  if (!allBuckets.length) return null;

  const requestBuckets = allBuckets.filter((b: any) => String(b?.tokenType || "").toUpperCase() === "REQUESTS");
  const buckets = requestBuckets.length ? requestBuckets : allBuckets;

  const modelId = (b: any) => String(b?.modelId || "").toLowerCase();
  const claudeNonThinking = buckets.filter((b: any) => modelId(b).includes("claude") && !modelId(b).includes("thinking"));
  const geminiPro = buckets.filter((b: any) => modelId(b).includes("gemini") && modelId(b).includes("pro"));
  const geminiFlash = buckets.filter((b: any) => modelId(b).includes("gemini") && modelId(b).includes("flash"));

  const primaryBucket =
    provider === "antigravity"
      ? pickMostUsedBucket(claudeNonThinking) || pickMostUsedBucket(geminiPro) || pickMostUsedBucket(geminiFlash) || pickMostUsedBucket(buckets)
      : pickMostUsedBucket(geminiPro) || pickMostUsedBucket(geminiFlash) || pickMostUsedBucket(buckets);

  const secondaryBucket = pickMostUsedBucket(geminiFlash) || pickMostUsedBucket(geminiPro) || pickMostUsedBucket(buckets);

  const session = usedPercentFromRemainingFraction(primaryBucket?.remainingFraction);
  const weekly = usedPercentFromRemainingFraction(secondaryBucket?.remainingFraction);

  if (session == null || weekly == null) return null;
  return normalizeUsagePair(session, weekly);
}

function hydrateUsageResets(usage: UsageData, nowMs = Date.now()): UsageData {
  return {
    ...usage,
    sessionResetsIn: usage.sessionResetsAt ? formatResetsAt(usage.sessionResetsAt, nowMs) : usage.sessionResetsIn,
    weeklyResetsIn: usage.weeklyResetsAt ? formatResetsAt(usage.weeklyResetsAt, nowMs) : usage.weeklyResetsIn,
  };
}

function snapshotUsage(usage: UsageData, nowMs = Date.now()): UsageData {
  return {
    session: usage.session,
    weekly: usage.weekly,
    sessionResetsAt: usage.sessionResetsAt,
    weeklyResetsAt: usage.weeklyResetsAt,
    sessionResetsIn: usage.sessionResetsIn,
    weeklyResetsIn: usage.weeklyResetsIn,
    extraSpend: usage.extraSpend,
    extraLimit: usage.extraLimit,
    fetchedAt: usage.fetchedAt ?? nowMs,
  };
}

function staleCachedUsage(cached: UsageData, warning: string, nowMs = Date.now()): UsageData {
  return {
    ...hydrateUsageResets(snapshotUsage(cached, nowMs), nowMs),
    stale: true,
    warning,
  };
}

function readClaudeCacheState(cacheFile = DEFAULT_USAGE_CACHE_FILE): ClaudeUsageCacheState {
  return readUsageCache(cacheFile).claude ?? {};
}

function writeClaudeCacheState(state: ClaudeUsageCacheState, cacheFile = DEFAULT_USAGE_CACHE_FILE): boolean {
  const cache = readUsageCache(cacheFile);
  cache.claude = state;
  return writeUsageCache(cache, cacheFile);
}

function clearClaudeCooldown(state: ClaudeUsageCacheState): ClaudeUsageCacheState {
  return {
    ...state,
    cooldownUntil: undefined,
    consecutive429s: 0,
    lastError: undefined,
  };
}

function computeClaudeBackoffMs(state: ClaudeUsageCacheState, retryAfterMs: number | null): number {
  if (retryAfterMs != null && retryAfterMs > 0) {
    return Math.min(CLAUDE_MAX_BACKOFF_MS, Math.max(CLAUDE_BASE_BACKOFF_MS, retryAfterMs));
  }

  const consecutive429s = Math.max(1, state.consecutive429s ?? 0);
  const exponential = CLAUDE_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, consecutive429s - 1));
  return Math.min(CLAUDE_MAX_BACKOFF_MS, exponential);
}

function cooldownMessage(untilMs: number, nowMs = Date.now()): string {
  return `rate limited; retry in ${formatDuration(Math.max(0, untilMs - nowMs) / 1000)}`;
}

function readClaudeCacheOutcome(cacheFile = DEFAULT_USAGE_CACHE_FILE, nowMs = Date.now()): UsageData | null {
  const state = readClaudeCacheState(cacheFile);

  if (state.cooldownUntil && state.cooldownUntil > nowMs) {
    const warning = cooldownMessage(state.cooldownUntil, nowMs);
    if (state.lastSuccess) return staleCachedUsage(state.lastSuccess, warning, nowMs);
    return { session: 0, weekly: 0, error: warning };
  }

  if (state.lastSuccess && state.lastSuccessAt && nowMs - state.lastSuccessAt <= CLAUDE_SHARED_FRESH_TTL_MS) {
    return hydrateUsageResets(snapshotUsage(state.lastSuccess, state.lastSuccessAt), nowMs);
  }

  return null;
}

export async function fetchCodexUsage(token: string, config: RequestConfig = {}): Promise<UsageData> {
  const result = await requestJson(
    "https://chatgpt.com/backend-api/wham/usage",
    { headers: { Authorization: `Bearer ${token}` } },
    config,
  );

  if (!result.ok) return { session: 0, weekly: 0, error: result.error };

  const primary = result.data?.rate_limit?.primary_window;
  const secondary = result.data?.rate_limit?.secondary_window;

  return {
    session: readPercentCandidate(primary?.used_percent) ?? 0,
    weekly: readPercentCandidate(secondary?.used_percent) ?? 0,
    sessionResetsIn: typeof primary?.reset_after_seconds === "number" ? formatDuration(primary.reset_after_seconds) : undefined,
    weeklyResetsIn: typeof secondary?.reset_after_seconds === "number" ? formatDuration(secondary.reset_after_seconds) : undefined,
  };
}

async function fetchClaudeUsageAttempt(
  token: string,
  config: RequestConfig = {},
  nowMs = Date.now(),
): Promise<ClaudeUsageAttemptResult> {
  const result = await requestJson(
    "https://api.anthropic.com/api/oauth/usage",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    config,
  );

  const retryAfterMs = parseRetryAfterMs(getHeader(result.headers, "retry-after"), nowMs);

  if (!result.ok) {
    return {
      usage: { session: 0, weekly: 0, error: result.error },
      status: result.status,
      retryAfterMs,
    };
  }

  const data = result.data;
  const usage: UsageData = hydrateUsageResets(
    {
      session: readPercentCandidate(data?.five_hour?.utilization) ?? 0,
      weekly: readPercentCandidate(data?.seven_day?.utilization) ?? 0,
      sessionResetsAt: typeof data?.five_hour?.resets_at === "string" ? data.five_hour.resets_at : undefined,
      weeklyResetsAt: typeof data?.seven_day?.resets_at === "string" ? data.seven_day.resets_at : undefined,
      fetchedAt: nowMs,
    },
    nowMs,
  );

  if (data?.extra_usage?.is_enabled) {
    usage.extraSpend = typeof data.extra_usage.used_credits === "number" ? data.extra_usage.used_credits : undefined;
    usage.extraLimit = typeof data.extra_usage.monthly_limit === "number" ? data.extra_usage.monthly_limit : undefined;
  }

  return { usage, status: result.status, retryAfterMs };
}

export async function fetchClaudeUsage(token: string, config: RequestConfig = {}): Promise<UsageData> {
  return (await fetchClaudeUsageAttempt(token, config)).usage;
}

export async function fetchClaudeUsageWithFallback(
  config: ClaudeUsageFetchConfig = {},
): Promise<ClaudeUsageFetchResult> {
  const authFile = config.authFile ?? DEFAULT_AUTH_FILE;
  const cacheFile = config.cacheFile ?? DEFAULT_USAGE_CACHE_FILE;
  const lockFile = `${cacheFile}.claude.lock`;
  const nowMs = config.nowMs ?? Date.now();

  let auth = config.auth ?? readAuth(authFile);
  if (!auth) {
    return {
      auth: null,
      changed: false,
      usage: { session: 0, weekly: 0, error: "missing access token (try /login again)" },
    };
  }

  let changed = false;
  const initialRefresh = await ensureFreshAuthForProviders(["anthropic"], {
    ...config,
    auth,
    authFile,
    nowMs,
  });
  auth = initialRefresh.auth ?? auth;
  changed = initialRefresh.changed;

  const initialRefreshError = initialRefresh.refreshErrors.anthropic;
  if (initialRefreshError) {
    return {
      auth,
      changed,
      usage: { session: 0, weekly: 0, error: `auth refresh failed (${initialRefreshError})` },
    };
  }

  const cachedOutcome = readClaudeCacheOutcome(cacheFile, nowMs);
  if (cachedOutcome) {
    return { auth, changed, usage: cachedOutcome };
  }

  const token = auth.anthropic?.access;
  if (!token) {
    return {
      auth,
      changed,
      usage: { session: 0, weekly: 0, error: "missing access token (try /login again)" },
    };
  }

  const releaseLock = await acquireFileLock(lockFile);
  if (!releaseLock) {
    const waitedOutcome = readClaudeCacheOutcome(cacheFile, nowMs);
    if (waitedOutcome) return { auth, changed, usage: waitedOutcome };
  }

  try {
    const lockOutcome = readClaudeCacheOutcome(cacheFile, nowMs);
    if (lockOutcome) return { auth, changed, usage: lockOutcome };

    let state = readClaudeCacheState(cacheFile);
    let attempt = await fetchClaudeUsageAttempt(token, config, nowMs);
    let refreshError: string | undefined;

    if (attempt.status === 429 && auth.anthropic?.refresh) {
      const forcedRefresh = await ensureFreshAuthForProviders(["anthropic"], {
        ...config,
        auth,
        authFile,
        nowMs,
        forceRefreshProviders: ["anthropic"],
      });

      auth = forcedRefresh.auth ?? auth;
      changed = changed || forcedRefresh.changed;
      refreshError = forcedRefresh.refreshErrors.anthropic;

      if (!refreshError && auth.anthropic?.access) {
        attempt = await fetchClaudeUsageAttempt(auth.anthropic.access, config, nowMs);
      }
    }

    if (!attempt.usage.error) {
      state = clearClaudeCooldown(state);
      state.lastSuccess = snapshotUsage(attempt.usage, nowMs);
      state.lastSuccessAt = nowMs;
      writeClaudeCacheState(state, cacheFile);
      return { auth, changed, usage: attempt.usage };
    }

    if (attempt.status === 429) {
      const consecutive429s = Math.max(1, (state.consecutive429s ?? 0) + 1);
      const backoffMs = computeClaudeBackoffMs({ ...state, consecutive429s }, attempt.retryAfterMs);
      const cooldownUntil = nowMs + backoffMs;
      const details = refreshError ? `; auth refresh failed (${refreshError})` : "";

      state = {
        ...state,
        cooldownUntil,
        consecutive429s,
        lastError: `${attempt.usage.error}${details}`,
      };
      writeClaudeCacheState(state, cacheFile);

      if (state.lastSuccess) {
        return {
          auth,
          changed,
          usage: staleCachedUsage(state.lastSuccess, `${cooldownMessage(cooldownUntil, nowMs)}${details}`, nowMs),
        };
      }

      return {
        auth,
        changed,
        usage: {
          session: 0,
          weekly: 0,
          error: `${attempt.usage.error}; ${cooldownMessage(cooldownUntil, nowMs)}${details}`,
        },
      };
    }

    return { auth, changed, usage: attempt.usage };
  } finally {
    releaseLock?.();
  }
}

/**
 * Parse z.ai-specific response where both session and weekly are TOKENS_LIMIT
 * entries differentiated by the `unit` field:
 *   unit 3 = 5-hour rolling window (session)
 *   unit 6 = 7-day rolling window (weekly)
 *   unit 5 = monthly web search quota (ignored for usage bars)
 *
 * Credit: Arthur Bodera (@Thinkscape)
 */
export function extractZaiUsageFromPayload(data: any, nowMs = Date.now()): UsageData | null {
  const limitsArrays = [data?.data?.limits, data?.limits, data?.quota?.limits, data?.data?.quota?.limits];
  const limits = limitsArrays.find((arr) => Array.isArray(arr)) as any[] | undefined;
  if (!limits?.length) return null;

  const tokensLimits = limits.filter((l: any) => String(l?.type || "").toUpperCase() === "TOKENS_LIMIT");

  // unit 3 = 5-hour session window
  const sessionEntry = tokensLimits.find((l: any) => l?.unit === 3);
  // unit 6 = 7-day weekly window
  const weeklyEntry = tokensLimits.find((l: any) => l?.unit === 6);

  if (!sessionEntry || !weeklyEntry) return null;

  const sessionPct = readPercentCandidate(sessionEntry.percentage);
  const weeklyPct = readPercentCandidate(weeklyEntry.percentage);

  if (sessionPct == null || weeklyPct == null) return null;

  const parsed = normalizeUsagePair(sessionPct, weeklyPct);

  const sessionReset = typeof sessionEntry.nextResetTime === "number" && sessionEntry.nextResetTime > 0
    ? formatDuration(Math.max(0, (sessionEntry.nextResetTime - nowMs) / 1000))
    : undefined;
  const weeklyReset = typeof weeklyEntry.nextResetTime === "number" && weeklyEntry.nextResetTime > 0
    ? formatDuration(Math.max(0, (weeklyEntry.nextResetTime - nowMs) / 1000))
    : undefined;

  return {
    session: parsed.session,
    weekly: parsed.weekly,
    sessionResetsIn: sessionReset,
    weeklyResetsIn: weeklyReset,
  };
}

export async function fetchZaiUsage(token: string, config: FetchConfig = {}): Promise<UsageData> {
  const endpoint = (config.endpoints ?? resolveUsageEndpoints(config.env)).zai;
  if (!endpoint) return { session: 0, weekly: 0, error: "configure PI_ZAI_USAGE_ENDPOINT" };

  const result = await requestJson(
    endpoint,
    { headers: { Authorization: `Bearer ${token}` } },
    config,
  );

  if (!result.ok) return { session: 0, weekly: 0, error: result.error };

  // Try z.ai-specific parser first (handles TOKENS_LIMIT with unit field)
  const zaiParsed = extractZaiUsageFromPayload(result.data);
  if (zaiParsed) return zaiParsed;

  // Fallback to generic parser
  const parsed = extractUsageFromPayload(result.data);
  if (!parsed) return { session: 0, weekly: 0, error: "unrecognized response shape" };
  return parsed;
}

export async function fetchGoogleUsage(
  token: string,
  endpoint: string,
  projectId: string | undefined,
  provider: "gemini" | "antigravity",
  config: FetchConfig = {},
): Promise<UsageData> {
  if (!endpoint) return { session: 0, weekly: 0, error: "configure endpoint" };

  const discoveredProjectId = projectId || (await discoverGoogleProjectId(token, config));
  if (!discoveredProjectId) {
    return { session: 0, weekly: 0, error: "missing projectId (try /login again)" };
  }

  const result = await requestJson(
    endpoint,
    {
      method: "POST",
      headers: googleHeaders(token, discoveredProjectId),
      body: JSON.stringify({ project: discoveredProjectId }),
    },
    config,
  );

  if (!result.ok) return { session: 0, weekly: 0, error: result.error };

  const quota = parseGoogleQuotaBuckets(result.data, provider);
  if (quota) return quota;

  const parsed = extractUsageFromPayload(result.data);
  if (!parsed) return { session: 0, weekly: 0, error: "unrecognized response shape" };
  return parsed;
}

export function detectProvider(
  model: { provider?: string; id?: string; name?: string; api?: string } | string | undefined | null,
): ProviderKey | null {
  if (!model) return null;
  if (typeof model === "string") return null;

  const provider = (model.provider || "").toLowerCase();

  if (provider === "openai-codex") return "codex";
  if (provider === "anthropic") return "claude";
  if (provider === "zai") return "zai";
  if (provider === "google-gemini-cli") return "gemini";
  if (provider === "google-antigravity") return "antigravity";

  return null;
}

export function providerToOAuthProviderId(active: ProviderKey | null): OAuthProviderId | null {
  if (active === "codex") return "openai-codex";
  if (active === "claude") return "anthropic";
  if (active === "gemini") return "google-gemini-cli";
  if (active === "antigravity") return "google-antigravity";
  return null;
}

export function canShowForProvider(active: ProviderKey | null, auth: AuthData | null, endpoints: UsageEndpoints): boolean {
  if (!active || !auth) return false;
  if (active === "codex") return !!(auth["openai-codex"]?.access || auth["openai-codex"]?.refresh);
  if (active === "claude") return !!(auth.anthropic?.access || auth.anthropic?.refresh);
  if (active === "zai") return !!(auth.zai?.access || auth.zai?.key) && !!endpoints.zai;
  if (active === "gemini") {
    return !!(auth["google-gemini-cli"]?.access || auth["google-gemini-cli"]?.refresh) && !!endpoints.gemini;
  }
  if (active === "antigravity") {
    return !!(auth["google-antigravity"]?.access || auth["google-antigravity"]?.refresh) && !!endpoints.antigravity;
  }
  return false;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function colorForPercent(value: number): "success" | "warning" | "error" {
  if (value >= 90) return "error";
  if (value >= 70) return "warning";
  return "success";
}

export async function fetchAllUsages(config: FetchAllUsagesConfig = {}): Promise<UsageByProvider> {
  const authFile = config.authFile ?? DEFAULT_AUTH_FILE;
  const auth = config.auth ?? readAuth(authFile);
  const endpoints = config.endpoints ?? resolveUsageEndpoints(config.env);

  const results: UsageByProvider = {
    codex: null,
    claude: null,
    zai: null,
    gemini: null,
    antigravity: null,
  };

  if (!auth) return results;

  const oauthProviders: OAuthProviderId[] = [
    "openai-codex",
    "anthropic",
    "google-gemini-cli",
    "google-antigravity",
  ];

  const refreshed = await ensureFreshAuthForProviders(oauthProviders, {
    ...config,
    auth,
    authFile,
  });

  const authData = refreshed.auth ?? auth;

  const refreshError = (providerId: OAuthProviderId): string | null => {
    const error = refreshed.refreshErrors[providerId];
    return error ? `auth refresh failed (${error})` : null;
  };

  const tasks: Promise<void>[] = [];
  const assign = (provider: ProviderKey, task: Promise<UsageData>) => {
    tasks.push(
      task
        .then((usage) => {
          results[provider] = usage;
        })
        .catch((error) => {
          results[provider] = { session: 0, weekly: 0, error: toErrorMessage(error) };
        }),
    );
  };

  if (authData["openai-codex"]?.access) {
    const err = refreshError("openai-codex");
    if (err) results.codex = { session: 0, weekly: 0, error: err };
    else assign("codex", fetchCodexUsage(authData["openai-codex"].access, config));
  }

  if (authData.anthropic?.access || authData.anthropic?.refresh) {
    const err = refreshError("anthropic");
    if (err) {
      results.claude = { session: 0, weekly: 0, error: err };
    } else {
      assign(
        "claude",
        fetchClaudeUsageWithFallback({
          ...config,
          auth: authData,
          authFile,
        }).then((result) => result.usage),
      );
    }
  }

  if (authData.zai?.access || authData.zai?.key) {
    assign("zai", fetchZaiUsage(authData.zai.access || authData.zai.key!, { ...config, endpoints }));
  }

  if (authData["google-gemini-cli"]?.access) {
    const err = refreshError("google-gemini-cli");
    if (err) {
      results.gemini = { session: 0, weekly: 0, error: err };
    } else {
      const creds = authData["google-gemini-cli"];
      assign(
        "gemini",
        fetchGoogleUsage(creds.access!, endpoints.gemini, creds.projectId, "gemini", { ...config, endpoints }),
      );
    }
  }

  if (authData["google-antigravity"]?.access) {
    const err = refreshError("google-antigravity");
    if (err) {
      results.antigravity = { session: 0, weekly: 0, error: err };
    } else {
      const creds = authData["google-antigravity"];
      assign(
        "antigravity",
        fetchGoogleUsage(creds.access!, endpoints.antigravity, creds.projectId, "antigravity", { ...config, endpoints }),
      );
    }
  }

  await Promise.all(tasks);
  return results;
}
