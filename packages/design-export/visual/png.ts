/**
 * 视觉回归用的最小 PNG 编解码与像素对比。
 *
 * 不引入图像库：Visual Studio 依赖一堆原生模块，而我们只需要读 Chrome 截出来的
 * 8-bit RGB/RGBA、非隔行 PNG，并把差异写成一张图。这里用 node:zlib 手写。
 */
import { deflateSync, inflateSync } from "node:zlib";

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA，逐行紧密排列。 */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 解码 PNG。支持 8-bit、颜色类型 2（RGB）与 6（RGBA）、非隔行。 */
export function decodePng(buffer: Buffer): RgbaImage {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("不是 PNG 文件");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      const interlace = data[12] ?? 0;
      if (bitDepth !== 8) throw new Error(`只支持 8-bit PNG，收到 ${bitDepth}`);
      if (colorType !== 2 && colorType !== 6) throw new Error(`只支持 RGB/RGBA PNG，收到颜色类型 ${colorType}`);
      if (interlace !== 0) throw new Error("不支持隔行 PNG");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!width || !height) throw new Error("PNG 缺少 IHDR");

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(stride * height);
  const bpp = channels;
  let cursor = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor++] ?? 0;
    const rowStart = y * stride;
    const previousStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[cursor++] ?? 0;
      const left = x >= bpp ? pixels[rowStart + x - bpp]! : 0;
      const up = y > 0 ? pixels[previousStart + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[previousStart + x - bpp]! : 0;
      pixels[rowStart + x] = unfilter(filter, rawByte, left, up, upLeft);
    }
  }

  if (channels === 4) return { width, height, data: pixels };

  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = pixels[index * 3]!;
    rgba[index * 4 + 1] = pixels[index * 3 + 1]!;
    rgba[index * 4 + 2] = pixels[index * 3 + 2]!;
    rgba[index * 4 + 3] = 255;
  }
  return { width, height, data: rgba };
}

function unfilter(filter: number, value: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0: return value;
    case 1: return (value + left) & 0xff;
    case 2: return (value + up) & 0xff;
    case 3: return (value + ((left + up) >> 1)) & 0xff;
    case 4: return (value + paeth(left, up, upLeft)) & 0xff;
    default: throw new Error(`未知的 PNG filter: ${filter}`);
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  if (toUp <= toUpLeft) return up;
  return upLeft;
}

/** 编码成 RGBA PNG（filter 0），用于输出差异图。 */
export function encodePng(image: RgbaImage): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(image.data.buffer, image.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr(image.width, image.height)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function ihdr(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;   // bit depth
  data[9] = 6;   // color type RGBA
  data[10] = 0;  // compression
  data[11] = 0;  // filter
  data[12] = 0;  // interlace
  return data;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface DiffOptions {
  /** 单通道允许的差值；低于等于它视为相同。默认 0。 */
  tolerance?: number;
  /**
   * 豁免抗锯齿边缘像素。默认 true。
   *
   * 浏览器渲染的斜边文字/圆角在两台机器上可能有 1 个灰阶的舍入差，这类差值不是
   * 回归。开启后，差值处于"边缘灰阶区间"的像素按豁免处理，只记为 AA 差异。
   */
  ignoreAntiAlias?: boolean;
  /**
   * 忽略的区域（CSS 像素坐标）。这些区域完全不参与差异统计。
   *
   * 用于屏蔽动态内容（时钟、随机头像、光标）——它们每次渲染都不同，比对它们
   * 只会制造假失败。
   */
  ignoreRegions?: IgnoreRegion[];
}

/** 需要忽略的矩形区域。坐标是 CSS 像素，原点在左上角。 */
export interface IgnoreRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelDiff {
  width: number;
  height: number;
  /** 有差异的像素数（已扣除 AA 豁免与忽略区域）。 */
  differentPixels: number;
  /** 因抗锯齿而被豁免的像素数。 */
  antiAliasedPixels: number;
  /** 因落在忽略区域内而跳过的像素数。 */
  ignoredPixels: number;
  totalPixels: number;
  /** 差异像素占比（0–1）。 */
  ratio: number;
  /** 最大单通道差值，便于判断是字体抗锯齿还是整体错位。 */
  maxChannelDelta: number;
  /** 差异可视化：不同的像素标红，其余淡化。 */
  image: RgbaImage;
}

/**
 * 抗锯齿判定的灰阶上限。
 *
 * 一个像素如果夹在前景色和背景色之间（典型的斜边文字），它的灰阶跨度不超过
 * 这个值时，两张图的差异更可能来自舍入而不是布局。这里取 64（占 255 的 25%），
 * 与 desigma-diff 的默认抗锯齿豁免保持同一量级。
 */
const ANTI_ALIAS_SPAN = 64;

/**
 * 可以被当作抗锯齿差异豁免的最大通道差。
 *
 * 光看"是否在边缘上"不够：孤立的一个亮像素周围全是黑，它同样处于边缘，
 * 但那是一次真实的内容改动。必须同时限制**差异幅度**——只有幅度也很小
 * （跨机器渲染的灰阶舍入）才豁免。真实改动（文字位移、颜色变化）的幅度
 * 通常远大于这个值，仍然会被标红。
 */
const ANTI_ALIAS_MAX_DELTA = 64;

/**
 * 判断像素 (x, y) 是否处于抗锯齿边缘。
 *
 * 判据：该像素与 8 邻域中存在"亮度差大于 ANTI_ALIAS_SPAN"的邻居，
 * 说明它跨越了前景/背景边界。
 */
function isAntiAliasedEdge(image: RgbaImage, x: number, y: number): boolean {
  const width = image.width;
  const height = image.height;
  const index = y * width + x;
  const luminance = (pixelIndex: number): number => {
    const offset = pixelIndex * 4;
    return (
      0.299 * image.data[offset]! +
      0.587 * image.data[offset + 1]! +
      0.114 * image.data[offset + 2]!
    );
  };
  const center = luminance(index);
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (Math.abs(luminance(ny * width + nx) - center) > ANTI_ALIAS_SPAN) return true;
    }
  }
  return false;
}

function inIgnoreRegion(x: number, y: number, regions: IgnoreRegion[] | undefined): boolean {
  if (!regions?.length) return false;
  for (const region of regions) {
    if (
      x >= region.x &&
      x < region.x + region.width &&
      y >= region.y &&
      y < region.y + region.height
    ) {
      return true;
    }
  }
  return false;
}

/** 比较两张同尺寸图片。尺寸不同直接抛错，避免"拉伸后再比较"掩盖布局问题。 */
export function diffImages(left: RgbaImage, right: RgbaImage, options: DiffOptions = {}): PixelDiff {
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error(`图片尺寸不一致：${left.width}x${left.height} vs ${right.width}x${right.height}`);
  }
  const tolerance = options.tolerance ?? 0;
  const ignoreAntiAlias = options.ignoreAntiAlias ?? true;
  const ignoreRegions = options.ignoreRegions;
  const total = left.width * left.height;
  const image: RgbaImage = { width: left.width, height: left.height, data: new Uint8Array(total * 4) };
  let different = 0;
  let antiAliased = 0;
  let ignored = 0;
  let maxDelta = 0;

  for (let index = 0; index < total; index += 1) {
    const a = index * 4;
    const delta = Math.max(
      Math.abs(left.data[a]! - right.data[a]!),
      Math.abs(left.data[a + 1]! - right.data[a + 1]!),
      Math.abs(left.data[a + 2]! - right.data[a + 2]!),
    );
    maxDelta = Math.max(maxDelta, delta);

    const x = index % left.width;
    const y = Math.floor(index / left.width);
    if (inIgnoreRegion(x, y, ignoreRegions)) {
      ignored += 1;
      image.data[a] = 200; image.data[a + 1] = 200; image.data[a + 2] = 200; image.data[a + 3] = 255;
      continue;
    }

    if (delta > tolerance) {
      // 只有"幅度也小"的边缘差异才降级为 AA 差异：真实内容改动幅度大，仍会标红。
      if (
        ignoreAntiAlias &&
        delta <= ANTI_ALIAS_MAX_DELTA &&
        (isAntiAliasedEdge(left, x, y) || isAntiAliasedEdge(right, x, y))
      ) {
        antiAliased += 1;
        image.data[a] = 255; image.data[a + 1] = 165; image.data[a + 2] = 0; image.data[a + 3] = 255;
        continue;
      }
      different += 1;
      image.data[a] = 255; image.data[a + 1] = 0; image.data[a + 2] = 0; image.data[a + 3] = 255;
    } else {
      const grey = 235;
      image.data[a] = grey; image.data[a + 1] = grey; image.data[a + 2] = grey; image.data[a + 3] = 255;
    }
  }

  return {
    width: left.width,
    height: left.height,
    differentPixels: different,
    antiAliasedPixels: antiAliased,
    ignoredPixels: ignored,
    totalPixels: total,
    ratio: different / total,
    maxChannelDelta: maxDelta,
    image,
  };
}
