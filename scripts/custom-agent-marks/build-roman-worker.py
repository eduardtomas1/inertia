"""Cute Roman worker study. Editable meshes, shared studio, no app integration.

Run via blender-run --threads 2 while holding /tmp/inertia-themed-render.lock.
"""
from pathlib import Path
import argparse
import math
import sys

import bpy
import bmesh
from mathutils import Vector


def mesh_object(name, vertices, faces, material, collection, bevel=0.0, smooth=True):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.data.materials.append(material)
    for face in mesh.polygons:
        face.use_smooth = smooth
    if bevel:
        modifier = obj.modifiers.new('Soft toy edge', 'BEVEL')
        modifier.width = bevel
        modifier.segments = 3
        obj.modifiers.new('Weighted plate normals', 'WEIGHTED_NORMAL')
    return obj


def contour(theta, width, depth):
    """Rounded rectangle section, softly flattened at the chest."""
    c, s = math.cos(theta), math.sin(theta)
    return (width * math.copysign(abs(c) ** .68, c),
            depth * math.copysign(abs(s) ** .68, s))


def armor_band(name, z, width, depth, height, material, collection):
    count = 64
    vertices = []
    for w, d, level in [(width, depth, z-height/2),
                         (width, depth, z+height/2),
                         (width-.035, depth-.035, z+height/2),
                         (width-.035, depth-.035, z-height/2)]:
        vertices += [(*contour(2*math.pi*i/count, w, d), level) for i in range(count)]
    faces = []
    for ring in range(4):
        following = (ring + 1) % 4
        for i in range(count):
            j = (i+1) % count
            faces.append((ring*count+i, ring*count+j,
                          following*count+j, following*count+i))
    obj = mesh_object(name, vertices, faces, material, collection, .018)
    for index, face in enumerate(obj.data.polygons):
        face.use_smooth = index // count in [0, 2]
    return obj


def cloth_loft(name, rings, material, collection):
    count = 64
    vertices = []
    for z, width, depth in rings:
        for i in range(count):
            theta = 2*math.pi*i/count
            x, y = contour(theta, width, depth)
            # Subtle vertical cloth channels give the hem softness without noise.
            fold = .009 * math.cos(theta * 12)
            vertices.append((x*(1+fold), y*(1+fold), z))
    faces = [tuple(range(count-1,-1,-1))]
    for ring in range(len(rings)-1):
        for i in range(count):
            j = (i+1) % count
            faces.append((ring*count+i, ring*count+j,
                          (ring+1)*count+j, (ring+1)*count+i))
    faces.append(tuple((len(rings)-1)*count+i for i in range(count)))
    obj = mesh_object(name, vertices, faces, material, collection)
    sub = obj.modifiers.new('Soft cloth silhouette', 'SUBSURF')
    sub.levels = sub.render_levels = 2
    return obj


def shoulder_plate(name, center_x, half_width, base_z, material, collection):
    steps = 20
    vertices = []
    for shell in [0, 1]:
        for x in [center_x-half_width, center_x+half_width]:
            for i in range(steps+1):
                angle = math.pi * i / steps
                vertices.append((x, -.22*math.cos(angle),
                                 base_z+.10*math.sin(angle)-shell*.035))
    n = steps+1
    faces = []
    for i in range(steps):
        faces += [(i,i+1,n+i+1,n+i),
                  (2*n+i,3*n+i,3*n+i+1,2*n+i+1),
                  (i,2*n+i,2*n+i+1,i+1),
                  (n+i,n+i+1,3*n+i+1,3*n+i)]
    faces += [(0,n,3*n,2*n),(steps,2*n+steps,3*n+steps,n+steps)]
    return mesh_object(name, vertices, faces, material, collection, .015)


# Scene construction below uses the shared family kit once imported.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import themed_common as c

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=Path('source-assets/custom-agent-marks/roman-worker'))
parser.add_argument('--size', type=int, default=900)
args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
args.output.mkdir(parents=True, exist_ok=True)
materials = c.initialize('roman-worker')
porcelain = materials['porcelain']
leather = c.material('Roman | warm chestnut leather', (.105,.053,.025), .52)
steel = c.material('Roman | satin warm silver armor', (.43,.47,.45), .30, .65)
brass = c.material('Roman | antique honey brass', (.48,.29,.095), .30, .68)
red = c.material('Roman | warm red wool tunic', (.37,.047,.034), .75)
crest_red = c.material('Roman | red horsehair crest', (.44,.041,.027), .72)
crest_dark = c.material('Roman | crest fibers', (.29,.022,.014), .82)
shadow = c.material('Roman | armor underlayer', (.115,.105,.085), .62)
accessories = bpy.data.collections.new('ROMAN | editable fitted armor and uniform')
bpy.context.scene.collection.children.link(accessories)

c.add_head()
body = c.base_body(arms={
    'Left':[(-.25,0,1.63),(-.43,-.005,1.39),(-.46,-.10,1.08)],
    'Right':[(.25,0,1.63),(.43,-.005,1.39),(.46,-.10,1.08)]
}, shoes=False)
# The continuous body forms the wool-covered upper chest below the floating head.
body['body'].data.materials.clear()
body['body'].data.materials.append(red)

# The short wool tunic remains clearly visible below the waist armor.
cloth_loft('Tunic | short rounded wool skirt', [
    (.88,.345,.232),(.90,.388,.25),(.98,.392,.25),
    (1.17,.327,.226),(1.42,.31,.22),(1.61,.33,.222),
    (1.66,.31,.21)
],red,accessories)
cloth_loft('Cuirass | soft dark underlayer',[
    (1.19,.285,.185),(1.23,.305,.198),(1.43,.33,.205),
    (1.61,.31,.198),(1.67,.28,.18)
],shadow,accessories)

for index,(z,width,depth) in enumerate([
    (1.285,.337,.245),(1.435,.367,.258),(1.585,.363,.252)
],1):
    armor_band(f'Cuirass | curved segment {index}',z,width,depth,.135,steel,accessories)
    # Four restrained front rivets expose the assembly without visual clutter.
    for side in [-1,1]:
        c.ball(f'Cuirass | segment {index} brass rivet {side}',
               (side*.245,-depth-.009,z),(.019,.013,.019),brass)
    c.rounded_box(f'Cuirass | central join {index}',(0,-depth-.012,z),
                  (.028,.018,.085),brass,.008)

# Separate rounded shoulder plates reproduce a lorica-like segmented profile.
for side,label in [(-1,'Left'),(1,'Right')]:
    c.sweep(f'{label} | red short sleeve',[
        ((side*.27,0,1.62),.13,.15),
        ((side*.34,0,1.55),.132,.15),
        ((side*.385,0,1.46),.115,.13)
    ],red)
    for index,(center,half_width,z) in enumerate([
        (.285,.065,1.66),(.385,.055,1.60),(.465,.046,1.53)
    ],1):
        shoulder_plate(f'{label} shoulder | segment {index}',side*center,
                       half_width,z,steel,accessories)
        c.ball(f'{label} shoulder | brass rivet {index}',
               (side*center,-.223,z+.025),(.018,.012,.018),brass)

# Thick but compact belt and the characteristic hanging leather apron strips.
armor_band('Belt | chestnut leather',1.17,.337,.252,.105,leather,accessories)
c.rounded_box('Belt | square brass buckle',(0,-.27,1.174),(.16,.045,.105),brass,.025)
c.rounded_box('Belt | recessed leather buckle center',(0,-.299,1.174),(.085,.012,.048),leather,.01)
for index,x in enumerate([-.18,-.06,.06,.18],1):
    panel = [(x-.038,1.155),(x+.038,1.155),(x+.038,.902),
             (x+.020,.88),(x-.020,.88),(x-.038,.902)]
    c.prism(f'Apron | rounded leather strip {index}',panel,-.272,.026,leather,.014)
    for z in [.935,1.02,1.10]:
        c.ball(f'Apron | brass stud {index} at {z}',(x,-.292,z),(.014,.010,.014),brass)

# Greaves protect the short shins, while small open sandals preserve the white limbs.
for side,label in [(-1,'Left'),(1,'Right')]:
    x=side*.205
    c.prism(f'{label} | rounded shin greave',[
        (x-.077,.285),(x+.077,.285),(x+.095,.55),
        (x+.06,.60),(x-.06,.60),(x-.095,.55)
    ],-.088,.075,steel,.035)
    c.line(f'{label} | greave central soft ridge',[
        (x,-.135,.32),(x,-.142,.45),(x,-.135,.555)
    ],.014,brass)
    c.ball(f'{label} | sandal sole',(x,-.055,.065),(.155,.225,.065),leather)
    c.ball(f'{label} | exposed soft toe',(x,-.095,.133),(.132,.19,.075),porcelain)
    for number,y in enumerate([-.16,-.025],1):
        c.line(f'{label} sandal | rounded leather strap {number}',[
            (x-.128,y,.119),(x-.10,y,.184),(x,y,.21),
            (x+.10,y,.184),(x+.128,y,.119)
        ],.025,leather)
    c.ball(f'{label} sandal | brass fastening',(x+side*.111,-.03,.18),(.02,.017,.019),brass)

# The small helmet cap follows the cursor's upper slope. The exposed blank face
# and every direction-change of the source pointer remain visually readable.
c.prism('Helmet | fitted silver upper cap',[
    (-.696,4.005),(.798,3.017),(.746,2.952),(-.688,3.902)
],-.104,.07,steel,.027)
c.line('Helmet | fine brass rim',[
    (-.683,-.15,3.907),(-.15,-.15,3.555),(.35,-.15,3.224),(.746,-.15,2.962)
],.019,brass)

# Short diagonal plume sits on the upper cap rather than covering the face.
crest_start = Vector((-.605,3.956))
crest_end = Vector((.29,3.364))
crest_normal = Vector((.552,.834))
crest_outline = [tuple(crest_start),tuple(crest_end),
                 tuple(crest_end+crest_normal*.115),
                 tuple(crest_start+crest_normal*.15)]
c.prism('Helmet | compact red crest',crest_outline,.025,.145,crest_red,.035)
for index in range(13):
    t = (index+.65)/14
    base = crest_start.lerp(crest_end,t)
    tip = base+crest_normal*(.15-.035*t)
    c.line(f'Helmet | subtle crest fiber {index+1}',[
        (base.x,-.05,base.y+.005),
        ((base.x+tip.x)/2,-.058,(base.y+tip.y)/2),
        (tip.x,-.05,tip.y-.008)
    ],.006,crest_dark)
c.line('Helmet | brass crest saddle',[
    (crest_start.x,-.055,crest_start.y),
    (-.15,-.055,3.655),
    (crest_end.x,-.055,crest_end.y)
],.035,brass)

c.finish_scene('roman-worker',args.output,resolution=args.size)
