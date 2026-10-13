// Scene variants for isolating the Incanto white-frame bug (README, Known issue).
// "background only" and "drew something" are distinguishable.
import * as fs from "node:fs";
const out = process.argv[2] ?? ".cache/lab/app/public/scenes";
const tpl = JSON.parse(fs.readFileSync(`${out}/template.json`, "utf8"));

function minimal({ recv = false, cast = false, light = false, size, preset = false }) {
  const lightProps = { position: [10, 20, 10], intensity: 1.5 };
  if (light) lightProps.castShadow = true;
  if (light && size) lightProps.shadowMapSize = size;
  return {
    format: 1, type: "scene", dimension: "3d", name: "Min",
    environment: { ...(preset ? { preset: "sunset" } : {}), ambient: { color: "#ffffff", intensity: 0.5 }, background: "#87ceeb" },
    root: { name: "Root", type: "Node3D", uid: "n_lab_root_0000000", children: [
      { name: "Floor", type: "MeshInstance3D", uid: "n_lab_floor_0000000", props: { mesh: "box", size: [20, 0.1, 20], position: [0, -0.05, 0], material: { color: "#3f7f3f" }, ...(recv ? { receiveShadow: true } : {}) } },
      { name: "Cube", type: "MeshInstance3D", uid: "n_lab_cube_0000000", props: { mesh: "box", size: [1, 1, 1], position: [0, 0.5, 0], material: { color: "#d04040" }, ...(cast ? { castShadow: true } : {}) } },
      { name: "Sun", type: "DirectionalLight3D", uid: "n_lab_sun_0000000", props: lightProps },
      { name: "Camera", type: "Camera3D", uid: "n_lab_camera_0000000", props: { position: [0, 3, 6], fov: 60, current: true } },
    ] },
  };
}
const V = {
  "min-none": {},
  "min-recv": { recv: true },
  "min-cast": { cast: true },
  "min-light": { light: true },
  "min-light-1024": { light: true, size: 1024 },
  "min-light-4096": { light: true, size: 4096 },
  "min-cast-light": { cast: true, light: true },
  "min-recv-light": { recv: true, light: true },
  "min-all": { recv: true, cast: true, light: true },
  "min-all-1024": { recv: true, cast: true, light: true, size: 1024 },
  "min-all-2048": { recv: true, cast: true, light: true, size: 2048 },
  "min-all-4096": { recv: true, cast: true, light: true, size: 4096 },
  "min-preset": { preset: true },
  "min-preset-all": { preset: true, recv: true, cast: true, light: true },
};
for (const [k, v] of Object.entries(V)) fs.writeFileSync(`${out}/${k}.json`, JSON.stringify(minimal(v), null, 1));

// Template variants: strip one thing at a time.
const clone = () => JSON.parse(JSON.stringify(tpl));
const walk = (n, f) => { f(n); for (const c of n.children ?? []) walk(c, f); };
const setShadow = (s, which, val) => walk(s.root, (n) => { if (n.props && which in n.props) n.props[which] = val; });
let s;
s = clone(); setShadow(s, "receiveShadow", false); setShadow(s, "castShadow", false); fs.writeFileSync(`${out}/tpl-noshadow.json`, JSON.stringify(s));
s = clone(); setShadow(s, "receiveShadow", false); fs.writeFileSync(`${out}/tpl-norecv.json`, JSON.stringify(s));
s = clone(); walk(s.root, (n) => { if (n.type === "DirectionalLight3D") n.props.castShadow = false; }); fs.writeFileSync(`${out}/tpl-nolightshadow.json`, JSON.stringify(s));
s = clone(); walk(s.root, (n) => { if (n.type === "ModelInstance3D") n.props.castShadow = false; }); fs.writeFileSync(`${out}/tpl-nomodelcast.json`, JSON.stringify(s));
s = clone(); walk(s.root, (n) => { if (n.type === "DirectionalLight3D") delete n.props.shadowMapSize; }); fs.writeFileSync(`${out}/tpl-defaultsize.json`, JSON.stringify(s));
s = clone(); walk(s.root, (n) => { if (n.type === "DirectionalLight3D") n.props.shadowMapSize = 2048; }); fs.writeFileSync(`${out}/tpl-2048.json`, JSON.stringify(s));
s = clone(); walk(s.root, (n) => { if (n.type === "DirectionalLight3D") n.props.shadowMapSize = 1024; }); fs.writeFileSync(`${out}/tpl-1024.json`, JSON.stringify(s));
s = clone(); delete s.environment.preset; fs.writeFileSync(`${out}/tpl-nopreset.json`, JSON.stringify(s));
s = clone(); s.environment.background = "#87ceeb"; fs.writeFileSync(`${out}/tpl-bluebg.json`, JSON.stringify(s));
console.log(fs.readdirSync(out).length, "scenes");
