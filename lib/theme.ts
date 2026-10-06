/**
 * The light/dark choice. With nothing saved the app is light, whatever the
 * device prefers; picking a theme saves it in this browser and sets
 * data-theme on <html>, which globals.css reads.
 */
export type ThemeChoice = "light" | "dark";

export const THEME_STORAGE_KEY = "luban:theme";

/**
 * The browser bar colour for each theme: the page canvas from globals.css.
 * It follows the app's own choice, not the device's dark-mode setting.
 */
export const THEME_COLORS: Record<ThemeChoice, string> = {
  light: "#b0a7df",
  dark: "#09090b",
};

/** Points the theme-color meta tags at the given theme. */
export function syncThemeColor(theme: ThemeChoice): void {
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute("content", THEME_COLORS[theme]);
  }
}

/**
 * Runs in <head> before the page paints, so a saved dark theme never
 * flashes light first. Kept tiny and self-contained: it is inlined as text.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;if(t==="dark")document.addEventListener("DOMContentLoaded",function(){document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.setAttribute("content",${JSON.stringify(
  THEME_COLORS.dark,
)});});});}catch(e){}})();`;
