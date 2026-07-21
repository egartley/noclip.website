import { vec2, vec3, vec4 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { assert } from "../util";
import { buildSpyroTile, SpyroTextureStore, SpyroTileDefinition } from "./texture";

// Credit to "Spyro World Viewer" by Kly_Men_COmpany for a majority of the data structures, reverse-engineering and parsing logic

interface SkyFace {
    indices: number[];
    colors: number[];
}

interface LevelStream {
    vertices: number[];
    colors: number[];
    uvs: number[];
    indicesGround: number[][];
    indicesTransparent: number[][];
    indicesLOD: number[][];
}

export interface SpyroDrawCall {
    tileIndex: number;
    indexOffset: number;
    indexCount: number;
    isWater: boolean;
}

export interface SpyroLevel {
    textures: SpyroTextureStore;
    game: number;
    id: number;
    vertices: Float32Array;
    colors: Float32Array;
    uvs: Float32Array;
    indicesGround: number[][];
    indicesTransparent: number[][];
    indicesLOD: number[][];
    waterIndices: number[];
};

export interface SpyroLevelData {
    vram: SpyroVRAM;
    textureHeaders: ArrayBufferSlice;
    ground: ArrayBufferSlice;
    grounds?: ArrayBufferSlice[];
    sky: ArrayBufferSlice;
    skies?: ArrayBufferSlice[];
    mobyInstances: ArrayBufferSlice;
}

export interface SpyroTextureHeader {
    mid: SpyroTileDefinition,
    cor?: SpyroTileDefinition[]
}

export interface SpyroSkybox {
    backgroundColor: number[];
    vertices: number[][];
    colors: number[][];
    faces: SkyFace[];
}

export interface SpyroMobyInstance {
    x: number;
    y: number;
    z: number;
    yaw: number;
    classId: number;
}

class PartHeader {
    x: number;
    y: number;
    z: number;
    flags: number; // presumably flags, usually is just the max u32 value
    lodVertexCount: number;
    lodColorCount: number;
    lodPolyCount: number;
    mdlVertexCount: number;
    mdlColorCount: number;
    mdlPolyCount: number;
    water: number;

    constructor(data: DataView, offs: number) {
        this.y = data.getInt16(offs, true);
        this.x = data.getInt16(offs + 2, true);
        this.z = data.getInt16(offs + 6, true);
        this.lodVertexCount = data.getUint8(offs + 8);
        this.lodColorCount = data.getUint8(offs + 9);
        this.lodPolyCount = data.getUint8(offs + 10);
        this.mdlVertexCount = data.getUint8(offs + 12);
        this.mdlColorCount = data.getUint8(offs + 13);
        this.mdlPolyCount = data.getUint8(offs + 14);
        this.water = data.getUint8(offs + 15);
        this.flags = data.getUint32(offs + 16, true);
    }
}

class LODPoly {
    vertexIndices: vec3;
    colorIndices: vec3;

    constructor(view: DataView, offset: number) {
        this.vertexIndices = vec3.fromValues(view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
        this.colorIndices = vec3.fromValues(view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7));
    }
}

class LODPoly2 {
    vertexIndices: vec4;
    colorIndices: vec4;

    constructor(view: DataView, offset: number) {
        this.vertexIndices = vec4.fromValues(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
        this.colorIndices = vec4.fromValues(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7));
    }
}

class Polygon {
    vertexIndices: vec4;
    colorIndices: vec4;
    packedTileIndex: number = 0;
    uvPermuatation: number = 0; // S1 only
    s: vec4 = vec4.create(); // S2/3 only
    ii: number = 0; // S2/3 only

    constructor(view: DataView, offset: number, gameNumber: number) {
        this.vertexIndices = vec4.fromValues(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
        this.colorIndices = vec4.fromValues(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7));
        if (gameNumber == 1) {
            this.packedTileIndex = view.getUint8(offset + 8);
            this.uvPermuatation = view.getUint8(offset + 9);
        } else {
            this.s = vec4.fromValues(view.getUint8(offset + 8), view.getUint8(offset + 9), view.getUint8(offset + 10), view.getUint8(offset + 11));
            this.packedTileIndex = view.getUint8(offset + 12) & 127;
            this.ii = view.getUint8(offset + 13);
        }
    }
}

// 512 KB and some change
const VRAM_SIZE = 524288;
const EMPTY_ARRAYBUFFERSLICE = new ArrayBufferSlice(new Uint8Array().buffer);

export class SpyroVRAM {
    private data: Uint16Array;

    constructor(buffer: ArrayBuffer) {
        this.data = new Uint16Array(buffer);
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

class Parser {
    public offset: number = 0;
    private data: DataView;

    constructor(public buffer: ArrayBufferSlice) {
        this.data = buffer.createDataView();
    }

    public getSubfile(i: number): ArrayBufferSlice {
        const ret = this.offset;
        this.offset = i * 8;
        const sf_off = this.getUint32();
        const sf_size = this.getUint32();
        let subfile;
        if (sf_off === 0 || sf_size === 0) {
            subfile = EMPTY_ARRAYBUFFERSLICE;
        } else {
            subfile = this.buffer.subarray(sf_off, sf_size);
        }
        this.offset = ret;
        return subfile;
    }

    public readSection(): ArrayBufferSlice {
        const size = this.getUint32();
        if (size === 4) {
            return EMPTY_ARRAYBUFFERSLICE;
        }
        const section = this.buffer.subarray(this.offset, size - 4);
        this.offset += size - 4;
        return section;
    }

    public skipSection() {
        const size = this.getUint32();
        this.offset += size - 4;
    }

    public skip(n: number) {
        this.offset += n;
    }

    public getInt8(): number {
        const n = this.data.getInt8(this.offset);
        this.offset += 1;
        return n;
    }

    public getUint8(): number {
        const n = this.data.getUint8(this.offset);
        this.offset += 1;
        return n;
    }

    public getUint32(): number {
        const n = this.data.getUint32(this.offset, true);
        this.offset += 4;
        return n;
    }

    public getUint32At(offset: number): number {
        return this.data.getUint32(offset, true);
    }
}

export function buildSpyroSkybox(data: DataView, gameNumber: number): SpyroSkybox {
    const backgroundColor = [data.getUint8(0), data.getUint8(1), data.getUint8(2)];
    const partCount = data.getUint32(4, true);
    let pointer = 8;
    const partOffsets: number[] = [];
    for (let i = 0; i < partCount; i++) {
        const offset = data.getUint32(pointer, true);
        pointer += 4;
        if (offset === 0 || offset >= data.byteLength) {
            break;
        }
        partOffsets.push(offset);
    }
    const vertices: number[][] = [];
    const colors: number[][] = [];
    const faces: SkyFace[] = [];
    for (const offset of partOffsets) {
        if (gameNumber == 1) {
            parseSkyboxPart(data, offset, vertices, colors, faces);
        } else {
            parseSkyboxPart2(data, offset, vertices, colors, faces);
        }
    }
    return { backgroundColor, vertices, colors, faces };
}

export function buildSpyroLevel(ground: DataView, textures: SpyroTextureStore, gameNumber: number, id: number): SpyroLevel {
    const vertices: number[] = [];
    const colors: number[] = [];
    const stream: LevelStream = {
        vertices: [], colors: [], uvs: [],
        indicesGround: [], indicesTransparent: [], indicesLOD: []
    };
    const tileCount = textures.headers.length;
    const invalidTile: boolean[] = [];
    const waterIndices: number[] = [];
    const UV = { TL: [0, 1], TR: [1, 1], BR: [1, 0], BL: [0, 0], ZERO: [0, 0] };
    let runningIndex = 0;

    for (let i = 0; i < tileCount; i++) {
        stream.indicesGround[i] = [];
        stream.indicesTransparent[i] = [];
        stream.indicesLOD[i] = [];
    }
    // band-aid solution to hide polygons that shouldn't (???) be visible if the entire texture is black
    // comment this out and then see tile 43 in the waterfall in idol springs for an example
    // these polygons are probably supposed to be invisible (e.g. zero alpha)
    for (let i = 0; i < textures.headers.length; i++) {
        let b = true;
        const rgba = textures.colors[i];
        for (let i = 0; i < rgba[0].length; i += 4) {
            if (rgba[0][i] !== 0 || rgba[0][i + 1] !== 0 || rgba[0][i + 2] !== 0) {
                b = false;
                break;
            }
        }
        invalidTile[i] = b;
    }

    let partCount = ground.getUint32(0, true);
    let offset = 4;
    const partOffsets: number[] = [];
    if (gameNumber > 1) {
        const skip = ground.getUint32(0, true);
        partCount = ground.getUint32(skip, true);
        offset = skip + 4;
        for (let i = 0; i < partCount; i++) {
            partOffsets.push(ground.getUint32(offset, true));
            offset += 4;
        }
    }

    function decodeLODPoly(poly: LODPoly | LODPoly2) {
        if (gameNumber === 1) {
            return {
                v1: (poly.vertexIndices[0] & 63),
                v2: (poly.vertexIndices[0] >> 6) | ((poly.vertexIndices[1] & 15) << 2),
                v3: (poly.vertexIndices[1] >> 4) | ((poly.vertexIndices[2] & 3) << 4),
                v4: (poly.vertexIndices[2] >> 2),
                c1: (poly.colorIndices[0] & 63),
                c2: (poly.colorIndices[0] >> 6) | ((poly.colorIndices[1] & 15) << 2),
                c3: (poly.colorIndices[1] >> 4) | ((poly.colorIndices[2] & 3) << 4),
                c4: (poly.colorIndices[2] >> 2),
            };
        } else {
            assert(poly instanceof LODPoly2);
            return {
                v1: (poly.vertexIndices[0] >> 3) | ((poly.vertexIndices[1] & 3) << 5),
                v2: (poly.vertexIndices[1] >> 2) | ((poly.vertexIndices[2] & 1) << 6),
                v3: (poly.vertexIndices[2] >> 1),
                v4: (poly.vertexIndices[3] & 127),
                c1: (poly.colorIndices[0] >> 4) | ((poly.colorIndices[1] & 7) << 4),
                c2: (poly.colorIndices[1] >> 3) | ((poly.colorIndices[2] & 3) << 5),
                c3: (poly.colorIndices[2] >> 2) | ((poly.colorIndices[3] & 1) << 6),
                c4: (poly.colorIndices[3] >> 1),
            };
        }
    }

    function pushTri(v1: number, v2: number, v3: number, c1: number, c2: number, c3: number, uv1: number[], uv2: number[], uv3: number[], tileIndex: number, opts: { isLOD: boolean; isTransparent?: boolean; isWater?: boolean }) {
        if (!opts.isLOD && invalidTile[tileIndex]) {
            return;
        }
        const group = opts.isLOD ? stream.indicesLOD : (opts.isTransparent || opts.isWater ? stream.indicesTransparent : stream.indicesGround);
        const v = [v1, v2, v3];
        const color = [c1, c2, c3];
        const uvs = [uv1, uv2, uv3];
        for (let i = 0; i < 3; i++) {
            const vi = v[i] * 3;
            const ci = color[i] * 3;
            const uv = uvs[i];
            const r = colors[ci];
            const g = colors[ci + 1];
            const b = colors[ci + 2];
            stream.vertices.push(vertices[vi], vertices[vi + 1], vertices[vi + 2]);
            stream.colors.push(r / 255, g / 255, b / 255);
            stream.uvs.push(uv[0], uv[1]);
            group[tileIndex].push(runningIndex++);
        }
    }

    function pushPoly(poly: Polygon, vertexOffset: number, colorOffset: number, waterFlag: number) {
        const tileIndex = poly.packedTileIndex & 127;
        if (tileIndex < 0 || tileIndex >= tileCount) {
            // console.warn("Out of bounds tile index for", poly, waterFlag);
            return;
        }
        const tile = textures.headers[tileIndex].mid;
        const isTransparent = tile.transparent > 0;
        const isWater = (gameNumber > 1) ? (waterFlag === 0 && poly.s[0] === 0 && poly.s[1] === 0 && poly.s[2] === 0 && poly.s[3] === 0) : false;
        const isLOD = false;
        const opts = { isLOD, isTransparent, isWater };
        const v1 = vertexOffset + poly.vertexIndices[0];
        const v2 = vertexOffset + poly.vertexIndices[1];
        const v3 = vertexOffset + poly.vertexIndices[2];
        const v4 = vertexOffset + poly.vertexIndices[3];
        const c1 = colorOffset + poly.colorIndices[0];
        const c2 = colorOffset + poly.colorIndices[1];
        const c3 = colorOffset + poly.colorIndices[2];
        const c4 = colorOffset + poly.colorIndices[3];
        let A = UV.TL, B = UV.TR, C = UV.BR, D = UV.BL;

        const isTri = poly.vertexIndices[0] === poly.vertexIndices[1];
        if (gameNumber > 1) {
            if (isTri) {
                const rr = (poly.ii >> 4) & 3;
                const rot = (tile.rotation - rr) & 3;
                const seq = [A, B, C, D];
                const rotated = [seq[(0 + rot) & 3], seq[(1 + rot) & 3], seq[(2 + rot) & 3], seq[(3 + rot) & 3]];
                [A, B, C, D] = rotated;
            }
        } else {
            if (poly.vertexIndices[0] === poly.vertexIndices[1]) {
                const base = [UV.TL, UV.TR, UV.BR, UV.BL];
                const perms = [[0, 1, 2, 3], [3, 0, 1, 2], [2, 3, 0, 1], [1, 2, 3, 0]];
                const p = perms[poly.uvPermuatation & 3];
                A = base[p[0]];
                B = base[p[1]];
                C = base[p[2]];
                D = base[p[3]];
            }
        }

        if (isTri) {
            const inverse = (gameNumber > 1) ? !!(poly.ii & 4) : false;
            if (!inverse) {
                pushTri(v2, v3, v4, c2, c3, c4, A, C, D, tileIndex, opts);
            } else {
                pushTri(v4, v3, v2, c4, c3, c2, D, C, A, tileIndex, opts);
            }
        } else {
            pushTri(v1, v2, v3, c1, c2, c3, A, B, C, tileIndex, opts);
            pushTri(v1, v3, v4, c1, c3, c4, A, C, D, tileIndex, opts);
        }

        if (isWater && !waterIndices.includes(tileIndex)) {
            waterIndices.push(tileIndex);
        }
    }

    for (let partIndex = 0; partIndex < partCount; partIndex++) {
        let pointer = 0;
        if (gameNumber === 1) {
            const o = ground.getUint32(offset, true);
            offset += 4;
            pointer = o;
        } else {
            pointer = partOffsets[partIndex];
        }
        pointer += 8;

        const header = new PartHeader(ground, pointer);
        pointer += 20;

        const lodVertexOffset = vertices.length / 3;
        for (let i = 0; i < header.lodVertexCount; i++) {
            const byte1 = ground.getUint8(pointer);
            const byte2 = ground.getUint8(pointer + 1);
            const byte3 = ground.getUint8(pointer + 2);
            const byte4 = ground.getUint8(pointer + 3);
            pointer += 4;
            const zraw = (byte1 | ((byte2 & 3) << 8));
            let z = zraw + header.z;
            if (gameNumber > 1) {
                z = (zraw << 1) + header.z;
            }
            const y = ((byte2 >> 2) | ((byte3 & 31) << 6)) + header.y;
            const x = ((byte3 >> 5) | (byte4 << 3)) + header.x;
            vertices.push(x, y, z);
        }

        const lodColorOffset = colors.length / 3;
        for (let i = 0; i < header.lodColorCount; i++) {
            const r = ground.getUint8(pointer);
            const g = ground.getUint8(pointer + 1);
            const b = ground.getUint8(pointer + 2);
            pointer += 4;
            colors.push(r, g, b);
        }

        for (let i = 0; i < header.lodPolyCount; i++) {
            const p = (gameNumber > 1) ? new LODPoly2(ground, pointer) : new LODPoly(ground, pointer);
            pointer += 8;
            const poly = decodeLODPoly(p);
            const v1 = lodVertexOffset + poly.v1;
            const v2 = lodVertexOffset + poly.v2;
            const v3 = lodVertexOffset + poly.v3;
            const v4 = lodVertexOffset + poly.v4;
            const c1 = lodColorOffset + poly.c1;
            const c2 = lodColorOffset + poly.c2;
            const c3 = lodColorOffset + poly.c3;
            const c4 = lodColorOffset + poly.c4;
            if (poly.v1 === poly.v2) {
                pushTri(v2, v3, v4, c2, c3, c4, UV.ZERO, UV.ZERO, UV.ZERO, 0, { isLOD: true });
            } else if (poly.v2 === poly.v3) {
                pushTri(v1, v3, v4, c1, c3, c4, UV.ZERO, UV.ZERO, UV.ZERO, 0, { isLOD: true });
            } else if (poly.v3 === poly.v4) {
                pushTri(v1, v2, v4, c1, c2, c4, UV.ZERO, UV.ZERO, UV.ZERO, 0, { isLOD: true });
            } else if (poly.v4 === poly.v1) {
                pushTri(v1, v2, v3, c1, c2, c3, UV.ZERO, UV.ZERO, UV.ZERO, 0, { isLOD: true });
            } else {
                pushTri(v2, v1, v3, c2, c1, c3, UV.ZERO, UV.ZERO, UV.ZERO, 0, { isLOD: true });
                pushTri(v2, v3, v4, c2, c3, c4, UV.ZERO, UV.ZERO, UV.ZERO, 0, { isLOD: true });
            }
        }

        let isWaterNonGround = false;
        if (gameNumber > 1) {
            let pos = pointer + header.mdlVertexCount * 4 + header.mdlColorCount * 4 + header.mdlColorCount * 4;
            for (let i = 0; i < header.mdlPolyCount; i++) {
                const s1 = ground.getUint8(pos + 8);
                const s2 = ground.getUint8(pos + 9);
                const s3 = ground.getUint8(pos + 10);
                const s4 = ground.getUint8(pos + 11);
                if (s1 === 0 && s2 === 0 && s3 === 0 && s4 === 0) {
                    isWaterNonGround = true;
                    break;
                }
                pos += 16;
            }
        }

        const mdlVertexOffset = vertices.length / 3;
        for (let i = 0; i < header.mdlVertexCount; i++) {
            const byte1 = ground.getUint8(pointer);
            const byte2 = ground.getUint8(pointer + 1);
            const byte3 = ground.getUint8(pointer + 2);
            const byte4 = ground.getUint8(pointer + 3);
            pointer += 4;
            const zraw = (byte1 | ((byte2 & 3) << 8));
            let z = zraw + header.z;
            if (gameNumber > 1) {
                const far = header.lodVertexCount === 0 && header.flags === 0xFFFFFFFF;
                if ((far && !isWaterNonGround) || (far && isWaterNonGround && header.water > 0) || (!far && header.water > 0)) {
                    z = (zraw << 1) + header.z;
                } else {
                    z = (zraw >> 2) + header.z;
                }
            }
            const y = ((byte2 >> 2) | ((byte3 & 31) << 6)) + header.y;
            const x = ((byte3 >> 5) | (byte4 << 3)) + header.x;
            vertices.push(x, y, z);
        }

        const mdlColorOffset = colors.length / 3;
        for (let i = 0; i < header.mdlColorCount; i++) {
            const r = ground.getUint8(pointer);
            const g = ground.getUint8(pointer + 1);
            const b = ground.getUint8(pointer + 2);
            pointer += 4;
            colors.push(r, g, b);
        }

        // these are valid colors, but appear out of order when used in place of the above colors
        // they could be colors used in place of textures for mdl parts that are a certain distance from the camera maybe?
        // (too close for lod but not close enough for textures to show)
        pointer += header.mdlColorCount * 4;

        for (let i = 0; i < header.mdlPolyCount; i++) {
            const poly = new Polygon(ground, pointer, gameNumber);
            pointer += 16;
            pushPoly(poly, mdlVertexOffset, mdlColorOffset, header.water);
        }
    }

    return {
        textures, game: gameNumber, id,
        vertices: new Float32Array(stream.vertices),
        colors: new Float32Array(stream.colors),
        uvs: new Float32Array(stream.uvs),
        indicesGround: stream.indicesGround,
        indicesTransparent: stream.indicesTransparent,
        indicesLOD: stream.indicesLOD, waterIndices
    };
}

export function parseSpyroTextureHeaders(data: DataView, gameNumber: number): SpyroTextureHeader[] {
    const count = data.getUint32(0, true);
    const headers = new Array(count);
    let offset = 4;
    if (gameNumber === 1) {
        // starts with lod-mid header pairs
        for (let i = 0; i < count; i++) {
            offset += 8; // skip lod header
            const mid = buildSpyroTile(data, offset, gameNumber);
            offset += 8;
            headers[i] = { mid, cor: [] };
        }
        // jump to high-res groups
        offset = 4 + (16 * count);
        for (let i = 0; i < count; i++) {
            offset += 8; // skip spr header
            const cor: SpyroTileDefinition[] = Array(4);
            for (let j = 0; j < 4; j++) {
                cor[j] = buildSpyroTile(data, offset, gameNumber);
                offset += 8;
            }
            offset += 8 * 16; // skip sm headers
            headers[i].cor = cor;
        }
    } else {
        // sequential headers of lod-mid-cor
        for (let i = 0; i < count; i++) {
            offset += 8; // skip lod
            const mid = buildSpyroTile(data, offset, gameNumber);
            offset += 8;
            const cor: SpyroTileDefinition[] = Array(4);
            for (let j = 0; j < 4; j++) {
                cor[j] = buildSpyroTile(data, offset, gameNumber);
                offset += 8;
            }
            headers[i] = { mid, cor };
        }
    }
    return headers;
}

export function parseSpyroMobyInstances(data: ArrayBufferSlice): SpyroMobyInstance[] {
    if (data.byteLength < 92) {
        return [];
    }

    const section = new Parser(data);
    const count = section.getUint32();
    const instances: SpyroMobyInstance[] = Array(count);
    for (let i = 0; i < count; i++) {
        section.skip(12);
        const x = section.getUint32();
        const y = section.getUint32();
        const z = section.getUint32();
        section.skip(30);
        const classId = section.getUint8();
        section.skip(15);
        const yaw = section.getInt8();
        section.skip(17);
        if (x === 0 && y === 0 && z === 0) {
            console.warn("Moby instance at origin, offset", section.offset - 88);
        }
        instances[i] = { x, y, z, yaw, classId };
    }

    return instances;
}

export function parseSpyroLevelData(data: ArrayBufferSlice, isStandard: boolean): SpyroLevelData {
    const file = new Parser(data);

    let vram;
    if (!isStandard && file.getUint32At(4) === 0) {
        // flyover levels will have smaller vram and no sound data
        // but the subfile 1 size is set to 0 for some reason, go until subfile 2 offset instead
        vram = data.subarray(file.getUint32At(0), file.getUint32At(8) - file.getUint32At(0));
    } else {
        const subfile1 = file.getSubfile(0);
        vram = subfile1.subarray(0, Math.min(VRAM_SIZE, subfile1.byteLength));
        // remainder of subfile 1 is sound data (if present)
    }

    const subfile2 = new Parser(file.getSubfile(1));
    const textureHeaders = subfile2.readSection();
    const ground = subfile2.readSection();
    if (isStandard) {
        subfile2.skipSection(); // unknown, has two sub-sections with lists of relative offsets
        subfile2.skipSection(); // unknown, can make portals in homeworlds non-enterable
        subfile2.skipSection(); // collision data
    }
    const sky = subfile2.readSection();
    if (isStandard) {
        // count of portal skyboxes
        // if > 0, homeworlds will have their portal skyboxes here
        // particle effect section
        // sound effect section
    }

    // subfile 3 is entirely moby animations (and the models themselves maybe?)
    // offsets to these are located at 0x50 and there's up to 64 of them

    const subfile4 = new Parser(file.getSubfile(3));
    let mobyInstances;
    if (isStandard) {
        subfile4.skip(136); // some sort of header
        subfile4.skipSection();
        subfile4.skipSection();
        subfile4.skipSection(); // possible moby sound data?
        subfile4.skipSection(); // possible moby sound data?
        subfile4.skipSection();
        subfile4.skipSection();
        subfile4.skipSection();
        mobyInstances = subfile4.readSection();
        // padding of 10240
        // three more unknown sections
        // another unknown section with pointers that can mess up portal text and make dragons non-replayable
    } else {
        mobyInstances = EMPTY_ARRAYBUFFERSLICE;
    }

    // any subfiles beyond 4 are related to dragon statues, majority of data is their voice lines

    return { vram: new SpyroVRAM(vram.copyToBuffer()), textureHeaders, ground, sky, mobyInstances };
}

export function parseSpyroLevelData2(data: ArrayBufferSlice, gameNumber: number, isFlyover: boolean = false): SpyroLevelData {
    const file = new Parser(data);

    const subfile1 = file.getSubfile(0);
    const vram = subfile1.subarray(0, Math.min(VRAM_SIZE, subfile1.byteLength));
    // remainder of subfile 1 is sound data (if present)

    const subfile2 = new Parser(file.getSubfile(1));
    const textureHeaders = subfile2.readSection();
    const ground = subfile2.readSection();
    subfile2.skipSection();
    subfile2.skipSection();
    if (!isFlyover) {
        if (gameNumber === 2) {
            subfile2.skipSection();
            subfile2.skipSection();
        }
        subfile2.skip(12);
        subfile2.skipSection(); // collision data
    }
    const sky = subfile2.readSection();
    if (!isFlyover) {
        // unknown section
        // particle effect section
        // unknown section
        // sound effect section
    }

    // sublevels' first subfile (up to 3)
    const grounds: ArrayBufferSlice[] = [];
    if (gameNumber === 3) {
        for (const i of [4, 6, 8]) {
            const sf = file.getSubfile(i);
            if (sf.byteLength > 0) {
                const subfile = new Parser(sf);
                subfile.skipSection();
                subfile.skip(384);
                grounds.push(subfile.readSection());
                // 3 unknown sections, then collision data
            }
        }
    }

    // sublevels' second subfile (up to 3)
    const skies: ArrayBufferSlice[] = [];
    if (gameNumber === 3) {
        for (const i of [5, 7, 9]) {
            const sf = file.getSubfile(i);
            if (sf.byteLength > 0) {
                const subfile = new Parser(sf);
                subfile.skip(48);
                const skySection = subfile.readSection();
                if (skySection.byteLength > 0) {
                    skies.push(skySection);
                }
                // 11 more unknown sections, then moby instances
            }
        }
    }

    const subfile4 = new Parser(file.getSubfile(3));
    let mobyInstances;
    if (!isFlyover) {
        subfile4.skip(gameNumber === 2 ? 44 : 48); // some sort of header
        subfile4.skipSection();
        subfile4.skipSection();
        subfile4.skipSection();
        subfile4.skipSection();
        subfile4.skipSection();
        subfile4.skipSection();
        subfile4.skipSection();
        subfile4.skipSection();
        if (gameNumber === 3) {
            subfile4.skipSection();
            subfile4.skipSection();
            subfile4.skipSection();
            subfile4.skipSection();
        }
        mobyInstances = subfile4.readSection();
        // a bunch of padding then the dialogue section
    } else {
        mobyInstances = EMPTY_ARRAYBUFFERSLICE;
    }

    return { vram: new SpyroVRAM(vram.copyToBuffer()), textureHeaders, ground, grounds, sky, skies, mobyInstances };
}

function parseSkyboxPart(data: DataView, partOffset: number, vertices: number[][], colors: number[][], faces: SkyFace[]): void {
    let pointer = partOffset;
    if (pointer + 24 > data.byteLength) {
        return;
    }
    const baseVertexIndex = vertices.length;
    const baseColorIndex = colors.length;

    // header (24)
    pointer += 8;
    const globalY = data.getInt16(pointer, true);
    const globalZ = data.getInt16(pointer + 2, true);
    const vertexCount = data.getUint16(pointer + 4, true);
    const globalX = data.getInt16(pointer + 6, true);
    const polyCount = data.getUint16(pointer + 8, true);
    const colorCount = data.getUint16(pointer + 10, true);
    pointer += 16;

    // vertices (4)
    for (let i = 0; i < vertexCount; i++) {
        if (pointer + 4 > data.byteLength) {
            break;
        }
        const b1 = data.getUint8(pointer);
        const b2 = data.getUint8(pointer + 1);
        const b3 = data.getUint8(pointer + 2);
        const b4 = data.getUint8(pointer + 3);
        vertices.push([
            ((b3 >> 5) | (b4 << 3)) + globalX,
            ((b2 >> 2) | ((b3 & 31) << 6)) - globalY,
            (b1 | ((b2 & 3) << 8)) - globalZ
        ]);
        pointer += 4;
    }

    // colors (4)
    for (let i = 0; i < colorCount; i++) {
        if (pointer + 4 > data.byteLength) {
            break;
        }
        colors.push([data.getUint8(pointer), data.getUint8(pointer + 1), data.getUint8(pointer + 2)]);
        pointer += 4;
    }

    function unpackSkyIndex(b1: number, b2: number, b3: number, b4: number): [number, number, number] {
        return [(b1 >> 2) | ((b2 & 15) << 6), (b2 >> 4) | ((b3 & 63) << 4), (b3 >> 6) | (b4 << 2)];
    }

    // polygons (8)
    for (let i = 0; i < polyCount; i++) {
        if (pointer + 8 > data.byteLength) {
            break;
        }
        const [vi1, vi2, vi3] = unpackSkyIndex(data.getUint8(pointer), data.getUint8(pointer + 1), data.getUint8(pointer + 2), data.getUint8(pointer + 3));
        const [ci1, ci2, ci3] = unpackSkyIndex(data.getUint8(pointer + 4), data.getUint8(pointer + 5), data.getUint8(pointer + 6), data.getUint8(pointer + 7));
        if (vi1 < vertexCount && vi2 < vertexCount && vi3 < vertexCount && ci1 < colorCount && ci2 < colorCount && ci3 < colorCount) {
            faces.push({
                indices: [baseVertexIndex + vi1, baseVertexIndex + vi2, baseVertexIndex + vi3],
                colors: [baseColorIndex + ci1, baseColorIndex + ci2, baseColorIndex + ci3,]
            });
        }
        pointer += 8;
    }
}

function parseSkyboxPart2(data: DataView, partOffset: number, vertices: number[][], colors: number[][], faces: SkyFace[]): void {
    let pointer = partOffset;
    const baseVertexIndex = vertices.length;
    const baseColorIndex = colors.length;

    // header (20)
    if (pointer + 20 > data.byteLength) {
        return;
    }
    pointer += 8;
    const globalY = data.getInt16(pointer, true);
    const globalZ = data.getInt16(pointer + 2, true);
    const vertexCount = data.getUint8(pointer + 4);
    const colorCount = data.getUint8(pointer + 5);
    const globalX = data.getInt16(pointer + 6, true);
    const polyCount = data.getUint16(pointer + 10, true);
    pointer += 12;

    // vertices (4)
    for (let i = 0; i < vertexCount; i++) {
        const b1 = data.getUint8(pointer);
        const b2 = data.getUint8(pointer + 1);
        const b3 = data.getUint8(pointer + 2);
        const b4 = data.getUint8(pointer + 3);
        vertices.push([
            ((b3 >> 5) | (b4 << 3)) + globalX,
            ((b2 >> 2) | ((b3 & 31) << 6)) - globalY,
            (b1 | ((b2 & 3) << 8)) - globalZ
        ]);
        pointer += 4;
    }

    // colors (4)
    for (let i = 0; i < colorCount; i++) {
        colors.push([data.getUint8(pointer), data.getUint8(pointer + 1), data.getUint8(pointer + 2)]);
        pointer += 4;
    }

    // polys
    let seeker = pointer + polyCount;
    for (let i = polyCount; i > 3; i -= 4) {
        if (pointer + 4 > data.byteLength) {
            return;
        }
        const b1 = data.getUint8(pointer);
        const b2 = data.getUint8(pointer + 1);
        const b3 = data.getUint8(pointer + 2);
        let c0 = (b1 >> 3) | ((b2 & 3) << 5);
        let c1 = (b2 >> 2) | ((b3 & 1) << 6);
        let c2 = b3 >> 1;
        let v0 = data.getUint8(pointer + 3);
        pointer += 4;

        if (seeker + 2 > data.byteLength) {
            return;
        }
        let v1 = data.getUint8(seeker);
        const v2 = data.getUint8(seeker + 1);
        seeker += 2;

        let v3Base = v0;
        let c3Base = c0;

        faces.push({
            indices: [baseVertexIndex + v0, baseVertexIndex + v1, baseVertexIndex + v2],
            colors: [baseColorIndex + c0, baseColorIndex + c1, baseColorIndex + c2]
        });

        for (let i = 0; i < (b1 & 7); i++) {
            if (seeker + 2 > data.byteLength) {
                return;
            }
            const v2New = data.getUint8(seeker);
            const cm = data.getUint8(seeker + 1);
            const c2New = cm & 127;
            faces.push({
                indices: [baseVertexIndex + v0, baseVertexIndex + v1, baseVertexIndex + v2New],
                colors: [baseColorIndex + c0, baseColorIndex + c1, baseColorIndex + c2New]
            });
            if ((cm & 128) > 0) {
                v1 = v3Base;
                c1 = c3Base;
            }
            v3Base = v2New;
            c3Base = c2New;
            v0 = v2New;
            c0 = c2New;
            seeker += 2;
        }
    }
}
