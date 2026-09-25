// BLACKWATER — level layout.
// World axes: +x east, +z south (toward the sea), +y up. Metres. Sea level y = 0.
// Everything that needs to agree (terrain carving, meshes, collision, story
// triggers) reads its coordinates from here.

import type { V2, V3 } from '../core/math';

export const WORLD = {
  minX: -1024,
  minZ: -800,
  size: 2048,
  res: 1025, // heightmap samples per side (2 m spacing)
  get cell() {
    return this.size / (this.res - 1);
  },
};

/** Coastline as an open polyline from far west to far east. Land lies to the north (-z). */
export const COASTLINE: V2[] = [
  { x: -14000, z: 1200 },
  { x: -6000, z: 760 },
  { x: -2600, z: 740 },
  { x: -1300, z: 690 },
  { x: -1000, z: 672 },
  { x: -820, z: 656 },
  { x: -700, z: 640 },
  { x: -610, z: 636 },
  { x: -548, z: 628 },
  { x: -500, z: 612 },
  { x: -462, z: 584 },
  { x: -436, z: 544 },
  { x: -426, z: 496 },
  { x: -414, z: 440 },
  { x: -392, z: 380 },
  { x: -364, z: 326 },
  { x: -330, z: 278 },
  { x: -290, z: 242 },
  { x: -246, z: 224 },
  { x: -196, z: 214 },
  { x: -130, z: 210 },
  { x: -60, z: 214 },
  { x: 20, z: 220 },
  { x: 110, z: 216 },
  { x: 196, z: 222 },
  { x: 268, z: 238 },
  { x: 330, z: 268 },
  { x: 372, z: 318 },
  { x: 400, z: 374 },
  { x: 432, z: 420 },
  { x: 488, z: 448 },
  { x: 580, z: 466 },
  { x: 720, z: 486 },
  { x: 900, z: 506 },
  { x: 1300, z: 530 },
  { x: 2600, z: 600 },
  { x: 6000, z: 820 },
  { x: 14000, z: 1300 },
];

/** Regions where the coast is a cliff (0..1 weights are blended by distance). */
export const CLIFF_CENTERS: { x: number; z: number; r: number; h: number }[] = [
  { x: -500, z: 520, r: 250, h: 40 }, // west headland (lighthouse)
  { x: -760, z: 600, r: 330, h: 46 },
  { x: 470, z: 390, r: 230, h: 26 }, // east headland
  { x: 760, z: 470, r: 320, h: 34 },
];

// Key places --------------------------------------------------------------
export const P = {
  overlook: { x: -186, y: 100, z: -432 },
  overlookView: { x: -170, z: -410 }, // where the viewer / guardrail sits
  bridge: { x: -40, y: 86.5, z: -369 },
  waterfall: { x: -44, z: -402 },
  roadblock: { x: 74, z: -70 },
  townCenter: { x: 30, z: 60 },
  harbor: { x: 0, z: 200 },
  substation: { x: 150, z: -8 },
  relayMast: { x: 176, z: -30 },
  lighthouse: { x: -484, y: 41, z: 560 },
  keeperHouse: { x: -474, z: 512 },
  lighthouseGate: { x: -222, z: -452 },
  keeperStairTop: { x: -446, z: 470 },
  keeperStairBottom: { x: -418, z: 482 },
  wallZ: 1100,
  escapeTower: { x: -196, z: 962 },
  wreck: { x: -262, z: 648 },
  whale: { x: -118, z: 452 },
};

/** Coast road (north map edge -> overlook -> bridge -> switchback -> town). Heights are targets. */
export const COAST_ROAD: V3[] = [
  { x: -336, y: 140, z: -812 },
  { x: -306, y: 131, z: -706 },
  { x: -262, y: 117, z: -590 },
  { x: -222, y: 106, z: -496 },
  { x: -196, y: 101, z: -448 },
  { x: -160, y: 97.5, z: -410 },
  { x: -112, y: 92.5, z: -384 },
  { x: -72, y: 88.8, z: -372 },
  { x: -40, y: 86.5, z: -369 },
  { x: -6, y: 84.6, z: -366 },
  { x: 40, y: 81.4, z: -356 },
  { x: 92, y: 76.2, z: -334 },
  { x: 136, y: 70.0, z: -298 },
  { x: 160, y: 63.0, z: -248 },
  { x: 158, y: 56.0, z: -196 },
  { x: 134, y: 48.0, z: -146 },
  { x: 102, y: 39.5, z: -104 },
  { x: 76, y: 32.0, z: -70 },
  { x: 56, y: 26.0, z: -38 },
];

/** Main Street: town entrance down to the harbor. */
export const MAIN_STREET: V3[] = [
  { x: 56, y: 26.0, z: -38 },
  { x: 46, y: 21.5, z: 0 },
  { x: 36, y: 16.0, z: 50 },
  { x: 26, y: 11.0, z: 100 },
  { x: 16, y: 6.2, z: 150 },
  { x: 10, y: 3.6, z: 186 },
];

/** Waterfront road along the harbor. */
export const HARBOR_ROAD: V3[] = [
  { x: -150, y: 3.4, z: 180 },
  { x: -70, y: 3.3, z: 188 },
  { x: 10, y: 3.4, z: 190 },
  { x: 90, y: 3.5, z: 188 },
  { x: 170, y: 3.8, z: 184 },
];

/** Hill Street: east from Main St up to the utility yard. */
export const HILL_STREET: V3[] = [
  { x: 40, y: 18.6, z: 26 },
  { x: 76, y: 24.0, z: 22 },
  { x: 112, y: 30.5, z: 10 },
  { x: 142, y: 34.0, z: -4 },
];

/** Bay Street: residential street west of Main. */
export const BAY_STREET: V3[] = [
  { x: 36, y: 16.0, z: 50 },
  { x: -6, y: 14.8, z: 58 },
  { x: -52, y: 12.6, z: 70 },
  { x: -86, y: 10.0, z: 92 },
  { x: -104, y: 6.8, z: 128 },
  { x: -110, y: 4.2, z: 168 },
  { x: -104, y: 3.4, z: 182 },
];

/** Lighthouse road: from the gate near the overlook down the west flank to the headland. */
export const LIGHTHOUSE_ROAD: V3[] = [
  { x: -212, y: 102.5, z: -466 },
  { x: -246, y: 99, z: -436 },
  { x: -300, y: 91, z: -376 },
  { x: -352, y: 81, z: -290 },
  { x: -388, y: 71, z: -190 },
  { x: -412, y: 63, z: -90 },
  { x: -434, y: 57, z: 10 },
  { x: -452, y: 51, z: 110 },
  { x: -466, y: 46.5, z: 210 },
  { x: -476, y: 43.5, z: 310 },
  { x: -480, y: 42.0, z: 400 },
  { x: -478, y: 41.5, z: 470 },
  { x: -476, y: 41.2, z: 496 },
];

/** Steep path cut into the headland cliff, from the lighthouse down to the beach. */
export const CLIFF_PATH: V3[] = [
  { x: -478, y: 41.2, z: 452 },
  { x: -462, y: 37.5, z: 446 },
  { x: -446, y: 30, z: 438 },
  { x: -430, y: 20, z: 430 },
  { x: -414, y: 10, z: 422 },
  { x: -400, y: 3.2, z: 415 },
  { x: -386, y: 0.6, z: 410 },
];

export type RoadDef = {
  id: string;
  pts: V3[];
  width: number; // asphalt width
  shoulder: number; // gravel shoulder each side
  kind: 'asphalt' | 'gravel';
  lines: boolean;
};

export const ROADS: RoadDef[] = [
  { id: 'coast', pts: COAST_ROAD, width: 6.6, shoulder: 1.2, kind: 'asphalt', lines: true },
  { id: 'main', pts: MAIN_STREET, width: 8.5, shoulder: 0.4, kind: 'asphalt', lines: true },
  { id: 'harbor', pts: HARBOR_ROAD, width: 7.0, shoulder: 0.6, kind: 'asphalt', lines: false },
  { id: 'hill', pts: HILL_STREET, width: 6.0, shoulder: 0.6, kind: 'asphalt', lines: false },
  { id: 'bay', pts: BAY_STREET, width: 6.0, shoulder: 0.6, kind: 'asphalt', lines: false },
  { id: 'lighthouse', pts: LIGHTHOUSE_ROAD, width: 4.2, shoulder: 0.8, kind: 'gravel', lines: false },
  { id: 'cliffpath', pts: CLIFF_PATH, width: 1.8, shoulder: 0.5, kind: 'gravel', lines: false },
];

/** River centreline with bed heights; continues across the flats as a tidal channel. */
export const RIVER: V3[] = [
  { x: -92, y: 150, z: -830 },
  { x: -78, y: 128, z: -700 },
  { x: -62, y: 104, z: -560 },
  { x: -52, y: 86, z: -470 },
  { x: -46, y: 77, z: -412 },
  { x: -43, y: 74.5, z: -404 }, // lip of the falls
  { x: -42, y: 63, z: -398 }, // plunge pool
  { x: -40, y: 61.5, z: -370 }, // under the bridge
  { x: -58, y: 52, z: -300 },
  { x: -96, y: 38, z: -210 },
  { x: -134, y: 26, z: -120 },
  { x: -164, y: 14, z: -20 },
  { x: -188, y: 6, z: 70 },
  { x: -208, y: 1.6, z: 150 },
  { x: -224, y: -0.4, z: 214 },
  { x: -226, y: -2.2, z: 300 },
  { x: -186, y: -4.2, z: 420 },
  { x: -118, y: -6.0, z: 530 },
  { x: -58, y: -8.2, z: 660 },
  { x: -44, y: -10.8, z: 800 },
  { x: -72, y: -13.5, z: 940 },
  { x: -96, y: -16.5, z: 1080 },
  { x: -110, y: -18.5, z: 1250 },
];

/** Where the townspeople's footprints lead (harbor slipway -> the wall). */
export const TRAIL: V3[] = [
  { x: -18, y: 0, z: 226 },
  { x: -40, y: 0, z: 300 },
  { x: -88, y: 0, z: 380 },
  { x: -140, y: 0, z: 470 },
  { x: -186, y: 0, z: 566 },
  { x: -206, y: 0, z: 680 },
  { x: -204, y: 0, z: 800 },
  { x: -196, y: 0, z: 920 },
  { x: -190, y: 0, z: 1040 },
  { x: -188, y: 0, z: 1092 },
];

/** Flat pads: terrain is levelled to `y` inside the rect (rotated by `rot`), blended over `blend` metres. */
export type Pad = { x: number; z: number; w: number; d: number; rot: number; y: number; blend: number };
export const PADS: Pad[] = [
  // Overlook pull-off (gravel lay-by beside the coast road)
  { x: -181, z: -428, w: 26, d: 12, rot: -0.62, y: 99.9, blend: 6 },
];

export function addPad(p: Pad) {
  PADS.push(p);
}
