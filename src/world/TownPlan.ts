// The town of Blackwater: building placements. Importing this module registers the
// building lots as terrain pads (so it must be imported before terrain generation).
import type { BuildingSpec, FacadeSpec, WindowSpec } from './BuildingGen';
import { yawFacing } from './BuildingGen';
import { PADS, MAIN_STREET, BAY_STREET, HILL_STREET, type Pad } from './Layout';

export type PlannedBuilding = Omit<BuildingSpec, 'floorY' | 'groundAt'> & { pad: Pad; floorLift?: number; role?: string };

function lerpPath(path: { x: number; z: number }[], z: number) {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i];
    if ((z >= a.z && z <= b.z) || (z <= a.z && z >= b.z)) {
      const t = (z - a.z) / (b.z - a.z || 1);
      return a.x + (b.x - a.x) * t;
    }
  }
  return path[path.length - 1].x;
}
function lerpPathX(path: { x: number; z: number }[], x: number) {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i];
    if ((x >= a.x && x <= b.x) || (x <= a.x && x >= b.x)) {
      const t = (x - a.x) / (b.x - a.x || 1);
      return a.z + (b.z - a.z) * t;
    }
  }
  return path[path.length - 1].z;
}

let lightIdx = 1;
export const BUILDINGS: PlannedBuilding[] = [];

/** Register a building with its front-centre at (x,z) facing direction (fx,fz). */
function place(
  spec: Omit<PlannedBuilding, 'pad' | 'x' | 'z' | 'yaw' | 'light'> & { light?: number },
  x: number,
  z: number,
  fx: number,
  fz: number,
  padMargin = 2.5,
) {
  const yaw = yawFacing(fx, fz);
  // footprint centre is d/2 behind the front
  const bx = -Math.sin(yaw),
    bz = -Math.cos(yaw); // local -z (front) in world
  const cx = x - bx * (spec.d / 2),
    cz = z - bz * (spec.d / 2);
  const porchD = spec.porch?.depth ?? 0;
  const pad: Pad = {
    x: cx + bx * (porchD / 2),
    z: cz + bz * (porchD / 2),
    w: spec.w + padMargin * 2,
    d: spec.d + porchD + padMargin * 2,
    rot: -yaw,
    y: NaN,
    blend: 5,
  };
  PADS.push(pad);
  const b = { ...spec, x, z, yaw, pad, light: spec.light ?? lightIdx++ } as PlannedBuilding;
  BUILDINGS.push(b);
  return b;
}

function evenWindows(L: number, n: number, w: number, h: number, sill: number, margin = 1.2, type: WindowSpec['type'] = 'sash'): WindowSpec[] {
  const out: WindowSpec[] = [];
  if (n <= 0) return out;
  const span = L - margin * 2;
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : -span / 2 + (span * i) / (n - 1);
    out.push({ x, w, h, sill, type });
  }
  return out;
}

function storeys(L: number, n: number, stories: number, storyH: number, w = 0.9, h = 1.45, skip?: (i: number, s: number) => boolean): WindowSpec[] {
  const out: WindowSpec[] = [];
  for (let s = 0; s < stories; s++)
    evenWindows(L, n, w, h, s * storyH + 0.85).forEach((win, i) => {
      if (!skip || !skip(i, s)) out.push(win);
    });
  return out;
}

const PAINT = {
  white: 0xe6e2d8,
  grey: 0xa9aca6,
  blue: 0x7f93a0,
  green: 0x8a9a80,
  red: 0x8b3f33,
  mustard: 0xc0a260,
  cream: 0xd9ccb0,
  teal: 0x5f8580,
  brown: 0x6d5847,
  rose: 0xb58f83,
};

// ---------------------------------------------------------------- Main Street
const msX = (z: number) => lerpPath(MAIN_STREET, z);
const WEST = (z: number) => msX(z) - 8.0;
const EAST = (z: number) => msX(z) + 8.0;

function house(id: string, x: number, z: number, fx: number, fz: number, color: number, opts: Partial<PlannedBuilding> = {}) {
  const w = opts.w ?? 8,
    d = opts.d ?? 10,
    stories = opts.stories ?? 2;
  const facades: Partial<Record<'front' | 'back' | 'left' | 'right', FacadeSpec>> = {
    front: {
      windows: storeys(w, 2, stories, 2.9, 0.85, 1.45, (i, s) => s === 0 && i === 0).concat(stories > 0 ? [{ x: -w / 2 + 1.5, w: 0.85, h: 1.45, sill: 0.85 }] : []),
      doors: [{ x: 1.2, w: 0.95, h: 2.1, id: id + '-door' }],
    },
    back: { windows: storeys(w, 2, stories, 2.9, 0.8, 1.3), doors: [{ x: -1.5, w: 0.9, h: 2.05, id: id + '-back' }] },
    left: { windows: storeys(d, 2, stories, 2.9, 0.8, 1.4) },
    right: { windows: storeys(d, 3, stories, 2.9, 0.8, 1.4) },
  };
  // remove overlap: front windows vs door
  facades.front!.windows = facades.front!.windows!.filter((wn) => !(wn.sill < 2 && Math.abs(wn.x - 1.2) < 1.1));
  return place(
    {
      id,
      w,
      d,
      stories,
      storyH: 2.9,
      roof: opts.roof ?? 'gable-z',
      pitch: opts.pitch ?? 0.75,
      siding: opts.siding ?? 'clapboard',
      color,
      trim: opts.trim ?? PAINT.white,
      roofMat: opts.roofMat ?? 'shingles',
      roofColor: opts.roofColor ?? 0xffffff,
      facades: opts.facades ?? facades,
      porch: opts.porch === undefined ? { depth: 2.2, w: w } : opts.porch,
      chimney: opts.chimney === undefined ? { x: -w / 2 + 1.0, z: d * 0.6 } : opts.chimney ?? undefined,
      enterable: opts.enterable,
      role: opts.role,
    },
    x,
    z,
    fx,
    fz,
  );
}

function shop(id: string, x: number, z: number, fx: number, fz: number, sign: string, color: number, opts: Partial<PlannedBuilding> & { signColor?: number } = {}) {
  const w = opts.w ?? 10,
    d = opts.d ?? 14,
    stories = opts.stories ?? 1;
  const facades: Partial<Record<'front' | 'back' | 'left' | 'right', FacadeSpec>> = opts.facades ?? {
    front: {
      windows: [
        { x: -w * 0.28, w: w * 0.34, h: 2.1, sill: 0.55, type: 'shop' },
        { x: w * 0.28, w: w * 0.34, h: 2.1, sill: 0.55, type: 'shop' },
        ...(stories > 1 ? evenWindows(w, 3, 0.9, 1.4, 3.3 + 0.8) : []),
      ],
      doors: [{ x: 0, w: 1.2, h: 2.4, id: id + '-door', glass: true, enterable: opts.enterable }],
    },
    back: { windows: storeys(w, 2, stories, 3.3, 0.8, 1.1), doors: [{ x: w / 2 - 1.5, w: 0.95, h: 2.1, id: id + '-back' }] },
    left: { windows: storeys(d, 3, stories, 3.3, 0.8, 1.2) },
    right: { windows: storeys(d, 2, stories, 3.3, 0.8, 1.2) },
  };
  return place(
    {
      id,
      w,
      d,
      stories,
      storyH: 3.3,
      roof: opts.roof ?? 'shed',
      pitch: opts.pitch ?? 0.12,
      siding: opts.siding ?? 'clapboard',
      color,
      trim: opts.trim ?? PAINT.white,
      roofMat: opts.roofMat ?? 'roofMetal',
      roofColor: opts.roofColor ?? 0xffffff,
      facades,
      falseFront: { h: opts.falseFront?.h ?? 1.6, sign, signColor: opts.signColor ?? 0x2d2a26 },
      porch: opts.porch,
      enterable: opts.enterable,
      role: opts.role,
    },
    x,
    z,
    fx,
    fz,
    1.5,
  );
}

// East side (front faces -x / west)
shop('fuel', EAST(-24) + 12, -24, -1, 0.1, 'BAYSIDE FUEL', PAINT.white, { w: 8, d: 6.5, signColor: 0x7a2a22, role: 'fuel' });
shop('sheriff', EAST(4), 4, -1, 0, 'HARROW CO. SHERIFF', PAINT.cream, {
  w: 10,
  d: 9,
  siding: 'brick',
  roof: 'flat',
  enterable: true,
  role: 'sheriff',
  signColor: 0x263238,
  facades: {
    front: {
      windows: [
        { x: -3, w: 1.6, h: 1.5, sill: 0.9, type: 'sash', panes: [2, 2] },
        { x: 3, w: 1.6, h: 1.5, sill: 0.9, type: 'sash', panes: [2, 2] },
      ],
      doors: [{ x: 0, w: 1.0, h: 2.2, id: 'sheriff-door', enterable: true }],
    },
    back: { windows: [{ x: 2.5, w: 0.9, h: 1.1, sill: 1.2 }] },
    left: { windows: [{ x: 1.5, w: 1.1, h: 1.3, sill: 1.0 }] },
    right: { windows: [{ x: -1.5, w: 1.1, h: 1.3, sill: 1.0 }, { x: 2.2, w: 0.7, h: 0.8, sill: 1.5, type: 'small' }] },
  },
});
shop('diner', EAST(46), 46, -1, 0, 'THE ANCHOR', PAINT.teal, {
  w: 13,
  d: 11,
  enterable: true,
  role: 'diner',
  signColor: 0x1f2d2e,
  facades: {
    front: {
      windows: [
        { x: -4.1, w: 3.6, h: 1.7, sill: 0.95, type: 'shop' },
        { x: 3.9, w: 3.8, h: 1.7, sill: 0.95, type: 'shop' },
      ],
      doors: [{ x: -0.6, w: 1.1, h: 2.25, id: 'diner-door', glass: true, enterable: true }],
    },
    back: { windows: [{ x: 3, w: 0.9, h: 1.0, sill: 1.3 }], doors: [{ x: -4, w: 0.95, h: 2.1, id: 'diner-back' }] },
    left: { windows: [{ x: -2, w: 1.6, h: 1.4, sill: 1.0, type: 'shop' }, { x: 2, w: 1.6, h: 1.4, sill: 1.0, type: 'shop' }] },
    right: { windows: [{ x: 0, w: 1.0, h: 1.0, sill: 1.3 }] },
  },
});
shop('hardware', EAST(74), 74, -1, 0, "HARLAN'S HARDWARE", PAINT.mustard, { w: 10, d: 15, stories: 2, signColor: 0x3a2f24 });
house('house-e5', EAST(100) + 1, 100, -1, 0, PAINT.grey, { w: 8, d: 11 });
shop('tavern', EAST(126), 126, -1, 0, 'SALT & ANCHOR TAVERN', PAINT.red, { w: 11, d: 14, stories: 2, signColor: 0x1c1a17 });

// West side (front faces +x / east)
house('house-w1', WEST(-22) - 1, -22, 1, 0, PAINT.white, { w: 8.5, d: 10 });
shop('mercantile', WEST(8), 8, 1, 0, "MARR'S MERCANTILE", PAINT.cream, { w: 12, d: 16, stories: 2, signColor: 0x283a2e, porch: { depth: 2.4, w: 12 } });
shop('postoffice', WEST(36), 36, 1, 0, 'U.S. POST OFFICE', PAINT.white, { w: 9, d: 10, roof: 'flat', siding: 'stucco', signColor: 0x22303a });
house('house-w4', WEST(66) - 1, 66, 1, 0, PAINT.green, { w: 8, d: 10 });
shop('grange', WEST(90), 90, 1, 0, 'GRANGE HALL No. 214', PAINT.white, {
  w: 12,
  d: 18,
  roof: 'gable-z',
  pitch: 0.8,
  roofMat: 'shingles',
  signColor: 0x2a3446,
  facades: {
    front: { windows: [{ x: -3.6, w: 1.1, h: 2.2, sill: 0.9 }, { x: 3.6, w: 1.1, h: 2.2, sill: 0.9 }], doors: [{ x: 0, w: 1.8, h: 2.6, id: 'grange-door' }] },
    left: { windows: evenWindows(18, 4, 1.1, 2.2, 0.9) },
    right: { windows: evenWindows(18, 4, 1.1, 2.2, 0.9) },
  },
});
house('house-w6', WEST(114) - 1, 114, 1, 0, PAINT.blue, { w: 7.5, d: 10, stories: 1, pitch: 0.9 });
shop('tackle', WEST(142), 142, 1, 0, 'TACKLE · BAIT · ICE', PAINT.grey, { w: 10, d: 12, siding: 'shingleWall', signColor: 0x1e2c31 });

// ---------------------------------------------------------------- Bay Street
const bayZ = (x: number) => lerpPathX(BAY_STREET, x);
house('pell', -36, bayZ(-36) - 9.5, 0.15, 1, PAINT.rose, { w: 9, d: 11, enterable: true, role: 'pell', porch: { depth: 2.4, w: 9 } });
house('house-b2', -12, bayZ(-12) - 9.5, 0.05, 1, PAINT.cream, { w: 8, d: 10, stories: 1, pitch: 0.95 });
house('house-b3', -62, bayZ(-62) - 9.5, 0.3, 1, PAINT.teal, { w: 8, d: 10 });
house('house-b4', -20, bayZ(-20) + 10, 0, -1, PAINT.white, { w: 8, d: 9, stories: 1, pitch: 0.95 });
house('house-b5', -50, bayZ(-50) + 10.5, 0, -1, PAINT.grey, { w: 9, d: 10 });
house('house-b6', -96, 112, 1, 0.1, PAINT.green, { w: 8, d: 10, stories: 1, pitch: 0.9 });
house('house-b7', -120, 148, 1, 0, PAINT.brown, { w: 7.5, d: 9, stories: 1, siding: 'shingleWall', pitch: 0.9 });

// ---------------------------------------------------------------- Hill Street
house('house-h1', 70, 34, 0, -1, PAINT.mustard, { w: 8, d: 9, stories: 1, pitch: 0.9 });
place(
  {
    id: 'church',
    w: 9,
    d: 16,
    stories: 1,
    storyH: 5.2,
    roof: 'gable-z',
    pitch: 1.1,
    siding: 'clapboard',
    color: PAINT.white,
    trim: PAINT.white,
    roofMat: 'shingles',
    roofColor: 0xffffff,
    facades: {
      front: { windows: [{ x: 0, w: 1.0, h: 1.4, sill: 3.4, type: 'small' }], doors: [{ x: 0, w: 1.6, h: 2.8, id: 'church-door' }] },
      left: { windows: evenWindows(16, 3, 1.0, 2.8, 1.4, 2.5, 'small') },
      right: { windows: evenWindows(16, 3, 1.0, 2.8, 1.4, 2.5, 'small') },
    },
    role: 'church',
  },
  96,
  4,
  0,
  1,
);

// ---------------------------------------------------------------- Harbor
place(
  {
    id: 'harbormaster',
    w: 7,
    d: 6,
    stories: 1,
    storyH: 2.9,
    roof: 'hip',
    pitch: 0.55,
    siding: 'shingleWall',
    color: 0x9aa39c,
    trim: PAINT.white,
    roofMat: 'roofMetal',
    roofColor: 0xffffff,
    enterable: true,
    role: 'harbormaster',
    facades: {
      front: { windows: [{ x: -1.8, w: 1.4, h: 1.2, sill: 1.0 }], doors: [{ x: 1.4, w: 0.95, h: 2.1, id: 'harbor-door', enterable: true }] },
      back: { windows: [{ x: -1.2, w: 2.2, h: 1.3, sill: 0.95, type: 'shop' }, { x: 1.8, w: 1.2, h: 1.3, sill: 0.95 }] },
      left: { windows: [{ x: 0, w: 1.4, h: 1.3, sill: 0.95 }] },
      right: { windows: [{ x: 0, w: 1.4, h: 1.3, sill: 0.95 }] },
    },
    porch: { depth: 1.6, w: 7, steps: true },
  },
  34,
  197,
  0,
  -1,
);
place(
  {
    id: 'cannery',
    w: 22,
    d: 34,
    stories: 2,
    storyH: 4.2,
    roof: 'gable-z',
    pitch: 0.35,
    siding: 'corrugated',
    color: 0xb9b4a8,
    trim: 0x8a8578,
    roofMat: 'corrugated',
    roofColor: 0xffffff,
    facades: {
      front: {
        windows: evenWindows(22, 4, 1.4, 1.4, 5.2, 3, 'small'),
        doors: [
          { x: -6, w: 4, h: 3.8, id: 'cannery-bay' },
          { x: 4, w: 1.1, h: 2.2, id: 'cannery-door' },
        ],
      },
      left: { windows: evenWindows(34, 6, 1.4, 1.2, 1.4, 3, 'small').concat(evenWindows(34, 6, 1.4, 1.2, 5.4, 3, 'small')) },
      right: { windows: evenWindows(34, 6, 1.4, 1.2, 1.4, 3, 'small').concat(evenWindows(34, 6, 1.4, 1.2, 5.4, 3, 'small')) },
      back: { windows: evenWindows(22, 3, 2.0, 1.4, 5.0, 4, 'small') },
    },
    falseFront: { h: 0.01, sign: 'BLACKWATER PACKING CO.', signColor: 0x5a1f18 },
    role: 'cannery',
    pilings: true,
  },
  -64,
  196,
  0,
  -1,
  1,
);
{
  const c = BUILDINGS[BUILDINGS.length - 1];
  c.pad.d = 10;
  c.pad.z = 196 + 4;
  c.floorLift = 1.2;
}
house('boathouse', 104, 196, 0, -1, 0x7d6d5d, { w: 9, d: 12, stories: 1, pitch: 0.7, siding: 'board', porch: null as unknown as undefined, chimney: null as unknown as undefined });

// ---------------------------------------------------------------- Utility yard (substation + relay)
PADS.push({ x: 160, z: -18, w: 46, d: 36, rot: 0.3, y: NaN, blend: 6 });
place(
  {
    id: 'relayhut',
    w: 6,
    d: 5,
    stories: 1,
    storyH: 3.0,
    roof: 'flat',
    siding: 'stucco',
    color: 0xb8b5aa,
    trim: 0x8f8c84,
    roofMat: 'roofMetal',
    roofColor: 0x888888,
    enterable: true,
    role: 'relayhut',
    facades: {
      front: { windows: [{ x: 1.6, w: 1.0, h: 0.9, sill: 1.3, type: 'small' }], doors: [{ x: -1.2, w: 0.95, h: 2.1, id: 'relay-door', enterable: true }] },
      right: { windows: [{ x: 0, w: 0.9, h: 0.6, sill: 1.6, type: 'small' }] },
    },
    light: 60,
  },
  162,
  -12,
  -0.55,
  0.83,
  1.5,
);

// ---------------------------------------------------------------- Lighthouse keeper's house
PADS.push({ x: -484, z: 560, w: 20, d: 20, rot: 0, y: 41.0, blend: 8 });
house('keeper', -474, 506, 0.2, -1, 0xe9e5dc, {
  w: 8,
  d: 9,
  stories: 1,
  pitch: 0.95,
  enterable: true,
  role: 'keeper',
  roofColor: 0x9a3a2e,
  roofMat: 'roofMetal',
  trim: 0x2d3a34,
  porch: { depth: 2.0, w: 8 },
  chimney: { x: 2.8, z: 5.5 },
});
{
  const k = BUILDINGS[BUILDINGS.length - 1];
  k.light = 61;
  k.pad.y = 41.0; // same level as the lighthouse lawn (the auto height lands in a gully)
}

// Pads registered above get their y assigned during terrain generation.
export { PADS, HILL_STREET };
