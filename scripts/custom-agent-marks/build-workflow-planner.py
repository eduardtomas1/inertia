"""Cute Inertia workflow planner. Rebuild with blender-run --threads 2."""
import argparse
import math
from pathlib import Path
import sys
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import themed_common as c

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[2] / 'source-assets/custom-agent-marks/workflow-planner')
parser.add_argument('--size', type=int, default=900)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])

m = c.initialize('workflow-planner')
vest = c.material('Planner | deep sage utility canvas', (.19, .32, .255), .73)
trim = c.material('Planner | soft sage binding', (.34, .45, .34), .70)
sleeve = c.material('Planner | warm rolled linen', (.76, .70, .55), .82)
seam = c.material('Planner | subtle stitching', (.45, .53, .39), .82)
cover = c.material('Planner | dark teal pad cover', (.035, .14, .14), .53)
paper = c.material('Planner | ivory planning paper', (.91, .86, .70), .88)
rule = c.material('Planner | pale ruled ink', (.30, .40, .34), .78)
pencil = c.material('Planner | mustard pencil lacquer', (.78, .42, .07), .4)
wood = c.material('Planner | exposed pencil cedar', (.62, .38, .18), .79)
number_mat = c.material('Planner | floating mint numbers', (.30, .49, .40), .50)

c.add_head()
body = c.base_body(arms={
    'Left': [(-.25, 0, 1.63), (-.43, -.025, 1.43), (-.50, -.13, 1.17), (-.40, -.49, 1.065)],
    'Right': [( .25, 0, 1.63), ( .44, -.025, 1.42), ( .52, -.14, 1.20), ( .29, -.57, 1.43)],
}, strong=True)

# A broad little vest gives strength without changing the relaxed stickman pose.
c.loft('Planner | rounded utility vest', [
    (.87,.30,.185), (.885,.345,.215), (.94,.355,.225),
    (1.12,.365,.233), (1.37,.385,.24), (1.55,.378,.235),
    (1.65,.335,.21), (1.72,.245,.165), (1.74,.17,.14),
], vest)
c.folded_panel('Planner | fitted linen neckline', [
    (-.14,-.179,1.735),(.14,-.179,1.735),(.105,-.246,1.55),
    (0,-.253,1.40),(-.105,-.246,1.55),
], sleeve)
for label, sign in [('Left',-1), ('Right',1)]:
    c.sweep(label+' | planner short linen sleeve', [
        ((sign*.25,0,1.63),.135,.145),
        ((sign*.32,-.005,1.60),.157,.153),
        ((sign*.405,-.020,1.46),.150,.145),
        ((sign*.455,-.050,1.33),.135,.13),
    ], sleeve)
    c.sweep(label+' | planner rolled sleeve cuff', [
        ((sign*.433,-.032,1.39),.143,.138),
        ((sign*.443,-.043,1.365),.153,.145),
        ((sign*.465,-.066,1.30),.145,.139),
        ((sign*.470,-.070,1.287),.133,.13),
    ], paper)
    c.folded_panel(label+' | planner vest shoulder binding', [
        (sign*.15,-.180,1.73),(sign*.27,-.150,1.69),
        (sign*.315,-.213,1.54),(sign*.15,-.255,1.42),
        (sign*.075,-.255,1.49),
    ], trim, .028)
    c.line(label+' | vest pocket top', [
        (sign*.19,-.243,1.17),(sign*.27,-.231,1.17),(sign*.32,-.214,1.18),
    ], .008, seam)
c.line('Planner | vest front binding', [(0,-.247,1.41),(0,-.242,1.18),(0,-.227,.92)], .017, trim)
for z in [1.34,1.18,1.02]:
    c.ball('Planner | utility snap', (0,-.265,z), (.020,.011,.020), m['brass'])

# The notepad sits against the supporting left palm. Pencil tip meets the paper.
pad = [(-.44,1.015),(.16,1.015),(.16,1.535),(-.44,1.535)]
c.prism('Planner | rounded notepad cover', pad, -.535, .065, cover, .032)
c.prism('Planner | block of ivory pages', [(-.421,1.039),(.141,1.039),(.141,1.512),(-.421,1.512)], -.583, .030, paper, .020)
# Three compact checked tasks form a small, explicit top-to-bottom workflow.
task_centers = [1.40,1.265,1.13]
for i,z in enumerate(task_centers,1):
    c.rounded_box('Planner | workflow task '+str(i)+' border', (-.135,-.611,z), (.35,.010,.077), rule, .012)
    c.rounded_box('Planner | workflow task '+str(i)+' paper', (-.135,-.618,z), (.326,.010,.055), paper, .009)
    c.line('Planner | workflow task '+str(i)+' checkmark', [(-.280,-.628,z),(-.264,-.628,z-.012),(-.237,-.628,z+.015)], .007, cover)
    c.line('Planner | workflow task '+str(i)+' short label', [(-.208,-.628,z),(-.025,-.628,z)], .0055, rule)
for i,z in enumerate([1.317,1.182],1):
    c.line('Planner | workflow link '+str(i), [(-.135,-.626,z+.038),(-.135,-.626,z)], .0055, cover)
    c.line('Planner | workflow arrow '+str(i), [(-.151,-.626,z+.014),(-.135,-.626,z),(-.119,-.626,z+.014)], .0055, cover)
for x in [-.34,-.24,-.14,-.04,.06]:
    c.ring('Planner | little brass top binding loop', (x,-.563,1.535), .028, .009, m['brass'])
c.ball('Planner | support thumb on page edge', (-.365,-.624,1.077), (.062,.038,.065), m['porcelain'])
# The pencil is drawn slightly forward of the mitten, with its tip touching the pad.
c.rod('Planner | sharpened graphite tip', (.084,-.605,1.286),(.108,-.612,1.310), .010, m['ink'], False)
c.rod('Planner | sharpened cedar', (.108,-.612,1.310),(.144,-.622,1.346), .023, wood, False)
c.rod('Planner | planning pencil', (.144,-.622,1.346),(.418,-.700,1.620), .025, pencil, False)
c.rod('Planner | brass pencil cap', (.408,-.697,1.610),(.440,-.707,1.642), .027, m['brass'], False)
c.ball('Planner | writing thumb curls around pencil', (.269,-.670,1.476), (.047,.049,.064), m['porcelain'])

# A restrained ascending thought: three small numerals, each kept off the logo.
collection = body['body'].users_collection[0]
for digit, x, z in [('1', .98, 2.38), ('2', 1.15, 2.84), ('3', 1.03, 3.31)]:
    curve = bpy.data.curves.new('Planner | floating thought '+digit, 'FONT')
    curve.body = digit
    curve.align_x = 'CENTER'
    curve.align_y = 'CENTER'
    curve.size = .255
    curve.extrude = .017
    curve.bevel_depth = .006
    curve.bevel_resolution = 3
    obj = bpy.data.objects.new('Planner | floating step '+digit, curve)
    collection.objects.link(obj)
    obj.location = (x,-.12,z)
    obj.rotation_euler = (math.pi/2,0,0)
    obj.data.materials.append(number_mat)
    c.fit_to_head(obj)
for x,z,scale in [(.80,2.10,.025),(.89,2.22,.034),(1.10,2.58,.022),(1.13,3.07,.022)]:
    c.fit_to_head(c.ball('Planner | thought dot', (x,-.11,z), (scale,)*3, number_mat))

bpy.context.scene['design_notes'] = 'Cute heavy-workflow planner: broad utility vest, rolled linen sleeves, supported notepad with three linked checked tasks, contacting pencil and sparse 1/2/3 thought motif; exact floating cursor head; no neck or face.'
c.finish_scene('workflow-planner', args.output, resolution=args.size)
