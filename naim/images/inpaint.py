"""Mask preparation and compositing, independent of HTTP."""
import io
from PIL import Image
from naim.images.prompt_metadata import save_png_with_prompt_metadata


def prepare_inpaint_mask_bytes(mask_bytes):
    with Image.open(io.BytesIO(mask_bytes)) as mask_img:
        mask_img = mask_img.convert("RGBA")
        gray = mask_img.convert("L")
        binary = gray.point(lambda px: 255 if px > 32 else 0, "L")
        alpha = mask_img.getchannel("A").point(lambda px: 255 if px >= 16 else 0, "L")
        black = Image.new("L", mask_img.size, 0)
        binary = Image.composite(binary, black, alpha)

        width, height = binary.size
        grid = 8
        small_w = max(1, (width + grid - 1) // grid)
        small_h = max(1, (height + grid - 1) // grid)
        small = Image.new("L", (small_w, small_h), 0)

        for gy in range(small_h):
            top = gy * grid
            bottom = min(height, top + grid)
            for gx in range(small_w):
                left = gx * grid
                right = min(width, left + grid)
                if binary.crop((left, top, right, bottom)).getbbox():
                    small.putpixel((gx, gy), 255)

        binary = small.resize((small_w * grid, small_h * grid), Image.Resampling.NEAREST).crop((0, 0, width, height))

        output = io.BytesIO()
        binary.convert("RGB").save(output, format="PNG", compress_level=0, optimize=False)
        return output.getvalue()


def image_to_png_bytes(image, prompt_info=None, source_label="NAI Image Manager Canvas Inpaint"):
    output = io.BytesIO()
    if prompt_info:
        save_png_with_prompt_metadata(image, output, prompt_info, source_label=source_label)
    else:
        image.save(output, format="PNG")
    return output.getvalue()


def blend_canvas_inpaint_result_with_source(source_bytes, generated_bytes, mask_bytes, feather=0):
    with Image.open(io.BytesIO(source_bytes)) as source_img:
        source_rgb = source_img.convert("RGB")
    with Image.open(io.BytesIO(generated_bytes)) as generated_img:
        generated_rgb = generated_img.convert("RGB")
    with Image.open(io.BytesIO(mask_bytes)) as mask_img:
        mask_l = mask_img.convert("L")

    if generated_rgb.size != source_rgb.size:
        generated_rgb = generated_rgb.resize(source_rgb.size, Image.Resampling.LANCZOS)
    if mask_l.size != source_rgb.size:
        mask_l = mask_l.resize(source_rgb.size, Image.Resampling.NEAREST)

    feather = max(0, int(feather or 0))
    if feather:
        from PIL import ImageFilter
        mask_l = mask_l.filter(ImageFilter.GaussianBlur(radius=feather))

    return Image.composite(generated_rgb, source_rgb, mask_l)

