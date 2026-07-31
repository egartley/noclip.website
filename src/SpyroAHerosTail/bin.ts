import { vec2, vec3 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { AABB } from "../Geometry";
import { HerosTailTextureFormat } from "./texture";

// Credit for basis of parsing: https://github.com/eurotools/eurochef

export interface HerosTailEDBFile {
    refEntities: HerosTailEntity[];
    entities: HerosTailEntity[];
    maps: HerosTailMap[];
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
    hash: number;
    type: HerosTailEntityType;
    bbox: AABB;
}

export interface HerosTailMap {
    placements: HerosTailPlacement[];
}

export interface HerosTailPlacement {
    position: vec3;
    rotation: vec3;
    scale: vec3;
    flags: number;
    engineFlags: number;
    map: number;
    entityHash: number;
    group: number;
}

interface CommonInfo {
    hash: number;
    unknown: number;
    offset: number;
}

interface EntityBase {
    flags: number;
    bbox: AABB;
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
    textureIds: number[];
}

export interface HerosTailSplitEntity extends HerosTailEntity, EntityBase {
    subEntities: HerosTailEntity[];
}

export enum HerosTailEntityType {
    MESH = 1537,
    SPLIT = 1539,
    INSTANCE = 1542,
    MAP_ZONE = 1544
}

enum SectionType {
    UNUSED,
    ENTITY,
    REF_ENTITY,
    TEXTURE,
    MAP
}

const EDB_VERSION = 240;
const EDB_MAGIC = 1195724621;
const MAP_CHECK = 1280;

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

        this.readSection(SectionType.UNUSED);
        const refEntities = this.readSection(SectionType.REF_ENTITY) as HerosTailEntity[];
        const entities = this.readSection(SectionType.ENTITY) as HerosTailEntity[];
        this.readSection(SectionType.UNUSED); // animations
        this.readSection(SectionType.UNUSED); // animation skins
        this.readSection(SectionType.UNUSED); // animation scripts
        const maps = this.readSection(SectionType.MAP) as HerosTailMap[];
        this.readSection(SectionType.UNUSED); // animation modes
        this.readSection(SectionType.UNUSED); // animation sets
        this.readSection(SectionType.UNUSED); // particles
        this.readSection(SectionType.UNUSED); // swooshes (???)
        this.readSection(SectionType.UNUSED); // spreadsheets
        this.readSection(SectionType.UNUSED); // fonts
        this.readSection(SectionType.UNUSED); // unknown
        const textures = this.readSection(SectionType.TEXTURE) as HerosTailRawTexure[];

        return { refEntities, entities, maps, textures };
    }

    private readSection(type: SectionType): any {
        if (type === SectionType.UNUSED) {
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
                case SectionType.MAP:
                    section = this.getMaps(count);
                    break;
            }

            this.offset = ret;
            return section;
        }
    }

    private getCommonInfo(): CommonInfo {
        const hash = this.getUint32();
        const unknown = this.getUint32();
        const offset = this.getUint32();
        this.offset += 4;
        return { hash, unknown, offset };
    }

    private getTextures(count: number): HerosTailRawTexure[] {
        const textures: HerosTailRawTexure[] = Array(count);
        for (let i = 0; i < count; i++) {
            const common = this.getCommonInfo();
            this.offset += 12;
            textures[i] = this.getTexture(common, i);
        }
        return textures;
    }

    private getTexture(common: CommonInfo, id: number): HerosTailRawTexure {
        const ret = this.offset;

        this.offset = common.offset;
        const width = this.getUshort();
        const height = this.getUshort();
        this.offset += 4;
        const scroll = vec2.fromValues(this.getShort(), this.getShort());
        this.offset += 6;
        let mips = this.getByte();
        const format = this.getByte() as HerosTailTextureFormat;
        this.offset += 20;
        const clutOffset = this.offset + this.getUint32();
        const indicesOffset = this.offset + this.getUint32();

        // temp workaround for broken mips for 4-bit textures
        if (format === HerosTailTextureFormat.CLUT_64) {
            mips = 1;
        }

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
            const common = this.getCommonInfo();
            this.offset += 4;
            entities[i] = this.getEntity(common);
        }
        return entities;
    }

    private getRefEntities(count: number): HerosTailEntity[] {
        const entities: HerosTailEntity[] = Array(count);
        for (let i = 0; i < count; i++) {
            const common = this.getCommonInfo();
            entities[i] = this.getEntity(common);
        }
        return entities;
    }

    private getEntity(common: CommonInfo): HerosTailEntity {
        const ret = this.offset;

        this.offset = common.offset;
        const type = this.getUint32();
        let entity = { hash: common.hash, type, bbox: new AABB() };
        switch (type) {
            case HerosTailEntityType.MESH:
                entity = this.getMeshEntity(entity);
                break;
            case HerosTailEntityType.SPLIT:
                entity = this.getSplitEntity(entity);
                break;
            default:
                console.warn("Unimplemented entity type", type, "at", this.offset - 4);
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

        return { flags, bbox };
    }

    private getMeshEntity(template: HerosTailEntity): HerosTailMeshEntity {
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
                indices.push(this.getUshort()); // packed index and restart flag
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

        this.offset = textureListOffset;
        const textureIdCount = this.getUshort();
        const textureIds = Array(textureIdCount);
        for (let i = 0; i < textureIdCount; i++) {
            textureIds[i] = this.getUshort();
        }

        return { hash: template.hash, type: HerosTailEntityType.MESH, flags: base.flags, bbox: base.bbox, vertexCount, tristrips, positions, textureIds };
    }

    private getSplitEntity(template: HerosTailEntity): HerosTailSplitEntity {
        const base = this.getEntityBase();
        const count = this.getUint32();
        this.offset += 4;
        const subEntities: HerosTailEntity[] = Array(count);
        for (let i = 0; i < count; i++) {
            const ret = this.offset;
            const offset = this.offset + this.getUint32();
            subEntities[i] = this.getEntity({ hash: 0, offset, unknown: 0 });
            this.offset = ret + 4;
        }
        return { hash: template.hash, type: HerosTailEntityType.SPLIT, flags: base.flags, bbox: base.bbox, subEntities };
    }

    private getMaps(count: number): HerosTailMap[] {
        const maps: HerosTailMap[] = Array(count);
        for (let i = 0; i < count; i++) {
            const common = this.getCommonInfo();
            maps[i] = this.getMap(common);
        }
        return maps;
    }

    private getMap(common: CommonInfo): HerosTailMap {
        const ret = this.offset;

        this.offset = common.offset;
        const check = this.getUint32();
        if (check !== MAP_CHECK) {
            console.warn("Map check failed at", this.offset - 4);
        }
        this.offset += 68;
        const placementCount = this.getUint32();

        const ret2 = this.offset + 4;
        const placementOffset = this.offset + this.getUint32();
        this.offset = placementOffset;

        const placements = Array(placementCount);
        for (let i = 0; i < placementCount; i++) {
            placements[i] = this.getPlacement();
        }
        this.offset = ret2;
        this.offset += 52;
        // zones

        this.offset = ret;
        return { placements };
    }

    private getPlacement(): HerosTailPlacement {
        this.offset += 4;
        const position = vec3.fromValues(this.getFloat(), this.getFloat(), this.getFloat());
        const flags = this.getUint32();
        const rotation = vec3.fromValues(this.getFloat(), this.getFloat(), this.getFloat());
        const scale = vec3.fromValues(this.getFloat(), this.getFloat(), this.getFloat());
        const engineFlags = this.getUshort();
        const map = this.getUshort();
        const entityHash = this.getUint32();
        this.offset += 2;
        const group = this.getShort();
        this.offset += 4;
        return { position, rotation, scale, flags, engineFlags, map, entityHash, group };
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
