"use client";

import { FormEvent, useState } from "react";
import {
  defaultSettings,
  settingsStorageKey,
  type PlannerSettings,
} from "@/lib/planning/preferences";
import AppShell from "../AppShell";
import styles from "../page.module.css";

function boundedNumber(value: string, maximum: number) {
  return Math.min(maximum, Math.max(0, Number(value) || 0));
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<PlannerSettings>(() => {
    if (typeof window === "undefined") return defaultSettings;
    try {
      const stored = window.localStorage.getItem(settingsStorageKey);
      return stored ? { ...defaultSettings, ...JSON.parse(stored) } : defaultSettings;
    } catch {
      return defaultSettings;
    }
  });
  const [saved, setSaved] = useState(false);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    window.localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
    setSaved(true);
  }

  return (
    <AppShell activePage="settings">
      <div className={styles.pageIntro}>
        <div>
          <p className={styles.eyebrow}>CONFIGURATION / PLANNING</p>
          <h1>Settings</h1>
          <p className={styles.subtitle}>
            Control which assets and in-flight work are considered by the planner.
          </p>
        </div>
      </div>
      <form className={styles.panel} onSubmit={save}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>01 / RULES</p>
            <h2>Planning settings</h2>
          </div>
        </div>
        <div className={styles.rule}>
          <span>
            <strong>Include corporation assets</strong>
            <small>Use eligible corporation hangars in the plan</small>
          </span>
          <input
            type="checkbox"
            checked={settings.includeCorporationAssets}
            onChange={(event) =>
              setSettings({ ...settings, includeCorporationAssets: event.target.checked })
            }
          />
        </div>
        <div className={styles.rule}>
          <span>
            <strong>Personal Sell Orders count as Stock</strong>
            <small>Count open personal sell orders as available items</small>
          </span>
          <input
            type="checkbox"
            checked={settings.personalSellOrdersAsStock}
            onChange={(event) =>
              setSettings({ ...settings, personalSellOrdersAsStock: event.target.checked })
            }
          />
        </div>
        <div className={styles.rule}>
          <span>
            <strong>All Corporation Sell Orders count as Stock</strong>
            <small>Count all open sell orders from eligible corporations</small>
          </span>
          <input
            type="checkbox"
            checked={settings.allCorporationSellOrdersAsStock}
            onChange={(event) =>
              setSettings({
                ...settings,
                allCorporationSellOrdersAsStock: event.target.checked,
                myCorporationSellOrdersAsStock: event.target.checked
                  ? true
                  : settings.myCorporationSellOrdersAsStock,
              })
            }
          />
        </div>
        <div className={styles.rule}>
          <span>
            <strong>My Corporation Sell Orders count as Stock</strong>
            <small>Count open corporation orders issued by selected characters</small>
          </span>
          <input
            type="checkbox"
            checked={settings.myCorporationSellOrdersAsStock}
            onChange={(event) =>
              setSettings({ ...settings, myCorporationSellOrdersAsStock: event.target.checked })
            }
          />
        </div>
        <div className={styles.rule}>
          <span>
            <strong>Include assembled containers in stock</strong>
            <small>Show assembled containers in stock and location asset lists</small>
          </span>
          <input
            type="checkbox"
            checked={settings.includeAssembledContainers}
            onChange={(event) =>
              setSettings({ ...settings, includeAssembledContainers: event.target.checked })
            }
          />
        </div>
        <div className={styles.rule}>
          <span>
            <strong>Include assembled ships in stock</strong>
            <small>Show assembled ships in stock and location asset lists</small>
          </span>
          <input
            type="checkbox"
            checked={settings.includeAssembledShips}
            onChange={(event) =>
              setSettings({ ...settings, includeAssembledShips: event.target.checked })
            }
          />
        </div>
        <div className={styles.rule}>
          <span>
            <strong>Respect active jobs</strong>
            <small>Account for jobs already in flight</small>
          </span>
          <input
            type="checkbox"
            checked={settings.respectActiveJobs}
            onChange={(event) =>
              setSettings({ ...settings, respectActiveJobs: event.target.checked })
            }
          />
        </div>
        <div className={styles.rule}>
          <span>
            <strong>Default intermediate ME</strong>
            <small>Material efficiency for blueprints not in the build list</small>
          </span>
          <input
            aria-label="Default intermediate material efficiency"
            type="number"
            min="0"
            max="10"
            step="1"
            value={settings.defaultMe}
            onChange={(event) =>
              setSettings({ ...settings, defaultMe: boundedNumber(event.target.value, 10) })
            }
          />
        </div>
        <div className={styles.rule}>
          <span>
            <strong>Default intermediate TE</strong>
            <small>Time efficiency for blueprints not in the build list</small>
          </span>
          <input
            aria-label="Default intermediate time efficiency"
            type="number"
            min="0"
            max="20"
            step="1"
            value={settings.defaultTe}
            onChange={(event) =>
              setSettings({ ...settings, defaultTe: boundedNumber(event.target.value, 20) })
            }
          />
        </div>
        <button className={styles.calculate} type="submit">
          <span>{saved ? "Settings saved" : "Save settings"}</span>
          <b>→</b>
        </button>
      </form>
    </AppShell>
  );
}
