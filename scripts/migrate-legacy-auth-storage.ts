import { randomUUID } from "node:crypto";
import { initStorage } from "../src/lib/storage";
import type {
  CharacterCollectionRecord,
  CharacterTokenRecord,
  TokenSet,
} from "../src/lib/auth/model";

const legacyCharactersKey = "characters";
const legacyAccountsKey = "accounts";
const characterRecordPrefix = "character:";
const characterTokenPrefix = "character-token:";
const applyRequested = process.argv.includes("--apply");

type LegacyAccountRecord = {
  accountId: string;
  characterIds: number[];
  createdAt: string;
  lastSeenAt: string;
};

type RawRecord = Record<string, unknown>;

type MigrationSummary = {
  legacyCharacters: number;
  legacyAccounts: number;
  charactersMigrated: number;
  charactersAlreadyCurrent: number;
  invalidCharactersRetained: number;
  accountsMigrated: number;
  invalidAccountsRetained: number;
  collectionsChanged: boolean;
  deletedLegacyKeys: string[];
};

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTokenSet(value: unknown): TokenSet | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.accessToken !== "string"
    || typeof value.refreshToken !== "string"
    || typeof value.accessTokenExpiresAt !== "string"
  ) return null;
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    accessTokenExpiresAt: value.accessTokenExpiresAt,
    scopes: Array.isArray(value.scopes)
      ? value.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    lastUsedAt: typeof value.lastUsedAt === "number" ? value.lastUsedAt : 0,
  };
}

function readLegacyAccount(value: unknown): LegacyAccountRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.accountId !== "string"
    || !Array.isArray(value.characterIds)
    || !value.characterIds.every((characterId) => Number.isInteger(characterId))
    || typeof value.createdAt !== "string"
    || typeof value.lastSeenAt !== "string"
  ) return null;
  return {
    accountId: value.accountId,
    characterIds: value.characterIds as number[],
    createdAt: value.createdAt,
    lastSeenAt: value.lastSeenAt,
  };
}

function readLegacyCharacter(
  value: unknown,
  accountIdByCharacterId: ReadonlyMap<number, string>,
): CharacterTokenRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.characterId !== "number" || !Number.isInteger(value.characterId)) return null;
  if (typeof value.characterName !== "string") return null;
  const personalAuth = readTokenSet(value.personalAuth) ?? readTokenSet(value);
  if (!personalAuth) return null;
  const collectionId =
    (typeof value.collectionId === "string" ? value.collectionId : undefined)
    ?? (typeof value.accountId === "string" ? value.accountId : undefined)
    ?? accountIdByCharacterId.get(value.characterId);
  const corporationRoles = Array.isArray(value.corporationRoles)
    ? value.corporationRoles.filter((role): role is string => typeof role === "string")
    : [];
  const record: CharacterTokenRecord = {
    characterId: value.characterId,
    characterName: value.characterName,
    onDeployment: typeof value.onDeployment === "boolean" ? value.onDeployment : false,
    personalAuth,
    corporationRoles,
  };
  if (collectionId) record.collectionId = collectionId;
  if (typeof value.corporationId === "number" && Number.isInteger(value.corporationId)) {
    record.corporationId = value.corporationId;
  }
  for (const field of [
    "hasDirectorRole",
    "hasAccountantRole",
    "hasTraderRole",
    "hasStationManagerRole",
  ] as const) {
    if (typeof value[field] === "boolean") record[field] = value[field];
  }
  return record;
}

function characterIdFromKey(key: string, prefix: string) {
  const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  const characterId = Number(suffix);
  return Number.isSafeInteger(characterId) && characterId > 0 ? characterId : null;
}

function readCurrentCollection(value: unknown): CharacterCollectionRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.collectionId !== "string"
    || !Array.isArray(value.characterIds)
    || !value.characterIds.every((characterId) => Number.isInteger(characterId))
    || typeof value.createdAt !== "string"
    || typeof value.lastSeenAt !== "string"
  ) return null;
  return {
    ...value,
    collectionId: value.collectionId,
    characterIds: [...new Set(value.characterIds as number[])],
    createdAt: value.createdAt,
    lastSeenAt: value.lastSeenAt,
  } as CharacterCollectionRecord;
}

function addCollectionMember(collection: CharacterCollectionRecord, characterId: number) {
  if (!collection.characterIds.includes(characterId)) collection.characterIds.push(characterId);
}

async function migrate() {
  const storage = await initStorage();
  const summary = await storage.runTransaction<MigrationSummary>(async (transaction) => {
    const [
      legacyCharactersRaw,
      legacyAccountsRaw,
      currentCharacterEntries,
      currentTokenEntries,
      currentCollectionsRaw,
    ] = await Promise.all([
      transaction.getItem<unknown>(legacyCharactersKey),
      transaction.getItem<unknown>(legacyAccountsKey),
      transaction.getItemsByPrefix<unknown>(characterRecordPrefix),
      transaction.getItemsByPrefix<unknown>(characterTokenPrefix),
      transaction.getItem<unknown>("collections"),
    ]);
    const legacyCharacters = Array.isArray(legacyCharactersRaw) ? legacyCharactersRaw : [];
    const legacyAccounts = Array.isArray(legacyAccountsRaw) ? legacyAccountsRaw : [];
    const validAccounts: LegacyAccountRecord[] = [];
    for (const value of legacyAccounts) {
      const account = readLegacyAccount(value);
      if (account) validAccounts.push(account);
    }
    const accountIdByCharacterId = new Map<number, string>();
    for (const account of validAccounts) {
      for (const characterId of account.characterIds) {
        if (!accountIdByCharacterId.has(characterId)) {
          accountIdByCharacterId.set(characterId, account.accountId);
        }
      }
    }

    const currentCharacterIds = new Set<number>();
    const collectionIdByCharacterId = new Map<number, string>();
    for (const entry of currentCharacterEntries) {
      const characterId = characterIdFromKey(entry.key, characterRecordPrefix);
      if (characterId === null) continue;
      currentCharacterIds.add(characterId);
      if (isRecord(entry.value)) {
        const collectionId =
          typeof entry.value.collectionId === "string"
            ? entry.value.collectionId
            : typeof entry.value.accountId === "string"
              ? entry.value.accountId
              : undefined;
        if (collectionId) collectionIdByCharacterId.set(characterId, collectionId);
      }
    }
    const currentTokenSetsByCharacterId = new Map<number, TokenSet>();
    for (const entry of currentTokenEntries) {
      const characterId = characterIdFromKey(entry.key, characterTokenPrefix);
      const tokenSet = readTokenSet(entry.value);
      if (characterId !== null && tokenSet) {
        currentTokenSetsByCharacterId.set(characterId, tokenSet);
      }
    }

    const migratedCharacters = new Map<number, CharacterTokenRecord>();
    const remainingLegacyCharacters: unknown[] = [];
    let charactersAlreadyCurrent = 0;
    for (const value of legacyCharacters) {
      const character = readLegacyCharacter(value, accountIdByCharacterId);
      if (!character) {
        remainingLegacyCharacters.push(value);
        continue;
      }
      if (currentCharacterIds.has(character.characterId)) {
        charactersAlreadyCurrent += 1;
        continue;
      }
      const currentTokenSet = currentTokenSetsByCharacterId.get(character.characterId);
      if (currentTokenSet) character.personalAuth = currentTokenSet;
      migratedCharacters.set(character.characterId, character);
      currentCharacterIds.add(character.characterId);
      if (character.collectionId) {
        collectionIdByCharacterId.set(character.characterId, character.collectionId);
      }
    }

    const collections = Array.isArray(currentCollectionsRaw)
      ? currentCollectionsRaw
          .map(readCurrentCollection)
          .filter((collection): collection is CharacterCollectionRecord => collection !== null)
      : [];
    const collectionById = new Map(
      collections.map((collection) => [collection.collectionId, collection]),
    );
    const ensureCollection = (
      collectionId: string,
      createdAt = new Date().toISOString(),
      lastSeenAt = createdAt,
    ) => {
      let collection = collectionById.get(collectionId);
      if (!collection) {
        collection = {
          collectionId,
          characterIds: [],
          createdAt,
          lastSeenAt,
        };
        collections.push(collection);
        collectionById.set(collectionId, collection);
      }
      return collection;
    };
    const addMemberIfOwned = (collectionId: string, characterId: number) => {
      const ownerCollectionId = collectionIdByCharacterId.get(characterId);
      if (ownerCollectionId && ownerCollectionId !== collectionId) return;
      const collection = ensureCollection(collectionId);
      if (!collection.characterIds.includes(characterId)) {
        addCollectionMember(collection, characterId);
      }
    };

    for (const entry of currentCharacterEntries) {
      const characterId = characterIdFromKey(entry.key, characterRecordPrefix);
      const collectionId =
        characterId === null ? undefined : collectionIdByCharacterId.get(characterId);
      if (collectionId && characterId !== null) addMemberIfOwned(collectionId, characterId);
    }
    for (const character of migratedCharacters.values()) {
      if (character.collectionId) addMemberIfOwned(character.collectionId, character.characterId);
    }
    for (const account of validAccounts) {
      const collection = ensureCollection(account.accountId, account.createdAt, account.lastSeenAt);
      for (const characterId of account.characterIds) {
        if (currentCharacterIds.has(characterId)) {
          addMemberIfOwned(collection.collectionId, characterId);
        }
      }
    }
    const collectionsChanged =
      JSON.stringify(collections) !== JSON.stringify(currentCollectionsRaw);

    const deletedLegacyKeys: string[] = [];
    if (applyRequested) {
      for (const character of migratedCharacters.values()) {
        transaction.setItem(`${characterRecordPrefix}${character.characterId}`, character);
      }
      if (collectionsChanged) transaction.setItem("collections", collections);
      if (legacyCharactersRaw !== undefined) {
        if (remainingLegacyCharacters.length === 0) {
          transaction.deleteItem(legacyCharactersKey);
          deletedLegacyKeys.push(legacyCharactersKey);
        }
        else transaction.setItem(legacyCharactersKey, remainingLegacyCharacters);
      }
      const remainingLegacyAccounts = legacyAccounts.filter((value) => !readLegacyAccount(value));
      if (legacyAccountsRaw !== undefined) {
        if (remainingLegacyAccounts.length === 0) {
          transaction.deleteItem(legacyAccountsKey);
          deletedLegacyKeys.push(legacyAccountsKey);
        }
        else transaction.setItem(legacyAccountsKey, remainingLegacyAccounts);
      }
    }

    return {
      legacyCharacters: legacyCharacters.length,
      legacyAccounts: legacyAccounts.length,
      charactersMigrated: migratedCharacters.size,
      charactersAlreadyCurrent,
      invalidCharactersRetained: remainingLegacyCharacters.length,
      accountsMigrated: validAccounts.length,
      invalidAccountsRetained: legacyAccounts.length - validAccounts.length,
      collectionsChanged,
      deletedLegacyKeys,
    };
  });
  return summary;
}

migrate()
  .then((summary) => {
    console.log(`Legacy characters found: ${summary.legacyCharacters}`);
    console.log(`Legacy accounts found: ${summary.legacyAccounts}`);
    console.log(`Characters to migrate: ${summary.charactersMigrated}`);
    console.log(`Characters already current: ${summary.charactersAlreadyCurrent}`);
    console.log(`Invalid characters retained: ${summary.invalidCharactersRetained}`);
    console.log(`Accounts to migrate: ${summary.accountsMigrated}`);
    console.log(`Invalid accounts retained: ${summary.invalidAccountsRetained}`);
    console.log(`Collections changed: ${summary.collectionsChanged ? "yes" : "no"}`);
    if (!applyRequested) {
      console.log("Dry run only. Re-run with --apply to migrate and prune legacy records.");
      return;
    }
    console.log(
      summary.deletedLegacyKeys.length > 0
        ? `Deleted empty legacy keys: ${summary.deletedLegacyKeys.join(", ")}`
        : "Legacy keys retained because invalid records remain.",
    );
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
