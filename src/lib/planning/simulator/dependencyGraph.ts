import type { BlueprintsRecord } from "@/lib/sde/generated";
import type { SimulationContext } from "./context";
import type { SimulationWarning, SimulationActivity } from "./types";

/** Semantic role represented by a dependency graph node. */
export type DependencyNodeKind =
  | "product"
  | "activity"
  | "production-blueprint"
  | "invention-output"
  | "invention-source"
  | "copying";

/** One uniquely identified node in the type-only dependency graph. */
export interface DependencyNode {
  id: string;
  kind: DependencyNodeKind;
  typeId: number;
  activity?: SimulationActivity;
  blueprintTypeId?: number;
  terminalReason?: "purchase" | "missing-blueprint" | "cycle" | "limit";
}

/** Directed relationship between two dependency graph nodes. */
export interface DependencyEdge {
  from: string;
  to: string;
  relation:
    | "produced-by"
    | "uses-blueprint"
    | "requires-material"
    | "invented-from"
    | "copied-from";
  quantity?: number;
}

/** Complete bounded graph and diagnostics produced by type discovery. */
export interface DependencyGraph {
  nodes: ReadonlyMap<string, DependencyNode>;
  edges: readonly DependencyEdge[];
  warnings: readonly SimulationWarning[];
  reachableTypeIds: ReadonlySet<number>;
}

/** Input policies controlling dependency graph discovery. */
export interface DependencyGraphOptions {
  buildBlacklist: ReadonlySet<number>;
  buyBlacklist: ReadonlySet<number>;
  maxNodes: number;
  maxDepth: number;
}

function nodeId(kind: DependencyNodeKind, typeId: number, qualifier?: number | string): string {
  return `${kind}:${typeId}${qualifier === undefined ? "" : `:${qualifier}`}`;
}

function activityForBlueprint(blueprint: BlueprintsRecord, activity: "manufacturing" | "reaction") {
  return activity === "manufacturing"
    ? blueprint.activities.manufacturing
    : blueprint.activities.reaction;
}

/** Builds the cycle-safe type graph used for bounded quantity expansion. */
export function buildDependencyGraph(
  rootTypeIds: readonly number[],
  context: Pick<SimulationContext, "blueprints">,
  options: DependencyGraphOptions,
): DependencyGraph {
  const nodes = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];
  const warnings: SimulationWarning[] = [];
  const reachableTypeIds = new Set<number>();
  const expandedTypeIds = new Set<number>();

  const addNode = (node: DependencyNode): boolean => {
    if (nodes.has(node.id)) return true;
    if (nodes.size >= options.maxNodes) return false;
    nodes.set(node.id, Object.freeze(node));
    return true;
  };
  const addEdge = (edge: DependencyEdge) => {
    if (
      !edges.some(
        (candidate) =>
          candidate.from === edge.from
          && candidate.to === edge.to
          && candidate.relation === edge.relation,
      )
    ) {
      edges.push(Object.freeze(edge));
    }
  };
  const stopForLimit = (typeId: number, productNodeId: string, message: string) => {
    const current = nodes.get(productNodeId);
    if (current) nodes.set(productNodeId, Object.freeze({ ...current, terminalReason: "limit" }));
    warnings.push({ code: "graph-limit-exceeded", typeId, message });
  };
  const setTerminalReason = (
    productNodeId: string,
    terminalReason: NonNullable<DependencyNode["terminalReason"]>,
  ) => {
    const current = nodes.get(productNodeId);
    if (current) nodes.set(productNodeId, Object.freeze({ ...current, terminalReason }));
  };

  const visitProduct = (typeId: number, depth: number, path: ReadonlySet<number>) => {
    reachableTypeIds.add(typeId);
    const productNodeId = nodeId("product", typeId);
    if (!addNode({ id: productNodeId, kind: "product", typeId })) {
      warnings.push({
        code: "graph-limit-exceeded",
        typeId,
        message: `Dependency graph exceeded ${options.maxNodes} nodes.`,
      });
      return;
    }
    if (path.has(typeId)) {
      setTerminalReason(productNodeId, "cycle");
      warnings.push({
        code: "cycle-detected",
        typeId,
        message: `Production dependency cycle detected at type ${typeId}.`,
      });
      return;
    }
    if (depth > options.maxDepth) {
      stopForLimit(
        typeId,
        productNodeId,
        `Dependency graph exceeded depth ${options.maxDepth} at type ${typeId}.`,
      );
      return;
    }
    if (expandedTypeIds.has(typeId)) return;
    if (options.buildBlacklist.has(typeId)) {
      setTerminalReason(productNodeId, "purchase");
      expandedTypeIds.add(typeId);
      return;
    }
    const production = context.blueprints.byBuildProductTypeId.get(typeId);
    if (!production) {
      setTerminalReason(productNodeId, "missing-blueprint");
      if (options.buyBlacklist.has(typeId)) {
        warnings.push({
          code: "missing-blueprint",
          typeId,
          message: `Type ${typeId} is buy-blacklisted but has no production blueprint.`,
        });
      }
      expandedTypeIds.add(typeId);
      return;
    }

    const activityNodeId = nodeId("activity", typeId, production.activity);
    const blueprintNodeId = nodeId("production-blueprint", production.blueprint._key);
    if (
      !addNode({
        id: activityNodeId,
        kind: "activity",
        typeId,
        activity: production.activity,
        blueprintTypeId: production.blueprint._key,
      })
      || !addNode({
        id: blueprintNodeId,
        kind: "production-blueprint",
        typeId: production.blueprint._key,
        blueprintTypeId: production.blueprint._key,
      })
    ) {
      stopForLimit(typeId, productNodeId, `Dependency graph exceeded ${options.maxNodes} nodes.`);
      return;
    }
    addEdge({ from: productNodeId, to: activityNodeId, relation: "produced-by" });
    addEdge({ from: activityNodeId, to: blueprintNodeId, relation: "uses-blueprint" });

    const nextPath = new Set(path);
    nextPath.add(typeId);
    for (const material of activityForBlueprint(production.blueprint, production.activity)
      ?.materials ?? []) {
      const materialNodeId = nodeId("product", material.typeID);
      if (!addNode({ id: materialNodeId, kind: "product", typeId: material.typeID })) {
        stopForLimit(typeId, productNodeId, `Dependency graph exceeded ${options.maxNodes} nodes.`);
        return;
      }
      addEdge({
        from: activityNodeId,
        to: materialNodeId,
        relation: "requires-material",
        quantity: material.quantity,
      });
      visitProduct(material.typeID, depth + 1, nextPath);
    }

    if (production.activity === "manufacturing") {
      for (const sourceBlueprint of context.blueprints.byInventionProductId.get(
        production.blueprint._key,
      ) ?? []) {
        const inventionNodeId = nodeId(
          "invention-output",
          production.blueprint._key,
          sourceBlueprint._key,
        );
        const sourceNodeId = nodeId("invention-source", sourceBlueprint._key);
        const copyingNodeId = nodeId("copying", sourceBlueprint._key);
        if (
          !addNode({
            id: inventionNodeId,
            kind: "invention-output",
            typeId: production.blueprint._key,
            activity: "invention",
            blueprintTypeId: sourceBlueprint._key,
          })
          || !addNode({
            id: sourceNodeId,
            kind: "invention-source",
            typeId: sourceBlueprint._key,
            blueprintTypeId: sourceBlueprint._key,
          })
          || !addNode({
            id: copyingNodeId,
            kind: "copying",
            typeId: sourceBlueprint._key,
            activity: "copying",
            blueprintTypeId: sourceBlueprint._key,
          })
        ) {
          stopForLimit(
            typeId,
            productNodeId,
            `Dependency graph exceeded ${options.maxNodes} nodes.`,
          );
          return;
        }
        addEdge({ from: blueprintNodeId, to: inventionNodeId, relation: "invented-from" });
        addEdge({ from: inventionNodeId, to: sourceNodeId, relation: "invented-from" });
        addEdge({ from: sourceNodeId, to: copyingNodeId, relation: "copied-from" });
        for (const material of sourceBlueprint.activities.invention?.materials ?? []) {
          const materialNodeId = nodeId("product", material.typeID);
          if (!addNode({ id: materialNodeId, kind: "product", typeId: material.typeID })) {
            stopForLimit(
              typeId,
              productNodeId,
              `Dependency graph exceeded ${options.maxNodes} nodes.`,
            );
            return;
          }
          addEdge({
            from: inventionNodeId,
            to: materialNodeId,
            relation: "requires-material",
            quantity: material.quantity,
          });
          visitProduct(material.typeID, depth + 1, nextPath);
        }
      }
    }
    expandedTypeIds.add(typeId);
  };

  for (const typeId of [...new Set(rootTypeIds)].sort((left, right) => left - right)) {
    visitProduct(typeId, 0, new Set());
  }
  return Object.freeze({
    nodes,
    edges: Object.freeze(edges),
    warnings: Object.freeze(warnings),
    reachableTypeIds,
  });
}
