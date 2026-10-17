import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/auth/session";
import { resolveFittingText } from "@/lib/fittings/resolve";
import { isSdeLanguage } from "@/lib/reference/languages";

const schema = z
  .object({
    text: z.string().trim().min(1).max(250000),
    language: z.string().refine(isSdeLanguage),
  })
  .strict();

/** Resolves one fitting against server-held SDE data; this never calls ESI or persists a fitting. */
export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  const session = await getSessionFromRequest(request);
  if (!session?.collectionId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401, headers });
  }
  let body: unknown;
  try {
    body = await request.json();
  }
  catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A fitting and supported language are required." },
      { status: 400, headers },
    );
  }
  try {
    return NextResponse.json(
      await resolveFittingText(parsed.data.text, parsed.data.language),
      { headers },
    );
  }
  catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not resolve fitting." },
      { status: 400, headers },
    );
  }
}
