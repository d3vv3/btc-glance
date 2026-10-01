"use client";

import { useEffect, useRef, useState } from "react";
import { api, establishSession } from "../client/api";
import type { ForecastResult, Operator, Watch, WatchInput } from "../lib/types";
import { money, percent } from "./Histogram";
import { Plus, Save, Bell, Send, Unplug } from "lucide-react";
import { activePushRegistration } from "../lib/push-readiness";

const errorText = (error: unknown) => error instanceof Error ? error.message : "Request failed. Try again when connected.";

export function isDisableOnly(editing: Watch | null, input: WatchInput): boolean {
  return !!editing && !input.enabled && (["topicId", "operator", "threshold", "materialPp", "cooldownSeconds"] as const).every(key => input[key] === editing[key]);
}

export function Watches({ result, threshold, operator, offline, historical = false, onSelect }: { result: ForecastResult | null; threshold: number; operator: Operator; offline: boolean; historical?: boolean; onSelect: (topic: number) => void }) {
  const [watches, setWatches] = useState<Watch[]>([]);
  const [session, setSession] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<Watch | null>(null);
  const [material, setMaterial] = useState(5);
  const [cooldown, setCooldown] = useState(3600);
  const [enabled, setEnabled] = useState(true);
  const [editThreshold, setEditThreshold] = useState(0);
  const [editOperator, setEditOperator] = useState<Operator>("above");
  const [pushState, setPushState] = useState("Not connected");
  const [pushEnabled, setPushEnabled] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [linkedWatch, setLinkedWatch] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const pushRevision = useRef(0);
  const actionPending = useRef(false);
  useEffect(() => { if (offline) { setWatches([]); setEditing(null); setLinkedWatch(null); } }, [offline]);
  useEffect(() => {
    let alive = true;
    let refreshing = false;
    let connected = false;
    setSupported(window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window);
    const deepWatch = new URLSearchParams(location.search).get("watch");
    const refreshPermission = () => { if (alive && "Notification" in window) { setPermission(Notification.permission); if (Notification.permission !== "granted") setPushState("Notification permission not granted"); } };
    const refresh = async () => {
      if (actionPending.current) return;
      refreshPermission();
      if (!navigator.onLine || refreshing || actionPending.current) return;
      refreshing = true;
      const revision = pushRevision.current;
      const installation = connected ? Promise.resolve() : establishSession();
      try {
        await Promise.all([
          installation.then(async () => {
            const list = await api.watches.list.query();
            connected = true;
            if (alive && navigator.onLine) { setSession(true); setWatches(list); setMessage(""); if (deepWatch && list.some(w => w.id === deepWatch)) setLinkedWatch(deepWatch); }
          }).catch(e => { connected = false; if (alive) { setSession(false); setMessage(errorText(e)); } }),
          api.push.config.query().then(async c => {
            await installation;
            const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
            const sub = await reg?.pushManager?.getSubscription();
            const registered = sub ? await api.push.status.query({ endpoint: sub.endpoint }) : false;
            if (alive && revision === pushRevision.current) {
              const granted = "Notification" in window && Notification.permission === "granted";
              setPushEnabled(c.enabled); setSubscribed(!!sub);
              setPushState(!c.enabled ? "Server push is not configured" : !granted ? "Notification permission not granted" : registered ? "Connected to this installation" : sub ? "Browser subscription is not registered; reconnect" : "Not connected");
            }
          }).catch(() => { if (alive && revision === pushRevision.current) setPushState("Push registration unavailable"); }),
        ]);
      } finally { refreshing = false; }
    };
    const wake = () => { if (document.visibilityState === "visible") void refresh(); };
    refreshPermission(); void refresh();
    window.addEventListener("online", refresh); window.addEventListener("focus", wake); document.addEventListener("visibilitychange", wake);
    const timer = setInterval(wake, 60000);
    let permissionStatus: PermissionStatus | undefined;
    if (navigator.permissions) void navigator.permissions.query({ name: "notifications" }).then(status => {
      if (alive) { permissionStatus = status; status.addEventListener("change", wake); }
    }).catch(() => {});
    return () => { alive = false; clearInterval(timer); window.removeEventListener("online", refresh); window.removeEventListener("focus", wake); document.removeEventListener("visibilitychange", wake); permissionStatus?.removeEventListener("change", wake); };
  }, []);
  useEffect(() => {
    if (linkedWatch) document.getElementById(`watch-${linkedWatch}`)?.scrollIntoView({ block: "center" });
  }, [linkedWatch]);
  const run = async (action: () => Promise<void>, beforeSession?: () => Promise<void>) => {
    if (actionPending.current || !navigator.onLine) return;
    actionPending.current = true; ++pushRevision.current;
    setBusy(true); setMessage("");
    try { if (beforeSession) await beforeSession(); if (!navigator.onLine) throw new Error("Offline. Reconnect before changing watches."); if (!session) { await establishSession(); setSession(true); } await action(); const list = await api.watches.list.query(); setWatches(navigator.onLine ? list : []); }
    catch (e) { setMessage(errorText(e)); if (beforeSession && Notification.permission === "granted") setPushState("Connection failed; reconnect to try again"); } finally { actionPending.current = false; setBusy(false); setConnecting(false); }
  };
  const ready = !historical && !offline && result?.status === "ready" && result.forecast?.source === "live" && Date.parse(result.forecast.targetAt) > Date.now() && !!result.freshUntil && Date.parse(result.freshUntil) >= Date.now();
  const topicId = result?.market?.topicId;
  const boundaries = [...new Set([...(result?.forecast?.buckets.flatMap(b => [b.lower, b.upper]) ?? []), ...(editing ? [editThreshold] : [])])].sort((a, b) => a - b);
  const editingCurrent = editing === null || editing.topicId === topicId;
  const input: WatchInput = { topicId: editing?.topicId ?? topicId ?? 0, operator: editing ? editOperator : operator, threshold: editing ? editThreshold : threshold, materialPp: material, cooldownSeconds: cooldown, enabled };
  const canDisable = isDisableOnly(editing, input);
  const validBoundary = !!result?.forecast?.buckets.some(b => b.lower === input.threshold || b.upper === input.threshold);
  const save = () => run(async () => {
    if (!input.topicId) throw new Error("Select a forecast first.");
    if (editing) await api.watches.update.mutate({ id: editing.id, ...input }); else await api.watches.create.mutate(input);
    setEditing(null); setMessage("Watch saved. Delivery also requires a connected push subscription.");
  });
  const connectPush = async () => {
    if (!supported || offline || actionPending.current) return;
    setConnecting(true);
    await run(async () => {
      const config = await api.push.config.query();
      if (!config.enabled || !config.publicKey) throw new Error("Server push is not configured.");
      setPushState("Waiting for notification service");
      const registration = await activePushRegistration(navigator.serviceWorker);
      setPushState("Connecting notifications");
      const raw = atob(config.publicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(config.publicKey.length / 4) * 4, "="));
      const key = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.auth || !json.keys.p256dh) throw new Error("Browser returned an incomplete subscription.");
      await api.push.register.mutate({ endpoint: json.endpoint, keys: { auth: json.keys.auth, p256dh: json.keys.p256dh } });
      setSubscribed(true); setPushState("Connected to this installation"); setMessage("Notifications connected.");
    }, async () => {
      // Hold the action lock before requesting permission, still directly in the click gesture.
      setPushState("Waiting for notification permission");
      let granted: NotificationPermission;
      try { granted = Notification.permission === "granted" ? "granted" : await Notification.requestPermission(); }
      catch (e) { setPushState("Connection failed; try again"); throw e; }
      setPermission(granted);
      if (granted !== "granted") {
        setPushState(granted === "denied" ? "Blocked in browser" : "Permission dismissed; reconnect to try again");
        throw new Error(granted === "denied" ? "Notifications blocked. Allow them in this site's browser settings, then reconnect." : "Permission not granted. Select Connect to try again.");
      }
      setPushState("Connecting notifications");
    });
  };
  return <section className="watch-section" id="watches" aria-labelledby="watch-title">
    <div className="section-heading"><div><span className="eyebrow">PERSONAL ALERTS</span><h2 id="watch-title">Price watches</h2></div><span className="count">{watches.length} watches</span></div>
    <div className="watch-columns"><div>
      <form onSubmit={e => { e.preventDefault(); void save(); }} className="watch-form">
        <h3>{editing ? "Edit watch" : "New price watch"}</h3>
        {editing ? <div className="field-row"><label>Direction<select value={editOperator} onChange={e => setEditOperator(e.target.value as Operator)}><option value="above">Above</option><option value="below">Below</option></select></label><label>Boundary<select value={editThreshold} onChange={e => setEditThreshold(Number(e.target.value))}>{boundaries.map(b => <option key={b} value={b}>{money(b)}</option>)}</select></label></div> : <p className="watch-target">{result?.forecast ? <>{operator === "above" ? "Above" : "Below"} <strong>{money(threshold)}</strong><span>Current market's settlement target</span></> : <>No validated boundary<span>A valid outlook is required before saving a watch.</span></>}</p>}
        <div className="field-row"><label>Change by (points)<input type="number" min="0.1" max="100" step="0.1" required value={material} onChange={e => setMaterial(Number(e.target.value))} /></label><label>Cooldown<select value={cooldown} onChange={e => setCooldown(Number(e.target.value))}>{[60, 900, 3600, 21600, 86400, 604800].map(s => <option key={s} value={s}>{s < 3600 ? `${s / 60} min` : `${s / 3600} hours`}</option>)}</select></label></div>
        <label className="check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Watch enabled</label>
        <div className="actions"><button className="primary" disabled={busy || offline || (!canDisable && (!ready || !editingCurrent || !validBoundary))} type="submit">{editing ? <Save size={16} /> : <Plus size={16} />}{busy ? "Saving..." : editing ? "Save changes" : "Create watch"}</button>{editing && <button type="button" onClick={() => setEditing(null)}>Cancel</button>}</div>
        {!ready && <p className="small">Alerts paused until a fresh live forecast is available.</p>}
        <details><summary>Advanced</summary><p className="small">Points are percentage points of quote share. Changes must persist for at least a minute; cooldown limits repeat alerts. Editing resets the baseline. Delivery requires connected notifications and is not guaranteed. Demo, cached, historical, and expired forecasts cannot create watches.</p></details>
      </form>
      <div className="push-settings"><h3>Notifications</h3><p role="status">{connecting ? pushState : permission === "denied" ? "Blocked in browser" : !supported ? "Unavailable in this browser" : !pushEnabled ? "Not configured" : permission === "granted" && pushState === "Connected to this installation" ? "Connected" : "Not connected"}</p><div className="actions"><button disabled={busy || offline || !supported || !pushEnabled || permission === "denied"} onClick={() => void connectPush()}><Bell size={16} />{connecting ? "Connecting..." : "Connect"}</button><button disabled={busy || offline || !subscribed || pushState !== "Connected to this installation" || !pushEnabled || permission !== "granted"} onClick={() => void run(async () => { await api.push.test.mutate(); setMessage("Test notification queued, not yet confirmed delivered."); })}><Send size={16} />Send test</button>{subscribed && <button disabled={busy || offline} onClick={() => void run(async () => { const reg = await navigator.serviceWorker.getRegistration(); const sub = await reg?.pushManager.getSubscription(); if (sub) { await api.push.unregister.mutate({ endpoint: sub.endpoint }); await sub.unsubscribe(); } setSubscribed(false); setPushState("Disconnected"); })}><Unplug size={16} />Disconnect</button>}</div>
        {permission === "denied" && <p className="small">Permission is blocked. Allow notifications in this site's browser settings, then return to the app and reconnect. The app cannot override your choice.</p>}
        <details><summary>Connection details</summary><p className="small">{pushState} . Permission: {permission}</p><p className="small">iOS 16.4+: add to the Home Screen in Safari, then open the installed app before enabling push. Push requires HTTPS or localhost and a supported browser.</p></details>
      </div>
    </div><div className="watch-list">
      {!watches.length && <div className="empty"><img src="/icons/icon-192.png?v=sun-orb-1" width="48" height="48" alt="" /><h3>{session ? "No watches yet" : "Installation not connected"}</h3><p>Saved watches for this browser will appear here.</p></div>}
      {watches.map(w => <article className={`watch-item ${linkedWatch === w.id ? "linked-watch" : ""}`} key={w.id} id={`watch-${w.id}`}><div className="section-heading"><a href={`/?market=${w.topicId}&watch=${w.id}&boundary=${w.threshold}&operator=${w.operator}`}>{w.operator === "above" ? "Above" : "Below"} {money(w.threshold)}</a><label className="check"><input type="checkbox" checked={w.enabled} disabled={busy || offline} onChange={() => void run(async () => { await api.watches.update.mutate({ ...w, enabled: !w.enabled }); })} />Enabled</label></div><p>Market #{w.topicId} . {w.materialPp} pp . {w.cooldownSeconds / 60} min cooldown</p><p className="small">Baseline {w.baseline === null ? "pending" : percent(w.baseline)} . Last alert {w.lastNotifiedAt ? new Date(w.lastNotifiedAt).toLocaleString() : "none"}</p><div className="actions"><button disabled={busy || offline} onClick={() => { setEditing(w); setMaterial(w.materialPp); setCooldown(w.cooldownSeconds); setEnabled(w.enabled); setEditThreshold(w.threshold); setEditOperator(w.operator); onSelect(w.topicId); }}>Edit</button><button disabled={busy || offline} onClick={() => { if (window.confirm("Delete this watch?")) void run(async () => { await api.watches.delete.mutate({ id: w.id }); if (editing?.id === w.id) setEditing(null); }); }}>Delete</button></div></article>)}
    </div></div>
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}
