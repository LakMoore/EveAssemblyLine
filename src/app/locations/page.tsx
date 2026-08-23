"use client";

import { FormEvent, useEffect, useState } from "react";
import { useAppLanguage } from "../AppShell";
import { ArrowRight, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  defaultLocations,
  locationsStorageKey,
  type KnownStructure,
  type PlannerLocations,
} from "@/lib/planning/preferences";
import type { SdeLanguage } from "@/lib/reference/languages";
import { loadClientSession, loadClientStock } from "@/lib/client/requestCache";
import { fetchRigs } from "@/lib/reference/rigs";
import {
  fetchStructureTypes,
  type StructureSize,
  type StructureType,
} from "@/lib/reference/structureTypes";
import { loadStructures, saveStructures } from "@/lib/planning/structureStore";
import {
  emptyFacilitySettings,
  facilitySettingsKey,
  facilitySettingsName,
  supportsReactionSettings,
  type FacilitySettingsEntry,
  type FacilitySettingsPayload,
} from "@/lib/planning/facilities";
import {
  fetchFacilityResponse,
  publishFacilities,
  facilitySettingsFromStructures,
} from "@/lib/planning/facilitiesStore";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import styles from "../page.module.css";

type SystemMatch = { systemId: number; name: string; securityStatus?: number };
type EsiStructure = {
  structureId: number;
  name: string;
  systemId?: number;
  systemName?: string;
  securityStatus?: number;
  locationType: "structure" | "station";
  assetCount: number;
  personalAssetCount: number;
  corporationAssetCount: number;
  resolved: boolean;
  ownedByCorporation: boolean;
  type?: string;
  size?: StructureSize;
  rigs: string[];
  services?: Array<{ name: string; state: string }>;
  state?: string;
  fuelExpires?: string;
  totalCount: number;
  totalVolume: number;
  bonuses: Record<
    "manufacturing" | "research" | "reactions" | "invention",
    { me: number; te: number; cost: number }
  >;
};
type LocationSort =
  | "alphabetical"
  | "totalVolume"
  | "totalCount"
  | `${"manufacturing" | "research" | "reactions" | "invention"}-${"me" | "te" | "cost"}`;

const locationSortOptions: Array<{ value: LocationSort; label: string }> = [
  { value: "alphabetical", label: "Alphabetical" },
  { value: "totalVolume", label: "Total volume" },
  { value: "totalCount", label: "Total count" },
  { value: "manufacturing-me", label: "Manufacturing ME" },
  { value: "manufacturing-te", label: "Manufacturing TE" },
  { value: "manufacturing-cost", label: "Manufacturing job cost" },
  { value: "research-me", label: "Research ME" },
  { value: "research-te", label: "Research TE" },
  { value: "research-cost", label: "Research job cost" },
  { value: "reactions-me", label: "Reactions ME" },
  { value: "reactions-te", label: "Reactions TE" },
  { value: "reactions-cost", label: "Reactions job cost" },
  { value: "invention-me", label: "Invention ME" },
  { value: "invention-te", label: "Invention TE" },
  { value: "invention-cost", label: "Invention job cost" },
];

function formatPercent(value: number) {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function formatBonusSummary(label: string, bonuses: { me: number; te: number; cost: number }) {
  return `${label} ME ${formatPercent(bonuses.me)} / TE ${formatPercent(bonuses.te)} / Cost ${formatPercent(bonuses.cost)}`;
}

function hasBonus(bonuses: { me: number; te: number; cost: number }) {
  return bonuses.me !== 0 || bonuses.te !== 0 || bonuses.cost !== 0;
}

function visibleBonusSummaries(bonuses: EsiStructure["bonuses"]) {
  const summaries: Array<[string, EsiStructure["bonuses"][keyof EsiStructure["bonuses"]]]> = [
    ["MFG", bonuses.manufacturing],
    ["RES", bonuses.research],
    ["REA", bonuses.reactions],
    ["INV", bonuses.invention],
  ];
  return summaries.filter(([, activityBonuses]) => hasBonus(activityBonuses));
}

function structureMatchKey(systemName: string | undefined, structureName: string) {
  const prefix = systemName ? `${systemName} - ` : "";
  const normalizedName = structureName.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
    ? structureName.slice(prefix.length)
    : structureName;
  return `${systemName ?? ""}::${normalizedName}`.trim().toLocaleLowerCase();
}

function normalizedStructureName(name: string) {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function sameRigTypeIds(left: number[] | undefined, right: number[] | undefined) {
  const leftIds = left ?? [];
  const rightIds = right ?? [];
  return (
    leftIds.length === rightIds.length
    && leftIds.every((rigTypeId, index) => rigTypeId === rightIds[index])
  );
}

function readLegacyStructures() {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(locationsStorageKey);
    const parsed = stored ? (JSON.parse(stored) as Partial<PlannerLocations>) : {};
    return Array.isArray(parsed.structures) ? parsed.structures : [];
  }
  catch {
    return [];
  }
}

export default function LocationsPage() {
  const { language } = useAppLanguage();
  const [structureTypes, setStructureTypes] = useState<StructureType[]>([]);
  const [locations, setLocations] = useState<PlannerLocations>(() => ({
    ...defaultLocations,
    structures: [],
  }));
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingStructure, setEditingStructure] = useState<KnownStructure | null>(null);
  const [rigOptionsBySize, setRigOptionsBySize] = useState<Record<StructureSize, string[]>>({
    Small: [],
    Medium: [],
    Large: [],
    "Extra Large": [],
  });
  const [rigTypeIdsByName, setRigTypeIdsByName] = useState<Record<string, number>>({});
  const [rigNamesByTypeId, setRigNamesByTypeId] = useState<Record<number, string>>({});
  const [facilities, setFacilities] = useState<FacilitySettingsPayload>(emptyFacilitySettings);
  const [esiStructures, setEsiStructures] = useState<EsiStructure[]>([]);
  const [esiConnected, setEsiConnected] = useState(false);
  const [esiRateLimitedUntil, setEsiRateLimitedUntil] = useState<string | null>(null);
  const [locationSort, setLocationSort] = useState<LocationSort>("alphabetical");
  const typeForName = (name: string): StructureType | undefined =>
    structureTypes.find((structure) => structure.name === name);
  useEffect(() => {
    fetchStructureTypes(language)
      .then(setStructureTypes)
      .catch(() => setStructureTypes([]));
  }, [language]);
  useEffect(() => {
    let cancelled = false;

    async function loadKnownStructures() {
      try {
        let structures = await loadStructures();
        if (structures.length === 0) {
          const legacyStructures = readLegacyStructures();
          if (legacyStructures.length > 0) {
            await saveStructures(legacyStructures);
            structures = legacyStructures;
          }
        }
        window.localStorage.removeItem(locationsStorageKey);
        if (!cancelled) {
          setLocations((current) => ({ ...current, structures }));
        }
      }
      catch {}
    }

    void loadKnownStructures();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    loadClientSession()
      .then((data: { authenticated?: boolean; characters?: unknown[] }) => {
        if (!cancelled) setEsiConnected(Boolean(data.authenticated && data.characters?.length));
      })
      .catch(() => {
        if (!cancelled) setEsiConnected(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!esiConnected) return;
    let cancelled = false;

    async function loadEsiStructures() {
      try {
        const data = await (loadClientStock(language) as Promise<{
          locations?: Array<{
            locationId: number;
            name: string;
            locationType: "structure" | "station" | "anchored";
            systemId?: number;
            systemName?: string;
            securityStatus?: number;
            typeId?: number;
            totalCount: number;
            totalVolume: number;
            assetCount: number;
            personalAssetCount: number;
            corporationAssetCount: number;
            resolved: boolean;
          }>;
        }>);
        const facilityResponse = await fetchFacilityResponse();
        if (!facilityResponse) throw new Error("Facilities unavailable");
        setFacilities(facilityResponse.settings);
        const facilitiesByLocationId = new Map(
          facilityResponse.facilities.map((facility) => [facility.id, facility]),
        );
        const locations = (data.locations ?? [])
          .filter(
            (
              location,
            ): location is typeof location & {
              locationType: "structure" | "station";
            } => location.locationType !== "anchored",
          )
          .map((location): EsiStructure => {
            const facility = facilitiesByLocationId.get(location.locationId);
            const manufacturing = facility?.activities.manufacturing;
            const research = facility?.activities.meResearch;
            const reactions = facility?.activities.reactions;
            const invention = facility?.activities.invention;
            return {
              structureId: location.locationId,
              name: location.name,
              locationType: location.locationType,
              systemId: location.systemId,
              systemName: location.systemName,
              securityStatus: location.securityStatus,
              type: location.typeId
                ? (
                    structureTypes.find((structure) => structure.typeId === location.typeId)?.name
                    ?? `Type ${location.typeId}`
                  )
                : undefined,
              assetCount: location.assetCount,
              personalAssetCount: location.personalAssetCount,
              corporationAssetCount: location.corporationAssetCount,
              resolved: location.resolved,
              ownedByCorporation: false,
              rigs: [],
              totalCount: location.totalCount,
              totalVolume: location.totalVolume,
              bonuses: {
                manufacturing: {
                  me: manufacturing?.materialConsumption ?? 0,
                  te: manufacturing?.jobDuration ?? 0,
                  cost: manufacturing?.jobCost ?? 0,
                },
                research: {
                  me: research?.materialConsumption ?? 0,
                  te: research?.jobDuration ?? 0,
                  cost: research?.jobCost ?? 0,
                },
                reactions: {
                  me: reactions?.materialConsumption ?? 0,
                  te: reactions?.jobDuration ?? 0,
                  cost: reactions?.jobCost ?? 0,
                },
                invention: {
                  me: invention?.materialConsumption ?? 0,
                  te: invention?.jobDuration ?? 0,
                  cost: invention?.jobCost ?? 0,
                },
              },
            };
          });
        if (!cancelled) setEsiStructures(locations);
      }
      catch {
        if (!cancelled) setEsiStructures([]);
      }
    }

    const handleRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ rateLimitedUntil?: string | null }>).detail;
      setEsiRateLimitedUntil(detail.rateLimitedUntil ?? null);
      void loadEsiStructures();
    };
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    void loadEsiStructures();
    return () => {
      cancelled = true;
      window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
    };
  }, [esiConnected, language, structureTypes]);

  useEffect(() => {
    fetchRigs(language)
      .then((rigs) => {
        const options: Record<StructureSize, string[]> = {
          Small: ["No Rig"],
          Medium: ["No Rig"],
          Large: ["No Rig"],
          "Extra Large": ["No Rig"],
        };
        for (const rig of rigs) options[rig.size].push(rig.name);
        setRigOptionsBySize(options);
        setRigTypeIdsByName(Object.fromEntries(rigs.map((rig) => [rig.name, rig.typeId])));
        setRigNamesByTypeId(Object.fromEntries(rigs.map((rig) => [rig.typeId, rig.name])));
      })
      .catch(() => setRigOptionsBySize({ Small: [], Medium: [], Large: [], "Extra Large": [] }));
  }, [language]);

  function sharedRigEntry(
    systemId: number | undefined,
    systemName: string | undefined,
    name: string,
  ) {
    if (!systemId) return undefined;
    const entry: FacilitySettingsEntry | undefined =
      facilities.facilities[facilitySettingsKey(systemId, facilitySettingsName(systemName, name))];
    return entry;
  }

  function sharedRigNames(
    systemId: number | undefined,
    systemName: string | undefined,
    name: string,
  ) {
    const entry = sharedRigEntry(systemId, systemName, name);
    if (!entry) return null;
    return entry.rigTypeIds.map((rigTypeId) => rigNamesByTypeId[rigTypeId] ?? "No Rig");
  }

  // The collection rig map is shared by every session, so it wins over the local copy.
  const knownStructures = locations.structures.map((structure) => {
    const entry = sharedRigEntry(structure.systemId, structure.systemName, structure.name);
    if (!entry || sameRigTypeIds(structure.rigTypeIds, entry.rigTypeIds)) return structure;
    return {
      ...structure,
      rigTypeIds: entry.rigTypeIds,
      rigs: entry.rigTypeIds.map((rigTypeId) => rigNamesByTypeId[rigTypeId] ?? "No Rig"),
    };
  });

  const knownStructuresByKey = new Map<string, KnownStructure>();
  for (const structure of knownStructures) {
    knownStructuresByKey.set(structureMatchKey(structure.systemName, structure.name), structure);
    knownStructuresByKey.set(structureMatchKey(undefined, structure.name), structure);
  }

  function findLocalOverride(esiStructure: EsiStructure) {
    return (
      knownStructures.find((known) => known.esiStructureId === esiStructure.structureId)
      ?? knownStructuresByKey.get(structureMatchKey(esiStructure.systemName, esiStructure.name))
      ?? knownStructuresByKey.get(structureMatchKey(undefined, esiStructure.name))
      ?? knownStructures.find((known) => {
        const esiName = normalizedStructureName(esiStructure.name);
        const localNames = [
          known.name,
          known.systemName ? `${known.systemName} - ${known.name}` : "",
        ];
        return localNames.some((name) => name && normalizedStructureName(name) === esiName);
      })
    );
  }

  const displayedEsiStructures = esiStructures.map((structure) => {
    if (structure.locationType !== "structure") return structure;
    const localOverride = findLocalOverride(structure);
    const rigs =
      localOverride?.rigs
      ?? sharedRigNames(structure.systemId, structure.systemName, structure.name);
    return rigs ? { ...structure, rigs } : structure;
  });
  const matchedKnownStructureIds = new Set(
    esiStructures
      .filter((structure) => structure.locationType === "structure")
      .map(findLocalOverride)
      .filter((structure): structure is KnownStructure => Boolean(structure))
      .map((structure) => structure.id),
  );
  const unmatchedKnownStructures = knownStructures.filter(
    (structure) => !matchedKnownStructureIds.has(structure.id),
  );
  const sortedEsiStructures = [...displayedEsiStructures].sort((left, right) => {
    if (locationSort === "alphabetical") return left.name.localeCompare(right.name);
    if (locationSort === "totalVolume") return right.totalVolume - left.totalVolume;
    if (locationSort === "totalCount") return right.totalCount - left.totalCount;
    const [activity, metric] = locationSort.split("-") as [
      "manufacturing" | "research" | "reactions" | "invention",
      "me" | "te" | "cost",
    ];
    return right.bonuses[activity][metric] - left.bonuses[activity][metric];
  });

  function openAddDialog() {
    setEditingStructure(null);
    setIsDialogOpen(true);
  }

  function openEsiEditDialog(esiStructure: EsiStructure) {
    if (esiStructure.locationType !== "structure") return;
    const localOverride = findLocalOverride(esiStructure);
    const type = typeForName(localOverride?.type ?? esiStructure.type ?? "");
    if (!type) return;
    setEditingStructure({
      id: localOverride?.id ?? `esi:${esiStructure.structureId}`,
      esiStructureId: esiStructure.structureId,
      systemId: localOverride?.systemId || esiStructure.systemId || 0,
      systemName: localOverride?.systemName || esiStructure.systemName || "",
      securityStatus: localOverride?.securityStatus ?? esiStructure.securityStatus,
      type: type.name,
      typeId: type.typeId,
      size: esiStructure.size ?? type.size,
      sizeId: type.sizeId,
      name: localOverride?.name ?? esiStructure.name,
      rigs:
        localOverride?.rigs
        ?? sharedRigNames(esiStructure.systemId, esiStructure.systemName, esiStructure.name)
        ?? (esiStructure.rigs.length > 0 ? esiStructure.rigs : ["No Rig", "No Rig", "No Rig"]),
      allowStandardBuilds: localOverride?.allowStandardBuilds,
      allowCapitalBuilds: localOverride?.allowCapitalBuilds,
      allowReprocessing: localOverride?.allowReprocessing,
      allowReactionBuilds: localOverride?.allowReactionBuilds,
      allowBiochemicalReactions: localOverride?.allowBiochemicalReactions,
      allowCompositeReactions: localOverride?.allowCompositeReactions,
      allowHybridReactions: localOverride?.allowHybridReactions,
      allowInvention: localOverride?.allowInvention,
      allowResearch: localOverride?.allowResearch,
      jobTypes: localOverride?.jobTypes,
      settingsLastModified: localOverride?.settingsLastModified,
    });
    setIsDialogOpen(true);
  }

  function removeStructure(id: string) {
    const structures = locations.structures.filter((structure) => structure.id !== id);
    setLocations((current) => ({
      ...current,
      structures,
    }));
    void saveStructures(structures);
  }

  return (
    <>
      <div className={`${styles.pageIntro} ${styles.locationsPageIntro}`}>
        <div>
          <p className={styles.eyebrow}>CONFIGURATION / OPERATIONS</p>
          <h1>Locations</h1>
          <p className={styles.subtitle}>
            Choose operational sites and maintain the structures you use.
          </p>
        </div>
      </div>
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>01 / STRUCTURES</p>
            <h2>Known structures</h2>
          </div>
          <Button
            type="button"
            className={`actionButton ${styles.importButton}`}
            onClick={openAddDialog}
            disabled={structureTypes.length === 0}
          >
            <Plus aria-hidden="true" />
            <span>Add structure</span>
          </Button>
        </div>
        {unmatchedKnownStructures.length === 0 ? (
          <Empty className={styles.emptyBuildList}>
            <EmptyDescription>
              All known structures with assets are listed above. Add a structure to make it
              available in Stock.
            </EmptyDescription>
          </Empty>
        ) : (
          <div className={styles.knownStructureList}>
            {unmatchedKnownStructures.map((structure) => (
              <div className={styles.knownStructure} key={structure.id}>
                <span>
                  <strong>
                    {structure.systemName} - {structure.name}
                  </strong>
                  <span className={styles.knownStructureMeta}>
                    <small>
                      <span>{structure.type}</span>
                      <span>{structure.size}</span>
                      {structure.rigs.length > 0 && (
                        <span>
                          {structure.rigs.filter((rig) => rig !== "No Rig").length} rig
                          {structure.rigs.filter((rig) => rig !== "No Rig").length === 1 ? "" : "s"}
                        </span>
                      )}
                    </small>
                  </span>
                </span>
                <button
                  type="button"
                  className={`actionButton ${styles.importButton}`}
                  aria-label={`Edit ${structure.name}`}
                  title={`Edit ${structure.name}`}
                  onClick={() => {
                    setEditingStructure(structure);
                    setIsDialogOpen(true);
                  }}
                >
                  <Pencil aria-hidden="true" />
                  <span className={styles.structureActionLabel}>Edit</span>
                </button>
                <button
                  type="button"
                  className={`actionButton ${styles.remove}`}
                  aria-label={`Remove ${structure.name}`}
                  onClick={() => removeStructure(structure.id)}
                >
                  <Trash2 aria-hidden="true" />
                  <span className={styles.structureActionLabel}>Delete</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>02 / ESI INVENTORY</p>
            <h2>Locations with assets</h2>
          </div>
          <div className={styles.locationControls}>
            <div className="flex min-w-0 items-center gap-2">
              <Label htmlFor="locations-sort">Sort</Label>
              <Select
                aria-label="Sort locations"
                value={locationSort}
                onValueChange={(value) => {
                  if (value !== null) setLocationSort(value as LocationSort);
                }}
                items={locationSortOptions}
              >
                <SelectTrigger id="locations-sort" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {locationSortOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <span className={styles.panelDescription}>{displayedEsiStructures.length} found</span>
          </div>
        </div>
        {displayedEsiStructures.length === 0 ? (
          <Empty className={styles.emptyBuildList}>
            <EmptyDescription>
              {esiRateLimitedUntil
                ? `ESI rate limit active until ${new Date(esiRateLimitedUntil).toLocaleTimeString()}.`
                : "No structure assets found in the current ESI cache. Refresh ESI data to update this list."}
            </EmptyDescription>
          </Empty>
        ) : (
          <div className={styles.knownStructureList}>
            {sortedEsiStructures.map((structure) => (
              <div className={styles.knownStructure} key={structure.structureId}>
                <span>
                  <strong>{structure.name}</strong>
                  <span className={styles.knownStructureMeta}>
                    <small>
                      {structure.locationType === "station"
                        ? "Station"
                        : (structure.type ?? "Structure")}
                      {" · "}
                      {structure.assetCount.toLocaleString()} records ·{" "}
                      {structure.totalCount.toLocaleString()} quantity ·{" "}
                      {structure.totalVolume.toLocaleString(
                        undefined,
                        {
                          maximumFractionDigits: 2,
                        },
                      )}{" "}
                      m³ Volume · {structure.personalAssetCount.toLocaleString()} character ·{" "}
                      {structure.corporationAssetCount.toLocaleString()} corp
                      {structure.locationType === "structure"
                        ? ` · ${structure.rigs.filter((rig) => rig !== "No Rig").length} rig${structure.rigs.filter((rig) => rig !== "No Rig").length === 1 ? "" : "s"}`
                        : ""}
                      {structure.state ? ` · ${structure.state}` : ""}
                      {structure.services?.length
                        ? ` · ${structure.services.filter((service) => service.state === "online").length} services online`
                        : ""}
                      {structure.fuelExpires
                        ? ` · Fuel expires ${new Date(structure.fuelExpires).toLocaleDateString()}`
                        : ""}
                      {!structure.resolved ? " · Name or metadata unavailable" : ""}
                    </small>
                    {visibleBonusSummaries(structure.bonuses).length > 0 && (
                      <small className={styles.locationBonusLine}>
                        {visibleBonusSummaries(structure.bonuses).map(([label, bonuses], index) => (
                          <span key={label}>
                            {index > 0 ? " · " : ""}
                            {formatBonusSummary(label, bonuses)}
                          </span>
                        ))}
                      </small>
                    )}
                  </span>
                </span>
                {structure.locationType === "structure" && (
                  <button
                    type="button"
                    className={`actionButton ${styles.importButton}`}
                    aria-label={`Edit ${structure.name}`}
                    title={`Edit ${structure.name}`}
                    onClick={() => openEsiEditDialog(structure)}
                  >
                    <Pencil aria-hidden="true" />
                    <span className={styles.structureActionLabel}>Edit</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      {isDialogOpen && (
        <StructureDialog
          language={language}
          structureTypes={structureTypes}
          structure={editingStructure}
          rigOptionsBySize={rigOptionsBySize}
          rigTypeIdsByName={rigTypeIdsByName}
          onCancel={() => setIsDialogOpen(false)}
          onSave={(structure) => {
            const previous = knownStructures.find((current) => current.id === structure.id);
            const structures =
              previous !== undefined
                ? knownStructures.map((current) =>
                    current.id === structure.id ? structure : current,
                  )
                : [...knownStructures, structure];
            setLocations((current) => ({
              ...current,
              structures,
            }));
            void saveStructures(structures);
            void publishFacilities(facilitySettingsFromStructures(structures)).then(setFacilities);
            setIsDialogOpen(false);
            setEditingStructure(null);
          }}
        />
      )}
    </>
  );
}

function StructureDialog({
  language,
  structureTypes,
  onCancel,
  onSave,
  structure,
  rigOptionsBySize,
  rigTypeIdsByName,
}: {
  language: SdeLanguage;
  structureTypes: StructureType[];
  onCancel: () => void;
  onSave: (structure: KnownStructure) => void;
  structure: KnownStructure | null;
  rigOptionsBySize: Record<StructureSize, string[]>;
  rigTypeIdsByName: Record<string, number>;
}) {
  const [systemName, setSystemName] = useState(structure?.systemName ?? "");
  const [system, setSystem] = useState<SystemMatch | null>(
    structure && structure.systemId > 0
      ? {
          systemId: structure.systemId,
          name: structure.systemName,
          securityStatus: structure.securityStatus,
        }
      : null,
  );
  const [suggestions, setSuggestions] = useState<SystemMatch[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const systemAnchor = useComboboxAnchor();
  const [type, setType] = useState(structure?.type ?? structureTypes[0].name);
  const [name, setName] = useState(structure?.name ?? "");
  const [rigs, setRigs] = useState(structure?.rigs ?? ["No Rig", "No Rig", "No Rig"]);
  const [allowStandardBuilds, setAllowStandardBuilds] = useState(
    structure?.allowStandardBuilds ?? true,
  );
  const [allowCapitalBuilds, setAllowCapitalBuilds] = useState(
    structure?.allowCapitalBuilds ?? false,
  );
  const [allowReprocessing, setAllowReprocessing] = useState(structure?.allowReprocessing ?? true);
  const [allowReactionBuilds, setAllowReactionBuilds] = useState(
    structure?.allowReactionBuilds ?? true,
  );
  const [allowBiochemicalReactions, setAllowBiochemicalReactions] = useState(
    structure?.allowBiochemicalReactions ?? structure?.allowReactionBuilds ?? true,
  );
  const [allowCompositeReactions, setAllowCompositeReactions] = useState(
    structure?.allowCompositeReactions ?? structure?.allowReactionBuilds ?? true,
  );
  const [allowHybridReactions, setAllowHybridReactions] = useState(
    structure?.allowHybridReactions ?? structure?.allowReactionBuilds ?? true,
  );
  const [allowInvention, setAllowInvention] = useState(structure?.allowInvention ?? true);
  const [allowResearch, setAllowResearch] = useState(structure?.allowResearch ?? true);
  const [jobTypes, setJobTypes] = useState(() => ({
    standard: String(structure?.jobTypes?.standard ?? 0),
    capital: String(structure?.jobTypes?.capital ?? 0),
    reprocessing: String(structure?.jobTypes?.reprocessing ?? 0),
    reactions: String(structure?.jobTypes?.reactions ?? 0),
    biochemical: String(structure?.jobTypes?.biochemical ?? 0),
    composite: String(structure?.jobTypes?.composite ?? 0),
    hybrid: String(structure?.jobTypes?.hybrid ?? 0),
    invention: String(structure?.jobTypes?.invention ?? 0),
    research: String(structure?.jobTypes?.research ?? 0),
  }));
  const taxRate = (jobType: keyof typeof jobTypes) => jobTypes[jobType];
  const numericTaxRate = (jobType: keyof typeof jobTypes) => {
    const value = Number(jobTypes[jobType]);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  const setTaxRate = (jobType: keyof typeof jobTypes, value: string) => {
    setJobTypes((current) => ({ ...current, [jobType]: value }));
  };
  const selectedType = structureTypes.find((structureType) => structureType.name === type);
  const reactionsAllowed = supportsReactionSettings(
    selectedType?.typeId,
    system?.securityStatus ?? structure?.securityStatus,
  );

  useEffect(() => {
    if (!system || system.securityStatus !== undefined) return;
    let cancelled = false;
    void fetch(`/api/reference/systems?systemId=${system.systemId}&language=${language}`)
      .then((response) => response.json() as Promise<{ item?: SystemMatch | null }>)
      .then((data) => {
        if (!cancelled && data.item) setSystem(data.item);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [language, system]);

  useEffect(() => {
    if (systemName.trim().length < 2 || !isOpen) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () =>
        fetch(
          `/api/reference/systems?query=${encodeURIComponent(systemName)}&language=${language}`,
          { signal: controller.signal },
        )
          .then((response) => response.json() as Promise<{ items?: SystemMatch[] }>)
          .then((data) => setSuggestions(data.items ?? []))
          .catch((error: unknown) => {
            if (!(error instanceof DOMException && error.name === "AbortError")) setSuggestions([]);
          }),
      180,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [isOpen, language, systemName]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!system || !name.trim() || !selectedType) return;
    const savedJobTypes = {
      standard: numericTaxRate("standard"),
      capital: numericTaxRate("capital"),
      reprocessing: numericTaxRate("reprocessing"),
      reactions: numericTaxRate("reactions"),
      biochemical: reactionsAllowed ? numericTaxRate("biochemical") : 0,
      composite: reactionsAllowed ? numericTaxRate("composite") : 0,
      hybrid: reactionsAllowed ? numericTaxRate("hybrid") : 0,
      invention: numericTaxRate("invention"),
      research: numericTaxRate("research"),
    };
    const reactionSettings = reactionsAllowed
      ? {
          allowBiochemicalReactions,
          allowCompositeReactions,
          allowHybridReactions,
        }
      : {
          allowBiochemicalReactions: false,
          allowCompositeReactions: false,
          allowHybridReactions: false,
        };
    onSave({
      id: structure?.id ?? `local:${crypto.randomUUID()}`,
      systemId: system.systemId,
      systemName: system.name,
      securityStatus: system.securityStatus,
      type,
      typeId: selectedType.typeId,
      size: selectedType.size,
      sizeId: selectedType.sizeId,
      name: name.trim(),
      rigs,
      rigTypeIds: rigs.map((rig) => rigTypeIdsByName[rig] ?? 0),
      allowStandardBuilds,
      allowCapitalBuilds,
      allowReprocessing,
      allowReactionBuilds,
      allowInvention,
      allowResearch,
      ...reactionSettings,
      jobTypes: savedJobTypes,
      settingsLastModified: new Date().toISOString(),
      ...(structure?.esiStructureId ? { esiStructureId: structure.esiStructureId } : {}),
    });
  }

  if (!selectedType) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className={styles.importModal} render={<form onSubmit={submit} />}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>STRUCTURE DIRECTORY</p>
            <DialogTitle>{structure ? "Edit structure" : "Add structure"}</DialogTitle>
          </div>
        </div>
        <DialogBody className="no-scrollbar overscroll-contain">
          <FieldGroup>
            <Field>
              <FieldLabel>SYSTEM</FieldLabel>
              <div ref={systemAnchor}>
                <Combobox
                  open={isOpen && systemName.trim().length >= 2}
                  inputValue={systemName}
                  onOpenChange={setIsOpen}
                  onInputValueChange={(value, eventDetails) => {
                    if (eventDetails.reason !== "input-change") return;
                    setSystem(null);
                    setSystemName(value);
                    setIsOpen(true);
                  }}
                  onValueChange={(value) => {
                    const match = suggestions.find(
                      (item) => String(item.systemId) === String(value),
                    );
                    if (match) {
                      setSystem(match);
                      setSystemName(match.name);
                      setIsOpen(false);
                    }
                  }}
                >
                  <ComboboxInput
                    showTrigger={false}
                    onFocus={() => suggestions.length > 0 && setIsOpen(true)}
                    placeholder="Type a system name"
                    aria-label="Search systems"
                  />
                  <ComboboxContent anchor={systemAnchor}>
                    <ComboboxList>
                      {suggestions.length > 0 ? (
                        suggestions.map((match) => (
                          <ComboboxItem key={match.systemId} value={String(match.systemId)}>
                            <span>{match.name}</span>
                            <small>System ID {match.systemId}</small>
                          </ComboboxItem>
                        ))
                      ) : (
                        <ComboboxEmpty>No matching systems.</ComboboxEmpty>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </div>
            </Field>
            <StructureSelect
              label="STRUCTURE TYPE"
              value={type}
              options={structureTypes.map((option) => ({
                value: option.name,
                label: `${option.name} (${option.size})`,
              }))}
              onChange={(value) => {
                const nextType = structureTypes.find(
                  (structureType) => structureType.name === value,
                );
                if (!nextType) return;
                setType(nextType.name);
                setRigs((current) =>
                  current.map((rig) =>
                    rigOptionsBySize[nextType.size].includes(rig) ? rig : "No Rig",
                  ),
                );
              }}
            />
            <Field>
              <FieldLabel htmlFor="structure-name">NAME</FieldLabel>
              <div>
                <Input
                  id="structure-name"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Assembly Bay Alpha"
                  aria-label="Structure name"
                />
              </div>
            </Field>
            {rigs.map((rig, index) => (
              <StructureSelect
                key={index}
                label={`RIG ${index + 1}`}
                value={rig}
                options={rigOptionsBySize[selectedType.size].map((option) => ({
                  value: option,
                  label: option,
                }))}
                onChange={(value) =>
                  setRigs((current) =>
                    current.map((currentRig, rigIndex) =>
                      rigIndex === index ? value : currentRig,
                    ),
                  )
                }
              />
            ))}
          </FieldGroup>
          <div className={styles.constructionGrid}>
            <div className={styles.constructionGridHeader} aria-hidden="true">
              <span />
              <span>ENABLED</span>
              <span>TAX RATE</span>
            </div>
            <div className={styles.constructionGridRow}>
              <span>REPROCESSING</span>
              <ActivitySwitch
                label="reprocessing"
                checked={allowReprocessing}
                onCheckedChange={setAllowReprocessing}
              />
              <TaxRateInput
                label="Reprocessing"
                value={taxRate("reprocessing")}
                onChange={(value) => setTaxRate("reprocessing", value)}
              />
            </div>
            <div className={styles.constructionGridRow}>
              <span>STANDARD MANUFACTURING</span>
              <ActivitySwitch
                label="standard manufacturing"
                checked={allowStandardBuilds}
                onCheckedChange={setAllowStandardBuilds}
              />
              <TaxRateInput
                label="Standard manufacturing"
                value={taxRate("standard")}
                onChange={(value) => setTaxRate("standard", value)}
              />
            </div>
            <div className={styles.constructionGridRow}>
              <span>CAPITAL MANUFACTURING</span>
              <ActivitySwitch
                label="capital manufacturing"
                checked={allowCapitalBuilds}
                onCheckedChange={setAllowCapitalBuilds}
              />
              <TaxRateInput
                label="Capital manufacturing"
                value={taxRate("capital")}
                onChange={(value) => setTaxRate("capital", value)}
              />
            </div>
            <div
              className={`${styles.constructionGridRow} ${
                !reactionsAllowed ? styles.constructionGridRowDisabled : ""
              }`}
            >
              <span>BIOCHEMICAL REACTIONS</span>
              <ActivitySwitch
                label="biochemical reactions"
                checked={reactionsAllowed && allowBiochemicalReactions}
                disabled={!reactionsAllowed}
                onCheckedChange={setAllowBiochemicalReactions}
              />
              <TaxRateInput
                label="Biochemical reaction"
                value={reactionsAllowed ? taxRate("biochemical") : "0.0"}
                disabled={!reactionsAllowed}
                onChange={(value) => setTaxRate("biochemical", value)}
              />
            </div>
            <div
              className={`${styles.constructionGridRow} ${
                !reactionsAllowed ? styles.constructionGridRowDisabled : ""
              }`}
            >
              <span>COMPOSITE REACTIONS</span>
              <ActivitySwitch
                label="composite reactions"
                checked={reactionsAllowed && allowCompositeReactions}
                disabled={!reactionsAllowed}
                onCheckedChange={setAllowCompositeReactions}
              />
              <TaxRateInput
                label="Composite reaction"
                value={reactionsAllowed ? taxRate("composite") : "0.0"}
                disabled={!reactionsAllowed}
                onChange={(value) => setTaxRate("composite", value)}
              />
            </div>
            <div
              className={`${styles.constructionGridRow} ${
                !reactionsAllowed ? styles.constructionGridRowDisabled : ""
              }`}
            >
              <span>HYBRID REACTIONS</span>
              <ActivitySwitch
                label="hybrid reactions"
                checked={reactionsAllowed && allowHybridReactions}
                disabled={!reactionsAllowed}
                onCheckedChange={setAllowHybridReactions}
              />
              <TaxRateInput
                label="Hybrid reaction"
                value={reactionsAllowed ? taxRate("hybrid") : "0.0"}
                disabled={!reactionsAllowed}
                onChange={(value) => setTaxRate("hybrid", value)}
              />
            </div>
            <div className={styles.constructionGridRow}>
              <span>INVENTION</span>
              <ActivitySwitch
                label="invention"
                checked={allowInvention}
                onCheckedChange={setAllowInvention}
              />
              <TaxRateInput
                label="Invention"
                value={taxRate("invention")}
                onChange={(value) => setTaxRate("invention", value)}
              />
            </div>
            <div className={styles.constructionGridRow}>
              <span>RESEARCH</span>
              <ActivitySwitch
                label="research"
                checked={allowResearch}
                onCheckedChange={setAllowResearch}
              />
              <TaxRateInput
                label="Research"
                value={taxRate("research")}
                onChange={(value) => setTaxRate("research", value)}
              />
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!system || !name.trim()}>
            {structure ? "Save structure" : "Add structure"}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StructureSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} onValueChange={(nextValue) => nextValue && onChange(nextValue)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function ActivitySwitch({
  label,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Switch
      size="default"
      checked={checked}
      disabled={disabled}
      aria-label={`Enable ${label.toLocaleLowerCase()}`}
      onCheckedChange={onCheckedChange}
    />
  );
}

function TaxRateInput({
  label,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className={styles.constructionTaxField}>
      <Input
        aria-label={`${label} tax rate`}
        type="number"
        min="0"
        step="0.1"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <span>%</span>
    </div>
  );
}
