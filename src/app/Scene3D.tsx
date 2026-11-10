import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Member, MemberType, SiteModel } from "../kernel/site";

export type LayerKey = MemberType | "grid" | "walls" | "cranes";
export type ViewName = "iso" | "plan" | "sw" | "ne";

export interface SceneCrane {
  id: string;
  label: string;
  x: number;
  z: number;
  color: string;
  /** Radius of the coverage ring, m. null = no ring. */
  ringM: number | null;
}

interface Props {
  model: SiteModel | null;
  cranes: SceneCrane[];
  /** Colour per member id. Members not in the map are drawn in the "out" colour. null = colour by type. */
  colors: Map<string, string> | null;
  selectedId: string | null;
  hiddenLayers: Set<LayerKey>;
  /** Line from a crane to the selected piece, drawn as boom and hoist line. */
  boom: { craneId: string; target: [number, number, number]; tipHeightM: number } | null;
  view: { name: ViewName; n: number };
  onSelect: (target: { kind: "member"; id: string } | { kind: "crane"; id: string } | null) => void;
  onMoveCrane: (id: string, x: number, z: number) => void;
}

export const TYPE_COLOR: Record<MemberType, string> = { column: "#b5532f", beam: "#3f6789", brace: "#2e8b6e", joist: "#b8902c" };
const OUT_COLOR = "#aab3ba";
const SELECT_COLOR = "#1f9bd6";
const SNAP_M = 0.3048;
const AXIS_Z = new THREE.Vector3(0, 0, 1);

function bubble(text: string, ring: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.arc(64, 64, 56, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 7;
  g.strokeStyle = ring;
  g.stroke();
  g.fillStyle = "#1d2730";
  g.font = `600 ${text.length > 2 ? 34 : 44}px "IBM Plex Sans Condensed", Arial, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 64, 67);
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
}

function dispose(group: THREE.Object3D) {
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    mats.forEach((x) => {
      (x as THREE.SpriteMaterial).map?.dispose();
      x.dispose();
    });
  });
  group.clear();
}

interface Piece {
  member: Member;
  pick: THREE.Mesh;
  /** The material whose colour shows the piece (mesh material, or the truss line material for joists). */
  paint: THREE.MeshStandardMaterial | THREE.LineBasicMaterial;
}

function buildMember(m: Member, group: THREE.Group): Piece {
  const a = new THREE.Vector3(...m.a);
  const b = new THREE.Vector3(...m.b);
  const len = a.distanceTo(b);
  const dir = b.clone().sub(a).normalize();
  const mid = a.clone().add(b).multiplyScalar(0.5);
  if (m.ref === "top") mid.y -= m.depthM / 2;
  const quat = new THREE.Quaternion().setFromUnitVectors(AXIS_Z, dir);

  if (m.type === "joist") {
    // Simplified Warren truss: chords plus diagonals, with an invisible box for picking.
    const d = m.depthM;
    const n = Math.max(2, Math.round(len / (Math.max(d, 0.5) * 1.4)));
    const P = (t: number) => a.clone().lerp(b, t);
    const drop = (p: THREE.Vector3) => p.clone().setY(p.y - d);
    const pts: THREE.Vector3[] = [a, b, drop(a), drop(b)];
    for (let i = 0; i < n; i++) {
      const low = drop(P((i + 0.5) / n));
      pts.push(P(i / n), low, low, P((i + 1) / n));
    }
    const paint = new THREE.LineBasicMaterial({ color: TYPE_COLOR.joist });
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), paint));
    const pick = new THREE.Mesh(new THREE.BoxGeometry(0.25, d, len), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    pick.position.copy(mid);
    pick.quaternion.copy(quat);
    group.add(pick);
    return { member: m, pick, paint };
  }

  const paint = new THREE.MeshStandardMaterial({ color: TYPE_COLOR[m.type], roughness: 0.6, metalness: 0.25 });
  const pick = new THREE.Mesh(new THREE.BoxGeometry(m.widthM, m.depthM, len), paint);
  pick.position.copy(mid);
  pick.quaternion.copy(quat);
  group.add(pick);
  if (m.type === "column") {
    const low = a.y <= b.y ? a : b;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(m.widthM + 0.12, 0.025, m.depthM + 0.12), paint);
    plate.position.set(low.x, low.y + 0.0125, low.z);
    group.add(plate);
  }
  return { member: m, pick, paint };
}

export function Scene3D({ model, cranes, colors, selectedId, hiddenLayers, boom, view, onSelect, onMoveCrane }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    layers: Record<LayerKey, THREE.Group>;
    boomGroup: THREE.Group;
    pieces: Map<string, Piece>;
    cranePicks: THREE.Mesh[];
    centre: THREE.Vector3;
    span: number;
  } | null>(null);
  const live = useRef({ onSelect, onMoveCrane, cranes });
  live.current = { onSelect, onMoveCrane, cranes };

  // Renderer, camera, controls and pointer handling — once.
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#e3e9ee");
    const camera = new THREE.PerspectiveCamera(40, 1, 0.2, 2000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(-30, 60, -20);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(40, 20, 60);
    scene.add(fill);

    const keys: LayerKey[] = ["column", "beam", "brace", "joist", "grid", "walls", "cranes"];
    const layers = Object.fromEntries(keys.map((k) => [k, new THREE.Group()])) as Record<LayerKey, THREE.Group>;
    keys.forEach((k) => scene.add(layers[k]));
    const boomGroup = new THREE.Group();
    scene.add(boomGroup);
    const state = { renderer, scene, camera, controls, layers, boomGroup, pieces: new Map<string, Piece>(), cranePicks: [] as THREE.Mesh[], centre: new THREE.Vector3(), span: 30 };
    three.current = state;

    const ray = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hitPoint = new THREE.Vector3();
    let down: [number, number] | null = null;
    let drag: { id: string; dx: number; dz: number; moved: boolean } | null = null;

    const aim = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ptr, camera);
    };
    const onDown = (e: PointerEvent) => {
      down = [e.clientX, e.clientY];
      if (!layers.cranes.visible) return;
      aim(e);
      const hit = ray.intersectObjects(state.cranePicks, false)[0];
      if (!hit) return;
      const id = hit.object.userData.craneId as string;
      const c = live.current.cranes.find((k) => k.id === id);
      if (!c || !ray.ray.intersectPlane(ground, hitPoint)) return;
      drag = { id, dx: hitPoint.x - c.x, dz: hitPoint.z - c.z, moved: false };
      controls.enabled = false;
      renderer.domElement.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      aim(e);
      if (!ray.ray.intersectPlane(ground, hitPoint)) return;
      const snap = (v: number) => Math.round(v / SNAP_M) * SNAP_M;
      drag.moved = true;
      live.current.onMoveCrane(drag.id, snap(hitPoint.x - drag.dx), snap(hitPoint.z - drag.dz));
    };
    const onUp = (e: PointerEvent) => {
      const wasDrag = drag;
      if (drag) {
        drag = null;
        controls.enabled = true;
        el.style.cursor = "";
      }
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      if (wasDrag) return live.current.onSelect({ kind: "crane", id: wasDrag.id });
      aim(e);
      const picks = [...state.pieces.values()].filter((p) => layers[p.member.type].visible).map((p) => p.pick);
      const hit = ray.intersectObjects(picks, false)[0];
      live.current.onSelect(hit ? { kind: "member", id: hit.object.userData.memberId as string } : null);
    };
    const dom = renderer.domElement;
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerup", onUp);
    dom.addEventListener("pointercancel", onUp);

    const resize = () => {
      const w = el.clientWidth;
      const h = Math.max(el.clientHeight, 1);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointercancel", onUp);
      dispose(scene);
      controls.dispose();
      renderer.dispose();
      dom.remove();
      three.current = null;
    };
  }, []);

  // Steel, grids and walls — rebuilt when the model changes.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    (["column", "beam", "brace", "joist", "grid", "walls"] as LayerKey[]).forEach((k) => dispose(t.layers[k]));
    t.pieces.clear();
    const box = new THREE.Box3();
    if (model) {
      for (const m of model.members) {
        const piece = buildMember(m, t.layers[m.type]);
        piece.pick.userData.memberId = m.id;
        t.pieces.set(m.id, piece);
        box.expandByPoint(new THREE.Vector3(...m.a)).expandByPoint(new THREE.Vector3(...m.b));
      }
      for (const w of model.walls) {
        const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, w.y1 - w.y0, 0.2), new THREE.MeshStandardMaterial({ color: "#c9bfae", transparent: true, opacity: 0.22, depthWrite: false }));
        mesh.position.set((w.a[0] + w.b[0]) / 2, (w.y0 + w.y1) / 2, (w.a[1] + w.b[1]) / 2);
        mesh.rotation.y = -Math.atan2(w.b[1] - w.a[1], w.b[0] - w.a[0]);
        t.layers.walls.add(mesh);
      }
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 6, 10));
    const size = box.getSize(new THREE.Vector3());
    t.centre = box.getCenter(new THREE.Vector3());
    t.span = Math.max(size.x, size.z, 12);
    const pad = t.span * 0.25;
    const dash = new THREE.LineDashedMaterial({ color: "#2f6fa3", dashSize: 1, gapSize: 0.5, transparent: true, opacity: 0.65 });
    const line = (p: THREE.Vector3, q: THREE.Vector3) => {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, q]), dash);
      l.computeLineDistances();
      t.layers.grid.add(l);
    };
    for (const g of model?.gridsX ?? []) {
      line(new THREE.Vector3(g.pos, 0.02, box.min.z - pad), new THREE.Vector3(g.pos, 0.02, box.max.z + pad));
      const s = bubble(g.name, "#2f6fa3");
      s.scale.setScalar(t.span * 0.045);
      s.position.set(g.pos, 0.02, box.min.z - pad - t.span * 0.03);
      t.layers.grid.add(s);
    }
    for (const g of model?.gridsZ ?? []) {
      line(new THREE.Vector3(box.min.x - pad, 0.02, g.pos), new THREE.Vector3(box.max.x + pad, 0.02, g.pos));
      const s = bubble(g.name, "#2f6fa3");
      s.scale.setScalar(t.span * 0.045);
      s.position.set(box.min.x - pad - t.span * 0.03, 0.02, g.pos);
      t.layers.grid.add(s);
    }
    const slab = new THREE.Mesh(new THREE.PlaneGeometry(size.x + pad * 4, size.z + pad * 4), new THREE.MeshStandardMaterial({ color: "#d3dbe1", transparent: true, opacity: 0.4, depthWrite: false }));
    slab.rotation.x = -Math.PI / 2;
    slab.position.set(t.centre.x, -0.01, t.centre.z);
    t.layers.grid.add(slab);
    const north = bubble("N", "#17191c");
    north.scale.setScalar(t.span * 0.04);
    north.position.set(box.max.x + pad, 0.02, box.min.z - pad - t.span * 0.03);
    t.layers.grid.add(north);
    setView(t, "iso");
  }, [model]);

  // Piece colours and selection highlight.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    for (const [id, p] of t.pieces) {
      const c = id === selectedId ? SELECT_COLOR : colors ? (colors.get(id) ?? OUT_COLOR) : TYPE_COLOR[p.member.type];
      p.paint.color.set(c);
      if (p.paint instanceof THREE.MeshStandardMaterial) p.paint.emissive.set(id === selectedId ? "#0d4a73" : "#000000");
    }
  }, [colors, selectedId, model]);

  // Cranes: pad, mast, coverage ring and label.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    dispose(t.layers.cranes);
    t.cranePicks = [];
    for (const c of cranes) {
      const col = new THREE.Color(c.color);
      const pad = new THREE.Mesh(new THREE.BoxGeometry(6, 0.1, 6), new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.6 }));
      pad.position.set(c.x, 0.05, c.z);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 9, 12), new THREE.MeshStandardMaterial({ color: col }));
      mast.position.set(c.x, 4.5, c.z);
      for (const m of [pad, mast]) {
        m.userData.craneId = c.id;
        t.layers.cranes.add(m);
        t.cranePicks.push(m);
      }
      if (c.ringM) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(c.ringM - 0.12, c.ringM + 0.12, 160), new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(c.x, 0.06, c.z);
        const disc = new THREE.Mesh(new THREE.CircleGeometry(c.ringM, 96), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }));
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(c.x, 0.04, c.z);
        t.layers.cranes.add(ring, disc);
      }
      const tag = bubble(c.label, c.color);
      tag.scale.setScalar(Math.max(1.6, t.span * 0.04));
      tag.position.set(c.x, 10.2, c.z);
      t.layers.cranes.add(tag);
    }
  }, [cranes, model]);

  // Boom and hoist line to the selected piece.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    dispose(t.boomGroup);
    const c = boom && cranes.find((k) => k.id === boom.craneId);
    if (!boom || !c) return;
    const tip = new THREE.Vector3(boom.target[0], Math.max(boom.tipHeightM, boom.target[1] + 2), boom.target[2]);
    const mat = new THREE.LineBasicMaterial({ color: c.color });
    t.boomGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(c.x, 2, c.z), tip]), mat));
    const hoist = new THREE.Line(new THREE.BufferGeometry().setFromPoints([tip, new THREE.Vector3(...boom.target)]), new THREE.LineDashedMaterial({ color: "#17191c", dashSize: 0.4, gapSize: 0.25 }));
    hoist.computeLineDistances();
    t.boomGroup.add(hoist);
  }, [boom, cranes]);

  useEffect(() => {
    const t = three.current;
    if (!t) return;
    (Object.keys(t.layers) as LayerKey[]).forEach((k) => (t.layers[k].visible = !hiddenLayers.has(k)));
    t.boomGroup.visible = !hiddenLayers.has("cranes");
  }, [hiddenLayers, model]);

  useEffect(() => {
    if (three.current) setView(three.current, view.name);
  }, [view]);

  return <div ref={host} className="stage-canvas" />;
}

function setView(t: { camera: THREE.PerspectiveCamera; controls: OrbitControls; centre: THREE.Vector3; span: number }, name: ViewName) {
  const s = t.span * 1.05;
  const offsets: Record<ViewName, [number, number, number]> = { iso: [-1.0, 0.95, -1.15], plan: [0, 2.3, 0.001], sw: [-0.95, 0.5, 1.5], ne: [1.5, 0.6, -1.0] };
  const [x, y, z] = offsets[name];
  t.controls.target.copy(t.centre);
  t.camera.position.set(t.centre.x + x * s, t.centre.y + y * s, t.centre.z + z * s);
  t.controls.update();
}
