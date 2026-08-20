"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { SdeLanguage } from "@/lib/reference/languages";
import TypeIdentity from "@/app/components/TypeIdentity";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "./ui/combobox";
import styles from "./TypeSearch.module.css";

type TypeSearchResult = {
  name: string;
  typeId: number;
  category?: "blueprint" | "bpo" | "bpc" | "reaction" | "item" | "reactionformula";
  marketCategory?: string;
};

type TypeSearchProps = {
  language: SdeLanguage;
  onSelect: (item: TypeSearchResult) => void;
  placeholder: string;
  ariaLabel: string;
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
}: TypeSearchProps) {
  const anchor = useComboboxAnchor();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TypeSearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 2) return;
    const currentRequestId = ++requestId.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      async () => {
        try {
          const response = await fetch(
            `/api/reference/types?query=${encodeURIComponent(trimmedQuery)}&language=${language}`,
            { signal: controller.signal },
          );
          const data = (await response.json()) as { items?: TypeSearchResult[] };
          if (currentRequestId === requestId.current) {
            setResults(data.items ?? []);
            setIsOpen(true);
          }
        }
        catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setResults([]);
        }
      },
      180,
    );
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [language, query]);

  function choose(item: TypeSearchResult) {
    onSelect(item);
    setQuery("");
    setResults([]);
    setIsOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") setIsOpen(false);
  }

  return (
    <div ref={anchor} className={styles.search}>
      <Combobox
        open={isOpen && query.trim().length >= 2}
        inputValue={query}
        onOpenChange={setIsOpen}
        onInputValueChange={(value) => {
          setQuery(value);
          setIsOpen(true);
        }}
        onValueChange={(value) => {
          const item = results.find((result) => String(result.typeId) === String(value));
          if (item) choose(item);
        }}
      >
        <ComboboxInput
          className={styles.searchInput}
          showTrigger={false}
          onFocus={() => results.length > 0 && setIsOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
        />
        <ComboboxContent anchor={anchor} className={styles.searchResults}>
          <ComboboxList>
            {results.length ? (
              results.map((item) => (
                <ComboboxItem
                  key={item.typeId}
                  value={String(item.typeId)}
                  className={styles.searchResult}
                >
                  <TypeIdentity
                    name={item.name}
                    typeId={item.typeId}
                    variation={resultVariation(item.category)}
                  />
                </ComboboxItem>
              ))
            ) : (
              <ComboboxEmpty className={styles.noResults}>
                No matching published items.
              </ComboboxEmpty>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}

export type { TypeSearchResult };
