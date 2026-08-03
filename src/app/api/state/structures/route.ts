import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getResolvedAssets, getRunningIndustryJobs } from "@/lib/esi/cache";
import { fetchCorporationStructures } from "@/lib/esi/client";
import { getCharacter } from "@/lib/auth/tokensStore";
import {
  getDogmaEffects,
  getActivityInputTypeIds,
  getGroups,
  getMarketGroups,
  getRigDogma,
  getSystems,
  getTypeBonuses,
  getTypesByIds,
} from "@/cache/services/sdeCache";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { categorizeType } from "@/lib/reference/category";

type StructureSize = "Small" | "Medium" | "Large" | "Extra Large";
type Activity = "manufacturing" | "research" | "reactions" | "invention";
type ActivityBonuses = Record<Activity, { me: number; te: number; cost: number }>;
const shipCategoryId = 6;
const containerCategoryId = 2;
const bonusAttributeIds = { me: 2594, te: 2593, cost: 2595 } as const;

function emptyBonuses(): ActivityBonuses {
  return {
    manufacturing: { me: 0, te: 0, cost: 0 },
    research: { me: 0, te: 0, cost: 0 },
    reactions: { me: 0, te: 0, cost: 0 },
    invention: { me: 0, te: 0, cost: 0 },
  };
}

function activityForEffect(name: string): Activity | null {
  const normalized = name.toLocaleLowerCase();
  if (normalized.includes("manufacture")) return "manufacturing";
  if (normalized.includes("reaction")) return "reactions";
  if (normalized.includes("invention")) return "invention";
  if (normalized.includes("research") || normalized.includes("copy")) return "research";
  return null;
}

function rigBonuses(
  rigIds: number[],
  rigDogma: Awaited<ReturnType<typeof getRigDogma>>,
  dogmaEffects: Awaited<ReturnType<typeof getDogmaEffects>>,
): ActivityBonuses {
  const bonuses = emptyBonuses();
  for (const rigId of rigIds) {
    const rig = rigDogma.get(rigId);
    if (!rig) continue;
    for (const effectRef of rig?.dogmaEffects ?? []) {
      const effect = dogmaEffects.get(effectRef.effectID);
      const activity = effect ? activityForEffect(effect.name) : null;
      if (!activity) continue;
      for (const modifier of effect?.modifierInfo ?? []) {
        const bonus = modifier.modifyingAttributeID;
        const key =
          bonus === bonusAttributeIds.me ? "me" : bonus === bonusAttributeIds.te ? "te" : bonus === bonusAttributeIds.cost ? "cost" : null;
        if (!key) continue;
        const value = rig.dogmaAttributes.find((attribute) => attribute.attributeID === bonus)?.value ?? 0;
        bonuses[activity][key] += Math.max(0, -value);
      }
    }
  }
  return bonuses;
}

function structureBonuses(
  typeId: number | undefined,
  typeBonuses: Awaited<ReturnType<typeof getTypeBonuses>>,
): ActivityBonuses {
  const bonuses = emptyBonuses();
  const record = typeId ? typeBonuses.get(typeId) : undefined;
  for (const entry of [...(record?.miscBonuses ?? []), ...(record?.roleBonuses ?? [])]) {
    const amount = Math.max(0, entry.bonus ?? 0);
    const text = entry.bonusText.en.toLocaleLowerCase();
    const activities: Activity[] = [];
    if (text.includes("manufacturing")) activities.push("manufacturing");
    if (text.includes("science")) activities.push("research", "invention");
    if (text.includes("reaction")) activities.push("reactions");
    if (activities.length === 0) continue;
    const metric = text.includes("material")
      ? "me"
      : text.includes("time")
        ? "te"
        : text.includes("isk")
          ? "cost"
          : null;
    if (!metric) continue;
    for (const activity of activities) bonuses[activity][metric] += amount;
  }
  return bonuses;
}

function addBonuses(target: ActivityBonuses, source: ActivityBonuses) {
  for (const activity of ["manufacturing", "research", "reactions", "invention"] as const) {
    target[activity].me += source[activity].me;
    target[activity].te += source[activity].te;
    target[activity].cost += source[activity].cost;
  }
}

function structureSize(type: string): StructureSize | undefined {
  if (["Athanor", "Raitaru", "Astrahus", "Tatara"].includes(type)) return "Medium";
  if (["Sotiyo", "Azbel", "Fortizar", "'Draccous' Fortizar", "'Horizon' Fortizar", "'Marginis' Fortizar", "'Moreau' Fortizar", "'Prometheus' Fortizar"].includes(type)) return "Large";
  if (["Keepstar", "Upwell Palatine Keepstar"].includes(type)) return "Extra Large";
  return undefined;
}

function isCargoContainerType(
  typeId: number,
  types: Awaited<ReturnType<typeof getTypesByIds>>,
  groups: Awaited<ReturnType<typeof getGroups>>,
  marketGroups: Awaited<ReturnType<typeof getMarketGroups>>,
) {
  const type = types.get(typeId);
  const group = groups.get(type?.groupID ?? -1);
  if (group?.categoryID === containerCategoryId) return true;
  let marketGroup = type?.marketGroupID === undefined ? undefined : marketGroups.get(type.marketGroupID);
  while (marketGroup) {
    if (marketGroup.name.en === "Cargo Containers") return true;
    marketGroup = marketGroup.parentGroupID === undefined
      ? undefined
      : marketGroups.get(marketGroup.parentGroupID);
  }
  return false;
}

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const requestedLanguage = new URL(request.url).searchParams.get("language");
  const url = new URL(request.url);
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  const includeAssembledContainers = url.searchParams.get("includeAssembledContainers") === "true";
  const includeAssembledShips = url.searchParams.get("includeAssembledShips") === "true";
  const stockOnly = url.searchParams.get("stockOnly") === "true";

  const [assets, jobs, activityInputTypeIds, rigDogma, dogmaEffects, typeBonuses, marketGroups] = await Promise.all([
    getResolvedAssets(session.characterIds, true),
    getRunningIndustryJobs(session.characterIds, true),
    getActivityInputTypeIds(),
    getRigDogma(),
    getDogmaEffects(),
    getTypeBonuses(),
    getMarketGroups(),
  ]);
  const assetTypes = await getTypesByIds([...new Set([
    ...assets.map((asset) => asset.typeId),
    ...jobs.flatMap((job) => [job.productTypeId ?? job.blueprintTypeId, job.blueprintTypeId]),
  ])]);
  const groups = await getGroups();
  const includedAssets = assets.filter((asset) => {
    const type = assetTypes.get(asset.typeId);
    const category = type ? categorizeType(type, language, marketGroups, groups).category : "item";
    if (
      stockOnly &&
      !activityInputTypeIds.has(asset.typeId) &&
      category !== "bpo" &&
      category !== "reaction"
    ) return false;
    const categoryId = groups.get(assetTypes.get(asset.typeId)?.groupID ?? -1)?.categoryID;
    const isCargoContainer =
      categoryId === containerCategoryId ||
      isCargoContainerType(asset.typeId, assetTypes, groups, marketGroups);
    if (isCargoContainer) return includeAssembledContainers || !asset.isSingleton;
    if (!asset.isSingleton) return true;
    if (categoryId === shipCategoryId) return includeAssembledShips;
    return true;
  });
  const filteredLocationIds = new Set(
    assets
      .filter((asset) => !includedAssets.includes(asset))
      .map((asset) => asset.location.locationId),
  );
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
      items: Map<string, {
        typeId: number;
        quantity: number;
        isPackaged: boolean;
        runCount?: number;
        me?: number;
        te?: number;
        blueprintPrints?: Array<{ itemId: number; runs: number; me?: number; te?: number }>;
        inBuild?: boolean;
        inUse?: boolean;
        jobId?: number;
        installerId?: number;
        facilityId?: number;
        outputLocationId?: number;
        blueprintId?: number;
        blueprintTypeId?: number;
        blueprintIsOriginal?: boolean;
        blueprintRunsAtInstall?: number;
        blueprintRunsUsed?: number;
        blueprintRunsRemaining?: number;
        endDate?: string;
      }>;
      bonuses: ActivityBonuses;
    }
  >();

  for (const asset of includedAssets) {
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
      const isPackaged = !asset.isSingleton;
      const assetType = assetTypes.get(asset.typeId);
      const assetCategory = assetType
        ? categorizeType(assetType, language, marketGroups, groups).category
        : "item";
      const blueprintKind = assetCategory === "bpo"
        ? asset.runCount === -1
          ? "bpo"
          : asset.runCount !== undefined
            ? "bpc"
            : isPackaged
              ? "bpc"
              : "bpc"
        : null;
      const itemKey = `${asset.typeId}:${blueprintKind ?? (isPackaged ? "packaged" : "assembled")}`;
      const item = existing.items.get(itemKey) ?? { typeId: asset.typeId, quantity: 0, isPackaged };
      const assetQuantity = asset.quantity > 0 ? asset.quantity : 1;
      item.quantity += assetQuantity;
      if (asset.runCount !== undefined) {
        item.runCount = item.runCount === -1 || asset.runCount === -1
          ? -1
          : (item.runCount ?? 0) + asset.runCount * assetQuantity;
        item.me ??= asset.me;
        item.te ??= asset.te;
        const blueprintPrints = item.blueprintPrints ?? [];
        blueprintPrints.push({
          itemId: asset.itemId,
          runs: asset.runCount * assetQuantity,
          ...(asset.me !== undefined ? { me: asset.me } : {}),
          ...(asset.te !== undefined ? { te: asset.te } : {}),
        });
        item.blueprintPrints = blueprintPrints;
      }
      existing.items.set(itemKey, item);
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
      items: new Map([[`${asset.typeId}:${asset.runCount !== undefined ? (asset.runCount === -1 ? "bpo" : "bpc") : (asset.isSingleton ? "assembled" : "packaged")}`, {
        typeId: asset.typeId,
        quantity: asset.quantity > 0 ? asset.quantity : 1,
        ...(asset.runCount !== undefined
          ? { runCount: asset.runCount === -1 ? -1 : asset.runCount * (asset.quantity > 0 ? asset.quantity : 1) }
          : {}),
        ...(asset.me !== undefined ? { me: asset.me } : {}),
        ...(asset.te !== undefined ? { te: asset.te } : {}),
        ...(asset.runCount !== undefined
          ? {
              blueprintPrints: [{
                itemId: asset.itemId,
                runs: asset.runCount * (asset.quantity > 0 ? asset.quantity : 1),
                ...(asset.me !== undefined ? { me: asset.me } : {}),
                ...(asset.te !== undefined ? { te: asset.te } : {}),
              }],
            }
          : {}),
        isPackaged: !asset.isSingleton,
      }]]),
      bonuses: emptyBonuses(),
    });
  }

  for (const job of jobs) {
    if (job.status === "cancelled" || job.status === "delivered") continue;
    const typeId = job.productTypeId ?? job.blueprintTypeId;
    const quantity = job.successfulRuns ?? job.runs;
    const remainingRuns = job.licensedRuns;
    const isOriginal = remainingRuns === undefined || remainingRuns < 0;
    if (isOriginal || (remainingRuns ?? 0) > 0) {
      const blueprintItem = {
        typeId: job.blueprintTypeId,
        quantity: 1,
        isPackaged: true,
        inBuild: true,
        inUse: true,
        jobId: job.jobId,
        installerId: job.installerId,
        facilityId: job.facilityId,
        outputLocationId: job.outputLocationId,
        blueprintId: job.blueprintId,
        blueprintTypeId: job.blueprintTypeId,
        blueprintIsOriginal: isOriginal,
        blueprintRunsAtInstall: isOriginal ? -1 : remainingRuns + job.runs,
        blueprintRunsUsed: job.runs,
        blueprintRunsRemaining: isOriginal ? -1 : remainingRuns,
        runCount: isOriginal ? -1 : remainingRuns,
        blueprintPrints: [{ itemId: job.blueprintId, runs: isOriginal ? -1 : remainingRuns }],
        endDate: job.endDate,
      };
      const blueprintStructure = structures.get(job.blueprintLocationId);
      if (blueprintStructure) {
        blueprintStructure.assetCount += 1;
        if (job.ownerType === "corporation") blueprintStructure.corporationAssetCount += 1;
        else blueprintStructure.personalAssetCount += 1;
        blueprintStructure.items.set(`job-blueprint:${job.jobId}`, blueprintItem);
      } else {
        structures.set(job.blueprintLocationId, {
          structureId: job.blueprintLocationId,
          name: `Location ${job.blueprintLocationId}`,
          locationType: "structure",
          assetCount: 1,
          personalAssetCount: job.ownerType === "character" ? 1 : 0,
          corporationAssetCount: job.ownerType === "corporation" ? 1 : 0,
          resolved: false,
          ownedByCorporation: job.ownerType === "corporation",
          rigs: [],
          items: new Map([[`job-blueprint:${job.jobId}`, blueprintItem]]),
          bonuses: emptyBonuses(),
        });
      }
    }
    const existing = structures.get(job.outputLocationId);
    const item = {
      typeId,
      quantity,
      isPackaged: false,
      inBuild: true,
      jobId: job.jobId,
      installerId: job.installerId,
      facilityId: job.facilityId,
      outputLocationId: job.outputLocationId,
      blueprintId: job.blueprintId,
      blueprintTypeId: job.blueprintTypeId,
      blueprintIsOriginal: isOriginal,
      blueprintRunsAtInstall: isOriginal ? -1 : remainingRuns + job.runs,
      blueprintRunsUsed: job.runs,
      blueprintRunsRemaining: isOriginal ? -1 : remainingRuns,
      endDate: job.endDate,
    };
    if (existing) {
      existing.assetCount += 1;
      if (job.ownerType === "corporation") existing.corporationAssetCount += 1;
      else existing.personalAssetCount += 1;
      existing.items.set(`job:${job.jobId}`, item);
      continue;
    }
    structures.set(job.outputLocationId, {
      structureId: job.outputLocationId,
      name: `Location ${job.outputLocationId}`,
      locationType: "structure",
      assetCount: 1,
      personalAssetCount: job.ownerType === "character" ? 1 : 0,
      corporationAssetCount: job.ownerType === "corporation" ? 1 : 0,
      resolved: false,
      ownedByCorporation: job.ownerType === "corporation",
      rigs: [],
      items: new Map([[`job:${job.jobId}`, item]]),
      bonuses: emptyBonuses(),
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
    const fittedRigIds = structure.rigs.map(Number);
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
    structure.bonuses = structureBonuses(structure.typeId, typeBonuses);
    addBonuses(structure.bonuses, rigBonuses(
      fittedRigIds,
      rigDogma,
      dogmaEffects,
    ));
  }

  const itemTypeIds = [...structures.values()].flatMap((structure) =>
    [...structure.items.values()].map((item) => item.typeId),
  );
  const itemTypes = await getTypesByIds(itemTypeIds);

  return NextResponse.json({
    filteredLocationIds: [...filteredLocationIds],
    structures: [...structures.values()]
      .map((structure) => ({
        ...structure,
        totalCount: [...structure.items.values()].reduce((total, item) => total + item.quantity, 0),
        totalVolume: [...structure.items.values()].reduce(
          (total, item) => total + item.quantity * (item.isPackaged
            ? itemTypes.get(item.typeId)?.packagedVolume ?? itemTypes.get(item.typeId)?.volume ?? 0
            : itemTypes.get(item.typeId)?.volume ?? 0),
          0,
        ),
        items: [...structure.items.values()].flatMap((item) => {
          const type = itemTypes.get(item.typeId);
          if (!type?.published) return [];
          const categorized = categorizeType(type, language, marketGroups, groups);
          const category =
            categorized.category === "bpo"
              ? item.runCount !== undefined
                ? item.runCount === -1
                  ? "bpo"
                  : "bpc"
                : item.isPackaged
                  ? "bpc"
                  : "bpc"
              : categorized.category;
          return [{
            typeId: item.typeId,
            name: type.name[language] ?? type.name.en ?? `Type ${item.typeId}`,
            quantity: item.quantity,
            ...(item.runCount !== undefined ? { runCount: item.runCount } : {}),
            ...(item.me !== undefined ? { me: item.me } : {}),
            ...(item.te !== undefined ? { te: item.te } : {}),
            ...(item.blueprintPrints ? { blueprintPrints: item.blueprintPrints } : {}),
            isPackaged: item.isPackaged,
            assembledVolume: type.volume ?? 0,
            packagedVolume: type.packagedVolume,
            ...categorized,
            category,
            ...(item.inBuild
              ? {
                  inBuild: true,
                  inUse: item.inUse,
                  jobId: item.jobId,
                  installerId: item.installerId,
                  facilityId: item.facilityId,
                  outputLocationId: item.outputLocationId,
                  blueprintId: item.blueprintId,
                  blueprintTypeId: item.blueprintTypeId,
                  blueprintIsOriginal: item.blueprintIsOriginal,
                  blueprintRunsAtInstall: item.blueprintRunsAtInstall,
                  blueprintRunsUsed: item.blueprintRunsUsed,
                  blueprintRunsRemaining: item.blueprintRunsRemaining,
                  endDate: item.endDate,
                }
              : {}),
          }];
        }),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
}
