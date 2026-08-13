# Provider support research

This document records providers considered for usage-bar support but currently blocked by the absence of a suitable first-party API. Recheck these findings when a provider publishes a new quota, balance, or billing API.

## Qwen Token Plan

**Status:** Blocked — no account-usage surface found as of 2026-08-13.

Pi 0.84.1 supports these provider IDs:

- `qwen-token-plan`
- `qwen-token-plan-individual`
- `qwen-token-plan-cn`

The Individual provider shares the international inference endpoint and `QWEN_TOKEN_PLAN_API_KEY` with the existing international provider, but exposes a narrower model catalog.

Research found no documented API-key-authenticated endpoint that reports consumed or remaining quota, percentages, or reset times. Independent probing of eight likely usage/quota paths on `token-plan.ap-southeast-1.maas.aliyuncs.com` returned `404`, and successful inference responses did not include quota or rate-limit headers. Qwen's client can recognize an exhausted-quota error, but that provides no usage percentage or reset timestamp.

Do not estimate account-wide quota from requests observed by this extension: other clients and sessions would make that value incomplete and misleading.

**Recheck when:** Alibaba Model Studio documents a Token Plan usage endpoint, adds quota headers to inference responses, or exposes a key-authenticated portal API.

## Baseten

**Status:** Blocked — no account-usage surface found as of 2026-08-13.

Pi 0.84.0 added the `baseten` provider using `BASETEN_API_KEY`. Baseten is primarily usage-billed, and research found no documented API-key endpoint for account balance, credits, budget utilization, or billing usage that this extension could safely query.

**Recheck when:** Baseten publishes a first-party balance, credits, budget, or billing-usage API accessible with the inference credential or a documented monitoring credential.

## Acceptance criteria for a new provider

A provider is suitable when a documented first-party API or response header supplies at least one meaningful account-level value:

- quota consumed or remaining, ideally with a reset time;
- account balance or credits; or
- spend for a defined billing period.

Authentication must work through Pi's provider credential API. The extension must not import browser cookies, scrape console pages, estimate account-wide usage from local traffic, or send credentials to third-party services.
