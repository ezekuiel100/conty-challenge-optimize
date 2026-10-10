import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string };
type CreatorRow = { id: string; name: string; niches_json: string };
type CreatorTotalRow = { creator_id: string; n: number };

// Métrica mais recente de cada conta (maior captured_at, empate por id decrescente),
// somada por criador. Contas sem métrica e criadores sem conta ficam de fora e valem 0.
const LATEST_REACH_SQL = `
  SELECT a.creator_id, SUM(m.views) AS n
  FROM (
    SELECT account_id, views,
      ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY captured_at DESC, id DESC) AS rn
    FROM metrics
  ) m
  JOIN social_accounts a ON a.id = m.account_id
  WHERE m.rn = 1
  GROUP BY a.creator_id`;

const DELIVERIES_SQL = `
  SELECT creator_id, COUNT(*) AS n
  FROM deliveries
  WHERE delivered_at >= ?
  GROUP BY creator_id`;

function totalsByCreator(rows: CreatorTotalRow[]): Map<string, number> {
  return new Map(rows.map((row) => [row.creator_id, Number(row.n)]));
}

function compareCreators(left: CreatorMatch, right: CreatorMatch): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(
    db,
    "SELECT id, niches_json FROM campaigns WHERE id = ?",
    input.campaignId,
  );
  if (!campaign) return null;

  const creators = await all<CreatorRow>(db, "SELECT id, name, niches_json FROM creators");
  const reachByCreator = totalsByCreator(await all<CreatorTotalRow>(db, LATEST_REACH_SQL));
  const deliveriesByCreator = totalsByCreator(
    await all<CreatorTotalRow>(db, DELIVERIES_SQL, deliveriesSince()),
  );
  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const scored: CreatorMatch[] = [];

  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore === 0) continue;

    scored.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: reachByCreator.get(creator.id) ?? 0,
      deliveries_90d: deliveriesByCreator.get(creator.id) ?? 0,
    });
  }

  scored.sort(compareCreators);
  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: scored.slice(input.offset, input.offset + input.limit),
  };
}
