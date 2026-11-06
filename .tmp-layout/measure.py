from PIL import Image

im = Image.open(r'.tmp-layout/shot.png').convert('RGB')
w, h = im.size
print('size', w, h)
px = im.load()


def kind(c):
    r, g, b = c
    if r > 235 and g > 235 and b > 235:
        return 'white'
    if abs(r - 32) < 12 and abs(g - 36) < 12 and abs(b - 44) < 14:
        return 'canvasbg'
    if abs(r - 23) < 8 and abs(g - 26) < 8 and abs(b - 33) < 10:
        return 'panel'
    if abs(r - 17) < 6 and abs(g - 26) < 6 and abs(b - 33) < 8:
        return 'panel'
    return 'other'


def runs(y):
    out = []
    prev = None
    start = 0
    for x in range(w):
        k = kind(px[x, y])
        if k != prev:
            if prev is not None:
                out.append((prev, start, x - 1, x - start))
            prev = k
            start = x
    out.append((prev, start, w - 1, w - start))
    return [r for r in out if r[3] > 3]


for y in (5, 40, 70, 100, 400, 800, 860, 900, 914):
    print(y, runs(y))

print('--- columns ---')


def vruns(x):
    out = []
    prev = None
    start = 0
    for y in range(h):
        k = kind(px[x, y])
        if k != prev:
            if prev is not None:
                out.append((prev, start, y - 1, y - start))
            prev = k
            start = y
    out.append((prev, start, h - 1, h - start))
    return [r for r in out if r[3] > 3]


for x in (5, 100, 250, 300, 600, 1200, 1450, 1500, 1600, 1900):
    print(x, vruns(x))
