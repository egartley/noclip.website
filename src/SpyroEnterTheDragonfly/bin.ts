enum ChunkType {
    Texture = 3671558448,
    Material = 3899959227,
    ObjectShape = 2724436415,
    Object = 1142910985,
    Attribute = 38888829,
    Effect = 2140961626,
    Property = 761170991,
    TextureGroup = 1203390189,
    Unknown1 = 67242671,
    Clip = 131162624,
    Shape2 = 4213557647,
    SpecularEnv = 3160929782,
    Particle = 2485864778,
    ParticleShape = 2499941824,
    Unknown2 = 3774573822,
    Unknown3 = 2438865836,
    Shape4 = 1028427169,
    ClusterShape = 1418262912,
    Cluster = 2337873906,
    Shape3 = 3053583857,
    Blend = 624797560,
    Shape5 = 4048945320,
    Mesh = 3808459748
}

abstract class Chunk {
    public instanceId: number;
    public name: string;
    public common: number;

    constructor(reader: MRBReader) {
        this.instanceId = reader.u32();
        this.name = reader.alignedString();
        reader.skip(4);
        this.common = reader.u32();
        this.parseData(reader);
    }

    protected abstract parseData(reader: MRBReader): void;
}

export class MeshChunk extends Chunk {
    vertices: number[];
    subData: number[];
    indices: number[];

    protected parseData(reader: MRBReader): void {
        this.vertices = [];
        this.subData = [];
        this.indices = [];
        reader.skip(49);
        const vCount = reader.u32();
        const fCount = reader.u32();
        for (let i = 0; i < vCount; i++) this.vertices.push(reader.f32(), reader.f32(), reader.f32());
        for (let i = 0; i < fCount; i++) this.subData.push(reader.f32(), reader.f32(), reader.f32());
        for (let i = 0; i < fCount; i++) this.indices.push(reader.u16(), reader.u16(), reader.u16());
    }
}

class ObjectChunk extends Chunk {
    rawHeader: Uint8Array;
    points: number[] = [];

    protected parseData(reader: MRBReader): void {
        this.points = [];
        this.rawHeader = reader.bytes(122);
        for (let i = 0; i < 4; i++) {
            this.points.push(reader.f32(), reader.f32(), reader.f32());
        }
        reader.skip(12);
    }
}

class ObjectShapeChunk extends Chunk {
    data: Uint8Array;
    data2: Uint8Array;
    textureGroupId: number;

    protected parseData(reader: MRBReader): void {
        this.data = reader.bytes(40);
        this.data = reader.bytes(44);
        this.textureGroupId = reader.u32();
    }
}

class MaterialChunk extends Chunk {
    data: Uint8Array;

    protected parseData(reader: MRBReader): void {
        this.data = reader.bytes(110);
    }
}

class TextureChunk extends Chunk {
    data: Uint8Array;
    pxtName: string;
    data2: Uint8Array;

    protected parseData(reader: MRBReader): void {
        this.data = reader.bytes(63);
        this.pxtName = reader.alignedString();
        this.data2 = reader.bytes(97);
    }
}

class PropertyChunk extends Chunk {
    data: Uint8Array;
    footer: Uint8Array;

    protected parseData(reader: MRBReader): void {
        const start = reader.getOffset();
        while (!reader.isPropEnd()) { reader.skip(1); }
        const end = reader.getOffset();
        this.data = reader.slice(start, end);
        this.footer = reader.bytes(9);
    }
}

class EffectChunk extends Chunk {
    public clipId: number = 0;
    public checkByte: number = 0;
    public checkData: Uint8Array;
    public data3: number[] = [];
    public data4: number[] = [];
    public data5: number[] = [];

    protected parseData(reader: MRBReader): void {
        reader.skip(4);
        const count = reader.u32();
        this.clipId = reader.u32();
        this.checkByte = reader.u8();
        this.checkData = reader.bytes(this.checkByte > 1 ? 9 : 2);
        for (let i = 0; i < count; i++) this.data3.push(reader.u32());
        for (let i = 0; i < count; i++) this.data4.push(reader.u32());
        for (let i = 0; i < count; i++) this.data5.push(reader.u32());
    }
}

class ClipChunk extends Chunk {
    data: Uint8Array;
    data2: number[] = [];
    data3: number[] = [];
    data4: Uint8Array;

    protected parseData(reader: MRBReader): void {
        const count = reader.u8();
        this.data = reader.bytes(3);
        for (let i = 0; i < count; i++) this.data2.push(reader.u32());
        for (let i = 0; i < count; i++) this.data3.push(reader.u32());
        this.data4 = reader.bytes(17);
    }
}

class TextureGroupChunk extends Chunk {
    public textureRefs: { prefix: Uint8Array, textureId: number, suffix: Uint8Array }[] = [];
    public finalTextureId: number = 0;

    protected parseData(reader: MRBReader): void {
        this.textureRefs = [];
        reader.skip(88); // data[88]
        const count = reader.u32();
        for (let i = 0; i < count; i++) {
            this.textureRefs.push({
                prefix: reader.bytes(4),
                textureId: reader.u32(),
                suffix: reader.bytes(122)
            });
        }
        this.finalTextureId = reader.u32();
        reader.skip(6); // end[6]
    }
}

class SpecularEnvChunk extends Chunk {
    public subData: number[] = [];

    protected parseData(reader: MRBReader): void {
        this.subData = [];
        reader.skip(110); // data[110]
        const count = reader.u32();
        for (let i = 0; i < count; i++) {
            this.subData.push(reader.u32(), reader.u32());
        }
        reader.skip(1); // end u8
    }
}

class BlendChunk extends Chunk {
    public values: number[] = [];

    protected parseData(reader: MRBReader): void {
        reader.skip(10); // data[10]
        const count = reader.u32();
        for (let i = 0; i < count; i++) {
            this.values.push(reader.u32());
        }
    }
}

class ParticleShapeChunk extends Chunk {
    public subData: Uint8Array[] = [];

    protected parseData(reader: MRBReader): void {
        reader.skip(136); // data[136]
        const count = reader.u32();
        if (count > 0) {
            for (let i = 0; i < count; i++) {
                this.subData.push(reader.bytes(48));
            }
        }
        reader.skip(94); // data2[94]
    }
}

class ClusterShapeChunk extends Chunk {
    public textureGroupId: number = 0;

    protected parseData(reader: MRBReader): void {
        reader.skip(84); // data[84]
        this.textureGroupId = reader.u32();
    }
}

class Shape5Chunk extends Chunk {
    public pos: { x: number, y: number, z: number };

    protected parseData(reader: MRBReader): void {
        reader.skip(64); // data[64]
        this.pos = { x: reader.f32(), y: reader.f32(), z: reader.f32() };
        reader.skip(76); // data2[76]
    }
}

class Unknown1Chunk extends Chunk { protected parseData(r: MRBReader) { r.skip(112); } }
class Unknown2Chunk extends Chunk { protected parseData(r: MRBReader) { r.skip(32); } }
class Unknown3Chunk extends Chunk { protected parseData(r: MRBReader) { r.skip(88); } }
class Shape2Chunk extends Chunk { protected parseData(r: MRBReader) { r.skip(92); } }
class Shape3Chunk extends Chunk { protected parseData(r: MRBReader) { r.skip(88); } }
class Shape4Chunk extends Chunk { protected parseData(r: MRBReader) { r.skip(170); } }
class ParticleChunk extends Chunk { protected parseData(r: MRBReader) { r.skip(182); } }

class ClusterChunk extends Chunk {
    public shapeId: number = 0;
    public vertices: { x: number, y: number, z: number }[] = [];
    public weights: number[] = [];

    protected parseData(reader: MRBReader): void {
        this.shapeId = reader.u32();
        reader.skip(6); // data2
        const vertexCount = reader.u32();

        // ClusterVertexData implementation
        for (let i = 0; i < vertexCount; i++) {
            reader.skip(48); // padding
            this.vertices.push({
                x: reader.f32(),
                y: reader.f32(),
                z: reader.f32()
            });
            reader.skip(4); // padding
        }

        reader.skip(64); // padding[64]

        // Read the weight/data4 block
        for (let i = 0; i < vertexCount; i++) {
            this.weights.push(reader.u32());
        }
    }
}

class AttributeChunk extends Chunk {
    public subData: number[];

    protected parseData(reader: MRBReader): void {
        this.subData = [];
        reader.skip(9);
        const count = reader.u32();
        for (let i = 0; i < count; i++) {
            this.subData.push(reader.u32(), reader.u32());
        }
        reader.skip(8);
    }
}

class UnknownChunk extends Chunk {
    constructor(reader: MRBReader, public typeId: number) {
        super(reader);
    }
    protected parseData(reader: MRBReader): void {
        console.warn(`Unknown Chunk Type: ${this.typeId} at ${reader.getOffset()}`);
    }
}

class MRBReader {
    private offset: number = 0;
    private decoder = new TextDecoder();

    constructor(private data: DataView) {

    }

    getOffset() { return this.offset; }
    skip(n: number) { this.offset += n; }

    u8() { return this.data.getUint8(this.offset++); }
    u16() { const v = this.data.getUint16(this.offset, true); this.offset += 2; return v; }
    u32() { const v = this.data.getUint32(this.offset, true); this.offset += 4; return v; }
    peekU32() { return this.data.getUint32(this.offset, true); }
    f32() { const v = this.data.getFloat32(this.offset, true); this.offset += 4; return v; }

    bytes(n: number) {
        const data = new Uint8Array(this.data.buffer, this.offset, n);
        this.offset += n;
        return data;
    }

    slice(start: number, end: number) {
        return new Uint8Array(this.data.buffer.slice(start, end));
    }

    alignedString() {
        const len = this.u32();
        return this.decoder.decode(this.bytes(len));
    }

    isPropEnd(): boolean {
        const o = this.offset;
        if (o + 9 > this.data.byteLength) return true;
        const a = this.data.getUint8(o);
        const e = this.data.getUint8(o + 4);
        const i = this.data.getUint8(o + 8);
        const zeroes = [1, 2, 3, 5, 6, 7].every(idx => this.data.getUint8(o + idx) === 0);
        return (a === 2 || a === 0) && zeroes && e === 2 && i === 1;
    }
}

export class MRB {
    fileName: string = "";
    chunks: Chunk[] = [];

    constructor(data: DataView) {
        const reader = new MRBReader(data);
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
                case ChunkType.Mesh: chunk = new MeshChunk(reader); break;
                case ChunkType.Texture: chunk = new TextureChunk(reader); break;
                case ChunkType.Object: chunk = new ObjectChunk(reader); break;
                case ChunkType.Property: chunk = new PropertyChunk(reader); break;
                case ChunkType.Effect: chunk = new EffectChunk(reader); break;
                case ChunkType.Cluster: chunk = new ClusterChunk(reader); break;
                case ChunkType.Attribute: chunk = new AttributeChunk(reader); break;
                case ChunkType.ObjectShape: chunk = new ObjectShapeChunk(reader); break;
                case ChunkType.Material: chunk = new MaterialChunk(reader); break;
                case ChunkType.Clip: chunk = new ClipChunk(reader); break;
                case ChunkType.TextureGroup: chunk = new TextureGroupChunk(reader); break;
                case ChunkType.SpecularEnv: chunk = new SpecularEnvChunk(reader); break;
                case ChunkType.Blend: chunk = new BlendChunk(reader); break;
                case ChunkType.ParticleShape: chunk = new ParticleShapeChunk(reader); break;
                case ChunkType.ClusterShape: chunk = new ClusterShapeChunk(reader); break;
                case ChunkType.Shape5: chunk = new Shape5Chunk(reader); break;
                case ChunkType.Unknown1: chunk = new Unknown1Chunk(reader); break;
                case ChunkType.Unknown2: chunk = new Unknown2Chunk(reader); break;
                case ChunkType.Unknown3: chunk = new Unknown3Chunk(reader); break;
                case ChunkType.Shape2: chunk = new Shape2Chunk(reader); break;
                case ChunkType.Shape3: chunk = new Shape3Chunk(reader); break;
                case ChunkType.Shape4: chunk = new Shape4Chunk(reader); break;
                case ChunkType.Particle: chunk = new ParticleChunk(reader); break;
                default: chunk = new UnknownChunk(reader, typeId); break;
            }
            if (chunk) {
                this.chunks.push(chunk);
            }
        }
    }
}
