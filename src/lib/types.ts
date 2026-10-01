export type Cadence = "hourly" | "daily";
export type Operator = "above" | "below";
export type Source = "live" | "demo";
export interface Bucket { optionId: number; label: string; lower: number; upper: number; yes: number; no: number; probability: number; quoteShare: number }
export interface Market { topicId: number; batchId: string; title: string; description: string; cadence: Cadence; targetAt: string; outcomeCount: number; resolvedOptionId: number | null; source: Source; volume24hMillisats: number | null; totalVolumeMillisats: number | null; liquidityMillisats: number | null }
export interface ForecastSummary { modalBucket: Bucket; central80: { lower: number; upper: number; probability: number } }
export type TransformationVersion = "quote-share-v1" | "quote-share-v2";
export interface Forecast { snapshotId: number; topicId: number; targetAt: string; capturedAt: string; source: Source; transformationVersion: TransformationVersion; originalYesSum: number; normalizationFactor: number; normalized: boolean; interpretation: "quote-share-not-calibrated"; caveat: string; buckets: Bucket[]; summary: ForecastSummary }
export interface Diagnostic { code: string; message: string }
export interface SnapshotProvenance { snapshotId: number; capturedAt: string; raw: unknown }
export interface ForecastResult { market: Market | null; forecast: Forecast | null; status: "ready" | "stale" | "expired" | "invalid" | "unavailable"; diagnostics: Diagnostic[]; provenance?: SnapshotProvenance; freshUntil?: string }
export interface MarketsResult { markets: Market[]; source: Source; collectedAt: string | null }
export interface TimelineResult { cadence: Cadence; asOf: string; collectedAt: string | null; source: Source; targets: ForecastResult[] }
export interface ThresholdResult { operator: Operator; threshold: number; probability: number; caveat: string }
export interface WatchInput { topicId: number; operator: Operator; threshold: number; materialPp: number; cooldownSeconds: number; enabled: boolean }
export interface Watch extends WatchInput { id: string; createdAt: string; baseline: number | null; lastNotifiedAt: string | null }
export interface MutationResult { ok: true }
export interface PushConfig { enabled: boolean; publicKey: string | null }
export interface PushSubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PerformanceSample { topicId: number; snapshotId: number; targetAt: string; capturedAt: string; resolvedOptionId: number; transformationVersion: TransformationVersion; brier: number }
export interface PerformanceGroup { cadence: Cadence; leadSeconds: number; maxSnapshotAgeSeconds: number; eligibleCount: number; sampleCount: number; missingSnapshotCount: number; pendingResolutionCount: number; meanBrier: number | null; samples: PerformanceSample[] }
export interface PerformanceResult { metric: "multiclass-brier-original-bins"; convention: "sum((p-y)^2), lower is better"; source: "live"; groups: PerformanceGroup[] }
