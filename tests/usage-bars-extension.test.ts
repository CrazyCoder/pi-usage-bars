import { afterEach, describe, expect, it } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import usageBarsExtension from "../extensions/usage-bars/index";

interface Harness {
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
  commands: Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>;
  emitted: Array<{ name: string; data: unknown }>;
}

function createHarness(): Harness {
  const harness: Harness = {
    handlers: new Map(),
    commands: new Map(),
    emitted: [],
  };
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      harness.handlers.set(name, handler);
    },
    registerCommand(name: string, command: Harness["commands"] extends Map<string, infer T> ? T : never) {
      harness.commands.set(name, command);
    },
    events: {
      emit(name: string, data: unknown) {
        harness.emitted.push({ name, data });
      },
    },
  } as unknown as ExtensionAPI;
  usageBarsExtension(pi);
  return harness;
}

function createContext(
  mode: "tui" | "rpc" | "json" | "print",
  provider = "openai",
  options: { configured?: boolean; source?: string; token?: string } = {},
) {
  const statuses: Array<string | undefined> = [];
  const notifications: string[] = [];
  let authCalls = 0;
  let customCalls = 0;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const context = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    model: { provider, id: "test-model" },
    ui: {
      theme,
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: (message: string) => notifications.push(message),
      custom: async () => { customCalls += 1; },
    },
    modelRegistry: {
      getProvider: () => ({}),
      getProviderAuthStatus: () => ({ configured: options.configured ?? false }),
      getProviderAuth: async () => {
        authCalls += 1;
        return options.token
          ? { auth: { apiKey: options.token }, source: options.source }
          : undefined;
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    context,
    statuses,
    notifications,
    authCalls: () => authCalls,
    customCalls: () => customCalls,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("usage-bars extension lifecycle", () => {
  it("does not poll or create timers in non-TUI modes", async () => {
    const harness = createHarness();
    const mock = createContext("print", "openai-codex", {
      configured: true,
      source: "OAuth",
      token: "token",
    });

    const result = harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, mock.context);
    expect(result).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mock.authCalls()).toBe(0);
    expect(mock.statuses).toHaveLength(0);
  });

  it("uses Pi provider auth and emits usage updates in TUI mode", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      rate_limit: {
        primary_window: { used_percent: 12 },
        secondary_window: { used_percent: 34 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const harness = createHarness();
    const mock = createContext("tui", "openai-codex", {
      configured: true,
      source: "OAuth",
      token: "resolved-by-pi",
    });
    harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, mock.context);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(mock.authCalls()).toBe(1);
    expect(harness.emitted).toContainEqual({
      name: "usage:update",
      data: expect.objectContaining({ provider: "codex", session: 12, weekly: 34 }),
    });
    expect(mock.statuses.at(-1)).toContain("Codex");

    harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, mock.context);
  });

  it("polls OpenRouter through Pi auth and emits financial usage", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      const body = url.endsWith("/credits")
        ? { data: { total_credits: 30, total_usage: 10 } }
        : { data: { limit: null, limit_remaining: null, usage_daily: 1, usage_weekly: 2, usage_monthly: 3 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const harness = createHarness();
    const mock = createContext("tui", "openrouter", {
      configured: true,
      source: "Environment variable",
      token: "resolved-by-pi",
    });
    harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, mock.context);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(mock.authCalls()).toBe(1);
    expect(harness.emitted).toContainEqual({
      name: "usage:update",
      data: expect.objectContaining({
        provider: "openrouter",
        accountBalance: { amount: 20, unit: "USD", label: "Balance" },
        accountSpend: expect.objectContaining({ monthly: 3 }),
      }),
    });
    expect(mock.statuses.at(-1)).toContain("OpenRouter");
    expect(mock.statuses.at(-1)).toContain("$20.00");

    harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, mock.context);
  });

  it("guards the custom command outside interactive TUI mode", async () => {
    const harness = createHarness();
    const mock = createContext("rpc");
    await harness.commands.get("usage")?.handler("", mock.context);
    expect(mock.customCalls()).toBe(0);
    expect(mock.notifications).toEqual(["/usage is available in interactive mode"]);
  });
});
