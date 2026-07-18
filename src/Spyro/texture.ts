import { vec2, vec4 } from "gl-matrix";
import { SpyroVRAM } from "./bin";

export interface SpyroTextureStore {
    colors: Uint8Array[][];
    headers: TextureHeader[];
}

interface TextureHeader {
    mid: TileDefinition,
    cor?: TileDefinition[]
}

class TileDefinition {
    baseX: number;
    baseY: number;
    packedPageCoords: vec2;
    xx: number;
    yy: number;
    flags1: number;
    flags2: number;
    pageX: number = 0;
    pageY: number = 0;
    bitDepth: 4 | 8 | 15 = 4;
    size: number = 32;
    rotation: number = 0;
    shift: number = 0;
    transparent: number = 0;
    x: vec4 = vec4.create();
    y: vec4 = vec4.create();

    constructor(data: DataView, offset: number) {
        this.baseX = data.getUint8(offset);
        this.baseY = data.getUint8(offset + 1);
        this.packedPageCoords = vec2.fromValues(data.getUint8(offset + 2), data.getUint8(offset + 3));
        this.xx = data.getUint8(offset + 4);
        this.yy = data.getUint8(offset + 5);
        this.flags1 = data.getUint8(offset + 6);
        this.flags2 = data.getUint8(offset + 7);
    }
}

// temp manual workaround for cor tiles in s3 sublevels with "missing" vram data
const S3_SUBLEVEL_INVALID_COR_TILES: Map<number, number[]> = new Map([
    [122, [3, 4, 5, 6, 77, 78]],
    [124, [10, 15, 16, 67]],
    [140, [60, 71, 78]],
    [156, [0]],
    [170, [1, 21, 22, 65]]
]);

export function parseSpyroTextures(vram: SpyroVRAM, textureHeaders: DataView, gameNumber: number, levelId: number = -1): SpyroTextureStore {
    const headers = parseTextureHeaders(textureHeaders, gameNumber);
    const colors: Uint8Array[][] = Array(headers.length);
    for (let i = 0; i < headers.length; i++) {
        let doCOR = true;
        if (gameNumber === 3 && S3_SUBLEVEL_INVALID_COR_TILES.has(levelId)) {
            doCOR = !S3_SUBLEVEL_INVALID_COR_TILES.get(levelId)!.includes(i);
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

function applyTileRotationRGBA(rgba: Uint8Array, tile: TileDefinition, size: number, gameNumber: number): Uint8Array {
    let rotatedRGBA = rgba;

    switch (tile.rotation) {
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

function decodeTileToRGBA(vram: SpyroVRAM, tile: TileDefinition, width: number = tile.size, height: number = tile.size): Uint8Array {
    let startX = tile.x[3];
    const startY = tile.y[3];
    if (tile.bitDepth === 4) {
        startX = startX >> 2;
        const clut = getCLUT(vram, tile.pageX, tile.pageY, 16);
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
    } else if (tile.bitDepth === 8) {
        startX = startX >> 1;
        const clut = getCLUT(vram, tile.pageX, tile.pageY, 256);
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
                const word = vram.getWord(tile.x[3] + x, startY + y);
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

function parseTextureHeaders(data: DataView, gameNumber: number): TextureHeader[] {
    const count = data.getUint32(4, true);
    const headers = new Array(count);
    let offset = 8;
    if (gameNumber === 1) {
        // starts with lod-mid header pairs
        for (let i = 0; i < count; i++) {
            offset += 8; // skip lod header (it's always the same???)
            const mid = parseTile(data, offset, gameNumber);
            offset += 8;
            headers[i] = { mid, cor: [] };
        }
        // jump to high-res groups
        offset = 8 + (16 * count);
        for (let i = 0; i < count; i++) {
            offset += 8; // skip "spr" header
            const cor: TileDefinition[] = Array(4);
            for (let j = 0; j < 4; j++) {
                cor[j] = parseTile(data, offset, gameNumber);
                offset += 8;
            }
            offset += 8 * 16; // skip "sm" headers, same as cor?
            headers[i].cor = cor;
        }
    } else {
        // sequential headers of lod-mid-cor
        for (let i = 0; i < count; i++) {
            offset += 8; // skip lod
            const mid = parseTile(data, offset, gameNumber);
            offset += 8;
            const cor: TileDefinition[] = Array(4);
            for (let j = 0; j < 4; j++) {
                cor[j] = parseTile(data, offset, gameNumber);
                offset += 8;
            }
            headers[i] = { mid, cor };
        }
    }
    return headers;
}

function parseTile(data: DataView, offset: number, gameNumber: number): TileDefinition {
    const tile = new TileDefinition(data, offset);
    if (gameNumber === 1) {
        if ((tile.flags2 & 128) > 0) {
            tile.size = 32;
        } else {
            tile.size = 16;
        }
    }
    if ((tile.flags2 & 1) > 0) {
        tile.bitDepth = 15;
    } else if ((tile.flags1 & 128) > 0) {
        tile.bitDepth = 8;
    } else {
        tile.bitDepth = 4;
    }
    tile.shift = tile.flags1 & 7;
    switch (tile.bitDepth) {
        case 4:
            tile.shift *= 256;
            break;
        case 8:
            tile.shift *= 128;
            break;
        case 15:
            tile.shift *= 64;
            break;
    }
    tile.x[3] = tile.baseX + tile.shift;
    tile.x[2] = tile.xx + tile.shift;
    tile.x[0] = tile.x[3];
    tile.x[1] = tile.x[3] + tile.size;
    tile.y[3] = tile.baseY;
    if ((tile.flags1 & 16) > 0) {
        tile.y[3] += 256;
    }
    tile.y[2] = tile.y[3];
    tile.y[0] = tile.y[3] + tile.size;
    tile.y[1] = tile.y[3] + tile.size;
    tile.pageX = (tile.packedPageCoords[0] & 31) * 16;
    tile.pageY = (tile.packedPageCoords[0] >> 6) | (tile.packedPageCoords[1] << 2);
    tile.rotation = ((tile.flags2 & 127) >> 4) & 7;
    if (gameNumber > 1) {
        if ((tile.flags2 & 128) > 0) {
            tile.transparent = 1 + ((tile.flags1 & 127) >> 5);
        } else {
            tile.transparent = 0;
        }
    }
    return tile;
}
