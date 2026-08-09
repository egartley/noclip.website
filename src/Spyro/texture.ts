import { parseSpyroTextureTable, SpyroTextureDefinition, SpyroVRAM } from "./bin";
import { GfxDevice, GfxTextureUsage, GfxTextureDimension } from "../gfx/platform/GfxPlatform";
import { GfxFormat } from "../gfx/platform/GfxPlatformFormat";
import { GfxTexture } from "../gfx/platform/GfxPlatformImpl";

export interface SpyroTextureHeader {
    mid: SpyroTextureDefinition,
    cor?: SpyroTextureDefinition[]
}

export interface SpyroRawTextures {
    colors: Uint8Array[][];
    headers: SpyroTextureHeader[];
}

export class SpyroTexture {
    public gfxTexture: GfxTexture;

    constructor(device: GfxDevice, rgba: Uint8Array[], header: SpyroTextureHeader, i: number, public isScrolling: boolean) {
        const s = header.cor === undefined ? 32 : 64;
        this.gfxTexture = device.createTexture({
            width: s, height: s,
            numLevels: s / 32,
            pixelFormat: GfxFormat.U8_RGBA_NORM,
            usage: GfxTextureUsage.Sampled,
            dimension: GfxTextureDimension.n2D,
            depthOrArrayLayers: 1
        });
        device.setResourceName(this.gfxTexture, `tile_${i}`);
        device.uploadTextureData(this.gfxTexture, 0, rgba);
    }
}

// temp manual workaround for cor textures in s3 sublevels with "missing" vram data
const S3_SUBLEVEL_INVALID_COR_TEXTURES: Map<number, number[]> = new Map([
    [122, [3, 4, 5, 6, 77, 78]],
    [124, [10, 15, 16, 67]],
    [140, [36, 60, 71, 78]],
    [156, [0]],
    [170, [1, 21, 22, 65]]
]);

export function buildSpyroRawTextures(vram: SpyroVRAM, textureTable: DataView, gameNumber: number, levelId: number = -1): SpyroRawTextures {
    const headers = parseSpyroTextureTable(textureTable, gameNumber);
    const colors: Uint8Array[][] = Array(headers.length);
    for (let i = 0; i < headers.length; i++) {
        let doCOR = true;
        if (gameNumber === 3 && S3_SUBLEVEL_INVALID_COR_TEXTURES.has(levelId)) {
            doCOR = !S3_SUBLEVEL_INVALID_COR_TEXTURES.get(levelId)!.includes(i);
        }
        colors[i] = [];
        if (doCOR) {
            const corners: Uint8Array[] = Array(4);
            for (let j = 0; j < 4; j++) {
                corners[j] = applyTileRotationRGBA(
                    decodeTileToRGBA(vram, headers[i].cor![j]), headers[i].cor![j], headers[i].cor![j].size, gameNumber
                );
            }
            colors[i].push(combineCorners(corners[0], corners[1], corners[2], corners[3], 32));
        } else {
            headers[i].cor = undefined;
        }
        colors[i].push(applyTileRotationRGBA(
            decodeTileToRGBA(vram, headers[i].mid), headers[i].mid, headers[i].mid.size, gameNumber)
        );
    }
    return { colors, headers };
}

export function buildSpyroTextureDefinition(data: DataView, offset: number, gameNumber: number): SpyroTextureDefinition {
    const tex = new SpyroTextureDefinition(data, offset);
    if (gameNumber === 1) {
        if ((tex.flags2 & 128) > 0) {
            tex.size = 32;
        } else {
            tex.size = 16;
        }
    }
    if ((tex.flags2 & 1) > 0) {
        tex.bitDepth = 15;
    } else if ((tex.flags1 & 128) > 0) {
        tex.bitDepth = 8;
    } else {
        tex.bitDepth = 4;
    }
    tex.shift = tex.flags1 & 7;
    switch (tex.bitDepth) {
        case 4:
            tex.shift *= 256;
            break;
        case 8:
            tex.shift *= 128;
            break;
        case 15:
            tex.shift *= 64;
            break;
    }
    tex.x[3] = tex.baseX + tex.shift;
    tex.x[2] = tex.xx + tex.shift;
    tex.x[0] = tex.x[3];
    tex.x[1] = tex.x[3] + tex.size;
    tex.y[3] = tex.baseY;
    if ((tex.flags1 & 16) > 0) {
        tex.y[3] += 256;
    }
    tex.y[2] = tex.y[3];
    tex.y[0] = tex.y[3] + tex.size;
    tex.y[1] = tex.y[3] + tex.size;
    tex.pageX = (tex.packedPageCoords[0] & 31) * 16;
    tex.pageY = (tex.packedPageCoords[0] >> 6) | (tex.packedPageCoords[1] << 2);
    tex.rotation = ((tex.flags2 & 127) >> 4) & 7;
    if (gameNumber > 1) {
        if ((tex.flags2 & 128) > 0) {
            tex.transparent = 1 + ((tex.flags1 & 127) >> 5);
        } else {
            tex.transparent = 0;
        }
    }
    return tex;
}

function turn(src: Uint8Array, size: number): Uint8Array {
    const dest = new Uint8Array(src.length);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const s = (y * size + x) * 4;
            const d = (x * size + (size - 1 - y)) * 4;
            dest[d + 0] = src[s + 0];
            dest[d + 1] = src[s + 1];
            dest[d + 2] = src[s + 2];
            dest[d + 3] = src[s + 3];
        }
    }
    return dest;
}

function mirror(src: Uint8Array, size: number): Uint8Array {
    const dest = new Uint8Array(src.length);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const s = (y * size + x) * 4;
            const d = (y * size + (size - 1 - x)) * 4;
            dest[d + 0] = src[s + 0];
            dest[d + 1] = src[s + 1];
            dest[d + 2] = src[s + 2];
            dest[d + 3] = src[s + 3];
        }
    }
    return dest;
}

function flip(src: Uint8Array, size: number): Uint8Array {
    const dest = new Uint8Array(src.length);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const s = (y * size + x) * 4;
            const d = ((size - 1 - y) * size + x) * 4;
            dest[d + 0] = src[s + 0];
            dest[d + 1] = src[s + 1];
            dest[d + 2] = src[s + 2];
            dest[d + 3] = src[s + 3];
        }
    }
    return dest;
}

function applyTileRotationRGBA(rgba: Uint8Array, tex: SpyroTextureDefinition, size: number, gameNumber: number): Uint8Array {
    let rotatedRGBA = rgba;

    switch (tex.rotation) {
        case 1:
            rotatedRGBA = mirror(flip(turn(rotatedRGBA, size), size), size);
            break;
        case 2:
            if (gameNumber === 1) {
                rotatedRGBA = turn(turn(rotatedRGBA, size), size);
            } else {
                rotatedRGBA = mirror(flip(rotatedRGBA, size), size);
            }
            break;
        case 3:
            if (gameNumber === 1) {
                rotatedRGBA = mirror(flip(rotatedRGBA, size), size);
            } else {
                rotatedRGBA = turn(turn(rotatedRGBA, size), size);
            }
            break;
        case 4:
            rotatedRGBA = mirror(turn(rotatedRGBA, size), size);
            break;
        case 5:
            rotatedRGBA = mirror(rotatedRGBA, size);
            break;
        case 6:
            rotatedRGBA = flip(turn(rotatedRGBA, size), size);
            break;
        case 7:
            rotatedRGBA = flip(rotatedRGBA, size);
            break;
        default:
            break;
    }

    return rotatedRGBA;
}

function colorBitsToRGBA(word: number): [number, number, number, number] {
    return [
        (((word) & 31) * 255 / 31) | 0,
        (((word >> 5) & 31) * 255 / 31) | 0,
        (((word >> 10) & 31) * 255 / 31) | 0,
        ((word >> 15) & 1) ? 0 : 255
    ];
}

function getCLUT(vram: SpyroVRAM, px: number, py: number, n: number): [number, number, number, number][] {
    const clut: [number, number, number, number][] = [];
    for (let i = 0; i < n; i++) {
        clut.push(colorBitsToRGBA(vram.getWordByIndex((py * 512 + px) + i)));
    }
    return clut;
}

function decodeTileToRGBA(vram: SpyroVRAM, tex: SpyroTextureDefinition, width: number = tex.size, height: number = tex.size): Uint8Array {
    let startX = tex.x[3];
    const startY = tex.y[3];
    if (tex.bitDepth === 4) {
        startX = startX >> 2;
        const clut = getCLUT(vram, tex.pageX, tex.pageY, 16);
        const rgba = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width / 4; x++) {
                const word = vram.getWord(startX + x, startY + y);
                for (let nib = 0; nib < 4; nib++) {
                    const dst = (y * width + (x * 4 + nib)) * 4;
                    const [r, g, b, a] = clut[(word >> (nib * 4)) & 15];
                    rgba[dst + 0] = r;
                    rgba[dst + 1] = g;
                    rgba[dst + 2] = b;
                    rgba[dst + 3] = a;
                }
            }
        }
        return rgba;
    } else if (tex.bitDepth === 8) {
        startX = startX >> 1;
        const clut = getCLUT(vram, tex.pageX, tex.pageY, 256);
        const rgba = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width / 2; x++) {
                const word = vram.getWord(startX + x, startY + y);
                {
                    const dst = (y * width + (x * 2)) * 4;
                    const [r, g, b, a] = clut[word & 255];
                    rgba[dst + 0] = r;
                    rgba[dst + 1] = g;
                    rgba[dst + 2] = b;
                    rgba[dst + 3] = a;
                }
                {
                    const dst = (y * width + (x * 2 + 1)) * 4;
                    const [r, g, b, a] = clut[(word >> 8) & 255];
                    rgba[dst + 0] = r;
                    rgba[dst + 1] = g;
                    rgba[dst + 2] = b;
                    rgba[dst + 3] = a;
                }
            }
        }
        return rgba;
    } else {
        const rgba = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const word = vram.getWord(tex.x[3] + x, startY + y);
                const [r, g, b, a] = colorBitsToRGBA(word);
                const dst = (y * width + x) * 4;
                rgba[dst + 0] = r;
                rgba[dst + 1] = g;
                rgba[dst + 2] = b;
                rgba[dst + 3] = a;
            }
        }
        return rgba;
    }
}

function combineCorners(topLeft: Uint8Array, topRight: Uint8Array, bottomLeft: Uint8Array, bottomRight: Uint8Array, size: number): Uint8Array {
    const combined: number[] = [];
    const rowWidth = size * 4;
    for (let i = 0; i < size; i++) {
        const start = i * rowWidth;
        const end = start + rowWidth;
        combined.push(...topLeft.slice(start, end));
        combined.push(...topRight.slice(start, end));
    }
    for (let i = 0; i < size; i++) {
        const start = i * rowWidth;
        const end = start + rowWidth;
        combined.push(...bottomLeft.slice(start, end));
        combined.push(...bottomRight.slice(start, end));
    }
    return new Uint8Array(combined);
}
