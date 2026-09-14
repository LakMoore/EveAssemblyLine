export type FacilityService =
  | "standard"
  | "capital"
  | "supercapital"
  | "research"
  | "invention"
  | "reprocessing"
  | "biochemical"
  | "composite"
  | "hybrid";

const facilityServiceByName: Record<string, FacilityService> = {
  "standup capital shipyard i": "capital",
  "standup hyasyoda research lab": "research",
  "standup invention lab i": "invention",
  "standup manufacturing plant": "standard",
  "standup manufacturing plant i": "standard",
  "standup research lab i": "research",
  "standup supercapital shipyard i": "supercapital",
  "standup reprocessing facility i": "reprocessing",
  "standup biochemical reactor i": "biochemical",
  "standup composite reactor i": "composite",
  "standup hybrid reactor i": "hybrid",
};

/** Maps a resolved EVE service module name to its facility activity. */
export function facilityServiceFromName(name: string): FacilityService | null {
  return facilityServiceByName[name.trim().toLocaleLowerCase("en-US")] ?? null;
}
