import type { SimulationContext } from "./context";
import type {
  IndustrySimulationResult,
  SimulationBlueprintPurchase,
  SimulationUnmetDemand,
} from "./industrySimulation";
import type { SimulationTransaction } from "./ledger";
import type { SimulationPurchase, SimulationWarning, SimulatorRequestV1 } from "./types";

/** Final purchase aggregation and blocked-policy diagnostics. */
export interface BuyingSettlementResult {
  materials: SimulationPurchase[];
  blueprints: SimulationPurchase[];
  transactions: SimulationTransaction[];
  warnings: SimulationWarning[];
}

function typeName(context: SimulationContext, typeId: number, language = "en"): string {
  const name = context.types.get(typeId)?.name;
  return name?.[language as keyof typeof name] ?? name?.en ?? `Type ${typeId}`;
}

function unitVolume(context: SimulationContext, typeId: number): number {
  const type = context.types.get(typeId);
  return type?.packagedVolume ?? type?.volume ?? 0;
}

function aggregateMaterialPurchases(
  request: SimulatorRequestV1,
  context: SimulationContext,
  demands: readonly SimulationUnmetDemand[],
): SimulationPurchase[] {
  const purchases = new Map<number, SimulationPurchase>();
  for (const demand of demands.filter((candidate) => !candidate.blockedByBuyBlacklist)) {
    const existing = purchases.get(demand.account.typeId) ?? {
      typeId: demand.account.typeId,
      typeName: typeName(context, demand.account.typeId, request.language),
      unitVolume: unitVolume(context, demand.account.typeId),
      quantity: 0,
      destinations: [],
    };
    existing.quantity += demand.quantity;
    existing.destinations.push({
      stockpileId: demand.account.stockpileId,
      locationId: demand.account.locationId,
      quantity: demand.quantity,
      demandingJobId: demand.source.demandingJobId,
      purpose: demand.purpose,
    });
    purchases.set(demand.account.typeId, existing);
  }
  return [...purchases.values()].sort(
    (left, right) => left.typeName.localeCompare(right.typeName) || left.typeId - right.typeId,
  );
}

function aggregateBlueprintPurchases(
  request: SimulatorRequestV1,
  context: SimulationContext,
  purchasesToAggregate: readonly SimulationBlueprintPurchase[],
): SimulationPurchase[] {
  const purchases = new Map<number, SimulationPurchase>();
  for (const purchase of purchasesToAggregate) {
    const existing = purchases.get(purchase.typeId) ?? {
      typeId: purchase.typeId,
      typeName: typeName(context, purchase.typeId, request.language),
      unitVolume: unitVolume(context, purchase.typeId),
      quantity: 0,
      destinations: [],
    };
    existing.quantity += purchase.quantity;
    existing.destinations.push(purchase.destination);
    purchases.set(purchase.typeId, existing);
  }
  return [...purchases.values()].sort(
    (left, right) => left.typeName.localeCompare(right.typeName) || left.typeId - right.typeId,
  );
}

/** Creates the single locationless buying ledger after every other settlement phase. */
export function settleBuying(
  request: SimulatorRequestV1,
  context: SimulationContext,
  industry: IndustrySimulationResult,
  remainingDemands: readonly SimulationUnmetDemand[],
): BuyingSettlementResult {
  const materials = aggregateMaterialPurchases(request, context, remainingDemands);
  const blueprints = aggregateBlueprintPurchases(request, context, industry.blueprintPurchases);
  const transactions: SimulationTransaction[] = remainingDemands
    .filter((demand) => !demand.blockedByBuyBlacklist)
    .map((demand, index) => ({
      id: `purchase:${index}`,
      kind: "purchase-requirement" as const,
      account: demand.account,
      quantity: demand.quantity,
      demandingJobId: demand.source.demandingJobId,
    }));
  const warnings = remainingDemands
    .filter((demand) => demand.blockedByBuyBlacklist)
    .map(
      (demand): SimulationWarning => ({
        code: "blocked-by-policy",
        typeId: demand.account.typeId,
        locationId: demand.account.locationId,
        jobId: demand.source.demandingJobId,
        message: `${demand.quantity} units remain unsatisfied and are prohibited from purchase.`,
      }),
    );
  return { materials, blueprints, transactions, warnings };
}
