export interface CharacterTokenRecord {
  characterId: number; characterName: string; refreshToken: string; accessToken: string;
  accessTokenExpiresAt: string; scopes: string[]; corporationId?: number;
  hasDirectorRole?: boolean; corpAuthCompleted?: boolean;
}

export interface SessionRecord {
  sessionId: string; characterIds: number[]; createdAt: string; lastSeenAt: string;
}