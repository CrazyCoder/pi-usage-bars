# Pi Extension Compliance Report

**Extension:** pi-usage-bars
**Date:** 2026-06-10
**Guidelines:** https://pi.dev/docs/latest/extensions

## Summary

The extension is **conformant** with the Pi extension guidelines. One violation was found and fixed; two other concerns were investigated and confirmed safe.

## Findings

### ✅ Fixed: Keybinding violation (moderate)

`UsageSelectorComponent.handleInput()` called `getKeybindings()` directly instead of using the `keybindings` parameter injected by `ctx.ui.custom()`. The docs explicitly state:

> Custom components and `ctx.ui.custom()` components receive `keybindings: KeybindingsManager` as an injected argument. They should use that injected manager directly instead of calling `getKeybindings()` or `setKeybindings()`.

**Fix:** Replaced all calls to `getKeybindings()` with `this.keybindings.matches(...)`. Updated the `ctx.ui.custom()` call site to pass `keybindings` through to the component constructor.

### ✅ Confirmed: No issue — `DynamicBorder` import

The extension imports `DynamicBorder` from `@earendil-works/pi-coding-agent`. This is correct — the symbol is exported from the package's `index.ts` under the "UI components for extensions" block and re-exported via `./modes/interactive/components/index.ts`. It is also used by other production extensions (e.g., `prompt-url-widget.ts`).

### ✅ Confirmed: No issue — stale `ctx` during polling

The `runPoll()` function performs async work that ends with a synchronous call to `updateStatus()`, which accesses the captured `ctx`. This is safe because:

1. `session_shutdown` clears the polling interval before `ctx` is cleared, so no new polls start after shutdown.
2. `updateStatus()` is called synchronously at the end of `runPoll()`, not inside a `.then()` callback, so it runs within the current event handler's lifetime.
3. `runPoll()` itself never reads `ctx` — it only reads `state` (plain data) and reads auth from disk.
4. `updateStatus()` is null-safe: `if (!ctx?.hasUI) return;`.
5. `poll()` has a `pollInFlight` dedup guard preventing concurrent polls from overlapping with shutdown.

## Other Compliant Areas

| Guideline | Status |
|---|---|
| Extension style (directory with `index.ts`) | ✅ |
| `package.json` with `"pi": { "extensions": [...] }` | ✅ |
| `peerDependencies` declared | ✅ |
| Default factory function signature | ✅ |
| `pi.on()` event handler signatures | ✅ |
| `ctx.hasUI` checks before UI calls | ✅ |
| `session_shutdown` cleanup | ✅ |
| Error handling (poll catches errors) | ✅ |
