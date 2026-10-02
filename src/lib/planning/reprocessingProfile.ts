import { z } from "zod";

/** Validated profile shared by reprocessing tools without exposing ESI or SDE records. */
export const reprocessingProfileSchema = z
  .object({
    structureTypeId: z.number().int().safe().nonnegative(),
    rigTypeIds: z.array(z.number().int().safe().positive()),
    skillLevels: z.record(z.string().regex(/^\d+$/), z.number().int().min(0).max(5)),
    implantLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4)]),
    securityStatus: z.number().min(-1).max(1).optional(),
  })
  .strict();

export type ReprocessingProfile = z.infer<typeof reprocessingProfileSchema>;

export type ReprocessingProfileLocation = {
  locationType: "station" | "structure";
  structureTypeId: number;
  rigTypeIds: number[];
  securityStatus?: number;
};

/** Converts selected settings into the shared, SDE-independent request profile. */
export function createReprocessingProfile(
  location: ReprocessingProfileLocation,
  skillLevels: Record<string, number>,
  implantLevel: ReprocessingProfile["implantLevel"],
): ReprocessingProfile {
  return {
    structureTypeId: location.locationType === "structure" ? location.structureTypeId : 0,
    rigTypeIds:
      location.locationType === "structure"
        ? location.rigTypeIds.filter((typeId) => Number.isSafeInteger(typeId) && typeId > 0)
        : [],
    skillLevels,
    implantLevel,
    ...(location.securityStatus === undefined ? {} : { securityStatus: location.securityStatus }),
  };
}
