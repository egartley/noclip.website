import { vec3, vec4 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { assert } from "../util";
import { buildSpyroTile, SpyroTextures, SpyroTileDefinition } from "./texture";

// Credit to "Spyro World Viewer" by Kly_Men_COmpany for the initial parsing and reverse-engineering work
// Further enhancements, additions and fixes are wholly original

export interface SpyroLevel {
    textures: SpyroTextures;
    gameNumber: number;
    id: number;
    parts: SpyroGroundPart[];
};

export interface SpyroGroundPart {
    vlut: number[][];
    clut: number[][];
    vlutLOD: number[][];
    clutLOD: number[][];
    polygons: GroundPolygon[];
    polygonsLOD: GroundPolygon[];
}

interface GroundPolygon {
    vertices: Uint32Array;
    colors: Uint32Array;
    uvs: number[][];
    textureIndex: number;
}

export interface SpyroLevelData {
    vram: SpyroVRAM;
    textureTable: ArrayBufferSlice;
    ground: ArrayBufferSlice;
    sky: ArrayBufferSlice;
    mobyInstances: ArrayBufferSlice;
}

export interface SpyroTextureHeader {
    mid: SpyroTileDefinition,
    cor?: SpyroTileDefinition[]
}

export interface SpyroSkybox {
    backgroundColor: number[];
    parts: SkyboxPart[];
}

interface SkyboxPart {
    vlut: number[][];
    clut: number[][];
    polygons: SkyPolygon[];
}

interface SkyPolygon {
    vertices: Uint32Array;
    colors: Uint32Array;
}

export interface SpyroMobyInstance {
    x: number;
    y: number;
    z: number;
    yaw: number;
    classId: number;
}

class GroundPartHeader {
    x: number;
    y: number;
    z: number;
    lodVertexCount: number;
    lodColorCount: number;
    lodPolyCount: number;
    mdlVertexCount: number;
    mdlColorCount: number;
    mdlPolyCount: number;
    water: number;
    flags: number; // presumably flags, usually is just the max u32 value

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

const VRAM_SIZE = 524288;
const UV_PERMS = { TL: [0, 1], TR: [1, 1], BR: [1, 0], BL: [0, 0], ZERO: [0, 0] };
const S2_MDL_BASE = [UV_PERMS.TL, UV_PERMS.TR, UV_PERMS.BR, UV_PERMS.BL];
const S2_MDL_PERMS = [[0, 1, 2, 3], [3, 0, 1, 2], [2, 3, 0, 1], [1, 2, 3, 0]];
const EMPTY_ARRAYBUFFERSLICE = new ArrayBufferSlice(new Uint8Array().buffer);

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
        if (size <= 8 && size >= 4) {
            // "empty" sections will be just the size itself or size + 4 padding bytes
            this.offset += size - 4;
            return EMPTY_ARRAYBUFFERSLICE;
        } else if (size > 8) {
            const section = this.buffer.subarray(this.offset, size - 4);
            this.offset += size - 4;
            return section;
        } else {
            console.warn("Section size too small. Hexpat is wrong!", `${size} at 0x${this.offset - 4}`);
            return EMPTY_ARRAYBUFFERSLICE;
        }
    }

    public skipSection() {
        const size = this.getUint32();
        if (size < 4) {
            console.warn("Section size too small. Further problems may occur...", `${size} at 0x${this.offset - 4}`);
        }
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

function unpackSkyIndices(b1: number, b2: number, b3: number, b4: number): [number, number, number] {
    return [(b1 >> 2) | ((b2 & 15) << 6), (b2 >> 4) | ((b3 & 63) << 4), (b3 >> 6) | (b4 << 2)];
}

function unpackGroundLODIndices(v: number[], c: number[], gameNumber: number) {
    if (gameNumber === 1) {
        assert(v.length === 3);
        assert(c.length === 3);
        return {
            v1: (v[0] & 63),
            v2: (v[0] >> 6) | ((v[1] & 15) << 2),
            v3: (v[1] >> 4) | ((v[2] & 3) << 4),
            v4: (v[2] >> 2),
            c1: (c[0] & 63),
            c2: (c[0] >> 6) | ((c[1] & 15) << 2),
            c3: (c[1] >> 4) | ((c[2] & 3) << 4),
            c4: (c[2] >> 2),
        };
    } else {
        assert(v.length === 4);
        assert(c.length === 4);
        return {
            v1: (v[0] >> 3) | ((v[1] & 3) << 5),
            v2: (v[1] >> 2) | ((v[2] & 1) << 6),
            v3: (v[2] >> 1),
            v4: (v[3] & 127),
            c1: (c[0] >> 4) | ((c[1] & 7) << 4),
            c2: (c[1] >> 3) | ((c[2] & 3) << 5),
            c3: (c[2] >> 2) | ((c[3] & 1) << 6),
            c4: (c[3] >> 1),
        };
    }
}

function buildSkyboxPart(data: DataView, offset: number): SkyboxPart {
    let pointer = offset;
    const vlut: number[][] = [];
    const clut: number[][] = [];

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
        const b1 = data.getUint8(pointer);
        const b2 = data.getUint8(pointer + 1);
        const b3 = data.getUint8(pointer + 2);
        const b4 = data.getUint8(pointer + 3);
        vlut.push([
            ((b3 >> 5) | (b4 << 3)) + globalX,
            ((b2 >> 2) | ((b3 & 31) << 6)) - globalY,
            (b1 | ((b2 & 3) << 8)) - globalZ
        ]);
        pointer += 4;
    }

    // colors (4)
    for (let i = 0; i < colorCount; i++) {
        clut.push([data.getUint8(pointer), data.getUint8(pointer + 1), data.getUint8(pointer + 2)]);
        pointer += 4;
    }

    // polygons (8)
    const polygons: SkyPolygon[] = Array(polyCount);
    for (let i = 0; i < polyCount; i++) {
        const [vi1, vi2, vi3] = unpackSkyIndices(data.getUint8(pointer), data.getUint8(pointer + 1), data.getUint8(pointer + 2), data.getUint8(pointer + 3));
        const [ci1, ci2, ci3] = unpackSkyIndices(data.getUint8(pointer + 4), data.getUint8(pointer + 5), data.getUint8(pointer + 6), data.getUint8(pointer + 7));
        polygons[i] = { vertices: new Uint32Array([vi1, vi2, vi3]), colors: new Uint32Array([ci1, ci2, ci3]) };
        pointer += 8;
    }

    return { vlut, clut, polygons };
}

function buildSkyboxPart2(data: DataView, partOffset: number): SkyboxPart {
    let pointer = partOffset;
    const vlut: number[][] = [];
    const clut: number[][] = [];
    const polygons: SkyPolygon[] = [];

    // header (20)
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
        vlut.push([
            ((b3 >> 5) | (b4 << 3)) + globalX,
            ((b2 >> 2) | ((b3 & 31) << 6)) - globalY,
            (b1 | ((b2 & 3) << 8)) - globalZ
        ]);
        pointer += 4;
    }

    // colors (4)
    for (let i = 0; i < colorCount; i++) {
        clut.push([data.getUint8(pointer), data.getUint8(pointer + 1), data.getUint8(pointer + 2)]);
        pointer += 4;
    }

    // polys (variable size, at least 4)
    let seeker = pointer + polyCount; 
    for (let i = polyCount; i > 3; i -= 4) {
        const b1 = data.getUint8(pointer);
        const b2 = data.getUint8(pointer + 1);
        const b3 = data.getUint8(pointer + 2);
        let c0 = (b1 >> 3) | ((b2 & 3) << 5);
        let c1 = (b2 >> 2) | ((b3 & 1) << 6);
        let c2 = b3 >> 1;
        let v0 = data.getUint8(pointer + 3);
        pointer += 4;

        let v1 = data.getUint8(seeker);
        const v2 = data.getUint8(seeker + 1);
        seeker += 2;

        polygons.push({ vertices: new Uint32Array([v0, v1, v2]), colors: new Uint32Array([c0, c1, c2]) });

        let v3Base = v0;
        let c3Base = c0;
        for (let i = 0; i < (b1 & 7); i++) {
            const v2New = data.getUint8(seeker);
            const cm = data.getUint8(seeker + 1);
            const c2New = cm & 127;

            polygons.push({ vertices: new Uint32Array([v0, v1, v2New]), colors: new Uint32Array([c0, c1, c2New]) });

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

    return { vlut, clut, polygons };
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
    const parts: SkyboxPart[] = Array(partOffsets.length);
    for (let i = 0; i < partOffsets.length; i++) {
        if (gameNumber == 1) {
            parts[i] = buildSkyboxPart(data, partOffsets[i]);
        } else {
            parts[i] = buildSkyboxPart2(data, partOffsets[i]);
        }
    }
    return { backgroundColor, parts };
}

export function buildSpyroLevel(data: DataView, textures: SpyroTextures, gameNumber: number, id: number): SpyroLevel {
    let partCount = data.getUint32(0, true);
    let offset = 4;
    const partOffsets: number[] = [];
    if (gameNumber > 1) {
        const skip = data.getUint32(0, true);
        partCount = data.getUint32(skip, true);
        offset = skip + 4;
    }
    for (let i = 0; i < partCount; i++) {
        partOffsets.push(data.getUint32(offset, true));
        offset += 4;
    }

    const parts: SpyroGroundPart[] = [];
    for (let i = 0; i < partCount; i++) {
        const vlut: number[][] = [];
        const clut: number[][] = [];
        const vlutLOD: number[][] = [];
        const clutLOD: number[][] = [];
        const polygons: GroundPolygon[] = [];
        const polygonsLOD: GroundPolygon[] = [];

        offset = partOffsets[i];

        // header (28)
        offset += 8;
        const header = new GroundPartHeader(data, offset);
        offset += 20;

        // LOD vertices (4)
        for (let j = 0; j < header.lodVertexCount; j++) {
            const byte1 = data.getUint8(offset);
            const byte2 = data.getUint8(offset + 1);
            const byte3 = data.getUint8(offset + 2);
            const byte4 = data.getUint8(offset + 3);
            offset += 4;

            const zRaw = (byte1 | ((byte2 & 3) << 8));
            let z = zRaw + header.z;
            if (gameNumber > 1) {
                z = (zRaw << 1) + header.z;
            }
            const y = ((byte2 >> 2) | ((byte3 & 31) << 6)) + header.y;
            const x = ((byte3 >> 5) | (byte4 << 3)) + header.x;
            vlutLOD.push([x, y, z]);
        }

        // LOD colors (4)
        for (let j = 0; j < header.lodColorCount; j++) {
            const r = data.getUint8(offset);
            const g = data.getUint8(offset + 1);
            const b = data.getUint8(offset + 2);
            offset += 4;
            clutLOD.push([r, g, b]);
        }

        // LOD polys (8)
        for (let j = 0; j < header.lodPolyCount; j++) {
            let vertexIndices;
            let colorIndices;
            if (gameNumber === 1) {
                vertexIndices = [data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3)];
                colorIndices = [data.getUint8(offset + 5), data.getUint8(offset + 6), data.getUint8(offset + 7)];
            } else {
                vertexIndices = [data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3)];
                colorIndices = [data.getUint8(offset + 4), data.getUint8(offset + 5), data.getUint8(offset + 6), data.getUint8(offset + 7)];
            }
            offset += 8;

            const poly = unpackGroundLODIndices(vertexIndices, colorIndices, gameNumber);
            if (poly.v1 === poly.v2) {
                polygonsLOD.push(
                    {
                        vertices: new Uint32Array([poly.v2, poly.v3, poly.v4]),
                        colors: new Uint32Array([poly.c2, poly.c3, poly.c4]),
                        uvs: [UV_PERMS.ZERO, UV_PERMS.ZERO, UV_PERMS.ZERO], textureIndex: 0
                    }
                );
            } else if (poly.v2 === poly.v3) {
                polygonsLOD.push(
                    {
                        vertices: new Uint32Array([poly.v1, poly.v3, poly.v4]),
                        colors: new Uint32Array([poly.c1, poly.c3, poly.c4]),
                        uvs: [UV_PERMS.ZERO, UV_PERMS.ZERO, UV_PERMS.ZERO], textureIndex: 0
                    }
                );
            } else if (poly.v3 === poly.v4) {
                polygonsLOD.push(
                    {
                        vertices: new Uint32Array([poly.v1, poly.v2, poly.v4]),
                        colors: new Uint32Array([poly.c1, poly.c2, poly.c4]),
                        uvs: [UV_PERMS.ZERO, UV_PERMS.ZERO, UV_PERMS.ZERO], textureIndex: 0
                    }
                );
            } else if (poly.v4 === poly.v1) {
                polygonsLOD.push(
                    {
                        vertices: new Uint32Array([poly.v1, poly.v2, poly.v3]),
                        colors: new Uint32Array([poly.c1, poly.c2, poly.c3]),
                        uvs: [UV_PERMS.ZERO, UV_PERMS.ZERO, UV_PERMS.ZERO], textureIndex: 0
                    }
                );
            } else {
                polygonsLOD.push(
                    {
                        vertices: new Uint32Array([poly.v2, poly.v1, poly.v3]),
                        colors: new Uint32Array([poly.c2, poly.c1, poly.c3]),
                        uvs: [UV_PERMS.ZERO, UV_PERMS.ZERO, UV_PERMS.ZERO], textureIndex: 0
                    }
                );
                polygonsLOD.push(
                    {
                        vertices: new Uint32Array([poly.v2, poly.v3, poly.v4]),
                        colors: new Uint32Array([poly.c2, poly.c3, poly.c4]),
                        uvs: [UV_PERMS.ZERO, UV_PERMS.ZERO, UV_PERMS.ZERO], textureIndex: 0
                    }
                );
            }
        }

        let isWaterNonGround = false;
        if (gameNumber > 1) {
            let pos = offset + header.mdlVertexCount * 4 + header.mdlColorCount * 4 + header.mdlColorCount * 4;
            for (let i = 0; i < header.mdlPolyCount; i++) {
                const s1 = data.getUint8(pos + 8);
                const s2 = data.getUint8(pos + 9);
                const s3 = data.getUint8(pos + 10);
                const s4 = data.getUint8(pos + 11);
                if (s1 === 0 && s2 === 0 && s3 === 0 && s4 === 0) {
                    isWaterNonGround = true;
                    break;
                }
                pos += 16;
            }
        }

        // MDL vertices (4)
        for (let j = 0; j < header.mdlVertexCount; j++) {
            const byte1 = data.getUint8(offset);
            const byte2 = data.getUint8(offset + 1);
            const byte3 = data.getUint8(offset + 2);
            const byte4 = data.getUint8(offset + 3);
            offset += 4;
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
            vlut.push([x, y, z]);
        }

        // MDL colors (4)
        for (let j = 0; j < header.mdlColorCount; j++) {
            const r = data.getUint8(offset);
            const g = data.getUint8(offset + 1);
            const b = data.getUint8(offset + 2);
            offset += 4;
            clut.push([r, g, b]);
        }

        // MID colors (4)
        // these are used in the game when blending between MDL and LOD, unused for now
        offset += header.mdlColorCount * 4;

        // MDL polys (16)
        for (let j = 0; j < header.mdlPolyCount; j++) {
            let v = vec4.fromValues(data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3));
            let c = vec4.fromValues(data.getUint8(offset + 4), data.getUint8(offset + 5), data.getUint8(offset + 6), data.getUint8(offset + 7));
            let packedTileIndex;
            let uvPerm, ii;
            if (gameNumber == 1) {
                packedTileIndex = data.getUint8(offset + 8);
                uvPerm = data.getUint8(offset + 9);
            } else {
                // s = vec4.fromValues(data.getUint8(offset + 8), data.getUint8(offset + 9), data.getUint8(offset + 10), data.getUint8(offset + 11));
                packedTileIndex = data.getUint8(offset + 12) & 127;
                ii = data.getUint8(offset + 13);
            }
            offset += 16;

            const textureIndex = packedTileIndex & 127;
            if (textureIndex < 0 || textureIndex >= textures.headers.length) {
                // console.warn("Out of bounds tile index for", poly, textureIndex);
                continue;
            }
            const tile = textures.headers[textureIndex].mid;
            let A = UV_PERMS.TL, B = UV_PERMS.TR, C = UV_PERMS.BR, D = UV_PERMS.BL;

            const isTriangle = v[0] === v[1];
            if (gameNumber > 1) {
                if (isTriangle) {
                    const rr = (ii! >> 4) & 3;
                    const rot = (tile.rotation - rr) & 3;
                    const seq = [A, B, C, D];
                    const rotated = [seq[(0 + rot) & 3], seq[(1 + rot) & 3], seq[(2 + rot) & 3], seq[(3 + rot) & 3]];
                    [A, B, C, D] = rotated;
                }
            } else if (v[0] === v[1]) {
                const p = S2_MDL_PERMS[uvPerm! & 3];
                A = S2_MDL_BASE[p[0]];
                B = S2_MDL_BASE[p[1]];
                C = S2_MDL_BASE[p[2]];
                D = S2_MDL_BASE[p[3]];
            }

            if (isTriangle) {
                const inverse = (gameNumber > 1) ? !!(ii! & 4) : false;
                if (!inverse) {
                    polygons.push(
                        {
                            vertices: new Uint32Array([v[1], v[2], v[3]]),
                            colors: new Uint32Array([c[1], c[2], c[3]]),
                            uvs: [A, C, D], textureIndex
                        }
                    );
                } else {
                    polygons.push(
                        {
                            vertices: new Uint32Array([v[3], v[2], v[1]]),
                            colors: new Uint32Array([c[3], c[2], c[1]]),
                            uvs: [D, C, A], textureIndex
                        }
                    );
                }
            } else {
                polygons.push(
                    {
                        vertices: new Uint32Array([v[0], v[1], v[2]]),
                        colors: new Uint32Array([c[0], c[1], c[2]]),
                        uvs: [A, B, C], textureIndex
                    }
                );
                polygons.push(
                    {
                        vertices: new Uint32Array([v[0], v[2], v[3]]),
                        colors: new Uint32Array([c[0], c[2], c[3]]),
                        uvs: [A, C, D], textureIndex
                    }
                );
            }
        }

        parts[i] = { vlut, clut, vlutLOD, clutLOD, polygons, polygonsLOD };
    }

    return { textures, gameNumber, id, parts };
}

export function parseSpyroTextureTable(data: DataView, gameNumber: number): SpyroTextureHeader[] {
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
        // but the subfile 1 size is set to 0 sometimes for some reason (???), use the subfile 2 offset to determine size
        vram = data.subarray(file.getUint32At(0), file.getUint32At(8) - file.getUint32At(0));
    } else {
        const subfile1 = file.getSubfile(0);
        vram = subfile1.subarray(0, Math.min(VRAM_SIZE, subfile1.byteLength));
        // remainder of subfile 1 is sound data (if present)
    }

    const subfile2 = new Parser(file.getSubfile(1));
    const textureTable = subfile2.readSection();
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

    return { vram: new SpyroVRAM(vram), textureTable, ground, sky, mobyInstances };
}

export function parseSpyroLevelData2(data: ArrayBufferSlice, gameNumber: number, levelNumber: number, isFlyover: boolean = false): SpyroLevelData {
    const file = new Parser(data);

    const subfile1 = file.getSubfile(0);
    const vram = subfile1.subarray(0, Math.min(VRAM_SIZE, subfile1.byteLength));
    // remainder of subfile 1 is sound data (if present)

    let ground = EMPTY_ARRAYBUFFERSLICE;
    let sky = EMPTY_ARRAYBUFFERSLICE;
    let mobyInstances = EMPTY_ARRAYBUFFERSLICE;

    const subfile2 = new Parser(file.getSubfile(1));
    const textureTable = subfile2.readSection();
    if (levelNumber === 0) {
        ground = subfile2.readSection();
    } else {
        // sublevel is specified, don't bother reading parent ground
        subfile2.skipSection();
    }
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
    sky = subfile2.readSection();
    // some other stuff like particle and sound effects, egg names in s3

    // sublevels' first subfile (up to 3)
    if (gameNumber === 3 && levelNumber > 0) {
        const i = [4, 6, 8][levelNumber - 1];
        const sf = file.getSubfile(i);
        if (sf.byteLength > 0) {
            const subfile = new Parser(sf);
            subfile.skipSection();
            subfile.skip(384);
            ground = subfile.readSection();
            // 3 unknown sections, then collision data
        } else {
            console.warn("Could not find first subfile for sublevel", levelNumber);
        }
    }

    // sublevels' second subfile (up to 3)
    if (gameNumber === 3 && levelNumber > 0) {
        const i = [5, 7, 9][levelNumber - 1];
        const sf = file.getSubfile(i);
        if (sf.byteLength > 0) {
            const subfile = new Parser(sf);
            subfile.skip(48);
            const skySection = subfile.readSection();
            if (skySection.byteLength > 8) {
                sky = skySection;
            } else {
                // most sublevels use will their parent's skybox
            }
            subfile.skipSection();
            subfile.skipSection();
            subfile.skipSection();
            subfile.skipSection();
            subfile.skipSection();
            subfile.skipSection();
            subfile.skipSection();
            subfile.skipSection(); // help text
            subfile.skipSection();
            subfile.skipSection();
            subfile.skipSection();
            mobyInstances = subfile.readSection();
        } else {
            console.warn("Could not find second subfile for sublevel", levelNumber);
        }
    }

    // always read for s2 and only for s3 if not a sublevel
    if (gameNumber === 2 || (gameNumber === 3 && levelNumber === 0)) {
        const subfile4 = new Parser(file.getSubfile(3));
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
                subfile4.skipSection(); // help text
                subfile4.skipSection();
                subfile4.skipSection();
                subfile4.skipSection();
            }
            mobyInstances = subfile4.readSection();
            // a bunch of padding then the dialogue section
        } else {
            mobyInstances = EMPTY_ARRAYBUFFERSLICE;
        }
    }

    return { vram: new SpyroVRAM(vram), textureTable, ground, sky, mobyInstances };
}
