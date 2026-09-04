export type RefreshCharacterTarget = {
  characterId: number;
  corporationId?: number;
  hasDirectorRole: boolean;
  corporationSupportEnabled?: boolean;
};

export type RefreshUnit = {
  key: string;
  kind: "character" | "corporation";
  ownerId: number;
};

export type RefreshUnitResult = {
  unit: RefreshUnit;
  success: boolean;
  error?: unknown;
};

/** Builds the unique session-scoped personal and eligible corporation refresh units. */
export function buildRefreshUnits(targets: readonly RefreshCharacterTarget[]): RefreshUnit[] {
  const characterUnits = new Map<number, RefreshUnit>();
  for (const target of targets) {
    if (characterUnits.has(target.characterId)) continue;
    characterUnits.set(
      target.characterId,
      {
        key: `character:${target.characterId}`,
        kind: "character",
        ownerId: target.characterId,
      },
    );
  }
  const corporationUnits = new Map<number, RefreshUnit>();
  for (const target of targets) {
    if (!target.corporationSupportEnabled || target.corporationId === undefined) continue;
    if (corporationUnits.has(target.corporationId)) continue;
    corporationUnits.set(
      target.corporationId,
      {
        key: `corporation:${target.corporationId}`,
        kind: "corporation",
        ownerId: target.corporationId,
      },
    );
  }
  // Return corporation units first to prioritize refreshing corporations before characters.
  return [...corporationUnits.values(), ...characterUnits.values()];
}

/** Runs refresh units with bounded concurrency and reports every settled unit. */
export async function runRefreshUnits(
  units: readonly RefreshUnit[],
  refresh: (unit: RefreshUnit) => Promise<void>,
  options: {
    concurrency?: number;
    onSettled?: (result: RefreshUnitResult) => void;
  } = {},
): Promise<RefreshUnitResult[]> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  const uniqueUnits = [...new Map(units.map((unit) => [unit.key, unit])).values()];
  const results: RefreshUnitResult[] = [];
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < uniqueUnits.length) {
      const unit = uniqueUnits[nextIndex];
      nextIndex += 1;
      try {
        await refresh(unit);
        const result = { unit, success: true };
        results.push(result);
        options.onSettled?.(result);
      }
      catch (error) {
        const result = { unit, success: false, error };
        results.push(result);
        options.onSettled?.(result);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueUnits.length) }, runNext));
  return results;
}

/** Coalesces concurrent work for the same character or corporation owner. */
export class RefreshCoordinator {
  private readonly active = new Map<string, Promise<unknown>>();

  /** Runs owner work once while sharing the same promise with concurrent callers. */
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.active.get(key);
    if (existing) return existing as Promise<T>;
    const pending = work().finally(() => this.active.delete(key));
    this.active.set(key, pending);
    return pending;
  }
}
