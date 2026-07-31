import { NextResponse } from "next/server";
import type { TypesRecordName } from "@/lib/sde/generated";
import {
  bonusDogmaAttributesById,
  ensureSdeLoaded,
  rigDogmaByTypeId,
  typeById,
} from "@/lib/sde/loader";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

const rigSizeAttribute = 1547;
const materialBonusAttribute = 2594;
const timeBonusAttribute = 2593;
const costBonusAttribute = 2595;
const securityMultiplierAttributes = [2355, 2356, 2357] as const;
const sizeByValue = { 2: "Medium", 3: "Large", 4: "Extra Large" } as const;
const outpostRigGroupId = 1984;

let cachedRigs: Array<{
  typeId: number;
  name: TypesRecordName;
  size: "Medium" | "Large" | "Extra Large";
  bonuses: { material: number; time: number; cost: number };
  securityMultipliers: number[];
}> | null = null;

export async function GET(request: Request) {
  const requestedLanguage = new URL(request.url).searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  try {
    ensureSdeLoaded();
    if (!cachedRigs) {
      const bonusAttributes = new Set([
        rigSizeAttribute,
        materialBonusAttribute,
        timeBonusAttribute,
        costBonusAttribute,
        ...securityMultiplierAttributes,
      ]);
      cachedRigs = [...rigDogmaByTypeId.values()].flatMap((dogma) => {
        const attributes = new Map(
          dogma.dogmaAttributes
            .filter(
              (attribute) =>
                bonusAttributes.has(attribute.attributeID) &&
                (attribute.attributeID === rigSizeAttribute ||
                  bonusDogmaAttributesById.has(attribute.attributeID)),
            )
            .map((attribute) => [attribute.attributeID, attribute.value]),
        );
        const size = sizeByValue[attributes.get(rigSizeAttribute) as keyof typeof sizeByValue];
        const type = typeById.get(dogma._key);
        if (
          !type?.published ||
          type.groupID === outpostRigGroupId ||
          !size ||
          ![materialBonusAttribute, timeBonusAttribute, costBonusAttribute].some(
            (id) => (attributes.get(id) ?? 0) !== 0,
          )
        )
          return [];
        return [
          {
            typeId: dogma._key,
            name: type.name,
            size,
            bonuses: {
              material: attributes.get(materialBonusAttribute) ?? 0,
              time: attributes.get(timeBonusAttribute) ?? 0,
              cost: attributes.get(costBonusAttribute) ?? 0,
            },
            securityMultipliers: securityMultiplierAttributes.map((id) => attributes.get(id) ?? 1),
          },
        ];
      });
    }
    const rigs = cachedRigs ?? [];
    return NextResponse.json({
      items: rigs.map((rig) => ({
        ...rig,
        name:
          rig.name[language] ??
          rig.name.en ??
          Object.values(rig.name).find(Boolean) ??
          `Type ${rig.typeId}`,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SDE reference data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
