"use client";
import { useEffect, useState } from "react";
import { api } from "../client/api";
import type { PerformanceResult } from "../lib/types";

export function HistoryPage() {
  const [performance, setPerformance] = useState<PerformanceResult | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!navigator.onLine) { if (alive) { setPerformance(null); setError("Unavailable"); } return; }
      try { const data = await api.forecasts.performance.query(); if (alive) { setPerformance(data); setError(""); } }
      catch { if (alive) setError("Unavailable"); }
    };
    void load(); const wake = () => { if (document.visibilityState === "visible") void load(); };
    const timer = setInterval(wake, 60000);
    window.addEventListener("online", wake); window.addEventListener("offline", wake); window.addEventListener("focus", wake);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("online", wake); window.removeEventListener("offline", wake); window.removeEventListener("focus", wake); };
  }, [retry]);
   return <section className="history-section" id="history"><div className="section-heading"><h1>History</h1></div>{error ? <div className="empty"><p role="status">Unavailable</p><button onClick={() => setRetry(value => value + 1)}>Retry</button></div> : performance ? <><div className="history-stats">{performance.groups.map(g => <div key={g.cadence}><h3>{g.cadence}</h3><strong>{g.sampleCount}</strong><span>scored</span><small>Score {g.meanBrier === null ? "-" : g.meanBrier.toFixed(4)}</small></div>)}</div>{performance.groups.map(g => <div className="performance-table" key={g.cadence}>{g.samples.length ? <table><caption>{g.cadence}</caption><thead><tr><th>Date</th><th>Score</th><th>Outcome</th></tr></thead><tbody>{g.samples.map(s => <tr key={s.snapshotId}><td><time dateTime={s.targetAt}>{new Date(s.targetAt).toLocaleString()}</time></td><td>{s.brier.toFixed(4)}</td><td><a href={`/?market=${s.topicId}&snapshotId=${s.snapshotId}`}>View</a></td></tr>)}</tbody></table> : <p className="small">No results yet</p>}{(g.missingSnapshotCount > 0 || g.pendingResolutionCount > 0) && <p className="small">{g.missingSnapshotCount} missing . {g.pendingResolutionCount} pending</p>}</div>)}</> : <p role="status" className="small">Loading...</p>}</section>;
}
