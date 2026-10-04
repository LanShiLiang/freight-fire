import * as THREE from './vendor/three.module.js';

// All art in this file is original procedural geometry and canvas painting.
// Dimensions are metres. Weapons point towards -Z; characters stand on Y = 0.
const cube = new THREE.BoxGeometry(1, 1, 1);
const cylinder = new THREE.CylinderGeometry(1, 1, 1, 10);
const sphere = new THREE.SphereGeometry(1, 12, 8);
const capsule = new THREE.CapsuleGeometry(1, 1, 3, 8);
const palettes = {
  steel: '#4b5152', dark: '#171d21', metal: '#374048', rubber: '#15181b',
  wood: '#7b5430', tan: '#b6a687', blue: '#546372', olive: '#65705b',
};
const materialCache = new Map();
export function material(color, roughness = .78, metalness = .12) {
  const key = `${color}|${roughness}|${metalness}`;
  if (!materialCache.has(key)) materialCache.set(key, new THREE.MeshStandardMaterial({color, roughness, metalness}));
  return materialCache.get(key);
}
function mesh(group, geometry, mat, x, y, z, sx = 1, sy = 1, sz = 1, rotation) {
  const obj = new THREE.Mesh(geometry, mat);
  obj.position.set(x, y, z); obj.scale.set(sx, sy, sz);
  if (rotation) obj.rotation.set(...rotation);
  obj.castShadow = true; obj.receiveShadow = true;
  group.add(obj); return obj;
}
function box(g, m, x, y, z, w, h, d, rot) { return mesh(g, cube, m, x, y, z, w, h, d, rot); }
function tube(g, m, x, y, z, r, len, axis = 'z') {
  return mesh(g, cylinder, m, x, y, z, r, len, r, axis === 'z' ? [Math.PI / 2, 0, 0] : axis === 'x' ? [0, 0, Math.PI / 2] : undefined);
}
function ball(g, m, x, y, z, sx, sy = sx, sz = sx) { return mesh(g, sphere, m, x, y, z, sx, sy, sz); }
function rounded(g,m,x,y,z,w,h,d) {return mesh(g,capsule,m,x,y,z,w/2,h/3,d/2);}
function segment(g,m,from,to,w,d=w) {
  const a=new THREE.Vector3(...from),b=new THREE.Vector3(...to),delta=b.clone().sub(a);
  const obj=rounded(g,m,...a.clone().add(b).multiplyScalar(.5).toArray(),w,delta.length(),d);
  obj.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());return obj;
}

// Merge static detail by material: thousands of ribs, bolts and plank seams cost
// a handful of draw calls rather than one draw call per decorative part.
export function bakeGroup(group) {
  group.updateMatrixWorld(true);
  const inverse = group.matrixWorld.clone().invert();
  const batches = new Map();
  group.traverse(obj => {
    if (!obj.isMesh || Array.isArray(obj.material)) return;
    const geometry = obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry.clone();
    geometry.applyMatrix4(inverse.clone().multiply(obj.matrixWorld));
    const batch = batches.get(obj.material) || {position: [], normal: [], uv: []};
    for (const key of ['position', 'normal', 'uv']) {
      const attr = geometry.getAttribute(key);
      if (attr) for (let i = 0; i < attr.array.length; i++) batch[key].push(attr.array[i]);
    }
    batches.set(obj.material, batch); geometry.dispose();
  });
  const out = new THREE.Group();
  for (const [mat, arrays] of batches) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(arrays.position, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(arrays.normal, 3));
    if (arrays.uv.length) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(arrays.uv, 2));
    geometry.computeBoundingSphere();
    const obj = new THREE.Mesh(geometry, mat); obj.castShadow = true; obj.receiveShadow = true; out.add(obj);
  }
  return out;
}

function canvasTexture(width, height, paint) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  paint(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4; return texture;
}
function seeded(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function paintSurface(color, seed, ribbed = false) {
  return canvasTexture(512, 512, (ctx, w, h) => {
    const random = seeded(seed); ctx.fillStyle = color; ctx.fillRect(0, 0, w, h);
    if (ribbed) for (let x = 0; x < w; x += 29) {
      ctx.fillStyle = 'rgba(0,0,0,.13)'; ctx.fillRect(x, 0, 4, h);
      ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(x + 4, 0, 3, h);
    }
    for (let i = 0; i < 700; i++) {
      const x = random() * w, y = random() * h;
      ctx.fillStyle = i % 3 ? `rgba(24,25,20,${.02 + random() * .065})` : `rgba(220,210,179,${.015 + random() * .06})`;
      ctx.fillRect(x, y, 2 + random() * 35, 1 + random() * 8);
    }
    for (let i = 0; i < 45; i++) {
      const x = random() * w, y = random() * h;
      ctx.fillStyle = 'rgba(93,52,26,.25)'; ctx.fillRect(x, y, 1 + random() * 4, 5 + random() * 55);
    }
    ctx.fillStyle = 'rgba(25,28,23,.16)'; ctx.fillRect(0, 0, w, 8); ctx.fillRect(0, h - 12, w, 12);
  });
}
function labelTexture(text, subtitle, color = '#e0decc') {
  return canvasTexture(512, 160, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = color;
    ctx.font = 'bold 66px Consolas, monospace'; ctx.fillText(text, 14, 76);
    ctx.font = '21px Consolas, monospace'; ctx.fillText(subtitle, 17, 122);
    ctx.fillRect(17, 139, 260, 3);
  });
}
function decal(group, texture, x, y, z, w, h, yaw = 0) {
  const mat = new THREE.MeshBasicMaterial({map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2});
  const obj = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); obj.position.set(x, y, z); obj.rotation.y = yaw; group.add(obj); return obj;
}

export function makeWeapon(id = 'm4a1') {
  const g = new THREE.Group();
  const steel = material('#596168', .46, .46), black = material('#30383e', .68, .16), rubber = material('#202628', .92), wood = material('#88522c', .66), accent = material('#929b9d', .38, .60);
  if (id === 'usp') {
    box(g, steel, 0, .03, -.095, .072, .082, .31); // slide
    box(g, black, 0, -.02, -.105, .069, .065, .30);
    box(g, rubber, 0, -.115, .024, .069, .19, .09, [.19, 0, 0]);
    tube(g, steel, 0, .035, -.283, .025, .08);
    for (let i = 0; i < 7; i++) box(g, black, 0, .074, .00 + i * .007, .074, .009, .003);
    box(g, black, 0, .09, -.22, .015, .02, .027); box(g, black, 0, .09, .037, .032, .016, .013);
    box(g, steel, 0, -.075, -.095, .052, .016, .10);
    box(g, steel, 0, -.103, -.136, .05, .065, .01);
    box(g, black, 0, -.123, -.089, .05, .012, .08);
    box(g, accent, .037, .02, -.08, .003, .012, .04);
    g.userData.muzzleZ = -.328;
  } else {
    const ak = id === 'ak47', awp = id === 'awp';
    const front = awp ? -.81 : ak ? -.70 : -.67;
    box(g, steel, 0, .02, 0, .092, .095, .31);
    box(g, black, 0, -.04, -.009, .086, .034, .24);
    box(g, rubber, 0, -.13, .07, .067, .19, .073, [.22, 0, 0]);
    // Open trigger guard and curved trigger.
    box(g, steel, 0, -.071, -.035, .051, .013, .085); box(g, steel, 0, -.115, -.035, .051, .013, .085);
    box(g, steel, 0, -.095, -.077, .051, .044, .011); box(g, black, 0, -.082, -.023, .014, .04, .012, [.35,0,0]);
    tube(g, steel, 0, .032, front + .18, .018, .42);
    tube(g, black, 0, .032, front - .025, .026, .055);
    box(g, black, 0, .015, -.30, .081, .08, .25);
    if (awp) {
      box(g, material('#59705c', .8), 0, -.038, .03, .105, .087, .73);
      box(g, material('#59705c', .8), 0, -.064, .35, .107, .14, .18);
      box(g, rubber, 0, -.07, .457, .113, .15, .025);
      box(g, steel, 0, -.13, -.08, .08, .12, .12);
      tube(g, steel, 0, .15, -.05, .052, .36);
      tube(g, black, 0, .15, -.25, .064, .06); tube(g, black, 0, .15, .16, .05, .04);
      tube(g, material('#38617a', .18, .7), 0, .15, -.284, .049, .002);
      tube(g, material('#35616e', .18, .7), 0, .15, .183, .039, .002);
      for (const z of [-.16, .07]) { box(g, steel, 0, .09, z, .063, .03, .036); tube(g, steel, 0, .15, z, .054, .023); }
      tube(g, steel, .085, .035, .112, .013, .11, 'x'); ball(g, black, .142, .012, .112, .025);
      for (const x of [-.053,.053]) box(g, black, x, -.077, -.55, .016, .09, .045, [0,0,x < 0 ? -.35 : .35]);
      g.userData.muzzleZ = -.85;
    } else if (ak) {
      box(g, wood, 0, -.007, -.31, .089, .085, .25);
      box(g, wood, 0, .039, -.27, .077, .032, .20);
      box(g, wood, 0, -.04, .285, .09, .12, .24, [-.12,0,0]);
      box(g, rubber, 0, -.05, .414, .10, .14, .026);
      // Segmented banana magazine, with ribs on either face.
      for (let i = 0; i < 5; i++) {
        const z = -.11 - i * .012, y = -.095 - i * .042;
        box(g, black, 0, y, z, .059, .057, .097, [.08 + i * .07,0,0]);
        for (const x of [-.031,.031]) box(g, steel, x, y, z, .004, .04, .061, [.08+i*.07,0,0]);
      }
      tube(g, steel, 0, .074, -.49, .018, .21); box(g, steel, 0, .092, -.54, .032, .10, .033);
      box(g, black, 0, .115, -.12, .028, .039, .05); box(g, black, 0, .115, -.54, .014, .016, .022);
      tube(g, accent, .062, .017, -.03, .012, .06, 'x');
      g.userData.muzzleZ = -.74;
    } else {
      tube(g, black, 0, .027, .275, .023, .28);
      box(g, black, 0, -.035, .32, .075, .107, .19); box(g, rubber, 0, -.025, .427, .084, .15, .025);
      box(g, black, 0, -.13, -.10, .061, .19, .11, [-.15,0,0]);
      for (let i = 0; i < 6; i++) box(g, steel, 0, -.095 - i * .022, -.102 - i * .003, .064, .005, .112, [-.15,0,0]);
      for (let i = 0; i < 14; i++) {
        box(g, steel, 0, .079, -.40 + i * .032, .087, .016, .013);
        for (const x of [-.045,.045]) box(g, black, x, .02, -.41 + i * .012, .005, .039, .005);
      }
      box(g, steel, 0, .096, -.034, .038, .033, .125); box(g, steel, 0, .13, -.077, .038, .04, .025);
      box(g, steel, 0, .096, -.55, .027, .08, .022); box(g, black, 0, .145, -.55, .013, .015, .02);
      box(g, accent, .048, .042, .025, .005, .028, .082);
      tube(g, black, -.051, .049, .13, .011, .036, 'x');
      g.userData.muzzleZ = -.71;
    }
    // Receiver pins and ejection port.
    for (const z of [-.093, .097]) tube(g, accent, .048, .005, z, .008, .004, 'x');
    box(g, black, .049, .036, .035, .003, .033, .071);
  }
  const baked = bakeGroup(g); baked.userData = g.userData; return baked;
}

export function makeViewArms() {
  const g = new THREE.Group(), sleeve = material('#59665c'), cuff = material('#333b32'), glove = material('#252b28'), leather = material('#6c705f');
  // Right forearm reaches the pistol grip, left hand wraps the handguard.
  box(g, sleeve, .135, -.19, .29, .12, .16, .34, [-.34,-.14,-.08]);
  box(g, cuff, .09, -.12, .129, .11, .115, .065, [-.22,0,0]);
  ball(g, glove, .067, -.102, .085, .07, .078, .069);
  box(g, leather, .098, -.084, .092, .016, .043, .065, [-.13,0,0]);
  box(g, sleeve, -.13, -.173, .09, .12, .135, .31, [-.33,.65,.05]);
  box(g, cuff, -.043, -.081, -.102, .108, .10, .068, [-.3,.22,0]);
  ball(g, glove, -.017, -.063, -.185, .067, .049, .094);
  for (let i = 0; i < 4; i++) box(g, leather, -.044 + i * .021, -.029, -.168, .017, .012, .06);
  return bakeGroup(g);
}

export function makeCharacter(team = 'blue', weaponId = 'm4a1') {
  const blue = team === 'blue' || team === 0 || team === 'defender';
  const g = new THREE.Group();
  const cloth = material(blue ? '#5e6e7c' : '#a4997f'), panel = material(blue ? '#4a5963' : '#776e59'), armor = material(blue ? '#293c46' : '#494a3d'), black = material('#252b2b'), glove = material('#393e36'), skin = material('#a6886b'), glass = material('#24363e', .24, .55), trim = material(blue ? '#a2b9bf' : '#b8ae8e');
  const torsoRaw = new THREE.Group();
  box(torsoRaw, cloth, 0, 1.15, 0, .43, .55, .28);
  box(torsoRaw, armor, 0, 1.21, -.158, .37, .39, .055);
  box(torsoRaw, armor, 0, 1.19, .17, .37, .38, .072);
  box(torsoRaw, black, 0, .895, 0, .42, .068, .31);
  for (const x of [-.125,0,.125]) {
    box(torsoRaw, panel, x, 1.055, -.204, .105, .16, .072);
    box(torsoRaw, trim, x, 1.107, -.247, .092, .016, .006);
    box(torsoRaw, armor, x, 1.253, -.194, .1, .079, .035);
  }
  for (const x of [-.156,.156]) box(torsoRaw, armor, x, 1.39, -.07, .076, .11, .29, [0,0,x < 0 ? -.1 : .1]);
  box(torsoRaw, panel, 0, 1.21, .224, .27, .31, .13);
  for (const x of [-.1,.1]) box(torsoRaw, black, x, 1.22, .297, .019, .25, .014);
  box(torsoRaw, black, -.223, 1.27, .025, .055, .19, .071); tube(torsoRaw, black, -.225, 1.425, .027, .008, .12, 'y');
  const torso = bakeGroup(torsoRaw); g.add(torso);
  const headRaw = new THREE.Group();
  ball(headRaw, skin, 0, .095, 0, .137, .176, .135);
  ball(headRaw, black, 0, .034, -.094, .13, .095, .086); // face covering
  ball(headRaw, armor, 0, .193, .008, .16, .123, .157);
  box(headRaw, armor, 0, .16, -.133, .27, .039, .051);
  box(headRaw, glass, 0, .109, -.144, .245, .073, .026);
  box(headRaw, black, 0, .108, -.163, .013, .073, .008);
  for (const x of [-.147,.147]) { box(headRaw, black, x, .095, .0, .035, .084, .075); box(headRaw, trim, x, .16, .005, .025, .018, .06); }
  box(headRaw, trim, 0, .27, -.018, .037, .022, .048);
  const head = bakeGroup(headRaw); head.position.y = 1.43; g.add(head);
  const limbs = {};
  for (const [name,x] of [['leftLeg',-.115],['rightLeg',.115]]) {
    const raw = new THREE.Group();
    rounded(raw, cloth, 0, -.217, 0, .184, .44, .224); ball(raw, panel, 0, -.368, -.08, .078, .065, .055);
    rounded(raw, cloth, 0, -.585, .005, .158, .38, .182); rounded(raw, black, 0, -.743, -.026, .177, .20, .252);
    box(raw, black, 0, -.83, -.047, .187, .055, .29);
    for (const z of [-.045,0,.045]) box(raw, glove, 0, -.719, z, .18, .008, .008);
    const limb = bakeGroup(raw); limb.position.set(x,.85,0); g.add(limb); limbs[name] = limb;
  }
  for (const [name,x] of [['leftArm',-.258],['rightArm',.258]]) {
    const raw = new THREE.Group();
    const elbow=x<0?[.108,-.26,-.15]:[.027,-.27,-.045];
    const palm=x<0?[.358,-.265,-.50]:[-.078,-.325,-.23];
    segment(raw,cloth,[0,-.025,0],elbow,.146,.175);
    box(raw, armor, 0, -.04, .006, .157, .123, .187);
    segment(raw,cloth,elbow,palm,.13,.145);
    ball(raw,glove,...palm,.069,.058,.069);
    box(raw, trim, x < 0 ? -.077 : .077, -.086, -.006, .006, .068, .082);
    const limb = bakeGroup(raw); limb.position.set(x,1.36,-.01);
    g.add(limb); limbs[name] = limb;
  }
  const gun = makeWeapon(weaponId); gun.scale.setScalar(.81); gun.position.set(.17,1.14,-.30); g.add(gun);
  g.userData = {limbs, head, torso, gun, weaponId, team};
  return g;
}

export function makeEnvironment(MAP) {
  const group = new THREE.Group(), labels = new THREE.Group();
  const width = MAP.bounds.maxX - MAP.bounds.minX, length = MAP.bounds.maxZ - MAP.bounds.minZ;
  const deckTexture = paintSurface('#6a706a', 113); deckTexture.wrapS = deckTexture.wrapT = THREE.RepeatWrapping; deckTexture.repeat.set(8, 18);
  const deck = new THREE.MeshStandardMaterial({color:'#c0c2b2', map:deckTexture, roughness:.91, metalness:.23});
  const steel = material('#465451', .82, .35), darkSteel = material('#303f42', .84, .4), yellow = material('#b7a044', .74, .3), stripe = material('#252d2a'), seam = material('#414d48'), wood = material('#97846a'), woodDark = material('#574d3b'), bolt = material('#929b8f', .53, .62);
  box(group, deck, 0, -.26, 0, width + 1.6, .5, length + 3);
  box(group, darkSteel, 0, -2.2, 0, width + 2.1, 3.45, length + 6);
  box(group, material('#7e4030', .94, .2), 0, -3.30, 0, width + 2.12, 1.5, length + 6);
  for (const x of [MAP.bounds.minX - .7, MAP.bounds.maxX + .7]) {
    box(group, steel, x, .24, 0, .24, .50, length + 2.6);
    box(group, yellow, x, 1.025, 0, .083, .083, length + 2.6);
    box(group, yellow, x, .61, 0, .064, .064, length + 2.6);
    for (let z = MAP.bounds.minZ; z <= MAP.bounds.maxZ + 1; z += 2.55) {
      box(group, yellow, x, .65, z, .07, .80, .07); box(group, steel, x, .18, z, .24, .08, .25);
    }
    for (let z = -30; z <= 30; z += 12) {
      tube(group, darkSteel, x, .53, z, .23, .60, 'y'); tube(group, bolt, x, .80, z, .20, .06, 'y');
      box(group, darkSteel, x, .57, z, .72, .13, .18);
    }
  }
  // Steel deck plate seams, loading lanes, drainage channels and worn warning paint.
  for (let z = MAP.bounds.minZ; z <= MAP.bounds.maxZ; z += 3.2) box(group, seam, 0, .001, z, width, .005, .012);
  for (const x of [-10.2,0,10.2]) {
    box(group, seam, x, .004, 0, .024, .005, length);
    if (x) for (let z = -29; z <= 29; z += 4.3) box(group, yellow, x, .010, z, .09, .009, 1.9);
  }
  for (const z of [-26,26]) {
    box(group, yellow, 0, .012, z, width - 2, .01, .12);
    for (let x = -12; x < 12; x += .75) box(group, stripe, x, .017, z, .26, .006, .16, [0,.45,0]);
  }
  const boxColors = ['#65725d','#788079','#52695c','#657566','#717866','#576b60'];
  let containerIndex = 0;
  for (const item of MAP.boxes) {
    const {x,y=0,z,w,h,d,kind} = item;
    if (kind === 'container') {
      const n = containerIndex++, color = boxColors[n % boxColors.length];
      const tex = paintSurface(color, 330 + n, true);
      const paint = new THREE.MeshStandardMaterial({map:tex, color:'#d8dacb', roughness:.88, metalness:.35});
      const edge = material(color,.77,.4);
      box(group, paint, x, y + h / 2, z, w, h, d);
      for (const side of [-1,1]) {
        for (let zz = z - d / 2 + .17; zz < z + d / 2; zz += .29) box(group, edge, x + side * (w / 2 + .015), y + h / 2, zz, .057, h - .12, .060);
        for (const yy of [.06,h-.06]) box(group, edge, x + side * (w/2+.026), y+yy, z, .074,.10,d+.035);
        for (const zz of [z-d/2+.09,z+d/2-.09]) box(group, bolt, x+side*(w/2+.04),y+h-.15,zz,.055,.17,.12);
      }
      for (let xx = x-w/2+.2; xx<x+w/2; xx+=.30) box(group,edge,xx,y+h+.022,z,.07,.045,d-.1);
      for (const side of [-1,1]) {
        const zz = z + side * (d/2+.045);
        box(group, edge,x,y+h/2,zz,.035,h,.044);
        for (const xx of [x-w*.35,x-w*.15,x+w*.15,x+w*.35]) {
          tube(group,bolt,xx,y+h/2,zz+side*.035,.021,h-.3,'y');
          box(group,darkSteel,xx,y+.9,zz+side*.07,.22,.046,.049);
          for(const yy of [.26,h-.26]) box(group,bolt,xx,y+yy,zz+side*.041,.10,.13,.032);
        }
        for(const xx of [x-w/2+.04,x+w/2-.04]) box(group,edge,xx,y+h/2,zz,.08,h,.08);
      }
      const serial = `FRT ${420 + n * 17}`;
      decal(labels,labelTexture(serial,'CARGO / 22G1   MAX 30,480 KG'),x,y+h*.71,z+d/2+.10,w*.70,.63);
      decal(labels,labelTexture(serial,'MARITIME FREIGHT // 04'),x+w/2+.068,y+h*.69,z-1.1,Math.min(d*.65,3.9),.69,Math.PI/2);
      decal(labels,labelTexture(serial,'KEEP CLEAR  /  NO CLIMB'),x-w/2-.068,y+h*.69,z+1.1,Math.min(d*.65,3.9),.69,-Math.PI/2);
      for (const xx of [x-w/2,x+w/2]) for (const zz of [z-d/2,z+d/2]) box(group, darkSteel, xx,y+.13,zz,.18,.22,.18);
    } else if (kind === 'crate') {
      box(group,wood,x,y+h/2,z,w,h,d);
      for (const xx of [x-w*.40,x+w*.40]) { box(group,woodDark,xx,y+h/2,z-d/2-.013,.10,h,.036); box(group,woodDark,xx,y+h/2,z+d/2+.013,.10,h,.036); }
      for (const zz of [z-d*.39,z+d*.39]) { box(group,woodDark,x-w/2-.013,y+h/2,zz,.036,h,.10); box(group,woodDark,x+w/2+.013,y+h/2,zz,.036,h,.10); }
      for(let yy=.19;yy<h;yy+=.22) {box(group,woodDark,x,y+yy,z-d/2-.01,w,.01,.02);box(group,woodDark,x,y+yy,z+d/2+.01,w,.01,.02);}
      for(const yy of [.08,h-.08]) { box(group,woodDark,x,y+yy,z-d/2-.02,w,.08,.055);box(group,woodDark,x,y+yy,z+d/2+.02,w,.08,.055); }
      for (const xx of [x-w*.43,x+w*.43]) for(const yy of [.11,h-.11]) for(const zz of [z-d/2-.055,z+d/2+.055]) ball(group,bolt,xx,y+yy,zz,.025);
      decal(labels,labelTexture('↑  ↑','HANDLE WITH CARE','#514b37'),x,y+h*.53,z+d/2+.06,w*.5,h*.50);
    } else if (kind === 'rail') {
      // Collision-only perimeter rails are represented by the detailed yellow railing above.
    } else {
      box(group,steel,x,y+h/2,z,w,h,d);
    }
  }
  // Open-front ship warehouses, placed outside the movement perimeter.
  for (const end of [-1,1]) {
    const z = end * (length / 2 + 1.7), roofZ = end * (length / 2 - 1.8);
    const warehouse = material(end < 0 ? '#768180' : '#77776b', .84, .25);
    box(group,warehouse,0,2.7,z,width+.2,5.4,.27);
    box(group,warehouse,0,5.3,roofZ,width+1.0,.32,8.0);
    box(group,darkSteel,0,5.09,end*(length/2-5.65),width+1.1,.24,.24);
    for(const x of [-width/2-.05,width/2+.05]) box(group,warehouse,x,2.7,roofZ,.25,5.4,8.0);
    for(const x of [-11.9,-4,4,11.9]) {box(group,darkSteel,x,2.6,z-end*.2,.18,5.2,.16);box(group,darkSteel,x,5.05,roofZ,.11,.14,7.7);}
    for(let yy=1;yy<5;yy+=.43) box(group,seam,0,yy,z-end*.16,width,.025,.022);
    box(group,darkSteel,0,2.2,z-end*.18,4.2,4.3,.06);
    for(let yy=.4;yy<4.3;yy+=.18) box(group,steel,0,yy,z-end*.225,4.0,.016,.02);
    const bayLabel = labelTexture(end < 0 ? 'BAY 01' : 'BAY 02','AUTHORIZED PERSONNEL ONLY');
    decal(labels,bayLabel,0,4.72,z-end*.23,4.5,.86,end < 0 ? 0 : Math.PI);
    for(const x of [-10,10]) { box(group,yellow,x,1.0,end*(length/2-5.5),.09,2,.10);box(group,stripe,x,.43,end*(length/2-5.5)-end*.065,.092,.16,.013);box(group,stripe,x,1.09,end*(length/2-5.5)-end*.065,.092,.16,.013); }
    // Small ship lights, floodlight brackets, ventilation louvers.
    for(const x of [-8,8]) {box(group,darkSteel,x,4.62,z-end*.3,.32,.18,.27);box(group,material('#ddd8bb',.5),x,4.57,z-end*.44,.25,.075,.028);}
    for(const x of [-10,10]) {box(group,darkSteel,x,3.6,z-end*.19,2.0,.68,.05);for(let yy=3.3;yy<3.9;yy+=.09) box(group,steel,x,yy,z-end*.23,1.9,.05,.06);}
  }
  // Scenic cranes and ship fittings remain outside the playable deck.
  for(const end of [-1,1]) {
    const x=end*18.2,z=end*20.0;
    tube(group,steel,x,4.9,z,.38,9.8,'y');tube(group,yellow,x,8.6,z,.5,.16,'y');
    box(group,yellow,x-end*3.9,10.15,z,8.0,.36,.32,[0,0,end*.2]);
    const cableMat=material('#263536',.7,.5);
    for(const dz of [-.14,.14]) box(group,cableMat,x-end*7.5,7.25,z+dz,.023,5.4,.023);
    box(group,steel,x-end*7.5,4.61,z,.65,.28,.44);
    for(let y=1;y<9.8;y+=.38) {box(group,bolt,x+end*.45,y,z,.14,.045,.50);}
  }
  // Deck coiled hoses and drums, decorative fittings outside collision boundaries.
  for(const side of [-1,1]) for(const z of [-33,32]) {
    const x=side*(width/2+.35);
    tube(group,material('#59625a'),x,.46,z,.36,.85,'y');
    for(const yy of [.12,.70,.86]) tube(group,darkSteel,x,yy,z,.37,.025,'y');
    tube(group,bolt,x,.91,z,.052,.027,'y');
  }
  const environment = bakeGroup(group); environment.add(labels); return environment;
}

export function makeBackdrop() {
  const group = new THREE.Group();
  const land = material('#697b73',1), rock = material('#60746c',1), port = material('#7d9191',.95), crane = material('#536e72',.8,.2);
  for (const [x,z,sx,sz,height] of [[-125,-185,105,43,35],[190,-215,160,46,47],[-225,40,65,32,22]]) {
    const geometry = new THREE.ConeGeometry(1,1,10); const obj=mesh(group,geometry,land,x,height/2-2,z,sx,height,sz);
    obj.rotation.y=.4;obj.castShadow=false;
    mesh(group,sphere,rock,x+sx*.35,2,z+3,sx*.6,12,sz*.72).castShadow=false;
  }
  for(let i=0;i<9;i++) box(group,port,78+i*13,5,-118,11,10+(i%3)*3,13);
  for(const x of [82,120,163]) {
    box(group,crane,x,17,-110,1.8,34,2.0);box(group,crane,x+10,31,-110,25,1.4,1.7);
    box(group,crane,x+20,24,-110,.4,14,.4);
  }
  const baked=bakeGroup(group);for(const child of baked.children)child.castShadow=false;return baked;
}
