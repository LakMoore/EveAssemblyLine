"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { SdeLanguage } from "@/lib/reference/languages";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "./ui/combobox";

const minimumQueryLength = 3;

type TypeSearchResult = {
  name: string;
  typeId: number;
  category?: "blueprint" | "bpo" | "bpc" | "reaction" | "item" | "reactionformula";
  assemblyLineGroup?: string;
  shipName?: string;
  fittingSource?: { id: string; scope: string; collectionId: string };
};

type TypeSearchProps = {
  language: SdeLanguage;
  onSelect: (item: TypeSearchResult) => void;
  placeholder: string;
  ariaLabel: string;
  inputId?: string;
  searchEndpoint?: string;
  disabled?: boolean;
  additionalSearch?: (query: string, language: SdeLanguage) => Promise<TypeSearchResult[]>;
};

function resultVariation(category?: string) {
  if (category === "blueprint") return "bp" as const;
  if (category === "reactionformula") return "bpc" as const;
  return "icon" as const;
}

export default function TypeSearch({
  language,
  onSelect,
  placeholder,
  ariaLabel,
  inputId,
  searchEndpoint = "/api/reference/types",
  disabled = false,
  additionalSearch,
}: TypeSearchProps) {
  const anchor = useComboboxAnchor();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TypeSearchResult[]>([]);
  const [searchError, setSearchError] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    if (!additionalSearch) return;
    const clearPrivateResults = () => {
      requestId.current += 1;
      setQuery("");
      setResults([]);
      setSearchError("");
      setIsOpen(false);
    };
    window.addEventListener("assembly-line-auth-changed", clearPrivateResults);
    return () => {
      window.removeEventListener("assembly-line-auth-changed", clearPrivateResults);
    };
  }, [additionalSearch]);

  useEffect(() => {
    const trimmedQuery = query.trim();
    const currentRequestId = ++requestId.current;
    if (disabled || trimmedQuery.length < minimumQueryLength) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => {
        setResults([]);
        setSearchError("");
        const typeSearch = fetch(
          `${searchEndpoint}?query=${encodeURIComponent(trimmedQuery)}&language=${language}`,
          { signal: controller.signal },
        ).then(async (response) => {
          const data = (await response.json()) as {
            error?: string;
            items?: TypeSearchResult[];
          };
          if (!response.ok) throw new Error(data.error ?? "Search data is unavailable.");
          return data.items ?? [];
        });
        const searches = [
          { label: "Type search", request: typeSearch },
          ...(additionalSearch
            ? [{ label: "Fitting search", request: additionalSearch(trimmedQuery, language) }]
            : []),
        ];
        for (const search of searches) {
          void search.request
            .then((sourceResults) => {
              if (currentRequestId !== requestId.current || controller.signal.aborted) return;
              setResults((current) => {
                const merged = [...current, ...sourceResults];
                return [
                  ...merged.filter((item) => !item.fittingSource),
                  ...merged.filter((item) => item.fittingSource),
                ];
              });
              setIsOpen(true);
            })
            .catch((error: unknown) => {
              if (currentRequestId !== requestId.current || controller.signal.aborted) return;
              const message = `${search.label}: ${error instanceof Error ? error.message : "Search data is unavailable."}`;
              setSearchError((current) => (current ? `${current} ${message}` : message));
              setIsOpen(true);
            });
        }
      },
      180,
    );
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [additionalSearch, disabled, language, query, searchEndpoint]);

  function choose(item: TypeSearchResult) {
    onSelect(item);
    setQuery("");
    setResults([]);
    setSearchError("");
    setIsOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") setIsOpen(false);
  }

  return (
    <div ref={anchor} className="w-full">
      <Combobox
        disabled={disabled}
        items={results}
        open={isOpen && query.trim().length >= minimumQueryLength}
        itemToStringLabel={(item: TypeSearchResult) => item.name}
        filter={null}
        inputValue={query}
        onOpenChange={setIsOpen}
        onInputValueChange={(value, eventDetails) => {
          if (eventDetails.reason !== "input-change") {
            setQuery("");
            setResults([]);
            setSearchError("");
            setIsOpen(false);
            return;
          }
          const hasSearchQuery = value.trim().length >= minimumQueryLength;
          setQuery(value);
          setIsOpen(hasSearchQuery);
          if (!hasSearchQuery) {
            setResults([]);
            setSearchError("");
          }
        }}
        onValueChange={(value) => {
          if (value) choose(value);
        }}
      >
        <ComboboxInput
          id={inputId}
          className="w-full"
          disabled={disabled}
          showTrigger={false}
          onFocus={() => {
            if (results.length > 0 && query.trim().length >= minimumQueryLength) {
              setIsOpen(true);
            }
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
        />
        <ComboboxContent anchor={anchor}>
          {searchError && results.length > 0 && (
            <Alert variant="destructive">
              <AlertDescription>{searchError}</AlertDescription>
            </Alert>
          )}
          <ComboboxEmpty>{searchError || "No matching published items."}</ComboboxEmpty>
          <ComboboxList>
            {[
              { label: "Types", items: results.filter((item) => !item.fittingSource) },
              { label: "Fittings", items: results.filter((item) => item.fittingSource) },
            ]
              .filter((group) => group.items.length > 0)
              .map((group) => (
                <ComboboxGroup key={group.label}>
                  {additionalSearch && <ComboboxLabel>{group.label}</ComboboxLabel>}
                  {group.items.map((item) => (
                    <ComboboxItem
                      key={item.fittingSource ? `fitting:${item.fittingSource.id}` : item.typeId}
                      value={item}
                    >
                      <TypeIdentity
                        name={item.name}
                        typeId={item.typeId}
                        typeName={item.shipName}
                        linkPath={item.fittingSource ? null : undefined}
                        variation={resultVariation(item.category)}
                      />
                    </ComboboxItem>
                  ))}
                </ComboboxGroup>
              ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}

export type { TypeSearchResult };
