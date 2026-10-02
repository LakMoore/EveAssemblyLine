"use client";

import { useEffect, useRef, useState } from "react";
import { NoPrefetchLink } from "@/components/NoPrefetchLink";
import EveAuthorizationWarning from "@/components/EveAuthorizationWarning";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  loadClientAssets,
  loadClientCharacterState,
  loadClientSession,
} from "@/lib/client/requestCache";
import { loadEndpointRecord, saveEndpointResponse } from "@/lib/client/refreshCache";
import {
  loadCompressSettings,
  saveCompressSettings,
  type CompressMaterial,
  type CompressSettings,
} from "@/lib/planning/compressSettingsStore";
import type { KnownStructure } from "@/lib/planning/preferences";
import { loadStructures } from "@/lib/planning/structureStore";
import { marketHubs } from "@/lib/reference/marketHubs";
import type { SdeLanguage } from "@/lib/reference/languages";

/** One location available for reprocessing configuration. */
export type ReprocessingLocationOption = {
  id: string;
  name?: string;
  locationType: "station" | "structure";
  structureTypeId?: number;
  securityStatus?: number;
  rigs?: string[];
  rigTypeIds?: number[];
  rankBonus?: number;
  baseYield?: number;
  canReprocess?: boolean;
};

/** Character skill and implant data used by reprocessing calculations. */
export type ReprocessingCharacterOption = {
  id: string;
  characterId: number;
  name: string;
  skills?: Record<string, number>;
  implants: number[];
};

/** Implant choice and its reprocessing yield level. */
export type ReprocessingImplantOption = {
  id: string;
  name: string;
  level: number;
  typeId?: number;
};

type ReprocessingOptionsData = {
  optionsVersion: number;
  characterImplants: Partial<Record<string, number[]>>;
  implants: ReprocessingImplantOption[];
  relevantSkillIds: number[];
};

type ReprocessingOptions = ReprocessingOptionsData & {
  locations: ReprocessingLocationOption[];
  characters: ReprocessingCharacterOption[];
};

type SettingsUpdate = Partial<CompressSettings> | ((current: CompressSettings) => CompressSettings);

/** Shared settings state and derived reprocessing inputs for both tools. */
export type CompressSettingsState = {
  settings: CompressSettings;
  loadKey: string;
  options: ReprocessingOptions;
  locationOptions: ReprocessingLocationOption[];
  selectedLocation?: ReprocessingLocationOption;
  selectedCharacter?: ReprocessingCharacterOption;
  selectedImplant?: ReprocessingImplantOption;
  implantOptions: ReprocessingImplantOption[];
  skillLevels: Record<string, number>;
  isLoading: boolean;
  error: string;
  updateSettings: (next: SettingsUpdate) => void;
};

const defaultSettings: CompressSettings = {
  locationId: "npc",
  characterId: "all-zero",
  implantId: "none",
  marketId: "jita",
  orderType: "sell",
  items: [],
};

const emptyOptions: ReprocessingOptions = {
  optionsVersion: 3,
  locations: [],
  characters: [],
  characterImplants: {},
  implants: [],
  relevantSkillIds: [],
};

/** Merges duplicate materials while preserving the first item's display metadata. */
export function mergeCompressItems(items: CompressMaterial[]) {
  const merged = new Map<number, CompressMaterial>();
  for (const item of items) {
    const existing = merged.get(item.typeId);
    merged.set(
      item.typeId,
      existing ? { ...existing, quantity: existing.quantity + item.quantity } : item,
    );
  }
  return [...merged.values()];
}

/** Removes repeated system names in persisted structure labels. */
function normalizeLocationName(name: string) {
  return name.replace(/^(.+?) - \1 - /i, "$1 - ");
}

/** Creates a stable duplicate key for asset and manually configured locations. */
function locationKey(location: ReprocessingLocationOption) {
  return location.structureTypeId !== undefined && location.structureTypeId !== 0 && location.name
    ? `structure:${normalizeLocationName(location.name).toLocaleLowerCase()}`
    : location.id;
}

/** Converts configured structures into the label used by the shared location selector. */
function structureDisplayName(structure: KnownStructure) {
  return structure.name.startsWith(`${structure.systemName} - `)
    ? structure.name
    : `${structure.systemName} - ${structure.name}`;
}

/** Loads and persists the compression/reprocessing settings used by both tools. */
export function useCompressSettings(language: SdeLanguage) {
  const [options, setOptions] = useState<ReprocessingOptions>(emptyOptions);
  const [settings, setSettings] = useState<CompressSettings>(defaultSettings);
  const [loadedOptionsKey, setLoadedOptionsKey] = useState("");
  const [error, setError] = useState("");
  const [optionsRefreshVersion, setOptionsRefreshVersion] = useState(0);
  const completedOptionsKeyRef = useRef("");
  const optionsLoadKey = `${language}:${optionsRefreshVersion}`;
  const isLoading = loadedOptionsKey !== optionsLoadKey;

  useEffect(() => {
    const requestedOptionsKey = `${language}:${optionsRefreshVersion}`;
    if (completedOptionsKeyRef.current === requestedOptionsKey) return;
    const isRefreshLoad = optionsRefreshVersion > 0;
    let isActive = true;
    setError("");

    Promise
      .all([
        loadCompressSettings(),
        loadClientSession(),
        loadEndpointRecord<Partial<ReprocessingOptionsData>>("compress/options"),
        loadClientAssets(language, isRefreshLoad).catch(() => null),
        loadStructures().catch(() => []),
      ])
      .then(async ([loadedSettings, session, cachedOptions, cachedAssets, knownStructures]) => {
        const characterState = session.authenticated ? await loadClientCharacterState() : null;
        const loadedFacilities = cachedAssets?.facilities ?? [];
        let loadedOptions = cachedOptions?.data;
        const cachedCharacterImplants =
          loadedOptions && Object.hasOwn(loadedOptions, "characterImplants")
            ? loadedOptions.characterImplants
            : undefined;
        const hasCachedCharacterImplants =
          loadedOptions?.optionsVersion === 3
          && cachedCharacterImplants !== undefined
          && (session.characters ?? []).every((character) =>
            Object.hasOwn(cachedCharacterImplants, String(character.characterId)),
          );
        if (isRefreshLoad || !loadedOptions || !hasCachedCharacterImplants) {
          const optionsResponse = await fetch(
            "/api/compress/options",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              cache: "no-store",
              body: JSON.stringify({ language }),
            },
          );
          loadedOptions = (await optionsResponse.json()) as ReprocessingOptionsData;
          if (!optionsResponse.ok) throw new Error("Could not load compression options.");
          await saveEndpointResponse("compress/options", "/api/compress/options", loadedOptions);
        }
        if (!loadedOptions.characterImplants) {
          throw new Error("Compression options did not include character implants.");
        }

        const characterImplants = loadedOptions.characterImplants;
        const rawLocations: ReprocessingLocationOption[] = [
          ...loadedFacilities.map((facility) => ({
            id: String(facility.id),
            name: facility.name,
            locationType: facility.locationType,
            structureTypeId: facility.typeId,
            securityStatus: facility.securityStatus,
            rigs: facility.rigTypeIds.map((typeId) => String(typeId)),
            rigTypeIds: facility.rigTypeIds,
            baseYield: (facility.activities.reprocessing.baseYield ?? 0) * 100,
            canReprocess: facility.activities.reprocessing.available,
          })),
          ...knownStructures.flatMap((structure) =>
            structure.esiStructureId === undefined
              ? []
              : [
                  {
                    id: String(structure.esiStructureId),
                    name: structureDisplayName(structure),
                    locationType: "structure" as const,
                    structureTypeId: structure.typeId,
                    rigs: structure.rigs,
                    rigTypeIds: structure.rigTypeIds ?? [],
                    securityStatus: structure.securityStatus,
                    baseYield: 0,
                    canReprocess: structure.allowReprocessing !== false,
                  },
                ],
          ),
        ].filter(
          (location, index, all) =>
            all.findIndex((candidate) => locationKey(candidate) === locationKey(location))
            === index,
        );
        const locationOptions = rawLocations
          .map((location) => {
            const baseYield = location.baseYield ?? 50;
            return { ...location, rankBonus: baseYield - 50 };
          })
          .sort(
            (left, right) =>
              right.rankBonus - left.rankBonus
              || (left.name ?? left.id).localeCompare(right.name ?? right.id),
          );
        const normalizedSettings: CompressSettings = {
          ...loadedSettings,
          items: Array.isArray(loadedSettings.items)
            ? mergeCompressItems(loadedSettings.items)
            : [],
          locationId: locationOptions.some((location) => location.id === loadedSettings.locationId)
            ? loadedSettings.locationId
            : (locationOptions[0]?.id ?? loadedSettings.locationId),
          marketId: marketHubs.some((market) => market.id === loadedSettings.marketId)
            ? loadedSettings.marketId
            : "jita",
        };
        const characters = (session.characters ?? []).map((character) => ({
          id: `character:${character.characterId}`,
          characterId: character.characterId,
          name: character.characterName,
          implants: characterImplants[String(character.characterId)] ?? [],
          skills: Object.fromEntries(
            (
              characterState?.characters?.find(
                (status) => status.characterId === character.characterId,
              )?.skills?.body ?? []
            ).map((skill) => [String(skill.skillId), skill.activeSkillLevel]),
          ),
        }));
        if (!isActive) return;
        setOptions({
          ...loadedOptions,
          optionsVersion: loadedOptions.optionsVersion ?? 2,
          characterImplants,
          implants: loadedOptions.implants ?? [],
          relevantSkillIds: loadedOptions.relevantSkillIds ?? [],
          characters,
          locations: locationOptions,
        });
        setSettings(normalizedSettings);
        void saveCompressSettings(normalizedSettings);
      })
      .catch((caughtError: unknown) => {
        if (!isActive) return;
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Could not load compression options.",
        );
      })
      .finally(() => {
        if (!isActive) return;
        completedOptionsKeyRef.current = requestedOptionsKey;
        setLoadedOptionsKey(requestedOptionsKey);
      });

    return () => {
      isActive = false;
    };
  }, [language, optionsRefreshVersion]);

  useEffect(() => {
    const handleRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ rateLimitedUntil?: string | null }>).detail;
      if (!detail.rateLimitedUntil) setOptionsRefreshVersion((version) => version + 1);
    };
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    return () => window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
  }, []);

  const updateSettings = (next: SettingsUpdate) => {
    setSettings((current) => {
      const updated = typeof next === "function" ? next(current) : { ...current, ...next };
      void saveCompressSettings(updated);
      return updated;
    });
  };

  const locationOptions = options.locations;
  const selectedLocation = locationOptions.find((location) => location.id === settings.locationId);
  const selectedCharacter = options.characters.find(
    (character) => character.id === settings.characterId,
  );
  const implantOptions = (
    selectedCharacter
      ? options.implants.filter(
          (implant) =>
            implant.id === "none"
            || (
              implant.typeId !== undefined
              && selectedCharacter.implants.includes(implant.typeId)
            ),
        )
      : options.implants
  ).filter((implant) => implant.id === "none" || implant.name.includes("RX-"));
  const selectedImplant = implantOptions.find((implant) => implant.id === settings.implantId);
  const skillLevels =
    settings.characterId === "all-zero"
      ? Object.fromEntries(options.relevantSkillIds.map((id) => [String(id), 0]))
      : settings.characterId === "all-iv"
        ? Object.fromEntries(options.relevantSkillIds.map((id) => [String(id), 4]))
        : settings.characterId === "all-v"
          ? Object.fromEntries(options.relevantSkillIds.map((id) => [String(id), 5]))
          : (selectedCharacter?.skills ?? {});

  return {
    settings,
    loadKey: optionsLoadKey,
    options,
    locationOptions,
    selectedLocation,
    selectedCharacter,
    selectedImplant,
    implantOptions,
    skillLevels,
    isLoading,
    error,
    updateSettings,
  } satisfies CompressSettingsState;
}

/** Renders the shared persisted settings used by compression and ore pricing. */
export function CompressSettingsPanel({
  state,
  className,
  showOrderType = true,
}: {
  state: CompressSettingsState;
  className?: string;
  showOrderType?: boolean;
}) {
  const { settings, options, locationOptions, selectedLocation, selectedImplant, implantOptions } =
    state;
  const groupedLocationOptions = [
    { kind: "structure" as const, label: "Structures" },
    { kind: "station" as const, label: "Stations" },
  ].map((group) => ({
    ...group,
    locations: locationOptions
      .filter((location) => location.locationType === group.kind)
      .sort(
        (left, right) =>
          (right.baseYield ?? 50) - (left.baseYield ?? 50)
          || (left.name ?? left.id).localeCompare(right.name ?? right.id),
      ),
  }));
  const sortedLocationOptions = groupedLocationOptions.flatMap((group) => group.locations);

  return (
    <div className={className} aria-busy={state.isLoading}>
      {state.error && (
        <Alert variant="destructive" className="col-span-full">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {locationOptions.length > 0 ? (
        <Label className="flex-col items-start gap-1.5">
          <span className="text-xs text-muted-foreground">LOCATION</span>
          <Select
            disabled={state.isLoading}
            value={settings.locationId}
            onValueChange={(value) => value && state.updateSettings({ locationId: value })}
            items={sortedLocationOptions.map((location) => ({
              value: location.id,
              label: `${location.name ?? `Location ${location.id}`}${location.canReprocess === false ? " [No Reprocessing]" : ""} · ${Math.round(location.baseYield ?? 50)}%`,
              disabled: location.canReprocess === false,
            }))}
          >
            <SelectTrigger className="w-full" aria-label="Reprocessing location">
              <SelectValue className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <span className="min-w-0 truncate">
                  {selectedLocation?.name ?? `Location ${settings.locationId}`}
                </span>
                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                  {Math.round(selectedLocation?.baseYield ?? 50)}%
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {groupedLocationOptions.map((group) => (
                <SelectGroup key={group.kind}>
                  <SelectLabel>{group.label}</SelectLabel>
                  {group.locations.map((location) => (
                    <SelectItem
                      value={location.id}
                      key={location.id}
                      className="items-start *:min-w-0 *:shrink *:leading-snug *:wrap-anywhere *:whitespace-normal"
                      disabled={location.canReprocess === false}
                    >
                      {location.name ?? `Location ${location.id}`}
                      {location.canReprocess === false ? " [No Reprocessing]" : ""} ·{" "}
                      {Math.round(location.baseYield ?? 50)}%
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </Label>
      ) : (
        <Alert>
          <AlertTitle>No reprocessing locations found.</AlertTitle>
          <AlertDescription>
            Add a reprocessing location on the{" "}
            <NoPrefetchLink href="/structures">Structures</NoPrefetchLink> page or{" "}
            <EveAuthorizationWarning href="/api/auth/eve/start">
              <Button
                type="button"
                variant="link"
                size="xs"
                className="inline h-auto p-0 align-baseline font-normal"
              >
                authenticate a character
              </Button>
            </EveAuthorizationWarning>{" "}
            to find the best location automatically.
          </AlertDescription>
        </Alert>
      )}
      <Label className="flex-col items-start gap-1.5">
        <span className="text-xs text-muted-foreground">CHARACTER / SKILLS</span>
        <Select
          disabled={state.isLoading}
          value={settings.characterId}
          onValueChange={(value) =>
            value && state.updateSettings({ characterId: value, implantId: "none" })
          }
          items={[
            { value: "all-zero", label: "All zero" },
            { value: "all-iv", label: "All IV" },
            { value: "all-v", label: "All V" },
            ...options.characters.map((character) => ({
              value: character.id,
              label: character.name,
            })),
          ]}
        >
          <SelectTrigger className="w-full" aria-label="Character skills">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all-zero">All zero</SelectItem>
              <SelectItem value="all-iv">All IV</SelectItem>
              <SelectItem value="all-v">All V</SelectItem>
              {options.characters.map((character) => (
                <SelectItem value={character.id} key={character.id}>
                  {character.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Label>
      <Label className="flex-col items-start gap-1.5">
        <span className="text-xs text-muted-foreground">IMPLANT</span>
        <Select
          disabled={state.isLoading}
          value={
            implantOptions.some((implant) => implant.id === settings.implantId)
              ? settings.implantId
              : "none"
          }
          onValueChange={(value) => value && state.updateSettings({ implantId: value })}
          items={implantOptions.map((implant) => ({ value: implant.id, label: implant.name }))}
        >
          <SelectTrigger className="w-full" aria-label="Reprocessing implant">
            <SelectValue className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <span className="min-w-0 truncate">{selectedImplant?.name ?? "No implant"}</span>
              <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                +{selectedImplant?.level ?? 0}%
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {implantOptions.map((implant) => (
                <SelectItem value={implant.id} key={implant.id}>
                  {implant.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Label>
      <Label className="flex-col items-start gap-1.5">
        <span className="text-xs text-muted-foreground">MARKET</span>
        <Select
          disabled={state.isLoading}
          value={settings.marketId}
          onValueChange={(value) => value && state.updateSettings({ marketId: value })}
          items={marketHubs.map((market) => ({ value: market.id, label: market.name }))}
        >
          <SelectTrigger className="w-full" aria-label="Market hub">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {marketHubs.map((market) => (
                <SelectItem value={market.id} key={market.id}>
                  {market.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Label>
      {showOrderType && (
        <Label className="flex-col items-start gap-1.5">
          <span className="text-xs text-muted-foreground">ORDER TYPE</span>
          <Select
            disabled={state.isLoading}
            value={settings.orderType}
            onValueChange={(value) =>
              value && state.updateSettings({ orderType: value as CompressSettings["orderType"] })
            }
            items={[
              { value: "buy-1-day", label: "Buy (1 Day)" },
              { value: "buy-5-day", label: "Buy (5 Day)" },
              { value: "sell", label: "Sell" },
            ]}
          >
            <SelectTrigger className="w-full" aria-label="Order type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="buy-1-day">Buy (1 Day)</SelectItem>
                <SelectItem value="buy-5-day">Buy (5 Day)</SelectItem>
                <SelectItem value="sell">Sell</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Label>
      )}
    </div>
  );
}
