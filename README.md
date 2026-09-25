# Blackwater

*The tide went out on Tuesday. It hasn't come back.*

Blackwater is a short, cinematic first-person mystery that runs entirely in the browser — on desktop
and on phones. You are Unit 7, a county communications technician sent to fix a dead radio relay in
a small coastal town. The town is empty. The harbor is mud to the horizon. Something is standing out
past the flats.

Everything you see and hear is generated at runtime: terrain, forests, the town and its interiors,
the sky and clouds, water, weather, textures, voices, music and ambience. There are no image, model
or audio files.

## Play

```bash
npm install
npm run dev          # http://localhost:5173
```

`npm run build` produces a static site in `dist/` (deployed to GitHub Pages by
`.github/workflows/pages.yml`). `npm run build:single` produces one self-contained HTML file,
`dist-single/blackwater.html`, that can be opened directly or hosted anywhere.

### Controls

| | Desktop | Controller | Touch |
|---|---|---|---|
| Move / look | WASD + mouse (click to capture) | Sticks | Drag left side / drag right side |
| Run | Shift | L3 / LB / LT | Push the stick past its ring |
| Use | E or left click | A | Tap the object, or the action button |
| Flashlight / headlights | F | X | Lamp button |
| Notebook | Tab / J | Y | Book button |
| Pause | Esc | Start | Menu button |

Headphones recommended. Progress is saved at checkpoints (Continue on the title screen).

## What's inside

- **Rendering** (three.js, custom pipeline): HDR with MSAA, physically based single + multiple
  scattering sky, raymarched volumetric clouds accumulated into a sky cubemap (reflections, image
  based lighting and aerial perspective), height fog, ground mist and a sea-fog bank, dual-filter
  bloom, GPU auto-exposure with physically scaled light units, AgX tone mapping and grading,
  dynamic resolution.
- **World**: 2 km eroded coastal heightfield with rivers, a waterfall, tide pools and road cuts;
  CDLOD terrain with texture-array splatting, triplanar rock, wetness and puddles; procedural
  conifer and alder meshes with octahedral impostors; instanced grass and ferns; a generated town
  with interior-mapped windows and enterable, furnished buildings; props, power lines, boats,
  a lighthouse with a turning Fresnel lens.
- **Weather**: time of day, storms, lightning with branching bolts, roof-occluded rain lit by
  street lamps, the flashlight and headlights, splashes, wet surfaces, wind in grass and trees.
- **Water**: depth-based absorption, refraction, screen-space reflections, flow-mapped normals,
  rain ripples, and a flood front with a breaking bore.
- **Audio** (WebAudio, all synthesised): wind, rain on roofs, rivers and falls, surf, birds,
  footsteps per surface, doors, electrical hum, thunder, formant-synthesised radio voices and a
  sparse score.
- **Game**: story beats with checkpoints, documents, a breaker-panel puzzle, a drivable truck,
  ladders, doors, binoculars and an ending.

Quality adapts to the device (`?q=low|medium|high|ultra` forces a tier).

## Project layout

```
src/core      engine loop, input, quality tiers, math
src/render    pipeline, sky, shared shader chunks, procedural texture baking
src/world     terrain, water, forest, grass, town, interiors, places, weather, lights
src/game      player, truck, interaction, dialogue, story, world assembly
src/audio     audio engine, ambience, voices, music
src/ui        overlay UI and styles
```
