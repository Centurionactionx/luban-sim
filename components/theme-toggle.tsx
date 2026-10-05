"use client";

import { useSyncExternalStore } from "react";

import { THEME_STORAGE_KEY, type ThemeChoice } from "@/lib/theme";

import { MoonIcon, SunIcon } from "./simulator-icons";

const THEME_EVENT = "luban:theme";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(THEME_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The theme on screen: dark only when someone chose it. */
function currentTheme(): ThemeChoice {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme: ThemeChoice): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private windows can refuse storage; the choice still lasts this visit.
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** Header button that flips between the light and dark themes. */
export function ThemeToggle() {
  // The server can't know the theme; it renders the light button, and the
  // browser corrects it on hydration.
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as const);
  const next: ThemeChoice = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`Switch to the ${next} theme`}
      title={`Switch to the ${next} theme`}
      onClick={() => applyTheme(next)}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
