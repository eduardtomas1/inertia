import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw

NAMES = ["runner", "scout", "guard", "builder", "scribe", "spark"]
THEMES = ["dark", "light"]
SIZE = 256
ALPHA_FLOOR = 8
UNIFORM_SPREAD = 0.10
TILES = {"dark": (20, 24, 33), "light": (244, 244, 242)}
SURFACES = {"dark": (33, 34, 38), "light": (255, 255, 255)}
INK = {"dark": (238, 238, 238), "light": (41, 45, 53)}


def parse_args():
    parser = argparse.ArgumentParser(description="Frame and tone the twelve custom agent mark renders.")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sheets", type=Path)
    parser.add_argument("--margin", type=float, default=0.07)
    parser.add_argument("--light-contrast", type=float, default=1.3)
    parser.add_argument("--light-lift", type=float, default=0.5)
    parser.add_argument("--dark-brightness", type=float, default=1.06)
    return parser.parse_args()


def load_sources(source):
    images = {}
    for name in NAMES:
        for theme in THEMES:
            path = source / f"{name}-{theme}.png"
            if not path.is_file() or path.is_symlink():
                raise SystemExit(f"Missing render: {path}")
            images[name, theme] = Image.open(path).convert("RGBA")
    return images


def alpha_box(image):
    box = image.getchannel("A").point(lambda value: 255 if value > ALPHA_FLOOR else 0).getbbox()
    if box is None:
        raise SystemExit("A render is fully transparent")
    return box


def square_sides(boxes, margin):
    heights = [box[3] - box[1] for box in boxes.values()]
    fill = 1 - 2 * margin
    if max(heights) > min(heights) * (1 + UNIFORM_SPREAD):
        shared = max(max(box[2] - box[0], box[3] - box[1]) for box in boxes.values()) / fill
        return {key: shared for key in boxes}, True
    return {key: max(box[2] - box[0], box[3] - box[1]) / fill for key, box in boxes.items()}, False


def opaque_mean(images):
    total = 0
    count = 0
    for image in images:
        mask = image.getchannel("A").point(lambda value: 255 if value > 250 else 0)
        histogram = image.convert("RGB").convert("L").histogram(mask=mask)
        total += sum(level * hits for level, hits in enumerate(histogram))
        count += sum(histogram)
    return total / count


def smoothstep(edge0, edge1, value):
    t = min(1.0, max(0.0, (value - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


def light_curve(pivot, contrast, lift):
    table = []
    for level in range(256):
        value = pivot + (level - pivot) * contrast
        value = min(255.0, max(0.0, value))
        value += lift * smoothstep(0.45 * 255, 255, value) * (255 - value)
        table.append(round(min(255.0, max(0.0, value))))
    return table


def dark_curve(brightness):
    return [round(min(255.0, level * brightness)) for level in range(256)]


def tone(image, table):
    red, green, blue, alpha = image.split()
    return Image.merge("RGBA", (red.point(table), green.point(table), blue.point(table), alpha))


def frame(image, box, side):
    centre_x = (box[0] + box[2]) / 2
    centre_y = (box[1] + box[3]) / 2
    left = centre_x - side / 2
    top = centre_y - side / 2
    pad = max(0, math.ceil(max(-left, -top, left + side - image.width, top + side - image.height))) + 2
    canvas = Image.new("RGBA", (image.width + 2 * pad, image.height + 2 * pad), (0, 0, 0, 0))
    canvas.paste(image, (pad, pad))
    region = (left + pad, top + pad, left + pad + side, top + pad + side)
    resized = canvas.convert("RGBa").resize((SIZE, SIZE), Image.Resampling.LANCZOS, box=region)
    return resized.convert("RGBA")


def tile(image, theme, size, scale):
    device = size * scale
    inset = (1 if size <= 24 else 2 if size < 48 else 4) * scale
    base = Image.new("RGBA", (device, device), TILES[theme] + (255,))
    figure = image.resize((device - 2 * inset, device - 2 * inset), Image.Resampling.LANCZOS)
    base.alpha_composite(figure, (inset, inset))
    mask = Image.new("L", (device, device), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, device - 1, device - 1), radius=round(device * 0.3), fill=255)
    return base, mask


def write_contact_sheet(path, framed):
    cell = SIZE + 28
    sheet = Image.new("RGB", (len(NAMES) * SIZE, len(THEMES) * cell))
    draw = ImageDraw.Draw(sheet)
    for row, theme in enumerate(THEMES):
        for column, name in enumerate(NAMES):
            x, y = column * SIZE, row * cell
            draw.rectangle((x, y, x + SIZE - 1, y + cell - 1), fill=TILES[theme])
            draw.rectangle((x, y, x + SIZE - 1, y + SIZE - 1), outline=INK[theme])
            sheet.paste(framed[name, theme], (x, y), framed[name, theme])
            draw.text((x + 12, y + SIZE + 8), name, fill=INK[theme])
    sheet.save(path)


def write_readability_sheet(path, before, after):
    sizes = [(36, 2), (20, 2), (36, 1), (20, 1)]
    column_width = sum(size * scale for size, scale in sizes) + 10 * len(sizes) + 10
    row_height = 84
    sheet = Image.new("RGB", (len(NAMES) * column_width + 90, len(THEMES) * 2 * row_height + 24), (90, 90, 90))
    draw = ImageDraw.Draw(sheet)
    for column, name in enumerate(NAMES):
        draw.text((90 + column * column_width + 10, 6), name, fill=(255, 255, 255))
    for theme_index, theme in enumerate(THEMES):
        for variant_index, (label, images) in enumerate([("before", before), ("after", after)]):
            y = 24 + (theme_index * 2 + variant_index) * row_height
            draw.text((6, y + 34), f"{theme} {label}", fill=(255, 255, 255))
            draw.rectangle((90, y, sheet.width - 1, y + row_height - 2), fill=SURFACES[theme])
            for column, name in enumerate(NAMES):
                cursor = 90 + column * column_width + 10
                for size, scale in sizes:
                    tile_image, mask = tile(images[name, theme], theme, size, scale)
                    sheet.paste(tile_image.convert("RGB"), (cursor, y + 5), mask)
                    cursor += size * scale + 10
    sheet.save(path)


def main():
    args = parse_args()
    sources = load_sources(args.source)
    boxes = {key: alpha_box(image) for key, image in sources.items()}
    sides, uniform = square_sides(boxes, args.margin)
    pivot = opaque_mean([sources[name, "light"] for name in NAMES])
    curves = {"light": light_curve(pivot, args.light_contrast, args.light_lift), "dark": dark_curve(args.dark_brightness)}
    framed = {key: frame(tone(image, curves[key[1]]), boxes[key], sides[key]) for key, image in sources.items()}
    args.output.mkdir(parents=True, exist_ok=True)
    for (name, theme), image in framed.items():
        image.save(args.output / f"{name}-{theme}.webp", "WEBP", quality=90, method=6)
    if args.sheets:
        args.sheets.mkdir(parents=True, exist_ok=True)
        write_contact_sheet(args.sheets / "contact-sheet.png", framed)
        before = {key: image.resize((SIZE, SIZE), Image.Resampling.LANCZOS) for key, image in sources.items()}
        write_readability_sheet(args.sheets / "readability.png", before, framed)
    scale = "one shared square" if uniform else "one square per render"
    print(f"Framed 12 marks into {args.output} ({scale}, margin {args.margin}, light pivot {pivot:.1f})")


main()
