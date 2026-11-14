"""Cute Inertia writer/scribe. Rebuild with blender-run --threads 2."""
import argparse
from pathlib import Path
import sys
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import themed_common as c

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[2] / 'source-assets/custom-agent-marks/writer')
parser.add_argument('--size', type=int, default=900)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])

m = c.initialize('writer')
cardigan = c.material('Writer | cozy mulberry cardigan', (.29, .155, .235), .83)
knit = c.material('Writer | ribbed rose binding', (.43, .245, .34), .82)
shirt = c.material('Writer | warm ivory shirt', (.88, .80, .62), .85)
cover = c.material('Writer | blue cloth notebook cover', (.075, .20, .26), .75)
pages = c.material('Writer | warm writing paper', (.95, .88, .72), .9)
page_edge = c.material('Writer | paper edge shade', (.75, .64, .47), .9)
ink = c.material('Writer | soft blue handwriting', (.24, .34, .39), .84)
pen = c.material('Writer | midnight fountain pen', (.025, .075, .10), .32)
bookmark = c.material('Writer | terracotta ribbon bookmark', (.68, .235, .105), .76)

c.add_head()
body = c.base_body(arms={
    'Left': [(-.25,0,1.63),(-.39,-.025,1.43),(-.47,-.13,1.16),(-.34,-.53,1.075)],
    'Right': [( .25,0,1.63),( .39,-.025,1.43),( .47,-.14,1.18),( .31,-.57,1.49)],
})
c.loft('Writer | soft cardigan body', [
    (.87,.245,.16),(.885,.28,.181),(.93,.292,.19),
    (1.14,.283,.198),(1.35,.292,.208),(1.56,.30,.204),
    (1.66,.275,.183),(1.72,.21,.145),(1.74,.14,.125),
], cardigan)
c.folded_panel('Writer | ivory shirt at V neckline', [
    (-.12,-.155,1.738),(.12,-.155,1.738),(.095,-.212,1.56),
    (0,-.226,1.39),(-.095,-.212,1.56),
], shirt)
for label, sign in [('Left',-1), ('Right',1)]:
    end = (-.365,-.436,1.093) if sign < 0 else (.350,-.449,1.417)
    c.sweep(label+' | continuous cardigan sleeve', [
        ((sign*.24,0,1.64),.108,.12),
        ((sign*.30,-.005,1.60),.126,.128),
        ((sign*.385,-.027,1.43),.117,.12),
        ((sign*.46,-.105,1.20),.105,.109),
        ((sign*.46,-.17,1.16 if sign<0 else 1.20),.103,.106),
        ((sign*.41,-.30,1.12 if sign<0 else 1.31),.095,.10),
        (end,.087,.092),
    ], cardigan)
    # Full sleeves cover the reusable skin mesh; the separate mittens stay visible.
    body['arms'][label].hide_render = True
    body['arms'][label].hide_viewport = True
    cuff_start = (-.383,-.39,1.103) if sign<0 else (.367,-.403,1.395)
    cuff_end = (-.355,-.47,1.085) if sign<0 else (.334,-.507,1.459)
    c.sweep(label+' | soft ribbed cuff', [
        (cuff_start,.092,.099),(end,.099,.105),(cuff_end,.092,.098),
    ], knit)
    c.line(label+' | cardigan V neck binding', [
        (sign*.126,-.162,1.735),(sign*.16,-.216,1.65),
        (sign*.11,-.232,1.51),(0,-.230,1.35),
    ], .025, knit)
    c.line(label+' | cardigan pocket seam', [
        (sign*.12,-.198,1.07),(sign*.20,-.186,1.06),(sign*.245,-.164,1.08),
    ], .007, knit)
c.line('Writer | cardigan button placket', [(0,-.224,1.35),(0,-.211,1.11),(0,-.192,.90)], .020, knit)
for z in [1.31,1.14,.98]:
    c.ball('Writer | cardigan horn button', (.010,-.247,z), (.020,.011,.020), m['brass'])
# A tiny chest pencil pocket reinforces the garment without adding text.
c.folded_panel('Writer | small cardigan chest pocket', [(.16,-.214,1.47),(.255,-.191,1.47),(.25,-.198,1.37),(.16,-.221,1.37)], knit, .012)
# A discreet pair of quotation marks sits on the cardigan's left neck binding.
for x in [-.165,-.130]:
    c.ball('Writer | quotation pin head', (x,-.249,1.637), (.012,.009,.016), m['brass'])
    c.line('Writer | quotation pin comma tail', [(x+.006,-.250,1.631),(x+.004,-.251,1.615),(x-.006,-.251,1.607)], .0055, m['brass'])

# An open notebook in a shallow V; the supporting hand cups its lower-left edge.
left_cover = [(-.43,-.605,1.045),(-.10,-.553,1.03),(-.10,-.553,1.49),(-.43,-.605,1.51)]
right_cover = [(-.10,-.553,1.03),(.24,-.605,1.045),(.24,-.605,1.51),(-.10,-.553,1.49)]
c.folded_panel('Writer | left blue notebook cover', left_cover, cover, .040)
c.folded_panel('Writer | right blue notebook cover', right_cover, cover, .040)
left_page = [(-.412,-.634,1.070),(-.105,-.582,1.055),(-.105,-.582,1.472),(-.412,-.634,1.488)]
right_page = [(-.095,-.582,1.055),(.222,-.634,1.070),(.222,-.634,1.488),(-.095,-.582,1.472)]
c.folded_panel('Writer | left cream page block', left_page, pages, .030)
c.folded_panel('Writer | right cream page block', right_page, pages, .030)
c.line('Writer | notebook spine crease', [(-.10,-.602,1.07),(-.10,-.603,1.27),(-.10,-.602,1.46)], .008, page_edge)
# Short understated handwriting marks, always on the actual page surface.
for i,z in enumerate([1.20,1.29,1.38]):
    c.line('Writer | left page line '+str(i), [(-.365,-.642,z+.010),(-.25,-.624,z+.005),(-.16,-.609,z)], .005, ink)
for i,z in enumerate([1.20,1.29]):
    c.line('Writer | right page line '+str(i), [(-.045,-.609,z),(.06,-.627,z+.005),(.175,-.645,z+.010)], .005, ink)
c.folded_panel('Writer | colored swallowtail bookmark', [
    (-.153,-.585,1.10),(-.108,-.585,1.10),(-.115,-.605,.955),
    (-.138,-.607,.976),(-.162,-.605,.951),
], bookmark, .012)
c.ball('Writer | supporting thumb on notebook', (-.338,-.667,1.10), (.053,.035,.063), m['porcelain'])
# The nib reaches the right page; the upper barrel crosses the writing grip.
c.rod('Writer | fountain pen gold nib', (.108,-.645,1.348),(.145,-.650,1.386), .015, m['brass'], False)
c.rod('Writer | fountain pen barrel', (.145,-.650,1.386),(.365,-.676,1.610), .026, pen, False)
c.rod('Writer | fountain pen cap band', (.318,-.670,1.562),(.336,-.673,1.581), .029, m['brass'], False)
c.rod('Writer | fountain pen finial', (.358,-.675,1.603),(.380,-.678,1.625), .025, m['brass'], False)
c.ball('Writer | writing thumb closes around pen', (.268,-.665,1.505), (.046,.045,.060), m['porcelain'])

bpy.context.scene['design_notes'] = 'Cute writer/scribe: slim cozy cardigan with tiny quotation pin, open cloth notebook with terracotta bookmark cupped in one hand and fountain-pen nib touching the right page; exact floating cursor head; no neck or face.'
c.finish_scene('writer', args.output, resolution=args.size)
