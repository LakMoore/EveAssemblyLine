import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDogmaAttributes, getGroups, getTypeDogma, getTypes } from "@/cache/services/sdeCache";
import { calculateReprocessingEfficiency } from "@/lib/planning/reprocessingEfficiency";

// Zod schema for query parameters
const baseYieldQuerySchema = z
  .object({
    structureTypeId: z
      .string()
      .optional()
      .default("0")
      .transform((val) => Number(val))
      .refine((val) => Number.isSafeInteger(val) && val >= 0, "Must be a nonnegative integer"),
    reprocessingRig: z
      .string()
      .optional()
      .default("0")
      .transform((val) => Number(val))
      .refine((val) => [0, 1, 2].includes(val), "Must be 0, 1, or 2"),
    securityStatus: z
      .string()
      .optional()
      .transform((val) => (val ? Number(val) : undefined))
      .refine(
        (val) => val === undefined || (Number.isFinite(val) && val >= -1 && val <= 1),
        "Must be between -1 and 1",
      ),
  })
  .describe("Base yield query parameters");

// Zod schema for POST request body
const baseYieldPostSchema = z.object({
  locations: z
    .array(
      z.object({
        id: z.string().describe("Location ID"),
        structureTypeId: z.number().int().nonnegative().optional().default(0),
        reprocessingRig: z
          .number()
          .int()
          .refine((val) => [0, 1, 2].includes(val), "Must be 0, 1, or 2")
          .optional()
          .default(0),
        securityStatus: z.number().min(-1).max(1).optional(),
      }),
    )
    .describe("Array of location configurations"),
});

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;

  // Parse and validate query parameters with Zod
  const validationResult = baseYieldQuerySchema.safeParse({
    structureTypeId: params.get("structureTypeId"),
    reprocessingRig: params.get("reprocessingRig"),
    securityStatus: params.get("securityStatus"),
  });

  if (!validationResult.success) {
    const errorMessages = validationResult.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return `${path || "query"}: ${issue.message}`;
    });
    return NextResponse.json({ error: errorMessages.join(" ") }, { status: 400 });
  }

  const { structureTypeId, reprocessingRig, securityStatus } = validationResult.data;
  try {
    const [types, groups, typeDogma, dogmaAttributes] = await Promise.all([
      getTypes(),
      getGroups(),
      getTypeDogma(),
      getDogmaAttributes(),
    ]);
    if (structureTypeId !== 0 && !types.has(structureTypeId)) {
      return NextResponse.json({ error: "Unknown structure type ID." }, { status: 400 });
    }
    const efficiencies = calculateReprocessingEfficiency(
      { types, groups, typeDogma, dogmaAttributes },
      structureTypeId,
      {},
      0,
      securityStatus,
      reprocessingRig,
    );
    return NextResponse.json({ baseYield: efficiencies.normalOre });
  }
  catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "SDE reprocessing data is unavailable." },
      { status: 503 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();

    // Parse and validate request body with Zod
    const validationResult = baseYieldPostSchema.safeParse(rawBody);
    if (!validationResult.success) {
      const errorMessages = validationResult.error.issues.map((issue) => {
        const path = issue.path.join(".");
        return `${path || "body"}: ${issue.message}`;
      });
      return NextResponse.json({ error: errorMessages.join(" ") }, { status: 400 });
    }

    const body = validationResult.data;
    const [types, groups, typeDogma, dogmaAttributes] = await Promise.all([
      getTypes(),
      getGroups(),
      getTypeDogma(),
      getDogmaAttributes(),
    ]);
    const maps = { types, groups, typeDogma, dogmaAttributes };
    const baseYields = body.locations.map((location) => {
      if (location.structureTypeId !== 0 && !types.has(location.structureTypeId)) {
        return null;
      }
      const efficiencies = calculateReprocessingEfficiency(
        maps,
        location.structureTypeId,
        {},
        0,
        location.securityStatus,
        location.reprocessingRig,
      );
      return { id: location.id, baseYield: efficiencies.normalOre };
    });
    if (baseYields.some((value) => value === null)) {
      return NextResponse.json(
        { error: "Invalid structure, rig, or security status." },
        { status: 400 },
      );
    }
    return NextResponse.json({ baseYields });
  }
  catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "SDE reprocessing data is unavailable." },
      { status: 503 },
    );
  }
}
