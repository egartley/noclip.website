import { GfxDevice, GfxFormat, GfxTexture, GfxTextureDimension, GfxTextureUsage } from "../gfx/platform/GfxPlatform";
import { BinaryReader, WilburChunkType, WilburDBLFile, WilburTextureChunk } from "./bin";

export class Texture {
    public gfxTexture: GfxTexture;

    constructor(device: GfxDevice, public rgba: Uint8Array, public width: number, public height: number, public name: string) {
        const gfxTexture = device.createTexture({
            width, height,
            pixelFormat: GfxFormat.U8_RGBA_NORM,
            usage: GfxTextureUsage.Sampled,
            dimension: GfxTextureDimension.n2D,
            depthOrArrayLayers: 1,
            numLevels: 1
        });
        device.setResourceName(gfxTexture, name);
        device.uploadTextureData(gfxTexture, 0, [rgba]);
        this.gfxTexture = gfxTexture;
    }
}

export function buildTextures(device: GfxDevice, dblFile: WilburDBLFile): Texture[] {
    const textures: Texture[] = [];
    for (const chunk of dblFile.chunks) {
        if (chunk.type == WilburChunkType.Texture) {
            const t = chunk as WilburTextureChunk;
            for (const texture of t.textures) {
                textures.push(new Texture(device, texture.rgba, texture.header.width, texture.header.height, texture.header.name));
            }
        }
    }
    return textures;
}

export class TextureHeader {
    public type: number;
    public pixelOffset: number;
    public paletteOffset: number;
    public width: number;
    public height: number;
    public paletteWidth: number;
    public paletteHeight: number;
    public paletteByte: number;
    public pixelByte: number;
    public name: string;

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
        this.name = reader.string(32).split("\\").slice(-1)[0].split(".")[0];
        switch (this.type) {
            // need to add type 2
            case 8:
                this.pixelByte = 0.5;
                this.paletteByte = 4;
                break;
            case 9:
                this.pixelByte = 1;
                this.paletteByte = 4;
                break;
            case 28:
                this.pixelByte = 4;
                this.paletteByte = 0;
                break;
            default:
                console.warn("Unimplemented texture type", this.type);
                this.pixelByte = 1;
                this.paletteByte = 1;
                break;
        }
    }
}

export class TextureData {
    public rgba: Uint8Array;

    constructor(reader: BinaryReader, public header: TextureHeader, start: number) {
        const colorCount = header.paletteWidth * header.paletteHeight;
        const pixelCount = header.width * header.height;
        reader.setPointer(start + header.paletteOffset);
        const palette = reader.bytes(colorCount * header.paletteByte);
        reader.setPointer(start + header.pixelOffset);
        const indices = reader.bytes(pixelCount * header.pixelByte);

        if (header.type === 9) {
            const clut = new Uint8Array(1024);
            for (let i = 0; i < 256; i++) {
                const unswizzled = (i & 231) | ((i & 8) << 1) | ((i & 16) >> 1);
                for (let c = 0; c < 4; c++) {
                    clut[i * 4 + c] = palette[unswizzled * 4 + c];
                }
            }
            const pixels: number[] = [];
            for (let y = 0; y < header.height; y++) {
                for (let x = 0; x < header.width; x++) {
                    const colorIndex = indices[y * header.width + x];
                    const index = ((y * header.width) + x) * 4;
                    const pointer = colorIndex * 4;
                    pixels[index] = clut[pointer];
                    pixels[index + 1] = clut[pointer + 1];
                    pixels[index + 2] = clut[pointer + 2];
                    pixels[index + 3] = 255; // clut[pointer + 3];
                }
            }
            this.rgba = new Uint8Array(pixels);
        } else if (header.type === 8) {
            const clut = [];
            for (let i = 0; i < palette.length; i += header.paletteByte) {
                clut.push({ r: palette[i], g: palette[i + 1], b: palette[i + 2] });
            }
            const pixels: number[] = [];
            for (let i = 0; i < indices.length; i++) {
                const byte = indices[i];
                const index = byte & 0x0F;
                const index2 = (byte >> 4) & 0x0F;
                pixels.push(clut[index].r, clut[index].g, clut[index].b, 255);
                pixels.push(clut[index2].r, clut[index2].g, clut[index2].b, 255);
            }
            this.rgba = new Uint8Array(pixels);
        } else {
            this.rgba = new Uint8Array();
        }
    }
}
