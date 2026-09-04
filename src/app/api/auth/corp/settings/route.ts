import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionCharacterIds, getSessionFromRequest } from "@/lib/auth/session";
import {
  getCharacter,
  getCollectionCorporationSettings,
  saveCollectionCorporationSettings,
} from "@/lib/auth/tokensStore";
import { corporationHangarFlags } from "@/lib/auth/model";

const sourceSchema = z.object({
  rootLocationId: z.number().int().positive(),
  locationFlag: z.enum(corporationHangarFlags),
});

const settingsSchema = z.object({
  corporationId: z.number().int().positive(),
  supportEnabled: z.boolean(),
  directHangars: z.array(sourceSchema).max(10_000),
  containerItemIds: z.array(z.number().int().positive()).max(10_000),
});

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(
    body,
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function GET(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return noStoreJson({ error: "Not authenticated." }, 401);
  return noStoreJson({ settings: await getCollectionCorporationSettings(session.collectionId!) });
}

export async function PUT(request: Request) {
  const session = await getSessionFromRequest(request);
  if (!session) return noStoreJson({ error: "Not authenticated." }, 401);
  const parsed = settingsSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return noStoreJson({ error: "Corporation settings are invalid." }, 400);
  }
  const characterIds = await getSessionCharacterIds(session);
  const characters = (await Promise.all(characterIds.map((id) => getCharacter(id)))).filter(
    (character) => character !== null,
  );
  if (!characters.some((character) => character.corporationId === parsed.data.corporationId)) {
    return noStoreJson({ error: "That corporation is not attached to this collection." }, 403);
  }
  try {
    const settings = await saveCollectionCorporationSettings(session.collectionId!, parsed.data);
    return noStoreJson({ settings });
  }
  catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : "Could not save corporation settings." },
      500,
    );
  }
}
