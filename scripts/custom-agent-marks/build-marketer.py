"""Build the relaxed Inertia marketer with the shared floating cursor head.

blender-run --threads 2 scripts/custom-agent-marks/build-marketer.py --output DIR
"""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import themed_common as c


def fitted_front(name, rows, mat, thickness=.014):
    """Small cloth insert that follows the rounded chest instead of floating."""
    vertices = [(x * width, y - .012 * (1 - x*x), z)
                for z, width, y in rows for x in [-1, 0, 1]]
    faces = [(i*3+j, i*3+j+1, (i+1)*3+j+1, (i+1)*3+j)
             for i in range(len(rows)-1) for j in range(2)]
    obj = c.surface(name, vertices, faces, mat, subdivision=1)
    obj.modifiers.new('Fitted cloth thickness', 'SOLIDIFY').thickness = thickness
    return obj


def build():
    mats = c.initialize('marketer')
    c.add_head()
    c.base_body(arms={
        'Left': [(-.25, 0, 1.63), (-.35, -.005, 1.51),
                 (-.405, -.035, 1.28), (-.425, -.075, 1.04)],
        'Right': [(.25, 0, 1.63), (.36, -.005, 1.50),
                  (.45, -.055, 1.29), (.52, -.19, 1.24), (.555, -.285, 1.275)],
    })
    sage = c.material('Cardigan | soft seafoam knit', (.205, .385, .335), .79)
    sage_edge = c.material('Cardigan | ribbed edging', (.285, .480, .405), .83)
    cream = c.material('T-shirt | warm oat cotton', (.81, .79, .68), .78)
    thread = c.material('Cardigan | quiet seam', (.16, .30, .25), .85)
    phone_edge = c.material('Phone | midnight anodized frame', (.035, .075, .082), .25, .48)
    phone_glass = c.material('Phone | dark glass', (.012, .030, .038), .18, .08)
    phone_screen = c.material('Phone | muted teal screen', (.105, .255, .29), .3)
    screen_light = c.material('Phone | warm display elements', (.78, .80, .67), .4)
    screen_accent = c.material('Phone | amber chart accent', (.92, .47, .14), .4)

    c.loft('Cardigan | softly fitted torso', [
        (.83, .235, .160), (.845, .265, .180), (.89, .275, .190),
        (1.09, .272, .195), (1.25, .278, .190), (1.43, .299, .192),
        (1.59, .315, .200), (1.68, .277, .180), (1.73, .195, .145),
        (1.745, .110, .112),
    ], sage)
    fitted_front('T-shirt | inset under open cardigan', [
        (1.736, .115, -.137), (1.68, .133, -.187),
        (1.54, .112, -.207), (1.40, .085, -.208),
        (1.19, .079, -.210), (.885, .079, -.209),
    ], cream)

    # Soft cardigan bands frame the cream T-shirt; no stiff suit lapels.
    for sign, label in [(-1, 'left'), (1, 'right')]:
        c.line('Cardigan | '+label+' front rib', [
            (sign*.143, -.150, 1.72), (sign*.150, -.196, 1.64),
            (sign*.120, -.214, 1.52), (sign*.090, -.218, 1.39),
            (sign*.087, -.220, 1.17), (sign*.087, -.217, .885),
        ], .022, sage_edge)
    c.loft('Cardigan | soft ribbed hem', [
        (.835, .240, .166), (.845, .270, .189),
        (.900, .280, .199), (.915, .274, .195),
    ], sage_edge)

    sleeves = [
        ('Left', [((-.245, 0, 1.64), .115, .128),
                  ((-.30, 0, 1.62), .125, .133),
                  ((-.36, -.010, 1.49), .118, .119),
                  ((-.398, -.033, 1.30), .101, .105),
                  ((-.418, -.061, 1.14), .094, .095),
                  ((-.421, -.066, 1.115), .092, .094)]),
        ('Right', [((.245, 0, 1.64), .115, .128),
                   ((.30, 0, 1.62), .125, .133),
                   ((.36, -.007, 1.50), .117, .119),
                   ((.425, -.041, 1.34), .107, .109),
                   ((.465, -.082, 1.275), .100, .103),
                   ((.500, -.155, 1.253), .096, .098),
                   ((.512, -.180, 1.258), .094, .096)]),
    ]
    for label, stations in sleeves:
        c.sweep('Cardigan | '+label.lower()+' rounded sleeve', stations, sage)
    c.sweep('Cardigan | left ribbed cuff', [
        ((-.418, -.060, 1.155), .097, .099),
        ((-.421, -.066, 1.115), .098, .099),
        ((-.423, -.070, 1.095), .094, .096),
    ], sage_edge)
    c.sweep('Cardigan | right ribbed cuff', [
        ((.495, -.144, 1.253), .100, .103),
        ((.516, -.188, 1.261), .100, .103),
        ((.523, -.205, 1.266), .096, .099),
    ], sage_edge)
    for z in [1.39, 1.22, 1.05]:
        c.ball('Cardigan | small warm button', (.088, -.244, z), (.018, .009, .018), mats['brass'])
    c.line('Cardigan | left pocket welt', [(-.235, -.136, 1.165), (-.196, -.169, 1.152), (-.142, -.196, 1.153)], .008, thread)

    # A small enamel megaphone follows the chest surface, like a real lapel pin.
    def pin_panel(name, outline, mat, front=0):
        return c.folded_panel(name, [(x, -.175-.52*(x+.215)+front, z)
                                    for x, z in outline], mat, .009)

    pin_panel('Megaphone pin | small handle', [
        (-.202, 1.485), (-.178, 1.485), (-.185, 1.433), (-.208, 1.433),
    ], mats['brass'])
    pin_panel('Megaphone pin | satin brass outline', [
        (-.275, 1.535), (-.190, 1.508), (-.160, 1.508),
        (-.160, 1.478), (-.190, 1.478), (-.275, 1.451),
    ], mats['brass'], -.004)
    pin_panel('Megaphone pin | warm cream enamel', [
        (-.265, 1.523), (-.193, 1.500), (-.169, 1.500),
        (-.169, 1.486), (-.193, 1.486), (-.265, 1.463),
    ], cream, -.011)

    # The phone rests inside the right mitten; the thumb curls around its edge.
    c.rounded_box('Phone | rounded case', (.555, -.323, 1.485), (.286, .065, .555), phone_edge, .037)
    c.rounded_box('Phone | glass front', (.555, -.361, 1.491), (.251, .016, .507), phone_glass, .027)
    c.rounded_box('Phone | visible screen', (.555, -.372, 1.491), (.221, .009, .439), phone_screen, .017)
    c.rounded_box('Phone | speaker', (.555, -.381, 1.725), (.063, .009, .009), phone_glass, .004)
    c.rounded_box('Phone | speech bubble notification', (.555, -.379, 1.587), (.167, .008, .074), screen_light, .012)
    c.prism('Phone | speech bubble tail', [(.500, 1.559), (.495, 1.529), (.530, 1.554)], -.379, .008, screen_light, .003)
    for x, height, color in [(.50, .060, screen_light), (.55, .104, screen_light), (.60, .145, screen_accent)]:
        c.rounded_box('Phone | campaign chart bar', (x, -.379, 1.365+height/2), (.028, .008, height), color, .006)
    c.ball('Right hand | thumb holding phone edge', (.443, -.367, 1.315), (.052, .049, .070), mats['porcelain'])
    c.ball('Right hand | curled fingers under phone', (.555, -.351, 1.235), (.091, .063, .052), mats['porcelain'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--size', type=int, default=900)
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    build()
    c.finish_scene('marketer', args.output, resolution=args.size)
