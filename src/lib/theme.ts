export type Theme = "light" | "dark";
export const themeKey = "bw-theme";
export const themeColors = { light: "#f2f4f3", dark: "#182024" };
export const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark";

// Runs before first paint, including when the application shell is cached offline.
export const themeBootstrap = `(()=>{let t;try{t=localStorage.getItem("${themeKey}")}catch{}if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t;document.querySelectorAll('meta[name="theme-color"]').forEach(m=>m.content=t==="dark"?"${themeColors.dark}":"${themeColors.light}")})()`;

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(meta => { meta.content = themeColors[theme]; });
}

export function observeTheme(onChange: (theme: Theme) => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let explicit: Theme | null = null;
  try { const stored = localStorage.getItem(themeKey); if (isTheme(stored)) explicit = stored; } catch {}
  const update = () => { const theme = explicit ?? (media.matches ? "dark" : "light"); applyTheme(theme); onChange(theme); };
  const storage = (event: StorageEvent) => { if (event.key === themeKey) { explicit = isTheme(event.newValue) ? event.newValue : null; update(); } };
  media.addEventListener("change", update);
  window.addEventListener("storage", storage);
  update();
  return {
    choose(theme: Theme) { explicit = theme; try { localStorage.setItem(themeKey, theme); } catch {} update(); },
    dispose() { media.removeEventListener("change", update); window.removeEventListener("storage", storage); },
  };
}
