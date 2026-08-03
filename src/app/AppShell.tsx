"use client";

import { ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import styles from "./page.module.css";

const languageStorageKey = "assembly-line-language";
type ActivePage = "planner" | "stock" | "locations" | "settings";
type CharacterSummary = {
  characterId: number;
  characterName: string;
  hasDirectorRole: boolean;
  corpAuthCompleted: boolean;
};

export default function AppShell({
  children,
  activePage,
  language: controlledLanguage,
  onLanguageChange,
}: {
  children: ReactNode;
  activePage: ActivePage;
  language?: SdeLanguage;
  onLanguageChange?: (language: SdeLanguage) => void;
}) {
  const [localLanguage, setLocalLanguage] = useState<SdeLanguage>(() => {
    if (typeof window === "undefined") return "en";
    const savedLanguage = window.localStorage.getItem(languageStorageKey);
    return isSdeLanguage(savedLanguage) ? savedLanguage : "en";
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [isRefreshingData, setIsRefreshingData] = useState(false);
  const language = controlledLanguage ?? localLanguage;

  useEffect(() => {
    fetch("/api/auth/session")
      .then((response) => response.json())
      .then((data: { authenticated?: boolean; characters?: CharacterSummary[] }) => {
        setAuthenticated(Boolean(data.authenticated));
        setCharacters(data.characters ?? []);
      })
      .catch(() => {
        setAuthenticated(false);
        setCharacters([]);
      });
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const handleViewportChange = () => setIsSidebarCollapsed(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleViewportChange);
    return () => mediaQuery.removeEventListener("change", handleViewportChange);
  }, []);

  function changeLanguage(nextLanguage: string) {
    if (!isSdeLanguage(nextLanguage)) return;
    setLocalLanguage(nextLanguage);
    window.localStorage.setItem(languageStorageKey, nextLanguage);
    onLanguageChange?.(nextLanguage);
  }

  async function refreshData() {
    if (isRefreshingData || !authenticated || characters.length === 0) return;
    setIsRefreshingData(true);
    try {
      const response = await fetch("/api/state/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const data = (await response.json()) as {
        success?: boolean;
        refreshedAt?: string;
        rateLimitedUntil?: string | null;
      };
      if (!response.ok || data.success !== true) return;
      window.dispatchEvent(
        new CustomEvent("assembly-line-esi-refreshed", {
          detail: {
            refreshedAt: data.refreshedAt ?? null,
            rateLimitedUntil: data.rateLimitedUntil ?? null,
          },
        }),
      );
    } catch {
    } finally {
      setIsRefreshingData(false);
    }
  }

  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/">
          <span className={styles.brandMark}>E</span>
          <span>
            Eve <span className={styles.brandAccent}>AssemblyLine</span>
          </span>
        </Link>
        <div className={styles.topMeta}>
          <label className={styles.languageControl}>
            <span>LANGUAGE</span>
            <select
              aria-label="Language"
              value={language}
              onChange={(event) => changeLanguage(event.target.value)}
            >
              <option value="de">Deutsch</option>
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="fr">Français</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
              <option value="ru">Русский</option>
              <option value="zh">中文</option>
            </select>
          </label>
          <span className={`${styles.onlineDot} ${authenticated ? "" : styles.offlineDot}`} />{" "}
          {authenticated ? "ESI CONNECTED" : "NOT CONNECTED"}
          {authenticated && (
            <button
              type="button"
              className={styles.refresh}
              onClick={() => void refreshData()}
              disabled={isRefreshingData}
            >
              ↻ <span>{isRefreshingData ? "Refreshing..." : "Refresh data"}</span>
            </button>
          )}
        </div>
      </header>
      <div className={`${styles.layout} ${isSidebarCollapsed ? styles.layoutCollapsed : ""}`}>
        <aside className={styles.sidebar}>
          <button
            type="button"
            className={styles.sidebarToggle}
            aria-label={isSidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
            onClick={() => setIsSidebarCollapsed((collapsed) => !collapsed)}
          >
            {isSidebarCollapsed ? "→" : "←"}
          </button>
          <div className={styles.sectionLabel}>WORKSPACE</div>
          <Link
            className={`${styles.navItem} ${activePage === "planner" ? styles.navActive : ""}`}
            href="/"
          >
            <span>▦</span>
            <span className={styles.navText}>Production planner</span>
          </Link>
          <Link
            className={`${styles.navItem} ${activePage === "stock" ? styles.navActive : ""}`}
            href="/stock"
          >
            <span>▤</span>
            <span className={styles.navText}>Stock</span>
          </Link>
          <div className={styles.sectionLabel}>CONFIGURATION</div>
          <Link
            className={`${styles.navItem} ${activePage === "locations" ? styles.navActive : ""}`}
            href="/locations"
          >
            <span>⌖</span>
            <span className={styles.navText}>Locations</span>
          </Link>
          <Link
            className={`${styles.navItem} ${activePage === "settings" ? styles.navActive : ""}`}
            href="/settings"
          >
            <span>⚙</span>
            <span className={styles.navText}>Settings</span>
          </Link>
          <button type="button" className={styles.navItem}>
            <span>◌</span>
            <span className={styles.navText}>Characters</span>
            <b>{characters.length}</b>
          </button>
          <button type="button" className={styles.navItem}>
            <span>⌁</span>
            <span className={styles.navText}>Data status</span>
          </button>
          <div className={styles.sidebarBottom}>
            <div className={styles.sectionLabel}>CONNECTED PILOTS</div>
            <div className={styles.pilotList}>
              {characters.map((character, index) => (
                <div className={styles.pilot} key={character.characterId}>
                  <span className={`${styles.pilotDot} ${index > 0 ? styles.pilotAlt : ""}`}>
                    {character.characterName.slice(0, 2).toUpperCase()}
                  </span>
                  <span className={styles.navText}>
                    <strong>{character.characterName}</strong>
                    <small>
                      {character.corpAuthCompleted && character.hasDirectorRole
                        ? "Director access"
                        : "Character access"}
                    </small>
                  </span>
                  <i />
                </div>
              ))}
            </div>
            <div className={styles.sidebarFooter}>
              <span
                className={`${styles.sidebarCount} ${styles.navText}`}
                aria-label={`${characters.length} connected characters`}
                data-tooltip={`${characters.length} connected character${characters.length === 1 ? "" : "s"}`}
                tabIndex={0}
              >
                {characters.length}
              </span>
              <a className={`${styles.addButton} ${styles.navText}`} href="/api/auth/eve/start">
                + Add character
              </a>
            </div>
          </div>
        </aside>
        <section className={styles.content}>{children}</section>
      </div>
    </main>
  );
}

export { languageStorageKey };
