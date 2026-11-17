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
import { GfxRendererLayer, GfxRenderInstManager, makeSortKey, setSortKeyDepth } from "../gfx/render/GfxRenderInstManager";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers";
import { colorNewFromRGBA, White } from "../Color";
import { DebugDrawFlags } from "../gfx/helpers/DebugDraw";
import { Destroyable } from "../SceneBase";
import { computeViewMatrixSkybox, computeViewSpaceDepthFromWorldSpacePoint } from "../Camera";
import { SpyroBlendMode, SpyroTexture } from "./texture";

const enum ShaderFlags {
    NONE = 0,
    TEXTURED = 1 << 0,
    WATER = 1 << 1,
    SCROLL = 1 << 2,
    ALPHA_TEST = 1 << 3, // discard fully transparent texels
    DISCARD_STP = 1 << 4, // also discard STP texels (opaque part of semi-transparent)
    DISCARD_NON_STP = 1 << 5, // also discard non-STP texels (blended part of semi-transparent)
    BLENDED = 1 << 6
}

class Shader extends DeviceProgram {
    public static ub_SceneParams = 0;

    constructor(flags: ShaderFlags) {
        super();
        this.setDefineBool("TEXTURED", (flags & ShaderFlags.TEXTURED) !== 0);
        this.setDefineBool("WATER", (flags & ShaderFlags.WATER) !== 0);
        this.setDefineBool("SCROLL", (flags & ShaderFlags.SCROLL) !== 0);
        this.setDefineBool("ALPHA_TEST", (flags & ShaderFlags.ALPHA_TEST) !== 0);
        this.setDefineBool("DISCARD_STP", (flags & ShaderFlags.DISCARD_STP) !== 0);
        this.setDefineBool("DISCARD_NON_STP", (flags & ShaderFlags.DISCARD_NON_STP) !== 0);
        this.setDefineBool("BLENDED", (flags & ShaderFlags.BLENDED) !== 0);
    }

    public override both = `
precision highp float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_VPM;
    float u_Time;
};

uniform sampler2D u_Texture;

varying vec3 v_Color;
varying vec2 v_UV;

#ifdef VERT
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec4 a_Color;
layout(location = 2) in vec2 a_UV;

void main() {
    v_Color = a_Color.rgb;
    v_UV = a_UV;

    vec3 pos = a_Position;
#ifdef WATER
    float t1 = u_Time;
    float t2 = u_Time * 0.12;
    float phase = dot(pos.xz, vec2(0.025, 0.03));
    float wave = sin(t1 + phase) * 3.0 + sin(t2 + phase * 1.7) * 1.5;
    pos.z += wave * 1.1;
#endif

    gl_Position = UnpackMatrix(u_VPM) * vec4(pos, 1.0);
}
#endif

#ifdef FRAG
void main() {
#ifdef TEXTURED
    vec2 uv = v_UV;
    #ifdef SCROLL
        uv.y = fract(uv.y - u_Time * 0.45);
    #endif
    vec4 texColor = texture(SAMPLER_2D(u_Texture), uv);
    #ifdef ALPHA_TEST
        if (texColor.a < 0.25) {
            discard;
        }
        bool stp = texColor.a < 0.75;
        #ifdef DISCARD_STP
            if (stp) {
                discard;
            }
        #endif
        #ifdef DISCARD_NON_STP
            if (!stp) {
                discard;
            }
        #endif
    #endif
    #ifdef BLENDED
        float alpha = ${BLEND_ALPHA.toFixed(3)};
    #else
        float alpha = 1.0;
    #endif
    gl_FragColor = vec4(min(texColor.rgb * v_Color * 2.0, vec3(1.0)), alpha);
#else
    gl_FragColor = vec4(v_Color, 1.0);
#endif
}
#endif
    `;
}

const MOBY_POS_SCALE = 1.0 / 16.0;
const MOBY_ROT_COLOR = colorNewFromRGBA(1, 1, 0, 1);
const MOBY_DEBUG_FLAGS = { flags: DebugDrawFlags.WorldSpace };
const BLEND_ALPHA = 0.5;
const MEGA_STATE_ADDITIVE = makeBlendMegaState(GfxBlendMode.Add, GfxBlendFactor.SrcAlpha, GfxBlendFactor.One);
const MEGA_STATE_AVERAGE = makeBlendMegaState(GfxBlendMode.Add, GfxBlendFactor.SrcAlpha, GfxBlendFactor.OneMinusSrcAlpha);
const SORT_MAX_DEPTH = 0x40000;
const UV_NONE = [0, 0];
const BINDING_LAYOUTS: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 1, numSamplers: 1 }];
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
        // it's also not constant throughout each game, so these are averages
        this.scrollSpeed = 0.001 * (level.gameNumber === 1 ? 2.6 : 1.6);

        // for now, all parts are combined into a single mesh
        this.mesh = new LevelMeshRenderer(cache, level.parts, this.textures);
        for (const part of level.parts) {
            if (part.polygonsLOD.length > 0) {
                this.hasLOD = true;
                break;
            }
        }
    }

    public prepareToRender(renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput) {
        const template = renderHelper.renderInstManager.pushTemplate();
        template.setBindingLayouts(BINDING_LAYOUTS);
        template.setUniformBuffer(renderHelper.uniformBuffer);

        let offs = template.allocateUniformBuffer(Shader.ub_SceneParams, 20);
        const d = template.mapUniformBufferF32(Shader.ub_SceneParams);
        // u_VPM (16)
        mat4.mul(SCRATCH_CLIP, viewerInput.camera.clipFromWorldMatrix, NOCLIP_SPACE_CORRECTION);
        offs += fillMatrix4x4(d, offs, SCRATCH_CLIP);
        // u_Time (1)
        d[offs++] = viewerInput.time * this.scrollSpeed;

        this.mesh.prepareToRender(renderHelper.renderInstManager, viewerInput.camera.viewMatrix, this.useLOD);

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

interface DrawPass {
    program: GfxProgram;
    sortKey: number;
    megaState: Partial<GfxMegaStateDescriptor> | null;
    samplerBindings: GfxSamplerBinding[] | null;
    count: number;
    offset: number;
    center: vec3 | null;
}

function makeBlendMegaState(blendMode: GfxBlendMode, blendSrcFactor: GfxBlendFactor, blendDstFactor: GfxBlendFactor): Partial<GfxMegaStateDescriptor> {
    const megaState: Partial<GfxMegaStateDescriptor> = { depthWrite: false };
    setAttachmentStateSimple(megaState, { blendMode, blendSrcFactor, blendDstFactor });
    return megaState;
}

function getBlendMegaState(blend: SpyroBlendMode): Partial<GfxMegaStateDescriptor> {
    switch (blend) {
        case SpyroBlendMode.ADDITIVE:
            return MEGA_STATE_ADDITIVE;
        case SpyroBlendMode.AVERAGE:
            return MEGA_STATE_AVERAGE;
        case SpyroBlendMode.SUBTRACTIVE: // B - F, ReverseSubtract with One/One
        case SpyroBlendMode.QUARTER: // B + F/4, One/One with the source color scaled by 0.25 in the shader
        default:
            // console.warn(`unimplemented blend mode ${SpyroBlendMode[blend]}, defaulting to additive`);
            return MEGA_STATE_ADDITIVE;
    }
}

class MeshBuilder {
    public indices: number[] = [];
    private positions: number[] = [];
    private colors: number[] = [];
    private uvs: number[] = [];
    private vertexMap = new Map<number, number>();
    private stride: number;

    constructor(private useUVs: boolean) {
        this.stride = this.useUVs ? 20 : 16;
    }

    public newPart(): void {
        this.vertexMap.clear();
    }

    public addVertex(vi: number, ci: number, v: number[], c: number[], uv: number[] = UV_NONE): number {
        const key = ((vi * 4096 + ci) * 2 + uv[0]) * 2 + uv[1];
        let index = this.vertexMap.get(key);
        if (index === undefined) {
            index = this.positions.length / 3;
            this.positions.push(v[0], v[1], v[2]);
            this.colors.push(c[0], c[1], c[2]);
            this.uvs.push(uv[0], uv[1]);
            this.vertexMap.set(key, index);
        }
        return index;
    }

    public createVertexBuffer(device: GfxDevice): GfxVertexBufferDescriptor {
        const vertexCount = this.positions.length / 3;
        const data = new ArrayBuffer(vertexCount * this.stride);
        const f32 = new Float32Array(data);
        const u8 = new Uint8Array(data);
        for (let i = 0; i < vertexCount; i++) {
            const f = i * this.stride / 4;
            f32[f] = this.positions[i * 3];
            f32[f + 1] = this.positions[i * 3 + 1];
            f32[f + 2] = this.positions[i * 3 + 2];
            const b = i * this.stride + 12;
            u8[b] = this.colors[i * 3];
            u8[b + 1] = this.colors[i * 3 + 1];
            u8[b + 2] = this.colors[i * 3 + 2];
            u8[b + 3] = 255;
            if (this.useUVs) {
                u8[b + 4] = this.uvs[i * 2] * 255;
                u8[b + 5] = this.uvs[i * 2 + 1] * 255;
            }
        }
        return { buffer: createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, data), byteOffset: 0 };
    }

    public createIndexBuffer(device: GfxDevice): GfxIndexBufferDescriptor {
        let data: Uint16Array | Uint32Array;
        if (this.getIndexFormat() === GfxFormat.U16_R) {
            data = new Uint16Array(this.indices.length + (this.indices.length & 1));
            data.set(this.indices);
        } else {
            data = new Uint32Array(this.indices);
        }
        return { buffer: createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, data.buffer), byteOffset: 0 };
    }

    public createInputLayout(cache: GfxRenderCache): GfxInputLayout {
        const vertexAttributeDescriptors = [
            { location: 0, bufferIndex: 0, format: GfxFormat.F32_RGB, bufferByteOffset: 0 },
            { location: 1, bufferIndex: 0, format: GfxFormat.U8_RGBA_NORM, bufferByteOffset: 12 }
        ];
        if (this.useUVs) {
            vertexAttributeDescriptors.push({ location: 2, bufferIndex: 0, format: GfxFormat.U8_RG_NORM, bufferByteOffset: 16 });
        }
        return cache.createInputLayout({
            vertexAttributeDescriptors,
            vertexBufferDescriptors: [{ byteStride: this.stride, frequency: GfxVertexBufferFrequency.PerVertex }],
            indexBufferFormat: this.getIndexFormat()
        });
    }

    private getIndexFormat(): GfxFormat {
        return this.positions.length / 3 <= 0x10000 ? GfxFormat.U16_R : GfxFormat.U32_R;
    }
}

class LevelMeshRenderer {
    private indexBufferDescriptor: GfxIndexBufferDescriptor;
    private vertexBufferDescriptor: GfxVertexBufferDescriptor;
    private inputLayout: GfxInputLayout;
    private programs = new Map<ShaderFlags, GfxProgram>();
    private passes: DrawPass[] = [];
    private passLOD: DrawPass | null = null;

    constructor(private cache: GfxRenderCache, parts: SpyroGroundPart[], textures: SpyroTexture[]) {
        const mesh = new MeshBuilder(true);
        const indices = mesh.indices;

        // part centers for depth sorting semi-transparent draw calls
        const partCenters = parts.map((part) => {
            const min = vec3.fromValues(Infinity, Infinity, Infinity);
            const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
            for (const v of part.vlut) {
                vec3.min(min, min, v as vec3);
                vec3.max(max, max, v as vec3);
            }
            const center = vec3.create();
            if (part.vlut.length > 0) {
                vec3.lerp(center, min, max, 0.5);
            }
            return vec3.transformMat4(center, center, NOCLIP_SPACE_CORRECTION);
        });

        // group by texture, blend mode and water flag
        // key = ((partKey * 128 + textureIndex) << 4) | (blend + 1) << 1 | isWater, where partKey = part index + 1 or 0 if opaque
        const groups = new Map<number, number[]>();
        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            const part = parts[partIndex];
            mesh.newPart();
            for (const polygon of part.polygons) {
                const blend = polygon.blendMode ?? SpyroBlendMode.OPAQUE;
                const partKey = blend === SpyroBlendMode.OPAQUE ? 0 : partIndex + 1;
                const key = ((partKey * 128 + polygon.textureIndex) << 4) | ((blend + 1) << 1) | (polygon.isWater ? 1 : 0);
                let group = groups.get(key);
                if (group === undefined) {
                    group = [];
                    groups.set(key, group);
                }
                for (let i = 0; i < 3; i++) {
                    const vi = polygon.vertices[i], ci = polygon.colors[i];
                    group.push(mesh.addVertex(vi, ci, part.vlut[vi], part.clut[ci], polygon.uvs[i]));
                }
            }
        }
        const gfxSampler = cache.createSampler({
            minFilter: GfxTexFilterMode.Point,
            magFilter: GfxTexFilterMode.Point,
            mipFilter: GfxMipFilterMode.Nearest,
            wrapS: GfxWrapMode.Clamp,
            wrapT: GfxWrapMode.Clamp
        });
        const samplerBindings: GfxSamplerBinding[][] = textures.map((t) => [{ gfxTexture: t.gfxTexture, gfxSampler }]);

        const keys = [...groups.keys()].sort((a, b) => a - b);
        for (const key of keys) {
            const group = groups.get(key)!;
            const offset = indices.length;
            const count = group.length;
            for (const i of group) {
                indices.push(i);
            }
            const textureIndex = (key >> 4) & 127;
            const blendMode: SpyroBlendMode = ((key >> 1) & 7) - 1;
            const partKey = key >> 11;

            const texture = textures[textureIndex];
            const bindings = samplerBindings[textureIndex];
            let base = ShaderFlags.TEXTURED;
            if (key & 1) {
                base |= ShaderFlags.WATER;
            }
            if (texture.isScrolling) {
                base |= ShaderFlags.SCROLL;
            }

            if (blendMode === SpyroBlendMode.OPAQUE) {
                const flags = base | (texture.hasTransparentTexels ? ShaderFlags.ALPHA_TEST : 0);
                this.passes.push(this.makePass(flags, bindings, count, offset, null, null));
                continue;
            }
            if (texture.hasOpaqueTexels) {
                // opaque part of a semi-transparent texture
                let flags = base;
                if (texture.hasTransparentTexels || texture.hasStpTexels) {
                    flags |= ShaderFlags.ALPHA_TEST;
                }
                if (texture.hasStpTexels) {
                    flags |= ShaderFlags.DISCARD_STP;
                }
                this.passes.push(this.makePass(flags, bindings, count, offset, null, null));
            }
            if (texture.hasStpTexels) {
                // blended part of a semi-transparent texture, depth sorted by part center
                let flags = base | ShaderFlags.BLENDED;
                if (texture.hasTransparentTexels || texture.hasOpaqueTexels) {
                    flags |= ShaderFlags.ALPHA_TEST | ShaderFlags.DISCARD_NON_STP;
                }
                this.passes.push(this.makePass(flags, bindings, count, offset, partCenters[partKey - 1], getBlendMegaState(blendMode)));
            }
        }
        const indexLODOffset = indices.length;

        for (const part of parts) {
            mesh.newPart();
            for (const polygon of part.polygonsLOD) {
                for (let i = 0; i < 3; i++) {
                    const vi = polygon.vertices[i], ci = polygon.colors[i];
                    indices.push(mesh.addVertex(vi, ci, part.vlutLOD[vi], part.clutLOD[ci]));
                }
            }
        }
        const drawCountLOD = indices.length - indexLODOffset;

        if (drawCountLOD > 0) {
            this.passLOD = this.makePass(ShaderFlags.NONE, null, drawCountLOD, indexLODOffset, null, null);
        }

        this.inputLayout = mesh.createInputLayout(cache);
        this.vertexBufferDescriptor = mesh.createVertexBuffer(cache.device);
        this.indexBufferDescriptor = mesh.createIndexBuffer(cache.device);
    }

    private getProgram(flags: ShaderFlags): GfxProgram {
        let program = this.programs.get(flags);
        if (program === undefined) {
            program = this.cache.createProgram(new Shader(flags));
            this.programs.set(flags, program);
        }
        return program;
    }

    private makePass(flags: ShaderFlags, samplerBindings: GfxSamplerBinding[] | null, count: number, offset: number, center: vec3 | null, megaState: Partial<GfxMegaStateDescriptor> | null): DrawPass {
        let sortKey: number;
        if (flags & ShaderFlags.BLENDED) {
            sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT);
        } else {
            const layer = (flags & ShaderFlags.ALPHA_TEST) ? GfxRendererLayer.OPAQUE + 1 : GfxRendererLayer.OPAQUE;
            sortKey = makeSortKey(layer, flags);
        }
        return { program: this.getProgram(flags), sortKey, megaState, samplerBindings, count, offset, center };
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, viewMatrix: mat4, lod: boolean) {
        const template = renderInstManager.pushTemplate();
        template.setVertexInput(this.inputLayout, [this.vertexBufferDescriptor], this.indexBufferDescriptor);
        if (lod) {
            if (this.passLOD !== null) {
                this.submitPass(renderInstManager, viewMatrix, this.passLOD);
            }
        } else {
            for (let i = 0; i < this.passes.length; i++) {
                this.submitPass(renderInstManager, viewMatrix, this.passes[i]);
            }
        }
        renderInstManager.popTemplate();
    }

    private submitPass(renderInstManager: GfxRenderInstManager, viewMatrix: mat4, pass: DrawPass) {
        const renderInst = renderInstManager.newRenderInst();
        renderInst.setGfxProgram(pass.program);
        if (pass.megaState !== null) {
            renderInst.setMegaStateFlags(pass.megaState);
        }
        renderInst.sortKey = pass.center !== null
            ? setSortKeyDepth(pass.sortKey, computeViewSpaceDepthFromWorldSpacePoint(viewMatrix, pass.center), SORT_MAX_DEPTH)
            : pass.sortKey;
        if (pass.samplerBindings !== null) {
            renderInst.setSamplerBindingsFromTextureMappings(pass.samplerBindings);
        }
        renderInst.setDrawCount(pass.count, pass.offset);
        renderInstManager.submitRenderInst(renderInst);
    }

    public destroy(device: GfxDevice) {
        device.destroyBuffer(this.indexBufferDescriptor.buffer);
        device.destroyBuffer(this.vertexBufferDescriptor.buffer);
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
layout(location = 1) in vec4 a_Color;

void main() {
    v_Color = a_Color.rgb;
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
    private vertexBufferDescriptor: GfxVertexBufferDescriptor;

    constructor(cache: GfxRenderCache, sky: SpyroSkybox) {
        // combine all parts into a single mesh
        const mesh = new MeshBuilder(false);
        for (const part of sky.parts) {
            mesh.newPart();
            for (const polygon of part.polygons) {
                for (let i = 0; i < 3; i++) {
                    const vi = polygon.vertices[i], ci = polygon.colors[i];
                    mesh.indices.push(mesh.addVertex(vi, ci, part.vlut[vi], part.clut[ci]));
                }
            }
        }

        this.gfxProgram = cache.createProgram(new SkyboxShader());
        this.megaStateFlags = makeMegaState({ cullMode: GfxCullMode.None, depthCompare: GfxCompareMode.Always, depthWrite: false }, defaultMegaState);

        this.drawCount = mesh.indices.length;
        this.gfxInputLayout = mesh.createInputLayout(cache);
        this.vertexBufferDescriptor = mesh.createVertexBuffer(cache.device);
        this.indexBufferDescriptor = mesh.createIndexBuffer(cache.device);
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

        renderInst.setVertexInput(this.gfxInputLayout, [this.vertexBufferDescriptor], this.indexBufferDescriptor);
        renderInst.setDrawCount(this.drawCount);
        renderHelper.renderInstManager.submitRenderInst(renderInst);
    }

    public destroy(device: GfxDevice) {
        device.destroyBuffer(this.indexBufferDescriptor.buffer);
        device.destroyBuffer(this.vertexBufferDescriptor.buffer);
    }
}
