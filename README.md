# Meta Ops MCP

An agent-facing MCP server for Instagram insights and scoped Meta Ads operations. It is a clean extraction of Inker's Meta Graph tooling. It replaces the original arbitrary Graph POST tool with explicit campaign changes that require out-of-band approval.

## Tools

| Tool | Effect |
|---|---|
| `list_instagram_media` | Read recent media |
| `get_media_insights` | Read metrics for one media ID |
| `get_account_insights` | Read account metrics |
| `list_campaigns` | Read campaigns in the configured ad account |
| `get_campaign_insights` | Read daily metrics for 7 or 30 days |
| `prepare_campaign_change` | Read current campaign/account state and persist a 15-minute change plan |
| `commit_campaign_change` | Execute a separately approved plan after checking that campaign state has not drifted |

Budget values are integer minor currency units of the configured ad account. For BRL, `5000` means R$50. The server reads the account currency and enforces configured daily/lifetime caps. It never chooses a campaign ID or account from an untrusted search result.

## Setup

Requires Bun 1.2 or newer. Install dependencies with `bun install`, then set the variables shown in [.env.example](.env.example) through your shell or agent host. The server does not load `.env` files itself.

```sh
bun run src/server.ts
```

Example MCP client entry using stdio:

```json
{
  "mcpServers": {
    "meta-ops": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/meta-ops-mcp/src/server.ts"],
      "env": {
        "META_ACCESS_TOKEN": "${META_ACCESS_TOKEN}",
        "META_INSTAGRAM_ACCOUNT_ID": "${META_INSTAGRAM_ACCOUNT_ID}",
        "META_AD_ACCOUNT_ID": "${META_AD_ACCOUNT_ID}",
        "META_GRAPH_API_VERSION": "${META_GRAPH_API_VERSION}"
      }
    }
  }
}
```

The `${...}` values are placeholders. Configure secret injection according to your MCP host; do not put a real token in versioned JSON.

## Changing a campaign

1. Ask the agent to call `prepare_campaign_change` with the exact campaign ID, field and value.
2. Review the returned plan: campaign name, account, currency, previous value, proposed value and expiry.
3. From a trusted shell outside the agent's tool surface, run `bun run src/approve.ts PLAN_ID CAMPAIGN_ID:KIND:VALUE` using the same `META_OPS_DB` as the server. For example, `789:status:PAUSED`.
4. The agent may then call `commit_campaign_change` with the plan ID.

Keep the approval command unavailable to the agent. MCP annotations describe tool behavior but do not enforce authorization. The host must control access to the approval path.

An ambiguous provider result becomes `uncertain` and is not automatically retried. Check Meta's actual campaign state before making another plan. See [architecture](docs/architecture.md).

## Verification

`bun test` uses fake Graph responses and no real Meta credentials. It covers account scoping, budget caps, approval requirement, drift checks, one-time POST and uncertain responses.

## Origin and scope

The original Inker MCP also had a generic GET/POST escape hatch. This public interface has named operations only and contains no Inker account ID, token or campaign data. Graph API permissions and available metrics vary by account and API version; use the official Meta documentation to configure a compatible token.
