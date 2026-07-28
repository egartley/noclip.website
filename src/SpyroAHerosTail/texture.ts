import { vec2 } from "gl-matrix";
import { HerosTailRawTexure } from "./bin";
import { GfxTexture } from "../gfx/platform/GfxPlatformImpl";
import { GfxDevice, GfxFormat, GfxTextureDimension, GfxTextureUsage } from "../gfx/platform/GfxPlatform";

export enum HerosTailTextureFormat {
    CLUT_64 = 1,
    CLUT_1024 = 3,
    ARGB_16_1555 = 4,
    RGBA_32_8888 = 5
}

export class HerosTailTexture {
    public gfxTexture: GfxTexture;

    constructor(device: GfxDevice, public id: number, public width: number, public height: number, rgba: Uint8Array[], public format: HerosTailTextureFormat, public scroll: vec2) {
        const gfxTexture = device.createTexture({
            width, height,
            pixelFormat: GfxFormat.U8_RGBA_NORM,
            usage: GfxTextureUsage.Sampled,
            dimension: GfxTextureDimension.n2D,
            depthOrArrayLayers: 1, numLevels: rgba.length
        });
        device.setResourceName(gfxTexture, `texture_${id}`);
        device.uploadTextureData(gfxTexture, 0, rgba);
        this.gfxTexture = gfxTexture;
    }
}

const INTERLACE_MATRIX = [0x00, 0x10, 0x02, 0x12, 0x11, 0x01, 0x13, 0x03];
const BPP_4_MATRIX = [0, 1, -1, 0];
const TILE_MATRIX = [4, -4];

export function decodeHerosTailTexture(raw: HerosTailRawTexure): Uint8Array[] {
    switch (raw.format) {
        case HerosTailTextureFormat.ARGB_16_1555:
            {
                const mips = Array(raw.mips);
                for (let i = 0; i < raw.mips; i++) {
                    const width = raw.width * Math.pow(0.5, i);
                    const height = raw.height * Math.pow(0.5, i);
                    const rgba = new Uint8Array(width * height * 4);
                    for (let j = 0; j < raw.indices[i].length; j += 2) {
                        const pixel = (raw.indices[i][j + 1] << 8) | raw.indices[i][j];
                        const a = (pixel >> 15) & 1;
                        const r = (pixel >> 10) & 31;
                        const g = (pixel >> 5) & 31;
                        const b = pixel & 31;
                        rgba[j * 2] = (r << 3) | (r >> 2);
                        rgba[(j * 2) + 1] = (g << 3) | (g >> 2);
                        rgba[(j * 2) + 2] = (b << 3) | (b >> 2);
                        rgba[(j * 2) + 3] = a ? 0 : 255;
                    }
                    mips[i] = rgba;
                }
                return mips;
            }
        case HerosTailTextureFormat.RGBA_32_8888:
            return raw.indices;
        case HerosTailTextureFormat.CLUT_64:
            {
                // Credit: https://github.com/eurotools/eurochef/blob/main/eurochef/shared/src/platform/texture/ps2.rs
                const mips = Array(raw.mips);
                for (let i = 0; i < raw.mips; i++) {
                    const width = raw.width * Math.pow(0.5, i);
                    const height = raw.height * Math.pow(0.5, i);
                    const pixelCount = width * height;
                    const pixels = new Uint8Array(pixelCount);
                    const indices = new Uint8Array(pixelCount);
                    let d = 0;
                    let s = 0;
                    for (let h = 0; h < height; h++) {
                        for (let w = 0; w < (width >> 1); w++) {
                            const p = raw.indices[i][s++];
                            pixels[d++] = p & 15;
                            pixels[d++] = p >> 4;
                        }
                    }
                    for (let y = 0; y < height; y++) {
                        for (let x = 0; x < width; x++) {
                            const isOdd = (y & 1) !== 0;
                            const xx = x + (Math.floor(y / 4) & 1) * TILE_MATRIX[Math.floor(x / 4) & 1];
                            const yy = y + BPP_4_MATRIX[y % 4];
                            const i = INTERLACE_MATRIX[(Math.floor(x / 4) % 4) + (isOdd ? 4 : 0)] + ((x * 4) % 16) + (Math.floor(x / 16) * 32) + ((y & ~1) * width);
                            const j = yy * width + xx;
                            indices[j] = i < pixels.length ? pixels[i] : pixels[pixels.length - 1];
                        }
                    }
                    const rgba = new Uint8Array(pixelCount * 4);
                    for (let j = 0; j < pixelCount; j++) {
                        const pixelIndex = j * 4;
                        const colorIndex = indices[j] * 4;
                        rgba[pixelIndex] = raw.clut[colorIndex];
                        rgba[pixelIndex + 1] = raw.clut[colorIndex + 1];
                        rgba[pixelIndex + 2] = raw.clut[colorIndex + 2];
                        rgba[pixelIndex + 3] = raw.clut[colorIndex + 3];
                    }
                    mips[i] = rgba;
                }
                return mips;
            }
        case HerosTailTextureFormat.CLUT_1024:
            {
                const mips = Array(raw.mips);
                for (let i = 0; i < raw.mips; i++) {
                    const clut = new Uint8Array(1024);
                    for (let j = 0; j < 256; j++) {
                        const unswizzled = (j & 231) | ((j & 8) << 1) | ((j & 16) >> 1);
                        for (let c = 0; c < 4; c++) {
                            clut[j * 4 + c] = raw.clut[unswizzled * 4 + c];
                        }
                    }
                    const width = raw.width * Math.pow(0.5, i);
                    const height = raw.height * Math.pow(0.5, i);
                    const rgba = new Uint8Array(width * height * 4);
                    for (let y = 0; y < height; y++) {
                        for (let x = 0; x < width; x++) {
                            const blockLocation = (y & -16) * width + (x & -16) * 2;
                            const swapSelector = (((y + 2) >> 2) & 1) * 4;
                            const posY = (((y & -4) >> 1) + (y & 1)) & 7;
                            const columnLocation = posY * width * 2 + ((x + swapSelector) & 7) * 4;
                            const byteNum = ((y >> 1) & 1) + ((x >> 2) & 2);
                            const pixelIndex = ((y * width) + x) * 4;
                            const colorIndex = raw.indices[i][blockLocation + columnLocation + byteNum];
                            rgba[pixelIndex] = clut[colorIndex * 4];
                            rgba[pixelIndex + 1] = clut[(colorIndex * 4) + 1];
                            rgba[pixelIndex + 2] = clut[(colorIndex * 4) + 2];
                            rgba[pixelIndex + 3] = clut[(colorIndex * 4) + 3];
                        }
                    }
                    mips[i] = rgba;
                }
                return mips;
            }
        default:
            console.warn("Unimplemented texture format", raw.format);
            return raw.indices;
    }
}