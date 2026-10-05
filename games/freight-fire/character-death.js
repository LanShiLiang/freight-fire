import * as THREE from './vendor/three.module.js';
import * as CANNON from './vendor/cannon-es.js';

// The rounded limb contacts need small steps at impact: 90 Hz lets contact
// impulses overshoot cone/hinge limits even with extra solver iterations.
const STEP=1/180,MAX_AGE=2.8,DEG=Math.PI/180,DECK_FRICTION=.15,HAND_FRICTION=.03;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const cv=v=>new CANNON.Vec3(v.x,v.y,v.z);
const cq=q=>new CANNON.Quaternion(q.x,q.y,q.z,q.w);
const tv=v=>new THREE.Vector3(v.x,v.y,v.z);
const worldPoint=bone=>bone.getWorldPosition(new THREE.Vector3());
const worldQuaternion=bone=>bone.getWorldQuaternion(new THREE.Quaternion());
const finiteVector=value=>value&&[value.x,value.y,value.z].every(Number.isFinite);
function vector(value,fallback=new THREE.Vector3()){
  const result=Array.isArray(value)?new THREE.Vector3(...value):finiteVector(value)?tv(value):fallback.clone();
  return finiteVector(result)?result:fallback.clone();
}

// Cannon's hinge constrains its axis, but has no built-in angle limits. This
// one-sided solver equation restricts the physical bend, rather than clamping
// the rendered bone after simulation. References come from the actual two
// segment directions, so mirrored +/-X child offsets need no guessed signs.
class BendLimit extends CANNON.Equation{
  constructor(bodyA,bodyB,axis,referenceA,referenceB,min,max){
    super(bodyA,bodyB,-180,180);
    this.axisA=bodyA.vectorToLocalFrame(axis);
    this.referenceA=bodyA.vectorToLocalFrame(referenceA);
    this.referenceB=bodyB.vectorToLocalFrame(referenceB);
    this.min=min;this.max=max;this.angle=0;this.error=0;
    this.axis=new CANNON.Vec3();this.aRef=new CANNON.Vec3();this.bRef=new CANNON.Vec3();this.cross=new CANNON.Vec3();
    this.setSpookParams(1e6,4,STEP);
  }
  update(){
    this.bi.vectorToWorldFrame(this.axisA,this.axis);
    this.bi.vectorToWorldFrame(this.referenceA,this.aRef);
    this.bj.vectorToWorldFrame(this.referenceB,this.bRef);
    // A swinging cone also moves its twist reference out of the hinge plane.
    // Project both references before measuring the signed twist/bend.
    this.axis.scale(this.aRef.dot(this.axis),this.cross);this.aRef.vsub(this.cross,this.aRef);this.aRef.normalize();
    this.axis.scale(this.bRef.dot(this.axis),this.cross);this.bRef.vsub(this.cross,this.bRef);this.bRef.normalize();
    this.aRef.cross(this.bRef,this.cross);
    this.angle=Math.atan2(this.axis.dot(this.cross),this.aRef.dot(this.bRef));
    this.error=this.angle-clamp(this.angle,this.min,this.max);
    this.enabled=Math.abs(this.error)>1e-5;
    this.minForce=this.error>0?-180:0;this.maxForce=this.error>0?0:180;
  }
  computeB(h){
    this.axis.negate(this.jacobianElementA.rotational);this.jacobianElementB.rotational.copy(this.axis);
    return -this.error*this.a-this.computeGW()*this.b-h*this.computeGiMf();
  }
}

class TwistLimit extends CANNON.Equation{
  constructor(a,b,axis,max){
    super(a,b,-100,100);this.axisA=a.vectorToLocalFrame(axis);this.axis=new CANNON.Vec3();
    this.neutral=a.quaternion.inverse().mult(b.quaternion).inverse();this.relative=new CANNON.Quaternion();
    this.gradient=new CANNON.Vec3();this.cross=new CANNON.Vec3();this.vector=new CANNON.Vec3();
    this.angle=0;this.error=0;this.max=max;this.setSpookParams(1e6,4,STEP);
  }
  update(){
    this.bi.quaternion.inverse().mult(this.bj.quaternion,this.relative);this.relative.mult(this.neutral,this.relative);
    const projection=this.relative.x*this.axisA.x+this.relative.y*this.axisA.y+this.relative.z*this.axisA.z;
    // The derivative of swing/twist decomposition is not the cone axis once
    // the shoulder/hip has swung. Using that guessed Jacobian lets the limit
    // and cone push against each other. Differentiate 2*atan2(v.axis,w).
    this.vector.set(this.relative.x,this.relative.y,this.relative.z);this.vector.cross(this.axisA,this.cross);
    this.axisA.scale(this.relative.w*this.relative.w,this.gradient);
    this.gradient.addScaledVector(this.relative.w,this.cross,this.gradient);
    this.gradient.addScaledVector(projection,this.vector,this.gradient);
    this.gradient.scale(1/Math.max(1e-8,this.relative.w*this.relative.w+projection*projection),this.gradient);
    this.bi.vectorToWorldFrame(this.gradient,this.axis);
    let angle=2*Math.atan2(projection,this.relative.w);if(angle>Math.PI)angle-=2*Math.PI;if(angle<-Math.PI)angle+=2*Math.PI;
    this.angle=angle;this.error=angle-clamp(angle,-this.max,this.max);this.enabled=Math.abs(this.error)>1e-5;
    this.minForce=this.error>0?-100:0;this.maxForce=this.error>0?0:100;
  }
  computeB(h){
    this.axis.negate(this.jacobianElementA.rotational);this.jacobianElementB.rotational.copy(this.axis);
    return -this.error*this.a-this.computeGW()*this.b-h*this.computeGiMf();
  }
}

function release(state){
  if(!state?.world)return;
  for(const constraint of [...state.world.constraints])state.world.removeConstraint(constraint);
  for(const body of [...state.world.bodies])state.world.removeBody(body);
  state.world.contacts.length=0;state.world.frictionEquations.length=0;
  state.world=null;state.supportSlide=null;state.material=null;state.handMaterial=null;state.bootMaterial=null;state.neutral=null;state.player=null;state.bindings.length=0;state.joints.length=0;state.bodies.length=0;state.poses.length=0;
}

function createBody(state,bone,end,mass,width,depth,{center,radius,halfHeight,axis}={}){
  const position=worldPoint(bone),rotation=worldQuaternion(bone),inverse=rotation.clone().invert();
  const tip=end?worldPoint(end):position.clone();
  const midpoint=center||position.clone().add(tip).multiplyScalar(.5);
  const offset=midpoint.clone().sub(position).applyQuaternion(inverse);
  const body=new CANNON.Body({mass,material:state.material,position:cv(midpoint),quaternion:cq(rotation),linearDamping:.22,angularDamping:end?.85:.95,
    allowSleep:false,collisionFilterGroup:2,collisionFilterMask:1});
  let orientation=new THREE.Quaternion();
  if(radius)body.addShape(new CANNON.Sphere(radius));
  else{
    const direction=axis?axis.clone().applyQuaternion(inverse):tip.clone().sub(position).applyQuaternion(inverse);
    const length=direction.length();
    orientation=length>1e-6?new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize()):new THREE.Quaternion();
    body.addShape(new CANNON.Box(new CANNON.Vec3(width,halfHeight??Math.max(.035,length*.46),depth)),new CANNON.Vec3(),cq(orientation));
  }
  state.world.addBody(body);state.bodies.push(body);
  const binding={bone,body,offset,position,tip,orientation,radius,depth:boneDepth(bone)};state.bindings.push(binding);return binding;
}
function boneDepth(bone){let depth=0;while(bone.parent){depth++;bone=bone.parent;}return depth;}
function cone(state,a,b,pivot,axis,angle,twist,parentAxis=axis){
  const constraint=new CANNON.ConeTwistConstraint(a.body,b.body,{pivotA:a.body.pointToLocalFrame(cv(pivot)),pivotB:b.body.pointToLocalFrame(cv(pivot)),
    axisA:a.body.vectorToLocalFrame(cv(parentAxis)),axisB:b.body.vectorToLocalFrame(cv(axis)),angle:angle*DEG,twistAngle:twist*DEG,maxForce:1500,collideConnected:false});
  // Native ConeTwist builds its twist tangents independently in each body's
  // local frame. The imported mirrored bone frames have different tangent
  // phases, which would apply an artificial impulse to a valid starting pose.
  // Use the same captured world reference in both frames for our twist limit.
  constraint.twistEquation.enabled=false;
  const limit=new TwistLimit(a.body,b.body,cv(axis),twist*DEG);
  constraint.equations.push(limit);
  const update=constraint.update.bind(constraint);constraint.update=()=>{update();constraint.twistEquation.enabled=false;limit.update();};
  for(const equation of constraint.equations)equation.setSpookParams(2e7,6,STEP);
  constraint.coneEquation.setSpookParams(2e7,4,STEP);limit.setSpookParams(2e6,6,STEP);
  state.world.addConstraint(constraint);state.joints.push({constraint,limit,kind:'cone',angle:angle*DEG,name:b.bone.name});
}
function hinge(state,a,b,pivot,maxAngle,fallbackAxis){
  const directionA=a.tip.clone().sub(a.position).normalize(),directionB=b.tip.clone().sub(b.position).normalize();
  const axis=new THREE.Vector3().crossVectors(directionA,directionB);
  if(axis.lengthSq()<.002){axis.copy(fallbackAxis).addScaledVector(directionA,-fallbackAxis.dot(directionA));}
  axis.normalize();
  const constraint=new CANNON.HingeConstraint(a.body,b.body,{pivotA:a.body.pointToLocalFrame(cv(pivot)),pivotB:b.body.pointToLocalFrame(cv(pivot)),
    axisA:a.body.vectorToLocalFrame(cv(axis)),axisB:b.body.vectorToLocalFrame(cv(axis)),maxForce:1500,collideConnected:false});
  const limit=new BendLimit(a.body,b.body,cv(axis),cv(directionA),cv(directionB),-4*DEG,maxAngle*DEG);
  constraint.equations.push(limit);
  const update=constraint.update.bind(constraint);constraint.update=()=>{update();limit.update();};
  for(const equation of constraint.equations)equation.setSpookParams(2e7,6,STEP);
  limit.setSpookParams(2e6,6,STEP);
  state.world.addConstraint(constraint);state.joints.push({constraint,limit,kind:'hinge',angle:maxAngle*DEG,name:b.bone.name});
}

// Fit simple colliders once to the real visible, weighted vertices. Boots
// include their toe bones and hands include the fingers; a sphere at the ankle
// or wrist misses those extents and can leave 15 cm of visible mesh underground.
// No skin vertices are sampled during the subsequent physics frames.

// A tiny incremental hull of the existing real weighted boot samples. This
// removes the oriented box's empty corner that was 15 cm under the deck.
// Per-call SAT projection frames retain Cannon's exact multiplication order.
// Cache only pose-invariant quaternion/origin transforms within this pair;
// every real vertex, face, edge, separating axis and clipping face is preserved.
function projectionFrame(shape,position,quaternion){
  const origin=new CANNON.Vec3();origin.vsub(position,origin);
  quaternion.conjugate(new CANNON.Quaternion()).vmult(origin,origin);
  const coordinates=new Float64Array(shape.vertices.length*3);for(let i=0;i<shape.vertices.length;i++){const vertex=shape.vertices[i];coordinates[i*3]=vertex.x;coordinates[i*3+1]=vertex.y;coordinates[i*3+2]=vertex.z;}
  return {vertices:shape.vertices,coordinates,origin,axis:new CANNON.Vec3(),result:[0,0],rotation:new CANNON.Quaternion(quaternion.x,quaternion.y,quaternion.z,-quaternion.w)};
}
function cachedProjection(axis,frame){
  frame.rotation.vmult(axis,frame.axis);const add=frame.origin.dot(frame.axis),coordinates=frame.coordinates,x=frame.axis.x,y=frame.axis.y,z=frame.axis.z;
  let min=coordinates[0]*x+coordinates[1]*y+coordinates[2]*z,max=min;
  for(let i=3;i<coordinates.length;i+=3){const value=coordinates[i]*x+coordinates[i+1]*y+coordinates[i+2]*z;if(value>max)max=value;if(value<min)min=value;}
  min-=add;max-=add;if(min>max){const swap=min;min=max;max=swap;}frame.result[0]=max;frame.result[1]=min;return frame.result;
}
function cachedSeparationDepth(axis,frameA,frameB){
  const [maxA,minA]=cachedProjection(axis,frameA),[maxB,minB]=cachedProjection(axis,frameB);
  if(maxA<minB||maxB<minA)return false;const a=maxA-minB,b=maxB-minA;return a<b?a:b;
}
function cachedSeparatingAxis(hullB, posA, quatA, posB, quatB, target, faceListA, faceListB) {
    const faceANormalWS3 = new CANNON.Vec3();
    const Worldnormal1 = new CANNON.Vec3();
    const deltaC = new CANNON.Vec3();
    const worldEdge0 = new CANNON.Vec3();
    const worldEdge1 = new CANNON.Vec3();
    const Cross = new CANNON.Vec3();
    let dmin = Number.MAX_VALUE;
    const hullA = this;
    const frameA=projectionFrame(hullA,posA,quatA),frameB=projectionFrame(hullB,posB,quatB);

    if (!hullA.uniqueAxes) {
      const numFacesA = faceListA ? faceListA.length : hullA.faces.length; // Test face normals from hullA

      for (let i = 0; i < numFacesA; i++) {
        const fi = faceListA ? faceListA[i] : i; // Get world face normal

        faceANormalWS3.copy(hullA.faceNormals[fi]);
        quatA.vmult(faceANormalWS3, faceANormalWS3);
        const d = cachedSeparationDepth(faceANormalWS3,frameA,frameB);

        if (d === false) {
          return false;
        }

        if (d < dmin) {
          dmin = d;
          target.copy(faceANormalWS3);
        }
      }
    } else {
      // Test unique axes
      for (let i = 0; i !== hullA.uniqueAxes.length; i++) {
        // Get world axis
        quatA.vmult(hullA.uniqueAxes[i], faceANormalWS3);
        const d = cachedSeparationDepth(faceANormalWS3,frameA,frameB);

        if (d === false) {
          return false;
        }

        if (d < dmin) {
          dmin = d;
          target.copy(faceANormalWS3);
        }
      }
    }

    if (!hullB.uniqueAxes) {
      // Test face normals from hullB
      const numFacesB = faceListB ? faceListB.length : hullB.faces.length;

      for (let i = 0; i < numFacesB; i++) {
        const fi = faceListB ? faceListB[i] : i;
        Worldnormal1.copy(hullB.faceNormals[fi]);
        quatB.vmult(Worldnormal1, Worldnormal1);
        const d = cachedSeparationDepth(Worldnormal1,frameA,frameB);

        if (d === false) {
          return false;
        }

        if (d < dmin) {
          dmin = d;
          target.copy(Worldnormal1);
        }
      }
    } else {
      // Test unique axes in B
      for (let i = 0; i !== hullB.uniqueAxes.length; i++) {
        quatB.vmult(hullB.uniqueAxes[i], Worldnormal1);
        const d = cachedSeparationDepth(Worldnormal1,frameA,frameB);

        if (d === false) {
          return false;
        }

        if (d < dmin) {
          dmin = d;
          target.copy(Worldnormal1);
        }
      }
    } // Test edges


    const edgesB=hullB.uniqueEdges.map(edge=>quatB.vmult(edge,new CANNON.Vec3()));
    for (let e0 = 0; e0 !== hullA.uniqueEdges.length; e0++) {
      // Get world edge
      quatA.vmult(hullA.uniqueEdges[e0], worldEdge0);

      for (let e1 = 0; e1 !== hullB.uniqueEdges.length; e1++) {
        // Get world edge 2
        worldEdge1.copy(edgesB[e1]);
        worldEdge0.cross(worldEdge1, Cross);

        if (!Cross.almostZero()) {
          Cross.normalize();
          const dist = cachedSeparationDepth(Cross,frameA,frameB);

          if (dist === false) {
            return false;
          }

          if (dist < dmin) {
            dmin = dist;
            target.copy(Cross);
          }
        }
      }
    }

    posB.vsub(posA, deltaC);

    if (deltaC.dot(target) > 0.0) {
      target.negate(target);
    }

    return true;
  }

function fittedBootHull(points,padding){
  const center=new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3()),vertices=[];
  for(const source of points){const point=source.clone().sub(center);if(padding&&point.length()>1e-5)point.addScaledVector(point.clone().normalize(),padding);if(!vertices.some(v=>v.distanceToSquared(point)<1e-10))vertices.push(point);}
  if(vertices.length<4)return null;
  let a=0,b=1,c=-1,d=-1,max=0;
  for(let i=1;i<vertices.length;i++){const distance=vertices[a].distanceToSquared(vertices[i]);if(distance>max){max=distance;b=i;}}
  const line=vertices[b].clone().sub(vertices[a]),normal=new THREE.Vector3();max=0;
  for(let i=0;i<vertices.length;i++){normal.crossVectors(line,vertices[i].clone().sub(vertices[a]));const distance=normal.lengthSq();if(distance>max){max=distance;c=i;}}
  if(c<0||max<1e-12)return null;
  normal.crossVectors(line,vertices[c].clone().sub(vertices[a])).normalize();max=0;
  for(let i=0;i<vertices.length;i++){const distance=Math.abs(normal.dot(vertices[i].clone().sub(vertices[a])));if(distance>max){max=distance;d=i;}}
  if(d<0||max<1e-6)return null;
  const inside=vertices[a].clone().add(vertices[b]).add(vertices[c]).add(vertices[d]).multiplyScalar(.25);
  const face=(a,b,c)=>{const n=new THREE.Vector3().crossVectors(vertices[b].clone().sub(vertices[a]),vertices[c].clone().sub(vertices[a])).normalize();if(n.dot(inside.clone().sub(vertices[a]))>0){[b,c]=[c,b];n.negate();}return {indices:[a,b,c],normal:n,plane:n.dot(vertices[a])};};
  let faces=[face(a,b,c),face(a,d,b),face(a,c,d),face(b,d,c)];
  for(let i=0;i<vertices.length;i++){
    const visible=faces.filter(f=>f.normal.dot(vertices[i])-f.plane>1e-7);if(!visible.length)continue;
    const edges=new Map();for(const f of visible)for(let e=0;e<3;e++){const a=f.indices[e],b=f.indices[(e+1)%3],key=Math.min(a,b)+','+Math.max(a,b);if(edges.has(key))edges.delete(key);else edges.set(key,[a,b]);}
    faces=faces.filter(f=>!visible.includes(f));for(const [a,b]of edges.values())faces.push(face(a,b,i));
  }
  // Preserve convex planar sole/heel faces as polygons rather than feeding
  // Cannon many co-planar triangles and duplicate deck-contact edges.
  const groups=[];for(const f of faces){let group=groups.find(g=>g.normal.dot(f.normal)>1-1e-6&&Math.abs(g.plane-f.plane)<1e-6);if(!group){group={normal:f.normal,plane:f.plane,faces:[]};groups.push(group);}group.faces.push(f);}
  const polygons=groups.map(group=>{const edges=new Map();for(const f of group.faces)for(let e=0;e<3;e++){const a=f.indices[e],b=f.indices[(e+1)%3],key=Math.min(a,b)+','+Math.max(a,b);if(edges.has(key))edges.delete(key);else edges.set(key,[a,b]);}const boundary=[...edges.values()],polygon=[boundary[0][0]];let current=boundary[0][1];while(current!==polygon[0]&&polygon.length<=boundary.length){polygon.push(current);const next=boundary.find(e=>e[0]===current);if(!next)return group.faces.map(f=>f.indices);current=next[1];}return [polygon];}).flat();
  const used=[...new Set(polygons.flat())],remap=new Map(used.map((old,index)=>[old,index]));
  const shape=new CANNON.ConvexPolyhedron({vertices:used.map(index=>cv(vertices[index])),faces:polygons.map(f=>f.map(index=>remap.get(index)))});
  // SAT edge axes are undirected. Keep the first exact direction, removing
  // its opposite duplicate without changing vertices, faces or collision fit.
  const edges=[];for(const edge of shape.uniqueEdges)if(!edges.some(other=>Math.abs(edge.x+other.x)<1e-12&&Math.abs(edge.y+other.y)<1e-12&&Math.abs(edge.z+other.z)<1e-12))edges.push(edge);
  shape.uniqueEdges=edges;
  return {shape,center};
}

function fitShapes(group,state){
  const data=group.userData,byBone=new Map(state.bindings.map(binding=>[binding.bone,binding])),owner=new Map();
  for(const bone of Object.values(data.bones)){let current=bone;while(current&&!byBone.has(current))current=current.parent;owner.set(bone,byBone.get(current));}
  for(const binding of state.bindings){binding.bounds=new THREE.Box3();binding.hullPoints=/^(ankle_|leg_upper_)/.test(binding.bone.name)?[]:null;binding.inverseBody=worldQuaternion(binding.bone).invert();binding.inverseShape=binding.orientation.clone().invert();}
  const point=new THREE.Vector3();let vertices=0;
  for(const {mesh,indices}of data.contactSamples||[]){
    mesh.skeleton?.update();const joints=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight');
    if(!joints||!weights)continue;
    for(const index of indices){
      let strongest=0;for(let i=1;i<4;i++)if(weights.getComponent(index,i)>weights.getComponent(index,strongest))strongest=i;
      const binding=owner.get(mesh.skeleton.bones[joints.getComponent(index,strongest)]);if(!binding)continue;
      mesh.getVertexPosition(index,point).applyMatrix4(mesh.matrixWorld).sub(tv(binding.body.position)).applyQuaternion(binding.inverseBody).applyQuaternion(binding.inverseShape);
      binding.bounds.expandByPoint(point);binding.hullPoints?.push(point.clone());vertices++;
    }
  }
  for(const binding of state.bindings){
    if(binding.bounds.isEmpty()||binding.radius)continue;
    const half=binding.bounds.getSize(new THREE.Vector3()).multiplyScalar(.5).addScalar(.008),center=binding.bounds.getCenter(new THREE.Vector3()).applyQuaternion(binding.orientation);
    half.x=Math.max(.025,half.x);half.y=Math.max(.03,half.y);half.z=Math.max(.025,half.z);
    binding.body.removeShape(binding.body.shapes[0]);
    const trunk=binding.bone.name==='pelvis'||binding.bone.name==='spine_0';
    const hull=binding.hullPoints?fittedBootHull(binding.hullPoints,/^ankle_/.test(binding.bone.name)?0.008:.008):null;
    if(hull){binding.body.addShape(hull.shape,cv(hull.center.applyQuaternion(binding.orientation)),cq(binding.orientation));}
    else if(trunk||/^(arm_|leg_)/.test(binding.bone.name)){
      // Rounded limbs roll at the deck instead of stacking their flat box
      // edges into a hand/knee support. A flat torso/hip box also forms an
      // artificial sitting base. Round the trunk along its longest measured
      // axis; the source proportions, body/joint count and mass stay unchanged.
      const dimensions=[half.x,half.y,half.z],index=trunk?dimensions.indexOf(Math.max(...dimensions)):1;
      const radius=Math.min(...dimensions),length=Math.max(.002,2*(dimensions[index]-radius)),axis=new THREE.Vector3().setComponent(index,1);
      const orientation=binding.orientation.clone().multiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),axis)),end=new THREE.Vector3(0,length*.5,0).applyQuaternion(orientation);
      binding.body.addShape(new CANNON.Cylinder(radius,radius,length,8),cv(center),cq(orientation));
      binding.body.addShape(new CANNON.Sphere(radius),cv(center.clone().add(end)));
      binding.body.addShape(new CANNON.Sphere(radius),cv(center.clone().sub(end)));
    }else binding.body.addShape(new CANNON.Box(cv(half)),cv(center),cq(binding.orientation));
    delete binding.bounds;delete binding.hullPoints;delete binding.inverseBody;delete binding.inverseShape;
  }
  // Install on this corpse's actual convex shapes only, never a vendor
  // prototype or another game's physics. Box narrowphase uses its own hull.
  for(const {body}of state.bindings)for(const shape of body.shapes){const hull=shape instanceof CANNON.ConvexPolyhedron?shape:shape.convexPolyhedronRepresentation;if(hull)hull.findSeparatingAxis=cachedSeparatingAxis;}
  state.contactVertices=vertices;
}

function buildRig(group,state){
  const {bones}=group.userData,up=new THREE.Vector3(0,1,0),right=new THREE.Vector3(1,0,0).applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion()));
  const pelvisPoint=worldPoint(bones.pelvis),chestBottom=worldPoint(bones.spine_0),neck=worldPoint(bones.neck_0);
  const pelvis=createBody(state,bones.pelvis,null,12,.17,.145,{center:pelvisPoint.clone().addScaledVector(up,-.055),halfHeight:.12,axis:up});
  // A chest proxy follows spine_0; the existing intermediate spine offsets and
  // current curvature remain intact instead of stretching each bone to a body.
  const chest=createBody(state,bones.spine_0,bones.neck_0,26,.18,.17);
  const head=createBody(state,bones.head_0,null,5,0,0,{center:worldPoint(bones.head_0).addScaledVector(up,.045),radius:.13});
  // Centre waist swing on the source anatomy, as for the hips below. A held
  // running/aiming curve is a pose inside this cone, not a new zero direction
  // that can trap an unconscious torso upright behind a planted hand.
  const neutralWaist=state.neutral.waist.clone().applyQuaternion(state.neutral.pelvis.clone().invert()).applyQuaternion(worldQuaternion(bones.pelvis));
  cone(state,pelvis,chest,chestBottom,neck.clone().sub(chestBottom).normalize(),45,25,neutralWaist);
  cone(state,chest,head,worldPoint(bones.head_0),up,32,28);
  for(const side of ['L','R']){
    const upperArm=createBody(state,bones['arm_upper_'+side],bones['arm_lower_'+side],2.2,.058,.061);
    const forearm=createBody(state,bones['arm_lower_'+side],bones['hand_'+side],1.5,.048,.052);
    const hand=createBody(state,bones['hand_'+side],bones['finger_middle_1_'+side],.55,.045,.05);
    const thigh=createBody(state,bones['leg_upper_'+side],bones['leg_lower_'+side],7.5,.09,.10);
    const calf=createBody(state,bones['leg_lower_'+side],bones['ankle_'+side],3.8,.075,.085);
    const foot=createBody(state,bones['ankle_'+side],bones['ball_'+side],1,.075,.065);
    cone(state,chest,upperArm,upperArm.position,upperArm.tip.clone().sub(upperArm.position).normalize(),85,55);
    hinge(state,upperArm,forearm,forearm.position,135,right);
    cone(state,forearm,hand,hand.position,forearm.tip.clone().sub(forearm.position).normalize(),25,25);
    // The hip's cone is centred on the source rig's anatomical standing axis,
    // rather than the already flexed crouch. Centring on a crouch would allow
    // another 60 degrees of flexion, bringing both boots up around the head.
    const hipAxis=state.neutral.thigh[side].clone().applyQuaternion(state.neutral.pelvis.clone().invert()).applyQuaternion(worldQuaternion(bones.pelvis));
    cone(state,pelvis,thigh,thigh.position,thigh.tip.clone().sub(thigh.position).normalize(),95,28,hipAxis);
    hinge(state,thigh,calf,calf.position,105,right.clone().negate());
    cone(state,calf,foot,foot.position,calf.tip.clone().sub(calf.position).normalize(),22,15);
  }
  fitShapes(group,state);
  // Only non-adjacent limbs versus the trunk collide inside this private world.
  // Opposite limbs do not fight each other; connected joint pairs are excluded
  // by Cannon. This prevents knees/boots sinking through the chest/head without
  // adding any wall, player, or other-corpse collision volumes to the scene.
  for(const {bone,body}of state.bindings){
    const leg=/^(leg_|ankle_)/.test(bone.name),arm=/^(arm_|hand_)/.test(bone.name);
    body.collisionFilterGroup=leg?4:arm?8:2;body.collisionFilterMask=leg?7:arm?3:13;
    if(bone.name.startsWith('hand_'))body.material=state.handMaterial;if(bone.name.startsWith('ankle_'))body.material=state.bootMaterial;
  }
  state.bindings.sort((a,b)=>a.depth-b.depth);
  const inherited=vector(group.userData.lastLivingVelocity,new THREE.Vector3(Number(state.player.vx)||0,Number(state.player.vy)||0,Number(state.player.vz)||0));
  if(inherited.length()>7)inherited.setLength(7);
  for(const body of state.bodies)body.velocity.copy(cv(inherited));
  const direction=vector(group.userData.deathDirection,new THREE.Vector3(0,0,1).applyQuaternion(group.quaternion));
  direction.y=clamp(direction.y,-.3,.3);if(direction.lengthSq()<1e-6)direction.set(0,0,1);direction.normalize();
  const strength=state.player.deathWeapon===2?38:state.player.deathWeapon===3?22:28;
  const hit=vector(group.userData.deathHitPoint,tv(chest.body.position).addScaledVector(up,.16));
  const relative=hit.sub(tv(chest.body.position));if(relative.length()>.24)relative.setLength(.24);
  chest.body.applyImpulse(cv(direction.clone().multiplyScalar(strength)),cv(relative));
  state.impulse=direction.multiplyScalar(strength).toArray();state.initialVelocity=inherited.toArray();
}

function applyPhysicsPose(group,state){
  const point=new THREE.Vector3(),rotation=new THREE.Quaternion(),parentRotation=new THREE.Quaternion();
  for(const {bone,body,offset}of state.bindings){
    rotation.set(body.quaternion.x,body.quaternion.y,body.quaternion.z,body.quaternion.w).normalize();
    if(bone.name==='pelvis'){
      point.copy(offset).applyQuaternion(rotation).negate().add(tv(body.position));
      bone.parent.worldToLocal(point);bone.position.copy(point);
    }
    bone.quaternion.copy(bone.parent.getWorldQuaternion(parentRotation).invert().multiply(rotation));
    bone.updateMatrix();bone.updateWorldMatrix(false,true);
  }
  group.updateMatrixWorld(true);
}

function diagnostics(state){
  let speed=0,angularSpeed=0,energy=0,sleeping=0,gap=0,bend=0,twist=0,swing=0;const jointAngles=[];
  for(const body of state.bodies){speed=Math.max(speed,body.velocity.length());angularSpeed=Math.max(angularSpeed,body.angularVelocity.length());energy+=.5*body.mass*body.velocity.lengthSquared();if(body.sleepState===CANNON.Body.SLEEPING)sleeping++;}
  for(const {constraint,limit,kind,angle,name}of state.joints){
    const a=constraint.bodyA.pointToWorldFrame(constraint.pivotA),b=constraint.bodyB.pointToWorldFrame(constraint.pivotB);
    gap=Math.max(gap,a.distanceTo(b));limit.update();
    if(kind==='hinge'){bend=Math.max(bend,Math.abs(limit.error));jointAngles.push({name,kind,bend:limit.angle,min:limit.min,max:limit.max});}
    else{
      twist=Math.max(twist,Math.abs(limit.error));
      const axisA=constraint.bodyA.vectorToWorldFrame(constraint.axisA),axisB=constraint.bodyB.vectorToWorldFrame(constraint.axisB);
      const opening=Math.acos(clamp(axisA.dot(axisB),-1,1));swing=Math.max(swing,Math.max(0,opening-angle));
      jointAngles.push({name,kind,swing:opening,maxSwing:angle,twist:limit.angle,maxTwist:limit.max});
    }
  }
  return {maxSpeed:speed,maxAngularSpeed:angularSpeed,kineticEnergy:energy,sleepingBodies:sleeping,maxJointGap:gap,maxBendViolation:bend,maxTwistViolation:twist,maxSwingViolation:swing,jointAngles};
}

/** Genuine constrained rigid bodies, initialized from the displayed skinned pose. */
export function beginCharacterDeath(group,player={},ground=Number(player.y)||0){
  const data=group.userData;release(data.deathState);group.updateMatrixWorld(true);
  const poses=[...data.rest].map(([bone,rest])=>({bone,rest,quaternion:bone.quaternion.clone(),position:bone.position.clone()}));
  data.mixer.stopAllAction();data.currentAction='';data.upperMode=null;data.upperUntil=0;data.rawPose?.clear();
  for(const {bone,rest}of poses){bone.position.copy(rest.position);bone.quaternion.copy(rest.quaternion);bone.scale.copy(rest.scale);}
  group.updateMatrixWorld(true);
  const neutral={pelvis:worldQuaternion(data.bones.pelvis),thigh:{},waist:worldPoint(data.bones.neck_0).sub(worldPoint(data.bones.spine_0)).normalize()};
  for(const side of ['L','R'])neutral.thigh[side]=worldPoint(data.bones['leg_lower_'+side]).sub(worldPoint(data.bones['leg_upper_'+side])).normalize();
  for(const pose of poses){pose.bone.quaternion.copy(pose.quaternion).normalize();pose.bone.position.copy(pose.bone.name==='pelvis'?pose.position:pose.rest.position);pose.bone.scale.copy(pose.rest.scale);}
  group.updateMatrixWorld(true);
  // Cannon does not wake connected sleeping bodies from constraint forces.
  // Sleeping a pelvis/head on its own gives it zero solver mass and can pin
  // the other limbs into a raised tripod. Freeze only the complete quiet
  // corpse below, then release the whole world together.
  const world=new CANNON.World({gravity:new CANNON.Vec3(0,-9.81,0),allowSleep:false});
  world.solver.iterations=24;world.solver.tolerance=1e-6;
  Object.assign(world.defaultContactMaterial,{friction:DECK_FRICTION,restitution:0,contactEquationStiffness:2e7,contactEquationRelaxation:12,frictionEquationStiffness:2e7,frictionEquationRelaxation:4});
  const material=new CANNON.Material('corpse'),handMaterial=new CANNON.Material('glove'),floorMaterial=new CANNON.Material('deck'),bootMaterial=new CANNON.Material('boot');
  world.addContactMaterial(new CANNON.ContactMaterial(material,material,{friction:.08,restitution:0,contactEquationStiffness:5e4,contactEquationRelaxation:8,frictionEquationStiffness:5e4,frictionEquationRelaxation:8}));
  for(const other of [material,handMaterial])world.addContactMaterial(new CANNON.ContactMaterial(handMaterial,other,{friction:.08,restitution:0,contactEquationStiffness:5e4,contactEquationRelaxation:8,frictionEquationStiffness:5e4,frictionEquationRelaxation:8}));
  // Slow positional correction for a boot initially a few centimetres below
  // the deck; a very hard correction injects upward velocity into the whole
  // linked corpse. Restitution stays zero and gravity remains fully physical.
  // A fallen cloth body can slide on the metal deck. High static friction locks
  // bent knees and a hand into a tripod, leaving the torso propped up when the
  // respawn budget expires. Let gravity collapse that support through actual
  // contact friction; bone poses and joint limits are never pulled toward a pose.
  world.addContactMaterial(new CANNON.ContactMaterial(material,floorMaterial,{friction:DECK_FRICTION,restitution:0,contactEquationStiffness:2e7,contactEquationRelaxation:12,frictionEquationStiffness:2e7,frictionEquationRelaxation:4}));
  // An unpowered glove slides more freely than clothing. Keeping its
  // floor material distinct avoids a locked straight arm propping the trunk
  // up, while the rest of the corpse retains deck friction and limited travel.
  world.addContactMaterial(new CANNON.ContactMaterial(handMaterial,floorMaterial,{friction:HAND_FRICTION,restitution:0,contactEquationStiffness:2e7,contactEquationRelaxation:12,frictionEquationStiffness:2e7,frictionEquationRelaxation:4}));
  // Real fitted boot hulls retain their sole/heel/toe envelope without the
  // old box's empty underground corners. Their separate .02 deck friction
  // lets a bent shoe slide while cloth keeps .15 and normal contacts stay firm.
  for(const other of [material,handMaterial,bootMaterial])world.addContactMaterial(new CANNON.ContactMaterial(bootMaterial,other,{friction:.08,restitution:0,contactEquationStiffness:5e4,contactEquationRelaxation:8,frictionEquationStiffness:5e4,frictionEquationRelaxation:8}));
  world.addContactMaterial(new CANNON.ContactMaterial(bootMaterial,floorMaterial,{friction:.02,restitution:0,contactEquationStiffness:2e7,contactEquationRelaxation:12,frictionEquationStiffness:2e7,frictionEquationRelaxation:4}));
  const plane=new CANNON.Body({mass:0,material:floorMaterial,shape:new CANNON.Plane(),position:new CANNON.Vec3(0,Number.isFinite(ground)?ground:0,0),collisionFilterGroup:1,collisionFilterMask:14});
  plane.quaternion.setFromAxisAngle(new CANNON.Vec3(1,0,0),-Math.PI/2);world.addBody(plane);
  const state={age:0,accumulator:0,frozen:false,world,material,handMaterial,bootMaterial,poses,player,neutral,bodies:[],bindings:[],joints:[],ground:Number.isFinite(ground)?ground:0,
    origin:group.position.clone(),yaw:group.rotation.y,steps:0,quietTime:0,contactPasses:0,groundContactCount:0,freezeReason:null};
  data.deathState=state;buildRig(group,state);data.visual.visible=true;if(data.gun)data.gun.visible=false;
  return advanceCharacterDeath(group,0);
}


// A dead glove/cloth support can become a static tripod between the rounded
// proxies even though the source limbs are relaxed. A measured persistent,
// slowly changing sleeve/trunk and arm/deck brace unlocks tangential friction
// and the waist's passive swing. Normal contacts, gravity and joint limits
// remain active; no body position, orientation, target pose or force is set.
function allowSupportedClothSlide(state,advance=true){
  if(state.world.time<.65)return false;
  if(!state.supportSlide){
    const find=name=>state.bindings.find(binding=>binding.bone.name===name);
    const hip=find('pelvis'),head=find('head_0'),chest=find('spine_0');
    const forearms=new Set(state.bindings.filter(binding=>/^arm_lower_/.test(binding.bone.name)).map(binding=>binding.body));
    const arms=new Set(state.bindings.filter(binding=>/^(arm_|hand_)/.test(binding.bone.name)).map(binding=>binding.body));
    state.supportSlide={hip,head,chest,forearms,arms,hold:0,released:false,releaseAge:null,headPoint:new CANNON.Vec3(),hipPoint:new CANNON.Vec3(),delta:new CANNON.Vec3(),
      headOffset:cv(head.offset).negate(),hipOffset:cv(hip.offset).negate()};
  }
  const support=state.supportSlide,{hip,head,chest}=support;
  head.body.pointToWorldFrame(support.headOffset,support.headPoint);hip.body.pointToWorldFrame(support.hipOffset,support.hipPoint);
  support.headPoint.vsub(support.hipPoint,support.delta);
  const ratio=Math.abs(support.delta.y)/Math.max(1e-8,support.delta.length());
  if(advance){const rate=support.previousRatio===undefined?0:(ratio-support.previousRatio)/STEP;support.tiltRate=(support.tiltRate||0)*.85+rate*.15;support.previousRatio=ratio;}
  let armLoad=0,sleeveChestLoad=0,sleevePelvisLoad=0;
  for(const contact of state.world.contacts){
    if(contact.multiplier<=5)continue;
    if((contact.bi.mass===0&&support.arms.has(contact.bj))||(contact.bj.mass===0&&support.arms.has(contact.bi)))armLoad=Math.max(armLoad,contact.multiplier);
    if((contact.bi===chest.body&&support.forearms.has(contact.bj))||(contact.bj===chest.body&&support.forearms.has(contact.bi)))sleeveChestLoad=Math.max(sleeveChestLoad,contact.multiplier);
    if((contact.bi===hip.body&&support.forearms.has(contact.bj))||(contact.bj===hip.body&&support.forearms.has(contact.bi)))sleevePelvisLoad=Math.max(sleevePelvisLoad,contact.multiplier);
  }
  const sleeveLoad=Math.max(sleeveChestLoad,sleevePelvisLoad);
  const elevated=ratio>.6&&armLoad;
  if(advance&&!support.released){
    const quiet=hip.body.velocity.length()<.6&&chest.body.velocity.length()<.6&&hip.body.angularVelocity.length()<1.5&&chest.body.angularVelocity.length()<1.5;
    support.hold=state.world.time>1&&elevated&&sleeveLoad&&quiet&&Math.abs(support.tiltRate)<0.2?support.hold+STEP:0;
    if(support.hold>=.02){
      for(const contact of state.world.contactmaterials){
        const deck=contact.materials.some(material=>material.name==='deck');
        if(!deck||contact.materials.some(material=>material.name==='glove'))contact.friction=0;
      }
      const waist=state.joints.find(joint=>joint.name==='spine_0');waist.angle=60*DEG;waist.constraint.angle=waist.angle;
      // Keep only scalar evidence from the preceding real physics contacts.
      // No Body, equation or contact reference survives the whole-world freeze.
      support.proof={age:state.world.time,sustainedSeconds:support.hold,torsoRatio:ratio,tiltRate:support.tiltRate,
        armGroundLoad:armLoad,sleeveChestLoad,sleevePelvisLoad,sleeveTrunkLoad:sleeveLoad,hipSpeed:hip.body.velocity.length(),chestSpeed:chest.body.velocity.length(),
        hipAngularSpeed:hip.body.angularVelocity.length(),chestAngularSpeed:chest.body.angularVelocity.length(),
        waistSwingDegrees:60,gloveDeckFriction:0,selfFriction:0};
      support.released=true;support.releaseAge=state.world.time;
    }
  }
  // Do not freeze a quiet hand-supported trunk before its finite slip window.
  return elevated;
}

/** A stationary/paused/frozen corpse performs no physics or skin-vertex sampling. */
export function advanceCharacterDeath(group,dt=1/60){
  const data=group.userData,state=data.deathState;if(!state||state.frozen)return data.deathStats;
  const elapsed=Math.min(MAX_AGE-state.age,clamp(Number(dt)||0,0,.1));if(elapsed===0&&state.contactPasses)return data.deathStats;
  state.age=Math.min(MAX_AGE,state.age+elapsed);state.accumulator+=elapsed;
  group.position.copy(state.origin);group.rotation.y=state.yaw;
  while(state.accumulator>=STEP-1e-9){allowSupportedClothSlide(state);state.world.step(STEP);state.steps++;state.accumulator=Math.max(0,state.accumulator-STEP);}
  applyPhysicsPose(group,state);const measured=diagnostics(state);
  state.groundContactCount=state.world.contacts.filter(contact=>contact.bi.mass===0||contact.bj.mass===0).length;
  state.contactPasses++;
  const waitingSupport=allowSupportedClothSlide(state,false);
  const quiet=!waitingSupport&&state.age>.65&&measured.maxSpeed<.16&&measured.maxAngularSpeed<.35&&state.groundContactCount>0;
  state.quietTime=quiet?state.quietTime+elapsed:0;
  state.frozen=state.quietTime>=.3||measured.sleepingBodies===15||state.age>=MAX_AGE-1e-6;
  if(state.frozen)state.freezeReason=state.age>=MAX_AGE-1e-6?'time-budget':'sleep';
  data.deathAge=state.age;
  data.deathStats={age:state.age,clip:'ragdoll',engine:'cannon-es',source:'current skinned skeleton',once:true,phase:state.frozen?'frozen':'physics',
    groundContacts:true,horizontalContacts:false,collisionMode:'ground-only',contactVertices:state.contactVertices,contactPasses:state.contactPasses,
    rigidBodies:15,constraints:14,physicsSteps:state.steps,physicsStepSeconds:STEP,groundContactCount:state.groundContactCount,selfContactCount:state.world.contacts.length-state.groundContactCount,impulse:state.impulse,initialVelocity:state.initialVelocity,
    supportedClothSlip:!!state.supportSlide?.released,supportReleaseAge:state.supportSlide?.releaseAge??null,
    supportReleaseProof:state.supportSlide?.proof?{...state.supportSlide.proof}:null,frozen:state.frozen,freezeReason:state.freezeReason,...measured};
  if(state.frozen)release(state);
  return data.deathStats;
}

export function clearCharacterDeath(group){
  const data=group.userData;release(data.deathState);data.deathState=null;data.deathStats=null;data.deathAge=0;data.upperMode=null;data.upperUntil=0;
  data.deathHitPoint=null;
}
