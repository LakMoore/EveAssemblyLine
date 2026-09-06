export type TimingPhase = number | TimingProfile;

export type TimingProfile = {
  totalMs: number;
  phasesMs: Record<string, TimingPhase>;
};

export type TimingScope = {
  mark: (name: string) => void;
  child: (name: string) => TimingScope;
  complete: () => TimingProfile;
};

export function logTiming(label: string, details: Record<string, unknown>) {
  console.info(label);
  console.dir(details, { depth: null });
}

function elapsedMilliseconds(startedAt: number) {
  return Math.round(performance.now() - startedAt);
}

export function createTimingScope(): TimingScope {
  const startedAt = performance.now();
  let phaseStartedAt = startedAt;
  let completedProfile: TimingProfile | undefined;
  const phasesMs: Record<string, TimingPhase> = {};

  const complete = () => {
    if (completedProfile) return completedProfile;
    completedProfile = {
      totalMs: elapsedMilliseconds(startedAt),
      phasesMs,
    };
    return completedProfile;
  };

  return {
    mark(name) {
      phasesMs[name] = elapsedMilliseconds(phaseStartedAt);
      phaseStartedAt = performance.now();
    },
    child(name) {
      const childScope = createTimingScope();
      return {
        mark: childScope.mark,
        child: childScope.child,
        complete() {
          const profile = childScope.complete();
          phasesMs[name] = profile;
          phaseStartedAt = performance.now();
          return profile;
        },
      };
    },
    complete,
  };
}

export function flattenTimingPhases(
  phasesMs: Record<string, TimingPhase>,
  prefix = "",
): Array<[string, number]> {
  return Object
    .entries(phasesMs)
    .flatMap(([name, duration]) => {
      const phaseName = prefix ? `${prefix}.${name}` : name;
      return typeof duration === "number"
        ? [[phaseName, duration]]
        : [[phaseName, duration.totalMs], ...flattenTimingPhases(duration.phasesMs, phaseName)];
    });
}
