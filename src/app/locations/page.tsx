"use client";

import { FormEvent, useEffect, useState } from "react";
import AppShell, { languageStorageKey } from "../AppShell";
import {
  defaultLocations,
  locationsStorageKey,
  type KnownStructure,
  type PlannerLocations,
} from "@/lib/planning/preferences";
import { isSdeLanguage, type SdeLanguage } from "@/lib/reference/languages";
import { fetchRigs } from "@/lib/reference/rigs";
import { loadStructures, saveStructures } from "@/lib/planning/structureStore";
import styles from "../page.module.css";

type StructureSize = "Small" | "Medium" | "Large" | "Extra Large";
type StructureType = { name: string; size: StructureSize };

const structureTypes: StructureType[] = [
  { name: "Athanor", size: "Medium" },
  { name: "Raitaru", size: "Medium" },
  { name: "Astrahus", size: "Medium" },
  { name: "Tatara", size: "Medium" },
  { name: "Sotiyo", size: "Large" },
  { name: "Azbel", size: "Large" },
  { name: "Fortizar", size: "Large" },
  { name: "Keepstar", size: "Extra Large" },
  { name: "'Draccous' Fortizar", size: "Large" },
  { name: "'Horizon' Fortizar", size: "Large" },
  { name: "'Marginis' Fortizar", size: "Large" },
  { name: "'Moreau' Fortizar", size: "Large" },
  { name: "'Prometheus' Fortizar", size: "Large" },
  { name: "Upwell Palatine Keepstar", size: "Extra Large" },
];
const fallbackRigOptionsBySize: Record<StructureSize, string[]> = {
  Small: [
    "No Rig",
    "Standup M-Set Basic Small Ship Manufacturing Material Efficiency I",
    "Standup M-Set Basic Small Ship Manufacturing Time Efficiency I",
    "Standup M-Set Basic Small Ship Manufacturing Material Efficiency II",
    "Standup M-Set Basic Small Ship Manufacturing Time Efficiency II",
    "Standup M-Set Advanced Small Ship Manufacturing Material Efficiency I",
    "Standup M-Set Advanced Small Ship Manufacturing Time Efficiency I",
    "Standup M-Set Advanced Small Ship Manufacturing Material Efficiency II",
    "Standup M-Set Advanced Small Ship Manufacturing Time Efficiency II",
    "Standup M-Set Small Ship Manufacturing Material Efficiency I",
    "Standup M-Set Small Ship Manufacturing Time Efficiency I",
  ],
  Medium: [
    "No Rig",
    "Standup M-Set Basic Medium Ship Manufacturing Material Efficiency I",
    "Standup M-Set Basic Medium Ship Manufacturing Material Efficiency II",
    "Standup M-Set Basic Medium Ship Manufacturing Time Efficiency I",
    "Standup M-Set Basic Medium Ship Manufacturing Time Efficiency II",
    "Standup M-Set Basic Small Ship Manufacturing Material Efficiency I",
    "Standup M-Set Basic Small Ship Manufacturing Material Efficiency II",
    "Standup M-Set Basic Small Ship Manufacturing Time Efficiency I",
    "Standup M-Set Basic Small Ship Manufacturing Time Efficiency II",
    "Standup M-Set Basic Large Ship Manufacturing Material Efficiency I",
    "Standup M-Set Basic Large Ship Manufacturing Material Efficiency II",
    "Standup M-Set Basic Large Ship Manufacturing Time Efficiency I",
    "Standup M-Set Basic Large Ship Manufacturing Time Efficiency II",
    "Standup M-Set Advanced Medium Ship Manufacturing Material Efficiency I",
    "Standup M-Set Advanced Medium Ship Manufacturing Material Efficiency II",
    "Standup M-Set Advanced Medium Ship Manufacturing Time Efficiency I",
    "Standup M-Set Advanced Medium Ship Manufacturing Time Efficiency II",
    "Standup M-Set Advanced Small Ship Manufacturing Material Efficiency I",
    "Standup M-Set Advanced Small Ship Manufacturing Material Efficiency II",
    "Standup M-Set Advanced Small Ship Manufacturing Time Efficiency I",
    "Standup M-Set Advanced Small Ship Manufacturing Time Efficiency II",
    "Standup M-Set Advanced Large Ship Manufacturing Material Efficiency I",
    "Standup M-Set Advanced Large Ship Manufacturing Material Efficiency II",
    "Standup M-Set Advanced Large Ship Manufacturing Time Efficiency I",
    "Standup M-Set Advanced Large Ship Manufacturing Time Efficiency II",
    "Standup M-Set Advanced Component Manufacturing Material Efficiency I",
    "Standup M-Set Advanced Component Manufacturing Material Efficiency II",
    "Standup M-Set Advanced Component Manufacturing Time Efficiency I",
    "Standup M-Set Advanced Component Manufacturing Time Efficiency II",
    "Standup M-Set Drone and Fighter Manufacturing Material Efficiency I",
    "Standup M-Set Drone and Fighter Manufacturing Material Efficiency II",
    "Standup M-Set Drone and Fighter Manufacturing Time Efficiency I",
    "Standup M-Set Drone and Fighter Manufacturing Time Efficiency II",
    "Standup M-Set Ammunition Manufacturing Material Efficiency I",
    "Standup M-Set Ammunition Manufacturing Material Efficiency II",
    "Standup M-Set Ammunition Manufacturing Time Efficiency I",
    "Standup M-Set Ammunition Manufacturing Time Efficiency II",
    "Standup M-Set Equipment Manufacturing Material Efficiency I",
    "Standup M-Set Equipment Manufacturing Material Efficiency II",
    "Standup M-Set Equipment Manufacturing Time Efficiency I",
    "Standup M-Set Equipment Manufacturing Time Efficiency II",
    "Standup M-Set Basic Capital Component Manufacturing Material Efficiency I",
    "Standup M-Set Basic Capital Component Manufacturing Material Efficiency II",
    "Standup M-Set Basic Capital Component Manufacturing Time Efficiency I",
    "Standup M-Set Basic Capital Component Manufacturing Time Efficiency II",
    "Standup M-Set Structure Manufacturing Material Efficiency I",
    "Standup M-Set Structure Manufacturing Material Efficiency II",
    "Standup M-Set Structure Manufacturing Time Efficiency I",
    "Standup M-Set Structure Manufacturing Time Efficiency II",
    "Standup M-Set Thukker Basic Capital Component Manufacturing Material Efficiency",
    "Standup M-Set Thukker Advanced Component Manufacturing Material Efficiency",
    "Standup M-Set Composite Reactor Material Efficiency I",
    "Standup M-Set Composite Reactor Material Efficiency II",
    "Standup M-Set Composite Reactor Time Efficiency I",
    "Standup M-Set Composite Reactor Time Efficiency II",
    "Standup M-Set Hybrid Reactor Material Efficiency I",
    "Standup M-Set Hybrid Reactor Material Efficiency II",
    "Standup M-Set Hybrid Reactor Time Efficiency I",
    "Standup M-Set Hybrid Reactor Time Efficiency II",
    "Standup M-Set Biochemical Reactor Material Efficiency I",
    "Standup M-Set Biochemical Reactor Material Efficiency II",
    "Standup M-Set Biochemical Reactor Time Efficiency I",
    "Standup M-Set Biochemical Reactor Time Efficiency II",
  ],
  Large: [
    "No Rig",
    "Standup L-Set Ammunition Manufacturing Efficiency I",
    "Standup L-Set Ammunition Manufacturing Efficiency II",
    "Standup L-Set Basic Large Ship Manufacturing Efficiency I",
    "Standup L-Set Basic Large Ship Manufacturing Efficiency II",
    "Standup L-Set Advanced Large Ship Manufacturing Efficiency I",
    "Standup L-Set Advanced Large Ship Manufacturing Efficiency II",
    "Standup L-Set Equipment Manufacturing Efficiency I",
    "Standup L-Set Equipment Manufacturing Efficiency II",
    "Standup L-Set Capital Ship Manufacturing Efficiency I",
    "Standup L-Set Capital Ship Manufacturing Efficiency II",
    "Standup L-Set Advanced Component Manufacturing Efficiency I",
    "Standup L-Set Advanced Component Manufacturing Efficiency II",
    "Standup L-Set Missile Flight Processor I",
    "Standup L-Set Missile Flight Processor II",
    "Standup L-Set Energy Neutralizer Feedback Control I",
    "Standup L-Set Energy Neutralizer Feedback Control II",
    "Standup L-Set Fighter Mission Control I",
    "Standup L-Set Fighter Mission Control II",
    "Standup L-Set EW Command System I",
    "Standup L-Set EW Command System II",
    "Standup L-Set Bomb Aimer I",
    "Standup L-Set Bomb Aimer II",
    "Standup L-Set Point Defense Battery Control I",
    "Standup L-Set Point Defense Battery Control II",
    "Standup L-Set Target Acquisition Array I",
    "Standup L-Set Target Acquisition Array II",
    "Standup L-Set Advanced Small Ship Manufacturing Efficiency I",
    "Standup L-Set Advanced Small Ship Manufacturing Efficiency II",
    "Standup L-Set Advanced Medium Ship Manufacturing Efficiency I",
    "Standup L-Set Advanced Medium Ship Manufacturing Efficiency II",
    "Standup L-Set Drone and Fighter Manufacturing Efficiency I",
    "Standup L-Set Drone and Fighter Manufacturing Efficiency II",
    "Standup L-Set Basic Small Ship Manufacturing Efficiency I",
    "Standup L-Set Basic Small Ship Manufacturing Efficiency II",
    "Standup L-Set Basic Medium Ship Manufacturing Efficiency I",
    "Standup L-Set Basic Medium Ship Manufacturing Efficiency II",
    "Standup L-Set Basic Capital Component Manufacturing Efficiency I",
    "Standup L-Set Basic Capital Component Manufacturing Efficiency II",
    "Standup L-Set Structure Manufacturing Efficiency I",
    "Standup L-Set Structure Manufacturing Efficiency II",
    "Standup L-Set Invention Optimization I",
    "Standup L-Set Invention Optimization II",
    "Standup L-Set ME Research Optimization I",
    "Standup L-Set ME Research Optimization II",
    "Standup L-Set TE Research Optimization I",
    "Standup L-Set TE Research Optimization II",
    "Standup L-Set Thukker Basic Capital Component Manufacturing Efficiency",
    "Standup L-Set Thukker Advanced Component Manufacturing Efficiency",
    "Standup L-Set Moon Drilling Proficiency I",
    "Standup L-Set Moon Drilling Proficiency II",
    "Standup L-Set Reactor Efficiency I",
    "Standup L-Set Reactor Efficiency II",
    "Standup L-Set Reprocessing Monitor I",
    "Standup L-Set Reprocessing Monitor II",
  ],
  "Extra Large": [
    "No Rig",
    "Standup XL-Set Equipment and Consumable Manufacturing Efficiency I",
    "Standup XL-Set Equipment and Consumable Manufacturing Efficiency II",
    "Standup XL-Set Ship Manufacturing Efficiency I",
    "Standup XL-Set Ship Manufacturing Efficiency II",
    "Standup XL-Set Laboratory Optimization I",
    "Standup XL-Set Laboratory Optimization II",
    "Standup XL-Set Missile Fire Control Computer I",
    "Standup XL-Set Missile Fire Control Computer II",
    "Standup XL-Set Integrated Fighter and PD Network I",
    "Standup XL-Set Integrated Fighter and PD Network II",
    "Standup XL-Set EW and Emissions Co-ordinator I",
    "Standup XL-Set EW and Emissions Co-ordinator II",
    "Standup XL-Set Extinction Level Weapons Suite I",
    "Standup XL-Set Extinction Level Weapons Suite II",
    "Standup XL-Set Structure and Component Manufacturing Efficiency I",
    "Standup XL-Set Structure and Component Manufacturing Efficiency II",
    "Standup XL-Set Thukker Structure and Component Manufacturing Efficiency",
    "Standup XL-Set Reprocessing Monitor I",
    "Standup XL-Set Reprocessing Monitor II",
  ],
};

function typeForName(name: string) {
  return structureTypes.find((structure) => structure.name === name) ?? structureTypes[0];
}

type SystemMatch = { systemId: number; name: string };

function readLegacyStructures() {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(locationsStorageKey);
    const parsed = stored ? (JSON.parse(stored) as Partial<PlannerLocations>) : {};
    return Array.isArray(parsed.structures)
      ? parsed.structures.map((structure) => ({
          ...structure,
          size: structure.size ?? typeForName(structure.type).size,
        }))
      : [];
  } catch {
    return [];
  }
}

export default function LocationsPage() {
  const [language, setLanguage] = useState<SdeLanguage>(() => {
    const saved =
      typeof window === "undefined" ? null : window.localStorage.getItem(languageStorageKey);
    return isSdeLanguage(saved) ? saved : "en";
  });
  const [locations, setLocations] = useState<PlannerLocations>(() => ({
    ...defaultLocations,
    structures: [],
  }));
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingStructure, setEditingStructure] = useState<KnownStructure | null>(null);
  const [rigOptionsBySize, setRigOptionsBySize] = useState(fallbackRigOptionsBySize);

  useEffect(() => {
    let cancelled = false;

    async function loadKnownStructures() {
      try {
        let structures = await loadStructures();
        if (structures.length === 0) {
          const legacyStructures = readLegacyStructures();
          if (legacyStructures.length > 0) {
            await saveStructures(legacyStructures);
            structures = legacyStructures;
          }
        }
        window.localStorage.removeItem(locationsStorageKey);
        if (!cancelled) {
          setLocations((current) => ({ ...current, structures }));
        }
      } catch {}
    }

    void loadKnownStructures();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    fetchRigs(language).then((rigs) => {
      if (!rigs.length) return;
      const options: Record<StructureSize, string[]> = {
        Small: ["No Rig"],
        Medium: ["No Rig"],
        Large: ["No Rig"],
        "Extra Large": ["No Rig"],
      };
      for (const rig of rigs) options[rig.size].push(rig.name);
      setRigOptionsBySize(options);
    }).catch(() => undefined);
  }, [language]);

  function openAddDialog() {
    setEditingStructure(null);
    setIsDialogOpen(true);
  }

  function removeStructure(id: string) {
    const structures = locations.structures.filter((structure) => structure.id !== id);
    setLocations((current) => ({
      ...current,
      structures,
    }));
    void saveStructures(structures);
  }

  return (
    <AppShell activePage="locations" language={language} onLanguageChange={setLanguage}>
      <div className={styles.pageIntro}>
        <div>
          <p className={styles.eyebrow}>CONFIGURATION / OPERATIONS</p>
          <h1>Locations</h1>
          <p className={styles.subtitle}>
            Choose operational sites and maintain the structures you use.
          </p>
        </div>
      </div>
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>01 / STRUCTURES</p>
            <h2>Known structures</h2>
          </div>
          <button type="button" className={styles.importButton} onClick={openAddDialog}>
            Add structure
          </button>
        </div>
        {locations.structures.length === 0 ? (
          <div className={styles.emptyBuildList}>
            No structures added yet. Add a structure to make it available in Stock.
          </div>
        ) : (
          <div className={styles.knownStructureList}>
            {locations.structures.map((structure) => (
              <div className={styles.knownStructure} key={structure.id}>
                <span>
                  <strong>{structure.name}</strong>
                  <small>
                    {structure.type} · {structure.size} · {structure.systemName}
                    {structure.rigs.length
                      ? ` · ${structure.rigs.filter((rig) => rig !== "No Rig").length} rig${structure.rigs.filter((rig) => rig !== "No Rig").length === 1 ? "" : "s"}`
                      : ""}
                  </small>
                </span>
                <button
                  type="button"
                  className={styles.importButton}
                  onClick={() => {
                    setEditingStructure(structure);
                    setIsDialogOpen(true);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`Remove ${structure.name}`}
                  onClick={() => removeStructure(structure.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {isDialogOpen && (
        <StructureDialog
          language={language}
          structure={editingStructure}
          rigOptionsBySize={rigOptionsBySize}
          onCancel={() => setIsDialogOpen(false)}
          onSave={(structure) => {
            const structures = editingStructure
              ? locations.structures.map((current) =>
                  current.id === structure.id ? structure : current,
                )
              : [...locations.structures, structure];
            setLocations((current) => ({
              ...current,
              structures,
            }));
            void saveStructures(structures);
            setIsDialogOpen(false);
            setEditingStructure(null);
          }}
        />
      )}
    </AppShell>
  );
}

function StructureDialog({
  language,
  onCancel,
  onSave,
  structure,
  rigOptionsBySize,
}: {
  language: SdeLanguage;
  onCancel: () => void;
  onSave: (structure: KnownStructure) => void;
  structure: KnownStructure | null;
  rigOptionsBySize: Record<StructureSize, string[]>;
}) {
  const [systemName, setSystemName] = useState(structure?.systemName ?? "");
  const [system, setSystem] = useState<SystemMatch | null>(
    structure ? { systemId: structure.systemId, name: structure.systemName } : null,
  );
  const [suggestions, setSuggestions] = useState<SystemMatch[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [type, setType] = useState(structure?.type ?? structureTypes[0].name);
  const [name, setName] = useState(structure?.name ?? "");
  const [rigs, setRigs] = useState(structure?.rigs ?? ["No Rig", "No Rig", "No Rig"]);
  const selectedType = typeForName(type);

  useEffect(() => {
    if (systemName.trim().length < 2 || !isOpen) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () =>
        fetch(
          `/api/reference/systems?query=${encodeURIComponent(systemName)}&language=${language}`,
          { signal: controller.signal },
        )
          .then((response) => response.json() as Promise<{ items?: SystemMatch[] }>)
          .then((data) => setSuggestions(data.items ?? []))
          .catch((error: unknown) => {
            if (!(error instanceof DOMException && error.name === "AbortError")) setSuggestions([]);
          }),
      180,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [isOpen, language, systemName]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!system || !name.trim()) return;
    onSave({
      id: structure?.id ?? `local:${crypto.randomUUID()}`,
      systemId: system.systemId,
      systemName: system.name,
      type,
      size: selectedType.size,
      name: name.trim(),
      rigs,
    });
  }

  return (
    <div
      className={styles.modalBackdrop}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <form
        className={styles.importModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="structure-dialog-title"
        onSubmit={submit}
      >
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.panelKicker}>STRUCTURE DIRECTORY</p>
            <h2 id="structure-dialog-title">{structure ? "Edit structure" : "Add structure"}</h2>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Close add structure dialog"
            onClick={onCancel}
          >
            ×
          </button>
        </div>
        <label className={styles.field}>
          SYSTEM
          <div className={styles.searchWrap}>
            <div className={styles.search}>
              ⌕{" "}
              <input
                role="combobox"
                aria-controls="structure-system-options"
                aria-expanded={isOpen}
                value={systemName}
                onFocus={() => setIsOpen(true)}
                onChange={(event) => {
                  setSystem(null);
                  setSystemName(event.target.value);
                  setIsOpen(true);
                }}
                placeholder="Type a system name"
                aria-label="Search systems"
                aria-autocomplete="list"
              />
            </div>
            {isOpen && suggestions.length > 0 && (
              <div className={styles.searchResults} id="structure-system-options" role="listbox">
                {suggestions.map((match) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={match.systemId === system?.systemId}
                    className={
                      match.systemId === system?.systemId
                        ? styles.searchResultActive
                        : styles.searchResult
                    }
                    key={match.systemId}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setSystem(match);
                      setSystemName(match.name);
                      setIsOpen(false);
                    }}
                  >
                    <span>{match.name}</span>
                    <small>System ID {match.systemId}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        </label>
        <StructureSelect
          label="STRUCTURE TYPE"
          value={type}
          options={structureTypes.map((option) => ({
            value: option.name,
            label: `${option.name} (${option.size})`,
          }))}
          onChange={(value) => {
            const nextType = typeForName(value);
            setType(nextType.name);
            setRigs((current) =>
              current.map((rig) =>
                rigOptionsBySize[nextType.size].includes(rig) ? rig : "No Rig",
              ),
            );
          }}
        />
        <label className={styles.field}>
          NAME
          <div className={styles.search}>
            ⌕{" "}
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Assembly Bay Alpha"
              aria-label="Structure name"
            />
          </div>
        </label>
        {rigs.map((rig, index) => (
          <StructureSelect
            key={index}
            label={`RIG ${index + 1}`}
            value={rig}
            options={rigOptionsBySize[selectedType.size].map((option) => ({
              value: option,
              label: option,
            }))}
            onChange={(value) =>
              setRigs((current) =>
                current.map((currentRig, rigIndex) =>
                  rigIndex === index ? value : currentRig,
                ),
              )
            }
          />
        ))}
        <div className={styles.modalActions}>
          <button type="button" className={styles.refresh} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={styles.calculate} disabled={!system || !name.trim()}>
            <span>{structure ? "Save structure" : "Add structure"}</span>
            <b>→</b>
          </button>
        </div>
      </form>
    </div>
  );
}

function StructureSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.field}>
      {label}
      <select
        className={styles.structureSelect}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
