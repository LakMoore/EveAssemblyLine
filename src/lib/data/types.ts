import type { CorporationSourcePolicy } from "@/lib/esi/cache";

export type DataOwner = {
  kind: "character" | "corporation";
  id: number;
};

/**
 * Server-only context used by owner data providers after refresh authorization.
 * The browser must never construct or provide this context.
 */
export type OwnerDataContext = {
  sessionId: string;
  characterIds: readonly number[];
  corporationPolicies: readonly CorporationSourcePolicy[];
  authorizationCharacterId?: number;
};

/** Ensures a character provider cannot read a character outside its authorized session. */
export function assertCharacterOwner(characterId: number, context: OwnerDataContext): void {
  if (!context.characterIds.includes(characterId)) {
    throw new Error("Character is not available to this data provider context.");
  }
}

/** Resolves the authorized corporation policy for a corporation provider. */
export function getCorporationPolicy(corporationId: number, context: OwnerDataContext) {
  return context.corporationPolicies.find((policy) => policy.corporationId === corporationId);
}

/** Ensures a corporation provider cannot read a corporation outside its authorized policy set. */
export function assertCorporationOwner(corporationId: number, context: OwnerDataContext): void {
  if (!getCorporationPolicy(corporationId, context)) {
    throw new Error("Corporation is not available to this data provider context.");
  }
}
