import { fittingInputSchema, type FittingInput } from "./model";
import type { SdeLanguage } from "@/lib/reference/languages";
import { z } from "zod";

/** Resolves EFT, XML, DNA or ESI JSON through the authenticated server's SDE. */
export async function importFittingText(
  text: string,
  language: SdeLanguage,
): Promise<FittingInput> {
  if (text.length > 250000) throw new Error("The fitting text is too large.");
  const response = await fetch(
    "/api/fittings/resolve",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language }),
    },
  );
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(body);
    throw new Error(error.success ? error.data.error : "Could not resolve fitting.");
  }
  const parsed = fittingInputSchema.safeParse(body);
  if (!parsed.success) throw new Error("Invalid resolved fitting response.");
  return parsed.data;
}
