import { mat4, vec3 } from "gl-matrix";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { fillMatrix4x4 } from "../gfx/helpers/UniformBufferHelpers";
import { GfxDevice, GfxBufferUsage, GfxBufferFrequencyHint, GfxFormat, GfxVertexBufferFrequency, GfxBindingLayoutDescriptor, GfxTexFilterMode, GfxWrapMode, GfxMipFilterMode, GfxCompareMode, GfxIndexBufferDescriptor, GfxVertexBufferDescriptor, GfxMegaStateDescriptor, GfxSamplerBinding, GfxBlendMode, GfxBlendFactor } from "../gfx/platform/GfxPlatform";
import { GfxInputLayout, GfxProgram } from "../gfx/platform/GfxPlatformImpl";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { DeviceProgram } from "../Program";
import { ViewerRenderInput } from "../viewer";
import { SpyroSkybox, SpyroLevel, SpyroMobyInstance, SpyroGroundPart, SpyroMDLPolygon } from "./bin";
import { GfxRendererLayer, GfxRenderInst, GfxRenderInstManager, makeSortKey, setSortKeyDepth } from "../gfx/render/GfxRenderInstManager";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers";
import { Color, colorNewFromRGBA, White } from "../Color";
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

const MOBY_POS_SCALE = 1.0 / 16.0;
const MOBY_ROT_COLOR = colorNewFromRGBA(1, 1, 0, 1);
const MOBY_DEBUG_FLAGS = { flags: DebugDrawFlags.WorldSpace };
const BLEND_ALPHA = 0.5;
const SORT_MAX_DEPTH = 0x40000;
const UV_NONE = [0, 0];
const MEGA_STATE_BLEND: Partial<GfxMegaStateDescriptor>[] = [
    makeBlendMegaState(GfxBlendFactor.OneMinusSrcAlpha), // average
    makeBlendMegaState(GfxBlendFactor.One), // additive
    makeBlendMegaState(GfxBlendFactor.One), // subtractive (stub)
    makeBlendMegaState(GfxBlendFactor.One) // quarter (stub)
];
const SHADER_DEFINES: [ShaderFlags, string][] = [
    [ShaderFlags.TEXTURED, "TEXTURED"],
    [ShaderFlags.WATER, "WATER"],
    [ShaderFlags.SCROLL, "SCROLL"],
    [ShaderFlags.ALPHA_TEST, "ALPHA_TEST"],
    [ShaderFlags.DISCARD_STP, "DISCARD_STP"],
    [ShaderFlags.DISCARD_NON_STP, "DISCARD_NON_STP"],
    [ShaderFlags.BLENDED, "BLENDED"]
];
const BINDING_LAYOUTS: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 1, numSamplers: 1 }];
const MEGA_STATE_SKYBOX: Partial<GfxMegaStateDescriptor> = { depthCompare: GfxCompareMode.Always, depthWrite: false };
const SCRATCH_VIEW = mat4.create();
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

class Shader extends DeviceProgram {
    public static ub_SceneParams = 0;

    constructor(flags: ShaderFlags) {
        super();
        for (const [flag, name] of SHADER_DEFINES) {
            this.setDefineBool(name, (flags & flag) !== 0);
        }
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
#ifdef TEXTURED
varying vec2 v_UV;
#endif

#ifdef VERT
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec4 a_Color;
#ifdef TEXTURED
layout(location = 2) in vec2 a_UV;
#endif

void main() {
    v_Color = a_Color.rgb;
#ifdef TEXTURED
    v_UV = a_UV;
#endif

    vec3 pos = a_Position;
#ifdef WATER
    float t = u_Time * 0.12;
    float phase = dot(pos.xy, vec2(0.025, 0.03));
    float wave = sin(u_Time + phase) * 3.0 + sin(t + phase * 1.7) * 1.5;
    pos.y += wave * 1.1;
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

interface MobyPointer {
    pos: vec3;
    tip: vec3;
    labelPos: vec3;
    color: Color;
    label: string;
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

interface DrawGroup {
    textureIndex: number;
    blendMode: SpyroBlendMode;
    isWater: boolean;
    partIndex: number | null;
    indices: number[];
}

function getPosInNCSpace(dst: vec3, x: number, y: number, z: number): vec3 {
    // convert from z-up to y-up
    return vec3.set(dst, x, z, -y);
}

function getMobyPointer(instance: SpyroMobyInstance, index: number): MobyPointer {
    const pos = getPosInNCSpace(vec3.create(), instance.x * MOBY_POS_SCALE, instance.y * MOBY_POS_SCALE, instance.z * MOBY_POS_SCALE);
    const yawRad = ((instance.yaw + 64) & 0xFF) / 256 * (Math.PI * 2);
    const tip = vec3.fromValues(pos[0] + Math.sin(yawRad) * 40, pos[1], pos[2] + Math.cos(yawRad) * 40);
    const label = `${instance.classId} (${index})`;
    const labelPos = vec3.fromValues(pos[0] - label.length * 7, pos[1] + 50, pos[2]); // roughly center it
    const r = ((instance.classId * 97) & 255) / 255;
    const g = ((instance.classId * 57) & 255) / 255;
    const b = ((instance.classId * 17) & 255) / 255;
    return { pos, tip, labelPos, color: colorNewFromRGBA(r, g, b, 1), label };
}

function makeBlendMegaState(blendDstFactor: GfxBlendFactor): Partial<GfxMegaStateDescriptor> {
    const megaState: Partial<GfxMegaStateDescriptor> = { depthWrite: false };
    setAttachmentStateSimple(megaState, { blendMode: GfxBlendMode.Add, blendSrcFactor: GfxBlendFactor.SrcAlpha, blendDstFactor });
    return megaState;
}

function computePartCenter(part: SpyroGroundPart): vec3 {
    const center = vec3.create();
    if (part.vlut.length === 0) {
        return center;
    }
    const min = vec3.fromValues(Infinity, Infinity, Infinity);
    const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
    for (const v of part.vlut) {
        vec3.min(min, min, v as vec3);
        vec3.max(max, max, v as vec3);
    }
    vec3.lerp(center, min, max, 0.5);
    return getPosInNCSpace(center, center[0], center[1], center[2]);
}

function groupPolygons(mesh: LevelMesh, parts: SpyroGroundPart[], textures: SpyroTexture[]): DrawGroup[] {
    // opaque polygons are grouped across all parts, blended polygons per part
    const groups = new Map<string, DrawGroup>();
    const getGroup = (partIndex: number | null, polygon: SpyroMDLPolygon): number[] => {
        const key = `${partIndex}_${polygon.textureIndex}_${polygon.isWater}`;
        let group = groups.get(key);
        if (group === undefined) {
            group = { textureIndex: polygon.textureIndex, blendMode: polygon.blendMode, isWater: polygon.isWater, partIndex, indices: [] };
            groups.set(key, group);
        }
        return group.indices;
    };
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex];
        for (const polygon of part.polygons) {
            const texture = textures[polygon.textureIndex];
            const isOpaque = polygon.blendMode === SpyroBlendMode.OPAQUE;
            const opaqueGroup = (isOpaque || texture.hasOpaqueTexels) ? getGroup(null, polygon) : null;
            const blendedGroup = (!isOpaque && texture.hasStpTexels) ? getGroup(partIndex, polygon) : null;
            for (let i = 0; i < 3; i++) {
                const vi = polygon.vertices[i], ci = polygon.colors[i];
                const index = mesh.addVertex(partIndex, vi, ci, part.vlut[vi], part.clut[ci], polygon.uvs[i]);
                opaqueGroup?.push(index);
                blendedGroup?.push(index);
            }
        }
    }
    return [...groups.values()];
}

function getShaderFlags(texture: SpyroTexture, blendMode: SpyroBlendMode, blended: boolean, isWater: boolean): ShaderFlags {
    let flags = ShaderFlags.TEXTURED;
    if (isWater) {
        flags |= ShaderFlags.WATER;
    }
    if (texture.isScrolling) {
        flags |= ShaderFlags.SCROLL;
    }

    if (blendMode === SpyroBlendMode.OPAQUE) {
        if (texture.hasTransparentTexels) {
            flags |= ShaderFlags.ALPHA_TEST;
        }
    } else if (!blended) {
        // opaque texels of a semi-transparent texture
        if (texture.hasTransparentTexels || texture.hasStpTexels) {
            flags |= ShaderFlags.ALPHA_TEST;
        }
        if (texture.hasStpTexels) {
            flags |= ShaderFlags.DISCARD_STP;
        }
    } else {
        // blended texels of a semi-transparent texture
        flags |= ShaderFlags.BLENDED;
        if (texture.hasTransparentTexels || texture.hasOpaqueTexels) {
            flags |= ShaderFlags.ALPHA_TEST | ShaderFlags.DISCARD_NON_STP;
        }
    }
    return flags;
}

class Buffers {
    constructor(private inputLayout: GfxInputLayout, private vertexBuffer: GfxVertexBufferDescriptor, private indexBuffer: GfxIndexBufferDescriptor) {
        
    }

    public setOnRenderInst(renderInst: GfxRenderInst): void {
        renderInst.setVertexInput(this.inputLayout, [this.vertexBuffer], this.indexBuffer);
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.vertexBuffer.buffer);
        device.destroyBuffer(this.indexBuffer.buffer);
    }
}

class LevelMesh {
    public indices: number[] = [];
    private positions: number[] = [];
    private colors: number[] = [];
    private uvs: number[] = [];
    private vertexMap = new Map<number, number>();
    private stride: number;

    constructor(private useUVs: boolean) {
        this.stride = this.useUVs ? 20 : 16;
    }

    public addVertex(partKey: number, vi: number, ci: number, v: number[], c: number[], uv: number[] = UV_NONE): number {
        const key = (((partKey * 1024 + vi) * 1024 + ci) * 2 + uv[0]) * 2 + uv[1];
        let index = this.vertexMap.get(key);
        if (index === undefined) {
            index = this.positions.length / 3;
            this.positions.push(v[0], v[2], -v[1]); // z-up to y-up
            this.colors.push(c[0], c[1], c[2]);
            this.uvs.push(uv[0], uv[1]);
            this.vertexMap.set(key, index);
        }
        return index;
    }

    public build(cache: GfxRenderCache): Buffers {
        return new Buffers(this.createInputLayout(cache), this.createVertexBuffer(cache.device), this.createIndexBuffer(cache.device));
    }

    private createVertexBuffer(device: GfxDevice): GfxVertexBufferDescriptor {
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

    private createIndexBuffer(device: GfxDevice): GfxIndexBufferDescriptor {
        let data: Uint16Array | Uint32Array;
        if (this.getIndexFormat() === GfxFormat.U16_R) {
            data = new Uint16Array(this.indices.length + (this.indices.length & 1));
            data.set(this.indices);
        } else {
            data = new Uint32Array(this.indices);
        }
        return { buffer: createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, data.buffer), byteOffset: 0 };
    }

    private createInputLayout(cache: GfxRenderCache): GfxInputLayout {
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
    private buffers: Buffers;
    private programs = new Map<ShaderFlags, GfxProgram>();
    private passesMDL: DrawPass[] = [];
    private passesLOD: DrawPass[] = [];

    constructor(private cache: GfxRenderCache, parts: SpyroGroundPart[], textures: SpyroTexture[]) {
        const mesh = new LevelMesh(true);
        const groups = groupPolygons(mesh, parts, textures);
        this.buildMDLPasses(mesh, groups, textures, parts.map(computePartCenter));
        this.buildLODPass(mesh, parts);
        this.buffers = mesh.build(cache);
    }

    public get hasLOD(): boolean {
        return this.passesLOD.length > 0;
    }

    private buildMDLPasses(mesh: LevelMesh, groups: DrawGroup[], textures: SpyroTexture[], partCenters: vec3[]): void {
        const indices = mesh.indices;
        const gfxSampler = this.cache.createSampler({
            minFilter: GfxTexFilterMode.Point,
            magFilter: GfxTexFilterMode.Point,
            mipFilter: GfxMipFilterMode.Nearest,
            wrapS: GfxWrapMode.Clamp,
            wrapT: GfxWrapMode.Clamp
        });
        const samplerBindings: GfxSamplerBinding[][] = textures.map((t) => [{ gfxTexture: t.gfxTexture, gfxSampler }]);

        for (const group of groups) {
            const offset = indices.length;
            const count = group.indices.length;
            for (const i of group.indices) {
                indices.push(i);
            }
            const blended = group.partIndex !== null;
            const flags = getShaderFlags(textures[group.textureIndex], group.blendMode, blended, group.isWater);
            const samplers = samplerBindings[group.textureIndex];
            if (group.partIndex !== null) {
                this.passesMDL.push(this.makePass(flags, samplers, count, offset, partCenters[group.partIndex], MEGA_STATE_BLEND[group.blendMode]));
            } else {
                this.passesMDL.push(this.makePass(flags, samplers, count, offset, null, null));
            }
        }
    }

    private buildLODPass(mesh: LevelMesh, parts: SpyroGroundPart[]): void {
        const indices = mesh.indices;
        const offset = indices.length;
        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            const part = parts[partIndex];
            // LOD vertices get their own key range after the MDL ones
            const partKey = parts.length + partIndex;
            for (const polygon of part.polygonsLOD) {
                for (let i = 0; i < 3; i++) {
                    const vi = polygon.vertices[i], ci = polygon.colors[i];
                    indices.push(mesh.addVertex(partKey, vi, ci, part.vlutLOD[vi], part.clutLOD[ci]));
                }
            }
        }
        const count = indices.length - offset;
        if (count > 0) {
            this.passesLOD.push(this.makePass(ShaderFlags.NONE, null, count, offset, null, null));
        }
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
        this.buffers.setOnRenderInst(template);
        const passes = lod ? this.passesLOD : this.passesMDL;
        for (let i = 0; i < passes.length; i++) {
            this.submitPass(renderInstManager, viewMatrix, passes[i]);
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
        this.buffers.destroy(device);
    }
}

export class SpyroLevelRenderer {
    public showMobys: boolean = false;
    public useLOD: boolean = false;
    public textures: SpyroTexture[];
    public mobyPointers: MobyPointer[];
    private scrollSpeed: number;
    private mesh: LevelMeshRenderer;

    constructor(cache: GfxRenderCache, level: SpyroLevel, mobyInstances: SpyroMobyInstance[]) {
        this.mobyPointers = mobyInstances.map(getMobyPointer);

        const scrolling = new Set(TILE_SCROLL_MAP[level.gameNumber][level.id] ?? []);
        this.textures = level.textures.map((raw, i) => new SpyroTexture(cache.device, raw, `tile_${i}`, scrolling.has(i)));

        // speed is hardcoded for now to roughly match appearance in game
        // it's also not constant throughout each game, so these are averages
        this.scrollSpeed = 0.001 * (level.gameNumber === 1 ? 2.6 : 1.6);

        // for now, all parts are combined into a single mesh
        this.mesh = new LevelMeshRenderer(cache, level.parts, this.textures);
    }

    public hasLOD(): boolean {
        return this.mesh.hasLOD;
    }

    public prepareToRender(renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput) {
        const template = renderHelper.renderInstManager.pushTemplate();
        template.setBindingLayouts(BINDING_LAYOUTS);
        template.setUniformBuffer(renderHelper.uniformBuffer);

        let offs = template.allocateUniformBuffer(Shader.ub_SceneParams, 20);
        const d = template.mapUniformBufferF32(Shader.ub_SceneParams);
        // u_VPM (16)
        offs += fillMatrix4x4(d, offs, viewerInput.camera.clipFromWorldMatrix);
        // u_Time (1)
        d[offs++] = viewerInput.time * this.scrollSpeed;

        this.mesh.prepareToRender(renderHelper.renderInstManager, viewerInput.camera.viewMatrix, this.useLOD);

        if (this.showMobys) {
            this.drawMobyPointers(renderHelper);
        }

        renderHelper.renderInstManager.popTemplate();
    }

    private drawMobyPointers(renderHelper: GfxRenderHelper): void {
        const debugDraw = renderHelper.debugDraw;
        for (let i = 0; i < this.mobyPointers.length; i++) {
            const m = this.mobyPointers[i];
            debugDraw.drawLocator(m.pos, 20, m.color, MOBY_DEBUG_FLAGS);
            debugDraw.drawLine(m.pos, m.tip, MOBY_ROT_COLOR, undefined, MOBY_DEBUG_FLAGS);
            debugDraw.drawWorldTextRU(m.label, m.labelPos, White, undefined, undefined, MOBY_DEBUG_FLAGS);
        }
    }

    public destroy(device: GfxDevice) {
        this.mesh.destroy(device);
        for (const t of this.textures) {
            device.destroyTexture(t.gfxTexture);
        }
    }
}

export class SpyroSkyboxRenderer implements Destroyable {
    private drawCount: number;
    private program: GfxProgram;
    private buffers: Buffers;

    constructor(cache: GfxRenderCache, sky: SpyroSkybox) {
        // combine all parts into a single mesh
        const mesh = new LevelMesh(false);
        for (let partIndex = 0; partIndex < sky.parts.length; partIndex++) {
            const part = sky.parts[partIndex];
            for (const polygon of part.polygons) {
                for (let i = 0; i < 3; i++) {
                    const vi = polygon.vertices[i], ci = polygon.colors[i];
                    mesh.indices.push(mesh.addVertex(partIndex, vi, ci, part.vlut[vi], part.clut[ci]));
                }
            }
        }
        this.drawCount = mesh.indices.length;
        this.program = cache.createProgram(new Shader(ShaderFlags.NONE));
        this.buffers = mesh.build(cache);
    }

    public prepareToRender(renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput) {
        const renderInst = renderHelper.renderInstManager.newRenderInst();
        renderInst.setGfxProgram(this.program);
        renderInst.setBindingLayouts(BINDING_LAYOUTS);
        renderInst.setUniformBuffer(renderHelper.uniformBuffer);
        renderInst.setMegaStateFlags(MEGA_STATE_SKYBOX);
        renderInst.sortKey = makeSortKey(GfxRendererLayer.BACKGROUND);

        let offs = renderInst.allocateUniformBuffer(Shader.ub_SceneParams, 20);
        const d = renderInst.mapUniformBufferF32(Shader.ub_SceneParams);
        // u_VPM (16)
        computeViewMatrixSkybox(SCRATCH_VIEW, viewerInput.camera);
        mat4.mul(SCRATCH_VIEW, viewerInput.camera.projectionMatrix, SCRATCH_VIEW);
        offs += fillMatrix4x4(d, 0, SCRATCH_VIEW);

        this.buffers.setOnRenderInst(renderInst);
        renderInst.setDrawCount(this.drawCount);
        renderHelper.renderInstManager.submitRenderInst(renderInst);
    }

    public destroy(device: GfxDevice) {
        this.buffers.destroy(device);
    }
}
