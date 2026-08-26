"use client";

import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ThemeSelect } from "@/components/ThemeSelect";
import {
  defaultSettings,
  settingsStorageKey,
  type PlannerSettings,
} from "@/lib/planning/preferences";
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
    }
    catch {
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
    <>
      <div className={styles.pageIntro}>
        <div>
          <p className="eyebrow">CONFIGURATION / PLANNING</p>
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
        <Field className={styles.rule} orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="theme">Theme</FieldLabel>
            <FieldDescription>Choose the application color palette</FieldDescription>
          </FieldContent>
          <ThemeSelect id="theme" className="w-40" />
        </Field>
        <Field className={styles.rule} orientation="horizontal">
          <FieldContent>
            <FieldLabel id="include-corporation-assets-label">
              Include corporation assets
            </FieldLabel>
            <FieldDescription>Use eligible corporation hangars in the plan</FieldDescription>
          </FieldContent>
          <Switch
            id="include-corporation-assets"
            aria-labelledby="include-corporation-assets-label"
            checked={settings.includeCorporationAssets}
            onCheckedChange={(checked) =>
              setSettings({ ...settings, includeCorporationAssets: checked })
            }
          />
        </Field>
        <Field className={styles.rule} orientation="horizontal">
          <FieldContent>
            <FieldLabel id="personal-sell-orders-as-stock-label">
              Personal Sell Orders count as Stock
            </FieldLabel>
            <FieldDescription>Count open personal sell orders as available items</FieldDescription>
          </FieldContent>
          <Switch
            id="personal-sell-orders-as-stock"
            aria-labelledby="personal-sell-orders-as-stock-label"
            checked={settings.personalSellOrdersAsStock}
            onCheckedChange={(checked) =>
              setSettings({ ...settings, personalSellOrdersAsStock: checked })
            }
          />
        </Field>
        <Field className={styles.rule} orientation="horizontal">
          <FieldContent>
            <FieldLabel id="all-corporation-sell-orders-as-stock-label">
              All Corporation Sell Orders count as Stock
            </FieldLabel>
            <FieldDescription>
              Count all open sell orders from eligible corporations
            </FieldDescription>
          </FieldContent>
          <Switch
            id="all-corporation-sell-orders-as-stock"
            aria-labelledby="all-corporation-sell-orders-as-stock-label"
            checked={settings.allCorporationSellOrdersAsStock}
            onCheckedChange={(checked) =>
              setSettings({
                ...settings,
                allCorporationSellOrdersAsStock: checked,
                myCorporationSellOrdersAsStock: checked
                  ? true
                  : settings.myCorporationSellOrdersAsStock,
              })
            }
          />
        </Field>
        <Field className={styles.rule} orientation="horizontal">
          <FieldContent>
            <FieldLabel id="my-corporation-sell-orders-as-stock-label">
              My Corporation Sell Orders count as Stock
            </FieldLabel>
            <FieldDescription>
              Count open corporation orders issued by selected characters
            </FieldDescription>
          </FieldContent>
          <Switch
            id="my-corporation-sell-orders-as-stock"
            aria-labelledby="my-corporation-sell-orders-as-stock-label"
            checked={settings.myCorporationSellOrdersAsStock}
            onCheckedChange={(checked) =>
              setSettings({ ...settings, myCorporationSellOrdersAsStock: checked })
            }
          />
        </Field>
        <Field className={styles.rule} orientation="horizontal">
          <FieldContent>
            <FieldLabel id="respect-active-jobs-label">Respect active jobs</FieldLabel>
            <FieldDescription>Account for jobs already in flight</FieldDescription>
          </FieldContent>
          <Switch
            id="respect-active-jobs"
            aria-labelledby="respect-active-jobs-label"
            checked={settings.respectActiveJobs}
            onCheckedChange={(checked) => setSettings({ ...settings, respectActiveJobs: checked })}
          />
        </Field>
        <Field className={styles.rule} orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="default-intermediate-me">Default intermediate ME</FieldLabel>
            <FieldDescription>
              Material efficiency for blueprints not in the build list
            </FieldDescription>
          </FieldContent>
          <Input
            id="default-intermediate-me"
            className={styles.ruleNumber}
            type="number"
            min="0"
            max="10"
            step="1"
            value={settings.defaultMe}
            onChange={(event) =>
              setSettings({ ...settings, defaultMe: boundedNumber(event.target.value, 10) })
            }
          />
        </Field>
        <Field className={styles.rule} orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="default-intermediate-te">Default intermediate TE</FieldLabel>
            <FieldDescription>
              Time efficiency for blueprints not in the build list
            </FieldDescription>
          </FieldContent>
          <Input
            id="default-intermediate-te"
            className={styles.ruleNumber}
            type="number"
            min="0"
            max="20"
            step="1"
            value={settings.defaultTe}
            onChange={(event) =>
              setSettings({ ...settings, defaultTe: boundedNumber(event.target.value, 20) })
            }
          />
        </Field>
        <Button className={styles.calculate} type="submit">
          <span>{saved ? "Settings saved" : "Save settings"}</span>
          <b>→</b>
        </Button>
      </form>
    </>
  );
}
