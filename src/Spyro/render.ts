import { mat4, ReadonlyMat4, vec3 } from "gl-matrix";
import { defaultMegaState, makeMegaState } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { fillMatrix4x3, fillMatrix4x4 } from "../gfx/helpers/UniformBufferHelpers";
import { GfxDevice, GfxBufferUsage, GfxBufferFrequencyHint, GfxFormat, GfxVertexBufferFrequency, GfxBindingLayoutDescriptor, GfxTexFilterMode, GfxWrapMode, GfxMipFilterMode, GfxCompareMode, GfxCullMode, GfxIndexBufferDescriptor, GfxVertexBufferDescriptor, GfxMegaStateDescriptor, GfxSamplerBinding } from "../gfx/platform/GfxPlatform";
import { GfxInputLayout, GfxProgram } from "../gfx/platform/GfxPlatformImpl";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { DeviceProgram } from "../Program";
import { ViewerRenderInput } from "../viewer";
import { SpyroSkybox, SpyroLevel, SpyroMobyInstance, SpyroGroundPart } from "./bin";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers";
import { colorNewFromRGBA, White } from "../Color";
import { DebugDrawFlags } from "../gfx/helpers/DebugDraw";
import { Destroyable } from "../SceneBase";
import { computeViewMatrixSkybox, computeViewSpaceDepthFromWorldSpaceAABB } from "../Camera";
import { AABB } from "../Geometry";
import { SpyroTexture } from "./texture";
import { GfxRenderInst } from "../gfx/render/GfxRenderInstManager";

class Shader extends DeviceProgram {
    public static ub_SceneParams = 0;
    public static ub_DrawParams = 1;

    public override both = `
precision highp float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat3x4 u_View;
    Mat4x4 u_ViewProj;
    float u_Time;
    float u_MIDNear;
    float u_MIDFar;
};

layout(std140) uniform ub_DrawParams {
    float u_ApplyTextures;
    float u_UseMIDColor;
    float u_Brightness;
    float u_Scroll;
};

uniform sampler2D u_Texture;

varying vec3 v_Color;
varying vec3 v_MIDColor;
varying vec2 v_UV;
// varying float v_Depth;

#ifdef VERT
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec3 a_Color;
layout(location = 2) in vec3 a_MIDColor;
layout(location = 3) in vec2 a_UV;

void main() {
    // vec3 pos = a_Position;
    v_Color = a_Color;
    if (u_UseMIDColor > 0.1) {
        v_Color = a_MIDColor;
        // v_Depth = -(UnpackMatrix(u_View) * vec4(a_Position, 1.0)).z;
    }
    v_UV = a_UV;

    // if (u_IsWater > 0.1) {
    //     float t1 = u_Time;
    //     float t2 = u_Time * 0.12;
    //     float phase = dot(pos.xz, vec2(0.025, 0.03));
    //     float wave = sin(t1 + phase) * 3.0 + sin(t2 + phase * 1.7) * 1.5;
    //     pos.z += wave * 1.1;
    // }

    gl_Position = UnpackMatrix(u_ViewProj) * vec4(a_Position, 1.0);
}
#endif

#ifdef FRAG
void main() {
    if (u_ApplyTextures < 1.0 || u_UseMIDColor > 0.1) {
        gl_FragColor = vec4(v_Color, 1.0);
    } else {
        vec2 uv = v_UV;
        if (u_Scroll > 0.1) {
            uv.y = fract(uv.y - u_Time * 0.45);
        }
        vec4 texColor = texture(SAMPLER_2D(u_Texture), uv);
        gl_FragColor = vec4(texColor.rgb * v_Color * u_Brightness, 1.0);
    }
}
#endif
    `;

    constructor() {
        super();
    }
}

const BRIGHTNESS_OPAQUE = 1.9;
const BRIGHTNESS_TRANSPARENT = 1.0;
const MOBY_POS_SCALE = 1.0 / 16.0;
const MOBY_ROT_COLOR = colorNewFromRGBA(1, 1, 0, 1);
const MOBY_DEBUG_FLAGS = { flags: DebugDrawFlags.WorldSpace };
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

function getAABB(vertices: number[]): AABB {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (let i = 0; i < vertices.length; i += 3) {
        min.x = Math.min(min.x, vertices[i]);
        min.y = Math.min(min.y, vertices[i + 1]);
        min.z = Math.min(min.z, vertices[i + 2]);
        max.x = Math.max(max.x, vertices[i]);
        max.y = Math.max(max.y, vertices[i + 1]);
        max.z = Math.max(max.z, vertices[i + 2]);
    }
    const box = new AABB(min.x, min.y, min.z, max.x, max.y, max.z);
    box.transform(box, NOCLIP_SPACE_CORRECTION);
    return box;
}

function getBboxPoints(box: AABB): number[] {
    return [
        box.min[0], box.min[1], box.min[2],
        box.max[0], box.min[1], box.min[2],
        box.min[0], box.max[1], box.min[2],
        box.max[0], box.max[1], box.min[2],
        box.min[0], box.min[1], box.max[2],
        box.max[0], box.min[1], box.max[2],
        box.min[0], box.max[1], box.max[2],
        box.max[0], box.max[1], box.max[2]
    ];
}

// much cheaper frustum culling than with aabb
function inView(bbox: number[], m: ReadonlyMat4) {
    let aol = true, aor = true;
    let aob = true, aot = true;
    let aon = true, aof = true;
    for (let i = 0; i < 24; i += 3) {
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

export class SpyroLevelRenderer {
    public showMobys: boolean = false;
    public showTextures: boolean = true;
    public applyLOD: boolean = false;
    public useLOD: boolean = false;
    public hasLOD: boolean = false;
    public textures: SpyroTexture[];
    public lodThrehold = 2000.0;
    public midThresold = 1500.0;
    private gfxProgram: GfxProgram;
    private gfxSamplerBindings: GfxSamplerBinding[][];
    private inputLayout: GfxInputLayout;
    private scrollSpeed: number;
    private parts: PartRenderer[];

    constructor(cache: GfxRenderCache, level: SpyroLevel, public mobyInstances: SpyroMobyInstance[]) {
        const textureCount = level.textures.headers.length;
        const scrollFlags = Array(textureCount).fill(false);
        if (level.id in TILE_SCROLL_MAP[level.gameNumber]) {
            for (const ti of TILE_SCROLL_MAP[level.gameNumber][level.id]) {
                scrollFlags[ti] = true;
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
                { location: 2, bufferIndex: 2, format: GfxFormat.F32_RGB, bufferByteOffset: 0 },
                { location: 3, bufferIndex: 3, format: GfxFormat.F32_RG, bufferByteOffset: 0 }
            ],
            vertexBufferDescriptors: [
                { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex },
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

        this.parts = Array(level.parts.length);
        for (let i = 0; i < level.parts.length; i++) {
            this.parts[i] = new PartRenderer(cache, level.parts[i], this.inputLayout);
            if (level.parts[i].polygonsLOD.length > 0) {
                this.hasLOD = true;
            }
        }
    }

    public prepareToRender(renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput) {
        const template = renderHelper.renderInstManager.pushTemplate();
        template.setGfxProgram(this.gfxProgram);
        template.setBindingLayouts(BINDING_LAYOUTS);
        template.setUniformBuffer(renderHelper.uniformBuffer);

        let offs = template.allocateUniformBuffer(Shader.ub_SceneParams, 31);
        const d = template.mapUniformBufferF32(Shader.ub_SceneParams);
        // u_View (12)
        mat4.mul(SCRATCH_CLIP, viewerInput.camera.viewMatrix, NOCLIP_SPACE_CORRECTION);
        offs += fillMatrix4x3(d, offs, SCRATCH_CLIP);
        // u_ViewProj (16)
        mat4.mul(SCRATCH_CLIP, viewerInput.camera.clipFromWorldMatrix, NOCLIP_SPACE_CORRECTION);
        offs += fillMatrix4x4(d, offs, SCRATCH_CLIP);
        // u_Time (1)
        d[offs++] = viewerInput.time * this.scrollSpeed;
        // u_MIDNear (1)
        d[offs++] = this.midThresold;
        // u_MIDFar (1)
        d[offs++] = this.lodThrehold;

        const c = vec3.fromValues(viewerInput.camera.worldMatrix[12], viewerInput.camera.worldMatrix[13], viewerInput.camera.worldMatrix[14]);
        const l = this.applyLOD ? this.lodThrehold : Infinity;
        const m = this.applyLOD ? this.midThresold : Infinity;
        for (const part of this.parts) {
            part.prepareToRender(renderHelper, viewerInput, this.gfxSamplerBindings, c, l, m);
        }

        if (this.showMobys) {
            this.drawMobys(renderHelper);
        }

        renderHelper.renderInstManager.popTemplate();
    }

    private drawMobys(renderHelper: GfxRenderHelper): void {
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
        for (const p of this.parts) {
            p.destroy(device);
        }
        for (const t of this.textures) {
            device.destroyTexture(t.gfxTexture);
        }
    }
}

interface DrawCall {
    texture: number;
    count: number;
    offset: number;
}

class PartRenderer {
    public hasMDL: boolean;
    public hasLOD: boolean;
    private indexBufferDescriptor: GfxIndexBufferDescriptor;
    private vertexBufferDescriptors: GfxVertexBufferDescriptor[];
    private drawCount: number;
    private drawCountLOD: number;
    private drawCalls: DrawCall[];
    private indexLODOffset: number;
    private bbox: AABB;
    private bboxPoints: number[];
    private bboxLOD: AABB;
    private bboxPointsLOD: number[];
    private centerPoint: vec3;

    constructor(cache: GfxRenderCache, part: SpyroGroundPart, private inputLayout: GfxInputLayout) {
        const vertices: number[] = [];
        const colors: number[] = [];
        const midColors: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];

        // build mdl vertex buffers and gather draw call ordering
        const callMapping: number[] = [];
        for (const polygon of part.polygons) {
            if (!callMapping.includes(polygon.textureIndex)) {
                callMapping.push(polygon.textureIndex);
            }
        }
        callMapping.sort();
        this.drawCalls = Array(callMapping.length);
        const callIndices: number[] = [];
        for (const polygon of part.polygons) {
            for (let i = 0; i < 3; i++) {
                const v = part.vlut[polygon.vertices[i]];
                const c = part.clut[polygon.colors[i]].map(c => c / 255);
                const mc = part.clutMID[polygon.colors[i]].map(c => c / 255);
                vertices.push(v[0], v[1], v[2]);
                colors.push(c[0], c[1], c[2]);
                midColors.push(mc[0], mc[1], mc[2]);
                uvs.push(polygon.uvs[i][0], polygon.uvs[i][1]);
                callIndices.push(polygon.textureIndex);
            }
        }
        // build mdl indices sequentially by texture index, keep track of counts and offsets
        for (let i = 0; i < callMapping.length; i++) {
            let count = 0;
            const offset = indices.length;
            for (let j = 0; j < callIndices.length; j++) {
                if (callMapping.indexOf(callIndices[j]) === i) {
                    indices.push(j);
                    count++;
                }
            }
            this.drawCalls[i] = { texture: callMapping[i], count, offset };
        }
        this.bbox = getAABB(vertices);
        this.bboxPoints = getBboxPoints(this.bbox);
        this.drawCount = indices.length;
        this.indexLODOffset = indices.length;
        this.hasMDL = indices.length > 0;

        // append lod indices after mdl indices
        let index = this.drawCount;
        for (const polygon of part.polygonsLOD) {
            for (let i = 0; i < 3; i++) {
                const v = part.vlutLOD[polygon.vertices[i]];
                const c = part.clutLOD[polygon.colors[i]].map(c => c / 255);
                vertices.push(v[0], v[1], v[2]);
                colors.push(c[0], c[1], c[2]);
                midColors.push(1, 1, 1); // shouldn't ever be visible, but pad to keep alignment
                uvs.push(polygon.uvs[i][0], polygon.uvs[i][1]);
                indices.push(index++);
            }
        }
        this.bboxLOD = getAABB(vertices.slice(this.drawCount));
        this.bboxPointsLOD = getBboxPoints(this.bboxLOD);
        this.drawCountLOD = indices.length - this.indexLODOffset;
        this.hasLOD = this.drawCountLOD > 0;
        this.centerPoint = vec3.create();
        (this.hasMDL ? this.bbox : this.bboxLOD).centerPoint(this.centerPoint);

        this.vertexBufferDescriptors = [
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(vertices).buffer), byteOffset: 0 },
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(colors).buffer), byteOffset: 0 },
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(midColors).buffer), byteOffset: 0 },
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(uvs).buffer), byteOffset: 0 }
        ];
        this.indexBufferDescriptor = { buffer: createBufferFromData(cache.device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, new Uint32Array(indices).buffer), byteOffset: 0 };
    }

    public prepareToRender(renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput, gfxSamplerBindings: GfxSamplerBinding[][], cameraPos: vec3, lodThrehold: number, midThresold: number) {
        const depth = vec3.distance(cameraPos, this.centerPoint);
        const lod = lodThrehold < Infinity ? (!this.hasMDL && this.hasLOD ? true : depth >= lodThrehold) : false;
        const mid = this.hasMDL ? depth >= midThresold && depth < lodThrehold : false;
        const visible = (lod ? this.drawCountLOD : this.drawCount) > 0 && inView(lod ? this.bboxPointsLOD : this.bboxPoints, viewerInput.camera.clipFromWorldMatrix);
        if (visible) {
            const template = renderHelper.renderInstManager.pushTemplate();
            template.setVertexInput(this.inputLayout, this.vertexBufferDescriptors, this.indexBufferDescriptor);
            this.fillDrawParams(template, !lod, mid);

            if (lod) {
                const renderInst = renderHelper.renderInstManager.newRenderInst();

                renderInst.setDrawCount(this.drawCountLOD, this.indexLODOffset);

                renderHelper.renderInstManager.submitRenderInst(renderInst);
            } else {
                for (const drawCall of this.drawCalls) {
                    const renderInst = renderHelper.renderInstManager.newRenderInst();

                    renderInst.setSamplerBindingsFromTextureMappings(gfxSamplerBindings[drawCall.texture]);
                    renderInst.setDrawCount(drawCall.count, drawCall.offset);

                    renderHelper.renderInstManager.submitRenderInst(renderInst);
                }
            }

            renderHelper.renderInstManager.popTemplate();
        }
    }

    public destroy(device: GfxDevice) {
        device.destroyBuffer(this.indexBufferDescriptor.buffer);
        for (const d of this.vertexBufferDescriptors) {
            device.destroyBuffer(d.buffer);
        }
    }

    private fillDrawParams(renderInst: GfxRenderInst, applyTextures: boolean, useMIDColor: boolean) {
        let offs = renderInst.allocateUniformBuffer(Shader.ub_DrawParams, 4);
        const d = renderInst.mapUniformBufferF32(Shader.ub_DrawParams);
        // u_ApplyTextures (1)
        d[offs++] = applyTextures ? 1.0 : 0.0;
        // u_UseMIDColor (1)
        d[offs++] = useMIDColor ? 1.0 : 0.0;
        // u_Brightness (1)
        d[offs++] = BRIGHTNESS_OPAQUE;
        // u_Scroll (1)
        d[offs++] = 0.0;
    }
}

class SkyboxShader extends DeviceProgram {
    public static ub_SceneParams = 0;

    public override both = `
precision highp float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_ViewProj;
};

varying vec3 v_Color;

#ifdef VERT
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec3 a_Color;

void main() {
    v_Color = a_Color;
    gl_Position = UnpackMatrix(u_ViewProj) * vec4(a_Position, 1.0);
}
#endif

#ifdef FRAG
void main() {
    gl_FragColor = vec4(v_Color, 1.0);
}
#endif
    `;

    constructor() {
        super();
    }
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

        let offs = renderInst.allocateUniformBuffer(SkyboxShader.ub_SceneParams, 16);
        const d = renderInst.mapUniformBufferF32(SkyboxShader.ub_SceneParams);
        // u_ViewProj (16)
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
