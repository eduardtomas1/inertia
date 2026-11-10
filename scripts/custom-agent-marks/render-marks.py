import argparse, math, sys, os, time, subprocess
from pathlib import Path
import bpy
from mathutils import Vector, Matrix, Euler
argv=sys.argv[sys.argv.index('--')+1:]; argv=[a for a in argv if a!='--']
p=argparse.ArgumentParser(); p.add_argument('--output',type=Path,required=True); p.add_argument('--inspection',action='store_true'); p.add_argument('--only',default=''); args=p.parse_args(argv)
args.output.mkdir(parents=True,exist_ok=True)
scene=bpy.context.scene; rig=bpy.data.objects['Inertia • standing expression rig']; rig.animation_data_clear()
for o in scene.objects:
    if o.type=='MESH': o.hide_render=not(o.name.startswith('Cursor ') or o.name.startswith('Runner '))
    if o.type=='LIGHT': o.hide_render=True
white=bpy.data.materials['Cursor porcelain']; graphite=bpy.data.materials['Graphite alloy']
props=[]
def finish(o,mat):
    o.data.materials.clear(); o.data.materials.append(mat); props.append(o)
    bevel=o.modifiers.new('Soft manufactured edges','BEVEL'); bevel.width=.035; bevel.segments=3
    o.modifiers.new('Weighted corner normals','WEIGHTED_NORMAL')
    return o

def rod(a,b,r=.085,mat=None):
    a,b=Vector(a),Vector(b); bpy.ops.mesh.primitive_cylinder_add(vertices=16,radius=r,depth=(b-a).length,location=(a+b)/2)
    o=bpy.context.object; o.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler(); return finish(o,mat or graphite)
def ring(c,r=.31,t=.085,mat=None):
    bpy.ops.mesh.primitive_torus_add(major_segments=24,minor_segments=8,location=c,major_radius=r,minor_radius=t,rotation=(math.pi/2,0,0)); return finish(bpy.context.object,mat or graphite)
def poly(points,y,depth,mat=None):
    n=len(points); verts=[(x,y+d,z) for d in [-depth/2,depth/2] for x,z in points]; faces=[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    mesh=bpy.data.meshes.new('Chunky prop'); mesh.from_pydata(verts,[],faces); mesh.update(); o=bpy.data.objects.new('Role prop',mesh); scene.collection.objects.link(o); return finish(o,mat or graphite)
def chain(u,l,target,pole):
    upper,lower=rig.pose.bones[u],rig.pose.bones[l]; bpy.context.view_layer.update(); start=upper.head.copy(); first,second=upper.bone.length,lower.bone.length
    direction=Vector(target)-start; distance=max(abs(first-second)+.002,min(direction.length,first+second-.002)); direction.normalize(); bend=Vector(pole)-direction*Vector(pole).dot(direction); bend.normalize()
    along=(first*first-second*second+distance*distance)/(2*distance); joint=start+direction*along+bend*math.sqrt(max(0,first*first-along*along)); end=start+direction*distance
    for bone,origin,tip in [(upper,start,joint),(lower,joint,end)]:
        rotation=(bone.bone.tail_local-bone.bone.head_local).normalized().rotation_difference((tip-origin).normalized())@bone.bone.matrix_local.to_quaternion(); bone.matrix=Matrix.LocRotScale(origin,rotation,Vector((1,1,1))); bpy.context.view_layer.update()
def pose(name):
    for o in props: bpy.data.objects.remove(o,do_unlink=True)
    props.clear()
    for b in rig.pose.bones: b.rotation_mode='QUATERNION'; b.rotation_quaternion=(1,0,0,0); b.location=(0,0,0); b.scale=(1,1,1)
    rig.pose.bones['spine'].rotation_quaternion=Euler((0,0,-.24)).to_quaternion()
    bpy.context.view_layer.update()
    head=rig.pose.bones['head']; pivot=head.head.copy()
    head.matrix=Matrix.Translation(pivot) @ Matrix.Rotation(.55,4,'Y') @ Matrix.Translation(-pivot) @ head.matrix
    bpy.context.view_layer.update()
    chain('upper_leg.L','lower_leg.L',(-1.03,.05,.60),(-.15,0,-1)); chain('upper_leg.R','lower_leg.R',(.60,-.04,.19),(1,0,.5))
    chain('upper_arm.L','forearm.L',(-.98,.05,1.52),(-1,0,.3)); chain('upper_arm.R','forearm.R',(.94,-.12,1.99),(1,0,-1))
    if name=='scout':
        chain('upper_arm.R','forearm.R',(.99,-.22,2.10),(1,0,-1))
        rod((.98,-.29,2.05),(1.15,-.29,2.45),.09); ring((1.25,-.29,2.72),.30,.09); ring((1.25,-.39,2.72),.30,.028,white)
    elif name=='guard':
        chain('upper_arm.R','forearm.R',(.88,-.25,1.92),(1,0,-1))
        rod((.99,-.30,1.86),(.99,-.49,1.86),.48); ring((.99,-.51,1.86),.43,.045,white); rod((.99,-.51,1.86),(.99,-.59,1.86),.12,white)
    elif name=='builder':
        rod((.94,-.28,1.88),(1.20,-.28,2.58),.13)
        jaw=[(.70,2.94),(.72,2.58),(.96,2.42),(1.38,2.42),(1.67,2.65),(1.69,3.00),(1.40,2.78),(1.13,2.73),(.98,3.06)]
        poly(jaw,-.28,.23)
        poly(jaw,-.41,.035,white)
    elif name=='scribe':
        rod((.93,-.33,1.61),(1.28,-.33,2.40),.12,white)
        rod((1.28,-.33,2.40),(1.42,-.33,2.71),.14)
        rod((.91,-.33,1.58),(.98,-.33,1.74),.13)
        poly([(.80,1.30),(.82,1.64),(1.04,1.55)],-.34,.13,white)
        poly([(.80,1.30),(.84,1.46),(.90,1.42)],-.42,.025)
    elif name=='spark':
        bolt=[(-1.42,1.17),(-1.77,.84),(-1.53,.81),(-1.81,.34),(-1.17,.90),(-1.44,.94)]
        poly(bolt,.00,.17,white)
        poly([(-1.99+(x+1.5)*.43,1.19+(z-.8)*.43) for x,z in bolt],.00,.12,white)

def light(name,loc,power,size,color):
    data=bpy.data.lights.new(name,'AREA'); o=bpy.data.objects.new(name,data); scene.collection.objects.link(o); o.location=loc; o.rotation_euler=(Vector((0,0,1.7))-o.location).to_track_quat('-Z','Y').to_euler(); data.energy=power; data.shape='DISK'; data.size=size; data.color=color; return data
key=light('Marks key',(-3,-4,6),240,4,(1,.96,.91)); fill=light('Marks fill',(3,-4,3),100,3,(.80,.88,1)); rim=light('Marks rim',(2,2,4),300,3,(.80,.89,1))
scene.world.use_nodes=True; scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.3,.34,.42,1); scene.world.node_tree.nodes['Background'].inputs[1].default_value=.25
cam=scene.camera; cam.data.type='ORTHO'; cam.data.ortho_scale=4.35; cam.location=(3,-11,2.75); cam.rotation_euler=(Vector((.08,0,1.72))-cam.location).to_track_quat('-Z','Y').to_euler()
scene.render.engine='CYCLES'; scene.cycles.samples=24; scene.cycles.use_denoising=True; scene.cycles.seed=23
scene.render.threads_mode='FIXED'; scene.render.threads=2; scene.render.resolution_x=scene.render.resolution_y=256; scene.render.resolution_percentage=100; scene.render.film_transparent=True
scene.render.image_settings.file_format='PNG'; scene.render.image_settings.color_mode='RGBA'; scene.view_settings.view_transform='AgX' if args.inspection else 'Standard'; scene.view_settings.look='None'; scene.view_settings.exposure=0
names=['runner','scout','guard','builder','scribe','spark']; selected=args.only.split(',') if args.only else names
for name in selected:
    pose(name)
    for theme in ['dark','light']:
        rim.energy=300 if theme=='dark' else 160; fill.energy=100 if theme=='dark' else 65
        graphite.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.065,.08,.10,1) if theme=='dark' else (.025,.032,.04,1)
        key.color=(1,.96,.91) if theme=='dark' else (.88,.94,1)
        key.energy=240 if theme=='dark' else 210
        scene.world.node_tree.nodes['Background'].inputs[1].default_value=.25 if theme=='dark' else .14
        fill.color=(.72,.83,1) if theme=='dark' else (.95,.97,1)
        subprocess.run(['uptime'],check=True)
        while os.getloadavg()[0]>12:
            print('Shared host load above 12; waiting 30 seconds.',flush=True); time.sleep(30); subprocess.run(['uptime'],check=True)
        scene.render.filepath=str(args.output/f'{name}-{theme}.png'); bpy.ops.render.render(write_still=True)
post=r'''
import sys,json
from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
out=Path(sys.argv[1]); names=['runner','scout','guard','builder','scribe','spark']
for path in out.glob('*-*.png'):
 if path.stem.split('-')[0] not in names: continue
 im=Image.open(path).convert('RGBA')
 alpha=im.getchannel('A'); gray=im.convert('L'); im=Image.merge('RGBA',(gray,gray,gray,alpha))
 im.save(path); im.save(path.with_suffix('.webp'),quality=90,method=6)

sheet=Image.new('RGB',(6*256,2*284)); d=ImageDraw.Draw(sheet)
small=Image.new('RGB',(6*160,2*190)); ds=ImageDraw.Draw(small)
for row,theme in enumerate(['dark','light']):
 bg='#141821' if theme=='dark' else '#f4f4f2'; fg='#eeeeee' if theme=='dark' else '#292d35'
 for col,name in enumerate(names):
  path=out/f'{name}-{theme}.png'
  if not path.exists(): continue
  im=Image.open(path); x,y=col*256,row*284; d.rectangle((x,y,x+255,y+283),fill=bg); sheet.paste(im,(x,y),im); d.text((x+16,y+260),name,fill=fg)
  x,y=col*160,row*190; ds.rectangle((x,y,x+159,y+189),fill=bg)
  for size,dx in [(32,8),(20,88)]:
   thumb=im.resize((size,size),Image.Resampling.LANCZOS); base=Image.new('RGBA',(size,size),bg); base.alpha_composite(thumb); small.paste(base.resize((size*2,size*2),Image.Resampling.NEAREST),(x+dx,y+26)); small.paste(base,(x+dx,y+110))
  ds.text((x+8,y+164),name,fill=fg)
sheet.save(out/'contact-sheet.png'); small.save(out/'readability.png')
(out/'sizes.json').write_text(json.dumps({p.name:p.stat().st_size for p in sorted(out.iterdir()) if p.suffix in ['.png','.webp']},indent=2))
'''
subprocess.run(['/usr/bin/python3','-c',post,str(args.output)],check=True)
