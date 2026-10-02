import type { SdeLanguage } from "@/lib/reference/languages";
import { z } from "zod";
import {
  loadClientAssets,
  loadClientCharacterState,
  loadClientSession,
} from "@/lib/client/requestCache";
import { loadEndpointRecord, saveEndpointResponse } from "@/lib/client/refreshCache";
import type { ClientPlanStockpile } from "./types";
import { loadCompressSettings } from "./compressSettingsStore";
import type { FacilityResponse } from "./facilities";
import { loadPlannerStockpiles, savePlannerStockpiles } from "./plannerStockpilesStore";

const reprocessingEfficiencyResponseSchema = z.object({
  efficiencies: z.record(z.string().regex(/^\d+$/), z.number().finite().min(0).max(150)).optional(),
  error: z.string().optional(),
});

/** Requests server-calculated efficiencies for an explicit reprocessing profile. */
export async function requestReprocessingEfficiencies(
  profile: {
    structureTypeId: number;
    rigTypeIds: number[];
    skillLevels: Record<string, number>;
    implantLevel: number;
    securityStatus?: number;
  },
  signal?: AbortSignal,
): Promise<Record<string, number>> {
  const response = await fetch(
    "/api/compress/efficiencies",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal,
      body: JSON.stringify(profile),
    },
  );
  const parsed = reprocessingEfficiencyResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!response.ok) {
    throw new Error(
      parsed.success
        ? (parsed.data.error ?? "Could not calculate reprocessing efficiencies.")
        : "Could not calculate reprocessing efficiencies.",
    );
  }
  if (
    !parsed.success
    || !parsed.data.efficiencies
    || Object.keys(parsed.data.efficiencies).length === 0
  ) {
    throw new Error("Reprocessing efficiencies were empty or invalid.");
  }
  return parsed.data.efficiencies;
}

type ImplantOption = {
  id: string;
  typeId?: number;
  level: number;
};

type CompressOptions = {
  optionsVersion: number;
  characterImplants: Partial<Record<string, number[]>>;
  implants: ImplantOption[];
  relevantSkillIds: number[];
};

let compressOptionsRequest: Promise<CompressOptions | undefined> | undefined;

/** Loads compression options from the shared cache, fetching them when absent. */
export function loadCompressOptions(language: SdeLanguage, reload = false) {
  if (compressOptionsRequest) return compressOptionsRequest;
  compressOptionsRequest = (async () => {
    const cached = reload ? null : await loadEndpointRecord<CompressOptions>("compress/options");
    if (cached && cached.data.optionsVersion === 4) return cached.data;
    const response = await fetch(
      "/api/compress/options",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ language }),
      },
    );
    if (!response.ok) return undefined;
    const options = (await response.json()) as CompressOptions;
    await saveEndpointResponse("compress/options", "/api/compress/options", options);
    return options;
  })().finally(() => {
    compressOptionsRequest = undefined;
  });
  return compressOptionsRequest;
}

/** Resolves the selected compression character's cached processing skill levels. */
async function selectedSkillLevels(options: CompressOptions, characterId: string) {
  if (characterId === "all-zero") {
    return Object.fromEntries(options.relevantSkillIds.map((id) => [String(id), 0]));
  }
  if (characterId === "all-iv" || characterId === "all-v") {
    const level = characterId === "all-iv" ? 4 : 5;
    return Object.fromEntries(options.relevantSkillIds.map((id) => [String(id), level]));
  }
  const session = await loadClientSession();
  const selectedCharacter = (session.characters ?? []).find(
    (character) => `character:${character.characterId}` === characterId,
  );
  if (!selectedCharacter || !session.authenticated) return {};
  const state = await loadClientCharacterState();
  return Object.fromEntries(
    (
      state.characters?.find((character) => character.characterId === selectedCharacter.characterId)
        ?.skills?.body ?? []
    ).map((skill) => [String(skill.skillId), skill.activeSkillLevel]),
  );
}

/**
 * Loads one server-calculated efficiency snapshot for the selected refinery and character.
 * A failed or empty server response is rejected so the planner cannot submit incomplete data.
 */
export async function loadPlannerReprocessingEfficiencies(
  language: SdeLanguage,
  reprocessingLocationId: number | undefined,
  facilities?: Pick<FacilityResponse, "facilities"> | null,
): Promise<Record<string, number>> {
  const [settings, loadedFacilities, options] = await Promise.all([
    loadCompressSettings(),
    facilities === undefined
      ? loadClientAssets(language).then((data) => ({ facilities: data.facilities ?? [] }))
      : Promise.resolve(facilities),
    loadCompressOptions(language),
  ]);
  if (!options) throw new Error("Could not load compression options.");
  const selectedFacility = loadedFacilities?.facilities.find(
    (facility) => facility.id === reprocessingLocationId,
  );
  const selectedImplant = options.implants.find((implant) => implant.id === settings.implantId);
  const selectedCharacter = (await loadClientSession()).characters?.find(
    (character) => `character:${character.characterId}` === settings.characterId,
  );
  const structureTypeId =
    selectedFacility?.locationType === "structure" ? selectedFacility.typeId : 0;
  const rigTypeIds =
    selectedFacility?.locationType === "structure"
      ? selectedFacility.rigTypeIds.filter((typeId) => typeId > 0)
      : [];
  const implantAllowed =
    selectedImplant?.typeId === undefined
    || (
      selectedCharacter
      && options.characterImplants[String(selectedCharacter.characterId)]?.includes(
        selectedImplant.typeId,
      ) === true
    );
  return requestReprocessingEfficiencies({
    structureTypeId,
    rigTypeIds,
    skillLevels: await selectedSkillLevels(options, settings.characterId),
    implantLevel: implantAllowed ? (selectedImplant?.level ?? 0) : 0,
    securityStatus: selectedFacility?.securityStatus,
  });
}

function hasReprocessingEfficiencies(stockpile: ClientPlanStockpile) {
  return Object.keys(stockpile.reprocessingEfficiencies ?? {}).length > 0;
}

/** Refreshes one efficiency response per distinct stockpile reprocessing location. */
export async function refreshPlannerStockpileEfficiencies(
  language: SdeLanguage,
  stockpiles: ClientPlanStockpile[],
  force = false,
  facilities?: Pick<FacilityResponse, "facilities"> | null,
) {
  const requests = new Map<number, Promise<Record<string, number>>>();
  const requestFor = (locationId: number) => {
    let request = requests.get(locationId);
    if (!request) {
      request = loadPlannerReprocessingEfficiencies(language, locationId, facilities);
      requests.set(locationId, request);
    }
    return request;
  };
  return Promise.all(
    stockpiles.map(async (stockpile) => {
      if (!force && hasReprocessingEfficiencies(stockpile)) return stockpile;
      try {
        return {
          ...stockpile,
          reprocessingEfficiencies: await requestFor(stockpile.locations.reprocessing),
        };
      }
      catch {
        return stockpile;
      }
    }),
  );
}

/** Refreshes and persists every saved stockpile after structure configuration changes. */
export async function refreshAllPlannerStockpileEfficiencies(language: SdeLanguage) {
  const stockpiles = await loadPlannerStockpiles();
  if (!stockpiles) return;
  const assets = await loadClientAssets(language, true);
  const refreshed = await refreshPlannerStockpileEfficiencies(
    language,
    stockpiles,
    true,
    { facilities: assets.facilities ?? [] },
  );
  await savePlannerStockpiles(refreshed);
}
