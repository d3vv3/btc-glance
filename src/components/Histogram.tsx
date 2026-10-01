"use client";

import { useId, useState, type PointerEvent } from "react";
import type { Bucket, Operator } from "../lib/types";

export const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
export const percent = (n: number) => `${(n * 100).toFixed(1)}%`;
export const coverageLabel = (n: number) => `${percent(n).replace(".0%", "%")} of market forecast`;

export const defaultBoundary = (buckets: Bucket[]) => buckets.reduce<Bucket | undefined>((peak, bucket) => !peak || bucket.probability > peak.probability ? bucket : peak, undefined)?.upper ?? 0;

export function Histogram({ buckets, centralRange, threshold, operator, onBoundary }: { buckets: Bucket[]; centralRange?: { lower: number; upper: number }; threshold: number; operator: Operator; onBoundary: (value: number) => void }) {
  const [active, setActive] = useState<number | null>(null);
  const id = useId();
  const selected = buckets.find(b => b.optionId === active);
  const first = centralRange ? buckets.findIndex(b => b.upper > centralRange.lower) : 0;
  const last = centralRange ? buckets.findLastIndex(b => b.lower < centralRange.upper) : buckets.length - 1;
  const outsideFocus = threshold < (buckets[Math.max(0, first - 2)]?.lower ?? 0) || threshold > (buckets[Math.min(buckets.length - 1, last + 2)]?.upper ?? 0);
  const boundaryIndex = outsideFocus ? buckets.findIndex(b => b.lower <= threshold && b.upper >= threshold) : -1;
  const visible = centralRange && first >= 0 && last >= first
    ? buckets.slice(Math.max(0, Math.min(first, boundaryIndex < 0 ? first : boundaryIndex) - 2), Math.max(last, boundaryIndex) + 3)
    : buckets;
  const outsideShare = buckets.filter(b => !visible.includes(b)).reduce((sum, b) => sum + b.probability, 0);
  const max = Math.max(...visible.map(b => b.probability), .01);
  const lower = visible[0]?.lower ?? 0;
  const upper = visible.at(-1)?.upper ?? 1;
  const marker = Math.max(lower, Math.min(upper, threshold));
  const x = (value: number) => 60 + (value - lower) / Math.max(upper - lower, 1) * 620;
  const boundaries = [...new Set(buckets.flatMap(b => [b.lower, b.upper]))].sort((a, b) => a - b);
  const peak = buckets.reduce<Bucket | undefined>((best, b) => !best || b.probability > best.probability ? b : best, undefined);
  const move = (event: PointerEvent<SVGGElement>) => {
    const svg = event.currentTarget.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix || !boundaries.length) return;
    const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    const value = lower + (point.matrixTransform(matrix.inverse()).x - 60) / 620 * (upper - lower);
    onBoundary(boundaries.reduce((nearest, boundary) => Math.abs(boundary - value) < Math.abs(nearest - value) ? boundary : nearest));
  };
  return <div className="histogram">
    <div className="chart-heading"><span><i className="peak-key" />Most likely</span>{visible.length < buckets.length && <span className="chart-coverage">{percent(outsideShare)} outside shown range</span>}</div>
    <div className="plot-scroll"><svg viewBox="0 0 720 300" aria-labelledby={id} role="group">
      <title id={id}>Interactive price distribution. Each bin selects its {operator === "above" ? "lower" : "upper"} boundary.</title>
      {[0, .25, .5, .75, 1].map(f => <g key={f}><line x1="60" x2="680" y1={240 - f * 190} y2={240 - f * 190} className="grid-line" /><text x="48" y={244 - f * 190} textAnchor="end" className="axis">{Math.round(f * max * 100)}%</text></g>)}
      <rect className="selection-band" x={operator === "above" ? x(marker) : 60} y="30" width={operator === "above" ? 680 - x(marker) : x(marker) - 60} height="210" />
      {visible.map(b => {
        const included = operator === "above" ? b.lower >= threshold : b.upper <= threshold;
        const choose = () => { setActive(b.optionId); onBoundary(operator === "above" ? b.lower : b.upper); };
        return <g key={b.optionId} role="button" tabIndex={0} aria-pressed={included} aria-label={`${money(b.lower)} to ${money(b.upper)}: ${percent(b.probability)} quote share. Select boundary.`} onClick={choose} onFocus={() => setActive(b.optionId)} onMouseEnter={() => setActive(b.optionId)} onKeyDown={e => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); }
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const next = e.key === "ArrowRight" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling; if (next instanceof SVGElement) next.focus(); }
        }} className={`bar ${included ? "included" : ""} ${active === b.optionId ? "active" : ""} ${b.optionId === peak?.optionId ? "modal" : ""} ${centralRange && b.lower >= centralRange.lower && b.upper <= centralRange.upper ? "central" : "tail"}`}>
          {centralRange && b.lower >= centralRange.lower && b.upper <= centralRange.upper && <rect className="uncertainty-band" x={x(b.lower)} y="30" width={x(b.upper) - x(b.lower)} height="210" />}
          <rect className="hit-area" x={x(b.lower)} y="30" width={x(b.upper) - x(b.lower)} height="214" />
          <rect className="column" x={x(b.lower)} y={240 - b.probability / max * 190} width={x(b.upper) - x(b.lower)} height={b.probability / max * 190} />
          <title>{b.label}: {percent(b.probability)}</title>
        </g>;
      })}
      {boundaries.length > 0 && <g className="threshold-marker" role="slider" tabIndex={0} aria-label="Chart price boundary" aria-valuemin={boundaries[0]} aria-valuemax={boundaries.at(-1)} aria-valuenow={threshold} aria-valuetext={`${operator} ${money(threshold)}`} onPointerDown={e => { e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); move(e); }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e); }} onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onKeyDown={e => {
        const index = boundaries.findIndex(b => b >= threshold);
        const current = index < 0 ? boundaries.length - 1 : index;
        const next = e.key === "Home" ? 0 : e.key === "End" ? boundaries.length - 1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? Math.min(current + 1, boundaries.length - 1) : e.key === "ArrowLeft" || e.key === "ArrowDown" ? Math.max(current - 1, 0) : null;
        if (next !== null) { e.preventDefault(); onBoundary(boundaries[next]); }
      }}>
        <rect className="marker-hit" x={x(marker) - 24} y="8" width="48" height="238" />
        <line x1={x(marker)} x2={x(marker)} y1="30" y2="240" />
        <circle cx={x(marker)} cy="30" r="12" /><path d={`M${x(marker) - 4} 26v8m8 -8v8`} />
      </g>}
      <text x="60" y="272" className="axis">{money(visible[0]?.lower ?? 0)}</text><text x="680" y="272" textAnchor="end" className="axis">{money(visible.at(-1)?.upper ?? 0)}</text>
    </svg></div>
    <div className="price-direction"><span>Lower price</span><span>Higher price</span></div>
    <p className="bin-detail" aria-live="polite">{selected ? `${money(selected.lower)} - ${money(selected.upper)} . ${percent(selected.probability)} market-implied` : ""}</p>
  </div>;
}
