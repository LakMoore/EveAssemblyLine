"use client";

import { ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import styles from "./page.module.css";

const languageStorageKey = "assembly-line-language";
type ActivePage = "planner" | "stock" | "locations" | "settings";

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
  const language = controlledLanguage ?? localLanguage;

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
          <span className={styles.onlineDot} /> ESI CONNECTED{" "}
          <button className={styles.avatar}>ST</button>
          <button
            type="button"
            className={styles.sidebarToggle}
            aria-label={isSidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
            onClick={() => setIsSidebarCollapsed((collapsed) => !collapsed)}
          >
            {isSidebarCollapsed ? "→" : "←"}
          </button>
        </div>
      </header>
      <div className={`${styles.layout} ${isSidebarCollapsed ? styles.layoutCollapsed : ""}`}>
        <aside className={styles.sidebar}>
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
          <button className={styles.navItem}>
            <span>◌</span>
            <span className={styles.navText}>Characters</span>
            <b>2</b>
          </button>
          <button className={styles.navItem}>
            <span>⌁</span>
            <span className={styles.navText}>Data status</span>
          </button>
          <div className={styles.sidebarBottom}>
            <div className={styles.sectionLabel}>CONNECTED PILOTS</div>
            <div className={styles.pilot}>
              <span className={styles.pilotDot}>SC</span>
              <span className={styles.navText}>
                <strong>Stuart Clarke</strong>
                <small>Director access</small>
              </span>
              <i />
            </div>
            <div className={styles.pilot}>
              <span className={`${styles.pilotDot} ${styles.pilotAlt}`}>AS</span>
              <span className={styles.navText}>
                <strong>Assembly Scout</strong>
                <small>Character access</small>
              </span>
              <i />
            </div>
            <button className={`${styles.addButton} ${styles.navText}`}>+ Add character</button>
          </div>
        </aside>
        <section className={styles.content}>{children}</section>
      </div>
    </main>
  );
}

export { languageStorageKey };
