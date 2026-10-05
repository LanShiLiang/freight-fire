import * as THREE from './vendor/three.module.js';
import { MAP, WEAPONS, raycastWorld, directionFromAngles } from './sim.js';
import { makeBackdrop } from './models.js';
import { makeEnvironmentV2 } from './environment-v2.js';
import { makeCharacterV2, updateCharacterV2, characterEvent, disposeCharacterV2 } from './character-v2.js';
import { ViewModelV2, makeWeaponV2 } from './viewmodel.js';
import { DeathCamera } from './death-camera.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const vec = value => Array.isArray(value) ? new THREE.Vector3(...value) : new THREE.Vector3(value?.x || 0, value?.y || 0, value?.z || 0);
const angleLerp = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const weaponId = p => typeof p?.weapon === 'string' ? p.weapon : (WEAPONS[p?.weapon || 0]?.id || 'm4a1');
const teamColor = team => team === 'blue' || team === 0 || team === 'defender' ? '#9fbfc9' : '#e3bf8e';
// Reduce each reference scope's actual projected magnification by 30%.
const SCOPE_ZOOM_FACTOR=.7;
function nameTexture(p) {
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=64;const ctx=canvas.getContext('2d');
  ctx.font='bold 24px Arial';ctx.textAlign='center';ctx.fillStyle='rgba(17,29,34,.7)';ctx.fillRect(16,12,224,41);ctx.fillStyle=teamColor(p.team);ctx.fillText(String(p.name||'Operator').slice(0,18),128,40);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;return texture;
}

export class ArenaRenderer {
  constructor(canvas, { quality = 'medium' } = {}) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({canvas, antialias: true, powerPreference: 'high-performance', alpha: false});
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.localClippingEnabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#afc5c4');
    this.scene.fog = new THREE.FogExp2('#b1c7c6', .0032);
    this.camera = new THREE.PerspectiveCamera(78, 1, .035, 650);
    this.camera.rotation.order = 'YXZ'; this.scene.add(this.camera);
    this.scene.add(new THREE.HemisphereLight('#e0edf2', '#646966', 1.8));
    this.sun = new THREE.DirectionalLight('#ffecd0', 3.4);
    this.sun.position.set(-35, 68, -23); this.sun.castShadow = true;
    Object.assign(this.sun.shadow.camera, {left:-29, right:29, top:48, bottom:-48, near:1, far:160});
    this.sun.shadow.bias = -.00013; this.sun.shadow.normalBias = .012; this.sun.shadow.radius = .8;
    this.sun.target.position.set(0,0,0); this.scene.add(this.sun, this.sun.target);
    this.environment = makeEnvironmentV2(MAP);
    this.ready = this.environment.userData.ready;
    this.scene.add(this.environment, makeBackdrop());
    this.createAtmosphere();
    // A small original sky capture provides the reflection metallic receivers
    // need; no remote cubemap or image asset is requested by the static game.
    const envScene=new THREE.Scene();
    const envSky=new THREE.Mesh(new THREE.SphereGeometry(30,24,12),this.sky.material.clone());envScene.add(envSky);
    const pmrem=new THREE.PMREMGenerator(this.renderer);
    this.environmentTarget=pmrem.fromScene(envScene,.08,.1,100);
    this.scene.environment=this.environmentTarget.texture;this.scene.environmentIntensity=.42;
    pmrem.dispose();envSky.geometry.dispose();envSky.material.dispose();
    this.players = new Map(); this.effects = []; this.lastEvent = new Set();
    this.viewScene = new THREE.Scene();
    this.viewScene.environment = this.scene.environment;this.viewScene.environmentIntensity=.65;
    this.viewCamera = new THREE.PerspectiveCamera(68,1,.015,10);this.viewScene.add(this.viewCamera);
    this.viewScene.add(new THREE.HemisphereLight('#dfeaf2','#56564a',2.3));
    const viewSun=new THREE.DirectionalLight('#fff0df',2.3);viewSun.position.set(-3,5,-2);this.viewScene.add(viewSun);
    this.viewModel = new ViewModelV2(this.viewCamera);
    this.view = this.viewModel.group;
    this.flashMat = new THREE.MeshBasicMaterial({color:'#ffe8a7', transparent:true, opacity:1, depthWrite:false, blending:THREE.AdditiveBlending});
    this.flash = new THREE.Mesh(new THREE.ConeGeometry(.04,.15,7).translate(0,.075,0),this.flashMat);this.flash.rotation.x=-Math.PI/2;this.flash.visible=false;this.flash.name='firstperson_muzzle_flash';this.viewCamera.add(this.flash);
    this.muzzleLight = new THREE.PointLight('#ffc66b',0,4);this.viewCamera.add(this.muzzleLight);
    this.recoil = 0; this.kick = 0; this.hitShake = 0; this.flashTime = 0; this.walkPhase = 0;
    this.recoilPitch=0;this.recoilYaw=0;this.recoilRoll=0;this.shotIndex=0;this.lastShotTime=-100;this.deathCamera=null;this.deathCameraStats=null;
    this.fpsTime = 0; this.frames = 0; this.stats = {fps:0,drawCalls:0,triangles:0};
    this.previousWeapon = ''; this.clockTime = 0; this.cameraReady = false; this.disposed = false;
    this.setQuality(quality); this.resize();
  }

  retryEnvironment() {
    // Retain the already loaded rig library and WebGL context on map retries.
    const previous=this.environment;this.environment=makeEnvironmentV2(MAP);this.ready=this.environment.userData.ready;
    this.scene.remove(previous);this.scene.add(this.environment);
    previous.traverse(obj=>{if(obj.isMesh){obj.geometry?.dispose();for(const material of [].concat(obj.material||[])){for(const key of ['map','normalMap','roughnessMap','metalnessMap','aoMap'])material[key]?.dispose();material.dispose();}}});
  }

  createAtmosphere() {
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(570,32,16),new THREE.ShaderMaterial({
      side:THREE.BackSide, depthWrite:false,
      uniforms:{sunDirection:{value:new THREE.Vector3(-.37,.76,-.30).normalize()}},
      vertexShader:'varying vec3 vDirection; void main(){ vDirection=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader:`varying vec3 vDirection; uniform vec3 sunDirection;
        void main(){vec3 d=normalize(vDirection);float h=max(d.y,0.0);
        vec3 sky=mix(vec3(.69,.78,.78),vec3(.25,.46,.59),pow(h,.54));
        float cloud=sin(d.x*25.0+d.z*19.0)*sin(d.z*42.0-d.x*13.0);
        sky=mix(sky,vec3(.82,.84,.80),smoothstep(.15,.80,cloud)*smoothstep(.05,.25,h)*.11);
        float sun=pow(max(dot(d,sunDirection),0.0),900.0);
        sky+=vec3(1.0,.85,.59)*sun*1.9;sky+=vec3(.23,.18,.10)*pow(max(dot(d,sunDirection),0.0),12.0);
        gl_FragColor=vec4(sky,1.0);}`,
    }));
    this.sky.renderOrder=-2;this.scene.add(this.sky);
    const seaGeometry = new THREE.PlaneGeometry(1800,1800,96,96);seaGeometry.rotateX(-Math.PI/2);
    this.seaMaterial = new THREE.ShaderMaterial({
      uniforms:{time:{value:0},cameraPositionWorld:{value:new THREE.Vector3()},fogColor:{value:new THREE.Color('#b1c7c6')}},
      vertexShader:`uniform float time; varying vec3 vWorld; varying vec3 vNormal;
        void main(){vec3 p=position;float t=time*.6;
        p.y+=sin(p.x*.065+t)*.20+sin(p.z*.10-t*.7)*.12;
        vNormal=normalize(vec3(-.013*cos(p.x*.065+t),1.0,-.012*cos(p.z*.10-t*.7)));
        vWorld=(modelMatrix*vec4(p,1.0)).xyz;gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.0);}`,
      fragmentShader:`uniform float time;uniform vec3 cameraPositionWorld;uniform vec3 fogColor;varying vec3 vWorld;varying vec3 vNormal;
        void main(){vec3 view=normalize(cameraPositionWorld-vWorld);vec3 n=normalize(vNormal);
        float ripples=sin(vWorld.x*1.4+time*.9)*sin(vWorld.z*1.8-time)*.035;
        float fres=pow(1.0-max(dot(view,n),0.0),3.0);
        vec3 col=mix(vec3(.075,.20,.25),vec3(.38,.53,.55),fres)+ripples;
        vec3 l=normalize(vec3(-.37,.76,-.30));float shine=pow(max(dot(reflect(-l,n),view),0.0),160.0);
        col+=vec3(.8,.74,.54)*shine*.60;
        float fog=1.0-exp(-length(cameraPositionWorld-vWorld)*.0038);col=mix(col,fogColor,fog);
        gl_FragColor=vec4(col,1.0);}`,
    });
    this.sea = new THREE.Mesh(seaGeometry,this.seaMaterial);this.sea.position.y=-3.72;this.sea.receiveShadow=false;this.scene.add(this.sea);
  }

  setQuality(quality) {
    this.quality = ['low','medium','high'].includes(quality) ? quality : 'medium';
    const high=this.quality==='high', low=this.quality==='low';
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, high ? 1.7 : low ? 1 : 1.35));
    this.renderer.shadowMap.enabled=!low;
    this.sun.shadow.mapSize.set(high ? 2048 : 1536,high ? 2048 : 1536);
    if(this.sun.shadow.map){this.sun.shadow.map.dispose();this.sun.shadow.map=null;}
    this.sun.shadow.needsUpdate=true;
    this.effectLimit=high?90:low?24:52;
    this.resize();
  }

  resize() {
    const width=this.canvas.clientWidth || window.innerWidth || 1280,height=this.canvas.clientHeight || window.innerHeight || 720;
    this.renderer.setSize(width,height,false);this.camera.aspect=width/height;this.camera.updateProjectionMatrix();
    if(this.viewCamera){this.viewCamera.aspect=width/height;this.viewCamera.updateProjectionMatrix();}
  }

  getPlayer(p) {
    let entry=this.players.get(p.id);
    if(!entry || entry.team!==p.team) {
      if(entry){this.scene.remove(entry.group);this.releaseObject(entry.group);}
      const group=makeCharacterV2(p.team,makeWeaponV2);group.position.set(p.x,p.y||0,p.z);group.rotation.y=p.yaw||0;this.scene.add(group);
      entry={group,team:p.team,weaponId:weaponId(p),lastX:p.x,lastZ:p.z,phase:Math.random()*6.28};this.players.set(p.id,entry);
      const tag=new THREE.Sprite(new THREE.SpriteMaterial({map:nameTexture(p),transparent:true,depthTest:true,depthWrite:false}));tag.scale.set(1.5,.375,1);tag.position.y=2.13;group.add(tag);entry.tag=tag;entry.name=p.name;
    }
    if(entry.name!==p.name){entry.tag.material.map.dispose();entry.tag.material.map=nameTexture(p);entry.tag.material.needsUpdate=true;entry.name=p.name;}
    return entry;
  }

  render(snapshot, localId, input = {}, dt = 1 / 60) {
    if(this.disposed)return;
    dt=clamp(dt||1/60,.001,.08);this.clockTime+=dt;
    const clockReset=(snapshot?.time||0)<(this.currentSnapshotTime||0)-.5,newRound=clockReset||this.roundResetPending===true;
    this.roundResetPending=false;
    if(clockReset)this.lastEvent.clear();
    if(newRound){this.resetView();this.deathCamera=null;this.deathCameraStats=null;this.cameraReady=false;}
    this.currentSnapshotTime=snapshot?.time||0;
    const list=Array.isArray(snapshot?.players)?snapshot.players:Object.values(snapshot?.players||{});
    const local=list.find(p=>p.id===localId);
    for(const event of snapshot?.events||[])this.event(event,localId);
    const seen=new Set();
    for(const p of list) {
      seen.add(p.id);const entry=this.getPlayer(p),g=entry.group;
      g.visible=p.id!==localId;
      const a=1-Math.exp(-dt*16),target=new THREE.Vector3(p.x,p.y||0,p.z),respawned=p.alive&&g.userData.dead;
      if(newRound||respawned||g.position.distanceToSquared(target)>64){g.position.copy(target);g.rotation.y=p.yaw||0;}
      else if(p.alive||!g.userData.dead){g.position.lerp(target,a);g.rotation.y=angleLerp(g.rotation.y,p.yaw||0,a);}
      updateCharacterV2(g,p,input.paused?0:dt,snapshot?.time||this.clockTime);
      entry.tag.visible=!!p.alive && !!local && p.team===local.team && p.id!==localId;entry.tag.position.y=p.crouching?1.52:2.0;
    }
    for(const [id,entry]of this.players)if(!seen.has(id)){this.scene.remove(entry.group);this.releaseObject(entry.group);this.players.delete(id);}
    this.recoil*=Math.exp(-dt*15);this.kick*=Math.exp(-dt*12);this.hitShake*=Math.exp(-dt*9);
    const recovery=Math.exp(-dt*(this.clockTime-this.lastShotTime>.12?13:8));this.recoilPitch*=recovery;this.recoilYaw*=recovery;this.recoilRoll*=Math.exp(-dt*18);
    this.flashTime=Math.max(0,this.flashTime-dt);this.flash.visible=this.flashTime>0;this.muzzleLight.intensity=this.flashTime>0?4:0;
    if(local && local.alive) {
      if(this.deathCamera){this.deathCamera=null;this.deathCameraStats=null;this.resetView();this.cameraReady=false;}
      const yaw=Number.isFinite(input.yaw)?input.yaw:local.yaw||0,pitch=Number.isFinite(input.pitch)?input.pitch:local.pitch||0;
      const eye=local.crouching?1.20:1.58;
      const target=new THREE.Vector3(local.x,(local.y||0)+eye,local.z);
      if(!this.cameraReady){this.camera.position.copy(target);this.cameraReady=true;}
      else this.camera.position.lerp(target,1-Math.exp(-dt*24));
      this.camera.rotation.set(clamp(pitch+this.recoilPitch,-1.45,1.45)+Math.sin(this.clockTime*39)*this.hitShake*.012,yaw+this.recoilYaw+Math.sin(this.clockTime*28)*this.hitShake*.012,this.recoilRoll,'YXZ');
      this.view.visible=true;
      this.updateView(local,input,dt);
    } else if(local) {
      this.view.visible=false;this.cameraReady=false;
      if(!this.deathCamera||this.deathCamera.playerId!==local.id){
        const kill=[...(snapshot?.events||[])].reverse().find(e=>e.type==='kill'&&(e.targetId??e.victimId)===local.id);
        const killer=list.find(p=>p.id===(local.killerId??kill?.playerId??kill?.killerId));this.deathCamera=new DeathCamera(local,this.camera,killer);
      }
      this.deathCameraStats=this.deathCamera.update(this.camera,input.paused?0:dt);
      const body=this.players.get(local.id)?.group;if(body)body.visible=this.deathCameraStats.showBody;
    } else {
      this.deathCamera=null;this.deathCameraStats=null;
      this.view.visible=false;this.cameraReady=false;
      const t=this.clockTime*.024;this.camera.position.set(25+Math.sin(t)*4,19.5+Math.sin(t*.7)*1.5,34+Math.cos(t)*3);this.camera.lookAt(-2,1.0,-5);
      this.camera.fov=65;this.camera.updateProjectionMatrix();
    }
    this.updateEffects(dt);
    this.seaMaterial.uniforms.time.value=this.clockTime;
    this.seaMaterial.uniforms.cameraPositionWorld.value.copy(this.camera.position);
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene,this.camera);
    let drawCalls=this.renderer.info.render.calls,triangles=this.renderer.info.render.triangles;
    if(this.view.visible){this.renderer.autoClear=false;this.renderer.clearDepth();this.renderer.render(this.viewScene,this.viewCamera);this.renderer.autoClear=true;}
    if(this.view.visible){drawCalls+=this.renderer.info.render.calls;triangles+=this.renderer.info.render.triangles;}
    this.frames++;this.fpsTime+=dt;
    if(this.fpsTime>.5){this.stats.fps=Math.round(this.frames/this.fpsTime);this.frames=0;this.fpsTime=0;}
    this.stats.drawCalls=drawCalls;this.stats.triangles=triangles;
  }

  updateView(local,input,dt) {
    const id=weaponId(local),aim=!!(input.aim ?? input.aiming ?? local.aiming);
    if(id!==this.previousWeapon){this.kick=.26;this.previousWeapon=id;}
    const direction=directionFromAngles(input.yaw??local.yaw,input.pitch??local.pitch);
    const wall=raycastWorld(this.camera.position,direction,1.2);
    this.viewModel.update(local,{...input,wallDistance:wall?.distance??Infinity},dt,this.currentSnapshotTime||0,{recoil:this.recoil,kick:this.kick});
    const fov=aim?(id==='awp'?THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(input.zoomLevel===2?10:40)/2)/SCOPE_ZOOM_FACTOR/this.camera.aspect)):58):78;
    this.camera.fov+=(fov-this.camera.fov)*(1-Math.exp(-dt*(id==='awp'&&aim?24:13)));this.camera.updateProjectionMatrix();
    this.flash.position.copy(this.viewModel.muzzle);this.flash.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),this.viewModel.muzzleDirection||new THREE.Vector3(0,0,-1));this.flash.rotateY(this.clockTime*123);this.muzzleLight.position.copy(this.viewModel.muzzle);
  }

  firstPersonMuzzleWorld() {
    // The gun uses a separate 68-degree camera. Reproject its actual muzzle
    // through that camera into the world camera instead of mixing FOV spaces.
    this.viewCamera.updateMatrixWorld(true);this.camera.updateMatrixWorld(true);
    const point=this.viewCamera.localToWorld(this.viewModel.muzzle.clone()),ndc=point.clone().project(this.viewCamera),ray=new THREE.Vector3(ndc.x,ndc.y,.5).unproject(this.camera).sub(this.camera.position).normalize();
    const forward=new THREE.Vector3(0,0,-1).applyQuaternion(this.camera.quaternion),depth=Math.max(.05,-this.viewModel.muzzle.z);
    return this.camera.position.clone().addScaledVector(ray,depth/Math.max(.05,ray.dot(forward)));
  }

  resetView() {
    Object.assign(this.viewModel,{previous:'',previousAgent:'',lastReloadUntil:0,reloadProgress:0,wall:0});
    this.previousWeapon='';this.recoil=0;this.kick=0;this.recoilPitch=0;this.recoilYaw=0;this.recoilRoll=0;this.hitShake=0;this.flashTime=0;this.shotIndex=0;
  }

  event(event,localId) {
    if(!event)return;
    const key=event.seq ?? event.id ?? `${event.type}:${event.time}:${event.playerId}:${event.targetId}`;
    if(this.lastEvent.has(key))return;
    this.lastEvent.add(key);if(this.lastEvent.size>500){const keys=[...this.lastEvent];for(let i=0;i<250;i++)this.lastEvent.delete(keys[i]);}
    if(event.type==='restart') {
      this.roundResetPending=true;this.resetView();this.deathCamera=null;this.deathCameraStats=null;this.cameraReady=false;
    } else if(event.type==='shot') {
      const shooter=event.playerId ?? event.shooterId;
      characterEvent(this.players.get(shooter)?.group,event,this.currentSnapshotTime||this.clockTime);
      if(shooter===localId){const spec=WEAPONS[event.weapon],id=spec?.id;if(this.clockTime-this.lastShotTime>.3)this.shotIndex=0;this.shotIndex++;this.lastShotTime=this.clockTime;
        const rise=spec?.recoil||.017,pattern=[0,.18,.30,.19,-.12,-.34,-.22,.08,.28,.32,-.16,-.31];
        this.recoilPitch=Math.min(this.recoilPitch+rise*(id==='awp'?.52:.72),.075);this.recoilYaw=clamp(this.recoilYaw+rise*pattern[(this.shotIndex-1)%pattern.length]*.30,-.022,.022);this.recoilRoll=rise*(this.shotIndex%2?.08:-.08);
        this.recoil=Math.min(this.recoil+(id==='awp'?1.8:id==='ak47'?.82:id==='usp'?.42:.60),2.5);this.kick=id==='awp'?.90:.55;this.flashTime=.042;this.viewModel.fire(event);}
      const from=vec(event.from),to=vec(event.to);
      if(event.from && event.to) {
        const d=to.clone().sub(from).normalize();
        let start=from.clone().addScaledVector(d,.42);
        // Cosmetic tracer starts at the actual visible barrel, then converges
        // onto the authoritative camera-centred impact point.
        if(shooter===localId&&this.view.visible){start=this.firstPersonMuzzleWorld();}
        else {const entry=this.players.get(shooter);const gun=entry?.group.userData.gun;if(gun)start=gun.userData.muzzle?gun.userData.muzzle.getWorldPosition(new THREE.Vector3()):gun.localToWorld(new THREE.Vector3(0,.006,gun.userData.muzzleZ||-.70));}
        const geometry=new THREE.BufferGeometry().setFromPoints([start,to]);
        const mat=new THREE.LineBasicMaterial({color:'#f9df9c',transparent:true,opacity:.68,depthWrite:false});
        const line=new THREE.Line(geometry,mat);line.userData.muzzleOwner=shooter;line.userData.firstPerson=shooter===localId;this.scene.add(line);this.addEffect(line,.052,'fade');
        if(shooter!==localId){
          const flash=new THREE.Mesh(new THREE.SphereGeometry(.075,6,4),this.flashMat.clone());flash.userData.muzzleOwner=shooter;flash.position.copy(start);flash.scale.set(1,1,2.2);this.scene.add(flash);this.addEffect(flash,.05,'fade');
        }
        // Metal sparks belong to hard surfaces; character hits have their own effect.
        for(let i=0;i<(event.surface!=='world'?0:this.quality==='low'?2:5);i++) {
          const spark=new THREE.Mesh(new THREE.BoxGeometry(.016,.016,.07),new THREE.MeshBasicMaterial({color:i%2?'#ffe7a7':'#b9b29a',transparent:true,opacity:.9}));
          spark.position.copy(to);spark.rotation.set(Math.random()*6,Math.random()*6,0);this.scene.add(spark);
          this.addEffect(spark,.14+Math.random()*.09,'particle',new THREE.Vector3((Math.random()-.5)*1.6,Math.random()*1.4,(Math.random()-.5)*1.6));
        }
        if(event.surface==='world'&&event.normal){
          const normal=vec(event.normal).normalize();
          const mark=new THREE.Mesh(new THREE.CircleGeometry(.045,9),new THREE.MeshBasicMaterial({color:'#18201f',transparent:true,opacity:.8,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2}));
          mark.position.copy(to).addScaledVector(normal,.008);mark.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),normal);
          this.scene.add(mark);this.addEffect(mark,7,'decal');
        }
      }
    } else if(event.type==='melee') {
      const shooter=event.playerId??event.shooterId;characterEvent(this.players.get(shooter)?.group,event,this.currentSnapshotTime||this.clockTime);
      if(shooter===localId)this.viewModel.fire(event);
    } else if(event.type==='reload') {
      characterEvent(this.players.get(event.playerId)?.group,event,this.currentSnapshotTime||this.clockTime);
    } else if(event.type==='hit') {
      if((event.targetId??event.playerId)===localId)this.hitShake=Math.min(1,this.hitShake+.6);
      const target=this.players.get(event.targetId)?.group;
      if(target&&!event.protected)target.userData.hitTime=this.currentSnapshotTime||0;
      if(!event.protected&&(event.to || event.position)) {
        const center=vec(event.to||event.position);
        for(let i=0;i<4;i++) {
          const puff=new THREE.Mesh(new THREE.SphereGeometry(.025,5,4),new THREE.MeshBasicMaterial({color:'#9d4d3e',transparent:true,opacity:.6}));puff.position.copy(center);this.scene.add(puff);
          this.addEffect(puff,.20,'particle',new THREE.Vector3((Math.random()-.5),Math.random()*.6,(Math.random()-.5)));
        }
      }
    } else if(event.type==='kill') {
      const target=this.players.get(event.targetId)?.group;
      if(target){target.userData.deathDirection=vec(event.direction||[0,0,1]);target.userData.deadAt=null;}
    }
  }

  addEffect(object,life,type,velocity) {
    while(this.effects.length>=this.effectLimit){const old=this.effects.shift();this.scene.remove(old.object);this.releaseObject(old.object);}
    this.effects.push({object,life,max:life,type,velocity});
  }
  updateEffects(dt) {
    for(let i=this.effects.length-1;i>=0;i--) {
      const e=this.effects[i];e.life-=dt;
      if(e.life<=0){this.scene.remove(e.object);this.releaseObject(e.object);this.effects.splice(i,1);continue;}
      // Events precede animation updates. Anchor effects after the current
      // shooting pose has been evaluated so they start on this frame's tip.
      if(e.object.userData.muzzleOwner!==undefined){const gun=this.players.get(e.object.userData.muzzleOwner)?.group.userData.gun,muzzle=e.object.userData.firstPerson&&this.view.visible?this.firstPersonMuzzleWorld():gun?.userData.muzzle?.getWorldPosition(new THREE.Vector3());if(muzzle){if(e.object.isLine){const positions=e.object.geometry.getAttribute('position');positions.setXYZ(0,muzzle.x,muzzle.y,muzzle.z);positions.needsUpdate=true;}else e.object.position.copy(muzzle);}}
      if(e.object.material)e.object.material.opacity=e.type==='decal'?Math.min(.8,e.life)*.8:e.life/e.max*.85;
      if(e.velocity){e.velocity.y-=dt*3;e.object.position.addScaledVector(e.velocity,dt);}
    }
  }
  releaseObject(object) {
    if(object?.userData.characterV2)disposeCharacterV2(object);
    object?.traverse?.(obj=>{if(obj.isMesh||obj.isLine){if(!obj.userData.sharedAsset&&!obj.isSkinnedMesh)obj.geometry?.dispose();if(!obj.userData.sharedAsset&&obj.material && !Array.isArray(obj.material) && (obj.material.isMeshBasicMaterial||obj.material.isLineBasicMaterial)){obj.material.map?.dispose();obj.material.dispose();}}if(obj.isSprite){obj.material.map?.dispose();obj.material.dispose();}});
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;for(const entry of this.players.values())disposeCharacterV2(entry.group);this.viewModel.dispose();
    this.flash.geometry.dispose();this.flashMat.dispose();this.scene.traverse(obj=>{obj.geometry?.dispose();if(obj.material){const mats=Array.isArray(obj.material)?obj.material:[obj.material];for(const mat of mats){mat.map?.dispose();mat.dispose();}}});this.environmentTarget?.dispose();this.renderer.dispose();this.players.clear();this.effects=[];
  }
}
