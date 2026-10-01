"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { publicRead } from "../client/api";
import type { Bucket, Cadence, ForecastResult, MarketsResult, Operator } from "../lib/types";
import { Histogram, coverageLabel, defaultBoundary, money, percent } from "./Histogram";
import { Watches } from "./Watches";
import { Cloud, Info, RefreshCw, CalendarClock, ArrowRight, ExternalLink } from "lucide-react";
import { Projection } from "./Projection";
import { selectionHref } from "../lib/selection";
import { Sheet } from "./Sheet";
import { groupDiagnostics } from "./diagnostics";
import { distributionRanges, millisatsToSats, quoteMetrics } from "../lib/projection";

const localTime = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" });
const utcTime = (value: string) => new Date(value).toISOString().replace("T", " ").replace(/(?:\.000)?Z$/, " UTC");
const compactTime = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function currentForecastResult(result: ForecastResult | null, now: number | null): ForecastResult | null {
  if (!result?.forecast || result.status !== "ready") return result;
  if (now === null || !result.freshUntil || !Number.isFinite(Date.parse(result.freshUntil))) return { ...result, status: "stale" };
  if (Date.parse(result.forecast.targetAt) <= now) return { ...result, status: "expired" };
  return Date.parse(result.freshUntil) < now ? { ...result, status: "stale" } : result;
}

export function canonicalBoundary(buckets: Bucket[], threshold: number): number | null {
  if (!Number.isFinite(threshold)) return null;
  return buckets.flatMap(b => [b.lower, b.upper]).find(value => Number.isFinite(value) && Math.abs(value - threshold) <= 1e-9) ?? null;
}

export function boundaryProbability(buckets: Bucket[], threshold: number, operator: Operator): number | null {
  const boundary = canonicalBoundary(buckets, threshold);
  return boundary === null ? null : buckets.filter(b => operator === "above" ? b.lower >= boundary : b.upper <= boundary).reduce((sum, b) => sum + b.probability, 0);
}

export function ForecastHeadline({ forecast }: { forecast: NonNullable<ForecastResult["forecast"]> }) {
  const median = distributionRanges(forecast.buckets)?.median;
  return <div className="outlook-intro"><div><span className="favored-label">Median range</span><h1>{median ? <>{money(median.lower)} <span>-</span> {money(median.upper)}</> : "Unavailable"}</h1></div></div>;
}
const sats = (value: number | null | undefined) => { const amount = millisatsToSats(value); return amount === null ? "Unavailable" : `${amount.toLocaleString(undefined, { maximumFractionDigits: 3 })} sats`; };
const validationLabels: Record<string, string> = {
  "pair-sum": "Historical v1 check: YES and NO quotes did not add up to 100 within tolerance",
  "total-sum": "Historical v1 check: total YES quotes did not add up to 100 within tolerance",
  schema: "Source data does not match the expected format",
  resolved: "Market has already resolved",
  coverage: "Quote count does not match the market outcomes",
  duplicate: "Duplicate outcome IDs",
  "quote-range": "Historical v1 check: quotes were outside 0..100",
  "negative-quote": "YES or NO quotes are negative",
  "zero-total": "Total YES quotes are zero",
  "numeric-overflow": "Total YES quotes exceed numeric representability",
  "numeric-representability": "Normalization factor exceeds numeric representability",
  "bin-label": "Price ranges could not be read",
  "bin-range": "Price ranges are invalid",
  contiguity: "Price ranges have gaps or overlaps",
  identity: "Quotes belong to a different market or settlement target",
  "outcome-identity": "Quotes do not match the discovered outcomes",
  "post-target": "Quotes were retrieved after the settlement target",
};

export function WeatherApp({ mode = "outlook" }: { mode?: "outlook" | "watches" } = {}) {
  const [markets, setMarkets] = useState<MarketsResult | null>(null);
  const [result, setResult] = useState<ForecastResult | null>(null);
  const [cadence, setCadence] = useState<Cadence>(mode === "outlook" ? "daily" : "hourly");
  const [topic, setTopic] = useState<number | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [operator, setOperator] = useState<Operator>("above");
  const [threshold, setThreshold] = useState(0);
  const [offline, setOffline] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [marketCachedAt, setMarketCachedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [forecastError, setForecastError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState<number | null>(null);
  const topicRef = useRef<number | null>(null);
  const snapshotRef = useRef<string | null>(null);
  const targetSelect = useRef<HTMLSelectElement>(null);
  const requestId = useRef(0);
  const autoSelect = useRef(true);
  const boundaryTarget = useRef<string | null>(null);
  const boundaryEdited = useRef(false);
  const chooseBoundary = (value: number) => { boundaryEdited.current = true; setThreshold(value); };
  const select = useCallback((id: number, preserveWatch = false) => {
    autoSelect.current = false;
    boundaryTarget.current = null; boundaryEdited.current = boundaryEdited.current || topicRef.current !== null;
    ++requestId.current;
    snapshotRef.current = null; setSnapshotId(null);
    setRetry(value => value + 1);
    topicRef.current = id; setTopic(id); setResult(null); setCachedAt(null); setForecastError(""); setLoading(true);
    const url = new URL(location.href); url.searchParams.set("market", String(id)); url.searchParams.delete("topicId");
    url.searchParams.delete("snapshotId");
    if (!preserveWatch) url.searchParams.delete("watch");
    history.replaceState(null, "", url);
    window.dispatchEvent(new Event("weather-selection"));
  }, []);
  const changeCadence = (next: Cadence) => {
    autoSelect.current = false;
    const market = markets?.markets.find(m => m.cadence === next);
    setCadence(next);
    if (market) select(market.topicId);
    else {
      ++requestId.current;
      boundaryTarget.current = null; boundaryEdited.current = false;
      topicRef.current = null; snapshotRef.current = null;
      setTopic(null); setSnapshotId(null); setResult(null); setCachedAt(null); setForecastError(""); setLoading(false);
      const url = new URL(location.href);
      ["market", "topicId", "snapshotId", "watch"].forEach(key => url.searchParams.delete(key));
      history.replaceState(null, "", url);
      window.dispatchEvent(new Event("weather-selection"));
    }
  };
  const refreshMarkets = useCallback(async () => {
    try {
      const response = await publicRead<MarketsResult>("/api/markets");
      setMarkets(response.data); setMarketCachedAt(response.cachedAt);
      if (autoSelect.current && topicRef.current === null && snapshotRef.current === null && response.data.markets.length) {
        const first = response.data.markets.find(m => m.cadence === (mode === "outlook" ? "daily" : "hourly")) ?? response.data.markets[0];
        setCadence(first.cadence); select(first.topicId);
      }
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Markets unavailable."); }
    finally { if (topicRef.current === null && snapshotRef.current === null) setLoading(false); }
  }, [select, mode]);
  useEffect(() => {
    const readLocation = () => {
      const params = new URLSearchParams(location.search);
      const id = Number(params.get("market") ?? params.get("topicId"));
      const nextTopic = Number.isSafeInteger(id) && id > 0 ? id : null;
      const snapshot = params.get("snapshotId");
      autoSelect.current = nextTopic === null && snapshot === null;
      boundaryTarget.current = null; boundaryEdited.current = false;
      const boundary = params.get("boundary");
      if (boundary !== null) { setThreshold(boundary.trim() !== "" && Number(boundary) >= 0 ? Number(boundary) : NaN); boundaryEdited.current = true; }
      const direction = params.get("operator");
      if (direction === "above" || direction === "below") setOperator(direction);
      ++requestId.current;
      snapshotRef.current = snapshot; setSnapshotId(snapshot);
      topicRef.current = nextTopic; setTopic(nextTopic); setResult(null); setCachedAt(null); setForecastError(""); setLoading(true);
      setRetry(value => value + 1);
    };
    readLocation();
    setNow(Date.now()); setOffline(!navigator.onLine);
    const network = () => { setNow(Date.now()); setOffline(!navigator.onLine); if (navigator.onLine) void refreshMarkets(); };
    const foreground = () => { if (document.visibilityState === "visible") { setNow(Date.now()); void refreshMarkets(); } };
    const pop = () => { readLocation(); void refreshMarkets(); };
    window.addEventListener("online", network); window.addEventListener("offline", network); window.addEventListener("popstate", pop);
    window.addEventListener("focus", foreground); document.addEventListener("visibilitychange", foreground);
    void refreshMarkets();
    const timer = window.setInterval(() => { setNow(Date.now()); if (document.visibilityState === "visible") void refreshMarkets(); }, 60000);
    return () => { clearInterval(timer); window.removeEventListener("online", network); window.removeEventListener("offline", network); window.removeEventListener("popstate", pop); window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground); };
  }, [refreshMarkets, select]);
  useEffect(() => {
    if (!topic && snapshotId === null) return;
    let alive = true;
    const load = async () => {
      const request = ++requestId.current;
      try {
        if (snapshotId !== null && (!/^[1-9]\d*$/.test(snapshotId) || !Number.isSafeInteger(Number(snapshotId)))) throw new Error("Invalid historical snapshot ID.");
        // The public response carries the server-validated freshness deadline, including offline evidence.
        const response = await publicRead<ForecastResult>(snapshotId !== null ? `/api/forecasts/snapshot?snapshotId=${snapshotId}` : `/api/forecasts?topicId=${topic}`);
        if (!alive || request !== requestId.current) return;
        if (snapshotId !== null && response.data.forecast && response.data.forecast.snapshotId !== Number(snapshotId)) throw new Error("Historical snapshot does not match the requested evidence.");
        const data = response.data;
        setResult(data); setNow(Date.now()); setCachedAt(response.cachedAt); setForecastError("");
        if (response.data.market) setCadence(response.data.market.cadence);
        const bins = response.data.forecast?.buckets ?? [];
        const nextForecast = response.data.forecast;
        if (nextForecast && bins.length) {
          const target = `${nextForecast.topicId}:${nextForecast.targetAt}`;
          if (boundaryTarget.current !== target) {
            if (boundaryTarget.current !== null || !boundaryEdited.current) setThreshold(defaultBoundary(bins));
            else setThreshold(value => canonicalBoundary(bins, value) ?? value);
            boundaryTarget.current = target;
            boundaryEdited.current = false;
          }
        }
      } catch (e) { if (alive && request === requestId.current) setForecastError(e instanceof Error ? e.message : "Forecast unavailable."); }
       finally { if (alive && request === requestId.current) setLoading(false); }
    };
    void load();
    const timer = snapshotId === null ? setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60000) : undefined;
    const wake = () => { if (document.visibilityState === "visible") { setNow(Date.now()); void load(); } };
    window.addEventListener("online", wake); window.addEventListener("focus", wake); document.addEventListener("visibilitychange", wake);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("online", wake); window.removeEventListener("focus", wake); document.removeEventListener("visibilitychange", wake); };
  }, [topic, snapshotId, retry]);
  useEffect(() => {
    if (!result?.forecast) return;
    const url = new URL(location.href);
    if (Number.isFinite(threshold)) url.searchParams.set("boundary", String(threshold));
    url.searchParams.set("operator", operator);
    history.replaceState(null, "", url);
    window.dispatchEvent(new Event("weather-selection"));
  }, [threshold, operator, result]);
  useEffect(() => {
    if (snapshotId !== null || !result?.forecast) return;
    const deadlines = [Date.parse(result.forecast.targetAt), Date.parse(result.freshUntil ?? "") + 1].filter(value => Number.isFinite(value) && value > Date.now());
    if (!deadlines.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.min(...deadlines) - Date.now(), 2147483647));
    return () => clearTimeout(timer);
  }, [result, snapshotId, now]);
  const forecast = result?.forecast;
  const boundaries = [...new Set(forecast?.buckets.flatMap(b => [b.lower, b.upper]) ?? [])].sort((a, b) => a - b);
  const boundary = canonicalBoundary(forecast?.buckets ?? [], threshold);
  const probability = boundaryProbability(forecast?.buckets ?? [], threshold, operator);
  const expired = !!forecast && now !== null && Date.parse(forecast.targetAt) <= now;
  const age = forecast && now !== null ? Math.max(0, Math.floor((now - Date.parse(forecast.capturedAt)) / 1000)) : null;
  const cached = offline || !!cachedAt;
  const historical = snapshotId !== null;
  const timedResult = historical ? result : currentForecastResult(result, now);
  const currentResult = !historical && (cached || error || forecastError) && timedResult?.status === "ready" ? { ...timedResult, status: "stale" as const } : timedResult;
   const status = historical ? "Historical" : expired ? "Expired" : cached ? "Cached" : error || forecastError ? "Not live" : currentResult?.status === "stale" ? "Stale" : currentResult?.status === "ready" ? forecast?.source === "demo" ? "Demo" : "Live" : loading ? "Updating" : "Unavailable";
  const visibleMarkets = markets?.markets.filter(m => m.cadence === cadence) ?? [];
  const selectedMarket = result?.market ?? (!historical ? markets?.markets.find(m => m.topicId === topic) : undefined);
   const targetAt = forecast?.targetAt ?? selectedMarket?.targetAt;
  const retrievedAt = forecast?.capturedAt ?? result?.provenance?.capturedAt;
  const metrics = quoteMetrics(result);
  const diagnosticGroups = groupDiagnostics(result?.diagnostics ?? []);
   const validationSummary = diagnosticGroups.size > 0 && <div className="validation-summary"><h3>Quotes inconsistent</h3><details><summary>Technical checks ({result?.diagnostics.length})</summary><ul>{[...diagnosticGroups].map(([code, group]) => <li key={code}><strong>{validationLabels[code] ?? code.replace(/[-_]/g, " ")}</strong><p><code>{code}</code> . {group.count} checks</p><details><summary>Examples</summary><ul className="validation-examples" aria-label={`Examples for ${code}`}>{group.examples.map((example, index) => <li key={index}>{example}</li>)}</ul></details></li>)}</ul></details></div>;
  return <>
      {(offline || cachedAt || marketCachedAt) && <div className="notice warning" role="status">{offline ? "Offline" : "Cached data"} . Not live. Alerts paused.</div>}
      {(markets?.source === "demo" || forecast?.source === "demo") && <div className="notice demo"><strong>DEMO</strong> Synthetic quotes . Alerts off</div>}
      {historical && <div className="notice warning" role="status">Historical snapshot #{snapshotId} . Not live <button disabled={!result?.market && !topic} onClick={() => { const id = result?.market?.topicId ?? topic; if (id) select(id, true); }}>Latest outlook <ArrowRight size={16} /></button></div>}
      <section className="outlook" id="outlook">
        {mode === "watches" && <h1>Watches</h1>}
        <div className="forecast-toolbar"><div className="segmented" aria-label="Market cadence">{(["hourly", "daily"] as const).map(c => <button key={c} aria-pressed={cadence === c} onClick={() => changeCadence(c)}>{c === "hourly" ? "Hourly" : "Daily"}</button>)}</div><label className="target-select"><CalendarClock size={18} aria-hidden="true" /><select aria-label="Forecast time" ref={targetSelect} disabled={!visibleMarkets.length} value={visibleMarkets.some(m => m.topicId === topic) ? topic ?? "" : ""} onChange={e => select(Number(e.target.value))}><option value="" disabled>{targetAt && selectedMarket?.cadence === cadence ? compactTime(targetAt) : "Choose a time"}</option>{visibleMarkets.map(m => <option key={m.topicId} value={m.topicId}>{compactTime(m.targetAt)}</option>)}</select></label></div>
        <div className="outlook-meta"><p className="forecast-for">{targetAt ? <>Forecast for <time dateTime={targetAt} aria-label={localTime(targetAt)} title={localTime(targetAt)}>{compactTime(targetAt)}</time></> : "Bitcoin price forecast"}</p><span className={`status ${status === "Live" ? "ready" : ""}`}><i />{status}</span></div>
        {mode === "outlook" && !historical && <Projection cadence={cadence} now={now} offline={offline} topic={topic} onSelect={select} />}
        {(error || forecastError) && forecast && <div className="notice warning" role="alert">Connection lost . Last snapshot, not live.<button onClick={() => { void refreshMarkets(); setRetry(value => value + 1); }}><RefreshCw size={16} />Retry</button></div>}
        {forecast ? <>
          {mode === "outlook" && <ForecastHeadline forecast={forecast} />}
          <div className={`forecast-grid ${mode === "watches" ? "watch-selection" : ""}`}>{mode === "outlook" && <div className="distribution"><h2 className="distribution-title">Distribution</h2><div className="range-strip"><span>{coverageLabel(forecast.summary.central80.probability)}</span><strong>{money(forecast.summary.central80.lower)} - {money(forecast.summary.central80.upper)}</strong></div>{Number.isFinite(threshold) && <Histogram key={forecast.topicId} buckets={forecast.buckets} centralRange={forecast.summary.central80} operator={operator} threshold={threshold} onBoundary={chooseBoundary} />}</div>}
          <aside className="threshold-panel"><div className="probability" aria-live="polite"><div><span className="chance-label">Chance {operator} {Number.isFinite(threshold) ? money(threshold) : "unsupported boundary"}</span><small>Market-implied</small></div><strong>{probability === null ? "Unavailable" : percent(probability)}</strong>{mode === "outlook" && boundary !== null && <a href={selectionHref("/watches", typeof location === "undefined" ? "" : location.search, { threshold: boundary, operator })} title="Watch this boundary" aria-label="Watch this boundary"><ArrowRight size={22} /></a>}</div>{boundary === null && <p className="notice warning" role="alert">This boundary is not offered for this target. Select an offered price to see its chance.</p>}<div className="odds-controls"><div className="segmented" aria-label="Chance direction">{(["above", "below"] as const).map(o => <button key={o} aria-label={`Chance ${o}`} aria-pressed={operator === o} onClick={() => setOperator(o)}>{o === "above" ? "Above" : "Below"}</button>)}</div><select aria-label="Chance price" value={boundary ?? String(threshold)} onChange={e => chooseBoundary(Number(e.target.value))}>{boundary === null && <option value={String(threshold)} disabled>{Number.isFinite(threshold) ? money(threshold) : "Unsupported boundary"}</option>}{boundaries.map(b => <option key={b} value={b}>{money(b)}</option>)}</select></div></aside></div>
          <div className="freshness"><RefreshCw size={13} aria-hidden="true" /><span>{historical ? "Captured" : cached ? "Cached snapshot" : "Updated"} <time dateTime={forecast.capturedAt}>{compactTime(forecast.capturedAt)}</time></span></div>
        </> : <div className="forecast-empty" aria-busy={loading}><Cloud size={64} strokeWidth={1} aria-hidden="true" /><h1>{loading ? "Checking the forecast" : "Forecast unavailable"}</h1><p role="status">{loading ? "Getting market quotes..." : error || forecastError ? "Couldn't reach market quotes." : !visibleMarkets.length && !selectedMarket ? "No times available right now." : "Market quotes need a check."}</p>{!loading && (error || forecastError ? <button className="primary" onClick={() => { void refreshMarkets(); setRetry(value => value + 1); }}><RefreshCw size={16} />Retry</button> : cadence === "hourly" && markets?.markets.some(m => m.cadence === "daily") ? <button className="primary" onClick={() => changeCadence("daily")}>Try daily <ArrowRight size={16} /></button> : visibleMarkets.length > 0 ? <button className="primary" onClick={() => { targetSelect.current?.focus(); targetSelect.current?.showPicker?.(); }}><CalendarClock size={16} />Choose another time</button> : <button className="primary" onClick={() => void refreshMarkets()}><RefreshCw size={16} />Refresh times</button>)}{!loading && (error || forecastError) && cadence === "hourly" && markets?.markets.some(m => m.cadence === "daily") && <button onClick={() => changeCadence("daily")}>Try daily <ArrowRight size={16} /></button>}</div>}
        <div className="method"><Sheet title="Forecast details" trigger={<><Info size={18} />Details</>}><div className="source-details">
          <p>{status} . Observed {retrievedAt ? <time dateTime={retrievedAt}>{utcTime(retrievedAt)}</time> : "time unavailable"}</p>
          <p>24h volume {sats(metrics.volume24hMillisats)} . Total volume {sats(metrics.totalVolumeMillisats)} . Locked liquidity {sats(metrics.liquidityMillisats)}. Observed quote fields: volume_24h_millisats, total_volume_millisats, liquidity_locked_millisats; millisats divided by 1,000, not USD. Missing fields are unavailable.</p>
          {forecast && distributionRanges(forecast.buckets) && <p>Median range: {distributionRanges(forecast.buckets)!.median.label}. Original source bracket; its midpoint is only a representative chart guide. {distributionRanges(forecast.buckets)!.bands.map(b => `Central ${b.nominal * 100}%: ${money(b.lower)} - ${money(b.upper)}, actual included quote share ${percent(b.probability)}.`).join(" ")}</p>}
          <p>Forecast for {targetAt ? <time dateTime={targetAt}>{localTime(targetAt)}</time> : "no time selected"}</p>
          <p>Market-implied chances use normalized YES quote shares, not calibrated probabilities. Above includes whole ranges starting at the chosen price; below includes whole ranges ending there. No within-range interpolation is used.</p>
          <details><summary>Exact time / UTC</summary>{targetAt && <p>Target <time dateTime={targetAt}>{utcTime(targetAt)}</time></p>}{retrievedAt && <p>Retrieved <time dateTime={retrievedAt}>{utcTime(retrievedAt)}</time></p>}<p>Retrieval time is not last-trade time.</p>{cachedAt && <p>Forecast cached {localTime(cachedAt)}</p>}{marketCachedAt && <p>Market list cached {localTime(marketCachedAt)}</p>}</details>
          <div className="source-links"><span>Source {forecast?.source === "demo" || selectedMarket?.source === "demo" ? "Demo (synthetic)" : selectedMarket || forecast ? "Glimpse" : "unavailable"}</span>{selectedMarket?.source === "live" && <a href={`https://www.glimpse.markets/markets/${encodeURIComponent(selectedMarket.batchId)}/${selectedMarket.topicId}`} target="_blank" rel="noreferrer">Market <ExternalLink size={14} /></a>}<a href="https://docs.glimpse.markets/api-reference/nmarket/market-quotes" target="_blank" rel="noreferrer">Quotes <ExternalLink size={14} /></a></div>
          {validationSummary}
          {(error || forecastError) && <details><summary>Connection details</summary><p>{error || forecastError}</p></details>}
          {forecast && <details><summary>Method & evidence . #{forecast.snapshotId}</summary><p>{forecast.caveat}</p><p>Most likely range has {percent(forecast.summary.modalBucket.probability)} of quote share. Chart bar heights show each range's original normalized share, including in the focused view.</p><p>Quote scale: raw total YES quotes = {forecast.originalYesSum}. Source quote scale is not assumed to be a calibrated probability denominator; NO quotes are retained, not used for likelihood.</p><p>Normalized shares: YES quote / total YES quotes = (raw YES / 100) * (100 / total YES quotes). Normalization factor: {forecast.normalizationFactor}. {forecast.normalized ? "Adjusted" : "Unadjusted"} . {forecast.transformationVersion}</p><p>Central range includes {percent(forecast.summary.central80.probability)} of quote share, rounded outward to whole bins. Quotes are not calibrated probabilities. Settlement source and exact equality treatment are not verified.</p><p>{age === null ? "" : `${age}s since retrieval . `}Server status: {result?.status}</p></details>}
          {historical && <p>Captured alert evidence, not the latest outlook. A current watch baseline does not establish a historical change.</p>}
        </div></Sheet></div>
      </section>
      {mode === "watches" && <Watches result={currentResult} threshold={threshold} operator={operator} historical={historical} offline={offline} onSelect={select} />}
  </>;
}
