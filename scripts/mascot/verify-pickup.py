"""Check original identity, skin normalization and rig motion continuity.

Run inside Blender with --python-exit-code 1; see source-assets/mascot/README.md.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys

import bpy

RIG = 'Inertia • standing expression rig'
BODY = 'Runner • continuous logo strokes'
ACTIVITIES = ['Idle', 'Thinking', 'Working', 'Idea']


def pose(action, frame):
    rig = bpy.data.objects[RIG]
    rig.animation_data.action = bpy.data.actions[action]
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    return {bone.name: bone.matrix.copy() for bone in rig.pose.bones}


def pose_error(first, second):
    return max(abs(first[name][row][column] - second[name][row][column])
               for name in first for row in range(4) for column in range(4))


def fingerprint(path):
    bpy.ops.wm.open_mainfile(filepath=str(path.resolve()))
    meshes, materials = {}, {}
    for obj in bpy.data.objects:
        if obj.type != 'MESH' or obj.name.startswith('STUDIO'):
            continue
        digest = hashlib.sha256()
        for vertex in obj.data.vertices:
            digest.update(struct.pack('<3f', *vertex.co))
        for polygon in obj.data.polygons:
            for index in polygon.vertices:
                digest.update(struct.pack('<I', index))
        meshes[obj.name] = digest.hexdigest()
        for material in obj.data.materials:
            shader = next(node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
            materials[material.name] = (
                tuple(material.diffuse_color), tuple(shader.inputs['Base Color'].default_value),
                shader.inputs['Metallic'].default_value, shader.inputs['Roughness'].default_value,
                shader.inputs['Coat Weight'].default_value,
            )
    bones = {bone.name: tuple(tuple(row) for row in bone.matrix_local)
             for bone in bpy.data.objects[RIG].data.bones}
    activities = {(name, frame): pose(name, frame) for name in ACTIVITIES
                  for frame in [0, 15, 30, 45, 60, 90, 120]}
    return meshes, bones, materials, activities, {action.name for action in bpy.data.actions}


parser = argparse.ArgumentParser()
parser.add_argument('--original', type=Path, required=True)
parser.add_argument('--candidate', type=Path, required=True)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
original = fingerprint(args.original)
candidate = fingerprint(args.candidate)
assert original[0] == candidate[0], 'Original mesh geometry changed'
assert original[1] == candidate[1], 'Original rest skeleton changed'
assert original[2] == candidate[2], 'Original material parameters changed'
assert candidate[4] == original[4] | {'Pickup', 'PickupLift'}, 'Unexpected action changes'
activity_error = max(pose_error(original[3][key], candidate[3][key]) for key in original[3])
assert activity_error < 1e-5, 'An original activity action changed'

body = bpy.data.objects[BODY]
weight_error = max(abs(sum(group.weight for group in vertex.groups) - 1)
                   for vertex in body.data.vertices)
assert weight_error < 1e-5, 'Skin weights are not normalized'
start = pose('Pickup', 0)
loop_error = pose_error(start, pose('Pickup', 60))
lift_error = pose_error(start, pose('PickupLift', 12))
assert loop_error < 1e-5, 'Suspended loop does not close'
assert lift_error < 1e-5, 'Lift endpoint does not match suspended pose'
print('MODEL_VERIFIED', json.dumps({
    'originalMeshes': len(candidate[0]), 'originalBones': len(candidate[1]),
    'normalizedSkinVertices': len(body.data.vertices), 'maximumWeightError': weight_error,
    'originalActivityPoseError': activity_error,
    'loopSeamError': loop_error, 'liftToLoopError': lift_error,
    'newActions': sorted(candidate[4] - original[4]),
}))
