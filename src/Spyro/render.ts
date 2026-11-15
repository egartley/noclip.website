import { mat4, vec3 } from "gl-matrix";
import { defaultMegaState, makeMegaState, setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { fillMatrix4x4 } from "../gfx/helpers/UniformBufferHelpers";
import { GfxDevice, GfxBufferUsage, GfxBufferFrequencyHint, GfxFormat, GfxVertexBufferFrequency, GfxBindingLayoutDescriptor, GfxTexFilterMode, GfxWrapMode, GfxMipFilterMode, GfxCompareMode, GfxCullMode, GfxIndexBufferDescriptor, GfxVertexBufferDescriptor, GfxMegaStateDescriptor, GfxSamplerBinding, GfxBlendMode, GfxBlendFactor } from "../gfx/platform/GfxPlatform";
import { GfxInputLayout, GfxProgram } from "../gfx/platform/GfxPlatformImpl";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { DeviceProgram } from "../Program";
import { ViewerRenderInput } from "../viewer";
import { SpyroSkybox, SpyroLevel, SpyroMobyInstance, SpyroGroundPart } from "./bin";
import { GfxRendererLayer, GfxRenderInst, GfxRenderInstManager, makeSortKey } from "../gfx/render/GfxRenderInstManager";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers";
import { colorNewFromRGBA, White } from "../Color";
import { DebugDrawFlags } from "../gfx/helpers/DebugDraw";
import { Destroyable } from "../SceneBase";
import { computeViewMatrixSkybox } from "../Camera";
import { SpyroBlendMode, SpyroTexture } from "./texture";

class Shader extends DeviceProgram {
    public static ub_SceneParams = 0;
    public static ub_DrawParams = 1;

    public override both = `
precision highp float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_VPM;
    float u_Time;
};

layout(std140) uniform ub_DrawParams {
    float u_ApplyTextures;
    float u_Scroll;
    float u_IsWater;
    float u_TexelFilter;
};

uniform sampler2D u_Texture;

varying vec3 v_Color;
varying vec2 v_UV;

#ifdef VERT
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec3 a_Color;
layout(location = 2) in vec2 a_UV;

void main() {
    v_Color = a_Color;
    v_UV = a_UV;

    vec3 pos = a_Position;
    if (u_IsWater > 0.5) {
        float t1 = u_Time;
        float t2 = u_Time * 0.12;
        float phase = dot(pos.xz, vec2(0.025, 0.03));
        float wave = sin(t1 + phase) * 3.0 + sin(t2 + phase * 1.7) * 1.5;
        pos.z += wave * 1.1;
    }

    gl_Position = UnpackMatrix(u_VPM) * vec4(pos, 1.0);
}
#endif

#ifdef FRAG
void main() {
    if (u_ApplyTextures < 1.0) {
        gl_FragColor = vec4(v_Color, 1.0);
    } else {
        vec2 uv = v_UV;
        if (u_Scroll > 0.1) {
            uv.y = fract(uv.y - u_Time * 0.45);
        }
        vec4 texColor = texture(SAMPLER_2D(u_Texture), uv);
        if (texColor.a < 0.25) {
            discard;
        }
        bool stp = texColor.a < 0.75;
        if (u_TexelFilter > 0.5 && u_TexelFilter < 1.5 && stp) {
            discard; // non-STP only (opaque part of semi-transparent)
        }
        if (u_TexelFilter > 1.5 && !stp) {
            discard; // STP only (blended part of semi-transparent)
        }
        gl_FragColor = vec4(texColor.rgb * v_Color * 2.0, 1.0);
    }
}
#endif
    `;
}

const MOBY_POS_SCALE = 1.0 / 16.0;
const MOBY_ROT_COLOR = colorNewFromRGBA(1, 1, 0, 1);
const MOBY_DEBUG_FLAGS = { flags: DebugDrawFlags.WorldSpace };
const MEGA_STATE_ADDITIVE = makeBlendMegaState(GfxBlendMode.Add, GfxBlendFactor.One, GfxBlendFactor.One);
const BINDING_LAYOUTS: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 2, numSamplers: 1 }];
const BINDING_LAYOUTS_SKY: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 1, numSamplers: 0 }];
const NOCLIP_SPACE_CORRECTION = mat4.fromValues(
    1, 0, 0, 0,
    0, 0, -1, 0,
    0, 1, 0, 0,
    0, 0, 0, 1,
);
const SCRATCH_CLIP = mat4.create();
const SCRATCH_VIEW = mat4.create();
const SCRATCH_MOBY_POS = vec3.create();
const SCRATCH_MOBY_ROT = vec3.create();
const TILE_SCROLL_MAP: Record<number, Record<number, number[]>> = {
    1: {
        11: [23], 13: [31], 17: [1], 27: [31], 35: [51], 37: [35],
        49: [54], 55: [66], 59: [12], 63: [77], 67: [55], 69: [29],
        75: [5], 79: [24]
    },
    2: {
        16: [72], 20: [44], 36: [44], 38: [48], 44: [35], 48: [0],
        50: [2], 58: [0, 1, 2], 72: [12, 13]
    },
    3: {
        98: [93], 100: [97], 110: [2], 112: [6], 116: [80], 120: [1],
        124: [77], 138: [72], 152: [27], 156: [7], 158: [80], 170: [29]
    }
};

export class SpyroLevelRenderer {
    public showMobys: boolean = false;
    public showTextures: boolean = true;
    public useLOD: boolean = false;
    public hasLOD: boolean = false;
    public textures: SpyroTexture[];
    private gfxProgram: GfxProgram;
    private gfxSamplerBindings: GfxSamplerBinding[][];
    private inputLayout: GfxInputLayout;
    private scrollSpeed: number;
    private mesh: LevelMeshRenderer;

    constructor(cache: GfxRenderCache, level: SpyroLevel, public mobyInstances: SpyroMobyInstance[]) {
        const textureCount = level.textures.headers.length;
        const scrollFlags = Array(textureCount).fill(false);
        if (level.id in TILE_SCROLL_MAP[level.gameNumber]) {
            for (const ti of TILE_SCROLL_MAP[level.gameNumber][level.id]) {
                if (ti >= 0 && ti < textureCount) {
                    scrollFlags[ti] = true;
                }
            }
        }
        this.textures = new Array(textureCount);
        for (let i = 0; i < textureCount; i++) {
            this.textures[i] = new SpyroTexture(cache.device, level.textures.colors[i], level.textures.headers[i], i, scrollFlags[i]);
        }

        // speed is hardcoded for now to roughly match appearance in game
        this.scrollSpeed = 0.001 * (level.gameNumber === 1 ? 2.6 : 2);

        this.gfxProgram = cache.createProgram(new Shader());
        this.inputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                { location: 0, bufferIndex: 0, format: GfxFormat.F32_RGB, bufferByteOffset: 0 },
                { location: 1, bufferIndex: 1, format: GfxFormat.F32_RGB, bufferByteOffset: 0 },
                { location: 2, bufferIndex: 2, format: GfxFormat.F32_RG, bufferByteOffset: 0 }
            ],
            vertexBufferDescriptors: [
                { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex },
                { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex },
                { byteStride: 8, frequency: GfxVertexBufferFrequency.PerVertex }
            ],
            indexBufferFormat: GfxFormat.U32_R
        });
        const gfxSampler = cache.createSampler({
            minFilter: GfxTexFilterMode.Point,
            magFilter: GfxTexFilterMode.Point,
            mipFilter: GfxMipFilterMode.Nearest,
            wrapS: GfxWrapMode.Clamp,
            wrapT: GfxWrapMode.Clamp
        });
        this.gfxSamplerBindings = Array(this.textures.length);
        for (let i = 0; i < this.textures.length; i++) {
            this.gfxSamplerBindings[i] = [{ gfxTexture: this.textures[i].gfxTexture, gfxSampler }];
        }

        // for now, all parts are combined into a single mesh
        this.mesh = new LevelMeshRenderer(cache, level.parts);
        for (const part of level.parts) {
            if (part.polygonsLOD.length > 0) {
                this.hasLOD = true;
                break;
            }
        }
    }

    public prepareToRender(renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput) {
        const template = renderHelper.renderInstManager.pushTemplate();
        template.setGfxProgram(this.gfxProgram);
        template.setBindingLayouts(BINDING_LAYOUTS);
        template.setUniformBuffer(renderHelper.uniformBuffer);

        let offs = template.allocateUniformBuffer(Shader.ub_SceneParams, 20);
        const d = template.mapUniformBufferF32(Shader.ub_SceneParams);
        // u_VPM (16)
        mat4.mul(SCRATCH_CLIP, viewerInput.camera.clipFromWorldMatrix, NOCLIP_SPACE_CORRECTION);
        offs += fillMatrix4x4(d, offs, SCRATCH_CLIP);
        // u_Time (1)
        d[offs++] = viewerInput.time * this.scrollSpeed;

        this.mesh.prepareToRender(renderHelper, this.inputLayout, this.textures, this.gfxSamplerBindings, this.useLOD);

        if (this.showMobys) {
            this.drawMobyPointers(renderHelper);
        }

        renderHelper.renderInstManager.popTemplate();
    }

    private drawMobyPointers(renderHelper: GfxRenderHelper): void {
        for (let i = 0; i < this.mobyInstances.length; i++) {
            const instance = this.mobyInstances[i];
            vec3.transformMat4(SCRATCH_MOBY_POS, vec3.fromValues(instance.x * MOBY_POS_SCALE, instance.y * MOBY_POS_SCALE, instance.z * MOBY_POS_SCALE), NOCLIP_SPACE_CORRECTION);

            const r = ((instance.classId * 97) & 255) / 255;
            const g = ((instance.classId * 57) & 255) / 255;
            const b = ((instance.classId * 17) & 255) / 255;
            renderHelper.debugDraw.drawLocator(SCRATCH_MOBY_POS, 20, colorNewFromRGBA(r, g, b, 1), MOBY_DEBUG_FLAGS);

            const yawRad = ((instance.yaw + 64) & 0xFF) / 256 * (Math.PI * 2);
            const forward = vec3.fromValues(Math.sin(yawRad), 0, Math.cos(yawRad));
            vec3.scale(forward, forward, 40);
            vec3.add(SCRATCH_MOBY_ROT, SCRATCH_MOBY_POS, forward);
            renderHelper.debugDraw.drawLine(SCRATCH_MOBY_POS, SCRATCH_MOBY_ROT, MOBY_ROT_COLOR, undefined, MOBY_DEBUG_FLAGS);

            const s = `${instance.classId} (${i})`;
            SCRATCH_MOBY_POS[0] -= s.length * 7; // roughly center it
            SCRATCH_MOBY_POS[1] += 50;
            renderHelper.debugDraw.drawWorldTextRU(s, SCRATCH_MOBY_POS, White, undefined, undefined, MOBY_DEBUG_FLAGS);
        }
    }

    public destroy(device: GfxDevice) {
        this.mesh.destroy(device);
        for (const t of this.textures) {
            device.destroyTexture(t.gfxTexture);
        }
    }
}

interface DrawCall {
    texture: number;
    isWater: boolean;
    blendMode: SpyroBlendMode;
    count: number;
    offset: number;
}

const enum TexelFilter {
    ALL = 0,
    NON_STP = 1,
    STP_ONLY = 2
}

function makeBlendMegaState(blendMode: GfxBlendMode, blendSrcFactor: GfxBlendFactor, blendDstFactor: GfxBlendFactor): Partial<GfxMegaStateDescriptor> {
    const megaState: Partial<GfxMegaStateDescriptor> = { depthWrite: false };
    setAttachmentStateSimple(megaState, { blendMode, blendSrcFactor, blendDstFactor });
    return megaState;
}

function getBlendMegaState(blend: SpyroBlendMode): Partial<GfxMegaStateDescriptor> {
    switch (blend) {
        case SpyroBlendMode.ADDITIVE:
            // only additive seems to be used?
            return MEGA_STATE_ADDITIVE;
        case SpyroBlendMode.AVERAGE: // B/2 + F/2. Output alpha 0.5 with SrcAlpha/OneMinusSrcAlpha, order-dependent so needs depth sorting
        case SpyroBlendMode.SUBTRACTIVE: // B - F, ReverseSubtract with One/One
        case SpyroBlendMode.QUARTER: // B + F/4, One/One with the source color scaled by 0.25 in the shader
        default:
            console.warn(`unimplemented blend mode ${SpyroBlendMode[blend]}, defaulting to additive`);
            return MEGA_STATE_ADDITIVE;
    }
}

class LevelMeshRenderer {
    private indexBufferDescriptor: GfxIndexBufferDescriptor;
    private vertexBufferDescriptors: GfxVertexBufferDescriptor[];
    private drawCount: number;
    private drawCountLOD: number;
    private drawCalls: DrawCall[];
    private indexLODOffset: number;

    constructor(cache: GfxRenderCache, parts: SpyroGroundPart[]) {
        const vertices: number[] = [];
        const colors: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];

        // group polygons into draw calls by texture, blend mode and water flag
        // key = textureIndex << 4 | (blend + 1) << 1 | isWater
        const groups = new Map<number, number[]>();
        let index = 0;
        for (const part of parts) {
            for (const polygon of part.polygons) {
                const blend = polygon.blendMode ?? SpyroBlendMode.OPAQUE;
                const key = (polygon.textureIndex << 4) | ((blend + 1) << 1) | (polygon.isWater ? 1 : 0);
                let group = groups.get(key);
                if (group === undefined) {
                    group = [];
                    groups.set(key, group);
                }
                for (let i = 0; i < 3; i++) {
                    const v = part.vlut[polygon.vertices[i]];
                    const c = part.clut[polygon.colors[i]];
                    vertices.push(v[0], v[1], v[2]);
                    colors.push(c[0] / 255, c[1] / 255, c[2] / 255);
                    uvs.push(polygon.uvs[i][0], polygon.uvs[i][1]);
                    group.push(index++);
                }
            }
        }
        const keys = [...groups.keys()].sort((a, b) => a - b);
        this.drawCalls = keys.map((key) => {
            const group = groups.get(key)!;
            const offset = indices.length;
            for (const i of group) {
                indices.push(i);
            }
            return { texture: key >> 4, blendMode: ((key >> 1) & 7) - 1, isWater: (key & 1) === 1, count: group.length, offset };
        });
        this.drawCount = indices.length;
        this.indexLODOffset = indices.length;

        for (const part of parts) {
            for (const polygon of part.polygonsLOD) {
                for (let i = 0; i < 3; i++) {
                    const v = part.vlutLOD[polygon.vertices[i]];
                    const c = part.clutLOD[polygon.colors[i]].map(c => c / 255);
                    vertices.push(v[0], v[1], v[2]);
                    colors.push(c[0], c[1], c[2]);
                    uvs.push(polygon.uvs[i][0], polygon.uvs[i][1]);
                    indices.push(index++);
                }
            }
        }
        this.drawCountLOD = indices.length - this.indexLODOffset;

        this.vertexBufferDescriptors = [
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(vertices).buffer), byteOffset: 0 },
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(colors).buffer), byteOffset: 0 },
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(uvs).buffer), byteOffset: 0 }
        ];
        this.indexBufferDescriptor = { buffer: createBufferFromData(cache.device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, new Uint32Array(indices).buffer), byteOffset: 0 };
    }

    public prepareToRender(renderHelper: GfxRenderHelper, inputLayout: GfxInputLayout, textures: SpyroTexture[], gfxSamplerBindings: GfxSamplerBinding[][], lod: boolean) {
        if ((lod ? this.drawCountLOD : this.drawCount) > 0) {
            const renderInstManager = renderHelper.renderInstManager;
            const template = renderInstManager.pushTemplate();
            template.setVertexInput(inputLayout, this.vertexBufferDescriptors, this.indexBufferDescriptor);

            if (lod) {
                const renderInst = renderInstManager.newRenderInst();
                this.fillDrawParams(renderInst, false, false, false, TexelFilter.ALL);
                renderInst.sortKey = makeSortKey(GfxRendererLayer.OPAQUE);
                renderInst.setDrawCount(this.drawCountLOD, this.indexLODOffset);
                renderInstManager.submitRenderInst(renderInst);
            } else {
                for (const drawCall of this.drawCalls) {
                    const texture = textures[drawCall.texture];
                    if (drawCall.blendMode === SpyroBlendMode.OPAQUE) {
                        this.submitDrawCall(renderInstManager, drawCall, texture, gfxSamplerBindings, TexelFilter.ALL, null);
                    } else {
                        if (texture.hasOpaqueTexels) {
                            this.submitDrawCall(renderInstManager, drawCall, texture, gfxSamplerBindings, TexelFilter.NON_STP, null);
                        }
                        if (texture.hasStpTexels) {
                            this.submitDrawCall(renderInstManager, drawCall, texture, gfxSamplerBindings, TexelFilter.STP_ONLY, getBlendMegaState(drawCall.blendMode));
                        }
                    }
                }
            }

            renderInstManager.popTemplate();
        }
    }

    private submitDrawCall(renderInstManager: GfxRenderInstManager, drawCall: DrawCall, texture: SpyroTexture, gfxSamplerBindings: GfxSamplerBinding[][], texelFilter: TexelFilter, blendMegaState: Partial<GfxMegaStateDescriptor> | null) {
        const renderInst = renderInstManager.newRenderInst();
        this.fillDrawParams(renderInst, true, texture.isScrolling, drawCall.isWater, texelFilter);
        if (blendMegaState !== null) {
            renderInst.setMegaStateFlags(blendMegaState);
            renderInst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT);
        } else {
            renderInst.sortKey = makeSortKey(GfxRendererLayer.OPAQUE);
        }
        renderInst.setSamplerBindingsFromTextureMappings(gfxSamplerBindings[drawCall.texture]);
        renderInst.setDrawCount(drawCall.count, drawCall.offset);
        renderInstManager.submitRenderInst(renderInst);
    }

    private fillDrawParams(renderInst: GfxRenderInst, applyTextures: boolean, isScrolling: boolean, isWater: boolean, texelFilter: TexelFilter) {
        let offs = renderInst.allocateUniformBuffer(Shader.ub_DrawParams, 4);
        const d = renderInst.mapUniformBufferF32(Shader.ub_DrawParams);
        // u_ApplyTextures (1)
        d[offs++] = applyTextures ? 1.0 : 0.0;
        // u_Scroll (1)
        d[offs++] = isScrolling ? 1.0 : 0.0;
        // u_IsWater (1)
        d[offs++] = isWater ? 1.0 : 0.0;
        // u_TexelFilter (1)
        d[offs++] = texelFilter;
    }

    public destroy(device: GfxDevice) {
        device.destroyBuffer(this.indexBufferDescriptor.buffer);
        for (const d of this.vertexBufferDescriptors) {
            device.destroyBuffer(d.buffer);
        }
    }
}

class SkyboxShader extends DeviceProgram {
    public static ub_SceneParams = 0;

    public override both = `
precision highp float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_VPM;
};

varying vec3 v_Color;

#ifdef VERT
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec3 a_Color;

void main() {
    v_Color = a_Color;
    gl_Position = UnpackMatrix(u_VPM) * vec4(a_Position, 1.0);
}
#endif

#ifdef FRAG
void main() {
    gl_FragColor = vec4(v_Color, 1.0);
}
#endif
    `;
}

export class SpyroSkyboxRenderer implements Destroyable {
    private drawCount: number;
    private gfxInputLayout: GfxInputLayout;
    private gfxProgram: GfxProgram;
    private megaStateFlags: GfxMegaStateDescriptor;
    private indexBufferDescriptor: GfxIndexBufferDescriptor;
    private vertexBufferDescriptors: GfxVertexBufferDescriptor[];

    constructor(cache: GfxRenderCache, sky: SpyroSkybox) {
        const vertices: number[] = [];
        const colors: number[] = [];
        const indices: number[] = [];

        // combine all parts into a single mesh
        let index = 0;
        for (const part of sky.parts) {
            for (const polygon of part.polygons) {
                for (let i = 0; i < 3; i++) {
                    const v = part.vlut[polygon.vertices[i]];
                    const c = part.clut[polygon.colors[i]].map(c => c / 255);
                    vertices.push(v[0], v[1], v[2]);
                    colors.push(c[0], c[1], c[2]);
                    indices.push(index++);
                }
            }
        }

        this.gfxProgram = cache.createProgram(new SkyboxShader());
        this.megaStateFlags = makeMegaState({ cullMode: GfxCullMode.None, depthCompare: GfxCompareMode.Always, depthWrite: false }, defaultMegaState);

        this.gfxInputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                { location: 0, bufferIndex: 0, format: GfxFormat.F32_RGB, bufferByteOffset: 0 },
                { location: 1, bufferIndex: 1, format: GfxFormat.F32_RGB, bufferByteOffset: 0 }
            ],
            vertexBufferDescriptors: [
                { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex },
                { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex }
            ],
            indexBufferFormat: GfxFormat.U32_R
        });
        this.drawCount = indices.length;
        this.indexBufferDescriptor = { buffer: createBufferFromData(cache.device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, new Uint32Array(indices).buffer), byteOffset: 0 };
        this.vertexBufferDescriptors = [
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(vertices).buffer), byteOffset: 0 },
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(colors).buffer), byteOffset: 0 }
        ];
    }

    public prepareToRender(renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput) {
        const renderInst = renderHelper.renderInstManager.newRenderInst();

        renderInst.setGfxProgram(this.gfxProgram);
        renderInst.setBindingLayouts(BINDING_LAYOUTS_SKY);
        renderInst.setUniformBuffer(renderHelper.uniformBuffer);
        renderInst.setMegaStateFlags(this.megaStateFlags);
        renderInst.sortKey = makeSortKey(GfxRendererLayer.BACKGROUND);

        let offs = renderInst.allocateUniformBuffer(SkyboxShader.ub_SceneParams, 16);
        const d = renderInst.mapUniformBufferF32(SkyboxShader.ub_SceneParams);
        // u_VPM (16)
        computeViewMatrixSkybox(SCRATCH_VIEW, viewerInput.camera);
        mat4.mul(SCRATCH_VIEW, viewerInput.camera.projectionMatrix, SCRATCH_VIEW);
        mat4.mul(SCRATCH_VIEW, SCRATCH_VIEW, NOCLIP_SPACE_CORRECTION);
        offs += fillMatrix4x4(d, offs, SCRATCH_VIEW);

        renderInst.setVertexInput(this.gfxInputLayout, this.vertexBufferDescriptors, this.indexBufferDescriptor);
        renderInst.setDrawCount(this.drawCount);
        renderHelper.renderInstManager.submitRenderInst(renderInst);
    }

    public destroy(device: GfxDevice) {
        device.destroyBuffer(this.indexBufferDescriptor.buffer);
        for (const d of this.vertexBufferDescriptors) {
            device.destroyBuffer(d.buffer);
        }
    }
}
