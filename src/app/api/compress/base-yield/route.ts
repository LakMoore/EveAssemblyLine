import { NextResponse } from "next/server";
import { getDogmaAttributes, getGroups, getTypeDogma, getTypes } from "@/cache/services/sdeCache";
import { calculateReprocessingEfficiency, type ReprocessingStructure } from "@/lib/planning/reprocessingEfficiency";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const structure = params.get("structure") ?? "NPC";
  const reprocessingRig = Number(params.get("reprocessingRig") ?? 0);
  const securityStatusValue = params.get("securityStatus");
  const securityStatus = securityStatusValue === null ? undefined : Number(securityStatusValue);
  if (structure !== "NPC" && structure !== "Athanor" && structure !== "Tatara") {
    return NextResponse.json({ error: "Structure must be NPC, Athanor, or Tatara." }, { status: 400 });
  }
  if (!Number.isInteger(reprocessingRig) || ![0, 1, 2].includes(reprocessingRig)) {
    return NextResponse.json({ error: "reprocessingRig must be 0, 1, or 2." }, { status: 400 });
  }
  if (securityStatus !== undefined && (!Number.isFinite(securityStatus) || securityStatus < -1 || securityStatus > 1)) {
    return NextResponse.json({ error: "Security status must be between -1 and 1." }, { status: 400 });
  }
  try {
    const [types, groups, typeDogma, dogmaAttributes] = await Promise.all([getTypes(), getGroups(), getTypeDogma(), getDogmaAttributes()]);
    const efficiencies = calculateReprocessingEfficiency(
      { types, groups, typeDogma, dogmaAttributes },
      structure as ReprocessingStructure,
      {},
      0,
      securityStatus,
      reprocessingRig,
    );
    return NextResponse.json({ baseYield: efficiencies.normalOre });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "SDE reprocessing data is unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      locations?: Array<{ id: string; structure?: string; reprocessingRig?: number; securityStatus?: number }>;
    };
    if (!Array.isArray(body.locations)) return NextResponse.json({ error: "locations must be an array." }, { status: 400 });
    const [types, groups, typeDogma, dogmaAttributes] = await Promise.all([getTypes(), getGroups(), getTypeDogma(), getDogmaAttributes()]);
    const maps = { types, groups, typeDogma, dogmaAttributes };
    const baseYields = body.locations.map((location) => {
      const structure = location.structure ?? "NPC";
      const reprocessingRig = location.reprocessingRig ?? 0;
      if ((structure !== "NPC" && structure !== "Athanor" && structure !== "Tatara") || !Number.isInteger(reprocessingRig) || ![0, 1, 2].includes(reprocessingRig) || (location.securityStatus !== undefined && (!Number.isFinite(location.securityStatus) || location.securityStatus < -1 || location.securityStatus > 1))) return null;
      const efficiencies = calculateReprocessingEfficiency(maps, structure, {}, 0, location.securityStatus, reprocessingRig);
      return { id: location.id, baseYield: efficiencies.normalOre };
    });
    if (baseYields.some((value) => value === null)) return NextResponse.json({ error: "Invalid structure, rig, or security status." }, { status: 400 });
    return NextResponse.json({ baseYields });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "SDE reprocessing data is unavailable." }, { status: 503 });
  }
}
