"""Add Pickup to Inertia's existing study-06 rig; never rebuild its geometry.

blender --background --python scripts/mascot/pose-pickup.py -- \
  --source source-assets/mascot/inertia-mascot-pickup.blend --output /tmp/inertia-pickup
"""
import argparse
import math
from pathlib import Path
import sys

import bpy
from mathutils import Euler, Vector

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
args.output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(args.source.resolve()))
bpy.context.preferences.filepaths.save_version = 0
rig = bpy.data.objects['Inertia • standing expression rig']
scene = bpy.context.scene
if 'Pickup' in bpy.data.actions:
    bpy.data.actions.remove(bpy.data.actions['Pickup'])
action = bpy.data.actions.new('Pickup')
action.use_fake_user = True
rig.animation_data.action = action
scene.render.fps = 30
scene.frame_start, scene.frame_end = 0, 60

# The cursor is the pickup point. Lift the body off the ground, curl its knees,
# and let its arms and feet trail with a small suspended pendulum motion.
# Pose the original 18 bones; mesh, weights, cursor shells and materials stay intact.
for frame in range(0, 61, 3):
    wave = math.sin(frame / 60 * math.tau)
    for bone in rig.pose.bones:
        bone.rotation_mode = 'QUATERNION'
        bone.rotation_quaternion = (1, 0, 0, 0)
        bone.location = (0, 0, 0)
        bone.scale = (1, 1, 1)
    for name in ['laptop', 'bubble', 'bulb']:
        rig.pose.bones[name].scale = (.0001,) * 3
    rig.pose.bones['root'].location.y = .22
    rig.pose.bones['spine'].rotation_quaternion = Euler((.04, .035 * wave, -.08)).to_quaternion()
    rig.pose.bones['head'].rotation_quaternion = Euler((-.05, -.035 * wave, .14)).to_quaternion()
    for side, sign in [('L', -1), ('R', 1)]:
        rig.pose.bones['upper_arm.' + side].rotation_quaternion = Euler((-.10, 0, -sign * (.55 + .035 * wave))).to_quaternion()
        rig.pose.bones['forearm.' + side].rotation_quaternion = Euler((-.22, 0, sign * .32)).to_quaternion()
        rig.pose.bones['upper_leg.' + side].rotation_quaternion = Euler((-.45 + sign * .04 * wave, 0, -sign * .10)).to_quaternion()
        rig.pose.bones['lower_leg.' + side].rotation_quaternion = Euler((1.05 + sign * .08 * wave, 0, sign * .08)).to_quaternion()
    for bone in rig.pose.bones:
        for channel in ['location', 'rotation_quaternion', 'scale']:
            bone.keyframe_insert(channel, frame=frame, group=bone.name)
scene.frame_set(0)
bpy.ops.wm.save_as_mainfile(filepath=str(args.output / 'inertia-mascot-pickup.blend'))

root = bpy.data.objects['INERTIA • study 06']
bpy.ops.object.select_all(action='DESELECT')
for obj in [root, *root.children_recursive]:
    obj.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(
    filepath=str(args.output / 'inertia-mascot-pickup.glb'), export_format='GLB',
    use_selection=True, export_apply=True, export_animations=True,
    export_animation_mode='ACTIONS', export_anim_single_armature=True,
    export_frame_range=False, export_force_sampling=True,
    export_cameras=False, export_lights=False,
)

# Match the original sprite capture's 32-degree camera and transparent framing.
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
scene.cycles.samples = 16
scene.cycles.use_denoising = True
scene.render.resolution_x = scene.render.resolution_y = 384
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
rig.animation_data.action = action
for frame in range(24):
    # 30fps rig sampled at exactly 12fps, including fractional frames.
    sample = frame * 30 / 12
    scene.frame_set(math.floor(sample), subframe=sample % 1)
    scene.render.filepath = str(args.output / f'{frame:04}.png')
    bpy.ops.render.render(write_still=True)
