# pi-usage-bars

Usage indicator for **pi**.

![Codex footer bar](https://raw.githubusercontent.com/ajarellanod/pi-usage-bars/main/assets/codex.png)

It adds:
- a footer status bar for the active provider
- a `/usage` command with all connected providers

Supported providers:
- OpenAI Codex
- Anthropic Claude
- Z.AI
- Google Gemini CLI
- Google Antigravity

## Credits / Inspiration

This extension is based on and inspired by:
- https://github.com/steipete/CodexBar
- https://github.com/mikeyobrien/rho/tree/main/extensions/usage-bars

---

## Install

```bash
pi install npm:pi-usage-bars
```

---

## Use

### 1) Footer usage bars
When your active model is supported, footer shows:
- Session usage
- Weekly usage
- Reset countdowns (when available)

![Claude footer bar](https://raw.githubusercontent.com/ajarellanod/pi-usage-bars/main/assets/claude.png)

### 2) `/usage` command
Opens an interactive list with all providers that have credentials.

![/usage command](https://raw.githubusercontent.com/ajarellanod/pi-usage-bars/main/assets/usage-command.png)
