import { BinaryReader } from "./bin";

export class GeometryChunk {
    offset: number;
    type: number;
    vertexCount: number;
    normalCount: number;
    unknownCount: number;
    realVertexCount: number;
    stripLengths: number[];
    colorCount: number;
    uvCount: number;
    vertices: number[];
    normals: number[];
    uvs: number[];
    colors: number[];
    textureIndex: number = -1;

    constructor(reader: BinaryReader) {
        this.offset = reader.getOffset();
        let skip = true;
        const signature = [0x20, 0x40, 0x40, 0x40, 0x40, 0x01, 0x80];
        while (skip) {
            skip = false;
            const nums = reader.peek(7);
            for (let i = 0; i < nums.length; i++) {
                if (nums[i] !== signature[i]) {
                    skip = true;
                }
            }
            reader.skip(1);
        }
        reader.skip(7);

        this.vertexCount = reader.u8();
        reader.skip(1);
        this.vertices = [];
        for (let i = 0; i < this.vertexCount; i++) {
            const x = reader.f32();
            const y = reader.f32();
            const z = reader.f32();
            this.vertices.push(x, y, z);
        }
        reader.skip(14);

        this.normalCount = reader.u8();
        const normalCheck = reader.u8();
        this.normals = [];
        for (let i = 0; i < this.normalCount; i++) {
            const x = reader.u16();
            const y = reader.u16();
            const z = reader.u16();
            this.normals.push(x, y, z);
        }
        if (normalCheck == 0x78) {
            reader.skip(6 * this.normalCount);
        }
        skip = true;
        const signature2 = [0x20, 0x54, 0x54, 0x54, 0x54, 0xC1, 0x80];
        while (skip) {
            skip = false;
            const nums = reader.peek(7);
            for (let i = 0; i < nums.length; i++) {
                if (nums[i] !== signature2[i]) {
                    skip = true;
                }
            }
            reader.skip(1);
        }
        reader.skip(7);

        this.unknownCount = reader.u8();
        reader.skip(1);
        this.realVertexCount = reader.u8();
        this.stripLengths = [];
        this.stripLengths.push(...reader.bytes(43));
        reader.skip(2);

        this.colorCount = reader.u8();
        reader.skip(1);
        this.colors = [];
        for (let i = 0; i < this.colorCount; i++) {
            const r = reader.u8();
            const g = reader.u8();
            const b = reader.u8();
            reader.skip(1);
            // const a = reader.u8();
            this.colors.push(r, g, b);
        }
        if (normalCheck == 0x78) {
            // skip 3 extra sets of colors
            reader.skip(3 * this.colorCount * 4);
        }
        reader.skip(14);

        this.uvCount = reader.u8();
        reader.skip(1);
        this.uvs = [];
        for (let i = 0; i < this.uvCount; i++) {
            const u = reader.f32();
            const v = reader.f32();
            this.uvs.push(u, v);
        }
        reader.skip(15);

        this.type = reader.u8();
    }
}

export class GeomFile {
    public chunks: GeometryChunk[];

    constructor(data: DataView) {
        const reader = new BinaryReader(data);
        this.chunks = [];
        while (reader.getOffset() < data.byteLength) {
            const chunk = new GeometryChunk(reader);
            this.chunks.push(chunk);
        }
    }
}
