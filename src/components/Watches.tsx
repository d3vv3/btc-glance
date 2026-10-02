"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, establishSession } from "../client/api";
import type { ForecastResult, Operator, Watch, WatchInput } from "../lib/types";
import { money, percent } from "./Histogram";
import { Plus, Save, Bell, Pencil, Trash2, X } from "lucide-react";
import { activePushRegistration } from "../lib/push-readiness";

const errorText = (error: unknown) => {
  if (!(error instanceof Error)) return "Unavailable. Try again.";
  const message = error.message.trim();
  if (!message || message.length > 180 || /^[{[]/.test(message) || /stack|SQLITE|INTERNAL_SERVER_ERROR/i.test(message)) return "Unavailable. Try again.";
  return message;
};

export function isDisableOnly(editing: Watch | null, input: WatchInput): boolean {
  return !!editing && !input.enabled && (["topicId", "operator", "threshold", "materialPp", "cooldownSeconds"] as const).every(key => input[key] === editing[key]);
}

export function WatchSwitch({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <label className="watch-switch"><input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span aria-hidden="true" /></label>;
}

export function Watches({ result, threshold, operator, offline, historical = false, onSelect, onOperatorChange, onThresholdChange, selectionControls, targetTimes = {} }: { result: ForecastResult | null; threshold: number; operator: Operator; offline: boolean; historical?: boolean; onSelect: (topic: number, threshold: number, operator: Operator) => void; onOperatorChange: (operator: Operator) => void; onThresholdChange: (threshold: number) => void; selectionControls?: (editing: boolean) => ReactNode; targetTimes?: Record<number, string> }) {
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
  const [formOpen, setFormOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const arrivalHandled = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const newWatch = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!formOpen) return;
    form.current?.scrollIntoView({ block: "start" });
    form.current?.querySelector<HTMLInputElement>('input:not([type="checkbox"]):not(:disabled)')?.focus({ preventScroll: true });
  }, [formOpen]);
  useEffect(() => { if (guideOpen && dialog.current && !dialog.current.open) dialog.current.showModal(); else if (!guideOpen) dialog.current?.close(); }, [guideOpen]);
  useEffect(() => { if (offline) { setWatches([]); setEditing(null); setLinkedWatch(null); } }, [offline]);
  useEffect(() => {
    let alive = true;
    let refreshing = false;
    let connected = false;
    const capable = window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    setSupported(capable);
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
              if (!arrivalHandled.current) {
                arrivalHandled.current = true;
                if (capable && c.enabled && (!granted || !registered)) setGuideOpen(true);
              }
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
  const closeForm = () => { setFormOpen(false); setEditing(null); setMaterial(5); setCooldown(3600); setEnabled(true); };
  const probability = validBoundary && editingCurrent ? result?.forecast?.buckets.filter(b => input.operator === "above" ? b.lower >= input.threshold : b.upper <= input.threshold).reduce((sum, b) => sum + b.probability, 0) : undefined;
  const cooldownChoices = [...new Set([300, 900, 1800, 3600, cooldown])].sort((a, b) => a - b);
  const save = () => run(async () => {
    if (!input.topicId) throw new Error("Select a forecast first.");
    if (editing) await api.watches.update.mutate({ id: editing.id, ...input }); else await api.watches.create.mutate(input);
    closeForm(); setMessage("Watch saved.");
  });
  const connectPush = async () => {
    if (!supported || offline || actionPending.current || permission === "denied") return;
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
      setSubscribed(true); setPushState("Connected to this installation"); setGuideOpen(false); setMessage("Notifications connected.");
    }, async () => {
      // Hold the action lock before requesting permission, still directly in the click gesture.
      setPushState("Waiting for notification permission");
      let granted: NotificationPermission;
      try { granted = Notification.permission === "granted" ? "granted" : await Notification.requestPermission(); }
      catch (e) { setPushState("Connection failed; try again"); throw e; }
      setPermission(granted);
      if (granted !== "granted") {
        setPushState(granted === "denied" ? "Blocked in browser" : "Permission dismissed; reconnect to try again");
        if (granted === "denied") setGuideOpen(true); else setGuideOpen(false);
        throw new Error(granted === "denied" ? "Notifications blocked." : "Notifications not enabled.");
      }
      setPushState("Connecting notifications");
    });
  };
  return <section className="watch-section" id="watches" aria-labelledby="watch-title">
    <div className="section-heading"><h1 id="watch-title">Watches</h1><button className="notification-status" aria-haspopup="dialog" onClick={() => setGuideOpen(true)}><Bell size={16} />{connecting ? "Connecting..." : permission === "granted" && subscribed && pushState === "Connected to this installation" ? "Connected" : "Notifications"}</button></div>
    <dialog ref={dialog} className="sheet" aria-labelledby="notification-title" onCancel={() => setGuideOpen(false)} onClose={() => setGuideOpen(false)}>
      <div className="sheet-content"><div className="sheet-heading"><h2 id="notification-title">{permission === "denied" ? "Notifications blocked" : "Enable notifications"}</h2><button className="icon-button" aria-label="Close notification dialog" title="Close" disabled={busy} onClick={() => setGuideOpen(false)}><X size={20} /></button></div>
        {permission === "denied" ? <p>Allow notifications in this site's browser settings, then select Enable.</p> : !supported ? <p>Use a browser with notifications, or install the app on your Home Screen.</p> : !pushEnabled ? <p>Notifications are unavailable right now.</p> : pushState === "Connected to this installation" && permission === "granted" ? <p>Notifications connected.</p> : <p>Receive alerts for your saved watches.</p>}
        <div className="actions">{supported && pushEnabled && permission !== "denied" && pushState !== "Connected to this installation" && <button className="primary" disabled={busy || offline} onClick={() => void connectPush()}><Bell size={16} />{connecting ? "Connecting..." : "Enable"}</button>}<button disabled={busy} onClick={() => setGuideOpen(false)}>Later</button></div>
      </div>
    </dialog>
    <div className={`watch-list${formOpen ? "" : " watch-list-fab"}`}>
      {!watches.length && <div className="empty"><img src="/icons/sun-orb-brand-192.png?v=sun-orb-3" width="48" height="48" alt="" /><h3>{session ? "No watches yet" : "Unavailable"}</h3>{!session && <button disabled={busy || offline} onClick={() => void run(async () => {})}>Retry</button>}</div>}
      {watches.map(w => <article className={`watch-item ${linkedWatch === w.id ? "linked-watch" : ""}`} key={w.id} id={`watch-${w.id}`}><div className="section-heading"><a href={`/?market=${w.topicId}&watch=${w.id}&boundary=${w.threshold}&operator=${w.operator}`}>{w.operator === "above" ? "Above" : "Below"} {money(w.threshold)}</a><WatchSwitch checked={w.enabled} disabled={busy || offline} label={`Enable watch ${w.operator} ${money(w.threshold)}`} onChange={checked => void run(async () => { await api.watches.update.mutate({ ...w, enabled: checked }); setMessage("Watch saved."); })} /></div>{targetTimes[w.topicId] && <p><time dateTime={targetTimes[w.topicId]}>{new Date(targetTimes[w.topicId]).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></p>}<div className="watch-item-footer"><p>{w.materialPp} points . {w.cooldownSeconds / 60} min between alerts</p><div className="actions"><button className="icon-button" aria-label="Edit watch" title="Edit watch" disabled={busy || offline} onClick={() => { setEditing(w); setFormOpen(true); setMaterial(w.materialPp); setCooldown(w.cooldownSeconds); setEnabled(w.enabled); setEditThreshold(w.threshold); setEditOperator(w.operator); onSelect(w.topicId, w.threshold, w.operator); }}><Pencil size={18} /></button><button className="icon-button" aria-label="Delete watch" title="Delete watch" disabled={busy || offline} onClick={() => { if (window.confirm("Delete this watch?")) void run(async () => { await api.watches.delete.mutate({ id: w.id }); if (editing?.id === w.id) closeForm(); setMessage("Watch deleted."); }); }}><Trash2 size={18} /></button></div></div></article>)}
    </div>
    {!formOpen && <button ref={newWatch} className="primary icon-button watch-fab" aria-label="New watch" title="New watch" disabled={busy || offline} onClick={() => { closeForm(); setMessage(""); setFormOpen(true); }}><Plus size={26} aria-hidden="true" /></button>}
    {formOpen && <form ref={form} onSubmit={e => { e.preventDefault(); void save(); }} className="watch-form">
      <h3>{editing ? "Edit watch" : "New watch"}</h3>
      {selectionControls?.(!!editing)}
      <div className="field-row"><div className="segmented" role="group" aria-label="Watch direction">{(["above", "below"] as const).map(value => <button key={value} type="button" aria-pressed={input.operator === value} onClick={() => { if (editing) setEditOperator(value); onOperatorChange(value); }}>{value === "above" ? "Above" : "Below"}</button>)}</div><label>Boundary<select aria-label="Watch boundary" disabled={!boundaries.length} value={input.threshold} onChange={e => { const value = Number(e.target.value); if (editing) setEditThreshold(value); onThresholdChange(value); }}>{!validBoundary && <option value={String(input.threshold)} disabled>{Number.isFinite(input.threshold) ? money(input.threshold) : "Choose a boundary"}</option>}{boundaries.map(b => <option key={b} value={b}>{money(b)}</option>)}</select></label></div>
      {probability !== undefined && <span className="watch-chance">{percent(probability)} {input.operator} {money(input.threshold)}</span>}
      <div className="field-row"><label>Change by (points)<input type="number" min="0.1" max="100" step="0.1" required value={material} onChange={e => setMaterial(Number(e.target.value))} /></label><label>Minimum time between alerts<select value={cooldown} onChange={e => setCooldown(Number(e.target.value))}>{cooldownChoices.map(s => <option key={s} value={s}>{s / 60} min</option>)}</select></label></div>
      <div className="actions"><WatchSwitch checked={enabled} disabled={busy || offline} label="Enable watch" onChange={setEnabled} /><button className="primary" disabled={busy || offline || (!canDisable && (!ready || !editingCurrent || !validBoundary))} type="submit">{editing ? <Save size={16} /> : <Plus size={16} />}{busy ? "Saving..." : editing ? "Save changes" : "Create watch"}</button><button type="button" disabled={busy} onClick={() => { closeForm(); requestAnimationFrame(() => newWatch.current?.focus({ preventScroll: true })); }}>Cancel</button></div>
    </form>}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}
