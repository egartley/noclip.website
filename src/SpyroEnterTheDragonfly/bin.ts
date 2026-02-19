export class BinaryReader {
    private offset: number = 0;
    private decoder = new TextDecoder();

    constructor(private data: DataView) { }

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

    peek(n: number) : number[] {
        const nums = [];
        for (let i = 0; i < n; i++) {
            nums.push(this.data.getUint8(this.offset + 1 + i));
        }
        return nums;
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
