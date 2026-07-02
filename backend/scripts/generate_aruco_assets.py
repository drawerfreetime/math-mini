import os

import cv2
import numpy as np


def main():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    out_dir = os.path.join(repo_root, "public", "aruco")
    os.makedirs(out_dir, exist_ok=True)

    aruco = cv2.aruco
    dictionary = aruco.getPredefinedDictionary(aruco.DICT_4X4_50)

    # Corner IDs (stable mapping; interpretation handled by scanner)
    # tl=10, tr=11, br=12, bl=13
    ids = [10, 11, 12, 13]

    # Generate at high resolution so PDF downscaling stays crisp
    side_px = 360
    border_bits = 1

    for marker_id in ids:
        img = aruco.generateImageMarker(dictionary, marker_id, side_px, borderBits=border_bits)
        img = (img > 0).astype(np.uint8) * 255  # ensure pure 0/255 grayscale
        path = os.path.join(out_dir, f"DICT_4X4_50_id{marker_id}.png")
        # cv2.imwrite can fail on Windows with non-ASCII paths (e.g., Korean folders).
        # Work around by encoding to PNG bytes and writing via Python's unicode-safe file IO.
        ok, buf = cv2.imencode(".png", img)
        if not ok:
            raise RuntimeError(f"Failed to encode PNG for id={marker_id}")
        with open(path, "wb") as f:
            f.write(buf.tobytes())
        print("wrote", path)

    print("OK")


if __name__ == "__main__":
    main()

