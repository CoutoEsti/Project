# Turns Ko's "1992 Honda Civic SiR II EG" (.blend, Blender 2.79, Cycles) into
# mtl/models/civic.glb, the file game/gltf-car.js loads as the player's car.
#
# The .blend and its textures are not in the repository (sent in the project
# chat). Put them in one folder and run, with Blender 4.2+ or the `bpy` wheel:
#
#   blender -b -P mtl/tools/civic-glb.py -- <dossier>/1992_Honda_Civic_SiR_II_EG.blend mtl/models/civic.glb
#   python3 mtl/tools/civic-glb.py <...>.blend mtl/models/civic.glb      (pip install bpy)
#
# What it fixes, because the glTF exporter only understands a Principled BSDF:
#   - every Cycles 2.79 shader (Diffuse, Glossy, Glass, Transparent mixes) is
#     rebuilt as a Principled BSDF that looks the same in three.js;
#   - the paint-coloured parts get a name with "Paint", so the game repaints
#     them to the colour of the car chosen in the garage;
#   - the four wheels, authored as left+right pairs in one object, are split
#     into wheel_front_left ... wheel_rear_right, each with its origin on its
#     own axle, so the game can steer and spin them;
#   - lamps and windows get names the loader recognises (headlight, taillight,
#     window), and the lamp lenses an emissive colour for night driving;
#   - transforms are applied: three.js measures a rotated mesh by its rotated
#     bounding box, which lifted the car off the road by a metre.

import os
import sys
import bpy
import bmesh
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
SRC, OUT = argv[0], argv[1]
TEX_DIR = SRC.rsplit('/', 1)[0] if '/' in SRC else '.'

bpy.ops.wm.open_mainfile(filepath=SRC)
scene = bpy.context.scene

# --- textures ----------------------------------------------------------------
# Paths are relative to the .blend; one points at the author's own disk.
MISSING = {'Test normals ind-3.png': 'F-IND-N.png'}
for im in bpy.data.images:
    name = MISSING.get(im.name, im.name)
    if im.source == 'FILE':
        path = f'{TEX_DIR}/{name}'
        if not os.path.isfile(path):
            sys.exit(f'texture introuvable : {name}')
        im.filepath = path
        im.reload()
        if im.name in MISSING:
            im.name = name

# --- objects -----------------------------------------------------------------
meshes = [o for o in scene.objects if o.type == 'MESH']
for o in list(meshes):
    if len(o.data.polygons) == 0:
        bpy.data.objects.remove(o)
        meshes.remove(o)

bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.make_single_user(object=True, obdata=True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# --- materials -----------------------------------------------------------------


def shader_of(mat):
    """The node feeding the output, and every BSDF in the tree by type."""
    nodes = mat.node_tree.nodes
    kinds = {}
    for n in nodes:
        kinds.setdefault(n.bl_idname, n)
    return kinds


def linked_image(node, socket):
    """Image texture plugged (directly or through a Normal Map) into `socket`."""
    s = node.inputs.get(socket)
    if not s or not s.is_linked:
        return None
    src = s.links[0].from_node
    if src.bl_idname == 'ShaderNodeNormalMap':
        src = src.inputs['Color'].links[0].from_node if src.inputs['Color'].is_linked else None
    return src.image if src is not None and src.bl_idname == 'ShaderNodeTexImage' else None


# Values read off a node die with it: callers pass plain tuples and floats,
# since this clears the tree first.
def rebuild(mat, base, metallic=0.0, roughness=0.5, alpha=1.0, color_img=None,
            alpha_from_img=False, normal_img=None, emission=None, coat=0.0):
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    p = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(p.outputs['BSDF'], out.inputs['Surface'])
    p.inputs['Base Color'].default_value = (*base[:3], 1)
    p.inputs['Metallic'].default_value = metallic
    p.inputs['Roughness'].default_value = roughness
    p.inputs['Alpha'].default_value = alpha
    p.inputs['Coat Weight'].default_value = coat
    if color_img is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = color_img
        nt.links.new(t.outputs['Color'], p.inputs['Base Color'])
        if alpha_from_img:
            nt.links.new(t.outputs['Alpha'], p.inputs['Alpha'])
    if normal_img is not None:
        normal_img.colorspace_settings.name = 'Non-Color'
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = normal_img
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], p.inputs['Normal'])
    if emission is not None:
        p.inputs['Emission Color'].default_value = (*emission, 1)
        p.inputs['Emission Strength'].default_value = 1.0


# Lamp lenses that light up: name -> emissive colour. The rest of the glass
# (reverse, indicators) stays dark, so braking does not light them too.
EMIT = {
    'HDL': (1.0, 0.95, 0.85), 'HDL.001': (1.0, 0.95, 0.85), 'Material.006': (1.0, 0.95, 0.85),
    'BR-LG': (0.7, 0.03, 0.02), 'SP-LG': (0.7, 0.03, 0.02),
}

for mat in bpy.data.materials:
    if not mat.node_tree:
        continue
    k = shader_of(mat)
    princ = k.get('ShaderNodeBsdfPrincipled')
    diff = k.get('ShaderNodeBsdfDiffuse')
    glossy = k.get('ShaderNodeBsdfAnisotropic') or k.get('ShaderNodeBsdfGlossy')
    glass = k.get('ShaderNodeBsdfGlass')
    transp = k.get('ShaderNodeBsdfTransparent')
    emit = EMIT.get(mat.name)

    if princ is not None:
        base = tuple(princ.inputs['Base Color'].default_value)
        metal = princ.inputs['Metallic'].default_value
        normal = linked_image(princ, 'Normal')
        coat = princ.inputs['Coat Weight'].default_value
        rebuild(mat, base, metal, max(0.08, princ.inputs['Roughness'].default_value),
                normal_img=normal, coat=coat)
        # The car's paint: the dark metallic clear-coated finish, wherever it
        # is (body, doors, fuel flap, mirrors, handles, hatch lock).
        if metal > 0.9 and coat > 0 and max(base[:3]) < 0.1 and not mat.name.startswith('Paint'):
            mat.name = 'Paint ' + mat.name.replace('Body Paint ', '')
    elif diff is not None and transp is not None:
        # Decals: the image's alpha cuts them out.
        rebuild(mat, (1, 1, 1), 0.0, 0.6, color_img=linked_image(diff, 'Color'), alpha_from_img=True)
    elif diff is not None:
        img = linked_image(diff, 'Color')
        rebuild(mat, tuple(diff.inputs['Color'].default_value), 0.0, 0.8, color_img=img)
    elif glass is not None:
        # Lamp lenses and clear covers: tinted, see-through, glossy.
        c = tuple(glass.inputs['Color'].default_value)
        tinted = min(c[:3]) < 0.5
        rebuild(mat, c, 0.0, 0.05, alpha=0.75 if tinted else 0.35,
                normal_img=linked_image(glass, 'Normal'), emission=emit)
    elif glossy is not None and transp is not None and linked_image(glossy, 'Normal') is None:
        # Windows.
        rebuild(mat, (0.03, 0.035, 0.04), 0.0, 0.05, alpha=0.4)
    elif glossy is not None and transp is not None:
        # Front indicator: amber, see-through, with its moulded pattern.
        c = tuple(transp.inputs['Color'].default_value)
        rebuild(mat, c, 0.0, 0.05, alpha=0.7, normal_img=linked_image(glossy, 'Normal'))
    elif glossy is not None:
        # Chrome: badges, mirrors, lamp reflectors, exhaust tip, wheel nuts.
        rebuild(mat, (0.85, 0.85, 0.85), 1.0, max(0.12, glossy.inputs['Roughness'].default_value),
                normal_img=linked_image(glossy, 'Normal'), emission=emit)
    elif transp is not None:
        rebuild(mat, (0.03, 0.035, 0.04), 0.0, 0.05, alpha=0.4)
    else:
        print('matériau non converti :', mat.name)

# --- names the loader recognises ------------------------------------------------
RENAME = {
    'Plane.009': 'headlight_lens_inner', 'Plane.115': 'headlight_lens', 'Plane.028': 'headlight_reflector',
    'Plane.000': 'taillight_brake', 'Plane.120': 'taillight_centre', 'Plane.121': 'taillight',
    'Plane.050': 'taillight_third',
    'Plane.003': 'window_rear_side', 'Plane.004': 'window_front_side',
    'Plane.005': 'windshield', 'Plane.006': 'window_hatch',
    'Plane.018': 'body', 'Plane.012': 'interior',
}
for old, new in RENAME.items():
    if old in bpy.data.objects:
        bpy.data.objects[old].name = new

# --- wheels -------------------------------------------------------------------
# Each of these holds parts of two or four wheels: split them into loose parts
# and give each part to the wheel whose axle it sits on.
WHEEL_PARTS = ['Plane.036', 'Plane.037', 'Plane.131', 'Plane.008', 'Plane.038',
               'Honda_Rim_Logo', 'Honda_Rim_Logo.001', 'Plane.039']

tyres = [bpy.data.objects[n] for n in ('Plane.037', 'Plane.131', 'Plane.038')]
pts = [v.co for o in tyres for v in o.data.vertices]
mid_x = 0.5 * (min(p.x for p in pts) + max(p.x for p in pts))
front_y = [v.co.y for v in bpy.data.objects['Plane.037'].data.vertices]
rear_y = [v.co.y for v in bpy.data.objects['Plane.038'].data.vertices]
axle_front = 0.5 * (min(front_y) + max(front_y))
axle_rear = 0.5 * (min(rear_y) + max(rear_y))
axle_z = 0.5 * (min(p.z for p in pts) + max(p.z for p in pts))


def wheel_of(centre):
    # The model's nose is at -Y, so its right side is -X.
    end = 'front' if abs(centre.y - axle_front) < abs(centre.y - axle_rear) else 'rear'
    side = 'right' if centre.x < mid_x else 'left'
    return f'wheel_{end}_{side}'


groups = {}
for name in WHEEL_PARTS:
    o = bpy.data.objects[name]
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.mesh.separate(type='LOOSE')
    for part in bpy.context.selected_objects:
        vs = part.data.vertices
        c = sum((v.co for v in vs), Vector()) / len(vs)
        groups.setdefault(wheel_of(c), []).append(part)

for wname, parts in groups.items():
    bpy.ops.object.select_all(action='DESELECT')
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    w = bpy.context.view_layer.objects.active
    w.name = wname
    w.data.name = wname
    xs = [v.co.x for v in w.data.vertices]
    pivot = Vector((0.5 * (min(xs) + max(xs)),
                    axle_front if 'front' in wname else axle_rear, axle_z))
    scene.cursor.location = pivot
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')

if sorted(groups) != ['wheel_front_left', 'wheel_front_right', 'wheel_rear_left', 'wheel_rear_right']:
    sys.exit(f'roues mal séparées : {sorted(groups)}')

# --- fewer draw calls ---------------------------------------------------------
# Each object x material is one draw call: 79 objects made 103. Materials
# that render the same become one, and every part that never moves on its own
# (all but wheels, lamps and windows) becomes one object.


def look(mat):
    p = next(n for n in mat.node_tree.nodes if n.bl_idname == 'ShaderNodeBsdfPrincipled')
    imgs = tuple(sorted(n.image.name for n in mat.node_tree.nodes if n.bl_idname == 'ShaderNodeTexImage'))
    vals = tuple(round(v, 3) for name in ('Base Color', 'Emission Color')
                 for v in p.inputs[name].default_value)
    vals += tuple(round(p.inputs[n].default_value, 3)
                  for n in ('Metallic', 'Roughness', 'Alpha', 'Coat Weight', 'Emission Strength'))
    return vals, imgs, any(l.to_socket.name == 'Alpha' for l in mat.node_tree.links)


canonical = {}
for o in scene.objects:
    if o.type != 'MESH':
        continue
    for slot in o.material_slots:
        if slot.material is None or not slot.material.node_tree:
            continue
        key = look(slot.material)
        slot.material = canonical.setdefault(key, slot.material)

MOVING = ('wheel_', 'headlight', 'taillight', 'window', 'windshield')
static = [o for o in scene.objects if o.type == 'MESH' and not o.name.startswith(MOVING)]
bpy.ops.object.select_all(action='DESELECT')
for o in static:
    o.select_set(True)
body = bpy.data.objects['body']
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
# Joining keeps every slot, including the ones now pointing at the same material.
bpy.ops.object.material_slot_remove_unused()
used = {}
for i, slot in enumerate(body.material_slots):
    used.setdefault(slot.material, i)
remap = [used[s.material] for s in body.material_slots]
for poly in body.data.polygons:
    poly.material_index = remap[poly.material_index]
bpy.ops.object.material_slot_remove_unused()

# --- export -----------------------------------------------------------------
tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in scene.objects if o.type == 'MESH')
print(f'{len([o for o in scene.objects if o.type == "MESH"])} objets, {tris} triangles')

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    export_image_format='WEBP',
    export_image_quality=88,
    export_apply=True,
    export_yup=True,
    export_texcoords=True,
    export_normals=True,
    export_tangents=False,
    export_materials='EXPORT',
    export_cameras=False,
    export_lights=False,
    export_animations=False,
    export_draco_mesh_compression_enable=False,
)
