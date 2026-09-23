#!/usr/bin/env bun
import { PlanStore } from './meta';

const [id, confirmation] = process.argv.slice(2);
if (!id || !confirmation) {
  console.error('usage: bun run src/approve.ts PLAN_ID CAMPAIGN_ID:KIND:VALUE');
  process.exit(2);
}

const plans = new PlanStore(process.env.META_OPS_DB ?? './meta-ops.db');
try {
  const plan = plans.get(id);
  const expected = `${plan.campaignId}:${plan.change.kind}:${plan.change.value}`;
  if (confirmation !== expected) throw new Error(`confirmation must equal ${expected}`);
  if (plan.status !== 'pending') throw new Error('plan is not pending');
  const approved = plans.transition(id, 'pending', 'approved');
  console.log(JSON.stringify({ id: approved.id, status: approved.status, campaign: approved.campaignName,
    currency: approved.currency, previous: approved.previous, change: approved.change }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  plans.close();
}
