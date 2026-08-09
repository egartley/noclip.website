import { GeometryBlock } from "./bin_geom";
import { TextureData, TextureHeader } from "./bin_texture";

export class BinaryReader {
    private pointer: number = 0;
    private decoder = new TextDecoder();

    constructor(private data: DataView) {
        
    }

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

export enum WilburChunkType {
    Texture = 917634,
    Object = 917607,
    Geometry = 917544,
    Material = 917764
}

interface DBLChunk {
    type: WilburChunkType
}

export interface WilburTextureChunk extends DBLChunk {
    count: number;
    name: string;
    headers: TextureHeader[];
    textures: TextureData[];
}

export interface WilburGeometryChunk extends DBLChunk {
    blocks: GeometryBlock[];
}

interface ObjectChunk extends DBLChunk {

}

interface MaterialChunk extends DBLChunk {

}

function getTextureChunk(reader: BinaryReader): WilburTextureChunk {
    const start = reader.getPointer();
    const count = reader.u32();
    reader.padding(20);
    const name = reader.string(32);
    const headers = [];
    const textures = [];
    for (let i = 0; i < count; i++) {
        headers.push(new TextureHeader(reader));
    }
    for (let i = 0; i < count; i++) {
        textures.push(new TextureData(reader, headers[i], start));
    }
    return { type: WilburChunkType.Texture, count, name, headers, textures };
}

function getGeometryChunk(reader: BinaryReader): WilburGeometryChunk {
    const start = reader.getPointer();
    const blockCount = reader.u16();
    reader.padding(2);
    const offsets = [];
    for (let i = 0; i < blockCount; i++) {
        offsets.push(reader.u32());
    }
    const blocks = [];
    for (let i = 0; i < blockCount; i++) {
        blocks.push(new GeometryBlock(reader, start + offsets[i]));
    }
    return { type: WilburChunkType.Geometry, blocks };
}

export class WilburDBLFile {
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

            let chunk;
            switch (typeId as WilburChunkType) {
                case WilburChunkType.Texture:
                    chunk = getTextureChunk(reader);
                    break;
                case WilburChunkType.Geometry:
                    chunk = getGeometryChunk(reader);
                    break;
                case WilburChunkType.Object:
                case WilburChunkType.Material:
                    chunk = { type: typeId as WilburChunkType };
                    break;
                default:
                    console.warn("Unimplemented chunk type", typeId);
                    break;
            }
            if (chunk) {
                this.chunks.push(chunk);
            }

            reader.setPointer(chunkStart + size);
        }
    }
}

export function getWilburChunksByType(dbl: WilburDBLFile, ...types: WilburChunkType[]): DBLChunk[] {
    const chunks: DBLChunk[] = [];
    for (const chunk of dbl.chunks) {
        if (types.includes(chunk.type)) {
            chunks.push(chunk);
        }
    }
    return chunks;
}
