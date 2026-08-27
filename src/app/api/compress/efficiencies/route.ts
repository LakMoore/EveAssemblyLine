import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getCompressibleTypes,
  getDogmaAttributes,
  getGroups,
  getTypeDogma,
  getTypes,
} from "@/cache/services/sdeCache";
import {
  calculateReprocessingEfficiency,
  efficiencyForType,
} from "@/lib/planning/reprocessingEfficiency";
import { specialReprocessableTypeIds } from "@/lib/planning/reprocessStock";

const efficiencyRequestSchema = z.object({
  structureTypeId: z.number().int().safe().nonnegative().default(0),
  rigTypeIds: z.array(z.number().int().safe().positive()).default([]),
  skillLevels: z.record(z.string().regex(/^\d+$/), z.number().int().min(0).max(5)).default({}),
  implantLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4)]).default(0),
  securityStatus: z.number().min(-1).max(1).optional(),
});

/** Returns the first supplied rig carrying an SDE reprocessing-yield attribute. */
function findReprocessingRigTypeId(
  rigTypeIds: readonly number[],
  typeDogma: Awaited<ReturnType<typeof getTypeDogma>>,
) {
  return rigTypeIds.find((typeId) =>
    typeDogma
      .get(typeId)
      ?.dogmaAttributes.some(
        (attribute) => attribute.attributeID === 379 || attribute.attributeID === 717,
      ),
  );
}

/** Calculates a complete efficiency snapshot for every planner-reprocessable type. */
export async function POST(request: Request) {
  try {
    const parsed = efficiencyRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues.map((issue) => issue.message).join(" ") },
        { status: 400 },
      );
    }
    const body = parsed.data;
    const [types, groups, typeDogma, dogmaAttributes, compressibleTypes] = await Promise.all([
      getTypes(),
      getGroups(),
      getTypeDogma(),
      getDogmaAttributes(),
      getCompressibleTypes(),
    ]);
    if (body.structureTypeId !== 0 && !types.has(body.structureTypeId)) {
      return NextResponse.json({ error: "Unknown structure type ID." }, { status: 400 });
    }
    const maps = { types, groups, typeDogma, dogmaAttributes };
    const calculated = calculateReprocessingEfficiency(
      maps,
      body.structureTypeId,
      body.skillLevels,
      body.implantLevel,
      body.securityStatus,
      0,
      findReprocessingRigTypeId(body.rigTypeIds, typeDogma),
    );
    const typeIds = new Set([...compressibleTypes.values(), ...specialReprocessableTypeIds]);
    const efficiencies = Object.fromEntries(
      [...typeIds].map((typeId) => [
        String(typeId),
        efficiencyForType(maps, typeId, calculated, body.skillLevels),
      ]),
    );
    return NextResponse.json({ efficiencies }, { headers: { "Cache-Control": "no-store" } });
  }
  catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not calculate reprocessing efficiencies.",
      },
      { status: 503 },
    );
  }
}
