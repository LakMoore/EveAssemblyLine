import type { TypeMetadata } from "@/lib/reference/types";
import { defaultMarketStations, type ConfiguredMarketStation } from "@/lib/market/stations";

export type PlannerLocations = {
  manufacturing: number;
  reactions: number;
  market: number;
  reprocessing?: number;
  copying?: number;
  invention?: number;
  structures: KnownStructure[];
};

export type KnownStructure = {
  id: string;
  systemId: number;
  systemName: string;
  securityStatus?: number;
  type: string;
  typeId?: number;
  size: "Small" | "Medium" | "Large" | "Extra Large";
  sizeId?: number;
  name: string;
  rigs: string[];
  rigTypeIds?: number[];
  esiStructureId?: number;
  allowStandardBuilds?: boolean;
  allowCapitalBuilds?: boolean;
  allowReprocessing?: boolean;
  allowReactionBuilds?: boolean;
  allowBiochemicalReactions?: boolean;
  allowCompositeReactions?: boolean;
  allowHybridReactions?: boolean;
  allowInvention?: boolean;
  allowResearch?: boolean;
  jobTypes?: import("./facilities").FacilityJobTypes;
  settingsLastModified?: string;
};

export type PlannerSettings = {
  includeCorporationAssets: boolean;
  personalSellOrdersAsStock: boolean;
  allCorporationSellOrdersAsStock: boolean;
  myCorporationSellOrdersAsStock: boolean;
  respectActiveJobs: boolean;
  buildBlacklist: TypeMetadata[];
  marketStations: ConfiguredMarketStation[];
  marketSalesTaxPercent: number;
  marketSignalThresholdIsk: number;
  defaultMe: number;
  defaultTe: number;
};

export const defaultLocations: PlannerLocations = {
  manufacturing: 60003760,
  reactions: 30000142,
  market: 60008494,
  reprocessing: 60003760,
  copying: 60003760,
  invention: 60003760,
  structures: [],
};

export const defaultSettings: PlannerSettings = {
  includeCorporationAssets: true,
  personalSellOrdersAsStock: true,
  allCorporationSellOrdersAsStock: true,
  myCorporationSellOrdersAsStock: true,
  respectActiveJobs: true,
  buildBlacklist: [],
  marketStations: defaultMarketStations,
  marketSalesTaxPercent: 3.6,
  marketSignalThresholdIsk: 5_000_000,
  defaultMe: 10,
  defaultTe: 20,
};

export const locationsStorageKey = "assembly-line-locations";
export const settingsStorageKey = "assembly-line-settings";

/** Normalizes saved settings while preserving defaults for newly introduced fields. */
export function parsePlannerSettings(value: unknown): PlannerSettings {
  if (!value || typeof value !== "object") return defaultSettings;
  const raw = value as Record<string, unknown>;
  const parsed = raw as Partial<PlannerSettings>;
  const buildBlacklist = Array.isArray(raw.buildBlacklist)
    ? raw.buildBlacklist.flatMap((item) => {
        if (typeof item === "number") return [{ typeId: item, name: `Type ${item}` }];
        if (
          item
          && typeof item === "object"
          && Number.isInteger((item as { typeId?: unknown }).typeId)
          && typeof (item as { name?: unknown }).name === "string"
        ) {
          return [item as TypeMetadata];
        }
        return [];
      })
    : [];
  const marketStations = Array.isArray(raw.marketStations)
    ? raw.marketStations.flatMap((item) => {
        if (
          item
          && typeof item === "object"
          && Number.isSafeInteger((item as { stationId?: unknown }).stationId)
          && Number((item as { stationId: number }).stationId) > 0
          && typeof (item as { name?: unknown }).name === "string"
        ) {
          return [item as ConfiguredMarketStation];
        }
        return [];
      })
    : defaultMarketStations;
  const marketSalesTaxPercent =
    typeof raw.marketSalesTaxPercent === "number" && Number.isFinite(raw.marketSalesTaxPercent)
      ? Math.min(100, Math.max(0, raw.marketSalesTaxPercent))
      : defaultSettings.marketSalesTaxPercent;
  const marketSignalThresholdIsk =
    typeof raw.marketSignalThresholdIsk === "number"
    && Number.isFinite(raw.marketSignalThresholdIsk)
      ? Math.max(0, raw.marketSignalThresholdIsk)
      : defaultSettings.marketSignalThresholdIsk;
  return {
    ...defaultSettings,
    ...parsed,
    buildBlacklist,
    marketStations,
    marketSalesTaxPercent,
    marketSignalThresholdIsk,
  };
}

/** Reads normalized planner settings from browser storage. */
export function readPlannerSettings(): PlannerSettings {
  if (typeof window === "undefined") return defaultSettings;
  try {
    const stored = window.localStorage.getItem(settingsStorageKey);
    return stored ? parsePlannerSettings(JSON.parse(stored)) : defaultSettings;
  }
  catch {
    return defaultSettings;
  }
}
