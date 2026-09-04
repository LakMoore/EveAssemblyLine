"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useAppLanguage } from "@/app/AppShell";
import {
  loadClientAssets,
  loadClientCharacters,
  loadClientCorporationSettings,
  saveClientCorporationSettings,
  type ClientCharacter,
  type ClientCorporationSettings,
  type ClientCorporationSource,
} from "@/lib/client/requestCache";
import { eveCorporationLogoUrl } from "@/lib/eve/imageServer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { CheckCheck, ListX } from "lucide-react";
import styles from "@/app/page.module.css";

type CorporationSourceGroup = {
  rootLocationId: number;
  locationName: string;
  locationKind: "station" | "structure" | "location";
  sources: ClientCorporationSource[];
};

type RefreshDetail = {
  rateLimitedUntil?: string | null;
  corporationSources?: ClientCorporationSource[];
};

type CorporationOption = {
  corporationId: number;
  corporationName?: string;
  hasDirectorAccess: boolean;
};

type BulkAction = "clear" | "select";

function groupCorporations(characters: ClientCharacter[]): CorporationOption[] {
  const corporations = new Map<number, CorporationOption>();
  for (const character of characters) {
    if (character.corporationId === undefined) continue;
    const existing = corporations.get(character.corporationId);
    if (existing) {
      existing.hasDirectorAccess ||= character.hasDirectorRole;
      existing.corporationName ||= character.corporationName;
      continue;
    }
    corporations.set(
      character.corporationId,
      {
        corporationId: character.corporationId,
        corporationName: character.corporationName,
        hasDirectorAccess: character.hasDirectorRole,
      },
    );
  }
  return [...corporations.values()].sort((left, right) =>
    (left.corporationName ?? `Corporation ${left.corporationId}`).localeCompare(
      right.corporationName ?? `Corporation ${right.corporationId}`,
    ),
  );
}

function groupCorporationSources(sources: ClientCorporationSource[]): CorporationSourceGroup[] {
  const groups = new Map<number, CorporationSourceGroup>();
  for (const source of sources) {
    const existing = groups.get(source.rootLocationId);
    if (existing) {
      existing.sources.push(source);
      continue;
    }
    groups.set(
      source.rootLocationId,
      {
        rootLocationId: source.rootLocationId,
        locationName: source.rootLocation?.name ?? `Location ${source.rootLocationId}`,
        locationKind:
          source.rootLocation?.kind === "station"
            ? "station"
            : source.rootLocation?.kind === "structure"
              ? "structure"
              : "location",
        sources: [source],
      },
    );
  }
  return [...groups.values()].map((group) => ({
    ...group,
    sources: [...group.sources].sort(
      (left, right) =>
        corporationHangarSortValue(left.locationFlag)
        - corporationHangarSortValue(right.locationFlag),
    ),
  }));
}

function corporationHangarSortValue(locationFlag: string) {
  if (locationFlag === "CorpDeliveries") return 8;
  const match = /^CorpSAG([1-7])$/.exec(locationFlag);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function corporationSourceGroupMatches(group: CorporationSourceGroup, filterText: string) {
  const normalizedFilter = filterText.trim().toLocaleLowerCase();
  if (!normalizedFilter) return true;
  const searchableValues = [
    group.locationName,
    ...group.sources.flatMap((source) => [
      source.rootLocation?.name,
      source.rootLocation?.systemName,
      source.rootLocation?.systemId?.toString(),
      ...source.containers.map((container) => container.name),
    ]),
  ];
  return searchableValues.some(
    (value) => value?.toLocaleLowerCase().includes(normalizedFilter) ?? false,
  );
}

/** Configures which corporation hangars and named containers are included in planning. */
export default function CorporationHangarSettings() {
  const { language } = useAppLanguage();
  const [characters, setCharacters] = useState<ClientCharacter[]>([]);
  const [corporationSources, setCorporationSources] = useState<ClientCorporationSource[]>([]);
  const [corporationSettings, setCorporationSettings] = useState<ClientCorporationSettings[]>([]);
  const [savingSourceKey, setSavingSourceKey] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [selectedCorporationId, setSelectedCorporationId] = useState<number | null>(null);
  const [pendingBulkAction, setPendingBulkAction] = useState<BulkAction | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadPageData(reload = false) {
      try {
        const [assetsData, settings, loadedCharacters] = await Promise.all([
          loadClientAssets(language, reload),
          loadClientCorporationSettings(reload),
          loadClientCharacters(reload),
        ]);
        if (cancelled) return;
        setCorporationSources(assetsData.corporationSources ?? []);
        setCorporationSettings(settings);
        setCharacters(loadedCharacters);
      }
      catch {
        if (cancelled) return;
        setCorporationSources([]);
        setCorporationSettings([]);
        setCharacters([]);
      }
    }

    void loadPageData();
    const handleRefresh = (event: Event) => {
      const detail = (event as CustomEvent<RefreshDetail>).detail;
      if (detail.rateLimitedUntil) return;
      if (detail.corporationSources) {
        setCorporationSources(detail.corporationSources);
        return;
      }
      void loadPageData(true);
    };
    const handleSettingsChanged = () => {
      void loadPageData(true);
    };
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    window.addEventListener("assembly-line-corporation-settings-changed", handleSettingsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
      window.removeEventListener(
        "assembly-line-corporation-settings-changed",
        handleSettingsChanged,
      );
    };
  }, [language]);

  async function setCorporationSourceSelected(
    source: ClientCorporationSource,
    kind: "direct" | "container",
    selected: boolean,
    containerItemId?: number,
  ) {
    const previousSettings = corporationSettings.find(
      (entry) => entry.corporationId === source.corporationId,
    );
    const nextSettings: ClientCorporationSettings = {
      corporationId: source.corporationId,
      supportEnabled: previousSettings?.supportEnabled ?? true,
      directHangars: [...(previousSettings?.directHangars ?? [])],
      containerItemIds: [...(previousSettings?.containerItemIds ?? [])],
    };
    if (kind === "direct") {
      nextSettings.directHangars = selected
        ? [
            ...nextSettings.directHangars.filter(
              (entry) =>
                entry.rootLocationId !== source.rootLocationId
                || entry.locationFlag !== source.locationFlag,
            ),
            { rootLocationId: source.rootLocationId, locationFlag: source.locationFlag },
          ]
        : nextSettings.directHangars.filter(
            (entry) =>
              entry.rootLocationId !== source.rootLocationId
              || entry.locationFlag !== source.locationFlag,
          );
    }
    else if (containerItemId !== undefined) {
      nextSettings.containerItemIds = selected
        ? [...new Set([...nextSettings.containerItemIds, containerItemId])]
        : nextSettings.containerItemIds.filter((itemId) => itemId !== containerItemId);
    }
    const sourceKey = `${source.corporationId}:${source.rootLocationId}:${source.locationFlag}:${kind}:${containerItemId ?? ""}`;
    const previousSources = corporationSources;
    setSavingSourceKey(sourceKey);
    setSourceError(null);
    setCorporationSources((current) =>
      current.map((entry) => {
        if (
          entry.corporationId !== source.corporationId
          || entry.rootLocationId !== source.rootLocationId
          || entry.locationFlag !== source.locationFlag
        ) return entry;
        return {
          ...entry,
          selected: kind === "direct" ? selected : entry.selected,
          containers: entry.containers.map((container) =>
            container.itemId === containerItemId ? { ...container, selected } : container,
          ),
        };
      }),
    );
    try {
      await saveClientCorporationSettings(nextSettings);
      setCorporationSettings((current) => [
        ...current.filter((entry) => entry.corporationId !== source.corporationId),
        nextSettings,
      ]);
      window.dispatchEvent(new CustomEvent("assembly-line-corporation-settings-changed"));
    }
    catch (error) {
      setCorporationSources(previousSources);
      setSourceError(
        error instanceof Error ? error.message : "Could not update corporation hangar settings.",
      );
    }
    finally {
      setSavingSourceKey(null);
    }
  }

  async function setAllCorporationSources(action: BulkAction) {
    const corporation = selectedCorporation;
    if (!corporation) return;
    const selectedSources = corporationSources.filter(
      (source) => source.corporationId === corporation.corporationId,
    );
    const previousSettings = corporationSettings.find(
      (entry) => entry.corporationId === corporation.corporationId,
    );
    const selectAll = action === "select";
    const nextSettings: ClientCorporationSettings = {
      corporationId: corporation.corporationId,
      supportEnabled: previousSettings?.supportEnabled ?? true,
      directHangars: selectAll
        ? selectedSources
            .filter((source) => source.canQuery)
            .map((source) => ({
              rootLocationId: source.rootLocationId,
              locationFlag: source.locationFlag,
            }))
        : [],
      containerItemIds: selectAll
        ? [
            ...new Set(
              selectedSources.flatMap((source) =>
                source.containers.map((container) => container.itemId),
              ),
            ),
          ]
        : [],
    };
    const previousSources = corporationSources;
    setSavingSourceKey(`bulk:${corporation.corporationId}:${action}`);
    setSourceError(null);
    setCorporationSources((current) =>
      current.map((source) => {
        if (source.corporationId !== corporation.corporationId) return source;
        return {
          ...source,
          selected: selectAll && source.canQuery,
          containers: source.containers.map((container) => ({
            ...container,
            selected: selectAll,
          })),
        };
      }),
    );
    try {
      await saveClientCorporationSettings(nextSettings);
      setCorporationSettings((current) => [
        ...current.filter((entry) => entry.corporationId !== corporation.corporationId),
        nextSettings,
      ]);
      window.dispatchEvent(new CustomEvent("assembly-line-corporation-settings-changed"));
    }
    catch (error) {
      setCorporationSources(previousSources);
      setSourceError(
        error instanceof Error ? error.message : "Could not update corporation hangar settings.",
      );
    }
    finally {
      setSavingSourceKey(null);
    }
  }

  function confirmBulkAction() {
    if (!pendingBulkAction) return;
    const action = pendingBulkAction;
    setPendingBulkAction(null);
    void setAllCorporationSources(action);
  }

  const corporations = groupCorporations(characters);
  const selectedCorporation =
    corporations.length === 0
      ? null
      : (
          corporations.find((corporation) => corporation.corporationId === selectedCorporationId)
          ?? corporations[0]
        );
  const selectedCorporationSources = corporationSources.filter(
    (source) => source.corporationId === selectedCorporation?.corporationId,
  );
  const corporationSourceGroups = groupCorporationSources(selectedCorporationSources);
  const filteredCorporationSourceGroups = corporationSourceGroups.filter((group) =>
    corporationSourceGroupMatches(group, filterText),
  );

  return (
    <>
      <div className={styles.pageIntro}>
        <div>
          <p className="eyebrow">WORKSPACE / CONFIGURATION</p>
          <h1>Corp Hangers</h1>
          <p className={styles.subtitle}>
            Configure corporation hangar access for production planning.
          </p>
        </div>
      </div>
      {sourceError && (
        <Alert variant="destructive" className={styles.importError}>
          <AlertDescription>{sourceError}</AlertDescription>
        </Alert>
      )}
      <section className={`${styles.panel} flex flex-col gap-4`}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>01 / CORPORATIONS</p>
            <h2>Corporation</h2>
          </div>
          <span className={styles.panelDescription}>Authenticated in this collection</span>
        </div>
        {corporations.length === 0 ? (
          <Empty className={styles.emptyBuildList}>
            <EmptyDescription>No authenticated corporations are available.</EmptyDescription>
          </Empty>
        ) : (
          <Select
            value={selectedCorporation ? String(selectedCorporation.corporationId) : ""}
            onValueChange={(value) => {
              if (value) setSelectedCorporationId(Number(value));
            }}
          >
            <SelectTrigger aria-label="Select corporation" className="w-full max-w-xl">
              <SelectValue placeholder="Select corporation">
                {() => {
                  if (!selectedCorporation) return "Select corporation";
                  const corporationName =
                    selectedCorporation.corporationName
                    ?? `Corporation ${selectedCorporation.corporationId}`;
                  return (
                    <>
                      <Image
                        className="size-6 shrink-0"
                        src={eveCorporationLogoUrl(selectedCorporation.corporationId, 64)}
                        alt=""
                        width={24}
                        height={24}
                      />
                      <span className="min-w-0 flex-1 truncate">{corporationName}</span>
                      <Badge
                        variant={selectedCorporation.hasDirectorAccess ? "default" : "outline"}
                      >
                        {selectedCorporation.hasDirectorAccess
                          ? "Director access"
                          : "No Director access"}
                      </Badge>
                    </>
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {corporations.map((corporation) => {
                  const corporationName =
                    corporation.corporationName ?? `Corporation ${corporation.corporationId}`;
                  return (
                    <SelectItem
                      key={corporation.corporationId}
                      value={String(corporation.corporationId)}
                    >
                      <Image
                        className="size-6 shrink-0"
                        src={eveCorporationLogoUrl(corporation.corporationId, 64)}
                        alt=""
                        width={24}
                        height={24}
                      />
                      <span className="min-w-0 flex-1 truncate">{corporationName}</span>
                      <Badge variant={corporation.hasDirectorAccess ? "default" : "outline"}>
                        {corporation.hasDirectorAccess ? "Director access" : "No Director access"}
                      </Badge>
                    </SelectItem>
                  );
                })}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </section>
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>02 / PLANNING ACCESS</p>
            <h2>Planning access</h2>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button
              size="sm"
              variant="destructive"
              disabled={!selectedCorporation || savingSourceKey !== null}
              onClick={() => setPendingBulkAction("clear")}
            >
              <ListX data-icon="inline-start" />
              Clear All
            </Button>
            {selectedCorporation?.hasDirectorAccess && (
              <Button
                size="sm"
                variant="outline"
                disabled={selectedCorporationSources.length === 0 || savingSourceKey !== null}
                onClick={() => setPendingBulkAction("select")}
              >
                <CheckCheck data-icon="inline-start" />
                Select All
              </Button>
            )}
            <Input
              aria-label="Filter by structure, system, or container"
              className="w-56"
              onChange={(event) => setFilterText(event.target.value)}
              placeholder="Filter..."
              type="search"
              value={filterText}
            />
            <Link className={styles.dialogLink} href="/characters">
              Manage corporation access
            </Link>
          </div>
        </div>
        {corporations.length === 0 ? (
          <Empty className={styles.emptyBuildList}>
            <EmptyDescription>
              Connect a character to this collection to discover corporation hangars and named
              containers.
            </EmptyDescription>
          </Empty>
        ) : selectedCorporationSources.length === 0 ? (
          <Empty className={styles.emptyBuildList}>
            <EmptyDescription>
              Enable corporation support on Characters, then refresh data to discover hangars and
              named containers.
            </EmptyDescription>
          </Empty>
        ) : filteredCorporationSourceGroups.length === 0 ? (
          <Empty className={styles.emptyBuildList}>
            <EmptyDescription>No corporation structures match this filter.</EmptyDescription>
          </Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {filteredCorporationSourceGroups.map((group) => {
              const locationTypeLabel =
                group.locationKind === "station"
                  ? "Station"
                  : group.locationKind === "structure"
                    ? "Structure"
                    : "Location";
              return (
                <section
                  className="flex flex-col gap-3 border border-border p-4"
                  key={group.rootLocationId}
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {locationTypeLabel}
                      </span>
                      <h3 className="text-lg font-semibold">{group.locationName}</h3>
                      <span className="text-sm text-muted-foreground">
                        {group.rootLocationId} · {group.sources.length} hangar
                        {group.sources.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-3 border-t border-border pt-3">
                    {group.sources.map((source) => {
                      const directKey = `${source.corporationId}:${source.rootLocationId}:${source.locationFlag}:direct:`;
                      return (
                        <section
                          className="flex flex-col gap-3 border-b border-border pb-3 last:border-b-0 last:pb-0"
                          key={`${source.corporationId}:${source.rootLocationId}:${source.locationFlag}`}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-4">
                            <div className="min-w-0">
                              <h4 className="font-semibold">{source.label}</h4>
                              <span className="text-xs text-muted-foreground">
                                {source.canTake ? "Materials and blueprints" : "Blueprints only"}
                                {" · "}
                                {source.canTake
                                  ? "Take access"
                                  : source.canQuery
                                    ? "Query access"
                                    : "No access"}
                              </span>
                            </div>
                            <label className="flex shrink-0 items-center gap-2 text-xs">
                              <span>Direct hangar contents</span>
                              {savingSourceKey === directKey ? (
                                <span className="inline-flex h-[18px] w-8 items-center justify-center">
                                  <Spinner
                                    aria-label={`Saving direct contents for ${source.label}`}
                                  />
                                </span>
                              ) : (
                                <Switch
                                  checked={source.selected}
                                  disabled={!source.canQuery}
                                  onCheckedChange={(checked) => {
                                    void setCorporationSourceSelected(source, "direct", checked);
                                  }}
                                  aria-label={`Select direct contents for ${source.label}`}
                                />
                              )}
                            </label>
                          </div>
                          {source.containers.length > 0 && (
                            <div className="flex flex-col gap-2 border-l border-border pl-4">
                              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Named containers
                              </span>
                              {source.containers.map((container) => {
                                const containerKey = `${source.corporationId}:${source.rootLocationId}:${source.locationFlag}:container:${container.itemId}`;
                                return (
                                  <label
                                    className="flex min-w-0 items-center justify-between gap-3 text-sm"
                                    key={container.itemId}
                                  >
                                    <span className="min-w-0 truncate">
                                      {container.name ?? `Container ${container.itemId}`}
                                    </span>
                                    {savingSourceKey === containerKey ? (
                                      <span className="inline-flex h-[18px] w-8 items-center justify-center">
                                        <Spinner
                                          aria-label={`Saving ${container.name ?? `container ${container.itemId}`}`}
                                        />
                                      </span>
                                    ) : (
                                      <Switch
                                        checked={container.selected}
                                        onCheckedChange={(checked) => {
                                          void setCorporationSourceSelected(
                                            source,
                                            "container",
                                            checked,
                                            container.itemId,
                                          );
                                        }}
                                        aria-label={`Select ${container.name ?? `container ${container.itemId}`}`}
                                      />
                                    )}
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </section>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </section>
      <AlertDialog
        open={pendingBulkAction !== null}
        onOpenChange={(open) => {
          if (!open && savingSourceKey === null) setPendingBulkAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingBulkAction === "clear" ? "Clear all hangar access?" : "Select all hangars?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingBulkAction === "clear"
                ? `Unset direct hangar and named-container access for ${selectedCorporation?.corporationName ?? "this corporation"}.`
                : `Enable direct hangar and named-container access for ${selectedCorporation?.corporationName ?? "this corporation"}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={pendingBulkAction === "clear" ? "destructive" : "default"}
              onClick={confirmBulkAction}
            >
              {pendingBulkAction === "clear" ? "Clear all" : "Select all"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
