import { randomUUID } from "node:crypto";
import { initStorage } from "../storage";
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
  if (!Number.isInteger(record.characterId) || typeof record.characterName !== "string")
    return null;
  const characterId = record.characterId as number;
  const personalAuth =
    normalizeTokenSet(record.personalAuth) ??
    normalizeTokenSet({
      accessToken: record.accessToken,
      refreshToken: record.refreshToken,
      accessTokenExpiresAt: record.accessTokenExpiresAt,
      scopes: record.scopes,
    });
  if (!personalAuth) return null;
  return {
    characterId,
    characterName: record.characterName,
    collectionId: record.collectionId ?? record.accountId,
    personalAuth,
    corporationId: record.corporationId,
    corporationRoles: Array.isArray(record.corporationRoles) ? record.corporationRoles : [],
    hasDirectorRole: record.hasDirectorRole,
    hasAccountantRole: record.hasAccountantRole,
    hasTraderRole: record.hasTraderRole,
  };
}

export async function getCharacters(): Promise<CharacterTokenRecord[]> {
  const storage = await initStorage();
  const raw = (await storage.getItem("characters")) as unknown[] | undefined;
  const records = (raw ?? [])
    .map(normalizeCharacter)
    .filter((record): record is CharacterTokenRecord => record !== null);
  if (JSON.stringify(raw ?? []) !== JSON.stringify(records))
    await storage.setItem("characters", records);
  return records;
}
export async function saveCharacters(records: CharacterTokenRecord[]) {
  await (await initStorage()).setItem("characters", records);
}
export async function getSessions(): Promise<SessionRecord[]> {
  const storage = await initStorage();
  const raw = (await storage.getItem("sessions")) as
    Array<SessionRecord & { accountId?: string; characterIds?: number[] }> | undefined;
  const records = (raw ?? []).map((session) => ({
    sessionId: session.sessionId,
    collectionId: session.collectionId ?? session.accountId,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
  }));
  if (JSON.stringify(raw ?? []) !== JSON.stringify(records))
    await storage.setItem("sessions", records);
  return records;
}
export async function saveSessions(records: SessionRecord[]) {
  await (await initStorage()).setItem("sessions", records);
}

export async function getCollections(): Promise<CharacterCollectionRecord[]> {
  const storage = await initStorage();
  const characters = await getCharacters();
  const stored = (await storage.getItem("collections")) as CharacterCollectionRecord[] | undefined;
  const legacy = (await storage.getItem("accounts")) as
    | Array<{ accountId: string; characterIds: number[]; createdAt: string; lastSeenAt: string }>
    | undefined;
  const collections =
    stored ??
    legacy?.map((account) => ({
      collectionId: account.accountId,
      characterIds: account.characterIds,
      createdAt: account.createdAt,
      lastSeenAt: account.lastSeenAt,
    })) ??
    [];
  const collectionById = new Map(
    collections.map((collection) => [collection.collectionId, collection]),
  );
  const now = new Date().toISOString();
  for (const character of characters) {
    let collection = character.collectionId
      ? collectionById.get(character.collectionId)
      : undefined;
    if (!collection) {
      collection = {
        collectionId: character.collectionId ?? randomUUID(),
        characterIds: [],
        createdAt: now,
        lastSeenAt: now,
      };
      collectionById.set(collection.collectionId, collection);
    }
    if (!collection.characterIds.includes(character.characterId))
      collection.characterIds.push(character.characterId);
    if (!character.collectionId) {
      character.collectionId = collection.collectionId;
      await upsertCharacter(character);
    }
  }
  const normalized = [...collectionById.values()];
  if (JSON.stringify(stored ?? []) !== JSON.stringify(normalized))
    await storage.setItem("collections", normalized);
  return normalized;
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
    (await getCollections()).find((collection) => collection.characterIds.includes(characterId)) ??
    null
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
  const storage = await initStorage();
  const collections = await getCollections();
  await storage.setItem("collections", [...collections, collection]);
  return collection;
}

export async function saveCollection(record: CharacterCollectionRecord) {
  const collections = await getCollections();
  const index = collections.findIndex(
    (collection) => collection.collectionId === record.collectionId,
  );
  if (index === -1) collections.push(record);
  else collections[index] = record;
  await (await initStorage()).setItem("collections", collections);
}

export async function deleteCharacter(characterId: number, collectionId: string) {
  const storage = await initStorage();
  await storage.runTransaction(async (transaction) => {
    const rawCharacters = (await transaction.getItem("characters")) as unknown[] | undefined;
    const characters = (rawCharacters ?? [])
      .map(normalizeCharacter)
      .filter((record): record is CharacterTokenRecord => record !== null);
    const character = characters.find((record) => record.characterId === characterId);
    if (!character || character.collectionId !== collectionId)
      throw new Error("Character is not attached to this collection.");

    const storedCollections = (await transaction.getItem("collections")) as
      CharacterCollectionRecord[] | undefined;
    const legacyAccounts = (await transaction.getItem("accounts")) as
      | Array<{ accountId: string; characterIds: number[]; createdAt: string; lastSeenAt: string }>
      | undefined;
    const collections =
      storedCollections ??
      legacyAccounts?.map((account) => ({
        collectionId: account.accountId,
        characterIds: account.characterIds,
        createdAt: account.createdAt,
        lastSeenAt: account.lastSeenAt,
      })) ??
      [];
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
      CharacterCollectionRecord[] | undefined;
    const legacyAccounts = (await transaction.getItem("accounts")) as
      | Array<{ accountId: string; characterIds: number[]; createdAt: string; lastSeenAt: string }>
      | undefined;
    const collections =
      storedCollections ??
      legacyAccounts?.map((account) => ({
        collectionId: account.accountId,
        characterIds: account.characterIds,
        createdAt: account.createdAt,
        lastSeenAt: account.lastSeenAt,
      })) ??
      [];
    const target = collections.find((collection) => collection.collectionId === targetId);
    const source = collections.find((collection) => collection.collectionId === sourceId);
    if (!target || !source) throw new Error("Collection not found");
    target.characterIds = [...new Set([...target.characterIds, ...source.characterIds])];
    target.lastSeenAt = new Date().toISOString();
    for (const character of characters) {
      if (character.collectionId === sourceId) character.collectionId = targetId;
    }
    const rawSessions = (await transaction.getItem("sessions")) as
      Array<SessionRecord & { accountId?: string }> | undefined;
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

export async function getSession(sessionId: string) {
  return (await getSessions()).find((session) => session.sessionId === sessionId) ?? null;
}
export async function deleteSession(sessionId: string) {
  const sessions = await getSessions();
  await saveSessions(sessions.filter((session) => session.sessionId !== sessionId));
}

export async function saveSession(record: SessionRecord) {
  const sessions = await getSessions();
  const index = sessions.findIndex((session) => session.sessionId === record.sessionId);
  if (index === -1) sessions.push(record);
  else sessions[index] = record;
  await saveSessions(sessions);
}

export async function savePendingMerge(mergeId: string, record: PendingMergeRecord) {
  await (await initStorage()).setItem(`pending-merge:${mergeId}`, record);
}

export async function getPendingMerge(mergeId: string) {
  return (await (await initStorage()).getItem(`pending-merge:${mergeId}`)) as
    PendingMergeRecord | undefined;
}

export async function deletePendingMerge(mergeId: string) {
  await (await initStorage()).setItem(`pending-merge:${mergeId}`, null);
}
