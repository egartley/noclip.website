import { GfxDevice, GfxFormat, GfxTexture, GfxTextureDimension, GfxTextureUsage } from "../gfx/platform/GfxPlatform";

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
            nums.push(this.data.getUint8(this.pointer + 1 + i));
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

enum ChunkType {
    Texture = 917634,
    Object = 917607,
    Geometry = 917544,
    Material = 917764
}

abstract class DBLChunk {
    constructor(reader: BinaryReader, public type: ChunkType) { this.parseData(reader); }
    protected abstract parseData(reader: BinaryReader): void;
}

export class Texture {
    public gfxTexture: GfxTexture;
    constructor(device: GfxDevice, public rgba: Uint8Array, public width: number, public height: number) {
        const gfxTexture = device.createTexture({
            width, height,
            pixelFormat: GfxFormat.U8_RGBA_NORM,
            usage: GfxTextureUsage.Sampled,
            dimension: GfxTextureDimension.n2D,
            depthOrArrayLayers: 1,
            numLevels: 1
        });
        device.uploadTextureData(gfxTexture, 0, [rgba]);
        this.gfxTexture = gfxTexture;
    }
}

export function buildTextures(device: GfxDevice, dblFile: DBLFile): Texture[] {
    const textures: Texture[] = [];
    for (const chunk of dblFile.chunks) {
        if (chunk.type == ChunkType.Texture) {
            const t = chunk as TextureChunk;
            for (const texture of t.textures) {
                textures.push(new Texture(device, texture.rgba, texture.header.width, texture.header.height));
            }
        }
    }
    return textures;
}

class TextureHeader {
    private type: number;
    public pixelOffset: number;
    public paletteOffset: number;
    public width: number;
    public height: number;
    public paletteWidth: number;
    public paletteHeight: number;
    public paletteByte: number;
    public pixelByte: number;
    private name: string;

    constructor(reader: BinaryReader) {
        const data = [];
        for (let i = 0; i < 20; i++) {
            data.push(reader.u16());
        }
        this.type = data[0];
        this.pixelOffset = data[6];
        this.width = data[8];
        this.height = data[9];
        this.paletteOffset = data[14];
        this.paletteWidth = data[16];
        this.paletteHeight = data[17];
        this.name = reader.string(32);
        switch (this.type) {
            case 8: this.pixelByte = 1; this.paletteByte = 2; break;
            case 9: this.pixelByte = 1; this.paletteByte = 4; break;
            case 28: this.pixelByte = 4; this.paletteByte = 0; break;
        }
    }
}

class TextureData {
    public rgba: Uint8Array;

    constructor(reader: BinaryReader, public header: TextureHeader, start: number) {
        const colorCount = header.paletteWidth * header.paletteHeight;
        const pixelCount = header.width * header.height;
        reader.setPointer(start + header.paletteOffset);
        const palette = reader.bytes(colorCount * header.paletteByte);
        reader.setPointer(start + header.pixelOffset);
        const indices = reader.bytes(pixelCount);

        const clut: number[] = [];
        for (let i = 0; i < palette.length; i += header.paletteByte) {
            clut.push(palette[i], palette[i + 1], palette[i + 2]);
        }
        
        const pixels: number[] = [];
        for (let i = 0; i < pixelCount; i++) {
            const index = indices[i];
            pixels.push(clut[index], clut[index + 1], clut[index + 2], 255);
        }

        this.rgba = new Uint8Array(pixels);
    }
}

class TextureChunk extends DBLChunk {
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

class ObjectChunk extends DBLChunk {
    protected parseData(reader: BinaryReader): void { }
}

class GeometryChunk extends DBLChunk {
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
