import { z } from "zod";

/** Validated numeric ESI fitting item, shared by imports, API requests and local cache. */
export const fittingItemSchema = z.object({
  flag: z.number().int().nonnegative().max(10000),
  quantity: z.number().int().positive().max(2_147_483_647),
  type_id: z.number().int().positive().max(2_147_483_647),
});

/** Editable, language-independent fitting payload. */
export const fittingInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(10000).default(""),
    shipTypeId: z.number().int().positive().max(2_147_483_647),
    items: z.array(fittingItemSchema).max(2000),
  })
  .strict();

/** App-managed fitting fields supplied by a caller. */
export type FittingInput = z.infer<typeof fittingInputSchema>;

/** Lightweight collection-library entry; bodies are fetched only when opened. */
export const fittingSummarySchema = fittingInputSchema
  .omit({ items: true, description: true })
  .extend({
    id: z.uuid(),
    updatedAt: z.iso.datetime(),
    revision: z.number().int().positive(),
    source: z
      .object({ characterId: z.number().int().positive(), fittingId: z.number().int().positive() })
      .optional(),
  });

/** Fitting index entry returned by GET /api/fittings. */
export type FittingSummary = z.infer<typeof fittingSummarySchema>;

/** Durable fitting and validated detail-response shape. */
export const savedFittingSchema = fittingInputSchema.extend(fittingSummarySchema.shape);

/** Full collection fitting with optimistic concurrency revision. */
export type SavedFitting = z.infer<typeof savedFittingSchema>;

/** Versioned durable index; import history includes fittings deleted from the app. */
export const fittingIndexSchema = z.object({
  version: z.literal(1),
  fittings: z.array(fittingSummarySchema).max(1000),
  importedSources: z.array(z.string().regex(/^\d+:\d+$/)).max(5000),
});

/** Durable collection library index. */
export type FittingIndex = z.infer<typeof fittingIndexSchema>;

const fittingFlagBases: Partial<Record<string, number>> = {
  LoSlot: 11,
  MedSlot: 19,
  HiSlot: 27,
  RigSlot: 92,
  SubSystemSlot: 125,
  ServiceSlot: 164,
};
const fittingBayFlags: Partial<Record<string, number>> = {
  Cargo: 5,
  DroneBay: 87,
  FighterBay: 158,
};

/** Normalizes current symbolic ESI flags and legacy numeric exports to one stored representation. */
const esiFittingFlagSchema = z.union([
  fittingItemSchema.shape.flag,
  z
    .string()
    .transform((flag, context) => {
      const match = flag.match(
        /^(LoSlot|MedSlot|HiSlot|RigSlot|SubSystemSlot|ServiceSlot)([0-7])$/,
      );
      const base = match ? fittingFlagBases[match[1]] : undefined;
      const numericFlag =
        match && base !== undefined ? base + Number(match[2]) : fittingBayFlags[flag];
      if (numericFlag !== undefined) return numericFlag;
      context.addIssue({ code: "custom", message: `Unsupported fitting inventory flag: ${flag}` });
      return z.NEVER;
    }),
]);

/** ESI response schema; current symbolic flags are normalized and unknown metadata discarded. */
export const esiFittingSchema = z.object({
  fitting_id: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10000).default(""),
  ship_type_id: z.number().int().positive(),
  items: z.array(fittingItemSchema.extend({ flag: esiFittingFlagSchema })).max(2000),
});

/** Validated personal fitting received from ESI. */
export type PersonalFitting = z.infer<typeof esiFittingSchema>;

/** Collection-scoped list and browser cache envelope. */
export const fittingListSchema = z.object({
  collectionId: z.string().min(1),
  fittings: z.array(fittingSummarySchema),
});

/** Produces a stable comparison key so case and Unicode variants cannot clash. */
export function fittingNameKey(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase();
}
