"use client";

import { FormEvent, useEffect, useState } from "react";
import AppShell, { languageStorageKey } from "../AppShell";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  defaultLocations,
  locationsStorageKey,
  type KnownStructure,
  type PlannerLocations,
} from "@/lib/planning/preferences";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { loadClientSession } from "@/lib/client/requestCache";
import { fetchRigs } from "@/lib/reference/rigs";
import { loadStructures, saveStructures } from "@/lib/planning/structureStore";
import styles from "../page.module.css";

type StructureSize = "Small" | "Medium" | "Large" | "Extra Large";
type StructureType = { name: string; size: StructureSize; typeId: number; sizeId: number };

const structureTypes: StructureType[] = [
  { name: "Athanor", size: "Medium", typeId: 35835, sizeId: 2 },
  { name: "Raitaru", size: "Medium", typeId: 35825, sizeId: 2 },
  { name: "Astrahus", size: "Medium", typeId: 35832, sizeId: 2 },
  { name: "Tatara", size: "Large", typeId: 35836, sizeId: 3 },
  { name: "Sotiyo", size: "Extra Large", typeId: 35827, sizeId: 4 },
  { name: "Azbel", size: "Large", typeId: 35826, sizeId: 3 },
  { name: "Fortizar", size: "Large", typeId: 35833, sizeId: 3 },
  { name: "Keepstar", size: "Extra Large", typeId: 35834, sizeId: 4 },
  { name: "'Draccous' Fortizar", size: "Large", typeId: 35833, sizeId: 3 },
  { name: "'Horizon' Fortizar", size: "Large", typeId: 35833, sizeId: 3 },
  { name: "'Marginis' Fortizar", size: "Large", typeId: 35833, sizeId: 3 },
  { name: "'Moreau' Fortizar", size: "Large", typeId: 35833, sizeId: 3 },
  { name: "'Prometheus' Fortizar", size: "Large", typeId: 35833, sizeId: 3 },
  { name: "Upwell Palatine Keepstar", size: "Extra Large", typeId: 35834, sizeId: 4 },
];
const fallbackRigOptionsBySize: Record<StructureSize, string[]> = {
  Small: [
    "No Rig",
    "Standup M-Set Basic Small Ship Manufacturing Material Efficiency I",
    "Standup M-Set Basic Small Ship Manufacturing Time Efficiency I",
    "Standup M-Set Basic Small Ship Manufacturing Material Efficiency II",
    "Standup M-Set Basic Small Ship Manufacturing Time Efficiency II",
    "Standup M-Set Advanced Small Ship Manufacturing Material Efficiency I",
    "Standup M-Set Advanced Small Ship Manufacturing Time Efficiency I",
    "Standup M-Set Advanced Small Ship Manufacturing Material Efficiency II",
    "Standup M-Set Advanced Small Ship Manufacturing Time Efficiency II",
    "Standup M-Set Small Ship Manufacturing Material Efficiency I",
    "Standup M-Set Small Ship Manufacturing Time Efficiency I",
  ],
  Medium: [
    "No Rig",
    "Standup M-Set Basic Medium Ship Manufacturing Material Efficiency I",
    "Standup M-Set Basic Medium Ship Manufacturing Material Efficiency II",
    "Standup M-Set Basic Medium Ship Manufacturing Time Efficiency I",
    "Standup M-Set Basic Medium Ship Manufacturing Time Efficiency II",
    "Standup M-Set Basic Small Ship Manufacturing Material Efficiency I",
    "Standup M-Set Basic Small Ship Manufacturing Material Efficiency II",
    "Standup M-Set Basic Small Ship Manufacturing Time Efficiency I",
    "Standup M-Set Basic Small Ship Manufacturing Time Efficiency II",
    "Standup M-Set Basic Large Ship Manufacturing Material Efficiency I",
    "Standup M-Set Basic Large Ship Manufacturing Material Efficiency II",
    "Standup M-Set Basic Large Ship Manufacturing Time Efficiency I",
    "Standup M-Set Basic Large Ship Manufacturing Time Efficiency II",
    "Standup M-Set Advanced Medium Ship Manufacturing Material Efficiency I",
    "Standup M-Set Advanced Medium Ship Manufacturing Material Efficiency II",
    "Standup M-Set Advanced Medium Ship Manufacturing Time Efficiency I",
    "Standup M-Set Advanced Medium Ship Manufacturing Time Efficiency II",
    "Standup M-Set Advanced Small Ship Manufacturing Material Efficiency I",
    "Standup M-Set Advanced Small Ship Manufacturing Material Efficiency II",
    "Standup M-Set Advanced Small Ship Manufacturing Time Efficiency I",
    "Standup M-Set Advanced Small Ship Manufacturing Time Efficiency II",
    "Standup M-Set Advanced Large Ship Manufacturing Material Efficiency I",
    "Standup M-Set Advanced Large Ship Manufacturing Material Efficiency II",
    "Standup M-Set Advanced Large Ship Manufacturing Time Efficiency I",
    "Standup M-Set Advanced Large Ship Manufacturing Time Efficiency II",
    "Standup M-Set Advanced Component Manufacturing Material Efficiency I",
    "Standup M-Set Advanced Component Manufacturing Material Efficiency II",
    "Standup M-Set Advanced Component Manufacturing Time Efficiency I",
    "Standup M-Set Advanced Component Manufacturing Time Efficiency II",
    "Standup M-Set Drone and Fighter Manufacturing Material Efficiency I",
    "Standup M-Set Drone and Fighter Manufacturing Material Efficiency II",
    "Standup M-Set Drone and Fighter Manufacturing Time Efficiency I",
    "Standup M-Set Drone and Fighter Manufacturing Time Efficiency II",
    "Standup M-Set Ammunition Manufacturing Material Efficiency I",
    "Standup M-Set Ammunition Manufacturing Material Efficiency II",
    "Standup M-Set Ammunition Manufacturing Time Efficiency I",
    "Standup M-Set Ammunition Manufacturing Time Efficiency II",
    "Standup M-Set Equipment Manufacturing Material Efficiency I",
    "Standup M-Set Equipment Manufacturing Material Efficiency II",
    "Standup M-Set Equipment Manufacturing Time Efficiency I",
    "Standup M-Set Equipment Manufacturing Time Efficiency II",
    "Standup M-Set Basic Capital Component Manufacturing Material Efficiency I",
    "Standup M-Set Basic Capital Component Manufacturing Material Efficiency II",
    "Standup M-Set Basic Capital Component Manufacturing Time Efficiency I",
    "Standup M-Set Basic Capital Component Manufacturing Time Efficiency II",
    "Standup M-Set Structure Manufacturing Material Efficiency I",
    "Standup M-Set Structure Manufacturing Material Efficiency II",
    "Standup M-Set Structure Manufacturing Time Efficiency I",
    "Standup M-Set Structure Manufacturing Time Efficiency II",
    "Standup M-Set Thukker Basic Capital Component Manufacturing Material Efficiency",
    "Standup M-Set Thukker Advanced Component Manufacturing Material Efficiency",
    "Standup M-Set Composite Reactor Material Efficiency I",
    "Standup M-Set Composite Reactor Material Efficiency II",
    "Standup M-Set Composite Reactor Time Efficiency I",
    "Standup M-Set Composite Reactor Time Efficiency II",
    "Standup M-Set Hybrid Reactor Material Efficiency I",
    "Standup M-Set Hybrid Reactor Material Efficiency II",
    "Standup M-Set Hybrid Reactor Time Efficiency I",
    "Standup M-Set Hybrid Reactor Time Efficiency II",
    "Standup M-Set Biochemical Reactor Material Efficiency I",
    "Standup M-Set Biochemical Reactor Material Efficiency II",
    "Standup M-Set Biochemical Reactor Time Efficiency I",
    "Standup M-Set Biochemical Reactor Time Efficiency II",
  ],
  Large: [
    "No Rig",
    "Standup L-Set Ammunition Manufacturing Efficiency I",
    "Standup L-Set Ammunition Manufacturing Efficiency II",
    "Standup L-Set Basic Large Ship Manufacturing Efficiency I",
    "Standup L-Set Basic Large Ship Manufacturing Efficiency II",
    "Standup L-Set Advanced Large Ship Manufacturing Efficiency I",
    "Standup L-Set Advanced Large Ship Manufacturing Efficiency II",
    "Standup L-Set Equipment Manufacturing Efficiency I",
    "Standup L-Set Equipment Manufacturing Efficiency II",
    "Standup L-Set Capital Ship Manufacturing Efficiency I",
    "Standup L-Set Capital Ship Manufacturing Efficiency II",
    "Standup L-Set Advanced Component Manufacturing Efficiency I",
    "Standup L-Set Advanced Component Manufacturing Efficiency II",
    "Standup L-Set Missile Flight Processor I",
    "Standup L-Set Missile Flight Processor II",
    "Standup L-Set Energy Neutralizer Feedback Control I",
    "Standup L-Set Energy Neutralizer Feedback Control II",
    "Standup L-Set Fighter Mission Control I",
    "Standup L-Set Fighter Mission Control II",
    "Standup L-Set EW Command System I",
    "Standup L-Set EW Command System II",
    "Standup L-Set Bomb Aimer I",
    "Standup L-Set Bomb Aimer II",
    "Standup L-Set Point Defense Battery Control I",
    "Standup L-Set Point Defense Battery Control II",
    "Standup L-Set Target Acquisition Array I",
    "Standup L-Set Target Acquisition Array II",
    "Standup L-Set Advanced Small Ship Manufacturing Efficiency I",
    "Standup L-Set Advanced Small Ship Manufacturing Efficiency II",
    "Standup L-Set Advanced Medium Ship Manufacturing Efficiency I",
    "Standup L-Set Advanced Medium Ship Manufacturing Efficiency II",
    "Standup L-Set Drone and Fighter Manufacturing Efficiency I",
    "Standup L-Set Drone and Fighter Manufacturing Efficiency II",
    "Standup L-Set Basic Small Ship Manufacturing Efficiency I",
    "Standup L-Set Basic Small Ship Manufacturing Efficiency II",
    "Standup L-Set Basic Medium Ship Manufacturing Efficiency I",
    "Standup L-Set Basic Medium Ship Manufacturing Efficiency II",
    "Standup L-Set Basic Capital Component Manufacturing Efficiency I",
    "Standup L-Set Basic Capital Component Manufacturing Efficiency II",
    "Standup L-Set Structure Manufacturing Efficiency I",
    "Standup L-Set Structure Manufacturing Efficiency II",
    "Standup L-Set Invention Optimization I",
    "Standup L-Set Invention Optimization II",
    "Standup L-Set ME Research Optimization I",
    "Standup L-Set ME Research Optimization II",
    "Standup L-Set TE Research Optimization I",
    "Standup L-Set TE Research Optimization II",
    "Standup L-Set Thukker Basic Capital Component Manufacturing Efficiency",
    "Standup L-Set Thukker Advanced Component Manufacturing Efficiency",
    "Standup L-Set Moon Drilling Proficiency I",
    "Standup L-Set Moon Drilling Proficiency II",
    "Standup L-Set Reactor Efficiency I",
    "Standup L-Set Reactor Efficiency II",
    "Standup L-Set Reprocessing Monitor I",
    "Standup L-Set Reprocessing Monitor II",
  ],
  "Extra Large": [
    "No Rig",
    "Standup XL-Set Equipment and Consumable Manufacturing Efficiency I",
    "Standup XL-Set Equipment and Consumable Manufacturing Efficiency II",
    "Standup XL-Set Ship Manufacturing Efficiency I",
    "Standup XL-Set Ship Manufacturing Efficiency II",
    "Standup XL-Set Laboratory Optimization I",
    "Standup XL-Set Laboratory Optimization II",
    "Standup XL-Set Missile Fire Control Computer I",
    "Standup XL-Set Missile Fire Control Computer II",
    "Standup XL-Set Integrated Fighter and PD Network I",
    "Standup XL-Set Integrated Fighter and PD Network II",
    "Standup XL-Set EW and Emissions Co-ordinator I",
    "Standup XL-Set EW and Emissions Co-ordinator II",
    "Standup XL-Set Extinction Level Weapons Suite I",
    "Standup XL-Set Extinction Level Weapons Suite II",
    "Standup XL-Set Structure and Component Manufacturing Efficiency I",
    "Standup XL-Set Structure and Component Manufacturing Efficiency II",
    "Standup XL-Set Thukker Structure and Component Manufacturing Efficiency",
    "Standup XL-Set Reprocessing Monitor I",
    "Standup XL-Set Reprocessing Monitor II",
  ],
};

function typeForName(name: string) {
  return structureTypes.find((structure) => structure.name === name) ?? structureTypes[0];
}

type SystemMatch = { systemId: number; name: string };
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

function readLegacyStructures() {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(locationsStorageKey);
    const parsed = stored ? (JSON.parse(stored) as Partial<PlannerLocations>) : {};
    return Array.isArray(parsed.structures)
      ? parsed.structures.map((structure) => ({
          ...structure,
          size: structure.size ?? typeForName(structure.type).size,
        }))
      : [];
  } catch {
    return [];
  }
}

export default function LocationsPage() {
  const [language, setLanguage] = useState<SdeLanguage>(() => {
    const saved =
      typeof window === "undefined" ? null : window.localStorage.getItem(languageStorageKey);
    return isSdeLanguage(saved) ? saved : "en";
  });
  const [locations, setLocations] = useState<PlannerLocations>(() => ({
    ...defaultLocations,
    structures: [],
  }));
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingStructure, setEditingStructure] = useState<KnownStructure | null>(null);
  const [rigOptionsBySize, setRigOptionsBySize] = useState(fallbackRigOptionsBySize);
  const [rigTypeIdsByName, setRigTypeIdsByName] = useState<Record<string, number>>({});
  const [esiStructures, setEsiStructures] = useState<EsiStructure[]>([]);
  const [esiConnected, setEsiConnected] = useState(false);
  const [esiRateLimitedUntil, setEsiRateLimitedUntil] = useState<string | null>(null);
  const [locationSort, setLocationSort] = useState<LocationSort>("alphabetical");
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
      } catch {}
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
        const params = new URLSearchParams({
          language,
        });
        const response = await fetch(`/api/state/stock?${params.toString()}`, {
          cache: "no-store",
        });
        const data = (await response.json()) as {
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
        };
        const locations = (data.locations ?? [])
          .filter(
            (
              location,
            ): location is typeof location & {
              locationType: "structure" | "station";
            } => location.locationType !== "anchored",
          )
          .map((location): EsiStructure => ({
            structureId: location.locationId,
            name: location.name,
            locationType: location.locationType,
            systemId: location.systemId,
            systemName: location.systemName,
            securityStatus: location.securityStatus,
            type: location.typeId ? `Type ${location.typeId}` : undefined,
            assetCount: location.assetCount,
            personalAssetCount: location.personalAssetCount,
            corporationAssetCount: location.corporationAssetCount,
            resolved: location.resolved,
            ownedByCorporation: false,
            rigs: [],
            totalCount: location.totalCount,
            totalVolume: location.totalVolume,
            bonuses: {
              manufacturing: { me: 0, te: 0, cost: 0 },
              research: { me: 0, te: 0, cost: 0 },
              reactions: { me: 0, te: 0, cost: 0 },
              invention: { me: 0, te: 0, cost: 0 },
            },
          }));
        if (!cancelled) setEsiStructures(locations);
      } catch {
        if (!cancelled) setEsiStructures([]);
      }
    }

    const handleRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ rateLimitedUntil?: string | null }>).detail;
      setEsiRateLimitedUntil(detail?.rateLimitedUntil ?? null);
      void loadEsiStructures();
    };
    window.addEventListener("assembly-line-esi-refreshed", handleRefresh);
    void loadEsiStructures();
    return () => {
      cancelled = true;
      window.removeEventListener("assembly-line-esi-refreshed", handleRefresh);
    };
  }, [esiConnected, language]);

  useEffect(() => {
    fetchRigs(language)
      .then((rigs) => {
        if (!rigs.length) return;
        const options: Record<StructureSize, string[]> = {
          Small: ["No Rig"],
          Medium: ["No Rig"],
          Large: ["No Rig"],
          "Extra Large": ["No Rig"],
        };
        for (const rig of rigs) options[rig.size].push(rig.name);
        setRigOptionsBySize(options);
        setRigTypeIdsByName(Object.fromEntries(rigs.map((rig) => [rig.name, rig.typeId])));
      })
      .catch(() => undefined);
  }, [language]);

  const knownStructuresByKey = new Map<string, KnownStructure>();
  for (const structure of locations.structures) {
    knownStructuresByKey.set(structureMatchKey(structure.systemName, structure.name), structure);
    knownStructuresByKey.set(structureMatchKey(undefined, structure.name), structure);
  }

  function findLocalOverride(esiStructure: EsiStructure) {
    return (
      locations.structures.find((known) => known.esiStructureId === esiStructure.structureId) ??
      knownStructuresByKey.get(structureMatchKey(esiStructure.systemName, esiStructure.name)) ??
      knownStructuresByKey.get(structureMatchKey(undefined, esiStructure.name)) ??
      locations.structures.find((known) => {
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
    return localOverride ? { ...structure, rigs: localOverride.rigs } : structure;
  });
  const matchedKnownStructureIds = new Set(
    esiStructures
      .filter((structure) => structure.locationType === "structure")
      .map(findLocalOverride)
      .filter((structure): structure is KnownStructure => Boolean(structure))
      .map((structure) => structure.id),
  );
  const unmatchedKnownStructures = locations.structures.filter(
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
    const type = typeForName(localOverride?.type ?? esiStructure.type ?? structureTypes[0].name);
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
        localOverride?.rigs ??
        (esiStructure.rigs.length > 0 ? esiStructure.rigs : ["No Rig", "No Rig", "No Rig"]),
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
    <AppShell activePage="locations" language={language} onLanguageChange={setLanguage}>
      <div className={styles.pageIntro}>
        <div>
          <p className={styles.eyebrow}>CONFIGURATION / OPERATIONS</p>
          <h1>Locations</h1>
          <p className={styles.subtitle}>
            Choose operational sites and maintain the structures you use.
          </p>
        </div>
      </div>
      <div className={styles.panel}>
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
                      {structure.totalVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
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
      </div>
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>01 / STRUCTURES</p>
            <h2>Known structures</h2>
          </div>
          <button type="button" className={`actionButton ${styles.importButton}`} onClick={openAddDialog}>
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
      </div>
      {isDialogOpen && (
        <StructureDialog
          language={language}
          structure={editingStructure}
          rigOptionsBySize={rigOptionsBySize}
          rigTypeIdsByName={rigTypeIdsByName}
          onCancel={() => setIsDialogOpen(false)}
          onSave={(structure) => {
            const existing = locations.structures.some((current) => current.id === structure.id);
            const structures = existing
              ? locations.structures.map((current) =>
                  current.id === structure.id ? structure : current,
                )
              : [...locations.structures, structure];
            setLocations((current) => ({
              ...current,
              structures,
            }));
            void saveStructures(structures);
            setIsDialogOpen(false);
            setEditingStructure(null);
          }}
        />
      )}
    </AppShell>
  );
}

function StructureDialog({
  language,
  onCancel,
  onSave,
  structure,
  rigOptionsBySize,
  rigTypeIdsByName,
}: {
  language: SdeLanguage;
  onCancel: () => void;
  onSave: (structure: KnownStructure) => void;
  structure: KnownStructure | null;
  rigOptionsBySize: Record<StructureSize, string[]>;
  rigTypeIdsByName: Record<string, number>;
}) {
  const [systemName, setSystemName] = useState(structure?.systemName ?? "");
  const [system, setSystem] = useState<SystemMatch | null>(
    structure && structure.systemId > 0
      ? { systemId: structure.systemId, name: structure.systemName }
      : null,
  );
  const [suggestions, setSuggestions] = useState<SystemMatch[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [type, setType] = useState(structure?.type ?? structureTypes[0].name);
  const [name, setName] = useState(structure?.name ?? "");
  const [rigs, setRigs] = useState(structure?.rigs ?? ["No Rig", "No Rig", "No Rig"]);
  const selectedType = typeForName(type);

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
    if (!system || !name.trim()) return;
    onSave({
      id: structure?.id ?? `local:${crypto.randomUUID()}`,
      systemId: system.systemId,
      systemName: system.name,
      type,
      typeId: selectedType.typeId,
      size: selectedType.size,
      sizeId: selectedType.sizeId,
      name: name.trim(),
      rigs,
      rigTypeIds: rigs.map((rig) => rigTypeIdsByName[rig] ?? 0),
      ...(structure?.esiStructureId ? { esiStructureId: structure.esiStructureId } : {}),
    });
  }

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
            const nextType = typeForName(value);
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
