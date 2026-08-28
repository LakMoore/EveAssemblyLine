import { randomUUID } from "node:crypto";
import { initStorage } from "../storage";
import {
  mergeFacilitySettings,
  normalizeFacilitySettings,
  type FacilitySettingsPayload,
} from "../planning/facilities";
import {
  CharacterCollectionRecord,
  CharacterTokenRecord,
  PendingMergeRecord,
  SessionRecord,
  TokenSet,
} from "./model";

function normalizeTokenSet(value: Partial<TokenSet> | undefined): TokenSet | null {
  if (!value?.accessToken || !value.refreshToken || !value.accessTokenExpiresAt) return null;
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    accessTokenExpiresAt: value.accessTokenExpiresAt,
    scopes: Array.isArray(value.scopes) ? value.scopes : [],
    lastUsedAt: value.lastUsedAt ?? 0,
  };
}

function normalizeCharacter(value: unknown): CharacterTokenRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<CharacterTokenRecord> & {
    accountId?: string;
    refreshToken?: string;
    accessToken?: string;
    accessTokenExpiresAt?: string;
    scopes?: string[];
  };
  if (!Number.isInteger(record.characterId) || typeof record.characterName !== "string") {
    return null;
  }
  const characterId = record.characterId as number;
  const personalAuth =
    normalizeTokenSet(record.personalAuth)
    ?? normalizeTokenSet({
      accessToken: record.accessToken,
      refreshToken: record.refreshToken,
      accessTokenExpiresAt: record.accessTokenExpiresAt,
      scopes: record.scopes,
    });
  if (!personalAuth) return null;
  return {
    characterId,
    characterName: record.characterName,
    onDeployment: record.onDeployment ?? false,
    collectionId: record.collectionId ?? record.accountId,
    personalAuth,
    corporationId: record.corporationId,
    corporationRoles: Array.isArray(record.corporationRoles) ? record.corporationRoles : [],
    hasDirectorRole: record.hasDirectorRole,
    hasAccountantRole: record.hasAccountantRole,
    hasTraderRole: record.hasTraderRole,
    hasStationManagerRole: record.hasStationManagerRole,
  };
}

// Reads never persist their normalized snapshot: another session may have written newer tokens or
// collection membership in between, and a write-back here would silently revert it.
export async function getCharacters(): Promise<CharacterTokenRecord[]> {
  const storage = await initStorage();
  const raw = (await storage.getItem("characters")) as unknown[] | undefined;
  return (raw ?? [])
    .map(normalizeCharacter)
    .filter((record): record is CharacterTokenRecord => record !== null);
}
export async function saveCharacters(records: CharacterTokenRecord[]) {
  await (await initStorage()).setItem("characters", records);
}
function normalizeSessions(
  raw: Array<SessionRecord & { accountId?: string; characterIds?: number[] }> | undefined,
): SessionRecord[] {
  return (raw ?? []).map((session) => ({
    sessionId: session.sessionId,
    collectionId: session.collectionId ?? session.accountId,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
  }));
}

export async function getSessions(): Promise<SessionRecord[]> {
  const storage = await initStorage();
  return normalizeSessions(
    (await storage.getItem("sessions")) as
      | Array<SessionRecord & { accountId?: string; characterIds?: number[] }>
      | undefined,
  );
}
export async function saveSessions(records: SessionRecord[]) {
  await (await initStorage()).setItem("sessions", records);
}

type LegacyAccountRecord = {
  accountId: string;
  characterIds: number[];
  createdAt: string;
  lastSeenAt: string;
};

/** Rebuilds the collection list from stored/legacy records plus the membership implied by characters. */
function normalizeCollections(
  stored: CharacterCollectionRecord[] | undefined,
  legacy: LegacyAccountRecord[] | undefined,
  characters: CharacterTokenRecord[],
): CharacterCollectionRecord[] {
  const collections =
    stored
    ?? legacy?.map((account) => ({
      collectionId: account.accountId,
      characterIds: account.characterIds,
      createdAt: account.createdAt,
      lastSeenAt: account.lastSeenAt,
    }))
    ?? [];
  const collectionById = new Map(
    collections.map((collection) => [collection.collectionId, collection]),
  );
  // A character belongs to exactly one collection, so its own record is the authority. This drops
  // members left behind in a stale collection record after a merge or a character removal.
  const collectionIdByCharacterId = new Map(
    characters.map((character) => [character.characterId, character.collectionId]),
  );
  for (const collection of collectionById.values()) {
    collection.characterIds = collection.characterIds.filter(
      (characterId) => collectionIdByCharacterId.get(characterId) === collection.collectionId,
    );
  }
  const now = new Date().toISOString();
  for (const character of characters) {
    if (!character.collectionId) continue;
    let collection = collectionById.get(character.collectionId);
    if (!collection) {
      collection = {
        collectionId: character.collectionId,
        characterIds: [],
        createdAt: now,
        lastSeenAt: now,
      };
      collectionById.set(collection.collectionId, collection);
    }
    if (!collection.characterIds.includes(character.characterId)) {
      collection.characterIds.push(character.characterId);
    }
  }
  return [...collectionById.values()];
}

export async function getCollections(): Promise<CharacterCollectionRecord[]> {
  const storage = await initStorage();
  const characters = await getCharacters();
  const stored = (await storage.getItem("collections")) as CharacterCollectionRecord[] | undefined;
  const legacy = (await storage.getItem("accounts")) as LegacyAccountRecord[] | undefined;
  // Characters saved before collections existed are adopted into a new collection here.
  for (const character of characters) {
    if (character.collectionId) continue;
    character.collectionId = randomUUID();
    await upsertCharacter(character);
  }
  return normalizeCollections(stored, legacy, characters);
}

export async function getCollection(collectionId: string) {
  return (
    (await getCollections()).find((collection) => collection.collectionId === collectionId) ?? null
  );
}

export async function getCollectionForCharacter(characterId: number) {
  const character = await getCharacter(characterId);
  if (character?.collectionId) return getCollection(character.collectionId);
  return (
    (await getCollections()).find((collection) => collection.characterIds.includes(characterId))
    ?? null
  );
}

export async function createCollection(): Promise<CharacterCollectionRecord> {
  const now = new Date().toISOString();
  const collection = {
    collectionId: randomUUID(),
    characterIds: [],
    createdAt: now,
    lastSeenAt: now,
  };
  await saveCollection(collection);
  return collection;
}

export async function saveCollection(record: CharacterCollectionRecord) {
  const storage = await initStorage();
  await storage.runTransaction(async (transaction) => {
    const collections =
      ((await transaction.getItem("collections")) as CharacterCollectionRecord[] | undefined) ?? [];
    const index = collections.findIndex(
      (collection) => collection.collectionId === record.collectionId,
    );
    if (index === -1) collections.push(record);
    else collections[index] = record;
    transaction.setItem("collections", collections);
  });
}

export async function deleteCharacter(characterId: number, collectionId: string) {
  const storage = await initStorage();
  await storage.runTransaction(async (transaction) => {
    const rawCharacters = (await transaction.getItem("characters")) as unknown[] | undefined;
    const characters = (rawCharacters ?? [])
      .map(normalizeCharacter)
      .filter((record): record is CharacterTokenRecord => record !== null);
    const character = characters.find((record) => record.characterId === characterId);
    if (!character || character.collectionId !== collectionId) {
      throw new Error("Character is not attached to this collection.");
    }

    const storedCollections = (await transaction.getItem("collections")) as
      | CharacterCollectionRecord[]
      | undefined;
    const legacyAccounts = (await transaction.getItem("accounts")) as
      | LegacyAccountRecord[]
      | undefined;
    const collections = normalizeCollections(storedCollections, legacyAccounts, characters);
    for (const collection of collections) {
      collection.characterIds = collection.characterIds.filter((id) => id !== characterId);
    }
    transaction.setItem(
      "characters",
      characters.filter((record) => record.characterId !== characterId),
    );
    transaction.setItem("collections", collections);
  });
}

export async function mergeCollections(targetId: string, sourceId: string) {
  if (targetId === sourceId) return;
  const storage = await initStorage();
  await storage.runTransaction(async (transaction) => {
    const rawCharacters = (await transaction.getItem("characters")) as unknown[] | undefined;
    const characters = (rawCharacters ?? [])
      .map(normalizeCharacter)
      .filter((record): record is CharacterTokenRecord => record !== null);
    const storedCollections = (await transaction.getItem("collections")) as
      | CharacterCollectionRecord[]
      | undefined;
    const legacyAccounts = (await transaction.getItem("accounts")) as
      | LegacyAccountRecord[]
      | undefined;
    const collections = normalizeCollections(storedCollections, legacyAccounts, characters);
    const target = collections.find((collection) => collection.collectionId === targetId);
    const source = collections.find((collection) => collection.collectionId === sourceId);
    if (!target || !source) throw new Error("Collection not found");
    target.characterIds = [...new Set([...target.characterIds, ...source.characterIds])];
    target.lastSeenAt = new Date().toISOString();
    target.facilities = mergeFacilitySettings(
      normalizeFacilitySettings(target.facilities),
      normalizeFacilitySettings(source.facilities),
    );
    for (const character of characters) {
      if (character.collectionId === sourceId) character.collectionId = targetId;
    }
    const rawSessions = (await transaction.getItem("sessions")) as
      | Array<SessionRecord & { accountId?: string }>
      | undefined;
    const sessions = (rawSessions ?? []).map((session) => ({
      sessionId: session.sessionId,
      collectionId: session.collectionId ?? session.accountId,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
    }));
    for (const session of sessions) {
      if (session.collectionId === sourceId) session.collectionId = targetId;
    }
    transaction.setItem("characters", characters);
    transaction.setItem("sessions", sessions);
    transaction.setItem(
      "collections",
      collections.filter((collection) => collection.collectionId !== sourceId),
    );
  });
}

export async function getCharacter(characterId: number) {
  return (await getCharacters()).find((record) => record.characterId === characterId) ?? null;
}

export async function getCollectionFacilities(
  collectionId: string,
): Promise<FacilitySettingsPayload> {
  return normalizeFacilitySettings((await getCollection(collectionId))?.facilities);
}

/** Merges facility settings into the collection, keeping the newer edit. */
export async function saveCollectionFacilities(
  collectionId: string,
  payload: FacilitySettingsPayload,
): Promise<FacilitySettingsPayload> {
  const derived = await getCollection(collectionId);
  const storage = await initStorage();
  return storage.runTransaction(async (transaction) => {
    const collections =
      ((await transaction.getItem("collections")) as CharacterCollectionRecord[] | undefined) ?? [];
    let collection = collections.find((record) => record.collectionId === collectionId);
    if (!collection) {
      // The collection may exist only as a record derived from character membership.
      if (!derived) throw new Error("Collection not found");
      collection = { ...derived };
      collections.push(collection);
    }
    const merged = mergeFacilitySettings(
      normalizeFacilitySettings(collection.facilities),
      normalizeFacilitySettings(payload),
    );
    collection.facilities = merged;
    transaction.setItem("collections", collections);
    return merged;
  });
}

export async function upsertCharacter(record: CharacterTokenRecord) {
  const storage = await initStorage();
  await storage.runTransaction(async (transaction) => {
    const raw = (await transaction.getItem("characters")) as unknown[] | undefined;
    const records = (raw ?? [])
      .map(normalizeCharacter)
      .filter((existing): existing is CharacterTokenRecord => existing !== null);
    const index = records.findIndex((existing) => existing.characterId === record.characterId);
    if (index === -1) records.push(record);
    else records[index] = record;
    transaction.setItem("characters", records);
  });
}

export async function setCharacterOnDeployment(
  characterId: number,
  collectionId: string,
  onDeployment: boolean,
) {
  const storage = await initStorage();
  await storage.runTransaction(async (transaction) => {
    const raw = (await transaction.getItem("characters")) as unknown[] | undefined;
    const records = (raw ?? [])
      .map(normalizeCharacter)
      .filter((existing): existing is CharacterTokenRecord => existing !== null);
    const record = records.find((existing) => existing.characterId === characterId);
    if (!record || record.collectionId !== collectionId) {
      throw new Error("Character is not attached to this collection.");
    }
    record.onDeployment = onDeployment;
    transaction.setItem("characters", records);
  });
}

/**
 * Persists a rotated token for one character without touching any other field or character.
 * If another session already stored a still-usable token for the same character, that token wins so
 * a slower writer cannot restore an already-consumed refresh token.
 */
export async function saveCharacterTokens(
  characterId: number,
  previousAccessToken: string,
  tokenSet: TokenSet,
): Promise<TokenSet> {
  const storage = await initStorage();
  return storage.runTransaction(async (transaction) => {
    const raw = (await transaction.getItem("characters")) as unknown[] | undefined;
    const records = (raw ?? [])
      .map(normalizeCharacter)
      .filter((existing): existing is CharacterTokenRecord => existing !== null);
    const index = records.findIndex((existing) => existing.characterId === characterId);
    if (index === -1) return tokenSet;
    const stored = records[index].personalAuth;
    if (
      stored.accessToken !== previousAccessToken
      && stored.accessToken !== tokenSet.accessToken
      && Date.parse(stored.accessTokenExpiresAt) > Date.now() + 5 * 60 * 1000
    ) {
      return stored;
    }
    records[index] = { ...records[index], personalAuth: tokenSet };
    transaction.setItem("characters", records);
    return tokenSet;
  });
}

export async function getSession(sessionId: string) {
  return (await getSessions()).find((session) => session.sessionId === sessionId) ?? null;
}
export async function deleteSession(sessionId: string) {
  const storage = await initStorage();
  await storage.runTransaction(async (transaction) => {
    const sessions = normalizeSessions(
      (await transaction.getItem("sessions")) as
        | Array<SessionRecord & { accountId?: string }>
        | undefined,
    );
    transaction.setItem(
      "sessions",
      sessions.filter((session) => session.sessionId !== sessionId),
    );
  });
}

export async function saveSession(record: SessionRecord) {
  const storage = await initStorage();
  await storage.runTransaction(async (transaction) => {
    const sessions = normalizeSessions(
      (await transaction.getItem("sessions")) as
        | Array<SessionRecord & { accountId?: string }>
        | undefined,
    );
    const index = sessions.findIndex((session) => session.sessionId === record.sessionId);
    if (index === -1) sessions.push(record);
    else sessions[index] = record;
    transaction.setItem("sessions", sessions);
  });
}

export async function savePendingMerge(mergeId: string, record: PendingMergeRecord) {
  const storage = await initStorage();
  await storage.runTransaction(async (transaction) => {
    const pendingMerges =
      await transaction.getItemsByPrefix<Partial<PendingMergeRecord>>("pending-merge:");
    const now = Date.now();
    for (const pendingMerge of pendingMerges) {
      const expiresAt = pendingMerge.value?.expiresAt;
      if (!expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now) {
        transaction.deleteItem(pendingMerge.key);
      }
    }
    transaction.setItem(`pending-merge:${mergeId}`, record);
  });
}

export async function getPendingMerge(mergeId: string) {
  return (await (await initStorage()).getItem(`pending-merge:${mergeId}`)) as
    | PendingMergeRecord
    | undefined;
}

export async function deletePendingMerge(mergeId: string) {
  await (await initStorage()).setItem(`pending-merge:${mergeId}`, null);
}
