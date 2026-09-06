import type { SdeLanguage } from "@/lib/reference/languages";
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

type CharacterOption = {
  id: string;
  characterId: number;
  implants: number[];
};

type ImplantOption = {
  id: string;
  typeId?: number;
  level: number;
};

type CompressOptions = {
  characters: CharacterOption[];
  implants: ImplantOption[];
  relevantSkillIds: number[];
};

let compressOptionsRequest: Promise<CompressOptions | undefined> | undefined;

/** Loads compression options from the shared cache, fetching them when absent. */
export function loadCompressOptions(language: SdeLanguage, reload = false) {
  if (compressOptionsRequest) return compressOptionsRequest;
  compressOptionsRequest = (async () => {
    const cached = reload ? null : await loadEndpointRecord<CompressOptions>("compress/options");
    if (cached) return cached.data;
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
  const selectedCharacter = options.characters.find((character) => character.id === characterId);
  if (!selectedCharacter || !(await loadClientSession()).authenticated) return {};
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
  const selectedCharacter = options.characters.find(
    (character) => character.id === settings.characterId,
  );
  const structureTypeId =
    selectedFacility?.locationType === "structure" ? selectedFacility.typeId : 0;
  const rigTypeIds =
    selectedFacility?.locationType === "structure"
      ? selectedFacility.rigTypeIds.filter((typeId) => typeId > 0)
      : [];
  const implantAllowed =
    selectedImplant?.typeId === undefined
    || selectedCharacter?.implants.includes(selectedImplant.typeId) === true;
  const response = await fetch(
    "/api/compress/efficiencies",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        structureTypeId,
        rigTypeIds,
        skillLevels: await selectedSkillLevels(options, settings.characterId),
        implantLevel: implantAllowed ? (selectedImplant?.level ?? 0) : 0,
        securityStatus: selectedFacility?.securityStatus,
      }),
    },
  );
  const result = (await response.json()) as {
    efficiencies?: Record<string, number>;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(result.error ?? "Could not calculate compression efficiencies.");
  }
  if (!result.efficiencies || Object.keys(result.efficiencies).length === 0) {
    throw new Error("Compression efficiencies were empty.");
  }
  return result.efficiencies;
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
