"use client";

import { startTransition, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownUp,
  ArrowRight,
  ArrowUp,
  FlaskConical,
  Search,
} from "lucide-react";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import TypeSearch, { type TypeSearchResult } from "@/components/TypeSearch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { inventionSkillsByTypeId } from "@/lib/invention/skills";
import {
  isCompleteClientOwnerSnapshotResponse,
  loadOwnerSnapshot,
  mergeOwnerSnapshot,
  saveOwnerSnapshot,
} from "@/lib/client/ownerSnapshotCache";
import {
  loadClientSession,
  refreshClientSession,
  type ClientSession,
} from "@/lib/client/requestCache";
import { Label } from "@/components/ui/label";
import { useAppLanguage } from "../AppShell";

type InventionOutcome = {
  productTypeId: number;
  probability: number;
  baseProbability: number;
  runs: number;
  materialEfficiency: number;
  timeEfficiency: number;
};

type RequiredInventionSkill = {
  typeId: number;
  name: string;
  role: "science" | "encryption";
  requiredLevel: number;
  level: number;
};

type InventionDecryptor = {
  typeId: number;
  name: string;
  probabilityMultiplier: number;
  materialEfficiencyModifier: number;
  timeEfficiencyModifier: number;
  maxRunModifier: number;
};

type InventionResponse = {
  product: { typeId: number; name: string };
  sources: Array<{ typeId: number; name: string; outcome: InventionOutcome }>;
  requiredSkills: RequiredInventionSkill[];
  decryptors: InventionDecryptor[];
  error?: string;
};

type InventionRow = {
  typeId?: number;
  sourceTypeId?: number;
  sourceName?: string;
  name: string;
  probability: number;
  runs: number;
  materialEfficiency: number;
  timeEfficiency: number;
  expectedRuns: number;
};

type InventionSortKey = keyof Pick<
  InventionRow,
  | "name"
  | "sourceName"
  | "probability"
  | "runs"
  | "materialEfficiency"
  | "timeEfficiency"
  | "expectedRuns"
>;

type InventionSortDirection = "ascending" | "descending";

const inventionSortColumns: Array<{
  key: Exclude<InventionSortKey, "name">;
  label: string;
  abbreviationTitle?: string;
}> = [
  { key: "probability", label: "Probability" },
  { key: "runs", label: "Runs" },
  { key: "materialEfficiency", label: "ME", abbreviationTitle: "Material efficiency" },
  { key: "timeEfficiency", label: "TE", abbreviationTitle: "Time efficiency" },
  { key: "expectedRuns", label: "Expected runs" },
];

/** Calculates an invention outcome with the supplied decryptor modifiers. */
function inventionRow(
  outcome: InventionOutcome,
  decryptor?: InventionDecryptor,
  sourceName?: string,
  sourceTypeId?: number,
): InventionRow {
  const probability = outcome.probability * (decryptor?.probabilityMultiplier ?? 1);
  const runs = Math.max(1, outcome.runs + (decryptor?.maxRunModifier ?? 0));
  return {
    typeId: decryptor?.typeId,
    sourceTypeId,
    sourceName,
    name: decryptor?.name ?? "No decryptor",
    probability,
    runs,
    materialEfficiency: outcome.materialEfficiency + (decryptor?.materialEfficiencyModifier ?? 0),
    timeEfficiency: outcome.timeEfficiency + (decryptor?.timeEfficiencyModifier ?? 0),
    expectedRuns: probability * runs,
  };
}

/** Formats a fractional invention probability as a percentage. */
function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

/** Sorts invention outcomes by a table column. Decryptor names always keep no decryptor first. */
function sortInventionRows(
  rows: InventionRow[],
  sortKey: InventionSortKey,
  sortDirection: InventionSortDirection,
) {
  return [...rows].sort((left, right) => {
    if (sortKey === "name") {
      if (left.typeId === undefined && right.typeId === undefined) {
        return (left.sourceName ?? "").localeCompare(right.sourceName ?? "");
      }
      if (left.typeId === undefined) return -1;
      if (right.typeId === undefined) return 1;
      return (
        left.name.localeCompare(right.name)
        || (left.sourceName ?? "").localeCompare(right.sourceName ?? "")
      );
    }
    if (sortKey === "sourceName") {
      const comparison = (left.sourceName ?? "").localeCompare(right.sourceName ?? "");
      return sortDirection === "ascending" ? comparison : -comparison;
    }
    const comparison = left[sortKey] - right[sortKey];
    if (comparison !== 0) return sortDirection === "ascending" ? comparison : -comparison;
    return left.name.localeCompare(right.name);
  });
}

/** Renders the sort indicator for a table column. */
function SortIndicator({
  active,
  direction,
}: {
  active: boolean;
  direction: InventionSortDirection;
}) {
  if (!active) return <ArrowDownUp aria-hidden="true" />;
  return direction === "ascending" ? (
    <ArrowUp aria-hidden="true" />
  ) : (
    <ArrowDown aria-hidden="true" />
  );
}

/** Renders the SDE-backed decryptor comparison workspace. */
export default function InventionPage() {
  const { language } = useAppLanguage();
  const [selectedType, setSelectedType] = useState<TypeSearchResult | null>(null);
  const [skillProfile, setSkillProfile] = useState("all-i");
  const [session, setSession] = useState<ClientSession | null>(null);
  const [result, setResult] = useState<InventionResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [sortKey, setSortKey] = useState<InventionSortKey>("expectedRuns");
  const [sortDirection, setSortDirection] = useState<InventionSortDirection>("descending");
  const requestId = useRef(0);
  const selectedCharacter = (session?.characters ?? []).find(
    (character) => `character:${character.characterId}` === skillProfile,
  );
  const characterProfileSelected = skillProfile.startsWith("character:");
  const characterSkillsUnavailable =
    characterProfileSelected && selectedCharacter?.skills?.hasBody !== true;
  const skillProfileLabel =
    skillProfile === "all-i"
      ? "All I"
      : skillProfile === "all-iv"
        ? "All IV"
        : skillProfile === "all-v"
          ? "All V"
          : (selectedCharacter?.characterName ?? "Character skills");
  const allSkillLevel =
    skillProfile === "all-i"
      ? 1
      : skillProfile === "all-iv"
        ? 4
        : skillProfile === "all-v"
          ? 5
          : undefined;
  const selectedSkillLevels = Object.fromEntries(
    (selectedCharacter?.skills?.body ?? [])
      .filter((skill) => inventionSkillsByTypeId.has(skill.skillId))
      .map((skill) => [String(skill.skillId), skill.activeSkillLevel]),
  );
  const serializedSkillLevels = JSON.stringify(selectedSkillLevels);

  useEffect(() => {
    void loadClientSession()
      .then(setSession)
      .catch(() => setSession(null));
  }, []);

  useEffect(() => {
    if (!selectedCharacter || !characterSkillsUnavailable) return;
    let cancelled = false;
    void fetch(
      `/api/state/refresh/character/${selectedCharacter.characterId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eTags: {} }),
      },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not refresh this character's ESI skills.");
        const data = (await response.json()) as { ownerSnapshot?: unknown };
        const snapshotScope = session?.snapshotScope;
        if (!data.ownerSnapshot || !snapshotScope) {
          throw new Error("Refresh did not return the required owner snapshot.");
        }
        if (!isCompleteClientOwnerSnapshotResponse(data.ownerSnapshot)) {
          throw new Error("Refresh returned an invalid owner snapshot.");
        }
        const owner = { kind: "character" as const, id: selectedCharacter.characterId };
        if (
          data.ownerSnapshot.owner.kind !== owner.kind
          || data.ownerSnapshot.owner.id !== owner.id
        ) {
          throw new Error("Refresh returned an owner snapshot for the wrong owner.");
        }
        const cachedSnapshot = await loadOwnerSnapshot(owner, snapshotScope);
        await saveOwnerSnapshot(
          mergeOwnerSnapshot(cachedSnapshot?.snapshot ?? null, data.ownerSnapshot),
          snapshotScope,
        );
        return refreshClientSession();
      })
      .then((refreshedSession) => {
        if (!cancelled) setSession(refreshedSession);
      })
      .catch((refreshError: unknown) => {
        if (cancelled) return;
        setError(
          refreshError instanceof Error
            ? refreshError.message
            : "Could not refresh this character's ESI skills.",
        );
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [characterSkillsUnavailable, selectedCharacter, session?.snapshotScope]);

  useEffect(() => {
    const currentRequestId = ++requestId.current;
    if (!selectedType || characterSkillsUnavailable) return;
    const controller = new AbortController();
    void fetch(
      `/api/invention?productTypeId=${selectedType.typeId}&language=${language}&skillLevels=${encodeURIComponent(serializedSkillLevels)}${allSkillLevel ? `&allSkillLevel=${allSkillLevel}` : ""}`,
      {
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const payload = (await response.json()) as InventionResponse;
        if (!response.ok) throw new Error(payload.error ?? "Could not load invention data.");
        if (currentRequestId === requestId.current) {
          startTransition(() => setResult(payload));
        }
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        if (currentRequestId !== requestId.current) return;
        setResult(null);
        setError(
          fetchError instanceof Error ? fetchError.message : "Could not load invention data.",
        );
      })
      .finally(() => {
        if (currentRequestId === requestId.current) setIsLoading(false);
      });
    return () => controller.abort();
  }, [allSkillLevel, characterSkillsUnavailable, language, selectedType, serializedSkillLevels]);

  function selectType(type: TypeSearchResult) {
    setResult(null);
    setError("");
    setIsLoading(true);
    setSelectedType(type);
  }

  function clearSelection() {
    setSelectedType(null);
    setResult(null);
    setError("");
    setIsLoading(false);
  }

  function selectSkillProfile(profile: string | null) {
    if (!profile) return;
    setSkillProfile(profile);
    if (selectedType) {
      setResult(null);
      setError("");
      setIsLoading(true);
    }
  }

  const insufficientSkills = characterProfileSelected
    ? (result?.requiredSkills ?? []).filter((skill) => skill.level < skill.requiredLevel)
    : [];

  function selectSort(sortColumn: InventionSortKey) {
    if (sortColumn === "name") {
      setSortKey(sortColumn);
      setSortDirection("ascending");
      return;
    }
    if (sortColumn === sortKey) {
      setSortDirection((currentDirection) =>
        currentDirection === "ascending" ? "descending" : "ascending",
      );
      return;
    }
    setSortKey(sortColumn);
    setSortDirection("descending");
  }

  const rows = result
    ? result.sources.flatMap((source) => [
        inventionRow(source.outcome, undefined, source.name, source.typeId),
        ...result.decryptors.map((decryptor) =>
          inventionRow(source.outcome, decryptor, source.name, source.typeId),
        ),
      ])
    : [];
  const sortedRows = sortInventionRows(rows, sortKey, sortDirection);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-2 border-b pb-6">
        <div className="flex items-center gap-2 text-muted-foreground">
          <FlaskConical aria-hidden="true" />
          <span className="text-xs font-medium uppercase">Industry / Research</span>
        </div>
        <h1 className="font-heading text-3xl font-semibold">Invention</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Compare no-decryptor and decryptor outcomes for an invented blueprint.
        </p>
      </header>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.4fr)_auto] lg:items-end">
        <div className="flex flex-col gap-2">
          <Label htmlFor="invention-product">Invented BPC</Label>
          <TypeSearch
            inputId="invention-product"
            language={language}
            onSelect={selectType}
            placeholder="Search an inventable blueprint"
            ariaLabel="Search an inventable blueprint"
            searchEndpoint="/api/reference/invention"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="invention-skill-profile">Installing character skills</Label>
          <Select value={skillProfile} onValueChange={selectSkillProfile}>
            <SelectTrigger
              id="invention-skill-profile"
              className="w-full"
              aria-label="Installing character skills"
            >
              <SelectValue>{skillProfileLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Training profile</SelectLabel>
                <SelectItem value="all-i">All I</SelectItem>
                <SelectItem value="all-iv">All IV</SelectItem>
                <SelectItem value="all-v">All V</SelectItem>
              </SelectGroup>
              {(session?.authenticated ?? false) && (session?.characters?.length ?? 0) > 0 && (
                <SelectGroup>
                  <SelectLabel>Your characters</SelectLabel>
                  {session?.characters?.map((character) => (
                    <SelectItem
                      key={character.characterId}
                      value={`character:${character.characterId}`}
                    >
                      {character.characterName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
        </div>
        {selectedType && (
          <Button variant="outline" onClick={clearSelection}>
            Clear selection
          </Button>
        )}
      </section>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Invention data unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {isLoading && (
        <div role="status" aria-live="polite">
          <Skeleton className="h-80 w-full" />
          <span className="sr-only">
            {characterSkillsUnavailable
              ? "Refreshing character skills."
              : "Calculating invention outcomes."}
          </span>
        </div>
      )}

      {characterSkillsUnavailable && !error && (
        <Alert>
          <AlertTitle>Refreshing character skills</AlertTitle>
          <AlertDescription>Calculating with the latest ESI skill levels.</AlertDescription>
        </Alert>
      )}

      {result && insufficientSkills.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Insufficient invention skills</AlertTitle>
          <AlertDescription>
            {insufficientSkills
              .map((skill) => `${skill.name} ${skill.level}/${skill.requiredLevel}`)
              .join(", ")}
          </AlertDescription>
        </Alert>
      )}

      {!isLoading && !result && !error && (
        <Empty>
          <EmptyHeader>
            <Search aria-hidden="true" />
            <EmptyTitle>Select an invented BPC</EmptyTitle>
            <EmptyDescription>
              Search by name or type ID to compare decryptor outcomes.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {!isLoading && result && (
        <section className="flex flex-col gap-6">
          <div className="flex flex-col items-start gap-3 border-b pb-4 md:flex-row md:items-center">
            {result.sources.length === 1 && (
              <>
                <TypeIdentity
                  typeId={result.sources[0].typeId}
                  name={result.sources[0].name}
                  variation="bpc"
                  imageSize={40}
                />
                <ArrowRight
                  className="ml-3 rotate-90 text-muted-foreground md:ml-0 md:rotate-0"
                  aria-hidden="true"
                />
              </>
            )}
            <TypeIdentity
              typeId={result.product.typeId}
              name={result.product.name}
              variation="bpc"
              imageSize={40}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {result.requiredSkills.map((skill) => (
              <Badge key={skill.typeId} variant={skill.level === 0 ? "destructive" : "outline"}>
                {skill.name} {skill.level}
              </Badge>
            ))}
          </div>
          <div
            className="max-h-[calc(100vh-12rem)] overflow-auto border lg:max-h-none lg:overflow-visible"
            role="region"
            aria-label="Scrollable invention decryptor outcome comparison"
            tabIndex={0}
          >
            <table className="w-full min-w-225 table-fixed text-left text-sm lg:min-w-0">
              <colgroup>
                {result.sources.length > 1 ? (
                  <>
                    <col className="w-[24%]" />
                    <col className="w-[24%]" />
                    <col className="w-[10%]" />
                    <col className="w-24" />
                    <col className="w-22" />
                    <col className="w-22" />
                    <col className="w-30" />
                  </>
                ) : (
                  <>
                    <col className="w-[35%]" />
                    <col className="w-[14%]" />
                    <col className="w-24" />
                    <col className="w-22" />
                    <col className="w-22" />
                    <col className="w-30" />
                  </>
                )}
              </colgroup>
              <caption className="sr-only">Invention decryptor outcome comparison</caption>
              <thead className="sticky -top-px z-2 border-b bg-background text-xs text-muted-foreground lg:top-0">
                <tr>
                  <th
                    className="px-2 py-3 font-medium lg:px-4"
                    {...(sortKey === "name" ? { "aria-sort": "ascending" as const } : {})}
                  >
                    <Button
                      variant="ghost"
                      size="xs"
                      className="w-full min-w-0 flex-wrap justify-start whitespace-normal"
                      aria-label="Sort by Decryptor, no decryptor first then alphabetically"
                      onClick={() => selectSort("name")}
                    >
                      Decryptor <SortIndicator active={sortKey === "name"} direction="ascending" />
                    </Button>
                  </th>
                  {result.sources.length > 1 && (
                    <th
                      className="px-2 py-3 font-medium lg:px-4"
                      {...(sortKey === "sourceName" ? { "aria-sort": sortDirection } : {})}
                    >
                      <Button
                        variant="ghost"
                        size="xs"
                        className="w-full min-w-0 flex-wrap justify-start whitespace-normal"
                        aria-label={`Sort by Relic alphabetically${sortKey === "sourceName" ? `, currently ${sortDirection}` : ""}`}
                        onClick={() => selectSort("sourceName")}
                      >
                        Relic{" "}
                        <SortIndicator
                          active={sortKey === "sourceName"}
                          direction={sortDirection}
                        />
                      </Button>
                    </th>
                  )}
                  {inventionSortColumns.map(({ key, label, abbreviationTitle }) => {
                    const active = sortKey === key;
                    return (
                      <th
                        key={key}
                        className="px-2 py-3 text-right font-medium lg:px-4"
                        {...(active ? { "aria-sort": sortDirection } : {})}
                      >
                        <Button
                          variant="ghost"
                          size="xs"
                          className="w-full min-w-0 flex-wrap justify-end whitespace-normal"
                          aria-label={`Sort by ${abbreviationTitle ?? label}${active ? `, currently ${sortDirection}` : ""}`}
                          onClick={() => selectSort(key)}
                        >
                          {abbreviationTitle ? (
                            <abbr title={abbreviationTitle}>{label}</abbr>
                          ) : (
                            label
                          )}
                          <SortIndicator active={active} direction={sortDirection} />
                        </Button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => (
                  <tr
                    key={`${row.sourceTypeId ?? "source"}:${row.typeId ?? "none"}`}
                    className="border-b last:border-0"
                  >
                    <td className="px-2 py-3 font-medium wrap-break-word lg:px-4">
                      <div className="flex items-center gap-2">{row.name}</div>
                    </td>
                    {result.sources.length > 1 && (
                      <td className="px-2 py-3 wrap-break-word lg:px-4">{row.sourceName}</td>
                    )}
                    <td className="px-2 py-3 text-right font-mono lg:px-4">
                      {percent(row.probability)}
                    </td>
                    <td className="px-2 py-3 text-right font-mono lg:px-4">{row.runs}</td>
                    <td className="px-2 py-3 text-right font-mono lg:px-4">
                      {row.materialEfficiency}
                    </td>
                    <td className="px-2 py-3 text-right font-mono lg:px-4">{row.timeEfficiency}</td>
                    <td className="px-2 py-3 text-right font-mono lg:px-4">
                      {row.expectedRuns.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
