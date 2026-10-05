/**
 * The light/dark choice. "system" (nothing saved) follows the operating
 * system; picking a theme saves it in this browser and sets data-theme on
 * <html>, which globals.css reads.
 */
export type ThemeChoice = "light" | "dark";

export const THEME_STORAGE_KEY = "luban:theme";

/**
 * Runs in <head> before the page paints, so a saved dark theme never
 * flashes light first. Kept tiny and self-contained: it is inlined as text.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();`;
