import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { Brush, Evaluator, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import polygonClipping from 'polygon-clipping';
import opentype from 'opentype.js';
import { zipSync, strToU8 } from 'fflate';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const fonts = {}; // name -> opentype.Font
let svgShapesRaw = null; // untransformed filled shapes from the uploaded SVG
let svgStrokesRaw = null; // untransformed stroked polylines from the uploaded SVG
let svgBBox = null;

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal'];

const $ = (id) => document.getElementById(id);

const ui = {
  shape: $('shape'), width: $('width'), height: $('height'), radius: $('radius'),
  baseThickness: $('baseThickness'), hole: $('hole'), holeDia: $('holeDia'),
  border: $('border'), borderWidth: $('borderWidth'), borderHeight: $('borderHeight'),
  text: $('text'), font: $('font'), fontFile: $('fontFile'),
  textSize: $('textSize'), lineSpacing: $('lineSpacing'), textX: $('textX'), textY: $('textY'),
  textMode: $('textMode'), textHeight: $('textHeight'),
  svgFile: $('svgFile'), svgClear: $('svgClear'),
  svgWidth: $('svgWidth'), svgX: $('svgX'), svgY: $('svgY'), svgRot: $('svgRot'), minLine: $('minLine'),
  svgMode: $('svgMode'), svgHeight: $('svgHeight'),
  filename: $('filename'), exportStl: $('exportStl'), exportParts: $('exportParts'), export3mf: $('export3mf'),
  dims: $('dims'), loading: $('loading'),
};

function params() {
  const shape = ui.shape.value;
  const w = +ui.width.value;
  const h = shape === 'circle' ? w : +ui.height.value;
  return {
    shape, w, h,
    r: +ui.radius.value,
    baseTh: +ui.baseThickness.value,
    hole: ui.hole.value,
    holeDia: +ui.holeDia.value,
    border: ui.border.checked,
    borderW: +ui.borderWidth.value,
    borderH: +ui.borderHeight.value,
    text: ui.text.value,
    fontName: ui.font.value,
    textSize: +ui.textSize.value,
    lineSpacing: +ui.lineSpacing.value,
    textX: +ui.textX.value,
    textY: +ui.textY.value,
    textMode: ui.textMode.value,
    textH: +ui.textHeight.value,
    svgW: +ui.svgWidth.value,
    svgX: +ui.svgX.value,
    svgY: +ui.svgY.value,
    svgRot: (+ui.svgRot.value) * Math.PI / 180,
    minLine: +ui.minLine.value,
    svgMode: ui.svgMode.value,
    svgH: +ui.svgHeight.value,
  };
}

// ---------------------------------------------------------------------------
// 2D shape builders (all centered at origin, dimensions in mm)
// ---------------------------------------------------------------------------
function roundedRectShape(w, h, r) {
  r = Math.max(0, Math.min(r, w / 2 - 0.01, h / 2 - 0.01));
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  if (r <= 0.01) {
    s.moveTo(x, y); s.lineTo(x + w, y); s.lineTo(x + w, y + h); s.lineTo(x, y + h);
    s.closePath();
    return s;
  }
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0);
  s.lineTo(x + w, y + h - r);
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  s.lineTo(x + r, y + h);
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  s.closePath();
  return s;
}

function ellipseShape(w, h) {
  const s = new THREE.Shape();
  s.absellipse(0, 0, w / 2, h / 2, 0, Math.PI * 2, false, 0);
  return s;
}

function polygonShape(w, h, sides) {
  const s = new THREE.Shape();
  // flat-top orientation
  const start = Math.PI / sides - Math.PI / 2;
  for (let i = 0; i <= sides; i++) {
    const a = start + (i / sides) * Math.PI * 2;
    const x = Math.cos(a) / Math.cos(Math.PI / sides) * w / 2;
    const y = Math.sin(a) / Math.cos(Math.PI / sides) * h / 2;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

function buildOutline(shape, w, h, r) {
  switch (shape) {
    case 'rect': return roundedRectShape(w, h, 0);
    case 'roundedRect': return roundedRectShape(w, h, r);
    case 'stadium': return roundedRectShape(w, h, h / 2);
    case 'ellipse': return ellipseShape(w, h);
    case 'circle': return ellipseShape(w, w);
    case 'hexagon': return polygonShape(w, h, 6);
    case 'octagon': return polygonShape(w, h, 8);
    default: return roundedRectShape(w, h, r);
  }
}

function holeCenter(p) {
  const m = p.holeDia / 2 + 2.5;
  if (p.hole === 'left') return { x: -p.w / 2 + m, y: 0 };
  if (p.hole === 'right') return { x: p.w / 2 - m, y: 0 };
  if (p.hole === 'top') return { x: 0, y: p.h / 2 - m };
  return null;
}

function buildBaseShape(p) {
  const s = buildOutline(p.shape, p.w, p.h, p.r);
  const hc = holeCenter(p);
  if (hc) {
    const hole = new THREE.Path();
    hole.absarc(hc.x, hc.y, p.holeDia / 2, 0, Math.PI * 2, true);
    s.holes.push(hole);
  }
  return s;
}

function buildBorderShape(p) {
  const b = p.borderW;
  const iw = p.w - 2 * b, ih = p.h - 2 * b;
  if (iw < 2 || ih < 2) return null;
  const outer = buildOutline(p.shape, p.w, p.h, p.r);
  const innerShape = buildOutline(p.shape, iw, ih, Math.max(0, p.r - b));
  const innerPath = new THREE.Path(innerShape.getPoints(48));
  outer.holes.push(innerPath);
  return outer;
}

// ---------------------------------------------------------------------------
// Text -> THREE.Shape[] (opentype.js handles Thai + Latin glyphs)
// ---------------------------------------------------------------------------
function textToShapes(font, p) {
  const lines = p.text.replace(/\r/g, '').split('\n');
  const size = p.textSize;
  const lineH = size * p.lineSpacing;
  const totalH = (lines.length - 1) * lineH;
  const upem = font.unitsPerEm;
  // visual middle of a line relative to its baseline
  const mid = ((font.ascender + font.descender) / 2 / upem) * size;

  const sp = new THREE.ShapePath();
  sp.userData = { style: { fill: '#000', fillOpacity: 1, fillRule: 'nonzero' } };
  let any = false;

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const advW = font.getAdvanceWidth(line, size, { kerning: true });
    const ox = p.textX - advW / 2;
    const baselineY = p.textY + totalH / 2 - i * lineH - mid;
    const path = font.getPath(line, 0, 0, size, { kerning: true, features: true });
    for (const c of path.commands) {
      // opentype is y-down; three.js is y-up -> negate y
      switch (c.type) {
        case 'M': sp.moveTo(ox + c.x, baselineY - c.y); any = true; break;
        case 'L': sp.lineTo(ox + c.x, baselineY - c.y); break;
        case 'Q': sp.quadraticCurveTo(ox + c.x1, baselineY - c.y1, ox + c.x, baselineY - c.y); break;
        case 'C': sp.bezierCurveTo(ox + c.x1, baselineY - c.y1, ox + c.x2, baselineY - c.y2, ox + c.x, baselineY - c.y); break;
        case 'Z': if (sp.currentPath) sp.currentPath.closePath(); break;
      }
    }
  });

  if (!any) return [];
  return SVGLoader.createShapes(sp);
}

// ---------------------------------------------------------------------------
// SVG -> THREE.Shape[] (scaled/rotated/positioned, y flipped to y-up)
// ---------------------------------------------------------------------------
function loadSvg(textContent) {
  const data = new SVGLoader().parse(textContent);
  const shapes = [];
  const strokes = [];
  for (const path of data.paths) {
    const style = path.userData?.style || {};
    if (style.fill && style.fill !== 'none') shapes.push(...SVGLoader.createShapes(path));
    if (style.stroke && style.stroke !== 'none') {
      for (const sp of path.subPaths) {
        const points = sp.getPoints();
        if (points.length >= 2) {
          strokes.push({
            points,
            width: style.strokeWidth || 1,
            cap: style.strokeLineCap || 'butt',
            join: style.strokeLineJoin || 'miter',
            miter: style.strokeMiterLimit || 4,
          });
        }
      }
    }
  }
  if (!shapes.length && !strokes.length) return null;
  const box = new THREE.Box2();
  const v = new THREE.Vector2();
  for (const s of shapes) for (const pt of s.getPoints(24)) box.expandByPoint(v.set(pt.x, pt.y));
  for (const st of strokes) for (const pt of st.points) box.expandByPoint(v.set(pt.x, pt.y));
  return { shapes, strokes, box };
}

function makeSvgTransform(p) {
  const c = svgBBox.getCenter(new THREE.Vector2());
  const size = svgBBox.getSize(new THREE.Vector2());
  const scale = p.svgW / Math.max(size.x, 1e-6);
  const cos = Math.cos(p.svgRot), sin = Math.sin(p.svgRot);
  const fn = (pt) => {
    const x = (pt.x - c.x) * scale;
    const y = -(pt.y - c.y) * scale; // SVG y-down -> y-up
    return new THREE.Vector2(x * cos - y * sin + p.svgX, x * sin + y * cos + p.svgY);
  };
  return { fn, scale };
}

// Fills and stroke bands are unioned in 2D (robust polygon booleans), so the
// SVG becomes plain non-overlapping shapes and every extrusion is watertight.
// Strokes thinner than the "min line width" setting are widened to it.
function buildSvgShapes(p) {
  const { fn, scale } = makeSvgTransform(p);
  const toRing = (pts) => pts.map((v) => [v.x, v.y]);
  const polys = [];

  if (svgShapesRaw) {
    for (const s of svgShapesRaw) {
      const outer = toRing(s.getPoints(12).map(fn));
      const holes = s.holes.map((h) => toRing(h.getPoints(12).map(fn)));
      polys.push([outer, ...holes]);
    }
  }
  if (svgStrokesRaw) {
    for (const st of svgStrokesRaw) {
      try {
        const w = Math.max(st.width * scale, p.minLine);
        const style = SVGLoader.getStrokeStyle(w, '#000', st.join, st.cap, st.miter);
        const band = SVGLoader.pointsToStroke(st.points.map(fn), style);
        if (!band) continue;
        const pos = band.attributes.position;
        const idx = band.index;
        const triCount = (idx ? idx.count : pos.count) / 3;
        for (let t = 0; t < triCount; t++) {
          const tri = [0, 1, 2].map((k) => {
            const vi = idx ? idx.getX(t * 3 + k) : t * 3 + k;
            return [pos.getX(vi), pos.getY(vi)];
          });
          const area = (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1])
                     - (tri[1][1] - tri[0][1]) * (tri[2][0] - tri[0][0]);
          if (Math.abs(area) > 1e-8) polys.push([tri]);
        }
      } catch (err) {
        console.error('stroke band failed:', err);
      }
    }
  }
  if (!polys.length) return [];

  const rawShapes = () => polys.map((pg) => {
    const shape = new THREE.Shape(pg[0].map(([x, y]) => new THREE.Vector2(x, y)));
    shape.holes = pg.slice(1).map((r) => new THREE.Path(r.map(([x, y]) => new THREE.Vector2(x, y))));
    return shape;
  });
  try {
    const mp = polygonClipping.union(...polys.map((pg) => [pg]));
    const shapes = [];
    for (const poly of mp) {
      const shape = new THREE.Shape(poly[0].map(([x, y]) => new THREE.Vector2(x, y)));
      shape.holes = poly.slice(1).map((r) => new THREE.Path(r.map(([x, y]) => new THREE.Vector2(x, y))));
      shapes.push(shape);
    }
    return shapes;
  } catch (err) {
    console.error('2D union failed, using raw outlines:', err);
    return rawShapes();
  }
}

// ---------------------------------------------------------------------------
// 3D build
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1420);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
camera.position.set(0, 110, 90);

const renderer = new THREE.WebGLRenderer({ canvas: $('canvas3d'), antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x334466, 1.1));
const dir1 = new THREE.DirectionalLight(0xffffff, 1.6);
dir1.position.set(60, 120, 80);
scene.add(dir1);
const dir2 = new THREE.DirectionalLight(0x88aaff, 0.5);
dir2.position.set(-80, 60, -60);
scene.add(dir2);

const grid = new THREE.GridHelper(300, 30, 0x2a3550, 0x1d2639);
grid.position.y = -0.05;
scene.add(grid);

// display group is rotated so the label lies flat on the grid (z-up -> y-up view)
const displayGroup = new THREE.Group();
displayGroup.rotation.x = -Math.PI / 2;
scene.add(displayGroup);

const matBase = new THREE.MeshStandardMaterial({ color: 0x4f8ef7, roughness: 0.55, metalness: 0.05 });
const matDesign = new THREE.MeshStandardMaterial({ color: 0xf7b84f, roughness: 0.5, metalness: 0.05 });

// exportable geometries of the current model (z-up, mm)
let currentParts = { base: null, design: null };

function extrude(shapes, depth, curveSegments = 6) {
  if (!shapes || !shapes.length) return null;
  return new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false, curveSegments });
}

function brushOf(geometry) {
  const b = new Brush(geometry);
  b.updateMatrixWorld();
  return b;
}

function csg(geomA, geomB, op) {
  const result = evaluator.evaluate(brushOf(geomA), brushOf(geomB), op);
  return result.geometry;
}

// --- geometry caches: only recompute 2D outlines when their own inputs change
let fontGen = 0, svgGen = 0;
let textCache = { key: null, shapes: [] };
let svgCache = { key: null, shapes: [] };

function getTextShapes(font, p) {
  const key = JSON.stringify([p.text, p.fontName, fontGen, p.textSize, p.lineSpacing, p.textX, p.textY]);
  if (textCache.key !== key) textCache = { key, shapes: textToShapes(font, p) };
  return textCache.shapes;
}

function getSvgShapes(p) {
  if (!svgBBox) return [];
  const key = JSON.stringify([svgGen, p.svgW, p.svgX, p.svgY, p.svgRot, p.minLine]);
  if (svgCache.key !== key) svgCache = { key, shapes: buildSvgShapes(p) };
  return svgCache.shapes;
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// label outlines are convex, so "all outer contour points inside" => whole design inside
function designInsideLabel(shapes, outlinePts, hc, holeR) {
  const hcV = hc ? new THREE.Vector2(hc.x, hc.y) : null;
  for (const s of shapes) {
    const pts = s.getPoints(6);
    for (const pt of pts) if (!pointInPolygon(pt, outlinePts)) return false;
    if (hcV && new THREE.Box2().setFromPoints(pts).distanceToPoint(hcV) < holeR + 0.6) return false;
  }
  return true;
}

function bboxOfShapes(shapes) {
  const b = new THREE.Box2();
  for (const s of shapes) for (const pt of s.getPoints(4)) b.expandByPoint(pt);
  return b;
}

let lastBuildMs = 0;

function rebuild() {
  const t0 = performance.now();
  const p = params();
  const font = fonts[p.fontName] || Object.values(fonts)[0];
  if (!font) return;

  // clamp engrave/inlay depth so it never goes through the base
  const clampDepth = (h) => Math.min(h, Math.max(0.2, p.baseTh - 0.2));

  // --- 2D shapes: text and SVG are independent groups with their own style
  const groups = [];
  const textShapes = getTextShapes(font, p);
  if (textShapes.length) {
    groups.push({ shapes: textShapes, mode: p.textMode, h: p.textMode === 'raised' ? p.textH : clampDepth(p.textH) });
  }
  const svgShapes = getSvgShapes(p);
  if (svgShapes.length) {
    groups.push({ shapes: svgShapes, mode: p.svgMode, h: p.svgMode === 'raised' ? p.svgH : clampDepth(p.svgH) });
  }

  const baseShape = buildBaseShape(p);
  const outlinePts = buildOutline(p.shape, p.w, p.h, p.r).getPoints(48);
  const hc = holeCenter(p);
  for (const grp of groups) {
    grp.inside = designInsideLabel(grp.shapes, outlinePts, hc, p.holeDia / 2);
  }

  const maxRaised = Math.max(0, ...groups.filter((g) => g.mode === 'raised').map((g) => g.h));
  // clip volume for designs that stick out past the label edge — built only when needed
  let prismGeom = null;
  const prism = () => (prismGeom ??= extrude([baseShape], p.baseTh + maxRaised + 20, 12));

  // --- base solid, with engraved/flush cavities carved in
  const carve = groups.filter((g) => g.mode !== 'raised');
  const sameDepth = carve.length > 0 && carve.every((g) => Math.abs(g.h - carve[0].h) < 1e-6);
  const noCross = carve.length < 2 || !bboxOfShapes(carve[0].shapes).intersectsBox(bboxOfShapes(carve[1].shapes));
  let baseGeom;

  if (carve.length && sameDepth && noCross && carve.every((g) => g.inside)) {
    // fast path (no CSG): bottom slab + top layer where the design outlines are
    // holes, and glyph counters (holes-in-holes) come back as solid islands
    const d = carve[0].h;
    const bottom = extrude([baseShape], p.baseTh - d, 12);
    const topShape = buildBaseShape(p);
    const islands = [];
    for (const g of carve) {
      for (const s of g.shapes) {
        topShape.holes.push(new THREE.Path(s.getPoints(8)));
        for (const h of s.holes) islands.push(new THREE.Shape(h.getPoints(8)));
      }
    }
    const top = extrude([topShape, ...islands], d, 12);
    top.translate(0, 0, p.baseTh - d);
    baseGeom = mergeGeoms(bottom, top);
  } else {
    baseGeom = extrude([baseShape], p.baseTh, 12);
    for (const g of carve) {
      try {
        const cutter = extrude(g.shapes, g.h + 0.1);
        cutter.translate(0, 0, p.baseTh - g.h);
        baseGeom = csg(baseGeom, cutter, SUBTRACTION);
      } catch (err) {
        console.error('CSG failed:', err);
      }
    }
  }

  // --- design solids (raised + flush inlays); CSG clip only when sticking out
  let designGeom = null;
  const addDesign = (g) => { designGeom = designGeom ? mergeGeoms(designGeom, g) : g; };
  for (const grp of groups) {
    if (grp.mode === 'engraved') continue;
    try {
      let g = extrude(grp.shapes, grp.h);
      g.translate(0, 0, grp.mode === 'raised' ? p.baseTh : p.baseTh - grp.h);
      if (!grp.inside) g = csg(g, prism(), INTERSECTION);
      addDesign(g);
    } catch (err) {
      console.error('CSG failed:', err);
    }
  }

  // --- raised border ring (belongs to the design/accent part)
  if (p.border) {
    const ringShape = buildBorderShape(p);
    if (ringShape) {
      let ringGeom = extrude([ringShape], p.borderH, 12);
      ringGeom.translate(0, 0, p.baseTh);
      // the hole sits 2.5 mm in from the edge, so the ring only reaches it when wider
      if (hc && p.borderW > 2.4) {
        const cyl = new THREE.CylinderGeometry(p.holeDia / 2, p.holeDia / 2, p.borderH + 2, 32);
        cyl.rotateX(Math.PI / 2);
        cyl.translate(hc.x, hc.y, p.baseTh + p.borderH / 2);
        try { ringGeom = csg(ringGeom, cyl, SUBTRACTION); } catch (e) { console.error(e); }
      }
      designGeom = designGeom ? mergeGeoms(designGeom, ringGeom) : ringGeom;
    }
  }

  // --- update scene
  for (let i = displayGroup.children.length - 1; i >= 0; i--) {
    const child = displayGroup.children[i];
    child.geometry.dispose();
    displayGroup.remove(child);
  }
  displayGroup.add(new THREE.Mesh(baseGeom, matBase));
  if (designGeom) displayGroup.add(new THREE.Mesh(designGeom, matDesign));

  currentParts = { base: baseGeom, design: designGeom };

  lastBuildMs = performance.now() - t0;
  const topH = p.baseTh + Math.max(maxRaised, p.border ? p.borderH : 0);
  ui.dims.textContent = `${p.w} × ${p.h} mm — total height ${topH.toFixed(1)} mm — ${lastBuildMs.toFixed(0)} ms`;
  ui.exportParts.disabled = !designGeom;
}

function mergeGeoms(a, b) {
  // simple concatenation of two non-indexed position/normal geometries
  const geoms = [a, b].map((g) => (g.index ? g.toNonIndexed() : g));
  const total = geoms.reduce((n, g) => n + g.attributes.position.count, 0);
  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const arr = new Float32Array(total * 3);
    let off = 0;
    for (const g of geoms) {
      arr.set(g.attributes[name].array, off);
      off += g.attributes[name].array.length;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function saveStl(geometries, filename) {
  const exportScene = new THREE.Scene();
  for (const g of geometries) if (g) exportScene.add(new THREE.Mesh(g));
  const data = new STLExporter().parse(exportScene, { binary: true });
  const blob = new Blob([data], { type: 'model/stl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function safeName() {
  return (ui.filename.value.trim() || 'label').replace(/[^\w฀-๿.-]+/g, '_');
}

// --- 3MF export: one object with two parts, extruder 1 = base, extruder 2 = design.
// Bambu Studio reads the part/extruder mapping from Metadata/model_settings.config.
function meshTo3mfXml(geom) {
  const pos = geom.attributes.position;
  const idx = geom.index;
  const triCount = (idx ? idx.count : pos.count) / 3;
  const map = new Map();
  const verts = [];
  const tris = [];
  const vertexFor = (i) => {
    const x = pos.getX(i).toFixed(3), y = pos.getY(i).toFixed(3), z = pos.getZ(i).toFixed(3);
    const key = `${x},${y},${z}`;
    let vi = map.get(key);
    if (vi === undefined) {
      vi = verts.length;
      verts.push(`<vertex x="${x}" y="${y}" z="${z}"/>`);
      map.set(key, vi);
    }
    return vi;
  };
  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    const a = vertexFor(idx ? idx.getX(i) : i);
    const b = vertexFor(idx ? idx.getX(i + 1) : i + 1);
    const c = vertexFor(idx ? idx.getX(i + 2) : i + 2);
    if (a !== b && b !== c && a !== c) tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
  }
  return `<mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh>`;
}

function export3mf() {
  const parts = [{ geom: currentParts.base, name: 'base', extruder: 1 }];
  if (currentParts.design) parts.push({ geom: currentParts.design, name: 'design', extruder: 2 });
  const asmId = parts.length + 1;

  const objectsXml = parts
    .map((pt, i) => `<object id="${i + 1}" type="model">${meshTo3mfXml(pt.geom)}</object>`)
    .join('\n');
  const componentsXml = parts.map((_, i) => `<component objectid="${i + 1}"/>`).join('');

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">BambuStudio-01.10.00.00</metadata>
<metadata name="BambuStudio:3mfVersion">1</metadata>
<resources>
${objectsXml}
<object id="${asmId}" type="model"><components>${componentsXml}</components></object>
</resources>
<build><item objectid="${asmId}" printable="1"/></build>
</model>`;

  const settings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${asmId}">
    <metadata key="name" value="${safeName()}"/>
${parts.map((pt, i) => `    <part id="${i + 1}" subtype="normal_part">
      <metadata key="name" value="${pt.name}"/>
      <metadata key="extruder" value="${pt.extruder}"/>
    </part>`).join('\n')}
  </object>
</config>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
<Default Extension="config" ContentType="text/xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  const zipped = zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/model_settings.config': strToU8(settings),
  }, { level: 4 });

  const blob = new Blob([zipped], { type: 'model/3mf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeName()}.3mf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

ui.export3mf.addEventListener('click', () => {
  if (currentParts.base) export3mf();
});

ui.exportStl.addEventListener('click', () => {
  saveStl([currentParts.base, currentParts.design], `${safeName()}.stl`);
});

ui.exportParts.addEventListener('click', () => {
  saveStl([currentParts.base], `${safeName()}-base.stl`);
  if (currentParts.design) {
    setTimeout(() => saveStl([currentParts.design], `${safeName()}-design.stl`), 300);
  }
});

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  // adapt to how long the last build took, so heavy CSG scenes don't pile up
  const delay = Math.min(400, Math.max(100, lastBuildMs * 1.5));
  rebuildTimer = setTimeout(rebuild, delay);
}

function syncVisibility() {
  const shape = ui.shape.value;
  $('heightRow').hidden = shape === 'circle';
  $('radiusRow').hidden = shape !== 'roundedRect';
  $('holeDiaRow').hidden = ui.hole.value === 'none';
  $('borderRows').hidden = !ui.border.checked;
  $('svgRows').hidden = !svgShapesRaw;
  ui.svgClear.hidden = !svgShapesRaw;

  const hints = {
    raised: 'Raised: sticks up above the label surface — adjust its thickness freely.',
    engraved: 'Engraved: carved down into the label.',
    flush: 'Flush: embedded level with the label surface (เรียบเสมอผิว) — ideal for 2-color prints via parts export or a slicer color change.',
  };
  $('textHeightLabel').firstChild.textContent =
    ui.textMode.value === 'raised' ? 'Text thickness (mm) ' : 'Text depth (mm) ';
  $('textModeHint').textContent = hints[ui.textMode.value];
  $('svgHeightLabel').firstChild.textContent =
    ui.svgMode.value === 'raised' ? 'Logo thickness (mm) ' : 'Logo depth (mm) ';
}

for (const el of document.querySelectorAll('input, select, textarea')) {
  el.addEventListener('input', () => {
    const out = $(el.id + 'Out');
    if (out) out.textContent = el.value;
    syncVisibility();
    scheduleRebuild();
  });
}

ui.fontFile.addEventListener('change', async () => {
  const file = ui.fontFile.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const font = opentype.parse(buf);
    fonts.custom = font;
    fontGen++;
    let opt = ui.font.querySelector('option[value="custom"]');
    if (!opt) {
      opt = document.createElement('option');
      opt.value = 'custom';
      ui.font.appendChild(opt);
    }
    opt.textContent = `★ ${file.name.replace(/\.(ttf|otf)$/i, '')}`;
    ui.font.value = 'custom';
    scheduleRebuild();
  } catch (err) {
    alert('Could not read this font file / อ่านไฟล์ฟอนต์ไม่ได้');
    console.error(err);
  }
});

ui.svgFile.addEventListener('change', async () => {
  const file = ui.svgFile.files[0];
  if (!file) return;
  try {
    const parsed = loadSvg(await file.text());
    if (!parsed) {
      alert('No paths found in this SVG. Convert text/objects to paths first (e.g. in Inkscape: Path → Object to Path).');
      return;
    }
    svgShapesRaw = parsed.shapes;
    svgStrokesRaw = parsed.strokes;
    svgBBox = parsed.box;
    svgGen++;
    syncVisibility();
    scheduleRebuild();
  } catch (err) {
    alert('Could not read this SVG / อ่านไฟล์ SVG ไม่ได้');
    console.error(err);
  }
});

ui.svgClear.addEventListener('click', () => {
  svgShapesRaw = null;
  svgStrokesRaw = null;
  svgBBox = null;
  svgGen++;
  ui.svgFile.value = '';
  syncVisibility();
  scheduleRebuild();
});

// ---------------------------------------------------------------------------
// Render loop + resize
// ---------------------------------------------------------------------------
function resize() {
  const el = $('viewport');
  const w = el.clientWidth, h = el.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// Boot: load bundled fonts, then first build
// ---------------------------------------------------------------------------
async function loadBundledFonts() {
  const names = ['Sarabun-Regular', 'Sarabun-Bold', 'Kanit-Regular', 'Kanit-Bold'];
  await Promise.all(names.map(async (n) => {
    const res = await fetch(`/fonts/${n}.ttf`);
    fonts[n] = opentype.parse(await res.arrayBuffer());
  }));
}

loadBundledFonts()
  .then(() => {
    ui.loading.classList.add('hidden');
    syncVisibility();
    rebuild();
  })
  .catch((err) => {
    ui.loading.textContent = 'Failed to load fonts — check console';
    console.error(err);
  });
