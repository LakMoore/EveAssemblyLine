"use client";

import { FormEvent, useEffect, useState } from "react";
import { useAppLanguage } from "../AppShell";
import { Pencil, Plus, Trash2 } from "lucide-react";
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
          <button
            type="button"
            className={`actionButton ${styles.importButton}`}
            onClick={openAddDialog}
            disabled={structureTypes.length === 0}
          >
            <Plus aria-hidden="true" />
            <span>Add structure</span>
          </button>
        </div>
        {unmatchedKnownStructures.length === 0 ? (
          <div className={styles.emptyBuildList}>
            All known structures with assets are listed above. Add a structure to make it available
            in Stock.
          </div>
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
            <label>
              <span>SORT</span>
              <select
                aria-label="Sort locations"
                value={locationSort}
                onChange={(event) => setLocationSort(event.target.value as LocationSort)}
              >
                {locationSortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <span className={styles.panelDescription}>{displayedEsiStructures.length} found</span>
          </div>
        </div>
        {displayedEsiStructures.length === 0 ? (
          <div className={styles.emptyBuildList}>
            {esiRateLimitedUntil
              ? `ESI rate limit active until ${new Date(esiRateLimitedUntil).toLocaleTimeString()}.`
              : "No structure assets found in the current ESI cache. Refresh ESI data to update this list."}
          </div>
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
    <div
      className={styles.modalBackdrop}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <form
        className={styles.importModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="structure-dialog-title"
        onSubmit={submit}
      >
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>STRUCTURE DIRECTORY</p>
            <h2 id="structure-dialog-title">{structure ? "Edit structure" : "Add structure"}</h2>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Close add structure dialog"
            onClick={onCancel}
          >
            ×
          </button>
        </div>
        <label className={styles.field}>
          SYSTEM
          <div className={styles.searchWrap}>
            <div className={styles.search}>
              ⌕{" "}
              <input
                role="combobox"
                aria-controls="structure-system-options"
                aria-expanded={isOpen}
                value={systemName}
                onFocus={() => setIsOpen(true)}
                onChange={(event) => {
                  setSystem(null);
                  setSystemName(event.target.value);
                  setIsOpen(true);
                }}
                placeholder="Type a system name"
                aria-label="Search systems"
                aria-autocomplete="list"
              />
            </div>
            {isOpen && suggestions.length > 0 && (
              <div className={styles.searchResults} id="structure-system-options" role="listbox">
                {suggestions.map((match) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={match.systemId === system?.systemId}
                    className={
                      match.systemId === system?.systemId
                        ? styles.searchResultActive
                        : styles.searchResult
                    }
                    key={match.systemId}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setSystem(match);
                      setSystemName(match.name);
                      setIsOpen(false);
                    }}
                  >
                    <span>{match.name}</span>
                    <small>System ID {match.systemId}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        </label>
        <StructureSelect
          label="STRUCTURE TYPE"
          value={type}
          options={structureTypes.map((option) => ({
            value: option.name,
            label: `${option.name} (${option.size})`,
          }))}
          onChange={(value) => {
            const nextType = structureTypes.find((structureType) => structureType.name === value);
            if (!nextType) return;
            setType(nextType.name);
            setRigs((current) =>
              current.map((rig) =>
                rigOptionsBySize[nextType.size].includes(rig) ? rig : "No Rig",
              ),
            );
          }}
        />
        <label className={styles.field}>
          NAME
          <div className={styles.search}>
            ⌕{" "}
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Assembly Bay Alpha"
              aria-label="Structure name"
            />
          </div>
        </label>
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
                current.map((currentRig, rigIndex) => (rigIndex === index ? value : currentRig)),
              )
            }
          />
        ))}
        <div className={styles.constructionGrid}>
          <div className={styles.constructionGridHeader} aria-hidden="true">
            <span />
            <span>ENABLED</span>
            <span>TAX RATE</span>
          </div>
          <div className={styles.constructionGridRow}>
            <span>REPROCESSING</span>
            <button
              type="button"
              className={styles.stockSwitch}
              role="switch"
              aria-checked={allowReprocessing}
              aria-label="Enable reprocessing"
              onClick={() => setAllowReprocessing((current) => !current)}
            >
              <span className={styles.stockSwitchThumb} />
            </button>
            <div className={styles.constructionTaxField}>
              <input
                className={styles.constructionTaxInput}
                aria-label="Reprocessing tax rate"
                type="number"
                min="0"
                step="0.1"
                value={taxRate("reprocessing")}
                onChange={(event) => setTaxRate("reprocessing", event.target.value)}
              />
              <span>%</span>
            </div>
          </div>
          <div className={styles.constructionGridRow}>
            <span>STANDARD MANUFACTURING</span>
            <button
              type="button"
              className={styles.stockSwitch}
              role="switch"
              aria-checked={allowStandardBuilds}
              aria-label="Enable standard manufacturing"
              onClick={() => setAllowStandardBuilds((current) => !current)}
            >
              <span className={styles.stockSwitchThumb} />
            </button>
            <div className={styles.constructionTaxField}>
              <input
                className={styles.constructionTaxInput}
                aria-label="Standard manufacturing tax rate"
                type="number"
                min="0"
                step="0.1"
                value={taxRate("standard")}
                onChange={(event) => setTaxRate("standard", event.target.value)}
              />
              <span>%</span>
            </div>
          </div>
          <div className={styles.constructionGridRow}>
            <span>CAPITAL MANUFACTURING</span>
            <button
              type="button"
              className={styles.stockSwitch}
              role="switch"
              aria-checked={allowCapitalBuilds}
              aria-label="Enable capital manufacturing"
              onClick={() => setAllowCapitalBuilds((current) => !current)}
            >
              <span className={styles.stockSwitchThumb} />
            </button>
            <div className={styles.constructionTaxField}>
              <input
                className={styles.constructionTaxInput}
                aria-label="Capital manufacturing tax rate"
                type="number"
                min="0"
                step="0.1"
                value={taxRate("capital")}
                onChange={(event) => setTaxRate("capital", event.target.value)}
              />
              <span>%</span>
            </div>
          </div>
          <div
            className={`${styles.constructionGridRow} ${
              !reactionsAllowed ? styles.constructionGridRowDisabled : ""
            }`}
          >
            <span>BIOCHEMICAL REACTIONS</span>
            <button
              type="button"
              className={styles.stockSwitch}
              role="switch"
              aria-checked={reactionsAllowed && allowBiochemicalReactions}
              aria-label="Enable biochemical reactions"
              aria-disabled={!reactionsAllowed}
              disabled={!reactionsAllowed}
              onClick={() => setAllowBiochemicalReactions((current) => !current)}
            >
              <span className={styles.stockSwitchThumb} />
            </button>
            <div className={styles.constructionTaxField}>
              <input
                className={styles.constructionTaxInput}
                aria-label="Biochemical reaction tax rate"
                type="number"
                min="0"
                step="0.1"
                value={reactionsAllowed ? taxRate("biochemical") : "0.0"}
                disabled={!reactionsAllowed}
                onChange={(event) => setTaxRate("biochemical", event.target.value)}
              />
              <span>%</span>
            </div>
          </div>
          <div
            className={`${styles.constructionGridRow} ${
              !reactionsAllowed ? styles.constructionGridRowDisabled : ""
            }`}
          >
            <span>COMPOSITE REACTIONS</span>
            <button
              type="button"
              className={styles.stockSwitch}
              role="switch"
              aria-checked={reactionsAllowed && allowCompositeReactions}
              aria-label="Enable composite reactions"
              aria-disabled={!reactionsAllowed}
              disabled={!reactionsAllowed}
              onClick={() => setAllowCompositeReactions((current) => !current)}
            >
              <span className={styles.stockSwitchThumb} />
            </button>
            <div className={styles.constructionTaxField}>
              <input
                className={styles.constructionTaxInput}
                aria-label="Composite reaction tax rate"
                type="number"
                min="0"
                step="0.1"
                value={reactionsAllowed ? taxRate("composite") : "0.0"}
                disabled={!reactionsAllowed}
                onChange={(event) => setTaxRate("composite", event.target.value)}
              />
              <span>%</span>
            </div>
          </div>
          <div
            className={`${styles.constructionGridRow} ${
              !reactionsAllowed ? styles.constructionGridRowDisabled : ""
            }`}
          >
            <span>HYBRID REACTIONS</span>
            <button
              type="button"
              className={styles.stockSwitch}
              role="switch"
              aria-checked={reactionsAllowed && allowHybridReactions}
              aria-label="Enable hybrid reactions"
              aria-disabled={!reactionsAllowed}
              disabled={!reactionsAllowed}
              onClick={() => setAllowHybridReactions((current) => !current)}
            >
              <span className={styles.stockSwitchThumb} />
            </button>
            <div className={styles.constructionTaxField}>
              <input
                className={styles.constructionTaxInput}
                aria-label="Hybrid reaction tax rate"
                type="number"
                min="0"
                step="0.1"
                value={reactionsAllowed ? taxRate("hybrid") : "0.0"}
                disabled={!reactionsAllowed}
                onChange={(event) => setTaxRate("hybrid", event.target.value)}
              />
              <span>%</span>
            </div>
          </div>
          <div className={styles.constructionGridRow}>
            <span>INVENTION</span>
            <button
              type="button"
              className={styles.stockSwitch}
              role="switch"
              aria-checked={allowInvention}
              aria-label="Enable invention"
              onClick={() => setAllowInvention((current) => !current)}
            >
              <span className={styles.stockSwitchThumb} />
            </button>
            <div className={styles.constructionTaxField}>
              <input
                className={styles.constructionTaxInput}
                aria-label="Invention tax rate"
                type="number"
                min="0"
                step="0.1"
                value={taxRate("invention")}
                onChange={(event) => setTaxRate("invention", event.target.value)}
              />
              <span>%</span>
            </div>
          </div>
          <div className={styles.constructionGridRow}>
            <span>RESEARCH</span>
            <button
              type="button"
              className={styles.stockSwitch}
              role="switch"
              aria-checked={allowResearch}
              aria-label="Enable research"
              onClick={() => setAllowResearch((current) => !current)}
            >
              <span className={styles.stockSwitchThumb} />
            </button>
            <div className={styles.constructionTaxField}>
              <input
                className={styles.constructionTaxInput}
                aria-label="Research tax rate"
                type="number"
                min="0"
                step="0.1"
                value={taxRate("research")}
                onChange={(event) => setTaxRate("research", event.target.value)}
              />
              <span>%</span>
            </div>
          </div>
        </div>
        <div className={styles.modalActions}>
          <button type="button" className={styles.refresh} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={styles.calculate} disabled={!system || !name.trim()}>
            <span>{structure ? "Save structure" : "Add structure"}</span>
            <b>→</b>
          </button>
        </div>
      </form>
    </div>
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
    <label className={styles.field}>
      {label}
      <select
        className={styles.structureSelect}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
