"use client";

import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import { Sheet } from "./Sheet";
import { detectInstallBrowser, installInstructions, isInstalledDisplay, type InstallBrowser } from "../lib/pwa-install";

interface InstallEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
const dismissalKey = "bw-install-invitation-dismissed";

export function monitorControllerUpdates(serviceWorker: ServiceWorkerContainer, reload: () => void, version: string | undefined) {
  let controller = serviceWorker.controller;
  let reloading = false;
  const ready = () => serviceWorker.controller?.postMessage({ type: "CLIENT_READY", version });
  const changed = () => {
    if (!serviceWorker.controller || reloading) return;
    if (controller && controller !== serviceWorker.controller) {
      reloading = true;
      reload();
    } else if (!controller) {
      controller = serviceWorker.controller;
      ready();
    }
  };
  serviceWorker.addEventListener("controllerchange", changed);
  ready();
  return () => serviceWorker.removeEventListener("controllerchange", changed);
}

export function PwaControls() {
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [installed, setInstalled] = useState(false);
  const [error, setError] = useState("");
  const [browser, setBrowser] = useState<InstallBrowser | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [status, setStatus] = useState("");
  const [dismissed, setDismissed] = useState(true);
  const pending = useRef<InstallEvent | null>(null);
  const prompting = useRef(false);
  const consumed = useRef(new WeakSet<InstallEvent>());
  useEffect(() => {
    try { setDismissed(localStorage.getItem(dismissalKey) === "true"); } catch { setDismissed(false); }
    setBrowser(detectInstallBrowser(navigator.userAgent, navigator.platform, navigator.maxTouchPoints));
    const standalone = window.matchMedia("(display-mode: standalone)");
    const minimalUi = window.matchMedia("(display-mode: minimal-ui)");
    let appInstalled = false;
    const clearPrompt = () => { pending.current = null; setInstall(null); };
    const updateDisplay = () => {
      const active = appInstalled || isInstalledDisplay((navigator as Navigator & { standalone?: boolean }).standalone, standalone.matches, minimalUi.matches);
      setInstalled(active);
      if (active) { clearPrompt(); setStatus(""); }
    };
    updateDisplay();
    standalone.addEventListener("change", updateDisplay);
    minimalUi.addEventListener("change", updateDisplay);
    const capture = (e: Event) => {
      const candidate = e as Partial<InstallEvent>;
      if (typeof candidate.prompt !== "function" || !candidate.userChoice) return;
      e.preventDefault();
      if (consumed.current.has(e as InstallEvent)) return;
      pending.current = e as InstallEvent;
      setInstall(e as InstallEvent);
      setStatus("");
    };
    const done = () => { appInstalled = true; updateDisplay(); };
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", done);
    let disposed = false;
    let stopMonitoring: (() => void) | undefined;
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      stopMonitoring = monitorControllerUpdates(navigator.serviceWorker, () => window.location.reload(), process.env.NEXT_PUBLIC_SW_VERSION);
      void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then(reg => {
        if (disposed) return;
        if (reg.waiting) setWaiting(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const worker = reg.installing;
          worker?.addEventListener("statechange", () => { if (!disposed && worker.state === "installed" && navigator.serviceWorker.controller) setWaiting(worker); });
        });
      }).catch(() => { if (!disposed) setError("Unavailable. Try again."); });
    }
    return () => { disposed = true; window.removeEventListener("beforeinstallprompt", capture); window.removeEventListener("appinstalled", done); standalone.removeEventListener("change", updateDisplay); minimalUi.removeEventListener("change", updateDisplay); stopMonitoring?.(); };
  }, []);
  const dismissInvitation = () => {
    setDismissed(true);
    try { localStorage.setItem(dismissalKey, "true"); } catch { /* Keep dismissal for this mount if storage is unavailable. */ }
  };
  const requestInstall = async () => {
    const event = pending.current;
    if (!event || prompting.current || installed) return;
    // Consume synchronously: a second click must never reuse the native event.
    pending.current = null;
    consumed.current.add(event);
    prompting.current = true;
    setInFlight(true);
    setError("");
    setStatus("");
    try {
      await event.prompt();
      const choice = await event.userChoice;
      dismissInvitation();
      setStatus(choice.outcome === "accepted" ? "Installation requested. Complete any browser confirmation to finish." : "Installation dismissed. You can still use the browser's install menu.");
    } catch {
      setError("Installation could not start. Check the instructions for your browser.");
    } finally {
      setInstall(current => current === event ? null : current);
      prompting.current = false;
      setInFlight(false);
    }
  };
  return <>
    {waiting && <div className="notice update"><span>An app update is ready.</span><button onClick={() => { waiting.postMessage({ type: "SKIP_WAITING" }); }}><RefreshCw size={16} />Update & reload</button></div>}
    {browser && !installed && <div className="install-control">{install && !dismissed && !waiting && <div className="install-invitation"><span>Add BTC glance to your apps</span><button className="icon-button" title="Dismiss install invitation" aria-label="Dismiss install invitation" disabled={inFlight} onClick={dismissInvitation}><X size={16} /></button></div>}{install ? <button disabled={inFlight} onClick={requestInstall}><Download size={18} />{inFlight ? "Installing..." : "Install"}</button> : <Sheet title="Install BTC glance" trigger={<><Download size={18} /><span>Install</span></>}>
      <p>{installInstructions(browser)}</p>
    </Sheet>}{error && <p role="status">{error}</p>}{status && <p role="status">{status}</p>}</div>}
  </>;
}
