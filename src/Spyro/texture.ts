import ArrayBufferSlice from "../ArrayBufferSlice";
import { GfxDevice, GfxTextureUsage, GfxTextureDimension } from "../gfx/platform/GfxPlatform";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat";
import { GfxTexture } from "../gfx/platform/GfxPlatformImpl";

// Credit to "Spyro World Viewer" by Kly_Men_COmpany for the initial parsing and reverse-engineering work

interface TextureDefinition {
    x: number;
    y: number;
    pageX: number;
    pageY: number;
    size: number;
    bitDepth: 4 | 8 | 15;
    rotation: number;
    blendMode: SpyroBlendMode;
    semiTransparent: boolean; // overwritten for s1
}

interface TextureHeader {
    mid: TextureDefinition;
    cor: TextureDefinition[];
    // also lod, tny and spr, but unused here
}

export interface SpyroRawTexture {
    mid: TextureDefinition;
    levels: Uint8Array[];
    texelClasses: TexelClass;
}

export class SpyroVRAM {
    private data: Uint16Array;

    constructor(data: ArrayBufferSlice) {
        this.data = new Uint16Array(data.copyToBuffer());
    }

    public getWord(wordX: number, wordY: number): number {
        if (wordX < 0 || wordX >= 512 || wordY < 0 || wordY >= 512) {
            return 0;
        }
        return this.data[wordY * 512 + wordX];
    }

    public getWordByIndex(index: number): number {
        if (index < 0 || index >= this.data.length) {
            return 0;
        }
        return this.data[index];
    }

    public applyFontStripFix() {
        for (let x = 512; x <= 575; x++) {
            this.data[130560 + x] = this.data[130048 + x - 512];
        }
    }
}

export class SpyroTexture {
    public gfxTexture: GfxTexture;
    public hasOpaqueTexels: boolean;
    public hasStpTexels: boolean;
    public hasTransparentTexels: boolean;

    constructor(device: GfxDevice, raw: SpyroRawTexture, name: string, public isScrolling: boolean) {
        this.hasOpaqueTexels = (raw.texelClasses & TexelClass.OPAQUE) !== 0;
        this.hasStpTexels = (raw.texelClasses & TexelClass.STP) !== 0;
        this.hasTransparentTexels = (raw.texelClasses & TexelClass.TRANSPARENT) !== 0;

        const size = 32 << (raw.levels.length - 1);
        this.gfxTexture = device.createTexture({
            width: size, height: size,
            numLevels: raw.levels.length,
            pixelFormat: GfxFormat.U8_RGBA_NORM,
            usage: GfxTextureUsage.Sampled,
            dimension: GfxTextureDimension.n2D,
            depthOrArrayLayers: 1
        });
        device.setResourceName(this.gfxTexture, name);
        device.uploadTextureData(this.gfxTexture, 0, raw.levels);
    }
}

export enum SpyroBlendMode {
    OPAQUE = -1,
    AVERAGE = 0, // B/2 + F/2
    ADDITIVE = 1, // B + F
    SUBTRACTIVE = 2, // B - F
    QUARTER = 3, // B + F/4
}

const enum TexelClass {
    TRANSPARENT = 1 << 0,
    STP = 1 << 1,
    OPAQUE = 1 << 2,
}

// temp manual workaround for cor textures in s3 sublevels with "missing" vram data (see TODO notes)
const S3_SUBLEVEL_INVALID_COR_TEXTURES: Map<number, number[]> = new Map([
    [122, [3, 4, 5, 6, 77, 78]],
    [124, [10, 15, 16, 67]],
    [140, [36, 60, 71, 78]],
    [156, [0]],
    [170, [1, 21, 22, 65]]
]);
const TEXEL_ALPHA_TRANSPARENT = 0;
const TEXEL_ALPHA_STP = 128;
const TEXEL_ALPHA_OPAQUE = 255;
const turn = (src: Uint32Array, s: number) => remap(src, s, (x, y) => x * s + (s - 1 - y));
const mirror = (src: Uint32Array, s: number) => remap(src, s, (x, y) => y * s + (s - 1 - x));
const flip = (src: Uint32Array, s: number) => remap(src, s, (x, y) => (s - 1 - y) * s + x);

function getTexelClasses(levels: Uint32Array[]): TexelClass {
    let classes = 0;
    for (const level of levels) {
        for (let i = 0; i < level.length; i++) {
            const alpha = level[i] >>> 24;
            classes |= alpha === TEXEL_ALPHA_TRANSPARENT ? TexelClass.TRANSPARENT : alpha === TEXEL_ALPHA_STP ? TexelClass.STP : TexelClass.OPAQUE;
        }
    }
    return classes;
}

function readTextureDefinition(data: DataView, offset: number, gameNumber: number): TextureDefinition {
    const flags1 = data.getUint8(offset + 6);
    const flags2 = data.getUint8(offset + 7);
    let bitDepth: 4 | 8 | 15, shiftUnit: number;
    if (flags2 & 1) {
        bitDepth = 15;
        shiftUnit = 64;
    } else if (flags1 & 128) {
        bitDepth = 8;
        shiftUnit = 128;
    } else {
        bitDepth = 4;
        shiftUnit = 256;
    }
    const page0 = data.getUint8(offset + 2);
    const page1 = data.getUint8(offset + 3);
    return {
        x: data.getUint8(offset) + (flags1 & 7) * shiftUnit,
        y: data.getUint8(offset + 1) + ((flags1 & 16) ? 256 : 0),
        pageX: (page0 & 31) * 16,
        pageY: (page0 >> 6) | (page1 << 2),
        size: (gameNumber === 1 && !(flags2 & 128)) ? 16 : 32,
        bitDepth,
        rotation: (flags2 >> 4) & 7,
        blendMode: (flags1 >> 5) & 3,
        semiTransparent: gameNumber > 1 && (flags2 & 128) !== 0,
    };
}

function readCorners(data: DataView, offset: number, gameNumber: number): TextureDefinition[] {
    return [0, 1, 2, 3].map((j) => readTextureDefinition(data, offset + j * 8, gameNumber));
}

function parseSpyroTextureTable(data: DataView, gameNumber: number): TextureHeader[] {
    const count = data.getUint32(0, true);
    const headers: TextureHeader[] = Array(count);
    if (gameNumber === 1) {
        // lod-mid header pairs (16 each), followed by groups of spr-cor-sm headers (8 + 32 + 128 each)
        const corStart = 4 + 16 * count;
        for (let i = 0; i < count; i++) {
            const mid = readTextureDefinition(data, 4 + i * 16 + 8, gameNumber);
            const cor = readCorners(data, corStart + i * 168 + 8, gameNumber);
            headers[i] = { mid, cor };
        }
    } else {
        // sequential lod-mid-cor headers (8 + 8 + 32 each)
        for (let i = 0; i < count; i++) {
            const offset = 4 + i * 48;
            headers[i] = { mid: readTextureDefinition(data, offset + 8, gameNumber), cor: readCorners(data, offset + 16, gameNumber) };
        }
    }
    return headers;
}

function remap(src: Uint32Array, size: number, getDestIndex: (x: number, y: number) => number): Uint32Array {
    const dest = new Uint32Array(src.length);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            dest[getDestIndex(x, y)] = src[y * size + x];
        }
    }
    return dest;
}

function applyTileRotation(texels: Uint32Array, tex: TextureDefinition, gameNumber: number): Uint32Array {
    const size = tex.size;
    switch (tex.rotation) {
        case 1:
            return mirror(flip(turn(texels, size), size), size);
        case 2:
            return gameNumber === 1 ? turn(turn(texels, size), size) : mirror(flip(texels, size), size);
        case 3:
            return gameNumber === 1 ? mirror(flip(texels, size), size) : turn(turn(texels, size), size);
        case 4:
            return mirror(turn(texels, size), size);
        case 5:
            return mirror(texels, size);
        case 6:
            return flip(turn(texels, size), size);
        case 7:
            return flip(texels, size);
        default:
            return texels;
    }
}

function colorBitsToRGBA(word: number): number {
    // 15-bit color to packed RGBA u32
    const r = ((word & 31) * 255 / 31) | 0;
    const g = (((word >> 5) & 31) * 255 / 31) | 0;
    const b = (((word >> 10) & 31) * 255 / 31) | 0;
    const a = word === 0x0000 ? TEXEL_ALPHA_TRANSPARENT : ((word >> 15) & 1) ? TEXEL_ALPHA_STP : TEXEL_ALPHA_OPAQUE;
    return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
}

function getCLUT(vram: SpyroVRAM, px: number, py: number, n: number): Uint32Array {
    const clut = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        clut[i] = colorBitsToRGBA(vram.getWordByIndex((py * 512 + px) + i));
    }
    return clut;
}

function decodeTile(vram: SpyroVRAM, tex: TextureDefinition, gameNumber: number): Uint32Array {
    // decodes a tile to packed RGBA with its rotation applied
    const size = tex.size;
    const startX = tex.x;
    const startY = tex.y;
    const texels = new Uint32Array(size * size);
    if (tex.bitDepth === 4) {
        const clut = getCLUT(vram, tex.pageX, tex.pageY, 16);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size / 4; x++) {
                const word = vram.getWord((startX >> 2) + x, startY + y);
                for (let nib = 0; nib < 4; nib++) {
                    texels[y * size + x * 4 + nib] = clut[(word >> (nib * 4)) & 15];
                }
            }
        }
    } else if (tex.bitDepth === 8) {
        const clut = getCLUT(vram, tex.pageX, tex.pageY, 256);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size / 2; x++) {
                const word = vram.getWord((startX >> 1) + x, startY + y);
                texels[y * size + x * 2] = clut[word & 255];
                texels[y * size + x * 2 + 1] = clut[(word >> 8) & 255];
            }
        }
    } else {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                texels[y * size + x] = colorBitsToRGBA(vram.getWord(startX + x, startY + y));
            }
        }
    }
    return applyTileRotation(texels, tex, gameNumber);
}

function combineCorners(corners: Uint32Array[], size: number): Uint32Array {
    const [topLeft, topRight, bottomLeft, bottomRight] = corners;
    const width = size * 2;
    const combined = new Uint32Array(width * width);
    for (let y = 0; y < size; y++) {
        const start = y * size;
        const end = start + size;
        combined.set(topLeft.subarray(start, end), y * width);
        combined.set(topRight.subarray(start, end), y * width + size);
        combined.set(bottomLeft.subarray(start, end), (y + size) * width);
        combined.set(bottomRight.subarray(start, end), (y + size) * width + size);
    }
    return combined;
}

export function buildSpyroRawTextures(vram: SpyroVRAM, textureTable: DataView, gameNumber: number, levelId: number, subLevelId: number): SpyroRawTexture[] {
    const invalidCOR = (gameNumber === 3 && subLevelId > 0) ? S3_SUBLEVEL_INVALID_COR_TEXTURES.get(levelId) ?? [] : [];
    return parseSpyroTextureTable(textureTable, gameNumber).map(({ mid, cor }, i) => {
        const levels: Uint32Array[] = [];
        if (!invalidCOR.includes(i)) {
            levels.push(combineCorners(cor.map((c) => decodeTile(vram, c, gameNumber)), cor[0].size));
        }
        levels.push(decodeTile(vram, mid, gameNumber));

        const texelClasses = getTexelClasses(levels);
        if (gameNumber === 1) {
            // unknown s1 semi-transparency bits, but semi-transparent textures always contain STP texels
            mid.semiTransparent = (texelClasses & TexelClass.STP) !== 0;
        }
        return { mid, levels: levels.map((level) => new Uint8Array(level.buffer)), texelClasses };
    });
}
