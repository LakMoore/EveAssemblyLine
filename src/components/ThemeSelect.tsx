"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const themeStorageKey = "assembly-line-theme";

const themes = [
  { value: "base", label: "Base" },
  { value: "base-dark", label: "Base.dark" },
  { value: "assemblyline", label: "AssemblyLine" },
  { value: "amarr", label: "Amarr" },
  { value: "caldari", label: "Caldari" },
  { value: "minmatar", label: "Minmatar" },
  { value: "gallente", label: "Gallente" },
] as const;

type Theme = (typeof themes)[number]["value"];

type ThemeSelectProps = {
  className?: string;
  id?: string;
};

/** Narrows a stored theme identifier to a configured application theme. */
function isTheme(value: string | null): value is Theme {
  return themes.some((theme) => theme.value === value);
}

/** Loads the persisted browser theme, falling back to AssemblyLine. */
function loadTheme(): Theme {
  const storedTheme = window.localStorage.getItem(themeStorageKey);
  return isTheme(storedTheme) ? storedTheme : "assemblyline";
}

/** Applies a theme identifier to the document-level theme scope. */
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

/** Selects and applies the local visual theme for the current browser. */
export function ThemeSelect({ className, id }: ThemeSelectProps) {
  const [theme, setTheme] = useState<Theme>("assemblyline");

  useEffect(() => {
    const syncTheme = (nextTheme: Theme) => {
      applyTheme(nextTheme);
      setTheme(nextTheme);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== themeStorageKey) return;
      syncTheme(loadTheme());
    };
    const handleThemeChange = (event: Event) => {
      const nextTheme = (event as CustomEvent<Theme>).detail;
      if (isTheme(nextTheme)) syncTheme(nextTheme);
    };

    syncTheme(loadTheme());
    window.addEventListener("storage", handleStorage);
    window.addEventListener("assembly-line-theme-change", handleThemeChange);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("assembly-line-theme-change", handleThemeChange);
    };
  }, []);

  /** Persists and broadcasts a selected theme to other selectors in this tab. */
  function changeTheme(nextTheme: string | null) {
    if (!isTheme(nextTheme)) return;
    applyTheme(nextTheme);
    window.localStorage.setItem(themeStorageKey, nextTheme);
    setTheme(nextTheme);
    window.dispatchEvent(
      new CustomEvent<Theme>("assembly-line-theme-change", { detail: nextTheme }),
    );
  }

  return (
    <Select value={theme} onValueChange={changeTheme} items={themes}>
      <SelectTrigger id={id} className={className} aria-label="Theme" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {themes.map((themeOption) => (
            <SelectItem key={themeOption.value} value={themeOption.value}>
              {themeOption.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
