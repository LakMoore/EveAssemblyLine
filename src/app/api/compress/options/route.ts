import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getCharacters } from "@/lib/auth/tokensStore";
import { getDogmaAttributes, getSystems, getTypeDogma, getTypes } from "@/cache/services/sdeCache";
import { requestEsi, fetchUniverseNames, getUsableToken } from "@/lib/esi/client";

export async function GET(request: Request) {
  const [types, systems, typeDogma, dogmaAttributes] = await Promise.all([getTypes(), getSystems(), getTypeDogma(), getDogmaAttributes()]);
  let assetLocations: Array<{ locationId: number; name: string; locationType: "station" | "structure"; typeId?: number; systemId?: number }> = [];
  try {
    const stockResponse = await fetch(new URL("/api/state/stock?language=en", request.url), {
      headers: { cookie: request.headers.get("cookie") ?? "" },
      cache: "no-store",
    });
    if (stockResponse.ok) {
      const stock = (await stockResponse.json()) as {
        locations?: Array<{ locationId: number; name: string; locationType: "station" | "structure" | "anchored"; typeId?: number; systemId?: number }>;
      };
      assetLocations = (stock.locations ?? []).filter(
        (location): location is typeof location & { locationType: "station" | "structure" } => location.locationType !== "anchored",
      );
    }
  } catch {}
  const npcLocations = assetLocations
    .filter((location) => location.locationType === "station")
    .map((location) => ({ id: `npc:${location.locationId}`, name: location.name, structure: "NPC" as const, modifier: 0, securityStatus: location.systemId === undefined ? undefined : systems.get(location.systemId)?.securityStatus }));
  const assetStructures = assetLocations
    .filter((location) => location.locationType === "structure")
    .map((location) => {
      const typeName = location.typeId === undefined ? undefined : types.get(location.typeId)?.name.en;
      if (typeName !== "Athanor" && typeName !== "Tatara") return null;
      return {
        id: `structure:${location.locationId}`,
        name: location.name,
        structure: typeName,
        modifier: typeName === "Tatara" ? 5.5 : 2,
        securityStatus: location.systemId === undefined ? undefined : systems.get(location.systemId)?.securityStatus,
      } as const;
    })
    .filter((location): location is NonNullable<typeof location> => location !== null);
  const session = await getSessionFromRequest(request);
  const records = session ? (await getCharacters()).filter((record) => session.characterIds.includes(record.characterId)) : [];
  const characters = await Promise.all(records.map(async (record) => {
    const skills = await requestEsi<{ skills?: Array<{ skill_id: number; active_skill_level: number }> }>(`/characters/${record.characterId}/skills/`, await getUsableToken(record, "personal")).catch(() => ({ data: null }));
    const clones = await requestEsi<{ active_clone_id?: number; clones?: Array<{ clone_id: number; implants?: number[] }> }>(`/characters/${record.characterId}/clones/`, await getUsableToken(record, "personal")).catch(() => ({ data: null }));
    return { id: `character:${record.characterId}`, characterId: record.characterId, name: record.characterName, skills: Object.fromEntries((skills.data?.skills ?? []).map((skill) => [skill.skill_id, skill.active_skill_level])), implants: [...new Set((clones.data?.clones ?? []).find((clone) => clone.clone_id === clones.data?.active_clone_id)?.implants ?? [])] };
  }));
  const implantNames = ["RX-801", "RX-802", "RX-804"].map((name) => {
    const type = [...types.values()].find((entry) => entry.name.en === name);
    return { id: type ? `implant:${type._key}` : `implant:${name}`, typeId: type?._key, name };
  });
  const cloneImplantIds = [...new Set(characters.flatMap((character) => character.implants))];
  let cloneImplantNames = new Map<number, string>();
  try {
    cloneImplantNames = await fetchUniverseNames(cloneImplantIds);
  } catch {}
  const cloneImplants = cloneImplantIds
    .filter((typeId) => !implantNames.some((implant) => implant.typeId === typeId))
    .map((typeId) => ({ id: `implant:${typeId}`, typeId, name: cloneImplantNames.get(typeId) ?? `Implant ${typeId}`, level: 0 }));
  const implantLevels: Record<string, number> = { "RX-801": 1, "RX-802": 2, "RX-804": 4 };
  const skillAttributeId = [...dogmaAttributes.values()].find((attribute) => attribute.name === "reprocessingSkillType")?._key;
  const relevantSkillIds = [...new Set([...typeDogma.values()].flatMap((record) => record.dogmaAttributes.filter((attribute) => attribute.attributeID === skillAttributeId).map((attribute) => attribute.value)))];
  return NextResponse.json({ locations: [...npcLocations, ...assetStructures], characters, relevantSkillIds, implants: [{ id: "none", name: "No implant", level: 0 }, ...implantNames.map((implant) => ({ ...implant, level: implantLevels[implant.name] })), ...cloneImplants] });
}