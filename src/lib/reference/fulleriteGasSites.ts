/** Describes a wormhole gas site and the Fullerites found there. */
export type FulleriteGasSite = {
  name: string;
  wormholeClasses: string;
  types: readonly number[];
};

/** Static Fullerite gas-site reference data used by the simulator presentation. */
export const fulleriteGasSites: readonly FulleriteGasSite[] = [
  {
    name: "Barren Perimeter Reservoir",
    wormholeClasses: "C1-C5, plus shattered",
    types: [30370, 30371],
  },
  {
    name: "Token Perimeter Reservoir",
    wormholeClasses: "C1-C5, plus shattered",
    types: [30371, 30372],
  },
  {
    name: "Minor Perimeter Reservoir",
    wormholeClasses: "C1-C5, plus shattered",
    types: [30372, 30373],
  },
  {
    name: "Sizeable Perimeter Reservoir",
    wormholeClasses: "C1-C5, plus shattered",
    types: [30370, 30374],
  },
  {
    name: "Ordinary Perimeter Reservoir",
    wormholeClasses: "C1-C5, plus shattered",
    types: [30373, 30374],
  },
  {
    name: "Bountiful Frontier Reservoir",
    wormholeClasses: "C3-C6, plus shattered",
    types: [30375, 30376],
  },
  {
    name: "Vast Frontier Reservoir",
    wormholeClasses: "C3-C6, plus shattered",
    types: [30375, 30376],
  },
  {
    name: "Instrumental Core Reservoir",
    wormholeClasses: "C5-C6, plus shattered",
    types: [30377, 30378],
  },
  {
    name: "Vital Core Reservoir",
    wormholeClasses: "C5-C6, plus shattered",
    types: [30377, 30378],
  },
];
