"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { SdeLanguage } from "@/lib/reference/languages";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
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
};

type TypeSearchProps = {
  language: SdeLanguage;
  onSelect: (item: TypeSearchResult) => void;
  placeholder: string;
  ariaLabel: string;
  inputId?: string;
  searchEndpoint?: string;
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
}: TypeSearchProps) {
  const anchor = useComboboxAnchor();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TypeSearchResult[]>([]);
  const [searchError, setSearchError] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const trimmedQuery = query.trim();
    const currentRequestId = ++requestId.current;
    if (trimmedQuery.length < minimumQueryLength) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      async () => {
        try {
          const response = await fetch(
            `${searchEndpoint}?query=${encodeURIComponent(trimmedQuery)}&language=${language}`,
            { signal: controller.signal },
          );
          const data = (await response.json()) as { error?: string; items?: TypeSearchResult[] };
          if (!response.ok) throw new Error(data.error ?? "Search data is unavailable.");
          if (currentRequestId === requestId.current) {
            setResults(data.items ?? []);
            setSearchError("");
            setIsOpen(true);
          }
        }
        catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (currentRequestId !== requestId.current) return;
          setResults([]);
          setSearchError(error instanceof Error ? error.message : "Search data is unavailable.");
          setIsOpen(true);
        }
      },
      180,
    );
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [language, query, searchEndpoint]);

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
          showTrigger={false}
          onFocus={() =>
            results.length > 0 && query.trim().length >= minimumQueryLength && setIsOpen(true)
          }
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
        />
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>{searchError || "No matching published items."}</ComboboxEmpty>
          <ComboboxList>
            {results.map((item) => (
              <ComboboxItem key={item.typeId} value={item}>
                <TypeIdentity
                  name={item.name}
                  typeId={item.typeId}
                  variation={resultVariation(item.category)}
                />
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}

export type { TypeSearchResult };
