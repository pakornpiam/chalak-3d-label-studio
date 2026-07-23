# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Chalak (ฉลาก = "label") is a browser-only 3D-printable label designer: Thai/English text, SVG logo import, raised/engraved/flush design modes, live Three.js preview, and STL/3MF export for slicers like Bambu Studio. No backend — everything (font shaping, SVG parsing, 2D boolean ops, CSG, mesh export) runs client-side.

## Commands

```
npm install
npm run dev       # Vite dev server → http://localhost:5173
npm run build     # production build → dist/
npm run preview   # preview the production build
```

There is no lint or test script configured. Verify changes by running `npm run dev` and exercising the UI in a browser (or a headless Chrome via playwright-core — see memory for the recipe), since this app has no automated test suite.

## Architecture

The entire app is one file: [src/main.js](src/main.js), driven by the static controls in [index.html](index.html). There's no framework, no build-time component system, no state library — UI inputs are read directly by id (the `ui` object + `$()` helper) and every `input` event triggers a debounced `rebuild()`.

Data flow through `rebuild()`:
1. **`params()`** reads all UI controls into a plain params object `p`.
2. **2D shape builders** (`buildOutline`, `buildBaseShape`, `buildBorderShape`, `textToShapes`, `buildSvgShapes`) produce `THREE.Shape[]` — all in mm, centered at origin, XY plane.
   - Text goes through opentype.js (`font.getPath`) with y flipped (opentype is y-down, three.js is y-up) and is converted via `SVGLoader.createShapes`.
   - SVG import (`loadSvg`) splits paths into filled shapes and stroked polylines; strokes are turned into solid triangle bands (`SVGLoader.pointsToStroke`) and both are unioned with `polygon-clipping` so every extrusion is watertight, and thin strokes are widened to the configured minimum line width.
3. **Caching**: `getTextShapes`/`getSvgShapes` memoize on a JSON key of their inputs (`fontGen`/`svgGen` counters bump on file uploads) so unrelated slider changes don't recompute 2D geometry.
4. **3D build**: shapes are extruded (`THREE.ExtrudeGeometry`) and combined. There's a **fast path** that avoids CSG entirely when engraved/flush designs share one depth, don't overlap, and stay inside the label outline (punches holes directly into the extruded base shape). Otherwise it falls back to real CSG boolean ops via `three-bvh-csg` (`SUBTRACTION`/`INTERSECTION`). Raised designs sticking outside the label boundary get clipped with an `INTERSECTION` against a prism of the base outline.
5. Everything is z-up in mm; `displayGroup` is rotated -90° on X purely for the preview camera. Exports (`currentParts.base` / `currentParts.design`) always use the unrotated z-up geometry.

Export formats:
- **STL** ([STLExporter](https://threejs.org/docs)) — single combined or base+design as two files.
- **3MF** — hand-built (not a library): `meshTo3mfXml` serializes geometry to the 3MF XML schema, `zipSync` (fflate) packages `3D/3dmodel.model` + `Metadata/model_settings.config`, mapping the base to extruder 1 and the design to extruder 2 so Bambu Studio opens it ready for a 2-color print.

Bundled fonts (Sarabun/Kanit, Thai+Latin) live in `public/fonts/*.ttf` and are fetched + parsed with opentype.js at boot (`loadBundledFonts`); custom uploads go through the same parser and are added as an extra `<option>`.

## Deployment

Static site on Cloudflare Pages (project `chalak-label-studio`), git-connected to `pakornpiam/chalak-3d-label-studio` on GitHub. Pushing to `main` auto-triggers a build (`npm run build`, output `dist`) and deploy — no manual `wrangler pages deploy` step needed.

Node is pinned to 22 via `.node-version` (required for Vite 8 builds on Cloudflare Pages).

## Git Rules (Important — Follow every time)

- Do not work directly on the `master` branch; always create a new branch.
- Branch naming convention: `feature/<short-name>` or `fix/<short-name>`.
- Use the Conventional Commits format for commit messages: `feat:` (new feature) / `fix:` (bug fix) / `refactor:` (code restructuring) / `test:` (adding/updating tests) / `docs:` (documentation updates).
- 1 commit = 1 task (atomic); do not bundle multiple changes into a single commit.
- PR descriptions must include 3 sections: What (what was done) / Why (reason for the change) / Test plan (how it was tested).
