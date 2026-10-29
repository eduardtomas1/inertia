"""Build the relaxed Inertia creative with apron, sketchbook and pencil.

blender-run --threads 2 scripts/custom-agent-marks/build-creative.py --output DIR
"""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import themed_common as c


def apron_panel(name, rows, mat, thickness=.022):
    """Tailor the apron to the round body with a shallow curved front."""
    vertices = [(x*width, y-.023*(1-x*x), z)
                for z, width, y in rows for x in [-1, -.5, 0, .5, 1]]
    faces = [(i*5+j, i*5+j+1, (i+1)*5+j+1, (i+1)*5+j)
             for i in range(len(rows)-1) for j in range(4)]
    obj = c.surface(name, vertices, faces, mat, subdivision=1)
    obj.modifiers.new('Apron cloth thickness', 'SOLIDIFY').thickness = thickness
    return obj


def build():
    mats = c.initialize('creative')
    c.add_head()
    c.base_body(arms={
        'Left': [(-.25, 0, 1.63), (-.355, -.01, 1.47),
                 (-.44, -.07, 1.22), (-.40, -.24, 1.105)],
        'Right': [(.25, 0, 1.63), (.35, -.008, 1.47),
                  (.42, -.075, 1.29), (.50, -.225, 1.285)],
    })
    cotton = c.material('Shirt | warm oatmeal cotton', (.75, .72, .61), .84)
    cuff = c.material('Shirt | folded warm cream sleeves', (.86, .83, .72), .81)
    clay = c.material('Apron | muted clay canvas', (.50, .205, .125), .84)
    clay_edge = c.material('Apron | soft terracotta trim', (.66, .32, .20), .82)
    stitch = c.material('Apron | warm stitching', (.77, .48, .29), .85)
    book = c.material('Sketchbook | soft sage cover', (.23, .40, .35), .75)
    book_spine = c.material('Sketchbook | dark linen spine', (.09, .20, .17), .82)
    paper = c.material('Sketchbook | ivory paper', (.87, .84, .71), .88)
    pencil = c.material('Pencil | mustard lacquer', (.90, .53, .115), .46)
    wood = c.material('Pencil | exposed cedar', (.68, .43, .23), .75)
    graphite = c.material('Pencil | graphite', (.065, .069, .061), .48)
    eraser = c.material('Pencil | muted rose eraser', (.70, .35, .29), .82)
    bristles = c.material('Pocket brush | warm bristles', (.20, .115, .065), .82)
    ochre_paint = c.material('Apron paint | restrained ochre', (.76, .47, .15), .69)

    c.loft('Shirt | softly fitted rounded torso', [
        (.83, .220, .152), (.86, .255, .176), (1.00, .264, .188),
        (1.22, .275, .190), (1.42, .298, .192),
        (1.59, .316, .197), (1.68, .267, .178),
        (1.735, .180, .135), (1.748, .110, .108),
    ], cotton)
    for label, sign in [('Left', -1), ('Right', 1)]:
        c.sweep('Shirt | '+label.lower()+' short sleeve', [
            ((sign*.245, 0, 1.64), .113, .125),
            ((sign*.300, 0, 1.60), .124, .128),
            ((sign*.350, -.010, 1.49), .112, .116),
            ((sign*.374, -.025, 1.415), .105, .108),
            ((sign*.380, -.030, 1.395), .105, .108),
        ], cotton)
        c.sweep('Shirt | '+label.lower()+' folded cuff', [
            ((sign*.370, -.022, 1.43), .112, .116),
            ((sign*.382, -.032, 1.39), .113, .117),
            ((sign*.387, -.037, 1.375), .108, .112),
        ], cuff)

    # The bib and skirt share a continuous canvas surface, fitted over the shirt.
    apron_panel('Apron | continuous short bib and skirt', [
        (1.700, .148, -.168), (1.680, .163, -.183),
        (1.590, .164, -.204), (1.435, .177, -.216),
        (1.335, .245, -.202), (1.285, .278, -.193),
        (1.100, .282, -.190), (.870, .278, -.180),
        (.845, .258, -.170),
    ], clay)
    # Canvas straps sit over the shoulders and disappear into the back waistband.
    for sign, label in [(-1, 'left'), (1, 'right')]:
        c.line('Apron | '+label+' shoulder strap', [
            (sign*.135, -.192, 1.66), (sign*.156, -.146, 1.730),
            (sign*.174, -.035, 1.760), (sign*.185, .105, 1.699),
            (sign*.195, .166, 1.44), (sign*.230, .174, 1.32),
        ], .027, clay_edge)
        c.ball('Apron | '+label+' small strap rivet', (sign*.137, -.213, 1.655), (.019, .009, .019), mats['brass'])
    c.loft('Apron | fitted waist tie', [
        (1.276, .253, .199), (1.286, .267, .208),
        (1.336, .265, .209), (1.344, .251, .200),
    ], clay_edge)
    apron_panel('Apron | rounded front pocket', [
        (1.254, .145, -.236), (1.240, .153, -.241),
        (1.105, .151, -.240), (1.075, .125, -.234),
        (1.063, .085, -.226),
    ], clay_edge, .017)
    c.line('Apron | pocket top stitching', [(-.135, -.260, 1.232), (0, -.274, 1.225), (.135, -.260, 1.232)], .0055, stitch)
    c.line('Apron | pocket center stitching', [(0, -.272, 1.215), (0, -.271, 1.145), (0, -.256, 1.088)], .004, stitch)

    # One slender brush is tucked behind the pocket, leaving both hands unchanged.
    c.rod('Pocket brush | sage wooden handle', (.064, -.235, 1.145), (.083, -.261, 1.360), .014, book_spine)
    c.rod('Pocket brush | small satin ferrule', (.083, -.261, 1.351), (.088, -.262, 1.400), .021, mats['brass'], rounded=False)
    c.sweep('Pocket brush | tapered bristle tuft', [
        ((.087, -.262, 1.391), .019, .014),
        ((.090, -.263, 1.412), .024, .017),
        ((.093, -.264, 1.444), .020, .014),
        ((.096, -.265, 1.468), .003, .003),
    ], bristles, sides=16, subdivision=1)
    c.prism('Apron | small ochre paint dab', [
        (-.170, .995), (-.144, 1.008), (-.100, 1.000),
        (-.106, .983), (-.147, .975), (-.171, .982),
    ], -.218, .003, ochre_paint, .002)
    c.prism('Apron | small sage paint dab', [
        (.149, 1.037), (.177, 1.045), (.201, 1.033),
        (.190, 1.017), (.159, 1.018),
    ], -.211, .003, book, .002)

    # A compact closed sketchbook, resting against the left palm and lower arm.
    c.rounded_box('Sketchbook | back cover', (-.535, -.270, 1.205), (.418, .043, .555), book, .027)
    c.rounded_box('Sketchbook | cream page block', (-.526, -.307, 1.205), (.388, .053, .520), paper, .018)
    c.rounded_box('Sketchbook | front cover', (-.535, -.350, 1.205), (.428, .033, .565), book, .023)
    c.rounded_box('Sketchbook | rounded linen spine', (-.732, -.309, 1.205), (.056, .104, .560), book_spine, .017)
    c.rounded_box('Sketchbook | subtle cover label', (-.527, -.372, 1.330), (.183, .009, .104), paper, .011)
    c.line('Sketchbook | simple pencil stroke on label', [(-.585, -.381, 1.309), (-.55, -.381, 1.351), (-.510, -.381, 1.317), (-.478, -.381, 1.346)], .006, book_spine)
    c.ball('Left hand | fingers supporting sketchbook', (-.410, -.330, .985), (.075, .063, .075), mats['porcelain'])
    c.ball('Left hand | thumb around sketchbook', (-.337, -.367, 1.155), (.048, .051, .076), mats['porcelain'])

    # The pencil is planted in the right mitten, with a clear pointed graphite end.
    p0 = (.480, -.270, 1.130)
    p1 = (.665, -.270, 1.708)
    c.rod('Pencil | mustard barrel', p0, p1, .032, pencil, rounded=False)
    c.rod('Pencil | short metal ferrule', (.475, -.270, 1.115), (.498, -.270, 1.187), .035, mats['brass'], rounded=False)
    c.rod('Pencil | rose eraser', (.459, -.270, 1.064), (.478, -.270, 1.124), .034, eraser)
    c.sweep('Pencil | sharpened cedar tip', [
        ((.662, -.270, 1.699), .032, .032),
        ((.672, -.270, 1.731), .027, .027),
        ((.687, -.270, 1.778), .012, .012),
        ((.693, -.270, 1.796), .007, .007),
    ], wood, sides=12, subdivision=0)
    c.sweep('Pencil | graphite point', [
        ((.688, -.270, 1.780), .012, .012),
        ((.697, -.270, 1.808), .001, .001),
    ], graphite, sides=12, subdivision=0)
    c.ball('Right hand | thumb around pencil', (.517, -.318, 1.289), (.055, .045, .063), mats['porcelain'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--size', type=int, default=900)
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    build()
    c.finish_scene('creative', args.output, resolution=args.size)
