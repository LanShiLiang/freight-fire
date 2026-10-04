"""Import structural geometry from the publicly shared 2014 classic-map port.

Only numeric geometry and collision data enter the game. Source textures,
logos, entities, scripts and compiled game code are not copied or executed.
Public reference: https://gamebanana.com/mods/111054
"""
import struct, json, re, io, zipfile, math, itertools, hashlib
from pathlib import Path
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parents[1]
ref = root / 'artifacts/transport-source-reference'
raw = (ref / 'maps/cf_transportship.bsp').read_bytes()
assert raw[:4] == b'VBSP' and struct.unpack_from('<i', raw, 4)[0] == 20
headers = [struct.unpack_from('<4i', raw, 8+i*16) for i in range(64)]
def lump(i):
    at, size, _, _ = headers[i]
    return raw[at:at+size]
def records(i, fmt): return list(struct.iter_unpack(fmt, lump(i)))
entities = [dict(re.findall(r'"([^"]+)"\s*"([^"]*)"', e)) for e in re.findall(r'\{([^{}]*)\}', lump(0).decode(errors='replace'))]
planes = records(1, '<4fi')
vertices = records(3, '<3f')
edges = records(12, '<2H')
surfedges = [v[0] for v in records(13, '<i')]
texinfo = records(6, '<16f2i')
texdata = records(2, '<3f5i')
strings = lump(43)
material_names = [strings[o[0]:].split(b'\x00')[0].decode().lower() for o in records(44,'<i')]
models = records(14, '<9f3i')
brushes = records(18, '<3i')
sides = records(19, '<HhHH')
nodes = records(5, '<3i6h2H2h')
leafbrushes = [v[0] for v in records(17, '<H')]
leaves = records(10, '<ihH6h4Hh2x')
world_brushes = set()
def visit(index):
    if index < 0:
        leaf = leaves[-1-index]
        world_brushes.update(leafbrushes[leaf[11]:leaf[11]+leaf[12]])
    else:
        visit(nodes[index][1]); visit(nodes[index][2])
visit(models[0][9])
# One uniform conversion, anchored to the shared simulation's 1.76 m operator.
# This Source-port unit is documented; it is not an original CF engine unit.
S = 1.76 / 72
C = (184.0, 142.0, 65.0)
def point(v): return [round(-(v[0]-C[0])*S,5), round((v[2]-C[2])*S,5), round((v[1]-C[1])*S,5)]
def normal(v): return [-v[0], v[2], v[1]]
def dot(a,b): return sum(x*y for x,y in zip(a,b))
def cross(a,b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
def corner(a,b,c):
    bc,ca,ab = cross(b[:3],c[:3]),cross(c[:3],a[:3]),cross(a[:3],b[:3])
    det = dot(a[:3],bc)
    if abs(det)<1e-7:return None
    return [(a[3]*bc[i]+b[3]*ca[i]+c[3]*ab[i])/det for i in range(3)]
solids=[]
for i in sorted(world_brushes):
    start,count,contents = brushes[i]
    if not contents & (1|2|8|0x10000):continue
    ps=[planes[sides[j][0]][:4] for j in range(start,start+count)]
    vs=[]
    for a,b,c in itertools.combinations(ps,3):
        v=corner(a,b,c)
        if v and all(dot(p[:3],v)<=p[3]+.04 for p in ps) and not any(sum((v[k]-q[k])**2 for k in range(3))<.01 for q in vs):vs.append(v)
    if len(vs)<4:continue
    vv=[point(v) for v in vs]
    lo=[min(v[k] for v in vv) for k in range(3)];hi=[max(v[k] for v in vv) for k in range(3)]
    # Skip enclosing sky brushes and remote water scenery. The playable hull,
    # stairwell ceilings, cargo and cabin doors are retained at source positions.
    if hi[0]<-16 or lo[0]>16 or hi[2]<-46 or lo[2]>46 or hi[1]<-5:continue
    names={material_names[texdata[texinfo[sides[j][1]][17]][3]] for j in range(start,start+count) if sides[j][1]>=0}
    if names and all('toolsskybox' in n for n in names):continue
    if contents & 0x10000 and (hi[1]-lo[1]>20):continue
    transformed=[[round(n,7) for n in normal(p[:3])]+[round((p[3]-dot(p[:3],C))*S,6)] for p in ps]
    solid={'id':f'classic-{i}','x':round((lo[0]+hi[0])/2,5),'y':lo[1],'z':round((lo[2]+hi[2])/2,5),'w':round(hi[0]-lo[0],5),'h':round(hi[1]-lo[1],5),'d':round(hi[2]-lo[2],5),'planes':transformed,'kind':'reference-solid','playerClip':bool(contents&0x10000)}
    if solid['w']<.0001 or solid['h']<.0001 or solid['d']<.0001:continue
    solids.append(solid)
pak=zipfile.ZipFile(io.BytesIO(lump(40)))
# Decode only 16px VTF thumbnails for research/material classification; none
# of these original images are emitted into shipping game assets.
def thumbnail(vtf):
    w,h=vtf[61],vtf[62];size=struct.unpack_from('<I',vtf,12)[0]
    offset=size
    if struct.unpack_from('<2I',vtf,4)>=(7,3):
        for j in range(struct.unpack_from('<I',vtf,68)[0]):
            a=80+j*8
            if vtf[a:a+3]==b'\x01\x00\x00':offset=struct.unpack_from('<I',vtf,a+4)[0]
    result=Image.new('RGB',(max(w,1),max(h,1)))
    def rgb(v):return ((v>>11)*255//31,((v>>5)&63)*255//63,(v&31)*255//31)
    for by in range((h+3)//4):
        for bx in range((w+3)//4):
            a=offset+(by*((w+3)//4)+bx)*8
            c0,c1,bits=struct.unpack_from('<HHI',vtf,a);a0,a1=rgb(c0),rgb(c1)
            colors=[a0,a1,tuple((2*a0[k]+a1[k])//3 for k in range(3)),tuple((a0[k]+2*a1[k])//3 for k in range(3))]
            for y in range(4):
                for x in range(4):
                    if bx*4+x<w and by*4+y<h:result.putpixel((bx*4+x,by*4+y),colors[(bits>>(2*(y*4+x)))&3])
    return result
montage=Image.new('RGB',(800,math.ceil(len(material_names)/8)*94),'#ddd');draw=ImageDraw.Draw(montage)
for i,name in enumerate(material_names):
    target='materials/'+name+'.vtf'
    match=next((n for n in pak.namelist() if n.lower()==target),None)
    if match:
        try:montage.paste(thumbnail(pak.read(match)).resize((76,66)),((i%8)*100,(i//8)*94))
        except (struct.error,IndexError):pass
    draw.text(((i%8)*100,(i//8)*94+67),str(i)+' '+name.split('/')[-1][:13],fill='black')
montage.save(ref/'material-research.png')
groups={}
for face_index in range(models[0][10],models[0][10]+models[0][11]):
    a=face_index*56
    plane_id,side,onnode,firstedge,numedges,texid,dispid,fog=struct.unpack_from('<HBBihhhh',lump(7),a)
    if texid<0 or numedges<3:continue
    name=material_names[texdata[texinfo[texid][17]][3]]
    if any(s in name for s in ['tools/','water','glass/offwnd','brsbody']):continue
    polygon=[]; uvs=[]
    axes=texinfo[texid]; texture=texdata[axes[17]]
    for edge_index in surfedges[firstedge:firstedge+numedges]:
        edge=edges[abs(edge_index)];v=vertices[edge[0] if edge_index>=0 else edge[1]]
        polygon.append(point(v))
        u=(dot(v,axes[:3])+axes[3])/max(1,texture[4])
        # The reference repeats some faces with mirrored UVs. Keep their scale
        # and phase, but orient newly painted stencils left-to-right on walls.
        face_normal=normal(planes[plane_id][:3])
        if abs(face_normal[1])<.8 and dot(normal(axes[:3]),cross([0,1,0],face_normal))<0:u=-u
        uvs.append([round(u,6),round(1-(dot(v,axes[4:7])+axes[7])/max(1,texture[5]),6)])
    if all(v[0]<-18 or v[0]>18 or v[2]<-48 or v[2]>48 or v[1]<-5 for v in polygon):continue
    # This BSP stores the oriented face plane directly. Applying its legacy
    # side flag again reverses visible cargo faces and cabin interiors.
    n=normal(planes[plane_id][:3])
    data=groups.setdefault(name,{'positions':[],'normals':[],'uvs':[]})
    for j in range(1,len(polygon)-1):
        tri=[polygon[0],polygon[j],polygon[j+1]];uvtri=[uvs[0],uvs[j],uvs[j+1]]
        area=cross([tri[1][k]-tri[0][k] for k in range(3)],[tri[2][k]-tri[0][k] for k in range(3)])
        if dot(area,n)<0:tri[1],tri[2]=tri[2],tri[1];uvtri[1],uvtri[2]=uvtri[2],uvtri[1]
        data['positions'].extend(v for p in tri for v in p);data['normals'].extend(n*3);data['uvs'].extend(v for uv in uvtri for v in uv)
spawns=[]
for team,classname in enumerate(['info_player_counterterrorist','info_player_terrorist']):
    es=[e for e in entities if e.get('classname')==classname]
    for e in es[:8]:
        x,y,z=point(list(map(float,e['origin'].split())))
        spawns.append({'x':x,'y':0,'z':z,'team':team,'yaw':0 if team==0 else math.pi})
metadata={'url':'https://gamebanana.com/mods/111054','authors':['SmileGate (original map)','Riding crab snails (conversion)','ElysiumLeoSK (compile/screenshots)'],'sourceSha256':hashlib.sha256(raw).hexdigest(),'sourceUnitScale':S,'transform':{'sourceCentre':C,'axes':'[-X, Z, Y]'},'originalEngineUnitsVerified':False,'adaptation':'Numeric structural geometry only. Repainted with bundled CC0 PBR materials. No original textures, logos, entities or code copied.'}
dest=root/'games/freight-fire/assets/maps';dest.mkdir(exist_ok=True,parents=True)
(dest/'classic-geometry.json').write_text(json.dumps(groups,separators=(',',':')),encoding='utf-8')
(dest/'classic-source.json').write_text(json.dumps(metadata,indent=2)+'\n',encoding='utf-8')
module={'bounds':{'minX':-14.45,'maxX':14.3,'minZ':-44.15,'maxZ':43.8},'boxes':solids,'spawns':spawns,'reference':metadata}
(root/'games/freight-fire/classic-map-data.js').write_text('// Derived structural reference; see assets/maps/classic-source.json.\nexport default '+json.dumps(module,separators=(',',':'))+';\n',encoding='utf-8')
(ref/'inspection.json').write_text(json.dumps({'materials':material_names,'solids':solids,'spawns':spawns},indent=2),encoding='utf-8')
print(json.dumps({'solids':len(solids),'materialGroups':len(groups),'triangles':sum(len(g['positions'])//9 for g in groups.values()),'geometryBytes':(dest/'classic-geometry.json').stat().st_size,'spawns':spawns}))
