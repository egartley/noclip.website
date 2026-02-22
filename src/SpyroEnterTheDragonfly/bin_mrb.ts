import { BinaryReader } from "./bin";

export enum ChunkType {
    Texture = 3671558448,
    Material = 3899959227,
    ObjectShape = 2724436415,
    Object = 1142910985,
    Attribute = 38888829,
    AnimatedObject = 2140961626,
    Property = 761170991,
    TextureGroup = 1203390189,
    Unknown1 = 67242671,
    Animation = 131162624,
    Shape2 = 4213557647,
    SpecularEnv = 3160929782,
    Particle = 2485864778,
    ParticleShape = 2499941824,
    Property2 = 3774573822,
    Property3 = 2438865836,
    Shape4 = 1028427169,
    ClusterShape = 1418262912,
    Cluster = 2337873906,
    Shape3 = 3053583857,
    Blend = 624797560,
    Shape5 = 4048945320,
    Mesh = 3808459748,
    BigShape = 3206376836,
    Field = 2730149095
}

abstract class Chunk {
    public type: ChunkType;
    public instanceId: number;
    public name: string;
    public groupId: number;

    constructor(reader: BinaryReader) {
        this.instanceId = reader.u32();
        this.name = reader.alignedString();
        reader.skip(4);
        this.groupId = reader.u32();
        this.parseData(reader);
    }

    protected abstract parseData(reader: BinaryReader): void;
}

class ChunkFlags {
    // flags: number[];

    constructor(reader: BinaryReader) {
        // this.flags = [];
        // for (let i = 0; i < 11; i++) {
        //     this.flags.push(reader.u32());
        // }
        reader.skip(44);
    }
}

class Vertex {
    x: number;
    y: number;
    z: number;

    constructor(reader: BinaryReader) {
        this.x = reader.f32();
        this.y = reader.f32();
        this.z = reader.f32();
    }
}

export class TextureChunk extends Chunk {
    data: Uint8Array;
    pxtName: string;
    data2: Uint8Array;

    protected parseData(reader: BinaryReader): void {
        this.data = reader.bytes(63);
        this.pxtName = reader.alignedString();
        this.data2 = reader.bytes(97);
    }
}

class MaterialChunk extends Chunk {
    flags: ChunkFlags;
    data: Uint8Array;

    protected parseData(reader: BinaryReader): void {
        this.flags = new ChunkFlags(reader);
        this.data = reader.bytes(66);
    }
}

export class ObjectShapeChunk extends Chunk {
    points: Vertex[];
    geomOffset: number;
    geomChunkCount: number;
    textureGroupId: number;

    protected parseData(reader: BinaryReader): void {
        this.points = [];
        this.points.push(new Vertex(reader));
        this.points.push(new Vertex(reader));
        this.points.push(new Vertex(reader));
        reader.skip(4 + 32);
        const count = reader.u32();
        this.geomOffset = reader.u32();
        reader.skip(2);
        this.geomChunkCount = reader.u16();
        this.textureGroupId = reader.u32();
        if (count > 1) {
            reader.skip(4 * count);
        }
    }
}

class ObjectChunk extends Chunk {
    flags: ChunkFlags;
    points: Vertex[];

    protected parseData(reader: BinaryReader): void {
        this.flags = new ChunkFlags(reader);
        reader.skip(4);
        this.points = [];
        this.points.push(new Vertex(reader), new Vertex(reader), new Vertex(reader));
        reader.skip(38);
        this.points.push(new Vertex(reader), new Vertex(reader), new Vertex(reader), new Vertex(reader));
        reader.skip(12);
    }
}

class AttributeChunk extends Chunk {
    subData: number[][];
    subData2: number[][];

    protected parseData(reader: BinaryReader): void {
        reader.skip(9);
        const count = reader.u32();
        this.subData = [];
        for (let i = 0; i < count; i++) {
            this.subData.push([reader.u32(), reader.u32()]);
        }
        const count2 = reader.u32();
        this.subData2 = [];
        if (count2 > 0) {
            for (let i = 0; i < count2; i++) {
                const n = [];
                for (let j = 0; j < 8; j++) {
                    n.push(reader.u32());
                }
                this.subData2.push(n);
            }
        }
        reader.skip(4);
    }
}

class AnimatedObjectChunk extends Chunk {
    animationId: number;

    protected parseData(reader: BinaryReader): void {
        const count = reader.u32();
        const count2 = reader.u32();
        this.animationId = reader.u32();
        let skipCount = 3;
        if (count > 1) {
            if (count === 6) {
                skipCount = 38;
            } else if (count === 7) {
                skipCount = 45;
            } else {
                skipCount = 9;
            }
        }
        reader.skip(skipCount);
        reader.skip(4 * count2 * 3);
    }
}

class PropertyChunk extends Chunk {
    protected parseData(reader: BinaryReader): void {
        const data = reader.u16();
        const check = reader.u16();
        if (data === 2 && check === 0) {
            reader.skip(data * 4 * 4);
        } else if (data === 5 && check === 0) {
            reader.skip(80);
        } else if (check === 2 || check === 3) {
            reader.skip(4);
        } else if (data > 20) {
            reader.skip(data * 4 * 4);
        } else {
            const signature = [[2], [0], [0], [0], [2, 0], [0], [0], [0], [1]];
            let skip = true;
            while (skip) {
                skip = false;
                const nums = reader.peek(9);
                for (let i = 0; i < nums.length; i++) {
                    if (!signature[i].includes(nums[i])) {
                        skip = true;
                    }
                }
                reader.skip(1);
            }
        }
        reader.skip(9);
    }
}

export class TextureGroupChunk extends Chunk {
    count: number;
    textureIds: number[];
    baseTextureId: number;

    protected parseData(reader: BinaryReader): void {
        reader.skip(88);
        this.count = reader.u32();
        this.textureIds = [];
        for (let i = 0; i < this.count; i++) {
            reader.skip(4);
            this.textureIds.push(reader.u32());
            reader.skip(122);
        }
        this.baseTextureId = reader.u32();
        reader.skip(6);
    }
}

class SpecularEnvChunk extends Chunk {
    flags: ChunkFlags;

    protected parseData(reader: BinaryReader): void {
        this.flags = new ChunkFlags(reader);
        reader.skip(66);
        const count = reader.u32();
        for (let i = 0; i < count; i++) {
            reader.skip(8);
        }
        reader.skip(1);
    }
}

class AnimationChunk extends Chunk {
    frameCount: number;

    protected parseData(reader: BinaryReader): void {
        this.frameCount = reader.u8();
        reader.skip(3);
        reader.skip(4 * this.frameCount * 2);
        reader.skip(4 + 4 + 9);
    }
}

class BlendChunk extends Chunk {
    protected parseData(reader: BinaryReader): void {
        reader.skip(10);
        const count = reader.u32();
        for (let i = 0; i < count; i++) {
            reader.skip(4);
        }
    }
}

class ParticleShapeChunk extends Chunk {
    protected parseData(reader: BinaryReader): void {
        reader.skip(136);
        const count = reader.u32();
        if (count > 0) {
            for (let i = 0; i < count; i++) {
                reader.skip(48);
            }
        } else {
            reader.skip(4);
        }
        reader.skip(90);
    }
}

class Property2Chunk extends Chunk {
    protected parseData(reader: BinaryReader): void {
        reader.skip(4);
        const count = reader.u32();
        for (let i = 0; i < count; i++) {
            reader.skip(4 + 4);
        }
    }
}

class Property3Chunk extends Chunk {
    protected parseData(reader: BinaryReader): void {
        reader.skip(4);
        const count = reader.u32();
        for (let i = 0; i < count; i++) {
            reader.skip(4 + 4 + 4 + 4);
        }
    }
}

export class ClusterShapeChunk extends Chunk {
    points: Vertex[];
    geomOffset: number;
    geomChunkCount: number;
    textureGroupId: number;

    protected parseData(reader: BinaryReader): void {
        this.points = [];
        this.points.push(new Vertex(reader), new Vertex(reader), new Vertex(reader));
        reader.skip(4 + (9 * 4));
        this.geomOffset = reader.u32();
        reader.skip(2);
        this.geomChunkCount = reader.u16();
        this.textureGroupId = reader.u32();
    }
}

class ClusterChunk extends Chunk {
    shapeId: number;
    vertexCount: number;
    vertices: Vertex[];

    protected parseData(reader: BinaryReader): void {
        this.shapeId = reader.u32();
        reader.skip(6);
        this.vertexCount = reader.u32();
        this.vertices = [];
        for (let i = 0; i < this.vertexCount; i++) {
            reader.skip(48);
            this.vertices.push(new Vertex(reader));
            reader.skip(4);
        }
        reader.skip(64 + (4 * this.vertexCount));
    }
}

class Shape5Chunk extends Chunk {
    flags: ChunkFlags;
    point: Vertex;

    protected parseData(reader: BinaryReader): void {
        this.flags = new ChunkFlags(reader);
        reader.skip(20);
        this.point = new Vertex(reader);
        reader.skip(76);
    }
}

class MeshChunk extends Chunk {
    vertexCount: number;
    faceCount: number;
    vertices: Vertex[];
    indices: number[];

    protected parseData(reader: BinaryReader): void {
        this.vertices = [];
        this.indices = [];
        reader.skip(49);
        this.vertexCount = reader.u32();
        this.faceCount = reader.u32();
        for (let i = 0; i < this.vertexCount; i++) {
            this.vertices.push(new Vertex(reader));
        }
        for (let i = 0; i < this.faceCount; i++) {
            reader.skip(12);
        }
        for (let i = 0; i < this.faceCount; i++) {
            this.indices.push(reader.u16(), reader.u16(), reader.u16());
        }
    }
}

export class Shape2Chunk extends Chunk {
    geomOffset: number;
    geomChunkCount: number;
    textureGroupId: number;

    protected parseData(reader: BinaryReader) {
        reader.skip(80);
        this.geomOffset = reader.u32();
        reader.skip(2);
        this.geomChunkCount = reader.u16();
        this.textureGroupId = reader.u32();
    }
}

class Unknown1Chunk extends Chunk { protected parseData(r: BinaryReader) { r.skip(44 + 68); } }
class Shape3Chunk extends Chunk { protected parseData(r: BinaryReader) { r.skip(88); } }
class Shape4Chunk extends Chunk { protected parseData(r: BinaryReader) { r.skip(44 + 126); } }
class ParticleChunk extends Chunk { protected parseData(r: BinaryReader) { r.skip(182); } }
class FieldChunk extends Chunk { protected parseData(r: BinaryReader) { r.skip(44 + 134); } }
class UnknownChunk extends Chunk {
    constructor(reader: BinaryReader) {
        super(reader);
    }
    protected parseData(reader: BinaryReader): void { }
}

class MRBFile {
    fileName: string = "";
    chunks: Chunk[] = [];

    constructor(reader: BinaryReader) {
        const nameLen = reader.u32();
        if (nameLen > 0) {
            this.fileName = new TextDecoder().decode(reader.bytes(nameLen));
        }

        const count = reader.u32();
        for (let i = 0; i < count; i++) {
            let chunk = null;
            const typeId = reader.u32();
            if (typeId === 0) {
                continue;
            }
            switch (typeId as ChunkType) {
                case ChunkType.Texture: chunk = new TextureChunk(reader); break;
                case ChunkType.Material: chunk = new MaterialChunk(reader); break;
                case ChunkType.ObjectShape: chunk = new ObjectShapeChunk(reader); break;
                case ChunkType.Object: chunk = new ObjectChunk(reader); break;
                case ChunkType.Attribute: chunk = new AttributeChunk(reader); break;
                case ChunkType.AnimatedObject: chunk = new AnimatedObjectChunk(reader); break;
                case ChunkType.Property: chunk = new PropertyChunk(reader); break;
                case ChunkType.TextureGroup: chunk = new TextureGroupChunk(reader); break;
                case ChunkType.SpecularEnv: chunk = new SpecularEnvChunk(reader); break;
                case ChunkType.Animation: chunk = new AnimationChunk(reader); break;
                case ChunkType.Blend: chunk = new BlendChunk(reader); break;
                case ChunkType.Unknown1: chunk = new Unknown1Chunk(reader); break;
                case ChunkType.Shape2: chunk = new Shape2Chunk(reader); break;
                case ChunkType.Particle: chunk = new ParticleChunk(reader); break;
                case ChunkType.ParticleShape: chunk = new ParticleShapeChunk(reader); break;
                case ChunkType.Property2: chunk = new Property2Chunk(reader); break;
                case ChunkType.Property3: chunk = new Property3Chunk(reader); break;
                case ChunkType.Shape4: chunk = new Shape4Chunk(reader); break;
                case ChunkType.ClusterShape: chunk = new ClusterShapeChunk(reader); break;
                case ChunkType.Cluster: chunk = new ClusterChunk(reader); break;
                case ChunkType.Shape3: chunk = new Shape3Chunk(reader); break;
                case ChunkType.Shape5: chunk = new Shape5Chunk(reader); break;
                case ChunkType.Mesh: chunk = new MeshChunk(reader); break;
                // case ChunkType.BigShape: chunk = new BigShapeChunk(reader); break;
                case ChunkType.Field: chunk = new FieldChunk(reader); break;
                default: chunk = new UnknownChunk(reader); break;
            }
            if (chunk) {
                chunk.type = typeId as ChunkType;
                this.chunks.push(chunk);
            }
        }
    }
}

export class MRBBundle {
    files: MRBFile[];

    constructor(data: DataView) {
        const reader = new BinaryReader(data);
        this.files = [];
        while (reader.getOffset() < data.byteLength) {
            this.files.push(new MRBFile(reader));
        }
    }
}

export function getChunksByType(bundle: MRBBundle, ...types: ChunkType[]): Chunk[] {
    const chunks: Chunk[] = [];
    for (const mrb of bundle.files) {
        for (const chunk of mrb.chunks) {
            if (types.includes(chunk.type)) {
                chunks.push(chunk);
            }
        }
    }
    return chunks;
}

export function getChunksById(bundle: MRBBundle, ...ids: number[]): Chunk[] {
    const chunks: Chunk[] = [];
    for (const mrb of bundle.files) {
        for (const chunk of mrb.chunks) {
            if (ids.includes(chunk.instanceId)) {
                chunks.push(chunk);
            }
        }
    }
    return chunks;
}
