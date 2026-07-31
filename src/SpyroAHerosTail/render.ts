import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { fillMatrix4x4 } from "../gfx/helpers/UniformBufferHelpers";
import { GfxDevice, GfxBufferUsage, GfxBufferFrequencyHint, GfxFormat, GfxVertexBufferFrequency, GfxBindingLayoutDescriptor, GfxIndexBufferDescriptor, GfxVertexBufferDescriptor, GfxSamplerBinding, GfxMipFilterMode, GfxTexFilterMode, GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { GfxInputLayout, GfxProgram } from "../gfx/platform/GfxPlatformImpl";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { DeviceProgram } from "../Program";
import { ViewerRenderInput } from "../viewer";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers";
import { HerosTailEDBFile, HerosTailEntity, HerosTailEntityType, HerosTailMeshEntity, HerosTailSplitEntity } from "./bin";
import { HerosTailTexture } from "./texture";
import { TextureMapping } from "../TextureHolder";
import { mat4, ReadonlyMat4, vec2, vec3 } from "gl-matrix";
import { computeModelMatrixSRT } from "../MathHelpers";
import { White } from "../Color";
import { AABB } from "../Geometry";

enum EntityFlags {
    USE_TEXTURE_LIST = 1
}

interface DrawCall {
    textureId: number;
    indexOffset: number;
    indexCount: number;
}

interface RenderData {
    positions: number[];
    colors: number[];
    uvs: number[];
}

interface Material {
    samplers: GfxSamplerBinding[];
    scroll: vec2;
}

class Shader extends DeviceProgram {
    public static ub_SceneParams = 0;
    public static ub_InstanceParams = 1;
    public static ub_DrawParams = 2;

    public override both = `
precision highp float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_ProjView;
    float u_Time;
};

layout(std140) uniform ub_InstanceParams {
    Mat4x4 u_Shift;
};

layout(std140) uniform ub_DrawParams {
    vec2 u_Scroll;
};

uniform sampler2D u_Texture;

varying vec4 v_Color;
varying vec2 v_UV;

#ifdef VERT
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec4 a_Color;
layout(location = 2) in vec2 a_UV;

void main() {
    v_Color = a_Color;
    v_UV = a_UV + (u_Time * u_Scroll);
    gl_Position = UnpackMatrix(u_ProjView) * UnpackMatrix(u_Shift) * vec4(a_Position, 1.0);
}
#endif

#ifdef FRAG
void main() {
    vec4 texColor = texture(SAMPLER_2D(u_Texture), v_UV);
    if (texColor.a < 0.1) {
        discard;
    }
    gl_FragColor = texColor * vec4(clamp(v_Color.rgb + vec3(0.2), 0.0, 1.0), v_Color.a);
}
#endif
    `;
}

const WORLD_SCALE = 200.0;
const FRAME_TIME_30 = 0.03;
const TRISTRIP_RESTART = 0x5000;
const NOCLIP_SPACE_CORRECTION = mat4.fromValues(
    -1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
);
const SCROLL_SCALE = vec2.fromValues(0.00005, 0.00005);
const SCRATCH_MVP = mat4.create();
const BINDING_LAYOUTS: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 3, numSamplers: 1 }];

function computeShiftMatrix(scale: vec3, rotation: vec3, position: vec3) {
    const srt = mat4.create();
    computeModelMatrixSRT(srt,
        scale[0] * WORLD_SCALE, scale[1] * WORLD_SCALE, scale[2] * WORLD_SCALE,
        rotation[0], rotation[1], rotation[2],
        position[0] * WORLD_SCALE, position[1] * WORLD_SCALE, position[2] * WORLD_SCALE
    );
    mat4.mul(srt, NOCLIP_SPACE_CORRECTION, srt);
    return srt;
}

function inView(bbox: Float32Array, m: ReadonlyMat4) {
    // cheaper frustum culling than with aabb
    let aol = true, aor = true;
    let aob = true, aot = true;
    let aon = true, aof = true;
    for (let i = 0; i < 26; i += 3) {
        const x = bbox[i], y = bbox[i + 1], z = bbox[i + 2];
        const xw = x * m[0] + y * m[4] + z * m[8] + m[12];
        const yw = x * m[1] + y * m[5] + z * m[9] + m[13];
        const zw = x * m[2] + y * m[6] + z * m[10] + m[14];
        const ww = x * m[3] + y * m[7] + z * m[11] + m[15];
        if (xw >= -ww && xw <= ww && yw >= -ww && yw <= ww && zw >= 0 && zw <= ww) {
            return true;
        }
        if (xw > -ww) aol = false;
        if (xw < ww) aor = false;
        if (yw > -ww) aob = false;
        if (yw < ww) aot = false;
        if (zw > 0) aon = false;
        if (zw < ww) aof = false;
    }
    if (aol || aor || aob || aot || aon || aof) {
        return false;
    }
    return true;
}

export class HerosTailRenderer {
    public refEntities: EntityRenderer[];
    public entities: EntityRenderer[];
    private gfxProgram: GfxProgram;
    private inputLayout: GfxInputLayout;
    private materials: Map<number, Material>;

    constructor(cache: GfxRenderCache, edb: HerosTailEDBFile, textures: HerosTailTexture[]) {
        this.gfxProgram = cache.createProgram(new Shader());

        const gfxSampler = cache.createSampler({
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Nearest,
            wrapS: GfxWrapMode.Repeat,
            wrapT: GfxWrapMode.Repeat
        });
        this.materials = new Map();
        for (let i = 0; i < textures.length; i++) {
            const tm = new TextureMapping();
            // scroll values are scaled down to approximately match the game
            const scroll = vec2.create();
            vec2.mul(scroll, textures[i].scroll, SCROLL_SCALE);
            tm.gfxTexture = textures[i].gfxTexture;
            tm.gfxSampler = gfxSampler;
            this.materials.set(i, { samplers: [tm], scroll });
        }

        this.refEntities = [];
        for (let i = 0; i < edb.refEntities.length; i++) {
            const entity = edb.refEntities[i];
            if (entity.type === HerosTailEntityType.SPLIT || entity.type === HerosTailEntityType.MESH) {
                // ref entities are rooted to origin, so their shift matrix is identity
                const er = new EntityRenderer(cache, `ref_${i}`, entity, computeShiftMatrix([1, 1, 1], [0, 0, 0], [0, 0, 0]));
                if (er.drawCount > 0) {
                    this.refEntities.push(er);
                } else {
                    er.destroy(cache.device);
                }
            }
        }

        this.entities = [];
        for (let i = 0; i < edb.maps.length; i++) {
            if (i > 0) {
                // only first map for now
                console.warn("Skipping subsequent maps...");
                break;
            }
            for (const placement of edb.maps[i].placements) {
                const entity = edb.entities.find(e => e.hash === placement.entityHash);
                if (!entity) {
                    console.warn("Could not find entity with hash of", placement.entityHash);
                    continue;
                } else if (entity.type !== HerosTailEntityType.MESH && entity.type !== HerosTailEntityType.SPLIT) {
                    console.warn("Unimplemented placement for entity type", entity.type);
                    continue;
                } else {
                    const i = this.entities.findIndex(er => er.name === placement.entityHash.toString());
                    const shift = computeShiftMatrix(placement.scale, placement.rotation, placement.position);
                    if (i < 0) {
                        const er = new EntityRenderer(cache, placement.entityHash.toString(), entity, shift);
                        if (er.drawCount > 0) {
                            this.entities.push(er);
                        } else {
                            er.destroy(cache.device);
                        }
                    } else {
                        this.entities[i].shiftMatrices.push(shift);
                    }
                }
            }
        }

        this.inputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                { location: 0, bufferIndex: 0, format: GfxFormat.F32_RGB, bufferByteOffset: 0 },
                { location: 1, bufferIndex: 1, format: GfxFormat.F32_RGBA, bufferByteOffset: 0 },
                { location: 2, bufferIndex: 2, format: GfxFormat.F32_RG, bufferByteOffset: 0 }
            ],
            vertexBufferDescriptors: [
                { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex },
                { byteStride: 16, frequency: GfxVertexBufferFrequency.PerVertex },
                { byteStride: 8, frequency: GfxVertexBufferFrequency.PerVertex }
            ],
            indexBufferFormat: GfxFormat.U32_R
        });
    }

    public prepareToRender(device: GfxDevice, renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput) {
        const template = renderHelper.renderInstManager.pushTemplate();
        template.setGfxProgram(this.gfxProgram);
        template.setBindingLayouts(BINDING_LAYOUTS);
        template.setUniformBuffer(renderHelper.uniformBuffer);

        let offs = template.allocateUniformBuffer(Shader.ub_SceneParams, 17);
        const d = template.mapUniformBufferF32(Shader.ub_SceneParams);
        // u_ProjView (16)
        offs += fillMatrix4x4(d, offs, viewerInput.camera.clipFromWorldMatrix);
        // u_Time (1)
        d[offs++] = viewerInput.time * FRAME_TIME_30;

        for (const e of this.refEntities) {
            if (e.visible) {
                e.prepareToRender(device, renderHelper, viewerInput, this.inputLayout, this.materials);
            }
        }

        for (const e of this.entities) {
            if (e.visible) {
                e.prepareToRender(device, renderHelper, viewerInput, this.inputLayout, this.materials);
            }
        }

        renderHelper.renderInstManager.popTemplate();
    }

    public destroy(device: GfxDevice) {
        for (const e of [...this.refEntities, ...this.entities]) {
            e.destroy(device);
        }
    }
}

class EntityRenderer {
    public drawCount: number;
    public visible: boolean = true;
    public shiftMatrices: mat4[] = [];
    private baseEntityFlags: number;
    private drawCalls: DrawCall[] = [];
    private bboxPoints: Float32Array;
    private indexBufferDescriptor: GfxIndexBufferDescriptor;
    private vertexBufferDescriptors: GfxVertexBufferDescriptor[];

    constructor(cache: GfxRenderCache, public name: string, entity: HerosTailEntity, shiftMatrix?: mat4) {
        const device = cache.device;
        if (shiftMatrix) {
            this.shiftMatrices = [shiftMatrix];
        } else {
            this.shiftMatrices = [mat4.create()];
        }

        let vertices: number[] = [];
        let colors: number[] = [];
        let uvs: number[] = [];
        let indices: number[] = [];
        const sortedIndices = new Map<number, number[]>();
        switch (entity.type) {
            case HerosTailEntityType.MESH:
                {   
                    const e = entity as HerosTailMeshEntity;
                    this.baseEntityFlags = e.flags;
                    const { positions: p, colors: c, uvs: u } = this.buildRenderData(e, 0, sortedIndices);
                    vertices = p;
                    colors = c;
                    uvs = u;
                }
                break;
            case HerosTailEntityType.SPLIT:
                {
                    const e = entity as HerosTailSplitEntity;
                    this.baseEntityFlags = e.flags;
                    let vertexOffset = 0;
                    const addMeshEntity = (ee: HerosTailMeshEntity) => {
                        const { positions: p, colors: c, uvs: u } = this.buildRenderData(ee, vertexOffset, sortedIndices);
                        vertexOffset += p.length / 3;
                        vertices.push(...p);
                        colors.push(...c);
                        uvs.push(...u);
                    }
                    const process = (e: HerosTailEntity) => {
                        if (e.type === HerosTailEntityType.SPLIT) {
                            const ee = e as HerosTailSplitEntity;
                            for (const se of ee.subEntities) {
                                process(se);
                            }
                        } else if (e.type === HerosTailEntityType.MESH) {
                            addMeshEntity(e as HerosTailMeshEntity);
                        }
                    }
                    for (const subEntity of e.subEntities) {
                        process(subEntity);
                    }
                }
                break;
            default:
                this.baseEntityFlags = 0;
                break;
        }

        for (const [textureId, texIndices] of sortedIndices.entries()) {
            if (texIndices.length === 0) {
                continue;
            }
            this.drawCalls.push({
                textureId,
                indexOffset: indices.length,
                indexCount: texIndices.length
            });
            indices.push(...texIndices);
        }

        this.drawCount = indices.length;
        this.bboxPoints = new Float32Array([
            entity.bbox.min[0], entity.bbox.min[1], entity.bbox.min[2],
            entity.bbox.max[0], entity.bbox.min[1], entity.bbox.min[2],
            entity.bbox.min[0], entity.bbox.max[1], entity.bbox.min[2],
            entity.bbox.max[0], entity.bbox.max[1], entity.bbox.min[2],
            entity.bbox.min[0], entity.bbox.min[1], entity.bbox.max[2],
            entity.bbox.max[0], entity.bbox.min[1], entity.bbox.max[2],
            entity.bbox.min[0], entity.bbox.max[1], entity.bbox.max[2],
            entity.bbox.max[0], entity.bbox.max[1], entity.bbox.max[2]
        ]);

        this.vertexBufferDescriptors = [
            { buffer: createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(vertices).buffer), byteOffset: 0 },
            { buffer: createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(colors.map(c => c / 255)).buffer), byteOffset: 0 },
            { buffer: createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(uvs).buffer), byteOffset: 0 }
        ];
        this.indexBufferDescriptor = { buffer: createBufferFromData(cache.device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, new Uint32Array(indices).buffer), byteOffset: 0 };
    }

    private buildRenderData(entity: HerosTailMeshEntity, vertexOffset = 0, sortedIndices: Map<number, number[]>): RenderData {
        // this handles the overly complicated tristrip structs
        // they can have duplicate indices, UVs and colors and all need to be kept in order
        // positions are handled are too (although not stored in the tristrip structs) since unique vertices need to be built

        const positions: number[] = [];
        const colors: number[] = [];
        const uvs: number[] = [];

        let currentLocalVertexCount = 0;
        const uniqueVertices = new Map<string, number>();
        for (const tristrip of entity.tristrips) {
            // textures ids are either relative to entity's own list of ids or relative to the edb-level texture list
            const tid = (this.baseEntityFlags & EntityFlags.USE_TEXTURE_LIST) !== 0 ? entity.textureIds[tristrip.textureId] : tristrip.textureId;
            if (!sortedIndices.has(tid)) {
                sortedIndices.set(tid, []);
            }
            const indices = sortedIndices.get(tid)!;

            // substrips are needed to account for the weird way restarts are marked (packed into the index for some reason...)
            const substrips: number[][] = [];
            let substrip: number[] = [];
            for (let i = 0; i < tristrip.indices.length; i++) {
                const index = tristrip.indices[i] & 0x0FFF;
                const flag = tristrip.indices[i] & 0xF000;
                const cr = tristrip.colors[i * 4];
                const cg = tristrip.colors[i * 4 + 1];
                const cb = tristrip.colors[i * 4 + 2];
                const ca = tristrip.colors[i * 4 + 3];
                const u = tristrip.uvs[i * 2];
                const v = tristrip.uvs[i * 2 + 1];

                // this is lazy/messy but it works...
                const key = `${index}_${u}_${v}_${cr}_${cg}_${cb}_${ca}`;
                let remappedIndex: number;
                if (uniqueVertices.has(key)) {
                    remappedIndex = uniqueVertices.get(key)!;
                } else {
                    remappedIndex = currentLocalVertexCount++;
                    uniqueVertices.set(key, remappedIndex);
                    positions.push(
                        entity.positions[index * 3],
                        entity.positions[index * 3 + 1],
                        entity.positions[index * 3 + 2]
                    );
                    colors.push(cr, cg, cb, ca);
                    uvs.push(u, v);
                }

                if (flag === TRISTRIP_RESTART && substrip.length > 0) {
                    substrips.push(substrip);
                    substrip = [];
                }
                substrip.push(remappedIndex);
            }

            if (substrip.length > 0) {
                substrips.push(substrip);
            }

            for (const strip of substrips) {
                for (let i = 0; i < strip.length - 2; i++) {
                    const a = vertexOffset + strip[i];
                    const b = vertexOffset + strip[i + 1];
                    const c = vertexOffset + strip[i + 2];
                    if (a === b || b === c || a === c) {
                        continue;
                    }
                    if (i % 2 === 0) {
                        indices.push(a, b, c);
                    } else {
                        indices.push(a, c, b);
                    }
                }
            }
        }

        return { positions, colors, uvs };
    }

    public setVisible(v: boolean): void {
        this.visible = v;
    }

    public prepareToRender(device: GfxDevice, renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput, inputLayout: GfxInputLayout, materials: Map<number, Material>) {
        const template = renderHelper.renderInstManager.pushTemplate();
        template.setVertexInput(inputLayout, this.vertexBufferDescriptors, this.indexBufferDescriptor);
        for (const shift of this.shiftMatrices) {
            mat4.mul(SCRATCH_MVP, viewerInput.camera.clipFromWorldMatrix, shift);
            if (!inView(this.bboxPoints, SCRATCH_MVP)) {
                continue;
            }
            const template2 = renderHelper.renderInstManager.pushTemplate();
            let offs = template2.allocateUniformBuffer(Shader.ub_InstanceParams, 16);
            const d = template2.mapUniformBufferF32(Shader.ub_InstanceParams);
            // u_Shift (16)
            offs += fillMatrix4x4(d, offs, shift);

            for (const dc of this.drawCalls) {
                const renderInst = renderHelper.renderInstManager.newRenderInst();
                const mat = materials.get(dc.textureId)!;

                offs = renderInst.allocateUniformBuffer(Shader.ub_DrawParams, 2);
                const d = renderInst.mapUniformBufferF32(Shader.ub_DrawParams);
                // u_Scroll (2)
                d[offs++] = mat.scroll[0];
                d[offs++] = mat.scroll[1];

                renderInst.setSamplerBindingsFromTextureMappings(mat.samplers);
                renderInst.setDrawCount(dc.indexCount, dc.indexOffset);

                renderHelper.renderInstManager.submitRenderInst(renderInst);
            }

            renderHelper.renderInstManager.popTemplate();
        }
        renderHelper.renderInstManager.popTemplate();
    }

    public destroy(device: GfxDevice) {
        device.destroyBuffer(this.indexBufferDescriptor.buffer);
        for (const d of this.vertexBufferDescriptors) {
            device.destroyBuffer(d.buffer);
        }
    }
}
