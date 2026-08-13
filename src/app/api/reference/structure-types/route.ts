import { NextResponse } from "next/server";
import { getGroups, getTypes } from "@/cache/services/sdeCache";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";

const structureCategoryId = 65;
const sizeByMass = new Map<number, { size: "Medium" | "Large" | "Extra Large"; sizeId: number }>([
  [3_000_000_000, { size: "Medium", sizeId: 2 }],
  [10_000_000_000, { size: "Large", sizeId: 3 }],
  [50_000_000_000, { size: "Extra Large", sizeId: 4 }],
]);

export async function GET(request: Request) {
  const requestedLanguage = new URL(request.url).searchParams.get("language");
  const language: SdeLanguage = isSdeLanguage(requestedLanguage) ? requestedLanguage : "en";
  try {
    const [types, groups] = await Promise.all([getTypes(), getGroups()]);
    const items = [...types.values()]
      .filter(
        (type) => type.published && groups.get(type.groupID)?.categoryID === structureCategoryId,
      )
      .flatMap((type) => {
        if (type.mass === undefined) return [];
        const size = sizeByMass.get(type.mass);
        if (!size) return [];
        return [
          {
            name: type.name[language] ?? type.name.en,
            typeId: type._key,
            ...size,
          },
        ];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return NextResponse.json({ items });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "SDE structure data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
