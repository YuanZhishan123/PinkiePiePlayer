"""Convert the AI-cut JPEG (white background) into a true transparent PNG icon."""
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

SRC = r"C:\Users\mingyue\Desktop\graph\图片背景抠除（透明PNG）.jpeg"
OUT_SRC = r"D:\code\video-player\src-tauri\icons\icon-source.png"
OUT_PREVIEW = r"D:\code\video-player\icon-preview.png"

img = Image.open(SRC).convert("RGBA")
a = np.asarray(img).astype(np.int16)
R, G, B = a[..., 0], a[..., 1], a[..., 2]

# near-white background (JPEG-tolerant)
near_white = (R >= 234) & (G >= 234) & (B >= 234)

# only components touching the image border are background (protect cream banjo head)
lab, n = ndimage.label(near_white)
border_labels = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
border_labels.discard(0)
bg = np.isin(lab, list(border_labels))

alpha = np.where(bg, 0, 255).astype(np.uint8)
alpha = np.asarray(Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(1.2)))

out = np.asarray(img).astype(np.uint8).copy()
# suppress white fringe on semi-transparent edge pixels
edge = (alpha > 0) & (alpha < 255)
out[edge, 0] = (out[edge, 0].astype(np.float32) * 0.85).astype(np.uint8)
out[..., 3] = alpha
res = Image.fromarray(out, "RGBA")

# crop to content, square-pad with 6% margin
ys, xs = np.where(alpha > 8)
y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
res = res.crop((x0, y0, x1 + 1, y1 + 1))
side = int(max(res.size) * 1.06)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(res, ((side - res.width) // 2, (side - res.height) // 2), res)
canvas = canvas.resize((1024, 1024), Image.LANCZOS)
canvas.save(OUT_SRC)

canvas.resize((256, 256), Image.LANCZOS).save(OUT_PREVIEW)
bgc = Image.new("RGBA", (256, 256), (230, 230, 230, 255))
for yy in range(0, 256, 16):
    for xx in range(0, 256, 16):
        if (xx // 16 + yy // 16) % 2:
            bgc.paste((205, 205, 205, 255), (xx, yy, min(xx + 16, 256), min(yy + 16, 256)))
bgc.alpha_composite(canvas.resize((256, 256), Image.LANCZOS))
bgc.convert("RGB").save(r"D:\code\video-player\icon-preview-checker.png")
print("done", canvas.size)
