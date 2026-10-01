import type { ReactNode } from "react";
import { Navigation } from "./Navigation";
import { PwaControls } from "./PwaControls";

export function AppShell({ children }: { children: ReactNode }) {
  return <div className="app-shell"><a className="skip-link" href="#content">Skip to content</a><header className="masthead"><a href="/" className="brand"><img src="/icons/icon-192.png?v=sun-orb-1" width="36" height="36" alt="" /><span>Bitcoin <strong>Weather</strong></span></a><PwaControls /></header><Navigation /><main id="content">{children}</main><footer><span>Bitcoin Weather</span><p>Market quotes, not investment advice.</p></footer></div>;
}
