import { NextResponse } from "next/server";
import { getTypes } from "@/cache/services/sdeCache";

const typeLimit = 100;

export async function GET(request: Request) {
  try {
    const requestedStartId = Number(new URL(request.url).searchParams.get("startTypeId") ?? 0);
    const startTypeId =
      Number.isSafeInteger(requestedStartId) && requestedStartId >= 0 ? requestedStartId : 0;
    const types = await getTypes();
    const publishedTypes = [...types.values()]
      .filter((type) => type.published)
      .sort((left, right) => left._key - right._key);
    const requestedIndex = publishedTypes.findIndex((type) => type._key >= startTypeId);
    const startIndex = Math.min(
      requestedIndex === -1 ? publishedTypes.length - typeLimit : requestedIndex,
      Math.max(0, publishedTypes.length - typeLimit),
    );
    const batch = publishedTypes.slice(startIndex, startIndex + typeLimit);
    const items = batch.map((type) => ({
      typeId: type._key,
      name: type.name.en ?? Object.values(type.name).find(Boolean) ?? `Type ${type._key}`,
    }));

    return NextResponse.json({
      items,
      startTypeId: items[0]?.typeId ?? null,
      previousStartTypeId:
        startIndex > 0 ? publishedTypes[Math.max(0, startIndex - typeLimit)]._key : null,
      nextStartTypeId:
        startIndex + typeLimit < publishedTypes.length
          ? publishedTypes[startIndex + typeLimit]._key
          : null,
    });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "SDE reference data is unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
