from PIL import Image

im = Image.open(r'.tmp-layout/shot.png').convert('RGB')
w, h = im.size
im.crop((1830, 0, w, h)).resize((80 * 4, h)).save(r'.tmp-layout/crop-right.png')
im.crop((250, 820, 1910, 915)).save(r'.tmp-layout/crop-bottom.png')
im.crop((250, 55, 1600, 200)).save(r'.tmp-layout/crop-top.png')
im.crop((1250, 800, 1610, 900)).resize((360 * 3, 100 * 3)).save(r'.tmp-layout/crop-controls.png')
print([(x, im.getpixel((x, 300))) for x in (0, 100, 250, 300, 400, 1000, 1520, 1550, 1570, 1700, 1880, 1900, 1909)])
print([(y, im.getpixel((600, y))) for y in (0, 30, 60, 64, 66, 80, 84, 86, 850, 860, 880, 900, 910, 914)])
