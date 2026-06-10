# Changelog

## [0.2.2] - 2026-06-10

### Fixed

- **Keybinding violation in `UsageSelectorComponent`** — replaced `getKeybindings()` with the `keybindings` parameter injected by `ctx.ui.custom()`. Per the Pi extension docs, custom components must use the injected `KeybindingsManager` directly rather than calling `getKeybindings()` or `setKeybindings()`. This fixes a compliance issue that could cause unexpected behavior under custom keybinding configurations.
