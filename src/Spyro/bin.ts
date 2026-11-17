import ArrayBufferSlice from "../ArrayBufferSlice";
import { SpyroBlendMode, SpyroRawTexture, SpyroVRAM } from "./texture";

// Credit to "Spyro World Viewer" by Kly_Men_COmpany for the initial parsing and reverse-engineering work

interface Polygon {
    vertices: number[];
    colors: number[];
}

interface SkyboxPart {
    vlut: number[][];
    clut: number[][];
    polygons: Polygon[];
}

export interface SpyroLevel {
    textures: SpyroRawTexture[];
    gameNumber: number;
    id: number;
    parts: SpyroGroundPart[];
}

export interface SpyroGroundPart {
    vlut: number[][];
    clut: number[][];
    vlutLOD: number[][];
    clutLOD: number[][];
    polygons: SpyroMDLPolygon[];
    polygonsLOD: Polygon[];
}

export interface SpyroMDLPolygon extends Polygon {
    uvs: number[][];
    textureIndex: number;
    isWater: boolean;
    blendMode: SpyroBlendMode;
}

export interface SpyroLevelData {
    vram: SpyroVRAM;
    textureTable: ArrayBufferSlice;
    ground: ArrayBufferSlice;
    sky: ArrayBufferSlice;
    mobyInstances: ArrayBufferSlice;
}

export interface SpyroSkybox {
    backgroundColor: number[];
    parts: SkyboxPart[];
}

export interface SpyroMobyInstance {
    x: number;
    y: number;
    z: number;
    yaw: number;
    classId: number;
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

const VRAM_SIZE = 524288;
const EMPTY_ARRAYBUFFERSLICE = new ArrayBufferSlice(new Uint8Array().buffer);
const UV_CORNERS = [[0, 1], [1, 1], [1, 0], [0, 0]]; // TL, TR, BR, BL
const UV_ROTATIONS = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((j) => UV_CORNERS[(j + r) & 3]));

function readGroundPartHeader(data: DataView, offs: number) {
    return {
        y: data.getInt16(offs, true),
        x: data.getInt16(offs + 2, true),
        z: data.getInt16(offs + 6, true),
        lodVertexCount: data.getUint8(offs + 8),
        lodColorCount: data.getUint8(offs + 9),
        lodPolyCount: data.getUint8(offs + 10),
        mdlVertexCount: data.getUint8(offs + 12),
        mdlColorCount: data.getUint8(offs + 13),
        mdlPolyCount: data.getUint8(offs + 14),
        water: data.getUint8(offs + 15),
        flags: data.getUint32(offs + 16, true) // presumably flags, usually is just the max u32 value
    };
}

function readVertices(data: DataView, offset: number, count: number, origin: number[], zScale = 1): number[][] {
    const vertices: number[][] = Array(count);
    for (let i = 0; i < count; i++, offset += 4) {
        const b1 = data.getUint8(offset);
        const b2 = data.getUint8(offset + 1);
        const b3 = data.getUint8(offset + 2);
        const b4 = data.getUint8(offset + 3);
        vertices[i] = [
            ((b3 >> 5) | (b4 << 3)) + origin[0],
            ((b2 >> 2) | ((b3 & 31) << 6)) + origin[1],
            Math.floor((b1 | ((b2 & 3) << 8)) * zScale) + origin[2]
        ];
    }
    return vertices;
}

function readColors(data: DataView, offset: number, count: number): number[][] {
    const colors: number[][] = Array(count);
    for (let i = 0; i < count; i++, offset += 4) {
        colors[i] = [data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2)];
    }
    return colors;
}

function getPolygon(v: number[], c: number[], i0: number, i1: number, i2: number): Polygon {
    return { vertices: [v[i0], v[i1], v[i2]], colors: [c[i0], c[i1], c[i2]] };
}

function isWaterPolygon(data: DataView, polyOffset: number): boolean {
    // heuristic for water, needs further confirmation
    return data.getUint32(polyOffset + 8, true) === 0;
}

function unpackSkyIndices(b1: number, b2: number, b3: number, b4: number): number[] {
    return [(b1 >> 2) | ((b2 & 15) << 6), (b2 >> 4) | ((b3 & 63) << 4), (b3 >> 6) | (b4 << 2)];
}

function unpackGroundLODIndices(data: DataView, offset: number, gameNumber: number): { v: number[], c: number[] } {
    if (gameNumber === 1) {
        const unpack = (b0: number, b1: number, b2: number) => [b0 & 63, (b0 >> 6) | ((b1 & 15) << 2), (b1 >> 4) | ((b2 & 3) << 4), b2 >> 2];
        return {
            v: unpack(data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3)),
            c: unpack(data.getUint8(offset + 5), data.getUint8(offset + 6), data.getUint8(offset + 7))
        };
    }
    const v = [data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3)];
    const c = [data.getUint8(offset + 4), data.getUint8(offset + 5), data.getUint8(offset + 6), data.getUint8(offset + 7)];
    return {
        v: [(v[0] >> 3) | ((v[1] & 3) << 5), (v[1] >> 2) | ((v[2] & 1) << 6), v[2] >> 1, v[3] & 127],
        c: [(c[0] >> 4) | ((c[1] & 7) << 4), (c[1] >> 3) | ((c[2] & 3) << 5), (c[2] >> 2) | ((c[3] & 1) << 6), c[3] >> 1]
    };
}

function readSkyPolygons(data: DataView, offset: number, count: number): Polygon[] {
    // polygons (8)
    const polygons: Polygon[] = Array(count);
    for (let i = 0; i < count; i++, offset += 8) {
        const vertices = unpackSkyIndices(data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3));
        const colors = unpackSkyIndices(data.getUint8(offset + 4), data.getUint8(offset + 5), data.getUint8(offset + 6), data.getUint8(offset + 7));
        polygons[i] = { vertices, colors };
    }
    return polygons;
}

function readSkyPolygonStrips(data: DataView, offset: number, size: number): Polygon[] {
    // variable size, at least 4
    const polygons: Polygon[] = [];
    let pointer = offset;
    let seeker = offset + size;
    for (let i = size; i > 3; i -= 4) {
        const b1 = data.getUint8(pointer);
        const b2 = data.getUint8(pointer + 1);
        const b3 = data.getUint8(pointer + 2);
        let c0 = (b1 >> 3) | ((b2 & 3) << 5);
        let c1 = (b2 >> 2) | ((b3 & 1) << 6);
        const c2 = b3 >> 1;
        let v0 = data.getUint8(pointer + 3);
        pointer += 4;

        let v1 = data.getUint8(seeker);
        const v2 = data.getUint8(seeker + 1);
        seeker += 2;

        polygons.push({ vertices: [v0, v1, v2], colors: [c0, c1, c2] });

        let v3Base = v0;
        let c3Base = c0;
        for (let j = 0; j < (b1 & 7); j++) {
            const v2New = data.getUint8(seeker);
            const cm = data.getUint8(seeker + 1);
            const c2New = cm & 127;

            polygons.push({ vertices: [v0, v1, v2New], colors: [c0, c1, c2New] });

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
    return polygons;
}

function buildSkyboxPart(data: DataView, offset: number, gameNumber: number): SkyboxPart {
    const globalY = data.getInt16(offset + 8, true);
    const globalZ = data.getInt16(offset + 10, true);
    const globalX = data.getInt16(offset + 14, true);
    let vertexCount: number, colorCount: number, polyCount: number;
    if (gameNumber === 1) {
        // header (24)
        vertexCount = data.getUint16(offset + 12, true);
        polyCount = data.getUint16(offset + 16, true);
        colorCount = data.getUint16(offset + 18, true);
        offset += 24;
    } else {
        // header (20)
        vertexCount = data.getUint8(offset + 12);
        colorCount = data.getUint8(offset + 13);
        polyCount = data.getUint16(offset + 18, true);
        offset += 20;
    }

    // vertices (4)
    const vlut = readVertices(data, offset, vertexCount, [globalX, -globalY, -globalZ]);
    offset += vertexCount * 4;

    // colors (4)
    const clut = readColors(data, offset, colorCount);
    offset += colorCount * 4;

    const polygons = gameNumber === 1 ? readSkyPolygons(data, offset, polyCount) : readSkyPolygonStrips(data, offset, polyCount);
    return { vlut, clut, polygons };
}

export function buildSpyroSkybox(data: DataView, gameNumber: number): SpyroSkybox {
    const backgroundColor = [data.getUint8(0), data.getUint8(1), data.getUint8(2)];
    const partCount = data.getUint32(4, true);
    let pointer = 8;
    const parts: SkyboxPart[] = [];
    for (let i = 0; i < partCount; i++) {
        const offset = data.getUint32(pointer, true);
        pointer += 4;
        if (offset === 0 || offset >= data.byteLength) {
            break;
        }
        parts.push(buildSkyboxPart(data, offset, gameNumber));
    }
    return { backgroundColor, parts };
}

export function buildSpyroLevel(data: DataView, textures: SpyroRawTexture[], gameNumber: number, id: number): SpyroLevel {
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
        offset = partOffsets[i];

        // header (28)
        offset += 8;
        const header = readGroundPartHeader(data, offset);
        offset += 20;
        const origin = [header.x, header.y, header.z];

        // LOD vertices (4)
        const vlutLOD = readVertices(data, offset, header.lodVertexCount, origin, gameNumber > 1 ? 2 : 1);
        offset += header.lodVertexCount * 4;

        // LOD colors (4)
        const clutLOD = readColors(data, offset, header.lodColorCount);
        offset += header.lodColorCount * 4;

        // LOD polys (8)
        const polygonsLOD: Polygon[] = [];
        for (let j = 0; j < header.lodPolyCount; j++, offset += 8) {
            const { v, c } = unpackGroundLODIndices(data, offset, gameNumber);
            const lod = (a: number, b: number, d: number) => polygonsLOD.push(getPolygon(v, c, a, b, d));
            if (v[0] === v[1]) {
                lod(1, 2, 3);
            } else if (v[1] === v[2]) {
                lod(0, 2, 3);
            } else if (v[2] === v[3]) {
                lod(0, 1, 3);
            } else if (v[3] === v[0]) {
                lod(0, 1, 2);
            } else {
                lod(1, 0, 2);
                lod(1, 2, 3);
            }
        }

        const polyOffset = offset + header.mdlVertexCount * 4 + header.mdlColorCount * 8;
        let zScale = 1;
        if (gameNumber > 1) {
            const far = header.lodVertexCount === 0 && header.flags === 0xFFFFFFFF;
            const hasWater = () => {
                for (let j = 0; j < header.mdlPolyCount; j++) {
                    if (isWaterPolygon(data, polyOffset + j * 16)) {
                        return true;
                    }
                }
                return false;
            };
            // weird z-scaling for shady oasis and mystic marsh in s2
            zScale = (header.water > 0 || (far && !hasWater())) ? 2 : 0.25;
        }

        // MDL vertices (4)
        const vlut = readVertices(data, offset, header.mdlVertexCount, origin, zScale);
        offset += header.mdlVertexCount * 4;

        // MDL colors (4)
        const clut = readColors(data, offset, header.mdlColorCount);
        offset += header.mdlColorCount * 4;

        // MID colors (4)
        // unused here, but used in game for blending between lod and mdl parts (basically an approx of the texture at distance)
        offset += header.mdlColorCount * 4;

        // MDL polys (16)
        const polygons: SpyroMDLPolygon[] = [];
        for (let j = 0; j < header.mdlPolyCount; j++) {
            const v = [data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3)];
            const c = [data.getUint8(offset + 4), data.getUint8(offset + 5), data.getUint8(offset + 6), data.getUint8(offset + 7)];
            const isTriangle = v[0] === v[1];
            const textureIndex = data.getUint8(offset + (gameNumber === 1 ? 8 : 12)) & 127;
            const uvFlags = data.getUint8(offset + (gameNumber === 1 ? 9 : 13));
            const isWater = gameNumber > 1 && header.water === 0 && isWaterPolygon(data, offset);
            offset += 16;

            if (textureIndex >= textures.length) {
                continue;
            }
            const tile = textures[textureIndex].mid;
            const blendMode = tile.semiTransparent ? tile.blendMode : SpyroBlendMode.OPAQUE;
            let rot = 0;
            if (isTriangle) {
                rot = gameNumber === 1 ? -(uvFlags & 3) : tile.rotation - ((uvFlags >> 4) & 3);
            }
            const [A, B, C, D] = UV_ROTATIONS[rot & 3];
            const inverse = gameNumber > 1 && (uvFlags & 4) !== 0;

            const tex = { textureIndex, isWater, blendMode };
            if (!isTriangle) {
                polygons.push(
                    { ...getPolygon(v, c, 0, 1, 2), uvs: [A, B, C], ...tex },
                    { ...getPolygon(v, c, 0, 2, 3), uvs: [A, C, D], ...tex }
                );
            } else if (!inverse) {
                polygons.push({ ...getPolygon(v, c, 1, 2, 3), uvs: [A, C, D], ...tex });
            } else {
                polygons.push({ ...getPolygon(v, c, 3, 2, 1), uvs: [D, C, A], ...tex });
            }
        }

        parts[i] = { vlut, clut, vlutLOD, clutLOD, polygons, polygonsLOD };
    }

    return { textures, gameNumber, id, parts };
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

export function parseSpyroLevelData2(data: ArrayBufferSlice, gameNumber: number, levelNumber: number, isFlyover: boolean): SpyroLevelData {
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
            // some sort of header
            if (gameNumber === 3) {
                subfile4.skip(48);
            } else {
                // weird fix for s2
                subfile4.skip(25);
                const unk = subfile4.getUint8();
                if (unk === 0xFF) {
                    subfile4.skip(18);
                } else {
                    subfile4.skip(-6);
                }
            }
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
