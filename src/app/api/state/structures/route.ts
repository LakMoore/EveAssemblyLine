import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import {
  getAssembledContainerAssetsByItemId,
  getResolvedAssetIndex,
  getResolvedAssets,
  getRunningIndustryJobs,
} from "@/lib/esi/cache";
import { fetchCorporationStructures, fetchLocationMetadata, getUsableToken } from "@/lib/esi/client";
import { getCharacter } from "@/lib/auth/tokensStore";
import {
  getDogmaEffects,
  getActivityInputTypeIds,
  getGroups,
  getMarketGroups,
  getBlueprintsByInventionProductId,
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

function activityName(activityId: number) {
  return ({
    1: "Manufacturing",
    3: "Time research",
    4: "Material research",
    5: "Copying",
    8: "Invention",
    9: "Reactions",
  } as Record<number, string>)[activityId] ?? "Industry job";
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
  const requestedTypeIds = new Set(
    (url.searchParams.get("typeIds") ?? "")
      .split(",")
      .map(Number)
      .filter((typeId) => Number.isInteger(typeId)),
  );

  const [productionAssets, assembledContainersById, jobs, activityInputTypeIds, rigDogma, dogmaEffects, typeBonuses, marketGroups] = await Promise.all([
    getResolvedAssets(session.characterIds, true),
    getAssembledContainerAssetsByItemId(session.characterIds, true),
    getRunningIndustryJobs(session.characterIds, true),
    getActivityInputTypeIds(),
    getRigDogma(),
    getDogmaEffects(),
    getTypeBonuses(),
    getMarketGroups(),
  ]);
  const assets = productionAssets;
  const assetTypes = await getTypesByIds([...new Set([
    ...assets.map((asset) => asset.typeId),
    ...jobs.flatMap((job) => [job.productTypeId ?? job.blueprintTypeId, job.blueprintTypeId]),
  ])]);
  const groups = await getGroups();
  const includedAssets = assets.filter((asset) => {
    const type = assetTypes.get(asset.typeId);
    const category = type ? categorizeType(type, language, marketGroups, groups).category : "item";
    if (
      !requestedTypeIds.has(asset.typeId) &&
      !activityInputTypeIds.has(asset.typeId) &&
      category !== "blueprint" &&
      category !== "reaction"
    ) return false;
    const categoryId = groups.get(assetTypes.get(asset.typeId)?.groupID ?? -1)?.categoryID;
    const isCargoContainer =
      categoryId === containerCategoryId ||
      isCargoContainerType(asset.typeId, assetTypes, groups, marketGroups);
    if (isCargoContainer) return true;
    if (!asset.isSingleton) return true;
    return true;
  });
  const filteredLocationIds = new Set(
    assets
      .filter((asset) => !includedAssets.includes(asset))
      .map((asset) => asset.location.locationId),
  );
  const assetsByItemId = await getResolvedAssetIndex(session.characterIds, true);
  const characters = await Promise.all(session.characterIds.map((characterId) => getCharacter(characterId)));
  const corporationStructures = new Map<number, Awaited<ReturnType<typeof fetchCorporationStructures>>[number]>();
  for (const character of characters) {
    if (!character) continue;
    try {
      for (const structure of await fetchCorporationStructures(character)) {
        corporationStructures.set(structure.structure_id, structure);
      }
    } catch {}
  }
  const itemAndJobLocations = new Set([
    ...jobs.map((job) => findTerminalAssetLocation(job.locationId)),
    ...jobs.map((job) => findTerminalAssetLocation(job.blueprintLocationId)),
    ...assets.map((asset) => findTerminalAssetLocation(asset.locationId)),
  ].filter(l => l !== undefined));
  type LocationMetadata = NonNullable<Awaited<ReturnType<typeof fetchLocationMetadata>>["data"]>;
  const locationMetadata = new Map<number, LocationMetadata>();
  const locationKinds = new Map<number, "station" | "structure">();
  const metadataTokens = (await Promise.all(characters.map(async (character) => {
    if (!character) return [];
    const tokens = [];
    try { tokens.push(await getUsableToken(character, "personal")); } catch {}
    try { if (character.corpAuth) tokens.push(await getUsableToken(character, "corp")); } catch {}
    return tokens;
  }))).flat();
  async function resolveLocationMetadata(locationId: number) {
    if (locationMetadata.has(locationId)) return;
    // Stations are in the SDE, so we can resolve them without an ESI request.
    metadataTokens.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const token of metadataTokens) {
      try {
        const result = await fetchLocationMetadata(locationId, "structure", token);
        if (result.data) {
          locationMetadata.set(locationId, result.data);
          locationKinds.set(locationId, "structure");
          return;
        }
      } catch {}
    }
  };
  await Promise.all(
    [...new Set([
      ...itemAndJobLocations,
    ])].map(async (location) => {
      try {
        await resolveLocationMetadata(location.locationId);
      } catch {
        // Keep unresolved locations visible below.
      }
    }),
  );
  const locations = includedAssets.map((asset) => {
    const location = findTerminalAssetLocation(asset.locationId);
    if (!location) return { ...asset, location: asset.location };
    const metadata = locationMetadata.get(location.locationId);
    if (!metadata) return { ...asset, location };
    const kind = locationKinds.get(location.locationId) ?? "station";
    return {
      ...asset,
      location: {
        ...location,
        kind,
        name: metadata.name,
        typeId: metadata.type_id,
        systemId: metadata.system_id,
        regionId: metadata.region_id,
        resolved: true,
      },
    };
  });
  function findTerminalAssetLocation(itemId: number) {
    let asset = assetsByItemId.get(itemId);
    while (asset) {
      const parentContainer = assembledContainersById.get(asset.locationId);
      if (!parentContainer) return asset.location;
      asset = parentContainer;
    }
    return undefined;
  }
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
        activityName?: string;
        endDate?: string;
      }>;
      bonuses: ActivityBonuses;
    }
  >();

  // Populate structures with assets and jobs.
  for (const location of locations.values()) {
    const displayLocation = location.location.kind !== "facility"
      ? {
          ...location.location,
          kind: "facility" as const,
          name: location.location.name ?? `Unresolved location ${location.locationId}`,
        }
      : location.location;
    if (displayLocation.kind !== "facility") continue;
    const displayAsset = { ...location, location: displayLocation };
    const existing = structures.get(displayLocation.locationId);
    if (existing) {
      existing.assetCount += 1;
      if (displayAsset.ownerType === "corporation") existing.corporationAssetCount += 1;
      else existing.personalAssetCount += 1;
      if (!existing.name && displayAsset.location.name) existing.name = displayAsset.location.name;
      if (!existing.systemId && displayAsset.location.systemId)
        existing.systemId = displayAsset.location.systemId;
      if (!existing.typeId && displayAsset.location.typeId) existing.typeId = displayAsset.location.typeId;
      if (displayAsset.ownerType === "corporation" && displayAsset.location.kind === "facility" && displayAsset.locationFlag.startsWith("RigSlot")) {
        existing.rigs.push(String(displayAsset.typeId));
      }
      const isPackaged = !displayAsset.isSingleton;
      const assetType = assetTypes.get(displayAsset.typeId);
      const assetCategory = assetType
        ? categorizeType(assetType, language, marketGroups, groups).category
        : "item";
      const blueprintKind = assetCategory === "blueprint"
        ? location.runCount === -1
          ? "bpo"
          : location.runCount !== undefined
            ? "bpc"
            : isPackaged
              ? "bpc"
              : "bpc"
        : null;
      const itemKey = `${displayAsset.typeId}:${blueprintKind ?? (isPackaged ? "packaged" : "assembled")}`;
      const item = existing.items.get(itemKey) ?? { typeId: displayAsset.typeId, quantity: 0, isPackaged };
      const assetQuantity = displayAsset.quantity > 0 ? displayAsset.quantity : 1;
      item.quantity += assetQuantity;
      if (displayAsset.runCount !== undefined) {
        item.runCount = item.runCount === -1 || displayAsset.runCount === -1
          ? -1
          : (item.runCount ?? 0) + displayAsset.runCount * assetQuantity;
        item.me ??= displayAsset.me;
        item.te ??= displayAsset.te;
        const blueprintPrints = item.blueprintPrints ?? [];
        blueprintPrints.push({
          itemId: displayAsset.itemId,
          runs: displayAsset.runCount * assetQuantity,
          ...(displayAsset.me !== undefined ? { me: displayAsset.me } : {}),
          ...(displayAsset.te !== undefined ? { te: displayAsset.te } : {}),
        });
        item.blueprintPrints = blueprintPrints;
      }
      existing.items.set(itemKey, item);
      continue;
    }
    structures.set(displayLocation.locationId, {
      structureId: displayLocation.locationId,
      name: displayLocation.name ?? `Unresolved location ${displayLocation.locationId}`,
      ...(displayLocation.systemId ? { systemId: displayLocation.systemId } : {}),
      locationType: displayLocation.kind === "facility" ? "structure" : displayLocation.kind,
      assetCount: 1,
      personalAssetCount: displayAsset.ownerType === "character" ? 1 : 0,
      corporationAssetCount: displayAsset.ownerType === "corporation" ? 1 : 0,
      resolved: true,
      ...(displayLocation.typeId ? { typeId: displayLocation.typeId } : {}),
      rigs:
        displayAsset.ownerType === "corporation" &&
        displayAsset.location.kind === "facility" &&
        displayAsset.locationFlag.startsWith("RigSlot")
          ? [String(displayAsset.typeId)]
          : [],
      ownedByCorporation: false,
      items: new Map([[`${displayAsset.typeId}:${displayAsset.runCount !== undefined ? (displayAsset.runCount === -1 ? "bpo" : "bpc") : (displayAsset.isSingleton ? "assembled" : "packaged")}`, {
        typeId: displayAsset.typeId,
        quantity: displayAsset.quantity > 0 ? displayAsset.quantity : 1,
        ...(displayAsset.runCount !== undefined
          ? { runCount: displayAsset.runCount === -1 ? -1 : displayAsset.runCount * (displayAsset.quantity > 0 ? displayAsset.quantity : 1) }
          : {}),
        ...(displayAsset.me !== undefined ? { me: displayAsset.me } : {}),
        ...(displayAsset.te !== undefined ? { te: displayAsset.te } : {}),
        ...(displayAsset.runCount !== undefined
          ? {
              blueprintPrints: [{
                itemId: displayAsset.itemId,
                runs: displayAsset.runCount * (displayAsset.quantity > 0 ? displayAsset.quantity : 1),
                ...(displayAsset.me !== undefined ? { me: displayAsset.me } : {}),
                ...(displayAsset.te !== undefined ? { te: displayAsset.te } : {}),
              }],
            }
          : {}),
        isPackaged: !displayAsset.isSingleton,
      }]]),
      bonuses: emptyBonuses(),
    });
  }

  for (const job of jobs) {
    if (job.status === "cancelled" || job.status === "delivered") continue;
    const typeId = job.productTypeId ?? job.blueprintTypeId;
    const jobActivityName = activityName(job.activityId);
    const inventionProducts = job.activityId === 8 && job.productTypeId
      ? (await getBlueprintsByInventionProductId(job.productTypeId)).flatMap(
          (blueprint) => blueprint.activities?.invention?.products ?? [],
        )
      : [];
    const inventionProduct = inventionProducts.find(
      (product) => product.typeID === job.productTypeId,
    );
    const inventionSuccesses = inventionProduct
      ? Math.floor(job.runs * (inventionProduct.probability ?? 1))
      : undefined;
    const quantity = inventionSuccesses ?? job.successfulRuns ?? job.runs;
    const remainingRuns = job.licensedRuns;
    const isManufacturingJob = job.activityId === 1;
    const isInventionJob = job.activityId === 8;
    const completedInventionCopies = job.successfulRuns ?? inventionSuccesses;
    const installedBlueprintAsset = assetsByItemId.get(job.blueprintId);
    let installedRunsAtStart = installedBlueprintAsset?.runCount !== undefined && installedBlueprintAsset.runCount >= 0
      ? installedBlueprintAsset.runCount
      : undefined;
    let installedRunsRemaining = installedRunsAtStart === undefined
      ? undefined
      : Math.max(0, installedRunsAtStart - job.runs);
    for (const structure of structures.values()) {
      for (const item of structure.items.values()) {
        const print = item.blueprintPrints?.find((entry) => entry.itemId === job.blueprintId);
        if (!print || item.runCount === undefined || item.runCount < 0) continue;
        installedRunsAtStart ??= print.runs;
        const runsUsed = Math.min(print.runs, job.runs);
        print.runs -= runsUsed;
        item.runCount -= runsUsed;
        installedRunsRemaining = print.runs;
      }
    }
    const isOriginal = installedRunsAtStart === undefined && (remainingRuns === undefined || remainingRuns < 0);
    if (isManufacturingJob && !isOriginal) {
      installedRunsAtStart = job.runs;
      installedRunsRemaining = 0;
    } else if (
      isInventionJob &&
      remainingRuns !== undefined &&
      remainingRuns >= 0 &&
      completedInventionCopies !== undefined
    ) {
      installedRunsAtStart = Math.max(0, remainingRuns - completedInventionCopies);
      installedRunsRemaining = Math.max(0, installedRunsAtStart - job.runs);
    }
    const displayRemainingRuns = installedRunsRemaining ?? remainingRuns;
    const displayRuns = displayRemainingRuns ?? 0;
    const runsAtInstall = isOriginal ? -1 : (installedRunsAtStart ?? displayRuns + job.runs);
    if (isOriginal || installedRunsAtStart !== undefined || (displayRemainingRuns ?? 0) > 0) {
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
        blueprintRunsAtInstall: runsAtInstall,
        blueprintRunsUsed: job.runs,
        blueprintRunsRemaining: isOriginal ? -1 : displayRuns,
        runCount: isOriginal ? -1 : displayRuns,
        blueprintPrints: [{ itemId: job.blueprintId, runs: isOriginal ? -1 : displayRuns }],
        activityName: jobActivityName,
        endDate: job.endDate,
      };
      const blueprintLocation = findTerminalAssetLocation(job.blueprintLocationId);
      const blueprintStructureId =
        blueprintLocation?.locationId ??
        (locationMetadata.has(job.blueprintLocationId)
          ? job.blueprintLocationId
          : job.locationId);
      const blueprintStructure = structures.get(blueprintStructureId);
      if (blueprintStructure) {
        blueprintStructure.assetCount += 1;
        if (job.ownerType === "corporation") blueprintStructure.corporationAssetCount += 1;
        else blueprintStructure.personalAssetCount += 1;
        blueprintStructure.items.set(`job-blueprint:${job.jobId}`, blueprintItem);
      } else {
        structures.set(blueprintStructureId, {
          structureId: blueprintStructureId,
          name: blueprintLocation?.name ?? locationMetadata.get(blueprintStructureId)?.name ?? `Location ${blueprintStructureId}`,
          locationType: locationKinds.get(blueprintStructureId) ?? "structure",
          assetCount: 1,
          personalAssetCount: job.ownerType === "character" ? 1 : 0,
          corporationAssetCount: job.ownerType === "corporation" ? 1 : 0,
          resolved: true,
          ...(locationMetadata.get(blueprintStructureId)?.type_id
            ? { typeId: locationMetadata.get(blueprintStructureId)?.type_id }
            : {}),
          ...(locationMetadata.get(blueprintStructureId)?.system_id
            ? { systemId: locationMetadata.get(blueprintStructureId)?.system_id }
            : {}),
          ownedByCorporation: job.ownerType === "corporation",
          rigs: [],
          items: new Map([[`job-blueprint:${job.jobId}`, blueprintItem]]),
          bonuses: emptyBonuses(),
        });
      }
    }
    const existing = structures.get(job.locationId);
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
      blueprintRunsAtInstall: runsAtInstall,
      blueprintRunsUsed: job.runs,
      blueprintRunsRemaining: isOriginal ? -1 : displayRuns,
      ...(inventionProduct ? { runCount: inventionProduct.quantity * quantity } : {}),
      activityName: jobActivityName,
      endDate: job.endDate,
    };
    if (existing) {
      existing.assetCount += 1;
      if (job.ownerType === "corporation") existing.corporationAssetCount += 1;
      else existing.personalAssetCount += 1;
      existing.items.set(`job:${job.jobId}`, item);
      continue;
    }
    structures.set(job.locationId, {
      structureId: job.locationId,
      name: locationMetadata.get(job.locationId)?.name ?? `Location ${job.locationId}`,
      locationType: locationKinds.get(job.locationId) ?? "structure",
      assetCount: 1,
      personalAssetCount: job.ownerType === "character" ? 1 : 0,
      corporationAssetCount: job.ownerType === "corporation" ? 1 : 0,
      resolved: locationMetadata.has(job.locationId),
      ...(locationMetadata.get(job.locationId)?.type_id
        ? { typeId: locationMetadata.get(job.locationId)?.type_id }
        : {}),
      ...(locationMetadata.get(job.locationId)?.system_id
        ? { systemId: locationMetadata.get(job.locationId)?.system_id }
        : {}),
      ownedByCorporation: job.ownerType === "corporation",
      rigs: [],
      items: new Map([[`job:${job.jobId}`, item]]),
      bonuses: emptyBonuses(),
    });
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
      structure.typeId ??= metadata.type_id;
      structure.type = type ?? types.get(metadata.type_id)?.name.en ?? `Type ${metadata.type_id}`;
      structure.size = structureSize(structure.type);
      if (!structure.resolved && metadata.name) structure.name = metadata.name;
      structure.systemId ??= metadata.system_id;
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
            categorized.category === "blueprint"
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
                  activityName: item.activityName,
                  endDate: item.endDate,
                }
              : {}),
          }];
        }),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
}
