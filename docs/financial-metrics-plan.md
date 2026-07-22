# Financial metrics plan

## Goal

Add an optional account-value view without treating balances and spend as subscription quota. Quota usage increases toward exhaustion; a balance decreases toward exhaustion; spend may be meaningful only relative to a budget. Those metrics must retain distinct labels and color rules.

## Normalized model

A future core revision should replace the two fixed quota fields with a list of typed metrics:

```ts
type UsageMetric =
  | {
      kind: "quota";
      id: string;
      label: string;
      usedPercent: number;
      resetsAt?: string;
    }
  | {
      kind: "money";
      id: string;
      label: string;
      currency: string;
      balance?: number;
      spent?: number;
      limit?: number;
      period?: "day" | "week" | "month" | "lifetime";
      resetsAt?: string;
    };
```

Provider fetchers should return normalized metrics. Rendering, not provider parsing, decides which metrics appear in the footer or `/usage` dialog.

## View behavior

The initial OpenRouter implementation displays both balance and spend in `/usage`. The footer prefers the balance and current-month spend, while a configured per-key limit remains the primary bar. A later persistent view setting may provide:

- `auto`: prefer quota windows; otherwise show a financial summary.
- `balance`: show remaining prepaid/credit balance.
- `spent`: show spend and a percentage only when a real limit or budget exists.
- `off`: retain quota-only behavior.

No environment variable or config key is reserved for that future view selector yet.

Color semantics:

- quota `usedPercent`: high is bad;
- balance: low remaining balance is bad only when a known starting balance or warning threshold exists;
- spend/limit: high is bad;
- unconstrained spend and raw balance: neutral colors, never a manufactured percentage.

## Provider rollout

1. **OpenRouter — implemented in 0.4.0**
   - `GET /api/v1/credits`: purchased credits, total usage, derived balance.
   - `GET /api/v1/key`: configured key limit and daily/weekly/monthly spend where supplied.
   - Uses only the API key resolved through Pi's provider registry.
2. **Balance providers**
   - DeepSeek and Moonshot/Kimi API prepaid balances are implemented in 0.4.0 using their official key-authenticated endpoints.
   - Mistral balance or monthly-plan data when available through an API credential.
   - MiniMax purchased Credits have a limited provider-specific implementation: when a first-party key-authenticated quota response includes `points_balance` or `credits_balance`, it is rendered neutrally. In current MiniMax deployments, the dedicated `/backend/account/token_plan_credit` endpoint requires browser-cookie authentication and does not accept the Subscription Key, so it remains out of scope. API status `2062` is rendered as a neutral “No active Token Plan” account state and never converted into a quota percentage.
3. **Spend providers**
   - OpenAI organization spend requires an Admin API key and therefore should appear only when Pi can resolve an appropriate credential.
   - AWS Bedrock spend requires explicit Cost Explorer permissions and should remain a separate opt-in integration.

Browser cookies and direct reads of Pi's credential files remain out of scope.

## Migration steps

1. Introduce `UsageMetric` alongside the existing `session`/`weekly` compatibility fields.
2. Convert quota fetchers and both renderers to metric lists.
3. Add persistent view selection; neutral financial formatting is already covered by OpenRouter tests.
4. Add further key-authenticated financial providers beyond OpenRouter, DeepSeek, and Moonshot.
5. Remove compatibility fields only in a documented major release.
