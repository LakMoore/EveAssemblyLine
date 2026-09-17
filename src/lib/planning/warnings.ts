/** Stable codes for planner warnings returned by the plan API. */
export const planWarningCodes = [
  "manufacturing-blueprint-me-zero",
  "manufacturing-bpc-runs-insufficient",
] as const;

/** A stable code identifying a planning warning. */
export type PlanWarningCode = (typeof planWarningCodes)[number];

/** Presentation content for a planning warning code. */
export type PlanWarningPresentation = {
  title: string;
  detail: string;
};

/** Maps stable planner warning codes to the client-side content shown to users. */
export const planWarningPresentation: Record<PlanWarningCode, PlanWarningPresentation> = {
  "manufacturing-blueprint-me-zero": {
    title: "No usable blueprint",
    detail:
      "This product uses the configured fallback ME because no usable blueprint or BPC is available.",
  },
  "manufacturing-bpc-runs-insufficient": {
    title: "Insufficient BPC runs",
    detail: "Acquire or copy additional BPC runs to cover this manufacturing requirement.",
  },
};
