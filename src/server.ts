#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { configFromEnv, MetaOps, PlanStore, type CampaignChange } from './meta';

const plans = new PlanStore(process.env.META_OPS_DB ?? './meta-ops.db');
const meta = new MetaOps(configFromEnv(), plans);
const server = new Server({ name: 'meta-ops-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });

const tools: Tool[] = [
  { name: 'list_instagram_media', description: 'List recent Instagram media for the configured business account.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } },
    annotations: { readOnlyHint: true } },
  { name: 'get_media_insights', description: 'Read metrics for one Instagram media ID.',
    inputSchema: { type: 'object', properties: { media_id: { type: 'string' }, metrics: { type: 'string' } }, required: ['media_id', 'metrics'] },
    annotations: { readOnlyHint: true } },
  { name: 'get_account_insights', description: 'Read metrics for the configured Instagram account.',
    inputSchema: { type: 'object', properties: { metrics: { type: 'string' }, period: { type: 'string', enum: ['day', 'week', 'days_28'] } }, required: ['metrics'] },
    annotations: { readOnlyHint: true } },
  { name: 'list_campaigns', description: 'List campaigns in the configured Meta ad account.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'get_campaign_insights', description: 'Read daily campaign insights for the last 7 or 30 days.',
    inputSchema: { type: 'object', properties: { campaign_id: { type: 'string' }, days: { type: 'integer', enum: [7, 30] } }, required: ['campaign_id'] },
    annotations: { readOnlyHint: true } },
  { name: 'prepare_campaign_change', description: 'Prepare a scoped campaign status or budget change. Returns a plan for out-of-band approval; no Meta mutation occurs.',
    inputSchema: { type: 'object', properties: { campaign_id: { type: 'string' }, kind: { type: 'string', enum: ['status', 'daily_budget', 'lifetime_budget'] }, value: { anyOf: [{ type: 'string' }, { type: 'integer' }] } }, required: ['campaign_id', 'kind', 'value'] },
    annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'commit_campaign_change', description: 'Execute a plan already approved outside MCP. A network failure becomes uncertain and is never retried automatically.',
    inputSchema: { type: 'object', properties: { plan_id: { type: 'string' } }, required: ['plan_id'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    let result: unknown;
    switch (params.name) {
      case 'list_instagram_media': result = await meta.listInstagramMedia(Number(args.limit ?? 10)); break;
      case 'get_media_insights': result = await meta.getMediaInsights(String(args.media_id ?? ''), String(args.metrics ?? '')); break;
      case 'get_account_insights': result = await meta.getAccountInsights(String(args.metrics ?? ''), String(args.period ?? 'day')); break;
      case 'list_campaigns': result = await meta.listCampaigns(); break;
      case 'get_campaign_insights': result = await meta.campaignInsights(String(args.campaign_id ?? ''), args.days === 30 ? 30 : 7); break;
      case 'prepare_campaign_change': {
        const kind = String(args.kind ?? '');
        if (!['status', 'daily_budget', 'lifetime_budget'].includes(kind)) throw new Error('invalid change kind');
        const value = kind === 'status' ? String(args.value ?? '') : Number(args.value);
        result = await meta.prepareCampaignChange(String(args.campaign_id ?? ''), { kind, value } as CampaignChange);
        break;
      }
      case 'commit_campaign_change': result = await meta.commitCampaignChange(String(args.plan_id ?? '')); break;
      default: throw new Error('unknown tool');
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
  }
});

await server.connect(new StdioServerTransport());
