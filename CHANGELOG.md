# Changelog

## [0.2.3] - 2026-06-10

### Fixed

- **`DynamicBorder` is not defined** — added missing import of `DynamicBorder` from `@earendil-works/pi-coding-agent`. This fixes the `DynamicBorder is not defined` error when calling `/usage`.

### Changed

- Updated repository URLs from `ajarellanod` to `hknet` in `package.json` and `README.md`.
- Updated README image URLs to point to the `hknet` repository.
- Updated LICENSE copyright to `ajarellanod (secondary: hknet)`.

### Removed

- Removed stale tgz build artifacts and `package-lock.json` from the repository.
- Removed `NOTE.md` compliance report (development artifact).

## [0.2.2] - 2026-06-10

### Fixed

- **Keybinding violation in `UsageSelectorComponent`** — replaced `getKeybindings()` with the `keybindings` parameter injected by `ctx.ui.custom()`. Per the Pi extension docs, custom components must use the injected `KeybindingsManager` directly rather than calling `getKeybindings()` or `setKeybindings()`. This fixes a compliance issue that could cause unexpected behavior under custom keybinding configurations.
