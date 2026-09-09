"""Refine the original Inertia rig and author a reversible lift plus suspended loop.

blender --background --threads 2 --python scripts/mascot/pose-pickup.py -- \
  --source source-assets/mascot/inertia-mascot-pickup.blend --output /tmp/inertia-pickup
"""
import argparse
import math
from pathlib import Path
import sys

import bpy
from mathutils import Euler, Matrix, Vector

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--preview-only', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
args.output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(args.source.resolve()))
bpy.context.preferences.filepaths.save_version = 0
rig = bpy.data.objects['Inertia • standing expression rig']
body = bpy.data.objects['Runner • continuous logo strokes']
scene = bpy.context.scene

# Keep the original mesh, shell materials and rest skeleton. Broaden the skin
# blends at elbows/knees and share the central hip weld across both legs. The
# original narrow blends pinched into rigid-looking lumps in a bent pose.
segments = {bone.name: (bone.head_local.copy(), bone.tail_local.copy())
            for bone in rig.data.bones
            if bone.name in ['spine', 'pelvis'] or 'arm.' in bone.name or 'leg.' in bone.name}
body.vertex_groups.clear()
groups = {name: body.vertex_groups.new(name=name) for name in segments}
world = body.matrix_world.copy()
for vertex in body.data.vertices:
    point = world @ vertex.co
    side = 'R' if point.x >= 0 else 'L'
    names = ['upper_arm.' + side, 'forearm.' + side, 'upper_leg.' + side,
             'lower_leg.' + side, 'pelvis', 'spine']
    if point.z < 1.77 and abs(point.x) < .25:
        names = [name for name in names if 'arm.' not in name]
    if .95 < point.z < 1.35 and abs(point.x) < .22:
        names += ['upper_leg.' + ('L' if side == 'R' else 'R')]
    distances = []
    for name in names:
        start, end = segments[name]
        axis = end - start
        along = max(0, min(1, (point - start).dot(axis) / axis.length_squared))
        distances.append(((point - start - axis * along).length, name))
    distances.sort()
    nearest = distances[:4]
    base = nearest[0][0]
    weights = [math.exp(-((distance - base) / .12) ** 2) for distance, _ in nearest]
    total = sum(weights)
    for (_, name), weight in zip(nearest, weights):
        groups[name].add([vertex.index], weight / total, 'REPLACE')
for modifier in list(body.modifiers):
    if modifier.name == 'Pickup joint relaxation':
        body.modifiers.remove(modifier)
relax = body.modifiers.new('Pickup joint relaxation', 'CORRECTIVE_SMOOTH')
relax.factor, relax.iterations, relax.smooth_type = .65, 12, 'LENGTH_WEIGHTED'


def reset():
    for bone in rig.pose.bones:
        bone.rotation_mode = 'QUATERNION'
        bone.rotation_quaternion = (1, 0, 0, 0)
        bone.location = (0, 0, 0)
        bone.scale = (1, 1, 1)
    for name in ['laptop', 'bubble', 'bulb']:
        rig.pose.bones[name].scale = (.0001,) * 3


def chain(upper_name, lower_name, target, pole):
    """Solve two original bones with a fixed bend plane; no elbow/knee flips."""
    upper, lower = rig.pose.bones[upper_name], rig.pose.bones[lower_name]
    bpy.context.view_layer.update()
    start = upper.head.copy()
    first, second = upper.bone.length, lower.bone.length
    direction = Vector(target) - start
    distance = max(abs(first - second) + .002, min(direction.length, first + second - .002))
    direction.normalize()
    bend = Vector(pole) - direction * Vector(pole).dot(direction)
    bend.normalize()
    along = (first * first - second * second + distance * distance) / (2 * distance)
    joint = start + direction * along + bend * math.sqrt(max(0, first * first - along * along))
    end = start + direction * distance
    for bone, origin, tip in [(upper, start, joint), (lower, joint, end)]:
        rest = bone.bone.matrix_local
        rotation = ((bone.bone.tail_local - bone.bone.head_local).normalized()
                    .rotation_difference((tip - origin).normalized()) @ rest.to_quaternion())
        bone.matrix = Matrix.LocRotScale(origin, rotation, Vector((1, 1, 1)))
        bpy.context.view_layer.update()


def suspended(phase):
    reset()
    wave, follow = math.sin(phase * math.tau), math.sin(phase * math.tau - .45) - math.sin(-.45)
    rig.pose.bones['root'].location = (.026 * wave, .16 + .01 * (1 - math.cos(phase * math.tau)), 0)
    rig.pose.bones['spine'].rotation_quaternion = Euler((-.025, .02, -.04 + .018 * wave)).to_quaternion()
    rig.pose.bones['head'].rotation_quaternion = Euler((.025, -.02, .065 - .018 * wave)).to_quaternion()
    for side, sign in [('L', -1), ('R', 1)]:
        chain('upper_arm.' + side, 'forearm.' + side,
              (sign * .73 + .015 * follow, -.06, 1.40 + sign * .012 * follow), (sign, 0, -.1))
        chain('upper_leg.' + side, 'lower_leg.' + side,
              (sign * (.33 if side == 'L' else .40) + .035 * follow,
               .17, (.37 if side == 'L' else .47) + sign * .012 * follow), (sign * .5, -1, 0))


def smooth(value):
    value = max(0, min(1, value))
    return value ** 3 * (value * (value * 6 - 15) + 10)


def keyframe(frame):
    for bone in rig.pose.bones:
        for channel in ['location', 'rotation_quaternion', 'scale']:
            bone.keyframe_insert(channel, frame=frame, group=bone.name)


scene.render.fps = 30
for name, length in [('Pickup', 60), ('PickupLift', 12)]:
    if name in bpy.data.actions:
        bpy.data.actions.remove(bpy.data.actions[name])
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    rig.animation_data.action = action
    for frame in range(length + 1):
        suspended(frame / length if name == 'Pickup' else 0)
        if name == 'PickupLift':
            # Head/body lead, arms follow, then feet leave the ground. The same
            # path can reverse at any frame on an early release, without a snap.
            time = frame / length
            for bone in rig.pose.bones:
                if bone.name in ['laptop', 'bubble', 'bulb']:
                    continue
                delay = .12 if 'arm.' in bone.name else .20 if 'leg.' in bone.name else 0
                amount = smooth((time - delay) / (1 - delay))
                bone.location *= amount
                bone.rotation_quaternion = Euler((0, 0, 0)).to_quaternion().slerp(bone.rotation_quaternion, amount)
        keyframe(frame)

# Soft broad studio lighting preserves the original porcelain/graphite identity.
# Use the original pixel capture camera for exact scale and registration with
# the four existing activity animations, rather than changing all their art.
camera = scene.camera
camera.data.type = 'PERSP'
camera.data.lens = 36 / (2 * math.tan(math.radians(32) / 2))
camera.data.sensor_width = 36
camera.location = (4.8, -8.2, 3.1)
camera.rotation_euler = (Vector((.22, 0, 2.13)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
for obj in scene.objects:
    if obj.name.startswith('STUDIO') and obj.type == 'MESH':
        obj.hide_render = True
scene.render.engine = 'CYCLES'
scene.cycles.samples = 48
scene.cycles.use_denoising = True
# Keep studio highlight detail in the editable model and inspection renders.
scene.view_settings.view_transform = 'AgX'
scene.view_settings.exposure = 0
scene.render.threads_mode, scene.render.threads = 'FIXED', 2
scene.render.resolution_x = scene.render.resolution_y = 384
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
rig.animation_data.action = bpy.data.actions['Pickup']
scene.frame_start, scene.frame_end = 0, 60
scene.frame_set(0)
bpy.ops.wm.save_as_mainfile(filepath=str(args.output / 'inertia-mascot-pickup.blend'))


def render(action, frame, path):
    rig.animation_data.action = bpy.data.actions[action]
    scene.frame_set(math.floor(frame), subframe=frame % 1)
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


if not args.preview_only:
    # Match the established display-referred sprite whites before quantization.
    # Filmic compression would map porcelain into the next gray palette entry.
    scene.view_settings.view_transform = 'Standard'
    for name, count, step in [('pickup', 48, 30 / 24), ('lift', 13, 1)]:
        directory = args.output / name
        directory.mkdir(exist_ok=True)
        for frame in range(count):
            render('Pickup' if name == 'pickup' else 'PickupLift', frame * step, directory / f'{frame:04}.png')

# Include ordinary states and four angles in the authoring inspection output.
scene.view_settings.view_transform = 'AgX'
preview = args.output / 'inspection'
preview.mkdir(exist_ok=True)
for action in ['Idle', 'Thinking', 'Working', 'Idea']:
    render(action, 45, preview / f'{action.lower()}.png')
camera.data.type, camera.data.ortho_scale = 'ORTHO', 4.25
scene.render.resolution_x = scene.render.resolution_y = 512
for name, position in [('front', (0, -10, 2.8)), ('three-quarter', (4.8, -8.2, 3.1)),
                       ('side', (10, 0, 2.8)), ('back', (0, 10, 2.8))]:
    camera.location = position
    camera.rotation_euler = (Vector((0, 0, 1.95)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    render('Pickup', 0, preview / f'{name}.png')
