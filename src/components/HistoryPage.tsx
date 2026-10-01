"use client";
import { useEffect, useState } from "react";
import { api } from "../client/api";
import type { PerformanceResult } from "../lib/types";

export function HistoryPage() {
  const [performance, setPerformance] = useState<PerformanceResult | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!navigator.onLine) { if (alive) { setPerformance(null); setError("History is unavailable offline."); } return; }
      try { const data = await api.forecasts.performance.query(); if (alive) { setPerformance(data); setError(""); } }
      catch { if (alive) setError("History unavailable. Reconnect to try again."); }
    };
    void load(); const wake = () => { if (document.visibilityState === "visible") void load(); };
    const timer = setInterval(wake, 60000);
    window.addEventListener("online", wake); window.addEventListener("offline", wake); window.addEventListener("focus", wake);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("online", wake); window.removeEventListener("offline", wake); window.removeEventListener("focus", wake); };
  }, []);
   return <section className="history-section" id="history"><div className="section-heading"><h1>History</h1><span className="small">Live samples</span></div>{error && <p role="status" className="notice">{error}</p>}{performance ? <><div className="history-stats">{performance.groups.map(g => <div key={g.cadence}><h3>{g.cadence}</h3><strong>{g.sampleCount}</strong><span>scored samples</span><small>Brier {g.meanBrier === null ? "-" : g.meanBrier.toFixed(4)}</small></div>)}</div><details><summary>Evaluation details</summary><p className="small">Original-bin Brier score; lower is better. Samples do not establish calibration. Historical versions are scored as saved, without retrospective conversion.</p>{performance.groups.map(g => <p className="small" key={g.cadence}>{g.cadence} . {g.leadSeconds / 3600}h lead . {g.maxSnapshotAgeSeconds / 60} min age allowance . {g.eligibleCount} eligible . {g.missingSnapshotCount} missing . {g.pendingResolutionCount} pending</p>)}</details>{performance.groups.map(g => <div className="performance-table" key={g.cadence}><table><caption>{g.cadence} evidence</caption><thead><tr><th>Target</th><th>Captured</th><th>Brier</th><th>Snapshot / version</th></tr></thead><tbody>{g.samples.map(s => <tr key={s.snapshotId}><td><time dateTime={s.targetAt}>{new Date(s.targetAt).toLocaleString()}</time></td><td><time dateTime={s.capturedAt}>{new Date(s.capturedAt).toLocaleString()}</time></td><td>{s.brier.toFixed(4)}</td><td><a href={`/?market=${s.topicId}&snapshotId=${s.snapshotId}`}>#{s.snapshotId}</a><br />{s.transformationVersion}</td></tr>)}</tbody></table></div>)}</> : !error && <p role="status" className="small">Loading history...</p>}</section>;
}
