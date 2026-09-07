"""Quantize the 3D captures using the original mascot's 96px pixel export recipe.

python3 scripts/mascot/encode-pickup.py /tmp/inertia-pickup
Authoring tools only: Pillow and img2webp (libwebp), neither ships in the app.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys

from PIL import Image, ImageFilter

source = Path(sys.argv[1])
assets = Path(__file__).resolve().parents[2] / 'src/renderer/src/assets/mascot'
manifest = json.loads((assets / 'manifest.json').read_text())
colors = [tuple(bytes.fromhex(color[1:])) for color in manifest['palette'] if color != '#151e2b']
palette = Image.new('P', (1, 1))
palette.putpalette([channel for color in colors for channel in color] + list(colors[-1]) * (256 - len(colors)))
frames = source / 'pixel'
frames.mkdir(exist_ok=True)
command = ['img2webp', '-loop', '0', '-lossless', '-exact', '-m', '6']
for frame in range(24):
    image = Image.open(source / f'{frame:04}.png').convert('RGBA').resize((96, 96), Image.Resampling.BOX)
    alpha = image.getchannel('A').point(lambda value: 255 if value >= 144 else 0)
    image = image.convert('RGB').quantize(palette=palette, dither=Image.Dither.NONE).convert('RGBA')
    image.putalpha(alpha)
    outline = Image.new('RGBA', (96, 96), (21, 30, 43, 0))
    outline.putalpha(alpha.filter(ImageFilter.MaxFilter(3)))
    image = Image.alpha_composite(outline, image)
    path = frames / f'{frame:04}.png'
    image.save(path)
    command += ['-d', str(round((frame + 1) * 1000 / 12) - round(frame * 1000 / 12)), str(path)]
subprocess.run([*command, '-o', str(assets / 'pickup.webp')], check=True)
shutil.copyfile(frames / '0000.png', assets / 'pickup.png')
