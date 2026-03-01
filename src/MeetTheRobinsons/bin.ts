import { GeometryBlock } from "./bin_geom";
import { TextureData, TextureHeader } from "./bin_texture";

export class BinaryReader {
    private pointer: number = 0;
    private decoder = new TextDecoder();

    constructor(private data: DataView) { }

    getPointer() { return this.pointer; }
    setPointer(p: number) { this.pointer = p; }
    padding(n: number) { this.pointer += n; }

    u8() { return this.data.getUint8(this.pointer++); }
    u16() { const v = this.data.getUint16(this.pointer, true); this.pointer += 2; return v; }
    u32() { const v = this.data.getUint32(this.pointer, true); this.pointer += 4; return v; }
    peekU32() { return this.data.getUint32(this.pointer, true); }
    f32() { const v = this.data.getFloat32(this.pointer, true); this.pointer += 4; return v; }

    bytes(n: number) {
        const data = new Uint8Array(this.data.buffer, this.pointer, n);
        this.pointer += n;
        return data;
    }

    peek(n: number): number[] {
        const nums = [];
        for (let i = 0; i < n; i++) {
            nums.push(this.data.getUint8(this.pointer + i));
        }
        return nums;
    }

    slice(start: number, end: number) {
        return new Uint8Array(this.data.buffer.slice(start, end));
    }

    string(length: number) {
        return this.decoder.decode(this.bytes(length));
    }
}

export enum ChunkType {
    Texture = 917634,
    Object = 917607,
    Geometry = 917544,
    Material = 917764
}

abstract class DBLChunk {
    constructor(reader: BinaryReader, public type: ChunkType) { this.parseData(reader); }
    protected abstract parseData(reader: BinaryReader): void;
}

export class TextureChunk extends DBLChunk {
    private count: number;
    private start: number;
    private name: string;
    private headers: TextureHeader[];
    public textures: TextureData[];

    protected parseData(reader: BinaryReader): void {
        this.start = reader.getPointer();
        this.count = reader.u32();
        reader.padding(20);
        this.name = reader.string(32);
        this.headers = [];
        this.textures = [];
        for (let i = 0; i < this.count; i++) {
            this.headers.push(new TextureHeader(reader));
        }
        for (let i = 0; i < this.count; i++) {
            this.textures.push(new TextureData(reader, this.headers[i], this.start));
        }
    }
}

export class GeometryChunk extends DBLChunk {
    private start: number;
    private blockCount: number;
    private offsets: number[];
    public blocks: GeometryBlock[];

    protected parseData(reader: BinaryReader): void {
        this.start = reader.getPointer();
        this.blockCount = reader.u16();
        reader.padding(2);
        this.offsets = [];
        for (let i = 0; i < this.blockCount; i++) {
            this.offsets.push(reader.u32());
        }
        this.blocks = [];
        for (let i = 0; i < this.blockCount; i++) {
            const offset = this.offsets[i];
            this.blocks.push(new GeometryBlock(reader, this.start + offset));
        }
    }
}

class ObjectChunk extends DBLChunk {
    protected parseData(reader: BinaryReader): void { }
}

class MaterialChunk extends DBLChunk {
    protected parseData(reader: BinaryReader): void { }
}

export class DBLFile {
    public chunks: DBLChunk[];

    constructor(data: DataView) {
        const reader = new BinaryReader(data);
        reader.padding(24);
        const chunkCount = reader.u16();
        reader.padding(6);

        this.chunks = [];
        for (let i = 0; i < chunkCount; i++) {
            const typeId = reader.u32();
            const size = reader.u32();
            reader.padding(56);
            const chunkStart = reader.getPointer();

            let chunk = null;
            switch (typeId as ChunkType) {
                case ChunkType.Texture: chunk = new TextureChunk(reader, ChunkType.Texture); break;
                case ChunkType.Object: chunk = new ObjectChunk(reader, ChunkType.Object); break;
                case ChunkType.Geometry: chunk = new GeometryChunk(reader, ChunkType.Geometry); break;
                case ChunkType.Material: chunk = new MaterialChunk(reader, ChunkType.Material); break;
            }
            if (chunk) {
                this.chunks.push(chunk);
            }

            reader.setPointer(chunkStart + size);
        }
    }
}

export function getChunksByType(dbl: DBLFile, ...types: ChunkType[]): DBLChunk[] {
    const chunks: DBLChunk[] = [];
    for (const chunk of dbl.chunks) {
        if (types.includes(chunk.type)) {
            chunks.push(chunk);
        }
    }
    return chunks;
}
