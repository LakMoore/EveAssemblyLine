"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import type { SdeLanguage } from "@/lib/reference/languages";

/** One station or cached structure returned by the partial-name search endpoint. */
export type StationSearchResult = {
  stationId: number;
  name: string;
  systemName: string;
  kind: "station" | "structure";
};

type StationSearchProps = {
  language: SdeLanguage;
  excludedStationIds: number[];
  onError: (message: string) => void;
  onSelect: (station: StationSearchResult) => void;
};

/** Searches market stations and cached asset structures after a short typing debounce. */
export default function StationSearch({
  language,
  excludedStationIds,
  onError,
  onSelect,
}: StationSearchProps) {
  const anchor = useComboboxAnchor();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StationSearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const requestId = useRef(0);
  const excludedStationIdsKey = excludedStationIds.join(",");

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 2) return;
    const currentRequestId = ++requestId.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      async () => {
        setIsSearching(true);
        try {
          const response = await fetch(
            `/api/reference/stations?query=${encodeURIComponent(trimmedQuery)}&language=${language}`,
            { signal: controller.signal },
          );
          const data = (await response.json()) as {
            items?: StationSearchResult[];
            error?: string;
          };
          if (!response.ok) throw new Error(data.error ?? "Could not search market locations.");
          if (currentRequestId !== requestId.current) return;
          const excludedIds = new Set(excludedStationIdsKey.split(",").filter(Boolean).map(Number));
          setResults((data.items ?? []).filter((station) => !excludedIds.has(station.stationId)));
          setIsOpen(true);
        }
        catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (currentRequestId !== requestId.current) return;
          setResults([]);
          onError(error instanceof Error ? error.message : "Could not search market locations.");
        }
        finally {
          if (currentRequestId === requestId.current) setIsSearching(false);
        }
      },
      300,
    );
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [excludedStationIdsKey, language, onError, query]);

  /** Adds the selected station and resets the search input. */
  function choose(station: StationSearchResult) {
    onSelect(station);
    setQuery("");
    setResults([]);
    setIsOpen(false);
  }

  /** Closes the result popup when Escape is pressed. */
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") setIsOpen(false);
  }

  return (
    <div ref={anchor} className="w-full">
      <Combobox
        items={results}
        open={isOpen && query.trim().length >= 2}
        itemToStringLabel={(station: StationSearchResult) => station.name}
        filter={null}
        inputValue={query}
        onOpenChange={setIsOpen}
        onInputValueChange={(value, eventDetails) => {
          if (eventDetails.reason !== "input-change") {
            setQuery("");
            setResults([]);
            setIsOpen(false);
            return;
          }
          const hasSearchQuery = value.trim().length >= 2;
          setQuery(value);
          setIsOpen(hasSearchQuery);
          if (!hasSearchQuery) {
            requestId.current += 1;
            setResults([]);
            setIsSearching(false);
          }
        }}
        onValueChange={(value) => {
          if (value) choose(value);
        }}
      >
        <ComboboxInput
          id="signals-station-search"
          className="w-full"
          showTrigger={false}
          onFocus={() => results.length > 0 && setIsOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search by station or structure name"
          aria-label="Search market locations"
        />
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>
            {isSearching ? "Searching market locations..." : "No matching market locations."}
          </ComboboxEmpty>
          <ComboboxList>
            {results.map((station) => (
              <ComboboxItem key={station.stationId} value={station}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{station.name}</span>
                  <span className="text-muted-foreground">
                    {station.systemName} - {station.kind === "structure" ? "Structure" : "Station"}
                    {" ID "}
                    {station.stationId}
                  </span>
                </span>
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
