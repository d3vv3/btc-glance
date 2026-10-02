"use client";
import { useEffect, useRef, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { observeTheme, type Theme } from "../lib/theme";

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme | null>(null);
  const controller = useRef<ReturnType<typeof observeTheme> | null>(null);
  useEffect(() => { controller.current = observeTheme(setTheme); return () => controller.current?.dispose(); }, []);
  const title = theme === "dark" ? "Use light theme" : "Use dark theme";
  return <button className="icon-button theme-switch" role="switch" aria-label="Dark theme" aria-checked={theme === "dark"} title={title} onClick={() => controller.current?.choose(theme === "dark" ? "light" : "dark")}><Sun className="theme-sun" size={19} aria-hidden="true" /><Moon className="theme-moon" size={19} aria-hidden="true" /></button>;
}
