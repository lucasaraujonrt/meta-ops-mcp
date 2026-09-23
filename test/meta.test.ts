import { afterEach, expect, test } from 'bun:test';
import { MetaOps, PlanStore, type MetaConfig } from '../src/meta';

const stores: PlanStore[] = [];
const config: MetaConfig = { token: 'test-secret', instagramAccountId: '123', adAccountId: 'act_456', version: 'v22.0',
  maxDailyBudgetMinor: 10000, maxLifetimeBudgetMinor: 100000 };
function store() { const value = new PlanStore(); stores.push(value); return value; }
afterEach(() => stores.splice(0).forEach((value) => value.close()));

test('prepares a scoped change, requires approval, commits and verifies', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const fetcher = (async (input: URL, options: RequestInit) => {
    calls.push({ url: String(input), method: options.method ?? 'GET' });
    if (calls.length === 1) return Response.json({ id: '789', account_id: '456', name: 'Demo', status: 'PAUSED' });
    if (calls.length === 2) return Response.json({ currency: 'BRL' });
    if (calls.length === 3) return Response.json({ account_id: '456', status: 'PAUSED' });
    if (calls.length === 4) return Response.json({ success: true });
    return Response.json({ status: 'ACTIVE' });
  }) as unknown as typeof fetch;
  const plans = store();
  const meta = new MetaOps(config, plans, fetcher);
  const plan = await meta.prepareCampaignChange('789', { kind: 'status', value: 'ACTIVE' });
  await expect(meta.commitCampaignChange(plan.id)).rejects.toThrow('approval');
  plans.transition(plan.id, 'pending', 'approved');
  const done = await meta.commitCampaignChange(plan.id);
  expect(done.status).toBe('succeeded');
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  expect(calls.some((call) => call.url.includes('test-secret'))).toBe(false);
});

test('rejects account mismatch and out-of-cap budget without POST', async () => {
  const fetcher = (async () => Response.json({ id: '789', account_id: '999', name: 'Other', daily_budget: '100' })) as unknown as typeof fetch;
  const meta = new MetaOps(config, store(), fetcher);
  await expect(meta.prepareCampaignChange('789', { kind: 'daily_budget', value: 10001 })).rejects.toThrow('cap');
  await expect(meta.prepareCampaignChange('789', { kind: 'daily_budget', value: 1000 })).rejects.toThrow('another ad account');
});

test('uncertain provider response cannot be replayed', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    if (calls === 1) return Response.json({ id: '789', account_id: '456', name: 'Demo', status: 'PAUSED' });
    if (calls === 2) return Response.json({ currency: 'BRL' });
    if (calls === 3) return Response.json({ account_id: '456', status: 'PAUSED' });
    throw new Error('timeout');
  }) as unknown as typeof fetch;
  const plans = store();
  const meta = new MetaOps(config, plans, fetcher);
  const plan = await meta.prepareCampaignChange('789', { kind: 'status', value: 'ACTIVE' });
  plans.transition(plan.id, 'pending', 'approved');
  expect((await meta.commitCampaignChange(plan.id)).status).toBe('uncertain');
  await expect(meta.commitCampaignChange(plan.id)).rejects.toThrow('approval');
  expect(calls).toBe(4);
});
