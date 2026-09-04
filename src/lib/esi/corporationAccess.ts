import {
  corporationHangarFlags,
  type CharacterTokenRecord,
  type CorporationHangarFlag,
} from "@/lib/auth/model";

export type CorporationHangarPermission = {
  flag: CorporationHangarFlag;
  canTake: boolean;
  canQuery: boolean;
};

export const corporationRefreshScopes = [
  "esi-assets.read_corporation_assets.v1",
  "esi-corporations.read_blueprints.v1",
  "esi-industry.read_corporation_jobs.v1",
  "esi-markets.read_corporation_orders.v1",
  "esi-corporations.read_divisions.v1",
  "esi-corporations.read_structures.v1",
  "esi-universe.read_structures.v1",
  "esi-characters.read_corporation_roles.v1",
] as const;

type CorporationRoleCharacter = Pick<
  CharacterTokenRecord,
  "corporationId" | "corporationRoles" | "rolesAtHq" | "rolesAtOther" | "hasDirectorRole"
>;

const roleNamesByFlag: Record<CorporationHangarFlag, { take: string; query: string }> = {
  CorpDeliveries: { take: "Deliveries_Take", query: "Deliveries_Query" },
  CorpSAG1: { take: "Hangar_Take_1", query: "Hangar_Query_1" },
  CorpSAG2: { take: "Hangar_Take_2", query: "Hangar_Query_2" },
  CorpSAG3: { take: "Hangar_Take_3", query: "Hangar_Query_3" },
  CorpSAG4: { take: "Hangar_Take_4", query: "Hangar_Query_4" },
  CorpSAG5: { take: "Hangar_Take_5", query: "Hangar_Query_5" },
  CorpSAG6: { take: "Hangar_Take_6", query: "Hangar_Query_6" },
  CorpSAG7: { take: "Hangar_Take_7", query: "Hangar_Query_7" },
};

/** Returns whether an ESI location flag is a corporation hangar root. */
export function isCorporationHangarFlag(value: string): value is CorporationHangarFlag {
  return (corporationHangarFlags as readonly string[]).includes(value);
}

/** Returns whether a character token can refresh the corporation data used by planning. */
export function hasCorporationRefreshScopes(scopes: readonly string[]) {
  return corporationRefreshScopes.every((scope) => scopes.includes(scope));
}

/** Returns the corporation hangar flag represented by a division number. */
export function corporationHangarFlagForDivision(
  division: number,
): CorporationHangarFlag | undefined {
  if (division === 0) return "CorpDeliveries";
  if (Number.isInteger(division) && division >= 1 && division <= 7) {
    return `CorpSAG${division}` as CorporationHangarFlag;
  }
  return undefined;
}

/** Returns the numeric ordering of a corporation hangar flag. */
export function corporationHangarNumber(flag: CorporationHangarFlag): number {
  return flag === "CorpDeliveries" ? 8 : Number(flag.slice("CorpSAG".length));
}

/** Returns the role set that applies to a character at a corporation root location. */
function rolesForLocation(
  character: CorporationRoleCharacter,
  rootLocationId: number,
  headquartersId: number,
) {
  if (character.hasDirectorRole || character.corporationRoles?.includes("Director")) {
    return character.corporationRoles ?? [];
  }
  return rootLocationId === headquartersId
    ? (character.rolesAtHq ?? [])
    : (character.rolesAtOther ?? []);
}

/** Merges effective Take and Query permissions for a corporation root location. */
export function getCorporationHangarPermissions(
  characters: readonly CorporationRoleCharacter[],
  corporationId: number,
  rootLocationId: number,
  headquartersId: number,
): Map<CorporationHangarFlag, CorporationHangarPermission> {
  const permissions = new Map<CorporationHangarFlag, CorporationHangarPermission>(
    corporationHangarFlags.map((flag) => [flag, { flag, canTake: false, canQuery: false }]),
  );
  for (const character of characters) {
    if (character.corporationId !== corporationId) continue;
    const roles = rolesForLocation(character, rootLocationId, headquartersId);
    const isDirector =
      character.hasDirectorRole || character.corporationRoles?.includes("Director");
    for (const flag of corporationHangarFlags) {
      const roleNames = roleNamesByFlag[flag];
      const permission = permissions.get(flag)!;
      permission.canTake ||= isDirector || roles.includes(roleNames.take);
      permission.canQuery ||= isDirector || roles.includes(roleNames.query);
      permission.canQuery ||= permission.canTake;
    }
  }
  return permissions;
}
