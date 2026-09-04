import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatDuration, type UsageData } from "./core";

export const DEFAULT_CENTRAL_DAILY_LIMIT_USD = 50;
export const CENTRAL_CONFIG_PATH = join(getAgentDir(), "usage-bars.json");
const CENTRAL_STATE_PATH = join(getAgentDir(), "usage-bars-central-state.json");

export interface CentralUsageOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  nowMs?: number;
  configPath?: string;
  statePath?: string;
  runLimit?: (signal?: AbortSignal) => Promise<unknown>;
}

export interface CentralLimit {
  used: number;
  limit: number;
  refillNext?: number;
  trackingId?: string;
}

export interface CentralDailyState {
  version: 1;
  date: string;
  spent: number;
  lastUsed: number;
  trackingId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function readConfig(configPath: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error(`${configPath} must contain a JSON object`);
  return value;
}

export function parseCentralLimit(value: unknown): CentralLimit {
  if (!isRecord(value)) throw new Error("invalid Central limit response");
  const used = finiteNumber(value.usedDollars);
  const limit = finiteNumber(value.maxDollars);
  const refillNext = finiteNumber(value.refillNext);
  if (used === undefined || used < 0 || limit === undefined || limit < 0) {
    if (value.managed === true) throw new Error("Central Server manages limits and exposes no usage totals");
    throw new Error("Central limit response has no usage totals");
  }
  const identity = [
    typeof value.email === "string" ? value.email : "",
    typeof value.licenseName === "string" ? value.licenseName : "",
    String(finiteNumber(value.refillLast) ?? ""),
  ].join("\0");
  const trackingId = identity === "\0\0"
    ? undefined
    : createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return {
    used,
    limit,
    ...(refillNext !== undefined && refillNext > 0 ? { refillNext } : {}),
    ...(trackingId ? { trackingId } : {}),
  };
}

function localDate(nowMs: number): string {
  const date = new Date(nowMs);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, "0"))
    .join("-");
}

export function updateCentralDailyState(
  previous: CentralDailyState | undefined,
  used: number,
  nowMs = Date.now(),
  trackingId?: string,
): CentralDailyState {
  const date = localDate(nowMs);
  if (!previous || previous.trackingId !== trackingId) {
    return { version: 1, date, spent: 0, lastUsed: used, ...(trackingId ? { trackingId } : {}) };
  }
  const delta = Math.max(0, used - previous.lastUsed);
  return {
    version: 1,
    date,
    spent: Math.round(((previous.date === date ? previous.spent : 0) + delta) * 100) / 100,
    lastUsed: used,
    ...(trackingId ? { trackingId } : {}),
  };
}

function readDailyState(path: string): CentralDailyState | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value) || value.version !== 1 || typeof value.date !== "string") return undefined;
    const spent = finiteNumber(value.spent);
    const lastUsed = finiteNumber(value.lastUsed);
    if (spent === undefined || spent < 0 || lastUsed === undefined) return undefined;
    const trackingId = typeof value.trackingId === "string" ? value.trackingId : undefined;
    return { version: 1, date: value.date, spent, lastUsed, ...(trackingId ? { trackingId } : {}) };
  } catch {
    return undefined;
  }
}

async function acquireLock(path: string, signal?: AbortSignal): Promise<() => void> {
  const deadline = Date.now() + 2_000;
  while (true) {
    signal?.throwIfAborted();
    try {
      mkdirSync(dirname(path), { recursive: true });
      const descriptor = openSync(path, "wx");
      closeSync(descriptor);
      return () => rmSync(path, { force: true });
    } catch (error) {
      const code = errorCode(error);
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 10_000) {
          rmSync(path, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for Central usage state");
      await new Promise(resolve => setTimeout(resolve, 50));
  }
}
}

async function trackDailySpend(
  used: number,
  statePath: string,
  nowMs: number,
  trackingId?: string,
  signal?: AbortSignal,
): Promise<number> {
  const release = await acquireLock(`${statePath}.lock`, signal);
  try {
    const next = updateCentralDailyState(readDailyState(statePath), used, nowMs, trackingId);
    mkdirSync(dirname(statePath), { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    renameSync(temporary, statePath);
    return next.spent;
  } finally {
    release();
  }
}

export function getCentralDailyLimit(configPath = CENTRAL_CONFIG_PATH): number {
  const value = readConfig(configPath);
  if (!("centralDailyLimitUsd" in value)) return DEFAULT_CENTRAL_DAILY_LIMIT_USD;
  const configured = finiteNumber(value.centralDailyLimitUsd);
  if (configured === undefined || configured <= 0) {
    throw new Error(`${configPath}: centralDailyLimitUsd must be greater than zero`);
  }
  return configured;
}

export function setCentralDailyLimit(limit: number, configPath = CENTRAL_CONFIG_PATH): void {
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("daily limit must be greater than zero");
  const existing = readConfig(configPath);
  mkdirSync(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...existing, centralDailyLimitUsd: limit }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, configPath);
}

function timeUntilLocalMidnight(nowMs: number): string {
  const midnight = new Date(nowMs);
  midnight.setHours(24, 0, 0, 0);
  return formatDuration(Math.max(0, midnight.getTime() - nowMs) / 1000);
}

export function buildCentralUsage(
  limit: CentralLimit,
  dailySpent: number,
  dailyLimit: number,
  nowMs = Date.now(),
): UsageData {
  return {
    session: limit.limit > 0 ? limit.used / limit.limit * 100 : 0,
    weekly: dailySpent / dailyLimit * 100,
    sessionLabel: "Monthly",
    weeklyLabel: "Today",
    sessionResetsIn: limit.refillNext
      ? formatDuration(Math.max(0, limit.refillNext - nowMs) / 1000)
      : undefined,
    weeklyResetsIn: timeUntilLocalMidnight(nowMs),
    sessionQuota: { used: limit.used, limit: limit.limit, unit: "USD", label: "Monthly" },
    weeklyQuota: { used: dailySpent, limit: dailyLimit, unit: "USD", label: "Today" },
    fetchedAt: nowMs,
  };
}

function runCentralLimit(signal?: AbortSignal, timeoutMs = 5_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("central", ["limit", "--json"], {
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => {
      child.kill();
      finish(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("central limit timed out"));
    }, timeoutMs);

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (stdout.length < 128 * 1024) stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      if (stderr.length < 16 * 1024) stderr += chunk;
    });
    child.on("error", error => finish(error));
    child.on("close", code => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(stderr.trim() || `central limit exited with code ${code}`));
        return;
      }
      try {
        finish(undefined, JSON.parse(stdout));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export async function fetchCentralUsage(options: CentralUsageOptions = {}): Promise<UsageData> {
  try {
    const nowMs = options.nowMs ?? Date.now();
    const runLimit = options.runLimit ?? (signal => runCentralLimit(signal, options.timeoutMs));
    const limit = parseCentralLimit(await runLimit(options.signal));
    const dailySpent = await trackDailySpend(
      limit.used,
      options.statePath ?? CENTRAL_STATE_PATH,
      nowMs,
      limit.trackingId,
      options.signal,
    );
    return buildCentralUsage(
      limit,
      dailySpent,
      getCentralDailyLimit(options.configPath),
      nowMs,
    );
  } catch (error) {
    const message = options.signal?.aborted
      ? "request cancelled"
      : error instanceof Error
        ? error.message
        : String(error);
    return { session: 0, weekly: 0, error: message };
  }
}
