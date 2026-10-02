import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getCompressibleTypes,
  getDogmaAttributes,
  getGroups,
  getTypeDogma,
  getTypes,
} from "@/cache/services/sdeCache";
import { calculateReprocessingProfile } from "@/lib/planning/reprocessingEfficiency";
import { reprocessingProfileSchema } from "@/lib/planning/reprocessingProfile";
import { specialReprocessableTypeIds } from "@/lib/planning/reprocessStock";

const efficiencyRequestSchema = z
  .object({
    reprocessingProfile: reprocessingProfileSchema,
  })
  .strict();

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
    const profile = body.reprocessingProfile;
    if (profile.structureTypeId !== 0 && !types.has(profile.structureTypeId)) {
      return NextResponse.json({ error: "Unknown structure type ID." }, { status: 400 });
    }
    const maps = { types, groups, typeDogma, dogmaAttributes };
    const result = calculateReprocessingProfile(
      maps,
      new Set([...compressibleTypes.values(), ...specialReprocessableTypeIds]),
      profile,
    );
    return NextResponse.json(
      { efficiencies: result.efficiencies },
      { headers: { "Cache-Control": "no-store" } },
    );
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
