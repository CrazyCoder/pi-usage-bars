/**
 * Usage Extension - Minimal API usage indicator for pi
 *
 * Shows Codex (OpenAI), Anthropic (Claude), Z.AI, and optionally
 * Google Gemini CLI / Antigravity usage as color-coded percentages
 * in the footer status bar.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Spacer,
  Text,
  type Focusable,
} from "@earendil-works/pi-tui";
import {
  canShowForProvider,
  clampPercent,
  colorForPercent,
  detectProvider,
  fetchAllUsages,
  fetchClaudeUsageWithFallback,
  fetchCodexUsage,
  fetchGoogleUsage,
  fetchZaiUsage,
  ensureFreshAuthForProviders,
  providerToOAuthProviderId,
  readAuth,
  resolveUsageEndpoints,
  type ProviderKey,
  type UsageByProvider,
  type UsageData,
} from "./core";

const POLL_INTERVAL_MS = 2 * 60 * 1000;
const STATUS_KEY = "usage-bars";

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  codex: "Codex",
  claude: "Claude",
  zai: "Z.AI",
  gemini: "Gemini",
  antigravity: "Antigravity",
};

interface SubscriptionItem {
  name: string;
  provider: ProviderKey;
  data: UsageData | null;
  isActive: boolean;
}

class UsageSelectorComponent extends Container implements Focusable {
  private searchInput: Input;
  private listContainer: Container;
  private hintText: Text;
  private tui: any;
  private theme: any;
  private keybindings: any;
  private onCancelCallback: () => void;
  private allItems: SubscriptionItem[] = [];
  private filteredItems: SubscriptionItem[] = [];
  private selectedIndex = 0;
  private loading = true;
  private activeProvider: ProviderKey | null;
  private fetchAllFn: () => Promise<UsageByProvider>;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    tui: any,
    theme: any,
    activeProvider: ProviderKey | null,
    fetchAll: () => Promise<UsageByProvider>,
    onCancel: () => void,
    keybindings: any,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.activeProvider = activeProvider;
    this.fetchAllFn = fetchAll;
    this.onCancelCallback = onCancel;
    this.keybindings = keybindings;

    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    this.addChild(new Spacer(1));

    this.hintText = new Text(theme.fg("dim", "Fetching usage from all providers…"), 0, 0);
    this.addChild(this.hintText);
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    this.fetchAllFn()
      .then((results) => {
        this.loading = false;
        this.buildItems(results);
        this.updateList();
        this.hintText.setText(
          theme.fg("muted", "Only showing providers with credentials. ") +
            theme.fg("dim", "✓ = active provider"),
        );
        this.tui.requestRender();
      })
      .catch(() => {
        this.loading = false;
        this.hintText.setText(theme.fg("error", "Failed to fetch usage data"));
        this.tui.requestRender();
      });

    this.updateList();
  }

  private buildItems(results: UsageByProvider) {
    const providers: Array<{ key: ProviderKey; name: string }> = [
      { key: "codex", name: "Codex" },
      { key: "claude", name: "Claude" },
      { key: "zai", name: "Z.AI" },
      { key: "gemini", name: "Gemini" },
      { key: "antigravity", name: "Antigravity" },
    ];

    this.allItems = [];
    for (const p of providers) {
      if (results[p.key] !== null) {
        this.allItems.push({
          name: p.name,
          provider: p.key,
          data: results[p.key],
          isActive: this.activeProvider === p.key,
        });
      }
    }

    this.filteredItems = this.allItems;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
  }

  private filterItems(query: string) {
    if (!query) {
      this.filteredItems = this.allItems;
    } else {
      const q = query.toLowerCase();
      this.filteredItems = this.allItems.filter(
        (item) => item.name.toLowerCase().includes(q) || item.provider.toLowerCase().includes(q),
      );
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
  }

  private renderBar(pct: number, width = 16): string {
    const value = clampPercent(pct);
    const filled = Math.round((value / 100) * width);
    const color = colorForPercent(value);
    const full = "█".repeat(Math.max(0, filled));
    const empty = "░".repeat(Math.max(0, width - filled));
    return this.theme.fg(color, full) + this.theme.fg("dim", empty);
  }

  private renderItem(item: SubscriptionItem, isSelected: boolean) {
    const t = this.theme;
    const pointer = isSelected ? t.fg("accent", "→ ") : "  ";
    const activeBadge = item.isActive ? t.fg("success", " ✓") : "";
    const name = isSelected ? t.fg("accent", t.bold(item.name)) : item.name;

    this.listContainer.addChild(new Text(`${pointer}${name}${activeBadge}`, 0, 0));

    const indent = "    ";

    if (!item.data) {
      this.listContainer.addChild(new Text(indent + t.fg("dim", "No credentials"), 0, 0));
    } else if (item.data.error) {
      this.listContainer.addChild(new Text(indent + t.fg("error", item.data.error), 0, 0));
    } else {
      const session = clampPercent(item.data.session);
      const weekly = clampPercent(item.data.weekly);

      const sessionReset = item.data.sessionResetsIn
        ? t.fg("dim", `  resets in ${item.data.sessionResetsIn}`)
        : "";
      const weeklyReset = item.data.weeklyResetsIn
        ? t.fg("dim", `  resets in ${item.data.weeklyResetsIn}`)
        : "";

      this.listContainer.addChild(
        new Text(
          indent +
            t.fg("muted", "Session  ") +
            this.renderBar(session) +
            " " +
            t.fg(colorForPercent(session), `${session}%`.padStart(4)) +
            sessionReset,
          0,
          0,
        ),
      );

      this.listContainer.addChild(
        new Text(
          indent +
            t.fg("muted", "Weekly   ") +
            this.renderBar(weekly) +
            " " +
            t.fg(colorForPercent(weekly), `${weekly}%`.padStart(4)) +
            weeklyReset,
          0,
          0,
        ),
      );

      if (typeof item.data.extraSpend === "number" && typeof item.data.extraLimit === "number") {
        this.listContainer.addChild(
          new Text(
            indent +
              t.fg("muted", "Extra    ") +
              t.fg("dim", `$${item.data.extraSpend.toFixed(2)} / $${item.data.extraLimit}`),
            0,
            0,
          ),
        );
      }

      if (item.data.warning) {
        this.listContainer.addChild(new Text(indent + t.fg("warning", `⚠ ${item.data.warning}`), 0, 0));
      }
    }

    this.listContainer.addChild(new Spacer(1));
  }

  private updateList() {
    this.listContainer.clear();

    if (this.loading) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  Loading…"), 0, 0));
      return;
    }

    if (this.filteredItems.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching providers"), 0, 0));
      return;
    }

    for (let i = 0; i < this.filteredItems.length; i++) {
      this.renderItem(this.filteredItems[i]!, i === this.selectedIndex);
    }
  }

  handleInput(keyData: string): void {
    if (this.keybindings.matches(keyData, "tui.select.up")) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
      this.updateList();
      return;
    }

    if (this.keybindings.matches(keyData, "tui.select.down")) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
      return;
    }

    if (this.keybindings.matches(keyData, "tui.select.cancel") || this.keybindings.matches(keyData, "tui.select.confirm")) {
      this.onCancelCallback();
      return;
    }

    this.searchInput.handleInput(keyData);
    this.filterItems(this.searchInput.getValue());
    this.updateList();
  }
}

interface UsageState extends UsageByProvider {
  lastPoll: number;
  activeProvider: ProviderKey | null;
}

export default function (pi: ExtensionAPI) {
  const endpoints = resolveUsageEndpoints();
  const state: UsageState = {
    codex: null,
    claude: null,
    zai: null,
    gemini: null,
    antigravity: null,
    lastPoll: 0,
    activeProvider: null,
  };

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight: Promise<void> | null = null;
  let pollQueued = false;
  let ctx: any = null;

  function renderPercent(theme: any, value: number): string {
    const v = clampPercent(value);
    return theme.fg(colorForPercent(v), `${v}%`);
  }

  function renderBar(theme: any, value: number): string {
    const v = clampPercent(value);
    const width = 8;
    const filled = Math.round((v / 100) * width);
    const full = "█".repeat(Math.max(0, Math.min(width, filled)));
    const empty = "░".repeat(Math.max(0, width - filled));
    return theme.fg(colorForPercent(v), full) + theme.fg("dim", empty);
  }

  function pickDataForProvider(provider: ProviderKey | null): UsageData | null {
    if (!provider) return null;
    return state[provider];
  }

  function updateStatus() {
    const active = state.activeProvider;
    const data = pickDataForProvider(active);

    if (data && !data.error) {
      pi.events.emit("usage:update", {
        session: data.session,
        weekly: data.weekly,
        sessionResetsIn: data.sessionResetsIn,
        weeklyResetsIn: data.weeklyResetsIn,
      });
    }

    if (!ctx?.hasUI) return;

    if (!active) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const auth = readAuth();
    if (!canShowForProvider(active, auth, endpoints)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const theme = ctx.ui.theme;
    const label = PROVIDER_LABELS[active];

    if (!data) {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", `${label} usage: loading…`));
      return;
    }

    if (data.error) {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", `${label} usage unavailable (${data.error})`));
      return;
    }

    const session = clampPercent(data.session);
    const weekly = clampPercent(data.weekly);

    const sessionReset = data.sessionResetsIn ? theme.fg("dim", ` ⟳ ${data.sessionResetsIn}`) : "";
    const weeklyReset = data.weeklyResetsIn ? theme.fg("dim", ` ⟳ ${data.weeklyResetsIn}`) : "";
    const staleSuffix = data.stale ? theme.fg("warning", " stale") : "";
    const warningSuffix = data.warning && !data.stale ? theme.fg("warning", " ⚠") : "";

    const status =
      theme.fg("dim", `${label} `) +
      theme.fg("muted", "S ") +
      renderBar(theme, session) +
      " " +
      renderPercent(theme, session) +
      sessionReset +
      theme.fg("muted", " W ") +
      renderBar(theme, weekly) +
      " " +
      renderPercent(theme, weekly) +
      weeklyReset +
      staleSuffix +
      warningSuffix;

    ctx.ui.setStatus(STATUS_KEY, status);
  }

  function updateProviderFrom(modelLike: any): boolean {
    const previous = state.activeProvider;
    state.activeProvider = detectProvider(modelLike);

    if (previous !== state.activeProvider) {
      updateStatus();
      return true;
    }

    return false;
  }

  async function runPoll() {
    let auth = readAuth();
    const active = state.activeProvider;

    const setActiveError = (message: string) => {
      if (!active) return;
      state[active] = { session: 0, weekly: 0, error: message };
    };

    if (!canShowForProvider(active, auth, endpoints)) {
      state.lastPoll = Date.now();
      updateStatus();
      return;
    }

    const oauthProviderId = providerToOAuthProviderId(active);
    if (oauthProviderId && auth) {
      const refreshed = await ensureFreshAuthForProviders([oauthProviderId], { auth });
      auth = refreshed.auth;

      const refreshError = refreshed.refreshErrors[oauthProviderId];
      if (refreshError) {
        setActiveError(`auth refresh failed (${refreshError})`);
        state.lastPoll = Date.now();
        updateStatus();
        return;
      }
    }

    if (!auth) {
      state.lastPoll = Date.now();
      updateStatus();
      return;
    }

    if (active === "codex") {
      const access = auth["openai-codex"]?.access;
      state.codex = access
        ? await fetchCodexUsage(access)
        : { session: 0, weekly: 0, error: "missing access token (try /login again)" };
    } else if (active === "claude") {
      state.claude = auth.anthropic?.access || auth.anthropic?.refresh
        ? (await fetchClaudeUsageWithFallback({ auth })).usage
        : { session: 0, weekly: 0, error: "missing access token (try /login again)" };
    } else if (active === "zai") {
      const token = auth.zai?.access || auth.zai?.key;
      state.zai = token
        ? await fetchZaiUsage(token, { endpoints })
        : { session: 0, weekly: 0, error: "missing token (try /login again)" };
    } else if (active === "gemini") {
      const creds = auth["google-gemini-cli"];
      state.gemini = creds?.access
        ? await fetchGoogleUsage(creds.access, endpoints.gemini, creds.projectId, "gemini", { endpoints })
        : { session: 0, weekly: 0, error: "missing access token (try /login again)" };
    } else if (active === "antigravity") {
      const creds = auth["google-antigravity"];
      state.antigravity = creds?.access
        ? await fetchGoogleUsage(creds.access, endpoints.antigravity, creds.projectId, "antigravity", { endpoints })
        : { session: 0, weekly: 0, error: "missing access token (try /login again)" };
    }

    state.lastPoll = Date.now();
    updateStatus();
  }

  async function poll() {
    if (pollInFlight) {
      pollQueued = true;
      await pollInFlight;
      return;
    }

    do {
      pollQueued = false;
      pollInFlight = runPoll()
        .catch(() => {
          // Never crash extension event handlers on transient polling errors.
        })
        .finally(() => {
          pollInFlight = null;
        });

      await pollInFlight;
    } while (pollQueued);
  }

  pi.on("session_start", async (_event, _ctx) => {
    ctx = _ctx;
    updateProviderFrom(_ctx.model);

    await poll();

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    if (_ctx?.hasUI) {
      _ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  pi.on("turn_start", async (_event, _ctx) => {
    ctx = _ctx;
    updateProviderFrom(_ctx.model);
  });

  pi.on("model_select", async (event, _ctx) => {
    ctx = _ctx;
    const changed = updateProviderFrom(event.model ?? _ctx.model);
    if (changed) await poll();
  });

  pi.registerCommand("usage", {
    description: "Show API usage for all subscriptions",
    handler: async (_args, _ctx) => {
      ctx = _ctx;
      updateProviderFrom(_ctx.model);

      try {
        if (_ctx?.hasUI) {
          await _ctx.ui.custom<void>((tui, theme, keybindings, done) => {
            const selector = new UsageSelectorComponent(
              tui,
              theme,
              state.activeProvider,
              () => fetchAllUsages({ endpoints }),
              () => done(),
              keybindings,
            );
            return selector;
          });
        }
      } finally {
        await poll();
      }
    },
  });
}
