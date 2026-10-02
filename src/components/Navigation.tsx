"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Bell, ChartNoAxesCombined, History } from "lucide-react";
import { selectionHref } from "../lib/selection";

const destinations = [{ path: "/" as const, label: "Outlook", Icon: ChartNoAxesCombined }, { path: "/watches" as const, label: "Watches", Icon: Bell }, { path: "/history" as const, label: "History", Icon: History }];
export function Navigation() {
  const pathname = usePathname();
  const [search, setSearch] = useState("");
  useEffect(() => {
    const read = () => setSearch(location.search);
    read(); window.addEventListener("weather-selection", read); window.addEventListener("popstate", read);
    return () => { window.removeEventListener("weather-selection", read); window.removeEventListener("popstate", read); };
  }, [pathname]);
  return <><div className="navigation-fade" aria-hidden="true" /><nav className="app-navigation" aria-label="Main navigation">{destinations.map(({ path, label, Icon }) => <Link key={path} href={selectionHref(path, search)} scroll={false} aria-current={pathname === path ? "page" : undefined}><Icon size={21} aria-hidden="true" /><span>{label}</span></Link>)}</nav></>;
}
