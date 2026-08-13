export interface TokenSet {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  scopes: string[];
  lastUsedAt: number;
}

export interface CharacterTokenRecord {
  characterId: number;
  characterName: string;
  collectionId?: string;
  personalAuth: TokenSet;
  corporationId?: number;
  corporationRoles?: string[];
  hasDirectorRole?: boolean;
  hasAccountantRole?: boolean;
  hasTraderRole?: boolean;
  hasStationManagerRole?: boolean;
}

export interface CharacterCollectionRecord {
  collectionId: string;
  characterIds: number[];
  createdAt: string;
  lastSeenAt: string;
}

export interface AssetRecord {
  itemId: number;
  typeId: number;
  name?: string;
  quantity: number;
  runCount?: number;
  me?: number;
  te?: number;
  locationId: number;
  locationType:
    "facility" | "station" | "solar_system" | "item" | "structure" | "container" | "other"; // ESI location type
  // ESI location_flag = AssetSafety, AutoFit, Bonus, Booster, BoosterBay, Capsule, CapsuleerDeliveries, Cargo, CorpDeliveries,
  // CorpSAG1, CorpSAG2, CorpSAG3, CorpSAG4, CorpSAG5, CorpSAG6, CorpSAG7, CorporationGoalDeliveries, CrateLoot, Deliveries,
  // DroneBay, DustBattle, DustDatabank, ExpeditionHold, FighterBay, FighterTube0, FighterTube1, FighterTube2, FighterTube3,
  // FighterTube4, FleetHangar, FrigateEscapeBay, Hangar, HangarAll, HiSlot0, HiSlot1, HiSlot2, HiSlot3, HiSlot4, HiSlot5,
  // HiSlot6, HiSlot7, HiddenModifiers, Implant, Impounded, InfrastructureHangar, JunkyardReprocessed, JunkyardTrashed,
  // LoSlot0, LoSlot1, LoSlot2, LoSlot3, LoSlot4, LoSlot5, LoSlot6, LoSlot7, Locked, MedSlot0, MedSlot1, MedSlot2, MedSlot3,
  // MedSlot4, MedSlot5, MedSlot6, MedSlot7
  // MobileDepotHold, MoonMaterialBay, OfficeFolder, Pilot, PlanetSurface, QuafeBay, QuantumCoreRoom, Reward, RigSlot0
  // RigSlot1, RigSlot2, RigSlot3, RigSlot4, RigSlot5, RigSlot6, RigSlot7, SecondaryStorage, ServiceSlot0, ServiceSlot1
  // ServiceSlot2, ServiceSlot3, ServiceSlot4, ServiceSlot5, ServiceSlot6, ServiceSlot7, ShipHangar, ShipOffline, Skill,
  // SkillInTraining, SpecializedAmmoHold, SpecializedAsteroidHold, SpecializedCommandCenterHold, SpecializedFuelBay,
  // SpecializedGasHold, SpecializedIceHold, SpecializedIndustrialShipHold, SpecializedLargeShipHold, SpecializedMaterialBay
  // SpecializedMediumShipHold, SpecializedMineralHold, SpecializedOreHold, SpecializedPlanetaryCommoditiesHold, SpecializedSalvageHold
  // SpecializedShipHold, SpecializedSmallShipHold, StructureActive, StructureFuel, StructureInactive, StructureOffline, SubSystemBay
  // SubSystemSlot0, SubSystemSlot1, SubSystemSlot2, SubSystemSlot3, SubSystemSlot4, SubSystemSlot5, SubSystemSlot6, SubSystemSlot7
  // Unlocked, Wallet, Wardrobe
  locationFlag: string;
  isSingleton: boolean;
  ownerType: "character" | "corporation";
  ownerId: number;
  rootLocation?: AssetRecord | AssetLocation;
}

export interface AssetLocation {
  locationId: number;
  kind: "station" | "structure" | "solar_system";
  name?: string;
  typeId?: number;
  systemId?: number;
  regionId?: number;
  resolved: boolean;
}

export interface IndustryJobRecord {
  jobId: number;
  installerId: number;
  facilityId: number;
  locationId: number;
  outputLocationId: number;
  activityId: number;
  blueprintId: number;
  blueprintTypeId: number;
  blueprintLocationId: number;
  runs: number;
  licensedRuns?: number;
  productTypeId?: number;
  status: string;
  successfulRuns?: number;
  startDate: string;
  endDate: string;
  ownerType: "character" | "corporation";
  ownerId: number;
}

export interface MarketOrderRecord {
  orderId: number;
  typeId: number;
  locationId: number;
  volumeRemain: number;
  volumeTotal: number;
  isBuyOrder: boolean;
  isCorporation?: boolean;
  issuedBy?: number;
  ownerType: "character" | "corporation";
  ownerId: number;
}

export interface SessionRecord {
  sessionId: string;
  collectionId?: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface PendingMergeRecord {
  sessionId: string;
  targetCollectionId: string;
  sourceCollectionId: string;
  characterId: number;
  characterName?: string;
  tokenSet: TokenSet;
  scopes: string[];
  expiresAt: string;
}
