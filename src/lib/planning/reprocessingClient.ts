import type { SdeLanguage } from "@/lib/reference/languages";
import { loadClientSession, loadClientStateStatus } from "@/lib/client/requestCache";
import { loadEndpointRecord, saveEndpointResponse } from "@/lib/client/refreshCache";
import { loadCompressSettings } from "./compressSettingsStore";
import { fetchFacilityResponse } from "./facilitiesStore";

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

/** Loads compression options from the shared cache, fetching them when absent. */
async function loadCompressOptions(language: SdeLanguage) {
  const cached = await loadEndpointRecord<CompressOptions>("compress/options");
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
  const state = await loadClientStateStatus();
  return Object.fromEntries(
    (
      state.characters?.find((character) => character.characterId === selectedCharacter.characterId)
        ?.skills?.body ?? []
    ).map((skill) => [String(skill.skillId), skill.activeSkillLevel]),
  );
}

/**
 * Loads one server-calculated efficiency snapshot for the selected refinery and character.
 * An empty result intentionally lets the planner apply its documented 50% fallback.
 */
export async function loadPlannerReprocessingEfficiencies(
  language: SdeLanguage,
  reprocessingLocationId: number | undefined,
): Promise<Record<string, number>> {
  try {
    const [settings, facilities, options] = await Promise.all([
      loadCompressSettings(),
      fetchFacilityResponse(),
      loadCompressOptions(language),
    ]);
    if (!options) return {};
    const selectedFacility = facilities?.facilities.find(
      (facility) => facility.id === reprocessingLocationId,
    );
    const selectedImplant = options.implants.find((implant) => implant.id === settings.implantId);
    const selectedCharacter = options.characters.find(
      (character) => character.id === settings.characterId,
    );
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
          structureTypeId: selectedFacility?.typeId ?? 0,
          rigTypeIds: (selectedFacility?.rigTypeIds ?? []).filter((typeId) => typeId > 0),
          skillLevels: await selectedSkillLevels(options, settings.characterId),
          implantLevel: implantAllowed ? (selectedImplant?.level ?? 0) : 0,
          securityStatus: selectedFacility?.securityStatus,
        }),
      },
    );
    if (!response.ok) return {};
    const result = (await response.json()) as { efficiencies?: Record<string, number> };
    return result.efficiencies ?? {};
  }
  catch {
    return {};
  }
}
