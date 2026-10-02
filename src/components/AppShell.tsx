import type { ReactNode } from "react";
import { Navigation } from "./Navigation";
import { PwaControls } from "./PwaControls";
import { ThemeSwitch } from "./ThemeSwitch";

export function AppShell({ children }: { children: ReactNode }) {
  return <div className="app-shell"><a className="skip-link" href="#content">Skip to content</a><header className="masthead"><a href="/" className="brand"><img src="/icons/sun-orb-brand-192.png?v=sun-orb-3" width="36" height="36" alt="" /><span>BTC <strong>glance</strong></span></a><PwaControls /><ThemeSwitch /></header><Navigation /><main id="content">{children}</main></div>;
}
