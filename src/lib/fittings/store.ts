import { randomUUID } from "node:crypto";
import { initStorage, type Storage } from "@/lib/storage";
import {
  type FittingIndex,
  fittingNameKey,
  type FittingInput,
  type FittingSummary,
  type PersonalFitting,
  type SavedFitting,
} from "./model";

/** Expected client-action failure with a stable HTTP status. */
export class FittingError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** Converts a full fitting into its lightweight list representation. */
function summarize(fitting: SavedFitting): FittingSummary {
  const { items: _items, description: _description, ...summary } = fitting;
  return summary;
}

/** Returns namespaced keys without trusting a client-supplied collection identifier. */
function indexKey(collectionId: string): string {
  return `fittings:v1:${encodeURIComponent(collectionId)}`;
}

/** Fits each body into a separate Firestore document. */
function bodyKey(collectionId: string, id: string): string {
  return `${indexKey(collectionId)}:${id}`;
}

/** Creates a collection-scoped fitting repository; tests supply an isolated storage adapter. */
export function createFittingStore(storage: Storage) {
  /** Reads an additive namespace, without changing any auth or collection record. */
  async function list(collectionId: string): Promise<FittingSummary[]> {
    const index = await storage.getItem<FittingIndex>(indexKey(collectionId));
    return [...(index?.fittings ?? [])].sort((first, second) =>
      first.name.localeCompare(second.name),
    );
  }

  /** Reads a body only within the authorized collection namespace. */
  async function get(collectionId: string, id: string): Promise<SavedFitting | undefined> {
    return storage.getItem<SavedFitting>(bodyKey(collectionId, id));
  }

  /** Creates an immutable fitting while atomically enforcing unique collection names. */
  async function save(collectionId: string, input: FittingInput): Promise<SavedFitting> {
    return storage.runTransaction(async (transaction) => {
      const index = (await transaction.getItem<FittingIndex>(indexKey(collectionId))) ?? {
        version: 1,
        fittings: [],
        importedSources: [],
      };
      if (
        index.fittings.some(
          (fitting) => fittingNameKey(fitting.name) === fittingNameKey(input.name),
        )
      ) {
        throw new FittingError("A fitting with this name already exists in this collection.", 409);
      }
      if (index.fittings.length >= 1000) {
        throw new FittingError("This collection has reached the 1,000 fitting limit.", 409);
      }
      const fitting: SavedFitting = {
        ...input,
        id: randomUUID(),
        updatedAt: new Date().toISOString(),
        revision: 1,
      };
      index.fittings = [
        ...index.fittings.filter((entry) => entry.id !== fitting.id),
        summarize(fitting),
      ];
      transaction.setItem(bodyKey(collectionId, fitting.id), fitting);
      transaction.setItem(indexKey(collectionId), index);
      return fitting;
    });
  }

  /** Deletes only collection-created fittings; imported ESI entries are protected transactionally. */
  async function remove(collectionId: string, id: string, revision: number): Promise<void> {
    await storage.runTransaction(async (transaction) => {
      const index = await transaction.getItem<FittingIndex>(indexKey(collectionId));
      const previous = index?.fittings.find((fitting) => fitting.id === id);
      if (!index || !previous) throw new FittingError("Fitting not found.", 404);
      if (previous.source) throw new FittingError("ESI-imported fittings cannot be deleted.", 403);
      if (previous.revision !== revision) {
        throw new FittingError("This fitting changed. Reload it before deleting.", 409);
      }
      index.fittings = index.fittings.filter((fitting) => fitting.id !== id);
      transaction.deleteItem(bodyKey(collectionId, id));
      transaction.setItem(indexKey(collectionId), index);
    });
  }

  /** Seeds new personal fits once, preserving existing entries and resolving duplicate names. */
  async function importPersonal(
    collectionId: string,
    characterId: number,
    fittings: PersonalFitting[],
  ): Promise<void> {
    await storage.runTransaction(async (transaction) => {
      const index = (await transaction.getItem<FittingIndex>(indexKey(collectionId))) ?? {
        version: 1,
        fittings: [],
        importedSources: [],
      };
      const imported = new Set(index.importedSources);
      const names = new Set(index.fittings.map((fitting) => fittingNameKey(fitting.name)));
      const pending = fittings.filter(
        (fitting) => !imported.has(`${characterId}:${fitting.fitting_id}`),
      );
      if (pending.length + index.fittings.length > 1000 || pending.length + imported.size > 5000) {
        throw new FittingError("The fitting library import limit has been reached.", 409);
      }
      for (const personal of pending) {
        let name = personal.name;
        let suffix = 2;
        while (names.has(fittingNameKey(name))) {
          name = `${personal.name.slice(0, 175)} (${suffix++})`;
        }
        const fitting: SavedFitting = {
          id: randomUUID(),
          name,
          description: personal.description,
          shipTypeId: personal.ship_type_id,
          items: personal.items,
          updatedAt: new Date().toISOString(),
          revision: 1,
          source: { characterId, fittingId: personal.fitting_id },
        };
        names.add(fittingNameKey(name));
        imported.add(`${characterId}:${personal.fitting_id}`);
        index.fittings.push(summarize(fitting));
        transaction.setItem(bodyKey(collectionId, fitting.id), fitting);
      }
      if (pending.length) {
        index.importedSources = [...imported];
        transaction.setItem(indexKey(collectionId), index);
      }
    });
  }

  return { list, get, save, remove, importPersonal };
}

/** Opens the durable, server-only Firestore fitting repository. */
export async function getFittingStore(): Promise<ReturnType<typeof createFittingStore>> {
  const storage = await initStorage();
  return createFittingStore(storage);
}
