import { BinaryReader } from "./bin";

export class GeometryBlock {
    public strips: GeometryStrip[];
    private name: string;

    constructor(reader: BinaryReader, offset: number) {
        this.strips = [];

        reader.setPointer(offset);
        reader.padding(48);
        this.name = reader.string(32);
        reader.padding(56 + 4); // skip u32 header value
        const meshCount = reader.u32();

        if (meshCount > 0) {
            reader.padding(4 * meshCount); // skip sizes
            const unkCount = reader.u32();
            reader.padding(unkCount);
            const data0 = reader.u32();
            const unkCount2 = reader.u32();
            reader.padding(8);

            if (data0 === 0) {
                const headerOffset = reader.u32();
                reader.padding(headerOffset - 12);
                let done = false;
                while (!done) {
                    const strip = new GeometryStrip(reader);
                    if (strip.vertices.length > 0 && strip.numbers.length > 0) {
                        this.strips.push(strip);
                        const lookAhead = reader.peek(4);
                        done = lookAhead[0] === 0xDD && (lookAhead[1] === 0x80 || lookAhead[1] === 0x90) && lookAhead[2] === 0x0F;
                    } else {
                        done = true;
                    }
                }
                // reader.padding(4);
            }
        }
    }
}

class GeometryStrip {
    public vertices: number[];
    public numbers: number[];

    constructor(reader: BinaryReader) {
        this.vertices = [];
        this.numbers = [];

        let flags = reader.bytes(4);
        while (flags[1] === 0 && flags[2] === 0)  {
            flags = reader.bytes(4);
        }
        if (flags[0] === 0xDD && (flags[1] === 0x80 || flags[1] === 0x90) && flags[2] === 0x0F) {
            return;
        } else {
            const count = flags[2];
            for (let i = 0; i < count; i++) {
                this.vertices.push(reader.f32(), reader.f32(), reader.f32());
                reader.padding(4);
            }

            reader.padding(4);
            for (let i = 0; i < 9; i++) {
                this.numbers.push(reader.u32());
            }
        }
        
    }
}
