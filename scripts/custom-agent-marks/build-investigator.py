"""Cute investigator with floating logo head. Run with blender-run --threads 2."""
import argparse
from pathlib import Path
import sys
import math
sys.path.insert(0,str(Path(__file__).resolve().parent))
import themed_common as c

p=argparse.ArgumentParser()
p.add_argument('--output',type=Path,default=Path('source-assets/custom-agent-marks/investigator'))
p.add_argument('--size',type=int,default=900)
p.add_argument('--no-render',action='store_true')
args=p.parse_args([a for a in sys.argv[sys.argv.index('--')+1:] if a!='--'])
m=c.initialize('investigator')
coat=c.material('Investigator | honey cotton',(.52,.355,.205),.76)
lapel=c.material('Investigator | soft lapels',(.67,.49,.30),.72)
seam=c.material('Investigator | seam',(.34,.22,.12),.8)
teal=c.material('Investigator | tiny teal tie',(.04,.24,.25),.7)
poses={
    'Left':[(-.24,0,1.63),(-.36,0,1.47),(-.43,-.03,1.24),(-.43,-.075,1.03)],
    'Right':[(.24,0,1.63),(.38,0,1.43),(.49,-.035,1.23),(.59,-.09,1.35),(.71,-.16,1.55)],
}
c.base_body(arms=poses)
c.add_head()
c.loft('Coat | rounded little trench',[(.79,.29,.19),(.805,.34,.205),(.86,.345,.21),
    (1.01,.33,.21),(1.20,.30,.205),(1.46,.33,.21),(1.62,.32,.19),
    (1.70,.25,.145),(1.73,.15,.105)],coat)
for label,points in poses.items():
    # The sleeve ends above the mitten; the bent arm is a continuous soft surface.
    start=points[:-1]+[tuple(points[-2][i]*.30+points[-1][i]*.70 for i in range(3))]
    c.sweep('Coat | '+label+' soft sleeve',[(xyz,.112-.015*j/(len(start)-1),.115-.018*j/(len(start)-1)) for j,xyz in enumerate(start)],coat)
    end=start[-1]
    before=tuple(start[-2][i]*.18+end[i]*.82 for i in range(3))
    c.sweep('Coat | '+label+' cuff',[(before,.105,.106),(end,.105,.106)],lapel)
c.folded_panel('Shirt | cream opening',[(-.105,-.17,1.72),(.105,-.17,1.72),(.08,-.23,1.51),(0,-.236,1.26),(-.08,-.23,1.51)],m['shirt'],.018)
c.folded_panel('Tie | little knot',[(-.034,-.25,1.60),(.034,-.25,1.60),(.024,-.259,1.54),(-.024,-.259,1.54)],teal,.022)
c.folded_panel('Tie | short blade',[(-.023,-.26,1.55),(.023,-.26,1.55),(.04,-.265,1.33),(0,-.265,1.28),(-.04,-.265,1.33)],teal,.018)
for sign in [-1,1]:
    c.folded_panel('Coat | folded collar',[(sign*x,y,z) for x,y,z in [(.225,-.15,1.72),(.08,-.23,1.68),(.024,-.26,1.27),(.225,-.23,1.45),(.16,-.24,1.53),(.265,-.18,1.61)]],lapel,.03)
    c.line('Coat | little pocket',[(sign*.15,-.208,1.00),(sign*.24,-.195,1.055)],.009,seam)
    for z in [1.30,.98]: c.ball('Coat | horn button',(sign*.12,-.223,z),(.023,.012,.023),m['dark'])
c.loft('Coat | curved belt',[(1.14,.31,.217),(1.15,.313,.22),(1.205,.313,.22),(1.215,.31,.217)],lapel)
c.rounded_box('Coat | small buckle',(0,-.243,1.177),(.12,.025,.095),m['brass'],.014)
c.rounded_box('Coat | buckle inset',(0,-.26,1.177),(.075,.009,.055),coat,.009)
c.line('Coat | center seam',[(0,-.216,.86),(0,-.219,1.10)],.004,seam)

# Two quiet role cues: an enquiry pin and a little clue card tucked in a pocket.
c.line('Investigator | question mark lapel pin',[
    (-.191,-.269,1.545),(-.183,-.269,1.559),(-.157,-.269,1.557),
    (-.148,-.269,1.542),(-.166,-.269,1.526),(-.166,-.269,1.516),
],.006,m['brass'])
c.ball('Investigator | question pin dot',(-.166,-.269,1.494),(.008,.006,.008),m['brass'])
c.rounded_box('Investigator | pocket clue card',(-.206,-.225,1.047),(.109,.018,.143),m['shirt'],.009)
clues=[(-.236,-.239,1.084),(-.180,-.239,1.071),(-.210,-.239,1.036)]
c.line('Investigator | linked clue notes',clues,.003,teal)
for point in clues:
    c.ball('Investigator | clue dot',point,(.007,.004,.007),teal)
c.line('Investigator | pocket lip over card',[(-.267,-.243,1.017),(-.207,-.245,1.009),(-.145,-.243,1.001)],.009,coat)

# Glasses and magnifier share a quiet, thin clear lens finish.
glass=c.material('Investigator | clear lenses',(.85,.96,1),.12)
bsdf=glass.node_tree.nodes.get('Principled BSDF')
glass.surface_render_method='BLENDED'
glass.use_transparency_overlap=False
transparent=glass.node_tree.nodes.new('ShaderNodeBsdfTransparent')
transparent.inputs[0].default_value=(.98,.99,1,1)
mix=glass.node_tree.nodes.new('ShaderNodeMixShader')
mix.inputs[0].default_value=.04
glass.node_tree.links.new(transparent.outputs[0],mix.inputs[1])
glass.node_tree.links.new(bsdf.outputs[0],mix.inputs[2])
glass.node_tree.links.new(mix.outputs[0],glass.node_tree.nodes['Material Output'].inputs['Surface'])
for label,x in [('Left',-.37),('Right',.21)]:
    c.fit_to_head(c.ring(label+' | big round glasses',(x,-.15,3.15),.24,.027,m['ink']))
    c.fit_to_head(c.ball(label+' | clear lens',(x,-.145,3.15),(.215,.012,.215),glass))
c.fit_to_head(c.line('Glasses | gentle bridge',[(-.13,-.15,3.16),(-.08,-.17,3.20),(-.03,-.15,3.16)],.021,m['ink']))
c.fit_to_head(c.line('Glasses | left temple',[(-.61,-.15,3.18),(-.65,-.02,3.18),(-.62,.12,3.16)],.019,m['ink']))
c.fit_to_head(c.line('Glasses | right temple',[(.45,-.15,3.18),(.52,-.02,3.18),(.49,.12,3.16)],.019,m['ink']))
c.rod('Magnifier | brass stem',(.71,-.17,1.49),(.845,-.17,1.95),.032,m['brass'])
c.rod('Magnifier | soft handle',(.695,-.17,1.44),(.765,-.17,1.68),.049,m['dark'])
c.ball('Right | gentle thumb',(.67,-.21,1.585),(.045,.04,.052),m['porcelain'])
c.ring('Magnifier | round rim',(.92,-.17,2.18),.245,.034,m['ink'])
c.ring('Magnifier | brass edge',(.92,-.207,2.18),.242,.011,m['brass'])
c.ball('Magnifier | clear lens',(.92,-.17,2.18),(.218,.015,.218),glass)
c.line('Magnifier | lens glint',[(.92+.19*math.cos(math.radians(a)),-.20,2.18+.19*math.sin(math.radians(a))) for a in [118,130,142,154]],.007,m['porcelain'])
c.finish_scene('investigator',args.output,resolution=args.size,render=not args.no_render)
