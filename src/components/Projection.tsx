"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { publicRead } from "../client/api";
import type { Cadence, TimelineResult } from "../lib/types";
import { bracketDirection, compactPriceRange, dailySlots, DIRECTION_LABELS, guideMidpoint, hourlySlots, heatmapOpacity, horizonTargets, nextHeatmapCell, midpointDirection, pricePosition, projectionModel, quoteShareLabel, type Horizon } from "../lib/projection";
import { CloudOff, CloudRain, CloudSnow, CloudSun, Sun, Wind, ChartNoAxesCombined, Grid2X2, RefreshCw } from "lucide-react";
import { percent } from "./Histogram";

const money = (value: number) => `$${value.toLocaleString("en-US", { maximumFractionDigits: 20 })}`;
const axisWidth = 52;
const PROJECTION_COLORS = { higher: "var(--positive)", lower: "var(--negative)", neutral: "var(--chart-primary)", unavailable: "var(--stale)" };
const axisPrice = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });

const local = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" });
const short = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const weatherIcons = { sunny: Sun, rainy: CloudRain, snowy: CloudSnow, windy: Wind, steady: CloudSun, unavailable: CloudOff };

export function Projection({ cadence, now, offline, topic, onSelect, onHistorical, cadenceControls, forecastLabel }: { cadence: Cadence; now: number | null; offline: boolean; topic: number | null; onSelect: (id: number) => void; onHistorical?: (snapshotId: number) => void; cadenceControls?: ReactNode; forecastLabel?: ReactNode }) {
  const plotClip = useId();
  const scroll = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<TimelineResult | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [inspected, setInspected] = useState<number | null>(null);
  const [clock, setClock] = useState<number | null>(null);
  const [horizon, setHorizon] = useState<Horizon>(7);
  const [view, setView] = useState<"range" | "heatmap">("range");
  const [hasMore, setHasMore] = useState(false);
  const [activeCell, setActiveCell] = useState<{ topicId: number; lower: number } | null>(null);
  const [cellDetail, setCellDetail] = useState<{ topicId: number; lower: number; upper: number; mass: number; targetAt: string } | null>(null);
  const heatmap = useRef<SVGSVGElement>(null);
  const retry = useRef<() => void>(() => {});
  const initialScroll = useRef<string | null>(null);
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
    initialScroll.current = null;
    setData(null); setCachedAt(null); setError(""); setInspected(null);
    const load = async () => {
      const request = ++generation;
      controller?.abort();
      controller = new AbortController();
      try { const response = await publicRead<TimelineResult>(`/api/forecasts/timeline?cadence=${cadence}&limit=32`, controller.signal); if (alive && request === generation) { setData(response.data); setCachedAt(response.cachedAt); setError(""); } }
      catch { if (alive && request === generation) setError("Projection unavailable"); }
    };
    retry.current = () => { void load(); };
    void load(); const wake = () => { if (document.visibilityState === "visible") void load(); };
    const timer = setInterval(wake, 60000);
    window.addEventListener("online", wake); window.addEventListener("focus", wake); document.addEventListener("visibilitychange", wake);
    return () => { alive = false; retry.current = () => {}; controller?.abort(); clearInterval(timer); window.removeEventListener("online", wake); window.removeEventListener("focus", wake); document.removeEventListener("visibilitychange", wake); };
  }, [cadence]);
  const current = now === null ? clock : Math.max(now, clock ?? now);
   const model = data && data.cadence === cadence && current !== null ? projectionModel(horizonTargets(data, current, horizon), current, offline || !!cachedAt || !!error, view, topic ?? inspected) : null;
  const columns = model?.columns ?? [];
   const selected = columns.find(c => c.topicId === inspected) ?? columns.find(c => c.topicId === topic) ?? columns.find(c => c.kind === "future") ?? columns[0];
   const readyCount = columns.filter(c => c.available || c.observed !== null).length;
  const lastCapturedAt = data?.targets.map(result => result.forecast?.capturedAt ?? result.provenance?.capturedAt).filter((at): at is string => !!at).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? data?.collectedAt;
  const slots = current === null ? [] : cadence === "daily" ? dailySlots(columns, current, horizon) : hourlySlots(columns, current, horizon);
  const width = slots.length * 180;
  const top = 16, bottom = 284;
  const slotX = (i: number) => (i + .5) * 180;
  const x = (i: number) => slotX(slots.findIndex(s => s.column === columns[i]));
  const y = (price: number) => pricePosition(price, model?.lower ?? 0, model?.upper ?? 1, top, bottom);
  const columnWidth = 180;
    const guide = (i: number) => columns[i].kind === "past" ? null : guideMidpoint(columns[i], view);
   const choose = (id: number) => { setInspected(id); const column = columns.find(c => c.topicId === id); if (column?.kind === "past") { if (column.result.archive) onHistorical?.(column.result.archive.snapshotId); } else onSelect(id); };
  const reference = model?.reference;
   const directionColor = (a: number, b: number) => PROJECTION_COLORS[midpointDirection(b, a)];
  const updateScroll = () => { const node = scroll.current; setHasMore(!!node && node.scrollLeft + node.clientWidth < node.scrollWidth - 2); };
  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const observer = new ResizeObserver(updateScroll);
    observer.observe(node); updateScroll();
    return () => observer.disconnect();
  }, [width, !!model, readyCount > 0]);
  const pastCount = columns.filter(c => c.kind === "past").length;
  useEffect(() => {
    const selection = `${cadence}:${horizon}`;
    if (!scroll.current || !model || initialScroll.current === selection) return;
    const firstFuture = scroll.current.querySelector<HTMLElement>('[data-kind="future"]');
    if (firstFuture) { scroll.current.scrollLeft += firstFuture.getBoundingClientRect().left - scroll.current.getBoundingClientRect().left; initialScroll.current = selection; updateScroll(); }
  }, [cadence, horizon, !!model, readyCount, pastCount]);
  const ticks = model && readyCount > 0 ? Array.from({ length: 6 }, (_, i) => model.lower + (model.upper - model.lower) * i / 5) : [];
  const cells = columns.flatMap((c, column) => c.available ? (model?.rows ?? []).flatMap((row, r) => c.masses[r] > 0 ? [{ column, row: r, topicId: c.topicId, lower: row.lower, mass: c.masses[r] }] : []) : []);
  const focusCell = cells.find(c => c.topicId === activeCell?.topicId && c.lower === activeCell.lower) ?? [...cells.filter(c => c.topicId === selected?.topicId)].sort((a, b) => b.mass - a.mass)[0] ?? cells[0];
  const inspectCell = (column: number, row: number) => {
    const c = columns[column], band = model!.rows[row];
    setActiveCell({ topicId: c.topicId, lower: band.lower });
    setCellDetail({ topicId: c.topicId, targetAt: c.targetAt, ...band, mass: c.masses[row] });
  };
  const visibleDetail = view === "heatmap" && cellDetail && columns.some(c => c.available && c.topicId === cellDetail.topicId && model?.rows.some((r, i) => r.lower === cellDetail.lower && r.upper === cellDetail.upper && c.masses[i] === cellDetail.mass)) ? cellDetail : null;
  return <section className="projection" aria-label="Forecast projection">
    {data?.source === "demo" && <span className="demo-badge">Demo</span>}
    <div className="projection-toolbar">
      <div className="projection-controls">
        {cadenceControls}<div className="segmented" aria-label="Projection view"><button aria-pressed={view === "range"} onClick={() => setView("range")}><ChartNoAxesCombined size={16} />Range</button><button aria-pressed={view === "heatmap"} onClick={() => setView("heatmap")}><Grid2X2 size={16} />Heatmap</button></div>
        <label className="projection-horizon"><select aria-label="Forecast horizon" value={horizon} onChange={e => setHorizon(Number(e.target.value) as Horizon)}>{([3, 7, 14] as const).map(value => <option key={value} value={value} aria-label={`${value} ${cadence === "daily" ? "days" : "hours"}`} title={`${value} ${cadence === "daily" ? "days" : "hours"}`}>{value}{cadence === "daily" ? "d" : "h"}</option>)}</select></label>
      </div>
      {forecastLabel}
    </div>
    <div className="projection-legend" role="group" aria-label={view === "range" ? "Central uncertainty bands and median" : "Red below reference, green above; brighter means more weight"}>{view === "range" ? <><span><i className="band-50" aria-hidden="true" />50%</span><span><i className="band-80" aria-hidden="true" />80%</span><span><i className="band-90" aria-hidden="true" />90%</span><span><i className="median-key" aria-hidden="true" />Median</span></> : <><span><i style={{ background: PROJECTION_COLORS.lower }} aria-hidden="true" />Below</span><span><i style={{ background: PROJECTION_COLORS.higher }} aria-hidden="true" />Above</span><span><i style={{ background: PROJECTION_COLORS.neutral }} aria-hidden="true" />Overlap</span><span>0% <i className="heatmap-intensity" aria-hidden="true" />{quoteShareLabel(model?.peakMass ?? 0)}</span></>}</div>
    {view === "heatmap" && model?.focus && <p className="projection-focus small">{compactPriceRange(model)}</p>}
    {model && readyCount > 0 && slots.length > 0 ? <div className="forecast-strip" data-more={hasMore} data-view={view}>
      <div className="projection-price-axis" aria-label="Price axis"><span>USD</span><svg width={axisWidth} height="300" viewBox={`0 0 ${axisWidth} 300`} preserveAspectRatio="none" role="img" aria-label="Price scale">{ticks.map(price => <text key={price} x={axisWidth - 6} y={y(price) + 4} textAnchor="end" className="projection-axis"><title>{money(price)}</title>{axisPrice.format(price)}</text>)}</svg></div>
      <div className="projection-scroll" ref={scroll} onScroll={updateScroll} tabIndex={0} role="region" aria-label={`${cadence === "daily" ? "Daily" : "Hourly"} forecast and price ranges`} onKeyDown={e => { if (e.target === e.currentTarget && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { e.preventDefault(); e.currentTarget.scrollTo({ left: e.key === "Home" ? 0 : e.key === "End" ? e.currentTarget.scrollWidth : e.currentTarget.scrollLeft + (e.key === "ArrowRight" ? 1 : -1) * e.currentTarget.clientWidth * .8 }); } }}>
      <div className="forecast-columns" style={{ width: `calc(${slots.length} * var(--forecast-column-width))` }}>
      <svg ref={heatmap} className="forecast-range-plot" width={width} height="300" viewBox={`0 0 ${width} 300`} preserveAspectRatio="none" role={view === "range" ? "img" : "group"} aria-label={view === "range" ? "Whole-bin central 50, 80 and 90 percent uncertainty bands with median range representative midpoint guide" : "Quote-share heatmap with modal range representative midpoint guide"}>
      {slots.map((slot, i) => <g key={slot.date}>{!slot.column && <rect data-testid="missing-date" x={slotX(i) - columnWidth / 2} y={top} width={columnWidth} height={bottom - top} fill="var(--stale)" fillOpacity=".16"><title>{`${slot.date}: Unavailable`}</title></rect>}</g>)}
      {ticks.map(price => <line key={price} x1="0" x2={width} y1={y(price)} y2={y(price)} className="grid-line" />)}
      {pastCount > 0 && <g data-testid="now-divider"><line x1={pastCount * columnWidth} x2={pastCount * columnWidth} y1="0" y2="300" stroke="var(--ink)" strokeOpacity=".6" strokeDasharray="2 4" /><text x={pastCount * columnWidth + 8} y="12" fill="var(--ink)" fontSize="11">{cadence === "daily" ? "TODAY" : "NOW"}</text></g>}
      {view === "range" && model.bandSegments.flatMap((segment, s) => [2, 1, 0].map(b => {
        // Straight connectors are visual guides between independent settlements, not a joint path.
        const upper = segment.map(i => `${x(i)},${y(columns[i].ranges!.bands[b].upper)}`);
        const lower = [...segment].reverse().map(i => `${x(i)},${y(columns[i].ranges!.bands[b].lower)}`);
         return segment.length > 1 ? <polygon key={`${s}-${b}`} data-testid={`fan-${[50, 80, 90][b]}`} points={[...upper, ...lower].join(" ")} className={`fan-band band-${[50, 80, 90][b]}`} style={segment.every(i => columns[i].kind === "past") ? { opacity: .45 } : undefined} /> : null;
      }))}
      {columns.map((c, i) => <g key={c.topicId} opacity={c.kind === "past" ? .45 : undefined}>{!c.available ? <rect x={x(i) - columnWidth / 2} y={top} width={columnWidth} height={bottom - top} fill="var(--stale)" fillOpacity=".16" /> : view === "heatmap" ? model.rows.map((row, r) => c.masses[r] > 0 && <g key={row.lower}>
        <rect data-testid="heatmap-cell" x={x(i) - columnWidth / 2} y={y(row.upper)} width={columnWidth} height={y(row.lower) - y(row.upper)} fill={PROJECTION_COLORS[reference ? bracketDirection(row, reference.ranges.median) : "neutral"]} fillOpacity={heatmapOpacity(c.masses[r], model.peakMass)} role="button" tabIndex={focusCell?.column === i && focusCell.row === r ? 0 : -1} data-cell={`${i}-${r}`} aria-label={`${short(c.targetAt)} ${money(row.lower)}-${money(row.upper)} quote share ${quoteShareLabel(c.masses[r])}`} onMouseEnter={() => inspectCell(i, r)} onFocus={() => inspectCell(i, r)} onClick={() => inspectCell(i, r)} onKeyDown={e => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
            e.preventDefault(); const next = nextHeatmapCell(columns, model.rows, { column: i, row: r }, e.key);
            inspectCell(next.column, next.row); heatmap.current?.querySelector<SVGRectElement>(`[data-cell="${next.column}-${next.row}"]`)?.focus();
          } else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inspectCell(i, r); choose(c.topicId); }
        }}><title>{`${short(c.targetAt)} . ${money(row.lower)} - ${money(row.upper)}: ${quoteShareLabel(c.masses[r])} quote share`}</title></rect>
      </g>) : model.bandSegments.some(segment => segment.length === 1 && segment[0] === i) ? [...c.ranges!.bands].reverse().map(b => <rect key={b.nominal} x={x(i) - 7} y={y(b.upper)} width="14" height={y(b.lower) - y(b.upper)} className={`fan-band band-${b.nominal * 100}`}><title>{`Central ${b.nominal * 100}%: ${money(b.lower)} - ${money(b.upper)}; included quote share ${percent(b.probability)}`}</title></rect>) : null}
      </g>)}
      <defs><clipPath id={plotClip}><rect x="0" y={top} width={width} height={bottom - top} /></clipPath></defs>
         {model.segments.filter(segment => columns[segment[0]].kind === "future").map((segment, i) => <g className="projection-guide" key={i} clipPath={`url(#${plotClip})`} data-testid={view === "range" ? "median-guide" : "modal-guide"}>{segment.length === 1 && <polyline points={`${x(segment[0])},${y(guide(segment[0])!)}`} fill="none" stroke={PROJECTION_COLORS.neutral} />}{segment.slice(1).map((index, j) => { const previous = segment[j]; const coordinates = { x1: x(previous), y1: y(guide(previous)!), x2: x(index), y2: y(guide(index)!) }; return <g key={index} data-testid="guide-segment"><line {...coordinates} className="projection-guide-direction" data-testid="guide-direction" stroke={directionColor(guide(previous)!, guide(index)!)} strokeWidth="3" strokeDasharray="6 5" /></g>; })}</g>)}
         {columns.map((c, i) => {
           if (c.observed === null) return null;
           const next = columns[i + 1];
           const adjacent = next && Date.parse(next.targetAt) - Date.parse(c.targetAt) === (cadence === "daily" ? 86400000 : 3600000);
           const nextPrice = adjacent ? guideMidpoint(next, view) : null;
           const edge = Math.max(model.lower, Math.min(model.upper, c.observed));
           return <g key={`observed-${c.targetAt}`} clipPath={`url(#${plotClip})`} data-testid="observed-price">
              {nextPrice !== null && <line x1={x(i)} y1={y(c.observed)} x2={x(i + 1)} y2={y(nextPrice)} stroke={next.kind === "past" ? "var(--ink)" : directionColor(c.observed, nextPrice)} strokeWidth="3" strokeDasharray={next.kind === "past" ? undefined : "6 5"} data-testid={next.kind === "past" ? "observed-segment" : "forecast-transition"} />}
              <circle cx={x(i)} cy={y(edge)} r="4" fill="var(--ink)"><title>{`Actual ${money(c.observed)}${edge !== c.observed ? " (outside focused range)" : ""}`}</title></circle>
              {edge !== c.observed && <text x={x(i) + 8} y={y(edge) + (edge === model.upper ? 14 : -8)} fill="var(--ink)" fontSize="11">{c.observed > model.upper ? "Above focus" : "Below focus"}</text>}
           </g>;
         })}
        {columns.map((c, i) => <g className="projection-guide" key={c.topicId}>{guide(i) !== null && <g clipPath={`url(#${plotClip})`}><circle aria-hidden="true" cx={x(i)} cy={y(guide(i)!)} r="6" fill="var(--ink)" /><circle cx={x(i)} cy={y(guide(i)!)} r="4" fill={PROJECTION_COLORS[c.direction]} stroke="var(--background)" strokeWidth="2" /></g>}{view === "range" && <rect x={x(i) - columnWidth / 2} y={top} width={columnWidth} height={bottom - top} fill="transparent" stroke="none">{c.ranges && <title>{c.ranges.bands.map(b => `Central ${b.nominal * 100}%: ${money(b.lower)} - ${money(b.upper)}; included quote share ${percent(b.probability)}`).join("\n")}</title>}</rect>}</g>)}
        {view === "heatmap" && columns.map((c, i) => c.available && <g className="heatmap-labels" key={c.topicId}>{model.rows.map((row, r) => { const center = (y(row.lower) + y(row.upper)) / 2; return c.masses[r] >= .03 && y(row.lower) - y(row.upper) >= 19.2 && <g key={row.lower}><rect aria-hidden="true" x={x(i) + 13} y={center - 9} width="50" height="18" rx="3" fill="var(--weight-plate)" /><text className="heatmap-share" x={x(i) + 38} y={center} textAnchor="middle" dominantBaseline="middle">{quoteShareLabel(c.masses[r])}</text></g>; })}</g>)}
      </svg>
        {slots.map(({ date, column: c }) => {
          const past = c?.kind === "past";
          const outlook = c?.outlook ?? "unavailable";
          const direction = c?.direction ?? "unavailable";
          const sentiment = c?.sentiment;
          const label = past ? direction === "unavailable" ? c?.observed === null ? "Unavailable" : "Observed" : DIRECTION_LABELS[direction] : sentiment?.label ?? "\u2014";
          const sentimentDescription = sentiment?.label && sentiment.reference ? `${sentiment.label}, reference ${money(sentiment.reference.value)} at ${local(sentiment.reference.time)}, quote weight above ${quoteShareLabel(sentiment.up!)}, below ${quoteShareLabel(sentiment.down!)}, undecided ${quoteShareLabel(sentiment.undecided!)}` : "Sentiment unavailable";
          const labelColor = past ? direction === "unavailable" ? "var(--ink)" : PROJECTION_COLORS[direction] : sentiment?.label === "Bullish" ? PROJECTION_COLORS.higher : sentiment?.label === "Bearish" ? PROJECTION_COLORS.lower : sentiment?.label === "Mixed" ? PROJECTION_COLORS.neutral : PROJECTION_COLORS.unavailable;
          const Icon = weatherIcons[past && direction === "unavailable" ? "steady" : outlook];
          const bracket = view === "range" ? c?.ranges?.median : c?.available ? c.result.forecast?.summary.modalBucket : null;
          return <button data-testid="calendar-slot" data-kind={c?.kind ?? "future"} data-direction={direction} className={`forecast-column outlook-${outlook}`} key={date} disabled={!c} aria-pressed={!!c && selected?.topicId === c.topicId} aria-label={c ? `${local(c.targetAt)}, ${c.reason}${past ? `, ${label}, observed ${c.observed === null ? "unavailable" : money(c.observed)}` : `, ${sentimentDescription}`}${bracket ? `, ${view === "range" ? "median" : "modal"} range ${bracket.label}` : ""}` : `${date}, No market discovered, Sentiment unavailable`} onClick={() => c && choose(c.topicId)}>
            <span className="forecast-column-header"><time dateTime={date}>{new Date(date.length === 10 ? `${date}T12:00:00Z` : date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(cadence === "daily" ? { timeZone: "UTC" } : {}) })}<small>{cadence === "daily" ? "00:00 UTC" : new Date(date).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</small></time>
            <span className="tile-outlook"><Icon size={26} role="img" aria-label={past ? label : `${sentiment?.label ?? "Sentiment unavailable"}${outlook === "windy" ? ", Wide range" : ""}`} /><span style={{ color: labelColor }}>{label}{outlook === "windy" && <small className="forecast-guide-label">Wide range</small>}</span></span>
            <span className="forecast-guide-label">{past ? "Observed close" : `${view === "range" ? "Median" : "Modal"} range`}</span><strong>{past ? c?.observed === null ? "Unavailable" : money(c!.observed!) : bracket ? compactPriceRange(bracket) : "Unavailable"}</strong>
            </span>
          </button>;
        })}
      </div></div></div> : <div className="projection-empty"><p role="status">{!data && !error ? "Loading..." : "Unavailable"}</p>{lastCapturedAt && <time className="sr-only" dateTime={lastCapturedAt}>{local(lastCapturedAt)}</time>}<button onClick={() => retry.current()}><RefreshCw size={16} />Retry</button></div>}
    {view === "heatmap" && <div className="heatmap-inspection" aria-live="polite" role="status">{visibleDetail ? `${short(visibleDetail.targetAt)} . ${compactPriceRange(visibleDetail)} . ${quoteShareLabel(visibleDetail.mass)} quote share` : ""}</div>}
      <div className="projection-reference projection-line-legend small" role="group" aria-label="Actual and forecast lines"><span aria-label="Actual, solid line"><i className="actual-line-key" aria-hidden="true" />Actual</span><span aria-label="Forecast, dashed line"><i className="forecast-line-key" aria-hidden="true" />Forecast</span></div>
     {view === "heatmap" && reference && <p className="projection-reference small">Reference {compactPriceRange(reference.ranges.median)}</p>}
  </section>;
}
