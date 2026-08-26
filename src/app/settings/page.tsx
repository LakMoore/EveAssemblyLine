"use client";

import { FormEvent, useEffect, useState } from "react";
import PasteListDialog from "@/components/PasteListDialog";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ThemeSelect } from "@/components/ThemeSelect";
import type { TypeMetadata } from "@/lib/reference/types";
import type { SdeLanguage } from "@/lib/reference/languages";
import TypeSearch, { type TypeSearchResult } from "@/components/TypeSearch";
import { useAppLanguage } from "../AppShell";
import { toast } from "@/components/ui/toast";
import {
  defaultSettings,
  settingsStorageKey,
  type PlannerSettings,
} from "@/lib/planning/preferences";
import { loadBuildBlacklist, saveBuildBlacklist } from "@/lib/planning/plannerPreferencesStore";
import styles from "../page.module.css";
import { ClipboardPaste, Copy, Trash2 } from "lucide-react";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar";

function boundedNumber(value: string, maximum: number) {
  return Math.min(maximum, Math.max(0, Number(value) || 0));
}

function BuildBlacklistSummary({ items }: { items: TypeMetadata[] }) {
  if (items.length === 0) {
    return <span className="text-sm text-muted-foreground">No types selected</span>;
  }
  const visibleItems = items.slice(0, 4);
  const remainingCount = items.length - visibleItems.length;

  return (
    <AvatarGroup aria-label={`Build blacklist: ${items.map((item) => item.name).join(", ")}`}>
      {visibleItems.map((item) => (
        <Avatar key={item.typeId} size="sm" title={item.name}>
          <AvatarImage src={eveTypeImageUrl(item.typeId, "icon", 32)} alt={item.name} />
          <AvatarFallback>{item.name.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      ))}
      {remainingCount > 0 ? (
        <AvatarGroupCount title={`${remainingCount} more blacklisted items`}>
          +{remainingCount}
        </AvatarGroupCount>
      ) : null}
    </AvatarGroup>
  );
}

function readSettings(): PlannerSettings {
  if (typeof window === "undefined") return defaultSettings;
  try {
    const stored = window.localStorage.getItem(settingsStorageKey);
    if (!stored) return defaultSettings;
    const raw = JSON.parse(stored) as Record<string, unknown>;
    const parsed = raw as Partial<PlannerSettings>;
    const rawBlacklist = raw.buildBlacklist;
    const buildBlacklist = Array.isArray(rawBlacklist)
      ? rawBlacklist.flatMap((item) => {
          if (typeof item === "number") {
            return [{ typeId: item, name: `Type ${item}` }];
          }
          if (
            item
            && typeof item === "object"
            && Number.isInteger(item.typeId)
            && typeof item.name === "string"
          ) {
            return [item as TypeMetadata];
          }
          return [];
        })
      : [];
    return { ...defaultSettings, ...parsed, buildBlacklist };
  }
  catch {
    return defaultSettings;
  }
}

export default function SettingsPage() {
  const { language } = useAppLanguage();
  const [settings, setSettings] = useState<PlannerSettings>(readSettings);
  const [saved, setSaved] = useState(false);
  const [isBlacklistOpen, setIsBlacklistOpen] = useState(false);

  useEffect(() => {
    void loadBuildBlacklist().then((buildBlacklist) => {
      if (buildBlacklist) setSettings((current) => ({ ...current, buildBlacklist }));
    });
  }, []);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    window.localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
    void saveBuildBlacklist(settings.buildBlacklist);
    setSaved(true);
  }

  async function copyBlacklist() {
    try {
      await navigator.clipboard.writeText(
        settings.buildBlacklist.map((item) => `${item.name}\t1`).join("\n"),
      );
      toast.add({ description: "Build blacklist copied" });
    }
    catch {
      toast.add({ description: "Could not copy build blacklist", type: "error" });
    }
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
            <FieldLabel>Build blacklist</FieldLabel>
            <FieldDescription>
              Buy these materials directly instead of building them
            </FieldDescription>
          </FieldContent>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <BuildBlacklistSummary items={settings.buildBlacklist} />
            <Button
              type="button"
              variant="outline"
              disabled={settings.buildBlacklist.length === 0}
              onClick={() => void copyBlacklist()}
            >
              <Copy data-icon="inline-start" aria-hidden="true" />
              Copy BlackList
            </Button>
            <Button type="button" variant="outline" onClick={() => setIsBlacklistOpen(true)}>
              Edit
            </Button>
          </div>
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
      {isBlacklistOpen && (
        <BuildBlacklistDialog
          language={language}
          items={settings.buildBlacklist}
          onCancel={() => setIsBlacklistOpen(false)}
          onSave={(buildBlacklist) => {
            const nextSettings = { ...settings, buildBlacklist };
            setSettings(nextSettings);
            window.localStorage.setItem(settingsStorageKey, JSON.stringify(nextSettings));
            void saveBuildBlacklist(buildBlacklist);
            setIsBlacklistOpen(false);
          }}
        />
      )}
    </>
  );
}

function BuildBlacklistDialog({
  language,
  items,
  onCancel,
  onSave,
}: {
  language: SdeLanguage;
  items: TypeMetadata[];
  onCancel: () => void;
  onSave: (items: TypeMetadata[]) => void;
}) {
  const [draft, setDraft] = useState(items);
  const [isPasteOpen, setIsPasteOpen] = useState(false);

  function addItem(item: TypeSearchResult | TypeMetadata) {
    if (draft.some((entry) => entry.typeId === item.typeId)) return;
    setDraft((current) => [
      ...current,
      {
        typeId: item.typeId,
        name: item.name,
        ...(item.category === "blueprint" || item.category === "reactionformula"
          ? { category: item.category }
          : {}),
        ...(item.marketCategory ? { marketCategory: item.marketCategory } : {}),
      },
    ]);
  }

  function importPastedItems(importedItems: Array<TypeMetadata & { quantity?: number }>) {
    setDraft(importedItems);
    setIsPasteOpen(false);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogTitle>Build blacklist</DialogTitle>
        <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
          <p className="text-sm text-muted-foreground">
            Blacklisted inputs are always bought when stock is insufficient.
          </p>
          <TypeSearch
            language={language}
            placeholder="Search items by name or type ID"
            ariaLabel="Search build blacklist items"
            onSelect={addItem}
          />
          {draft.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No types are on the build blacklist.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {draft.map((item) => (
                <div
                  className="flex items-center justify-between gap-3 border p-2"
                  key={item.typeId}
                >
                  <TypeIdentity name={item.name} typeId={item.typeId} />
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon-sm"
                    title={`Remove ${item.name}`}
                    aria-label={`Remove ${item.name}`}
                    onClick={() =>
                      setDraft((current) => current.filter((entry) => entry.typeId !== item.typeId))
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" onClick={() => setDraft([])}>
              <Trash2 data-icon="inline-start" aria-hidden="true" />
              Delete all
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setIsPasteOpen(true);
              }}
            >
              <ClipboardPaste data-icon="inline-start" aria-hidden="true" />
              Paste list
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={() => onSave(draft)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
      {isPasteOpen && (
        <PasteListDialog
          language={language}
          currentItems={draft}
          title="Build blacklist import"
          description="Paste one item per line. Quantities are ignored for the blacklist."
          ariaLabel="Blacklist items and quantities"
          onCancel={() => setIsPasteOpen(false)}
          onImport={(importedItems) =>
            void importPastedItems(
              importedItems.map((item) => ({
                typeId: item.typeId,
                name: item.name,
                quantity: item.quantity,
                ...(item.category === "blueprint"
                || item.category === "reactionformula"
                || item.category === "item"
                  ? { category: item.category }
                  : {}),
                ...(item.marketCategory ? { marketCategory: item.marketCategory } : {}),
              })),
            )
          }
        />
      )}
    </Dialog>
  );
}
