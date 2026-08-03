export interface TokenSet {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  scopes: string[];
}

export interface CharacterTokenRecord {
  characterId: number;
  characterName: string;
  accountId?: string;
  personalAuth: TokenSet;
  corpAuth?: TokenSet;
  corporationId?: number;
  hasDirectorRole?: boolean;
  hasStationManagerRole?: boolean;
  corpAuthCompleted?: boolean;
}

export interface AccountRecord {
  accountId: string;
  characterIds: number[];
  createdAt: string;
  lastSeenAt: string;
}

export interface AssetRecord {
  itemId: number;
  typeId: number;
  quantity: number;
  runCount?: number;
  me?: number;
  te?: number;
  locationId: number;
  locationType: "station" | "solar_system" | "item" | "structure" | "other";
  locationFlag: string;
  isSingleton: boolean;
  ownerType: "character" | "corporation";
  ownerId: number;
}

export interface AssetLocation {
  locationId: number;
  kind: "station" | "solar_system" | "structure" | "container" | "unknown";
  name?: string;
  typeId?: number;
  systemId?: number;
  regionId?: number;
  parentLocationId?: number;
  resolved: boolean;
}

export interface ResolvedAssetRecord extends AssetRecord {
  location: AssetLocation;
  sourceLocationId: number;
  sourceLocationName?: string;
}

export interface SessionRecord {
  sessionId: string;
  accountId?: string;
  characterIds: number[];
  createdAt: string;
  lastSeenAt: string;
}