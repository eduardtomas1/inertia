"""Shared cute, floating-cursor character geometry and studio for six agent marks."""
import math
from pathlib import Path
import bpy
import bmesh
from mathutils import Matrix, Vector

scene = None
character = None
MATS = {}
HEAD_SCALE = .70
HEAD_ANCHOR = Vector((0, 0, 1.952))


def initialize(role):
    global scene, character, MATS
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    character = bpy.data.collections.new(role.upper()+' | editable character')
    scene.collection.children.link(character)
    MATS = {
        'porcelain': material('Family | warm porcelain',(.92,.93,.90),.32),
        'ink': material('Family | ink',(.035,.045,.055),.36),
        'dark': material('Family | soft leather',(.085,.065,.050),.5),
        'brass': material('Family | satin brass',(.55,.36,.15),.32,.6),
        'shirt': material('Family | cream cotton',(.82,.78,.66),.74),
    }
    return MATS


def rounded_box(name, location, dimensions, mat, bevel=.04):
    bpy.ops.mesh.primitive_cube_add(size=1,location=location)
    obj=bpy.context.object
    obj.dimensions=dimensions
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    return finish(obj,name,mat,bevel)


def loft(name, rings, mat, sides=40):
    vertices=[]
    for z,width,depth in rings:
        for j in range(sides):
            a=2*math.pi*j/sides
            c,s=math.cos(a),math.sin(a)
            vertices.append((width*math.copysign(abs(c)**.8,c),
                depth*math.copysign(abs(s)**.8,s),z))
    faces=[tuple(range(sides-1,-1,-1))]
    for i in range(len(rings)-1):
        for j in range(sides):
            a,b=i*sides+j,i*sides+(j+1)%sides
            faces.append((a,b,b+sides,a+sides))
    faces.append(tuple((len(rings)-1)*sides+j for j in range(sides)))
    return surface(name,vertices,faces,mat,2)


def fit_to_head(obj):
    """Scale the logo and its accessories around the floating lower tip."""
    bpy.context.view_layer.update()
    obj.matrix_world = (Matrix.Translation(HEAD_ANCHOR)
        @ Matrix.Scale(HEAD_SCALE, 4)
        @ Matrix.Translation(-HEAD_ANCHOR) @ obj.matrix_world)
    return obj


def add_head():
    vertices=[(520,184),(706,307),(637,329),(686,402),(629,440),(580,364),(535,415)]
    outline=[((x-606)*.008,4.0-(z-184)*.008) for x,z in vertices]
    obj=prism('Cursor | floating exact-logo head',outline,0,.20,MATS['porcelain'],.04)
    obj.modifiers[0].segments=5
    obj['silhouette_source']='src/renderer/public/inertia-logo.svg'
    obj['floating_head']=True
    obj['relative_head_scale']=HEAD_SCALE
    return fit_to_head(obj)


def base_body(arms=None,strong=False,shoes=True):
    white=MATS['porcelain']
    width=1.12 if strong else 1.0
    body=loft('Stickman | rounded torso',[(.82,.14,.11),(.87,.23,.145),
        (.98,.25,.16),(1.16,.22,.15),(1.42,.27*width,.17),
        (1.62,.29*width,.175),(1.71,.23*width,.14),(1.75,.12,.10)],white)
    legs=[]
    for label,sign in [('Left',-1),('Right',1)]:
        legs.append(sweep(label+' | short rounded leg',[
            ((sign*.155,0,.98),.104,.102),((sign*.18,0,.84),.106,.102),
            ((sign*.20,-.01,.58),.096,.094),((sign*.20,0,.34),.083,.084),
            ((sign*.20,0,.16),.076,.078)],white))
        if shoes:
            rounded_box(label+' | little shoe',(sign*.20,-.075,.105),(.27,.37,.19),MATS['dark'],.075)
    poses=arms or {
        'Left':[(-.24,0,1.63),(-.37,0,1.48),(-.45,-.025,1.25),(-.46,-.07,1.08)],
        'Right':[(.24,0,1.63),(.37,0,1.48),(.45,-.025,1.25),(.46,-.07,1.08)]}
    arm_objects={}
    hands={}
    for label,points in poses.items():
        radius=.090 if strong else .075
        stations=[(xyz,radius*(1-.14*i/max(1,len(points)-1)),radius*(1-.14*i/max(1,len(points)-1)))
            for i,xyz in enumerate(points)]
        arm_objects[label]=sweep(label+' | soft stick arm',stations,white)
        hands[label]=tuple(points[-1])
        ball(label+' | little mitten',points[-1],(.088,.081,.101),white)
    return {'hands':hands,'body':body,'arms':arm_objects,'legs':legs}


def finish_scene(role, output, resolution=900, render=True):
    output=Path(output)
    output.mkdir(parents=True,exist_ok=True)
    floor_mat=material('Studio | warm paper',(.80,.78,.72),.9)
    bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,0))
    floor=bpy.context.object
    floor.name='Studio | floor'
    floor.data.materials.append(floor_mat)
    world=bpy.data.worlds.new('Family studio')
    world.use_nodes=True
    world.node_tree.nodes['Background'].inputs[0].default_value=(.78,.82,.88,1)
    world.node_tree.nodes['Background'].inputs[1].default_value=.5
    scene.world=world
    for name,loc,power,size,color in [
        ('Key',(-3,-4,6),420,4,(1,.94,.83)),
        ('Fill',(3,-3,3),220,3,(.83,.92,1)),
        ('Rim',(1,3,5),350,3,(1,.97,.90))]:
        data=bpy.data.lights.new('Studio | '+name,'AREA')
        data.energy,data.shape,data.size,data.color=power,'DISK',size,color
        obj=bpy.data.objects.new('Studio | '+name,data)
        scene.collection.objects.link(obj)
        obj.location=loc
        obj.rotation_euler=(Vector((0,0,1.8))-obj.location).to_track_quat('-Z','Y').to_euler()
    data=bpy.data.cameras.new('Family orthographic')
    camera=bpy.data.objects.new('Family camera',data)
    scene.collection.objects.link(camera)
    scene.camera=camera
    camera.location=(1.2,-12,4.15)
    camera.rotation_euler=(Vector((.12,0,1.72))-camera.location).to_track_quat('-Z','Y').to_euler()
    data.type,data.ortho_scale='ORTHO',4.10
    scene.render.engine='BLENDER_EEVEE'
    scene.render.threads_mode,scene.render.threads='FIXED',2
    scene.render.resolution_x=scene.render.resolution_y=resolution
    scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG'
    scene.render.image_settings.color_mode='RGBA'
    scene.view_settings.view_transform='AgX'
    scene.render.film_transparent=False
    scene.render.filepath=str(output/(role+'-preview.png'))
    scene['design_direction']='Cute compact stickman; floating cursor-logo head; no neck; relaxed standing role outfit.'
    bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=str((output/(role+'.blend')).resolve()))
    if render:
        bpy.ops.render.render(write_still=True)
        floor.hide_render=True
        scene.render.film_transparent=True
        scene.render.filepath=str(output/(role+'-transparent.png'))
        bpy.ops.render.render(write_still=True)

def material(name, color, roughness=.38, metallic=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metallic
    return mat

def finish(obj, name, mat, bevel=0, smooth=False):
    obj.name = name
    for collection in list(obj.users_collection):
        collection.objects.unlink(obj)
    character.objects.link(obj)
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new('Small rounded manufactured edge', 'BEVEL')
        mod.width, mod.segments = bevel, 3
        obj.modifiers.new('Weighted face normals', 'WEIGHTED_NORMAL')
    if smooth:
        for face in obj.data.polygons:
            face.use_smooth = True
    return obj

def ball(name, point, scale, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=20, location=point)
    obj = bpy.context.object
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, mat, smooth=True)

def rod(name, a, b, radius, mat, rounded=True):
    a, b = Vector(a), Vector(b)
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=radius, depth=(b-a).length, location=(a+b)/2)
    obj = bpy.context.object
    obj.rotation_euler = (b-a).to_track_quat('Z', 'Y').to_euler()
    finish(obj, name, mat, .015, True)
    if rounded:
        for label, point in [('start', a), ('end', b)]:
            ball(name + ' | ' + label, point, (radius,)*3, mat)
    return obj

def prism(name, outline, y, depth, mat, bevel=.025):
    n = len(outline)
    vertices = [(x, y+d, z) for d in [-depth/2, depth/2] for x, z in outline]
    faces = [tuple(range(n-1, -1, -1)), tuple(range(n, 2*n))]
    faces += [(i, (i+1) % n, (i+1) % n+n, i+n) for i in range(n)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    character.objects.link(obj)
    return finish(obj, name, mat, bevel)

def ring(name, center, radius, thickness, mat):
    bpy.ops.mesh.primitive_torus_add(major_segments=64, minor_segments=12,
        location=center, major_radius=radius, minor_radius=thickness,
        rotation=(math.pi/2, 0, 0))
    return finish(bpy.context.object, name, mat, smooth=True)

def line(name, points, radius, mat):
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '3D'
    curve.resolution_u = 20
    curve.bevel_depth = radius
    curve.bevel_resolution = 4
    spline = curve.splines.new('BEZIER')
    spline.bezier_points.add(len(points)-1)
    for point, xyz in zip(spline.bezier_points, points):
        point.co = xyz
        point.handle_left_type = point.handle_right_type = 'AUTO'
    obj = bpy.data.objects.new(name, curve)
    character.objects.link(obj)
    obj.data.materials.append(mat)
    return obj

def surface(name, vertices, faces, mat, subdivision=2):
    """Closed, consistently oriented quad surfaces instead of overlapping primitives."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    character.objects.link(obj)
    finish(obj, name, mat, smooth=True)
    if subdivision:
        mod = obj.modifiers.new('Continuous smooth surface', 'SUBSURF')
        mod.levels = mod.render_levels = subdivision
    return obj

def sweep(name, stations, mat, sides=24, subdivision=2):
    """A continuous tapered limb. Stations are (position, radius in-plane, depth)."""
    vertices = []
    axis = (Vector(stations[-1][0])-Vector(stations[0][0])).normalized()
    reference = Vector((0,0,1)) if abs(axis.y) > .9 else Vector((0,1,0))
    for i, (xyz, radius, depth) in enumerate(stations):
        prev = Vector(stations[max(0, i-1)][0])
        following = Vector(stations[min(len(stations)-1, i+1)][0])
        tangent = (following-prev).normalized()
        across = tangent.cross(reference).normalized()
        normal = across.cross(tangent).normalized()
        for j in range(sides):
            angle = 2*math.pi*j/sides
            point = Vector(xyz)+across*(radius*math.cos(angle))+normal*(depth*math.sin(angle))
            vertices.append(tuple(point))
    faces = [tuple(range(sides-1, -1, -1))]
    for i in range(len(stations)-1):
        for j in range(sides):
            a, b = i*sides+j, i*sides+(j+1)%sides
            faces.append((a,b,b+sides,a+sides))
    faces.append(tuple((len(stations)-1)*sides+j for j in range(sides)))
    return surface(name, vertices, faces, mat, subdivision)

def folded_panel(name, points, mat, thickness=.025):
    n = len(points)
    vertices = [(x,y+d,z) for d in [-thickness/2,thickness/2] for x,y,z in points]
    faces = [tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    obj = surface(name, vertices, faces, mat, subdivision=0)
    for face in obj.data.polygons:
        face.use_smooth = False
    mod = obj.modifiers.new('Soft folded cloth edge','BEVEL')
    mod.width, mod.segments = .012, 3
    obj.modifiers.new('Cloth panel normals','WEIGHTED_NORMAL')
    return obj
