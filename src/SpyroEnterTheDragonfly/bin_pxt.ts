import { GfxDevice, GfxFormat, GfxTexture, GfxTextureDimension, GfxTextureUsage } from "../gfx/platform/GfxPlatform";
import { BinaryReader } from "./bin";

class PXTHeader {
    width: number;
    height: number;

    constructor(reader: BinaryReader) {
        reader.skip(48);
        this.width = reader.u32();
        this.height = reader.u32();
        reader.skip(40);
    }
}

class CLUT {
    width: number;
    height: number;
    bitDepth: number;
    colors: number[];

    constructor(reader: BinaryReader) {
        const header = new PXTHeader(reader);
        this.width = header.width;
        this.height = header.height;
        switch (this.width * this.height) {
            case 4096:
                this.bitDepth = 32;
                break;
            case 256:
                this.bitDepth = 8;
                break;
            case 16:
                this.bitDepth = 4;
                break;
            default:
                this.bitDepth = -1;
                break;
        }
        this.colors = [];
        for (let i = 0; i < this.width * this.height * 4; i++) {
            this.colors.push(reader.u8());
        }
    }
}

class PXTTexture {
    width: number;
    height: number;
    indices: number[];

    constructor(reader: BinaryReader, clut: CLUT) {
        const header = new PXTHeader(reader);
        this.width = header.width;
        this.height = header.height;
        let n = this.width * this.height;
        if (clut.bitDepth < 8) {
            n /= 2;
        }
        const indices = [];
        for (let i = 0; i < n; i++) {
            indices.push(reader.u8());
        }
        if (clut.bitDepth > 4) {
            this.indices = indices;
        } else {
            this.indices = [];
            for (let i = 0; i < indices.length; i++) {
                this.indices.push(indices[i] & 0xF);
                this.indices.push((indices[i] >> 4) & 0xF);
            }
        }
    }
}

class PXTChunk {
    clut: CLUT;
    textures: PXTTexture[];

    constructor(reader: BinaryReader) {
        reader.skip(16);
        this.clut = new CLUT(reader);
        this.textures = [];
        const signature = [4, 0, 0, 0, 0, 0, 0, 16, 14, 0, 0, 0, 0, 0, 0, 0];
        let next = true;
        while (next) {
            reader.skip(-1);
            const nums = reader.peek(16);
            for (let i = 0; i < nums.length; i++) {
                if (nums[i] !== signature[i]) {
                    next = false;
                }
            }
            reader.skip(1);
            if (next) {
                this.textures.push(new PXTTexture(reader, this.clut));
            }
        }
        reader.skip(16);
    }
}

export class PXTFile {
    public chunks: PXTChunk[];

    constructor(data: DataView) {
        const reader = new BinaryReader(data);
        this.chunks = [];
        while (reader.getOffset() < data.byteLength) {
            const chunk = new PXTChunk(reader);
            this.chunks.push(chunk);
        }
    }
}

export function buildTextures(device: GfxDevice, pxt: PXTFile): Texture[] {
    const textures: Texture[] = [];
    for (const chunk of pxt.chunks) {
        const bitDepth = chunk.clut.bitDepth;
        if (bitDepth === 32) {
            const clut = chunk.clut;
            textures.push(new Texture(device, new Uint8Array(clut.colors), clut.width, clut.height, bitDepth));
        } else {
            for (const t of chunk.textures.slice(0, 1)) {
                const rgba: Uint8Array = new Uint8Array(t.width * t.height * 4);
                if (bitDepth === 8) {
                    // CLUT is swizzled, but the indices are not
                    const clut = new Uint8Array(1024);
                    for (let i = 0; i < 256; i++) {
                        const unswizzled = (i & 231) | ((i & 8) << 1) | ((i & 16) >> 1);
                        for (let c = 0; c < 4; c++) {
                            clut[i * 4 + c] = chunk.clut.colors[unswizzled * 4 + c];
                        }
                    }
                    for (let y = 0; y < t.height; y++) {
                        for (let x = 0; x < t.width; x++) {
                            const colorIndex = t.indices[y * t.width + x];
                            const index = ((y * t.width) + x) * 4;
                            const pointer = colorIndex * 4;
                            rgba[index] = clut[pointer];
                            rgba[index + 1] = clut[pointer + 1];
                            rgba[index + 2] = clut[pointer + 2];
                            rgba[index + 3] = 255; // clut[pointer + 3];
                        }
                    }
                    textures.push(new Texture(device, rgba, t.width, t.height, bitDepth));
                } else if (bitDepth === 4) {
                    // close but not exactly right
                    const clut = chunk.clut.colors;
                    for (let y = 0; y < t.height; y++) {
                        for (let x = 0; x < t.width; x++) {
                            const colorIndex = t.indices[y * t.width + x];
                            const index = ((y * t.width) + x) * 4;
                            const pointer = colorIndex * 4;
                            rgba[index] = clut[pointer];
                            rgba[index + 1] = clut[pointer + 1];
                            rgba[index + 2] = clut[pointer + 2];
                            rgba[index + 3] = 255; // clut[pointer + 3];
                        }
                    }
                    textures.push(new Texture(device, rgba, t.width, t.height, bitDepth));
                }
            }
        }
    }
    return textures;
}

export class Texture {
    public gfxTexture: GfxTexture;
    constructor(device: GfxDevice, public rgba: Uint8Array, public width: number, public height: number, public bitDepth: number) {
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
