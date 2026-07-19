# Chalak — ฉลาก 3D Label Studio

Design 3D-printable labels with Thai + English text and SVG logos, preview them in 3D, and export STL files for your slicer (e.g. Bambu Studio).

## Run / วิธีใช้งาน

```
npm install
npm run dev
```

Then open http://localhost:5173

## Features

- **Shapes**: rounded rectangle, rectangle, stadium (pill), ellipse, circle, hexagon, octagon
- **Adjustable**: width, height, corner radius, thickness, hanging hole, raised border
- **Text**: Thai + English (Sarabun / Kanit bundled, upload your own .ttf/.otf), multi-line, size, spacing, position
- **SVG logo**: upload a filled-path SVG, scale/move/rotate it (convert strokes & text to paths first, e.g. Inkscape → Path → Object to Path)
- **Design styles** (set independently for text and logo, each with its own thickness/depth):
  - *Raised* — sticks up from the surface, adjustable thickness
  - *Engraved* — carved into the surface
  - *Flush* — embedded level with the top surface (great for 2-color prints)
- **Export** (units are mm):
  - **3MF (2 colors)** — opens in Bambu Studio as one object with base on filament 1 and text/logo on filament 2, ready to slice
  - single STL (one piece)
  - base + design as separate STLs

## Tech

Vite + Three.js (preview, extrusion, STL export), opentype.js (font outlines incl. Thai), three-bvh-csg (engrave/inlay boolean operations).
