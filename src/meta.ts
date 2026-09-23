import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';

export interface MetaConfig {
  token: string;
  instagramAccountId: string;
  adAccountId: string;
  version: string;
  maxDailyBudgetMinor: number;
  maxLifetimeBudgetMinor: number;
}

export type CampaignChange = { kind: 'status'; value: 'PAUSED' | 'ACTIVE' } |
  { kind: 'daily_budget'; value: number } |
  { kind: 'lifetime_budget'; value: number };

export interface ChangePlan {
  id: string;
  campaignId: string;
  campaignName: string;
  accountId: string;
  currency: string;
  change: CampaignChange;
  previous: string;
  status: 'pending' | 'approved' | 'executing' | 'succeeded' | 'uncertain';
  createdAt: number;
  expiresAt: number;
  providerResult?: unknown;
}

function numericId(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error('campaign ID must contain digits only');
  return value;
}

function accountId(value: string): string {
  if (!/^act_\d+$/.test(value)) throw new Error('META_AD_ACCOUNT_ID must be act_<digits>');
  return value;
}

export class PlanStore {
  private readonly db: Database;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, result_json TEXT
    )`);
  }

  create(input: Omit<ChangePlan, 'id' | 'status' | 'createdAt' | 'expiresAt'>): ChangePlan {
    const now = Date.now();
    const plan: ChangePlan = { ...input, id: randomUUID(), status: 'pending', createdAt: now, expiresAt: now + 15 * 60_000 };
    this.db.prepare('INSERT INTO plans (id,payload,status,created_at,expires_at) VALUES (?,?,?,?,?)')
      .run(plan.id, JSON.stringify(plan), plan.status, now, plan.expiresAt);
    return plan;
  }

  get(id: string): ChangePlan {
    const row = this.db.prepare('SELECT * FROM plans WHERE id=?').get(id) as { payload: string; status: ChangePlan['status']; result_json?: string } | null;
    if (!row) throw new Error('plan not found');
    return { ...JSON.parse(row.payload) as ChangePlan, status: row.status, providerResult: row.result_json ? JSON.parse(row.result_json) : undefined };
  }

  transition(id: string, from: ChangePlan['status'], to: ChangePlan['status'], result?: unknown): ChangePlan {
    const requireFresh = from === 'pending' || from === 'approved';
    const changed = this.db.prepare(`UPDATE plans SET status=?, result_json=? WHERE id=? AND status=? ${requireFresh ? 'AND expires_at>?' : ''}`)
      .run(...[to, result === undefined ? null : JSON.stringify(result), id, from, ...(requireFresh ? [Date.now()] : [])]).changes;
    if (changed !== 1) throw new Error(`plan is not ${from} or has expired`);
    return this.get(id);
  }

  close(): void { this.db.close(); }
}

export class MetaOps {
  constructor(
    private readonly config: MetaConfig,
    private readonly plans: PlanStore,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    accountId(config.adAccountId);
    if (!/^v\d+\.\d+$/.test(config.version)) throw new Error('invalid Graph API version');
    if (!Number.isSafeInteger(config.maxDailyBudgetMinor) || config.maxDailyBudgetMinor <= 0 ||
      !Number.isSafeInteger(config.maxLifetimeBudgetMinor) || config.maxLifetimeBudgetMinor <= 0) {
      throw new Error('budget caps must be positive integer minor units');
    }
  }

  private async graph(path: string, params: Record<string, string>, method: 'GET' | 'POST' = 'GET'): Promise<unknown> {
    const url = new URL(`https://graph.facebook.com/${this.config.version}/${path.replace(/^\//, '')}`);
    const body = new URLSearchParams(params);
    const options: RequestInit = { method, headers: { Authorization: `Bearer ${this.config.token}` }, signal: AbortSignal.timeout(30_000) };
    if (method === 'GET') url.search = body.toString();
    else {
      options.headers = { ...options.headers, 'Content-Type': 'application/x-www-form-urlencoded' };
      options.body = body.toString();
    }
    const response = await this.fetcher(url, options);
    const data = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new Error(`Meta Graph ${response.status}: ${data.error?.message ?? 'request failed'}`);
    return data;
  }

  listInstagramMedia(limit = 10): Promise<unknown> {
    const size = Math.max(1, Math.min(50, Math.trunc(limit)));
    return this.graph(this.config.instagramAccountId + '/media', {
      fields: 'id,media_type,media_product_type,caption,permalink,timestamp,like_count,comments_count',
      limit: String(size),
    });
  }

  getMediaInsights(mediaId: string, metrics: string): Promise<unknown> {
    numericId(mediaId);
    if (!/^[a-z_,]+$/.test(metrics)) throw new Error('invalid insight metrics');
    return this.graph(`${mediaId}/insights`, { metric: metrics });
  }

  getAccountInsights(metrics: string, period = 'day'): Promise<unknown> {
    if (!/^[a-z_,]+$/.test(metrics)) throw new Error('invalid insight metrics');
    if (!['day', 'week', 'days_28'].includes(period)) throw new Error('invalid period');
    return this.graph(`${this.config.instagramAccountId}/insights`, { metric: metrics, period });
  }

  listCampaigns(): Promise<unknown> {
    return this.graph(`${this.config.adAccountId}/campaigns`, {
      fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,account_id', limit: '100',
    });
  }

  campaignInsights(campaignId: string, days: 7 | 30 = 7): Promise<unknown> {
    numericId(campaignId);
    return this.graph(`${campaignId}/insights`, {
      fields: 'date_start,date_stop,spend,impressions,clicks,ctr,cpc,cpm,actions',
      date_preset: days === 7 ? 'last_7d' : 'last_30d', time_increment: '1',
    });
  }

  async prepareCampaignChange(campaignId: string, change: CampaignChange): Promise<ChangePlan> {
    numericId(campaignId);
    if (change.kind === 'status' && !['PAUSED', 'ACTIVE'].includes(change.value)) throw new Error('invalid status');
    if (change.kind !== 'status') {
      const cap = change.kind === 'daily_budget' ? this.config.maxDailyBudgetMinor : this.config.maxLifetimeBudgetMinor;
      if (!Number.isSafeInteger(change.value) || change.value <= 0 || change.value > cap) throw new Error('budget exceeds configured minor-unit cap');
    }
    const campaign = await this.graph(campaignId, { fields: 'id,name,account_id,status,daily_budget,lifetime_budget' }) as Record<string, string>;
    if (campaign.account_id !== this.config.adAccountId.replace('act_', '')) throw new Error('campaign belongs to another ad account');
    const account = await this.graph(this.config.adAccountId, { fields: 'currency' }) as { currency?: string };
    if (!account.currency) throw new Error('account currency unavailable');
    const previous = change.kind === 'status' ? campaign.status : campaign[change.kind];
    if (previous === undefined) throw new Error('campaign field unavailable; cannot prepare change');
    return this.plans.create({ campaignId, campaignName: campaign.name, accountId: this.config.adAccountId,
      currency: account.currency, change, previous });
  }

  async commitCampaignChange(planId: string): Promise<ChangePlan> {
    const plan = this.plans.get(planId);
    if (plan.status !== 'approved') throw new Error('plan requires out-of-band approval');
    const current = await this.graph(plan.campaignId, { fields: `account_id,${plan.change.kind}` }) as Record<string, string>;
    if (current.account_id !== plan.accountId.replace('act_', '') || current[plan.change.kind] !== plan.previous) {
      throw new Error('campaign changed since preparation; create a new plan');
    }
    this.plans.transition(planId, 'approved', 'executing');
    try {
      const result = await this.graph(plan.campaignId, { [plan.change.kind]: String(plan.change.value) }, 'POST');
      if ((result as { success?: boolean }).success === false) throw new Error('Meta reported unsuccessful mutation');
      const after = await this.graph(plan.campaignId, { fields: plan.change.kind }) as Record<string, string>;
      if (String(after[plan.change.kind]) !== String(plan.change.value)) throw new Error('Meta mutation could not be verified');
      return this.plans.transition(planId, 'executing', 'succeeded', { result, verified: after[plan.change.kind] });
    } catch (error) {
      return this.plans.transition(planId, 'executing', 'uncertain', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export function configFromEnv(): MetaConfig {
  const token = process.env.META_ACCESS_TOKEN;
  const instagramAccountId = process.env.META_INSTAGRAM_ACCOUNT_ID;
  const adAccountId = process.env.META_AD_ACCOUNT_ID;
  const version = process.env.META_GRAPH_API_VERSION;
  if (!token || !instagramAccountId || !adAccountId || !version) throw new Error('META_ACCESS_TOKEN, META_INSTAGRAM_ACCOUNT_ID, META_AD_ACCOUNT_ID and META_GRAPH_API_VERSION are required');
  numericId(instagramAccountId);
  return { token, instagramAccountId, adAccountId, version,
    maxDailyBudgetMinor: Number(process.env.META_MAX_DAILY_BUDGET_MINOR ?? 10000),
    maxLifetimeBudgetMinor: Number(process.env.META_MAX_LIFETIME_BUDGET_MINOR ?? 100000) };
}
