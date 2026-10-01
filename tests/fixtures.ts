import type { Market, WatchInput } from "../src/lib/types";
export const now = Date.parse("2026-10-01T00:00:00Z");
export const market: Market = { topicId: 123, batchId: "test-batch", title: "Bitcoin", description: "Fixture", cadence: "hourly", targetAt: "2026-10-01T02:00:00Z", outcomeCount: 3, resolvedOptionId: null, source: "live", volume24hMillisats: null, totalVolumeMillisats: null, liquidityMillisats: null };
export const quote = (yes = [20, 60, 20]): Record<string, unknown> => ({ topic_id: market.topicId, batch_id: market.batchId, title: market.title, market_end_time_utc: Date.parse(market.targetAt) / 1000, is_resolved: false, outcomes: yes.map((p, i) => ({ option_id: i + 1, name: `${i * 1000}-${(i + 1) * 1000}`, yes_price: p, no_price: 100 - p })) });
export const watch: WatchInput = { topicId: market.topicId, operator: "above", threshold: 2000, materialPp: 5, cooldownSeconds: 60, enabled: true };
