"""Cute practical builder/fixer with shared floating cursor head and studio.

flock /tmp/inertia-themed-render.lock blender-run --threads 2 \
  scripts/custom-agent-marks/build-builder.py \
  --output source-assets/custom-agent-marks/builder --size 900
"""
import argparse
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import themed_common as c

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=Path('source-assets/custom-agent-marks/builder'))
parser.add_argument('--size', type=int, default=900)
args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
args.output.mkdir(parents=True, exist_ok=True)
materials = c.initialize('builder')
white = materials['porcelain']
cream = c.material('Builder | warm cream work shirt',(.79,.735,.61),.76)
denim = c.material('Builder | soft indigo denim',(.075,.205,.34),.78)
denim_light = c.material('Builder | pocket denim',(.09,.25,.40),.75)
denim_dark = c.material('Builder | denim seams',(.045,.135,.235),.83)
stitch = c.material('Builder | restrained flax stitching',(.43,.46,.405),.79)
leather = c.material('Builder | warm saddle leather',(.245,.115,.052),.56)
sole = c.material('Builder | dark rubber soles',(.065,.055,.045),.68)
steel = c.material('Builder | satin steel wrench',(.44,.51,.55),.29,.66)
steel_inset = c.material('Builder | wrench handle recess',(.28,.35,.39),.40,.60)
brass = c.material('Builder | old brass fasteners',(.46,.30,.11),.36,.57)
pencil = c.material('Builder | carpenter pencil ochre',(.58,.34,.07),.70)
eraser = c.material('Builder | pencil eraser',(.46,.20,.14),.80)

c.add_head()
body = c.base_body(arms={
    'Left':[(-.245,0,1.63),(-.37,-.008,1.43),(-.44,-.06,1.10)],
    'Right':[(.245,0,1.63),(.405,-.015,1.405),(.50,-.115,1.075)]
},shoes=False)
body['body'].data.materials.clear()
body['body'].data.materials.append(cream)

# Soft denim trousers sit over the small shared legs, with no change of stance.
c.loft('Overalls | rounded denim hips',[
    (.82,.17,.13),(.86,.27,.185),(.97,.292,.205),
    (1.10,.287,.207),(1.20,.267,.19)
],denim)
for sign,label in [(-1,'Left'),(1,'Right')]:
    c.sweep(f'{label} | denim trouser leg',[
        ((sign*.15,0,.98),.13,.124),
        ((sign*.18,0,.84),.13,.126),
        ((sign*.20,-.01,.58),.115,.112),
        ((sign*.20,0,.35),.103,.101),
        ((sign*.20,0,.205),.102,.10)
    ],denim)
    c.sweep(f'{label} | soft trouser cuff',[
        ((sign*.20,0,.225),.105,.104),
        ((sign*.20,0,.25),.108,.105),
        ((sign*.20,0,.28),.105,.103)
    ],denim_dark)
    c.rounded_box(f'{label} | compact work boot',
                  (sign*.20,-.075,.125),(.285,.385,.23),leather,.075)
    c.rounded_box(f'{label} | boot rubber sole',
                  (sign*.20,-.079,.035),(.29,.39,.065),sole,.027)
    c.line(f'{label} | boot toe seam',[
        (sign*.20-.10,-.18,.205),(sign*.20,-.205,.223),
        (sign*.20+.10,-.18,.205)
    ],.008,leather)

# Cream sleeves end in small rounded rolls, exposing the porcelain forearms.
for label,points in {
    'Left':[(-.245,0,1.63),(-.31,-.003,1.53),(-.37,-.008,1.405)],
    'Right':[(.245,0,1.63),(.325,-.006,1.52),(.40,-.015,1.39)]
}.items():
    c.sweep(f'{label} | cream shirt sleeve',[
        (points[0],.128,.135),(points[1],.125,.129),(points[2],.102,.109)
    ],cream)
    end=Vector(points[-1]); previous=Vector(points[-2]); direction=(end-previous).normalized()
    c.sweep(f'{label} | rolled cream cuff',[
        (tuple(end-direction*.05),.108,.115),
        (tuple(end-direction*.01),.119,.122),
        (tuple(end+direction*.025),.111,.116)
    ],cream)

# Slightly rounded bib and wide straps form one clear overall silhouette.
c.prism('Overalls | rounded front bib',[
    (-.245,1.18),(.245,1.18),(.223,1.54),(.18,1.605),
    (-.18,1.605),(-.223,1.54)
],-.193,.035,denim,.035)

def strap(label,x):
    centers=[(-.222,1.55),(-.195,1.66),(-.11,1.716),
             (0,1.733),(.11,1.69),(.176,1.57),(.187,1.23)]
    vertices=[(x+offset,y,z) for y,z in centers for offset in [-.039,.039]]
    faces=[(i*2,i*2+1,i*2+3,i*2+2) for i in range(len(centers)-1)]
    obj=c.surface(f'Overalls | {label} broad shoulder strap',vertices,faces,denim,2)
    solid=obj.modifiers.new('Thick soft denim strap','SOLIDIFY'); solid.thickness=.019
    return obj

for sign,label in [(-1,'Left'),(1,'Right')]:
    strap(label,sign*.19)
    c.ball(f'{label} strap | rounded brass fastening',
           (sign*.19,-.232,1.545),(.028,.015,.028),brass)

# One small pocket and a single carpenter pencil are the only extra detail cue.
c.rounded_box('Bib | small practical patch pocket',(0,-.23,1.365),
              (.245,.025,.19),denim_light,.035)
c.line('Bib | subtle pocket seam',[
    (-.104,-.247,1.42),(-.103,-.25,1.315),(0,-.25,1.295),
    (.103,-.25,1.315),(.104,-.247,1.42)
],.0055,stitch)
c.rounded_box('Bib pocket | tiny carpenter pencil',
              (-.052,-.221,1.505),(.027,.022,.20),pencil,.007)
c.rounded_box('Bib pocket | tiny eraser',
              (-.052,-.221,1.609),(.029,.024,.023),eraser,.007)

# A close-fitting work belt with one small empty pouch stays secondary to the bib.
c.loft('Tool belt | warm brown waist band',[
    (1.105,.292,.215),(1.12,.307,.224),(1.19,.307,.224),(1.205,.29,.21)
],leather)
c.rounded_box('Tool belt | compact brass buckle',(.03,-.244,1.154),
              (.12,.035,.081),brass,.018)
c.rounded_box('Tool belt | buckle leather center',(.03,-.266,1.154),
              (.064,.012,.039),leather,.009)
c.rounded_box('Tool belt | small side pouch',(-.255,-.19,1.005),
              (.18,.14,.235),leather,.045)
c.line('Tool belt | pouch top rolled edge',[
    (-.33,-.265,1.105),(-.255,-.277,1.115),(-.18,-.265,1.105)
],.015,leather)

# A short open-ended wrench hangs casually from the relaxed right hand.
# The continuous handle passes through the closed mitten; both visible ends
# meet the same grip axis and the small thumb wraps its front face.
grip=Vector((.50,-.115,1.075))
angle=math.radians(14)

def wrench_point(x,z):
    return (grip.x+x*math.cos(angle)-z*math.sin(angle),
            grip.z+x*math.sin(angle)+z*math.cos(angle))

wrench_outline=[
    (-.031,.16),(.031,.16),(.040,.12),(.038,-.20),
    (.09,-.245),(.135,-.30),(.14,-.35),(.12,-.425),(.07,-.457),
    (.04,-.402),(.068,-.355),(.035,-.305),(-.035,-.305),
    (-.068,-.355),(-.04,-.402),(-.07,-.457),(-.12,-.425),
    (-.14,-.35),(-.135,-.30),(-.09,-.245),(-.038,-.20),(-.040,.12)
]
c.prism('Wrench | continuous open jaw and handle',
        [wrench_point(x,z) for x,z in wrench_outline],grip.y,.062,steel,.014)
# A shallow darker handle inset suggests forged steel, visible below the grip.
c.prism('Wrench | shallow forged handle inset',
        [wrench_point(x,z) for x,z in [(-.013,-.12),(.013,-.12),(.013,-.20),(-.013,-.20)]],
        grip.y-.034,.007,steel_inset,.008)

# Weld a small thumb into the right mitten to make the tool contact unambiguous.
mitten=bpy.data.objects['Right | little mitten']
thumb=c.ball('Right | thumb around wrench',
             (grip.x-.044,grip.y-.064,grip.z+.025),(.044,.035,.052),white)
bpy.ops.object.select_all(action='DESELECT')
mitten.select_set(True); thumb.select_set(True)
bpy.context.view_layer.objects.active=mitten
bpy.ops.object.join()
mitten.name='Right | continuous mitten gripping wrench'
remesh=mitten.modifiers.new('Weld thumb to palm','REMESH')
remesh.mode='VOXEL'; remesh.voxel_size=.008; remesh.use_smooth_shade=True
bpy.ops.object.modifier_apply(modifier=remesh.name)
soften=mitten.modifiers.new('Soften grip transitions','SMOOTH')
soften.factor=.75; soften.iterations=4
sub=mitten.modifiers.new('Soft porcelain hand finish','SUBSURF')
sub.levels=sub.render_levels=1

bpy.context.scene['role']='Builder / Fixer | friendly practical execution worker'
bpy.context.scene['detail_cues']='Blue overalls; cream rolled sleeves; warm brown tool belt; open-ended wrench; one tiny pencil.'
c.finish_scene('builder',args.output,resolution=args.size)
