export type ProfileValue =
  | number
  | {
      totalMS: number;
      sections: Record<string, ProfileValue>;
      count?: number;
    };

type ProfileGroup = Exclude<ProfileValue, number>;

function profileCount(group: ProfileGroup): number {
  return group.count === undefined ? 1 : group.count;
}

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

  function mergeProfileValues(left: ProfileValue, right: ProfileValue): ProfileValue {
    const leftGroup =
      typeof left === "number"
        ? { totalMS: left, sections: {}, count: 1 }
        : { ...left, count: profileCount(left) };
    const rightGroup =
      typeof right === "number"
        ? { totalMS: right, sections: {}, count: 1 }
        : { ...right, count: profileCount(right) };
    const sectionNames = new Set([
      ...Object.keys(leftGroup.sections),
      ...Object.keys(rightGroup.sections),
    ]);
    const sections = Object.fromEntries(
      [...sectionNames].map((name) => {
        const hasLeftSection = Object.prototype.hasOwnProperty.call(leftGroup.sections, name);
        const hasRightSection = Object.prototype.hasOwnProperty.call(rightGroup.sections, name);
        const mergedSection = !hasLeftSection
          ? rightGroup.sections[name]
          : !hasRightSection
            ? leftGroup.sections[name]
            : mergeProfileValues(leftGroup.sections[name], rightGroup.sections[name]);
        return [name, mergedSection];
      }),
    );
    return {
      totalMS: Math.round((leftGroup.totalMS + rightGroup.totalMS) * 100) / 100,
      sections,
      count: leftGroup.count + rightGroup.count,
    };
  }

  function recordSection(
    parentSections: Map<string, ProfileValue>,
    name: string,
    value: ProfileValue,
  ) {
    const existing = parentSections.get(name);
    parentSections.set(name, existing === undefined ? value : mergeProfileValues(existing, value));
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
      recordSection(parentSections, section, finishSection(activeSection, totalMS));
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
          recordSection(parentSections, section, finishSection(activeSection, totalMS));
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
