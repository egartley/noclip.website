import { vec2 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { AABB } from "../Geometry";
import { HerosTailTextureFormat } from "./texture";

// Credit for basis of parsing: https://github.com/eurotools/eurochef

export interface HerosTailEDBFile {
    refEntities: HerosTailEntity[];
    entities: HerosTailEntity[];
    textures: HerosTailRawTexure[];
}

export interface HerosTailRawTexure {
    id: number;
    format: HerosTailTextureFormat;
    width: number;
    height: number;
    scroll: vec2;
    mips: number;
    clut: Uint8Array;
    indices: Uint8Array[];
}

export interface HerosTailEntity {
    type: HerosTailEntityType
}

interface EntityBase {
    bbox: AABB
}

interface Tristrip {
    textureId: number;
    uvs: number[];
    indices: number[];
    colors: number[];
}

export interface HerosTailMeshEntity extends HerosTailEntity, EntityBase {
    tristrips: Tristrip[];
    vertexCount: number;
    positions: number[];
}

export interface HerosTailSplitEntity extends HerosTailEntity, EntityBase {
    subEntities: HerosTailEntity[];
}

export enum HerosTailEntityType {
    MESH = 1537,
    SPLIT = 1539
}

enum SectionType {
    UNKNOWN,
    ENTITY,
    REF_ENTITY,
    TEXTURE
}

const EDB_VERSION = 240;
const EDB_MAGIC = 1195724621;

export class HerosTailParser {
    private view: DataView;
    private offset: number = 0;

    constructor(buffer: ArrayBufferSlice) {
        this.view = buffer.createDataView();
    }

    public parse(): HerosTailEDBFile {
        if (this.getUint32() !== EDB_MAGIC) {
            console.warn("Unknown EDB magic");
        }
        this.offset += 4;
        if (this.getUint32() !== EDB_VERSION) {
            console.warn("Unknown EDB version");
        }
        this.offset += 72;

        this.readSection(SectionType.UNKNOWN);
        const refEntities = this.readSection(SectionType.REF_ENTITY) as HerosTailEntity[];
        const entities = this.readSection(SectionType.ENTITY) as HerosTailEntity[];
        this.readSection(SectionType.UNKNOWN);
        this.readSection(SectionType.UNKNOWN);
        this.readSection(SectionType.UNKNOWN);
        this.readSection(SectionType.UNKNOWN);
        this.readSection(SectionType.UNKNOWN);
        this.readSection(SectionType.UNKNOWN);
        this.readSection(SectionType.UNKNOWN);
        this.readSection(SectionType.UNKNOWN);
        this.readSection(SectionType.UNKNOWN);
        this.readSection(SectionType.UNKNOWN);
        this.readSection(SectionType.UNKNOWN);
        const textures = this.readSection(SectionType.TEXTURE) as HerosTailRawTexure[];

        return { refEntities, entities, textures };
    }

    private readSection(type: SectionType): any {
        if (type === SectionType.UNKNOWN) {
            this.offset += 8;
            return undefined;
        } else {
            const ret = this.offset + 8;

            const count = this.getUshort();
            this.offset += 2;
            const infosOffset = this.offset + this.getUint32();

            let section;
            this.offset = infosOffset;
            switch (type) {
                case SectionType.REF_ENTITY:
                    section = this.getRefEntities(count);
                    break;
                case SectionType.ENTITY:
                    section = this.getEntities(count);
                    break;
                case SectionType.TEXTURE:
                    section = this.getTextures(count);
                    break;
            }

            this.offset = ret;
            return section;
        }
    }

    private getCommonInfo(): number {
        // for now just returns the absolute offset, skips the hash
        this.offset += 8;
        const offset = this.getUint32();
        this.offset += 4;
        return offset;
    }

    private getTextures(count: number): HerosTailRawTexure[] {
        const textures: HerosTailRawTexure[] = Array(count);
        for (let i = 0; i < count; i++) {
            const absoluteOffset = this.getCommonInfo();
            this.offset += 12;
            textures[i] = this.getTexture(i, absoluteOffset);
        }
        return textures;
    }

    private getTexture(id: number, offset: number): HerosTailRawTexure {
        const ret = this.offset;

        this.offset = offset;
        const width = this.getUshort();
        const height = this.getUshort();
        this.offset += 4;
        const scroll = vec2.fromValues(this.getShort(), this.getShort());
        this.offset += 6;
        const mips = this.getByte();
        const format = this.getByte() as HerosTailTextureFormat;
        this.offset += 20;
        const clutOffset = this.offset + this.getUint32();
        const indicesOffset = this.offset + this.getUint32();
        let clut;
        let indices: Uint8Array[] = Array(mips);
        switch (format) {
            case HerosTailTextureFormat.CLUT_64:
                clut = new Uint8Array(this.view.buffer, clutOffset, 64);
                for (let i = 0; i < mips; i++) {
                    const s = Math.pow(0.5, i);
                    indices[i] = new Uint8Array(this.view.buffer, indicesOffset, (s * width) * (s * height) * 0.5);
                }
                break;
            case HerosTailTextureFormat.CLUT_1024:
                clut = new Uint8Array(this.view.buffer, clutOffset, 1024);
                for (let i = 0; i < mips; i++) {
                    const s = Math.pow(0.5, i);
                    indices[i] = new Uint8Array(this.view.buffer, indicesOffset, (s * width) * (s * height));
                }
                break;
            case HerosTailTextureFormat.ARGB_16_1555:
                clut = new Uint8Array();
                for (let i = 0; i < mips; i++) {
                    const s = Math.pow(0.5, i);
                    indices[i] = new Uint8Array(this.view.buffer, indicesOffset, (s * width) * (s * height) * 2);
                }
                break;
            case HerosTailTextureFormat.RGBA_32_8888:
                clut = new Uint8Array();
                for (let i = 0; i < mips; i++) {
                    const s = Math.pow(0.5, i);
                    indices[i] = new Uint8Array(this.view.buffer, indicesOffset, (s * width) * (s * height) * 4);
                }
                break;
            default:
                clut = new Uint8Array();
                indices = [new Uint8Array()];
                console.warn("Texture", id, "has unimplemented format", format);
                break;
        }

        this.offset = ret;
        return { id, format, width, height, scroll, mips, clut, indices };
    }

    private getEntities(count: number): HerosTailEntity[] {
        const entities: HerosTailEntity[] = Array(count);
        for (let i = 0; i < count; i++) {
            const absoluteOffset = this.getCommonInfo();
            this.offset += 4;
            entities[i] = this.getEntity(absoluteOffset);
        }
        return entities;
    }

    private getRefEntities(count: number): HerosTailEntity[] {
        const entities: HerosTailEntity[] = Array(count);
        for (let i = 0; i < count; i++) {
            this.offset += 8;
            const absoluteOffset = this.getUint32();
            this.offset += 4;
            entities[i] = this.getEntity(absoluteOffset);
        }
        return entities;
    }

    private getEntity(offset: number): HerosTailEntity {
        const ret = this.offset;

        this.offset = offset;
        const type = this.getUint32();
        let entity = { type };
        switch (type) {
            case HerosTailEntityType.MESH:
                entity = this.getMeshEntity();
                break;
            case HerosTailEntityType.SPLIT:
                entity = this.getSplitEntity();
                break;
        }

        this.offset = ret;
        return entity;
    }

    private getEntityBase(): EntityBase {
        const flags = this.getUint32();
        this.offset += 8;
        const xyzw = Array(8);
        for (let i = 0; i < xyzw.length; i++) {
            xyzw[i] = this.getFloat();
        }
        const bbox = new AABB(xyzw[0], xyzw[1], xyzw[2], xyzw[4], xyzw[5], xyzw[6]);
        this.offset += 16; // unk 4 floats
        this.offset += 20;

        return { bbox };
    }

    private getMeshEntity(): HerosTailMeshEntity {
        const base = this.getEntityBase();

        const textureListOffset = this.offset + this.getUint32();
        const tristripOffset = this.offset + this.getUint32();
        const vertexOffset = this.offset + this.getUint32();
        this.offset += 8;
        const tristripCount = this.getUshort();
        const vertexCount = this.getUshort();

        this.offset = tristripOffset;
        const tristrips: Tristrip[] = Array(tristripCount);
        for (let i = 0; i < tristripCount; i++) {
            const count = this.getUshort() + 2;
            const textureId = this.getUshort();
            this.offset += 12;
            const uvs: number[] = [];
            const indices: number[] = [];
            const colors: number[] = [];
            for (let j = 0; j < count; j++) {
                uvs.push(this.getFloat(), this.getFloat());
                indices.push(this.getUshort());
                this.offset += 2;
                colors.push(this.getByte(), this.getByte(), this.getByte(), this.getByte());
            }
            tristrips[i] = { textureId, uvs, indices, colors };
        }

        this.offset = vertexOffset;
        const positions: number[] = [];
        for (let i = 0; i < vertexCount; i++) {
            positions.push(this.getFloat(), this.getFloat(), this.getFloat());
            this.offset += 4;
        }

        return { type: HerosTailEntityType.MESH, bbox: base.bbox, vertexCount, tristrips, positions };
    }

    private getSplitEntity(): HerosTailSplitEntity {
        const base = this.getEntityBase();
        const count = this.getUint32();
        this.offset += 4;
        const subEntities: HerosTailEntity[] = Array(count);
        for (let i = 0; i < count; i++) {
            const ret = this.offset;
            const offset = this.offset + this.getUint32();
            subEntities[i] = this.getEntity(offset);
            this.offset = ret + 4;
        }
        return { type: HerosTailEntityType.SPLIT, bbox: base.bbox, subEntities };
    }

    private getUint32(): number {
        const n = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return n;
    }

    private getFloat(): number {
        const n = this.view.getFloat32(this.offset, true);
        this.offset += 4;
        return n;
    }

    private getShort(): number {
        const n = this.view.getInt16(this.offset, true);
        this.offset += 2;
        return n;
    }

    private getUshort(): number {
        const n = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return n;
    }

    private getByte(): number {
        const n = this.view.getUint8(this.offset);
        this.offset += 1;
        return n;
    }
}
