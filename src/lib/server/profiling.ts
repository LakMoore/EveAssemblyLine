export type ProfileValue =
  | number
  | {
      totalMS: number;
      sections: Record<string, ProfileValue>;
    };

export type RequestProfiler = {
  start(section: string): void;
  end(section: string): void;
  measure<T>(section: string, operation: () => Promise<T>): Promise<T>;
  finish(): void;
};

/** Collects nested development-only timings without changing request behavior. */
export function createRequestProfiler(
  label: string,
  details: Record<string, string | number> = {},
): RequestProfiler {
  const enabled = process.env.NODE_ENV === "development";
  const startedAt = performance.now();
  type ActiveSection = {
    name: string;
    startedAt: number;
    sections: Map<string, ProfileValue>;
  };
  const rootSections = new Map<string, ProfileValue>();
  const activeSections: ActiveSection[] = [];

  function finishSection(section: ActiveSection, totalMS: number): ProfileValue {
    if (section.sections.size === 0) return totalMS;
    return {
      totalMS,
      sections: Object.fromEntries(section.sections),
    };
  }

  return {
    start(section: string) {
      if (enabled) {
        activeSections.push({ name: section, startedAt: performance.now(), sections: new Map() });
      }
    },
    end(section: string) {
      if (!enabled) return;
      const activeSection = activeSections.pop();
      if (!activeSection || activeSection.name !== section) return;
      const totalMS = Math.round((performance.now() - activeSection.startedAt) * 100) / 100;
      const parentSections = activeSections.at(-1)?.sections ?? rootSections;
      parentSections.set(section, finishSection(activeSection, totalMS));
    },
    async measure<T>(section: string, operation: () => Promise<T>) {
      if (!enabled) return operation();
      activeSections.push({ name: section, startedAt: performance.now(), sections: new Map() });
      try {
        return await operation();
      }
      finally {
        const activeSection = activeSections.pop();
        if (activeSection && activeSection.name === section) {
          const totalMS = Math.round((performance.now() - activeSection.startedAt) * 100) / 100;
          const parentSections = activeSections.at(-1)?.sections ?? rootSections;
          parentSections.set(section, finishSection(activeSection, totalMS));
        }
      }
    },
    finish() {
      if (!enabled) return;
      console.info(
        `[${label} profile]`,
        JSON.stringify(
          {
            ...details,
            totalMS: Math.round((performance.now() - startedAt) * 100) / 100,
            sections: Object.fromEntries(rootSections),
          },
          null,
          2,
        ),
      );
    },
  };
}
