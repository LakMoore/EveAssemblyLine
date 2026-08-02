import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getResolvedAssets } from "@/lib/esi/cache";
import { fetchCorporationStructures } from "@/lib/esi/client";
import { getCharacter } from "@/lib/auth/tokensStore";
import { getSystems, getTypesByIds } from "@/cache/services/sdeCache";

type StructureSize = "Small" | "Medium" | "Large" | "Extra Large";

function structureSize(type: string): StructureSize | undefined {
  if (["Athanor", "Raitaru", "Astrahus", "Tatara"].includes(type)) return "Medium";
  if (["Sotiyo", "Azbel", "Fortizar", "'Draccous' Fortizar", "'Horizon' Fortizar", "'Marginis' Fortizar", "'Moreau' Fortizar", "'Prometheus' Fortizar"].includes(type)) return "Large";
  if (["Keepstar", "Upwell Palatine Keepstar"].includes(type)) return "Extra Large";
  return undefined;
}

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const assets = await getResolvedAssets(session.characterIds, true);
  const structures = new Map<
    number,
    {
      structureId: number;
      name: string;
      systemId?: number;
      systemName?: string;
      locationType: "structure" | "station";
      assetCount: number;
      personalAssetCount: number;
      corporationAssetCount: number;
      resolved: boolean;
      typeId?: number;
      type?: string;
      size?: StructureSize;
      rigs: string[];
      services?: Array<{ name: string; state: string }>;
      state?: string;
      fuelExpires?: string;
      ownedByCorporation: boolean;
    }
  >();

  for (const asset of assets) {
    if (asset.location.kind !== "structure" && asset.location.kind !== "station") continue;
    const existing = structures.get(asset.location.locationId);
    if (existing) {
      existing.assetCount += 1;
      if (asset.ownerType === "corporation") existing.corporationAssetCount += 1;
      else existing.personalAssetCount += 1;
      existing.resolved ||= asset.location.resolved;
      if (!existing.name && asset.location.name) existing.name = asset.location.name;
      if (!existing.systemId && asset.location.systemId)
        existing.systemId = asset.location.systemId;
      if (!existing.typeId && asset.location.typeId) existing.typeId = asset.location.typeId;
      if (asset.ownerType === "corporation" && asset.location.kind === "structure" && asset.locationFlag.startsWith("RigSlot")) {
        existing.rigs.push(String(asset.typeId));
      }
      continue;
    }
    structures.set(asset.location.locationId, {
      structureId: asset.location.locationId,
      name: asset.location.name ?? `Structure ${asset.location.locationId}`,
      ...(asset.location.systemId ? { systemId: asset.location.systemId } : {}),
      locationType: asset.location.kind,
      assetCount: 1,
      personalAssetCount: asset.ownerType === "character" ? 1 : 0,
      corporationAssetCount: asset.ownerType === "corporation" ? 1 : 0,
      resolved: asset.location.resolved,
      ...(asset.location.typeId ? { typeId: asset.location.typeId } : {}),
      rigs:
        asset.ownerType === "corporation" &&
        asset.location.kind === "structure" &&
        asset.locationFlag.startsWith("RigSlot")
          ? [String(asset.typeId)]
          : [],
      ownedByCorporation: false,
    });
  }

  const records = await Promise.all(session.characterIds.map((characterId) => getCharacter(characterId)));
  const corporationStructures = new Map<number, Awaited<ReturnType<typeof fetchCorporationStructures>>[number]>();
  for (const record of records) {
    if (!record) continue;
    try {
      for (const structure of await fetchCorporationStructures(record)) {
        corporationStructures.set(structure.structure_id, structure);
      }
    } catch {}
  }

  const typeIds = [...structures.values()].flatMap((structure) => [
    ...(structure.typeId ? [structure.typeId] : []),
    ...structure.rigs.map(Number),
  ]);
  const systems = await getSystems();
  const types = await getTypesByIds(typeIds);
  for (const structure of structures.values()) {
    const metadata = corporationStructures.get(structure.structureId);
    const typeId = metadata?.type_id ?? structure.typeId;
    const type = typeId ? types.get(typeId)?.name.en : undefined;
    const corporationRigs = structure.rigs.map((rig) => types.get(Number(rig))?.name.en ?? rig);
    if (metadata) {
      structure.ownedByCorporation = true;
      structure.typeId = metadata.type_id;
      structure.type = types.get(metadata.type_id)?.name.en ?? `Type ${metadata.type_id}`;
      structure.size = structureSize(structure.type);
      structure.name = metadata.name ?? structure.name;
      structure.systemId = metadata.system_id;
      structure.state = metadata.state;
      structure.fuelExpires = metadata.fuel_expires;
      structure.services = metadata.services;
    } else {
      structure.type = type;
      structure.size = type ? structureSize(type) : undefined;
    }
    if (structure.systemId) {
      const system = systems.get(structure.systemId);
      structure.systemName = system?.name.en;
    }
    structure.rigs = corporationRigs;
  }

  return NextResponse.json({
    structures: [...structures.values()].sort((left, right) => left.name.localeCompare(right.name)),
  });
}
