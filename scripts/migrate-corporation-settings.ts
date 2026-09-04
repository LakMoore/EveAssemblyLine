import { initStorage } from "../src/lib/storage";
import {
  corporationHangarFlags,
  type CharacterCollectionRecord,
  type CorporationCollectionSettings,
} from "../src/lib/auth/model";
import { normalizeCorporationSettings } from "../src/lib/auth/tokensStore";

const applyRequested = process.argv.includes("--apply");
const hangarFlagSet = new Set<string>(corporationHangarFlags);

type RawRecord = Record<string, unknown>;

type MigrationSummary = {
  collectionsFound: number;
  collectionsChanged: number;
  malformedCollections: number;
  malformedSettings: number;
};

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSource(value: unknown) {
  if (!isRecord(value)) return false;
  return (
    typeof value.rootLocationId === "number"
    && Number.isSafeInteger(value.rootLocationId)
    && value.rootLocationId > 0
    && typeof value.locationFlag === "string"
    && hangarFlagSet.has(value.locationFlag)
  );
}

function isValidSettings(value: unknown): value is CorporationCollectionSettings[] {
  return (
    Array.isArray(value)
    && value.every((candidate) => {
      if (!isRecord(candidate)) return false;
      return (
        typeof candidate.corporationId === "number"
        && Number.isSafeInteger(candidate.corporationId)
        && candidate.corporationId > 0
        && (candidate.supportEnabled === undefined || typeof candidate.supportEnabled === "boolean")
        && (
          candidate.directHangars === undefined
          || (
            Array.isArray(candidate.directHangars)
            && candidate.directHangars.every(isValidSource)
          )
        )
        && (
          candidate.containerItemIds === undefined
          || (
            Array.isArray(candidate.containerItemIds)
            && candidate.containerItemIds.every(
              (itemId) => typeof itemId === "number" && Number.isSafeInteger(itemId) && itemId > 0,
            )
          )
        )
      );
    })
  );
}

function isCollection(value: unknown): value is CharacterCollectionRecord & RawRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.collectionId === "string"
    && Array.isArray(value.characterIds)
    && value.characterIds.every(
      (characterId) => typeof characterId === "number" && Number.isSafeInteger(characterId),
    )
    && typeof value.createdAt === "string"
    && typeof value.lastSeenAt === "string"
  );
}

async function migrate() {
  const storage = await initStorage();
  return storage.runTransaction<MigrationSummary>(async (transaction) => {
    const raw = await transaction.getItem<unknown>("collections");
    if (raw === undefined) {
      return {
        collectionsFound: 0,
        collectionsChanged: 0,
        malformedCollections: 0,
        malformedSettings: 0,
      };
    }
    if (!Array.isArray(raw)) {
      return {
        collectionsFound: 0,
        collectionsChanged: 0,
        malformedCollections: 1,
        malformedSettings: 0,
      };
    }

    const collections = [...raw];
    let collectionsChanged = 0;
    let malformedCollections = 0;
    let malformedSettings = 0;
    for (const [index, value] of collections.entries()) {
      if (!isCollection(value)) {
        malformedCollections += 1;
        continue;
      }
      if (value.corporationSettings !== undefined && !isValidSettings(value.corporationSettings)) {
        malformedSettings += 1;
        continue;
      }
      const settings = normalizeCorporationSettings(value.corporationSettings);
      const migrated = { ...value, corporationSettings: settings };
      if (JSON.stringify(migrated) !== JSON.stringify(value)) {
        collections[index] = migrated;
        collectionsChanged += 1;
      }
    }
    if (applyRequested && collectionsChanged > 0) transaction.setItem("collections", collections);
    return {
      collectionsFound: collections.length,
      collectionsChanged,
      malformedCollections,
      malformedSettings,
    };
  });
}

migrate()
  .then((summary) => {
    console.log(`Collections found: ${summary.collectionsFound}`);
    console.log(`Collections to update: ${summary.collectionsChanged}`);
    console.log(`Malformed collections retained: ${summary.malformedCollections}`);
    console.log(`Malformed corporation settings retained: ${summary.malformedSettings}`);
    if (!applyRequested) console.log("Dry run only. Re-run with --apply to write the new schema.");
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
