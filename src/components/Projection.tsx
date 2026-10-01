"use client";
import { useEffect, useId, useState } from "react";
import { publicRead } from "../client/api";
import type { Cadence, TimelineResult } from "../lib/types";
import { bracketDirection, compactPriceRange, dailySlots, horizonTargets, millisatsToSats, OUTLOOK_LABELS, pricePosition, PROJECTION_COLORS, projectionModel, quoteMetrics, type Horizon } from "../lib/projection";
import { CloudOff, CloudRain, CloudSnow, CloudSun, Sun, Wind, ChartNoAxesCombined, Grid2X2 } from "lucide-react";
import { percent } from "./Histogram";

const money = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 20 })}`;

const local = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" });
const utc = (value: string) => new Date(value).toISOString().replace("T", " ").replace("Z", " UTC");
const short = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const weatherIcons = { sunny: Sun, rainy: CloudRain, snowy: CloudSnow, windy: Wind, steady: CloudSun, unavailable: CloudOff };

export function Projection({ cadence, now, offline, topic, onSelect }: { cadence: Cadence; now: number | null; offline: boolean; topic: number | null; onSelect: (id: number) => void }) {
  const plotClip = useId();
  const [data, setData] = useState<TimelineResult | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [inspected, setInspected] = useState<number | null>(null);
  const [clock, setClock] = useState<number | null>(null);
  const [horizon, setHorizon] = useState<Horizon>(7);
  const [view, setView] = useState<"range" | "heatmap">("range");
  useEffect(() => {
    if (clock === null) { setClock(Date.now()); return; }
    const deadlines = data?.targets.flatMap(r => [Date.parse(r.market?.targetAt ?? ""), Date.parse(r.freshUntil ?? "") + 1]).filter(at => Number.isFinite(at) && at > Date.now()) ?? [];
    if (!deadlines.length) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.min(Math.min(...deadlines) - Date.now(), 2147483647));
    return () => clearTimeout(timer);
  }, [data, clock, now]);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    let controller: AbortController | undefined;
    setData(null); setCachedAt(null); setError(""); setInspected(null);
    const load = async () => {
      const request = ++generation;
      controller?.abort();
      controller = new AbortController();
      try { const response = await publicRead<TimelineResult>(`/api/forecasts/timeline?cadence=${cadence}&limit=32`, controller.signal); if (alive && request === generation) { setData(response.data); setCachedAt(response.cachedAt); setError(""); } }
      catch { if (alive && request === generation) setError("Projection unavailable"); }
    };
    void load(); const wake = () => { if (document.visibilityState === "visible") void load(); };
    const timer = setInterval(wake, 60000);
    window.addEventListener("online", wake); window.addEventListener("focus", wake); document.addEventListener("visibilitychange", wake);
    return () => { alive = false; controller?.abort(); clearInterval(timer); window.removeEventListener("online", wake); window.removeEventListener("focus", wake); document.removeEventListener("visibilitychange", wake); };
  }, [cadence]);
  const current = now === null ? clock : Math.max(now, clock ?? now);
  const model = data && current !== null ? projectionModel(horizonTargets(data, current, horizon), current, offline || !!cachedAt || !!error, view) : null;
  const columns = model?.columns ?? [];
  const selected = columns.find(c => c.topicId === inspected) ?? columns.find(c => c.topicId === topic) ?? columns[0];
  const readyCount = columns.filter(c => c.available).length;
  const slots = cadence === "daily" && current !== null ? dailySlots(columns, current, horizon) : columns.map(c => ({ date: c.targetAt, column: c }));
  const times = slots.map(s => Date.parse(s.date));
  const first = times[0] ?? 0, last = times.at(-1) ?? first;
  const minimumGap = Math.min(...times.slice(1).map((at, i) => at - times[i]).filter(gap => gap > 0));
  const width = Math.max(640, slots.length * 92 + 150, Number.isFinite(minimumGap) ? (last - first) / minimumGap * 92 + 150 : 0);
  const left = 90, right = width - 60, top = 28, bottom = 270;
  const slotX = (i: number) => left + (times[i] - first) / Math.max(last - first, 1) * (right - left);
  const x = (i: number) => slotX(slots.findIndex(s => s.column === columns[i]));
  const y = (price: number) => pricePosition(price, model?.lower ?? 0, model?.upper ?? 1, top, bottom);
  const columnWidth = slots.length > 1 ? Math.min(72, ...slots.slice(1).map((_, i) => (slotX(i + 1) - slotX(i)) * .8)) : 48;
  const guide = (i: number) => view === "range" ? columns[i].ranges?.midpoint ?? null : columns[i].midpoint;
  const choose = (id: number) => { setInspected(id); onSelect(id); };
  const sats = (value: number | null | undefined) => { const amount = millisatsToSats(value); return amount === null ? "Unavailable" : `${amount.toLocaleString(undefined, { maximumFractionDigits: 3 })} sats`; };
  const metrics = quoteMetrics(selected?.result);
  const reference = model?.reference;
  const directionColor = (a: number, b: number) => PROJECTION_COLORS[b > a ? "higher" : b < a ? "lower" : "neutral"];
  return <section className="projection" aria-labelledby="projection-title">
    <div className="section-heading"><h2 id="projection-title">Bitcoin weather</h2><span className="small">{offline || cachedAt ? "Cached" : data?.source === "demo" ? "Demo" : readyCount ? "Market-implied" : "Not live"}</span></div>
    <div className="projection-controls"><div className="segmented" aria-label="Projection view"><button aria-pressed={view === "range"} onClick={() => setView("range")}><ChartNoAxesCombined size={16} />Range</button><button aria-pressed={view === "heatmap"} onClick={() => setView("heatmap")}><Grid2X2 size={16} />Heatmap</button></div><label>Horizon<select aria-label="Projection horizon" value={horizon} onChange={e => setHorizon(Number(e.target.value) as Horizon)}>{([3, 7, 14] as const).map(value => <option key={value} value={value}>{value} {cadence === "daily" ? "days" : "hours"}</option>)}</select></label></div>
    <p className="projection-reference small" title={reference ? `Reference original median bracket: ${money(reference.ranges.median.lower)} - ${money(reference.ranges.median.upper)}. Not a spot price.` : undefined}>Market outlook{reference ? ` . Compared with ${short(reference.targetAt)}` : " . No fresh reference"}</p>
    <div className="projection-legend">{view === "range" ? <><span><i className="band-90" />Central 90%</span><span><i className="band-80" />Central 80%</span><span><i className="band-50" />Central 50%</span><span>Median range representative midpoint</span></> : <><span>Focused price range</span><span><i style={{ background: PROJECTION_COLORS.lower }} />Lower</span><span><i style={{ background: PROJECTION_COLORS.higher }} />Higher</span><span>Brighter = more likely</span></>}</div>
    {model && slots.length > 0 ? <div className="projection-scroll" tabIndex={0} aria-label="Price ranges over target times"><svg width={width} height="330" viewBox={`0 0 ${width} 330`} role="img" aria-label={view === "range" ? "Whole-bin central 50, 80 and 90 percent uncertainty bands with median range representative midpoint guide" : "Quote-share heatmap with modal range representative midpoint guide"}>
      {slots.map((slot, i) => <g key={slot.date} data-testid="calendar-slot">{!slot.column && <rect data-testid="missing-date" x={slotX(i) - columnWidth / 2} y={top} width={columnWidth} height={bottom - top} fill="#8c9599" fillOpacity=".16"><title>{`${slot.date}: No market discovered`}</title></rect>}<text x={slotX(i)} y="300" textAnchor="middle" className="projection-axis">{new Date(slot.date).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(cadence === "daily" ? { timeZone: "UTC" } : {}) })}</text><text x={slotX(i)} y="318" textAnchor="middle" className="projection-axis">{cadence === "daily" ? "00:00 UTC" : new Date(slot.date).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</text></g>)}
      {Array.from({ length: 6 }, (_, i) => model.lower + (model.upper - model.lower) * i / 5).map(price => <g key={price}><line x1={left - 35} x2={right + 35} y1={y(price)} y2={y(price)} className="grid-line" /><text x={left - 42} y={y(price) + 4} textAnchor="end" className="projection-axis">{money(price)}</text></g>)}
      {view === "range" && model.segments.flatMap((segment, s) => [2, 1, 0].map(b => {
        // Straight connectors are visual guides between independent settlements, not a joint path.
        const upper = segment.map(i => `${x(i)},${y(columns[i].ranges!.bands[b].upper)}`);
        const lower = [...segment].reverse().map(i => `${x(i)},${y(columns[i].ranges!.bands[b].lower)}`);
        return segment.length > 1 ? <polygon key={`${s}-${b}`} data-testid={`fan-${[50, 80, 90][b]}`} points={[...upper, ...lower].join(" ")} className={`fan-band band-${[50, 80, 90][b]}`} /> : null;
      }))}
      {columns.map((c, i) => <g key={c.topicId}>{!c.available ? <rect x={x(i) - columnWidth / 2} y={top} width={columnWidth} height={bottom - top} fill="#8c9599" fillOpacity=".16" /> : view === "heatmap" ? model.rows.map((row, r) => <rect data-testid="heatmap-cell" key={row.lower} x={x(i) - columnWidth / 2} y={y(row.upper)} width={columnWidth} height={y(row.lower) - y(row.upper)} fill={PROJECTION_COLORS[reference ? bracketDirection(row, reference.ranges.median) : "neutral"]} fillOpacity={.08 + Math.sqrt(Math.min(1, c.masses[r])) * .92}><title>{`${money(row.lower)} - ${money(row.upper)}: ${percent(c.masses[r])} quote share`}</title></rect>) : model.segments.some(segment => segment.length === 1 && segment[0] === i) ? [...c.ranges!.bands].reverse().map(b => <rect key={b.nominal} x={x(i) - 7} y={y(b.upper)} width="14" height={y(b.lower) - y(b.upper)} className={`fan-band band-${b.nominal * 100}`}><title>{`Central ${b.nominal * 100}%: ${money(b.lower)} - ${money(b.upper)}; included quote share ${percent(b.probability)}`}</title></rect>) : null}</g>)}
      <defs><clipPath id={plotClip}><rect x="0" y={top} width={width} height={bottom - top} /></clipPath></defs>
      {model.segments.map((segment, i) => <g key={i} clipPath={`url(#${plotClip})`} data-testid={view === "range" ? "median-guide" : "modal-guide"}>{segment.length === 1 && <polyline points={`${x(segment[0])},${y(guide(segment[0])!)}`} fill="none" stroke={PROJECTION_COLORS.neutral} />}{segment.slice(1).map((index, j) => { const previous = segment[j]; return <line key={index} x1={x(previous)} y1={y(guide(previous)!)} x2={x(index)} y2={y(guide(index)!)} stroke={directionColor(guide(previous)!, guide(index)!)} strokeWidth="3" />; })}</g>)}
      {columns.map((c, i) => <g key={c.topicId}>{guide(i) !== null && <circle clipPath={`url(#${plotClip})`} cx={x(i)} cy={y(guide(i)!)} r="4" fill="#ffbc48" stroke="#182024" strokeWidth="2" />}<rect x={x(i) - columnWidth / 2} y={top} width={columnWidth} height={bottom - top} fill="transparent" stroke={selected?.topicId === c.topicId ? "#ffffff" : "none"} tabIndex={0} role="button" aria-label={`${local(c.targetAt)}, ${c.reason}${c.ranges ? `, median range ${c.ranges.median.label}` : ""}`} onClick={() => choose(c.topicId)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(c.topicId); } }}>{c.ranges && <title>{c.ranges.bands.map(b => `Central ${b.nominal * 100}%: ${money(b.lower)} - ${money(b.upper)}; included quote share ${percent(b.probability)}`).join("\n")}</title>}</rect></g>)}
    </svg></div> : <p className="projection-empty" role="status">{error || !data ? error || "Checking target times..." : "No validated fresh targets in this horizon."}</p>}
    <div className="daily-tiles" aria-label={cadence === "daily" ? "Daily targets" : "Hourly targets"}>{slots.map(({ date, column: c }) => { const outlook = c?.outlook ?? "unavailable"; const Icon = weatherIcons[outlook]; return <button className={`day-tile outlook-${outlook}`} key={date} disabled={!c} aria-pressed={!!c && topic === c.topicId} onClick={() => c && choose(c.topicId)}><time dateTime={date}>{new Date(date.length === 10 ? `${date}T12:00:00Z` : date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(cadence === "daily" ? { timeZone: "UTC" } : {}) })}{cadence === "hourly" && <small>{new Date(date).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</small>}</time><div className="tile-outlook"><Icon size={28} role="img" aria-label={`Market outlook: ${OUTLOOK_LABELS[outlook]}`} /><span>{OUTLOOK_LABELS[outlook]}</span></div><strong>{c?.ranges ? compactPriceRange(c.ranges.median) : "Unavailable"}</strong><span>{c?.reason ?? "No market discovered"}</span><small>Range width {c?.ranges ? money(c.ranges.bands[1].upper - c.ranges.bands[1].lower) : "unavailable"}</small></button>; })}</div>
    {selected && <div className="projection-detail" aria-live="polite"><strong>Median range {selected.ranges?.median.label ?? "unavailable"}</strong><span>{selected.reason} . {short(selected.targetAt)}</span><span>Source {selected.result.market?.source === "demo" ? "Demo" : "Glimpse"} . 24h volume {sats(metrics.volume24hMillisats)} . Locked liquidity {sats(metrics.liquidityMillisats)}</span></div>}
    {data && <details><summary>Details</summary>
      <p className="small">Independent settlement distributions, not a joint price path. The line represents the midpoint of the {view === "range" ? "median-containing" : "modal"} original bracket, not an exact price prediction. Central bands round outward to whole original bins; no smoothing or within-bin CDF interpolation. Missing, invalid and stale targets break connections. Range width uses the central 80% whole-bin interval. Daily calendar tiles use UTC dates.</p>
      <p className="small">{reference ? `Reference: first fresh valid target in this horizon, ${utc(reference.targetAt)}, original median bracket ${money(reference.ranges.median.lower)} - ${money(reference.ranges.median.upper)}, representative midpoint ${money(reference.ranges.midpoint)}.` : "No fresh valid reference available."} No external spot price is used. Market outlook describes bracket comparisons, not proven sentiment or actual price moves. Nonoverlapping higher median brackets are sunny; lower brackets are rainy, or snowy when their representative midpoint is at least 3% lower. Overlapping brackets are steady. Central 80% width of at least 8% of its representative median midpoint takes precedence as a wide, windy range. The reference itself is steady.</p>
      <p className="small">As of {utc(data.asOf)} . Collection {data.collectedAt ? utc(data.collectedAt) : "unavailable"}{cachedAt ? ` . Cached ${utc(cachedAt)}` : ""}. Heatmap focuses on the union of central 90% whole-bin intervals plus two source bins on each side, clamped to original support. Aligned equal-width bins are grouped without splitting into at most 40 rows (at least 6 pixels per row). Excluded tails are not renormalized; displayed shares need not sum to 100%. Green is above the reference original bracket, red below, amber overlapping. Brightness increases with normalized market quote weight, not calibrated probability or validated accuracy.</p>
      <div className="performance-table"><table><caption>Original brackets and actual included quote share</caption><thead><tr><th>Target UTC</th><th>Median range</th><th>Central intervals / actual coverage</th><th>Outside focused range</th><th>Status / observed UTC</th></tr></thead><tbody>{columns.map(c => <tr key={c.topicId}><td>{utc(c.targetAt)}</td><td>{c.ranges?.median.label ?? "Unavailable"}</td><td>{c.ranges?.bands.map(b => <div key={b.nominal}>Central {b.nominal * 100}%: {money(b.lower)} - {money(b.upper)} . Included {percent(b.probability)}</div>) ?? "Unavailable"}</td><td>{c.omittedMass === null ? view === "range" ? "Heatmap only" : "Unavailable" : `${percent(c.omittedMass)} quote share`}</td><td>{c.reason}<br />{c.result.forecast ? utc(c.result.forecast.capturedAt) : c.result.provenance ? utc(c.result.provenance.capturedAt) : "No snapshot"}</td></tr>)}</tbody></table></div>
    </details>}
  </section>;
}
