# Architecture

The stdio MCP server exposes seven named tools. `MetaOps` owns the Graph API calls and validates account/model fields. `PlanStore` owns local SQLite plans. The approval CLI is intentionally a separate process and is not exposed as an MCP tool.

For a mutation, `prepare_campaign_change` fetches the campaign and configured ad account, checks ownership and currency, checks the maximum budget, then persists a plan with a 15-minute expiry. A trusted operator approves the exact campaign ID, field and value. `commit_campaign_change` fetches the campaign again, refuses drift, atomically claims the approved plan, sends one Graph POST, and reads the changed field back to verify it.

Once the POST starts, a timeout or verification failure is recorded as `uncertain`. The tool must not retry the same plan. An operator should inspect the campaign in Meta before deciding whether to prepare a new change.

The local SQLite database is operational state and must remain private. The service uses the access token only in the Authorization header and does not print it. The authenticated agent host must restrict who can call this server and who can invoke the approval CLI.
