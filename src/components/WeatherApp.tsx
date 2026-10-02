"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { publicRead } from "../client/api";
import type { Bucket, Cadence, ForecastResult, MarketsResult, Operator } from "../lib/types";
import { Histogram, coverageLabel, defaultBoundary, money, percent } from "./Histogram";
import { Watches } from "./Watches";
import { Cloud, RefreshCw, CalendarClock, ArrowRight } from "lucide-react";
import { Projection } from "./Projection";
import { selectionHref } from "../lib/selection";
import { distributionRanges } from "../lib/projection";

const localTime = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" });
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
  const requestId = useRef(0);
  const autoSelect = useRef(true);
  const boundaryTarget = useRef<string | null>(null);
  const boundaryEdited = useRef(false);
  const chooseBoundary = (value: number) => { boundaryEdited.current = true; setThreshold(value); };
  const select = useCallback((id: number, preserveWatch = false, keepBoundaryContext = false) => {
    autoSelect.current = false;
    boundaryTarget.current = null; boundaryEdited.current = keepBoundaryContext;
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
  const selectHistorical = (id: number) => {
    autoSelect.current = false; ++requestId.current;
    topicRef.current = null; setTopic(null);
    boundaryTarget.current = null; boundaryEdited.current = false;
    snapshotRef.current = String(id); setSnapshotId(String(id));
    setResult(null); setCachedAt(null); setForecastError(""); setLoading(true);
    const url = new URL(location.href); url.searchParams.set("snapshotId", String(id));
    ["market", "topicId", "watch"].forEach(key => url.searchParams.delete(key));
    history.replaceState(null, "", url); window.dispatchEvent(new Event("weather-selection"));
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
  const cached = offline || !!cachedAt;
  const historical = snapshotId !== null;
  const timedResult = historical ? result : currentForecastResult(result, now);
  const currentResult = !historical && (cached || error || forecastError) && timedResult?.status === "ready" ? { ...timedResult, status: "stale" as const } : timedResult;
   const status = historical ? "Historical" : expired ? "Expired" : cached ? "Cached" : error || forecastError ? "Not live" : currentResult?.status === "stale" ? "Stale" : currentResult?.status === "ready" ? forecast?.source === "demo" ? "Demo" : "Live" : loading ? "Updating" : "Unavailable";
  const visibleMarkets = markets?.markets.filter(m => m.cadence === cadence) ?? [];
  const selectedMarket = result?.market ?? (!historical ? markets?.markets.find(m => m.topicId === topic) : undefined);
   const targetAt = forecast?.targetAt ?? selectedMarket?.targetAt;
   const selectionControls = (editing = false) => <><div className="forecast-toolbar"><div className="segmented" aria-label="Market cadence">{(["hourly", "daily"] as const).map(c => <button key={c} type="button" disabled={editing} aria-pressed={cadence === c} onClick={() => changeCadence(c)}>{c === "hourly" ? "Hourly" : "Daily"}</button>)}</div><label className="target-select"><CalendarClock size={18} aria-hidden="true" /><select aria-label="Forecast time" disabled={editing || !visibleMarkets.length} value={visibleMarkets.some(m => m.topicId === topic) ? topic ?? "" : ""} onChange={e => select(Number(e.target.value), false, false)}><option value="" disabled>{targetAt && selectedMarket?.cadence === cadence ? compactTime(targetAt) : "Choose a time"}</option>{visibleMarkets.map(m => <option key={m.topicId} value={m.topicId}>{compactTime(m.targetAt)}</option>)}</select></label></div><div className="outlook-meta"><p className="forecast-for">{targetAt ? <>Forecast for <time dateTime={targetAt} aria-label={localTime(targetAt)} title={localTime(targetAt)}>{compactTime(targetAt)}</time></> : "Bitcoin price forecast"}</p><span className={`status ${status === "Live" ? "ready" : ""}`} role="status" aria-label={status}><i aria-hidden="true" /><span className="sr-only">{status}</span></span></div></>;
   if (mode === "watches") return <Watches result={currentResult} threshold={threshold} operator={operator} historical={historical} offline={offline} selectionControls={selectionControls} targetTimes={Object.fromEntries(markets?.markets.map(m => [m.topicId, m.targetAt]) ?? [])} onSelect={(id, savedThreshold, savedOperator) => { setThreshold(savedThreshold); setOperator(savedOperator); select(id, true, true); }} onOperatorChange={setOperator} onThresholdChange={chooseBoundary} />;
    return <>
      {(markets?.source === "demo" || forecast?.source === "demo") && <span className="demo-badge">Demo</span>}
      <section className="outlook" id="outlook">
        <Projection cadence={cadence} now={now} offline={offline} topic={topic} onSelect={select} onHistorical={selectHistorical}
          cadenceControls={<div className="segmented" aria-label="Market cadence">{(["hourly", "daily"] as const).map(c => <button key={c} aria-pressed={cadence === c} onClick={() => changeCadence(c)}>{c === "hourly" ? "Hourly" : "Daily"}</button>)}</div>}
          forecastLabel={<div className="outlook-meta"><p className="forecast-for">{targetAt ? <>Forecast for <time dateTime={targetAt} aria-label={localTime(targetAt)} title={localTime(targetAt)}>{compactTime(targetAt)}</time></> : "Bitcoin price forecast"}</p><span className={`status ${status === "Live" ? "ready" : ""}`} role="status" aria-label={offline ? "Offline" : marketCachedAt ? "Cached" : status}><i aria-hidden="true" /><span className="sr-only">{offline ? "Offline" : marketCachedAt ? "Cached" : status}</span></span></div>}
        />
        {(error || forecastError) && forecast && <button className="icon-button" title="Retry" aria-label="Retry" onClick={() => { void refreshMarkets(); setRetry(value => value + 1); }}><RefreshCw size={16} /></button>}
        {forecast ? <>
          {mode === "outlook" && <ForecastHeadline forecast={forecast} />}
          <div className="forecast-grid">{mode === "outlook" && <div className="distribution"><h2 className="distribution-title">Distribution</h2><div className="range-strip"><span>{coverageLabel(forecast.summary.central80.probability)}</span><strong>{money(forecast.summary.central80.lower)} - {money(forecast.summary.central80.upper)}</strong></div>{Number.isFinite(threshold) && <Histogram key={forecast.topicId} buckets={forecast.buckets} centralRange={forecast.summary.central80} operator={operator} threshold={threshold} onBoundary={chooseBoundary} />}</div>}
          <aside className="threshold-panel"><div className="probability" aria-live="polite"><div><span className="chance-label">Chance {operator} {Number.isFinite(threshold) ? money(threshold) : "Unavailable"}</span></div><strong>{probability === null ? "Unavailable" : percent(probability)}</strong>{mode === "outlook" && boundary !== null && <a href={selectionHref("/watches", typeof location === "undefined" ? "" : location.search, { threshold: boundary, operator })} title="Watch this boundary" aria-label="Watch this boundary"><ArrowRight size={22} /></a>}</div><div className="odds-controls"><div className="segmented" aria-label="Chance direction">{(["above", "below"] as const).map(o => <button key={o} aria-label={`Chance ${o}`} aria-pressed={operator === o} onClick={() => setOperator(o)}>{o === "above" ? "Above" : "Below"}</button>)}</div><select aria-label="Chance price" value={boundary ?? String(threshold)} onChange={e => chooseBoundary(Number(e.target.value))}>{boundary === null && <option value={String(threshold)} disabled>{Number.isFinite(threshold) ? money(threshold) : "Unavailable"}</option>}{boundaries.map(b => <option key={b} value={b}>{money(b)}</option>)}</select></div></aside></div>
          <div className="sr-only">Updated <time dateTime={forecast.capturedAt}>{compactTime(forecast.capturedAt)}</time></div>
        </> : <div className="forecast-empty" aria-busy={loading}><Cloud size={64} strokeWidth={1} aria-hidden="true" /><h1 role="status">{loading ? "Loading..." : "Unavailable"}</h1>{!loading && <button className="primary" onClick={() => { void refreshMarkets(); setRetry(value => value + 1); }}><RefreshCw size={16} />Retry</button>}</div>}
      </section>
  </>;
}
