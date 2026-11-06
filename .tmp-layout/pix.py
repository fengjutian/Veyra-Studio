from PIL import Image

im = Image.open(r'.tmp-layout/shot.png').convert('RGB')
w, h = im.size
print('row y=300 x1875..1909:', [(x, im.getpixel((x, 300))) for x in range(1875, w)])
print()
print('row y=120 x1480..1580:', [(x, im.getpixel((x, 120))) for x in range(1480, 1580, 2)])
print()
print('col x=1700 y880..914:', [(y, im.getpixel((1700, y))) for y in range(880, h)])
print()
print('col x=100 y880..914:', [(y, im.getpixel((100, y))) for y in range(880, h)])
print()
print('col x=1500 y880..914:', [(y, im.getpixel((1500, y))) for y in range(880, h)])
print()
print('col x=1400 y60..95:', [(y, im.getpixel((1400, y))) for y in range(60, 96)])
print()
print('col x=290 y60..100:', [(y, im.getpixel((290, y))) for y in range(60, 101, 2)])
print('row y=90 x280..330:', [(x, im.getpixel((x, 90))) for x in range(280, 331, 2)])
