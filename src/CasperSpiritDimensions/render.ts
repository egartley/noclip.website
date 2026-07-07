import { mat4, quat, ReadonlyMat4, vec3 } from "gl-matrix";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { fillMatrix4x3, fillMatrix4x4, fillVec4v } from "../gfx/helpers/UniformBufferHelpers";
import { GfxBindingLayoutDescriptor, GfxBlendFactor, GfxBlendMode, GfxBufferFrequencyHint, GfxBufferUsage, GfxCullMode, GfxDevice, GfxFormat, GfxIndexBufferDescriptor, GfxInputLayout, GfxMipFilterMode, GfxProgram, GfxSampler, GfxTexFilterMode, GfxVertexBufferDescriptor, GfxVertexBufferFrequency, GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { DeviceProgram } from "../Program";
import { ViewerRenderInput } from "../viewer";
import { CasperMesh, CasperTexture, CasperObjectInstance, CapserLevel, CasperBSPNode, CasperFrame, CapserMaterialType, CasperMaterial, CasperSKA, CasperAnimationTrack, CasperKeyframe } from "./bin";
import { calcEulerAngleRotationFromSRTMatrix, computeModelMatrixSRT, lerp, Mat4Identity, MathConstants } from "../MathHelpers";
import { AABB } from "../Geometry";
import { Layer } from "../ui";
import { computeViewMatrix } from "../Camera";
import { drawWorldSpaceLine, drawWorldSpaceText, getDebugOverlayCanvas2D } from "../DebugJunk";
import { White } from "../Color";

interface DrawCall {
    materialIndex: number;
    indexOffset: number;
    indexCount: number;
}

interface MeshBufferData {
    vertices: Float32Array;
    indices: Uint32Array;
    colors: Float32Array;
    uvs: Float32Array;
    joints?: Uint8Array;
    weights?: Float32Array;
}

class Shader extends DeviceProgram {
    public static a_Position = 0;
    public static a_Color = 1;
    public static a_UV = 2;
    public static a_Joint = 3;
    public static a_Weight = 4;
    public static ub_SceneParams = 0;
    public static ub_InstanceParams = 1;
    public static ub_DrawParams = 2;

    constructor(boneCount: number) {
        super();
        this.both = `
precision highp float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    float u_ShowTextures;
};

layout(std140) uniform ub_InstanceParams {
    Mat3x4 u_View;
    ${boneCount > 0 ? `Mat3x4 u_BoneSRT[${boneCount}];` : ``}
};

layout(std140) uniform ub_DrawParams {
    vec4 u_MaterialColor;
    float u_HasTexture;
};

uniform sampler2D u_Texture;

varying vec3 v_Color;
varying vec2 v_UV;

#ifdef VERT
layout(location = ${Shader.a_Position}) in vec3 a_Position;
layout(location = ${Shader.a_Color}) in vec3 a_Color;
layout(location = ${Shader.a_UV}) in vec2 a_UV;
${boneCount > 1 ?
    `layout(location = ${Shader.a_Joint}) in uvec4 a_Joint;
    layout(location = ${Shader.a_Weight}) in vec4 a_Weight;`
    : ''}

void main() {
    v_Color = a_Color;
    v_UV = a_UV;
    ${boneCount > 1 ?
        `mat4x3 t_BoneMatrix = mat4x3(0.0);
    t_BoneMatrix += UnpackMatrix(u_BoneSRT[a_Joint.x]) * a_Weight.x;
    t_BoneMatrix += UnpackMatrix(u_BoneSRT[a_Joint.y]) * a_Weight.y;
    t_BoneMatrix += UnpackMatrix(u_BoneSRT[a_Joint.z]) * a_Weight.z;
    t_BoneMatrix += UnpackMatrix(u_BoneSRT[a_Joint.w]) * a_Weight.w;
    vec3 t_ViewPosition = UnpackMatrix(u_View) * vec4(t_BoneMatrix * vec4(a_Position, 1.0), 1.0);
    gl_Position = UnpackMatrix(u_Projection) * vec4(t_ViewPosition, 1.0);`
    : 'gl_Position = UnpackMatrix(u_Projection) * vec4(UnpackMatrix(u_View) * vec4(a_Position, 1.0), 1.0);'}
}
#endif

#ifdef FRAG
void main() {
    if (u_ShowTextures > 0.1) {
        if (u_HasTexture > 0.1) {
            vec4 color = texture(SAMPLER_2D(u_Texture), v_UV);
            if (color.a < 0.1) {
                discard;
            }
            vec3 ambient = vec3(0.075); // close approx to PS2 appearance
            color *= vec4(clamp(v_Color + ambient, 0.0, 1.0), 1.0);
            gl_FragColor = color;
        } else {
            gl_FragColor = u_MaterialColor * vec4(v_Color, 1.0);
        }
    } else {
        gl_FragColor = vec4(v_Color, 1.0);
    }
}
#endif
    `;
    }
}

const BINDING_LAYOUTS: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 3, numSamplers: 1 }];
const WORLD_SCALE = 300; // raw XYZ are extremely small
const BACK_CULL_LEVELS = [5, 8, 9, 11, 12, 14]; // levels that are mostly interior
const SCRATCH_VIEW = mat4.create();
const SCRATCH_INSTANCE = mat4.create();
const SCRATCH_BONE = mat4.create();
const SCRATCH_QUAT = quat.create();
const SCRATCH_POS = vec3.create();
const scratchVec3a = vec3.create();
const scratchVec3b = vec3.create();

export class CasperLevelRenderer {
    public showTextures: boolean = true;
    public showObjects: boolean = true;
    public cullMode: GfxCullMode = GfxCullMode.None;
    public meshLayers: Layer[] = [];
    private indexBufferDescriptor: GfxIndexBufferDescriptor;
    private vertexBufferDescriptors: GfxVertexBufferDescriptor[] = [];
    private drawCalls: DrawCall[] = [];
    private sortKeys: Map<string, number> = new Map();
    private shiftMatrix: mat4;
    private objectRenderers: MeshRenderer[] = [];
    private gfxInputLayout: GfxInputLayout;
    private gfxProgram: GfxProgram;
    private gfxSampler: GfxSampler;
    private materials: CasperMaterial[];

    constructor(cache: GfxRenderCache, level: CapserLevel, private textures: Map<string, CasperTexture>, meshes: Map<string, CasperMesh>, objInstances: CasperObjectInstance[], skas: Map<string, CasperSKA>) {
        if (BACK_CULL_LEVELS.includes(level.number)) {
            this.cullMode = GfxCullMode.Back;
        }

        this.materials = level.materials;
        const { vertices, indices, uvs, colors } = this.buildBuffersAndDrawCalls(level.root);
        const validDrawCalls = this.drawCalls.filter(dc => this.materials[dc.materialIndex].type === CapserMaterialType.COLOR ||
            (this.materials[dc.materialIndex].type === CapserMaterialType.TEXTURE && this.textures.get(this.materials[dc.materialIndex].name) !== undefined));
        if (this.drawCalls.length !== validDrawCalls.length) {
            console.warn(level.name, "has invalid texture materials",
                this.drawCalls.filter(dc => this.materials[dc.materialIndex].type === CapserMaterialType.TEXTURE &&
                this.textures.get(this.materials[dc.materialIndex].name) === undefined),
                this.materials);
        }
        this.drawCalls = validDrawCalls;
        this.drawCalls = this.drawCalls.filter(dc => this.textures.get(this.materials[dc.materialIndex].name) !== undefined);
        this.indexBufferDescriptor = { buffer: createBufferFromData(cache.device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indices.buffer), byteOffset: 0 };
        this.vertexBufferDescriptors = [
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, vertices.buffer), byteOffset: 0 },
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, colors.buffer), byteOffset: 0 },
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, uvs.buffer), byteOffset: 0 },
        ];
        this.meshLayers.push({ name: level.name, visible: true, setVisible(v: boolean) { this.visible = v } });

        for (const [name, mesh] of meshes.entries()) {
            const meshTextures = new Map<string, CasperTexture>();
            for (const t of mesh.materials!.filter(m => m.type === CapserMaterialType.TEXTURE)) {
                meshTextures.set(t.name, this.textures.get(t.name)!);
            }
            this.objectRenderers.push(new MeshRenderer(cache, name, meshTextures, mesh, objInstances.filter(i => i.name === name), skas.get(name)));
            this.meshLayers.push({ name, visible: true, setVisible(v: boolean) { this.visible = v } });
        }

        this.gfxInputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                { location: Shader.a_Position, bufferIndex: 0, format: GfxFormat.F32_RGB, bufferByteOffset: 0 },
                { location: Shader.a_Color, bufferIndex: 1, format: GfxFormat.F32_RGB, bufferByteOffset: 0 },
                { location: Shader.a_UV, bufferIndex: 2, format: GfxFormat.F32_RG, bufferByteOffset: 0 }
            ],
            vertexBufferDescriptors: [
                { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex },
                { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex },
                { byteStride: 8, frequency: GfxVertexBufferFrequency.PerVertex }
            ],
            indexBufferFormat: GfxFormat.U32_R
        });

        this.gfxProgram = cache.createProgram(new Shader(0));
        this.gfxSampler = cache.createSampler({
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Nearest,
            wrapS: GfxWrapMode.Repeat,
            wrapT: GfxWrapMode.Repeat
        });
        this.shiftMatrix = computeShiftMatrix();
    }

    public prepareToRender(device: GfxDevice, renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput) {
        const template = renderHelper.renderInstManager.pushTemplate();

        template.setBindingLayouts(BINDING_LAYOUTS);
        template.setUniformBuffer(renderHelper.uniformBuffer);

        let offset = template.allocateUniformBuffer(Shader.ub_SceneParams, 17);
        const uniformBuffer = template.mapUniformBufferF32(Shader.ub_SceneParams);
        // u_Projection (16)
        offset += fillMatrix4x4(uniformBuffer, offset, viewerInput.camera.projectionMatrix);
        // u_ShowTextures (1)
        uniformBuffer[offset++] = this.showTextures ? 1.0 : 0.0;

        computeViewMatrix(SCRATCH_VIEW, viewerInput.camera);
        if (this.meshLayers[0].visible) {
            const renderInst = renderHelper.renderInstManager.pushTemplate();

            let offset2 = template.allocateUniformBuffer(Shader.ub_InstanceParams, 12);
            const uniformBuffer2 = template.mapUniformBufferF32(Shader.ub_InstanceParams);
            // u_View (12)
            mat4.mul(SCRATCH_INSTANCE, SCRATCH_VIEW, this.shiftMatrix);
            offset2 += fillMatrix4x3(uniformBuffer2, offset2, SCRATCH_INSTANCE);

            renderInst.setVertexInput(this.gfxInputLayout, this.vertexBufferDescriptors, this.indexBufferDescriptor);
            renderInst.setGfxProgram(this.gfxProgram);
            for (const drawCall of this.drawCalls) {
                const material = this.materials[drawCall.materialIndex];

                const renderInst = renderHelper.renderInstManager.newRenderInst();
                let offset3 = renderInst.allocateUniformBuffer(Shader.ub_DrawParams, 5);
                const uniformBuffer3 = renderInst.mapUniformBufferF32(Shader.ub_DrawParams);
                // u_MaterialColor (4)
                offset3 += fillVec4v(uniformBuffer3, offset3, material.color);
                // u_HasTexture (1)
                uniformBuffer3[offset3++] = material.type === CapserMaterialType.TEXTURE ? 1.0 : 0.0;

                if (material.type === CapserMaterialType.TEXTURE) {
                    const texture = this.textures.get(material.name)!;
                    const megaState = renderInst.getMegaStateFlags();
                    if (texture.hasAlpha) {
                        setAttachmentStateSimple(megaState, {
                            blendMode: GfxBlendMode.Add,
                            blendSrcFactor: GfxBlendFactor.SrcAlpha,
                            blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha
                        });
                    }
                    renderInst.sortKey = this.sortKeys.get(texture.gfxTexture.ResourceName!)!;
                    renderInst.setMegaStateFlags(megaState);
                    renderInst.setSamplerBindingsFromTextureMappings([{ gfxTexture: texture.gfxTexture, gfxSampler: this.gfxSampler }]);
                }
                renderInst.setDrawCount(drawCall.indexCount, drawCall.indexOffset);
                renderHelper.renderInstManager.submitRenderInst(renderInst);
            }

            renderHelper.renderInstManager.popTemplate();
        }

        if (this.showObjects) {
            for (const or of this.objectRenderers) {
                if (this.meshLayers.find(m => m.name === or.name)!.visible) {
                    or.prepareToRender(device, renderHelper, viewerInput);
                }
            }
        }
    }

    public destroy(device: GfxDevice) {
        for (const or of this.objectRenderers) {
            or.destroy(device);
        }
        device.destroyBuffer(this.indexBufferDescriptor.buffer);
        for (const d of this.vertexBufferDescriptors) {
            device.destroyBuffer(d.buffer);
        }
        for (const texture of this.textures.values()) {
            device.destroyTexture(texture.gfxTexture);
        }
    }

    private buildBuffersAndDrawCalls(rootNode: CasperBSPNode): MeshBufferData {
        let vertexOffset = 0;
        const vertices: number[] = [];
        const colors: number[] = [];
        const uvs: number[] = [];
        const indexGroups = new Map<number, number[]>();
        const traverse = (node: CasperBSPNode) => {
            if (node.mesh && node.mesh.vertices.length > 0) {
                const offsetBase = vertexOffset;
                vertices.push(...node.mesh.vertices);
                colors.push(...node.mesh.colors.map(c => c / 255));
                uvs.push(...node.mesh.uvs);
                vertexOffset += node.mesh.vertices.length / 3;
                for (const split of node.mesh.indexSplits) {
                    const material = this.materials[split.materialIndex];
                    if (material === undefined) {
                        continue;
                    }
                    if (!indexGroups.has(split.materialIndex)) {
                        indexGroups.set(split.materialIndex, []);
                    }
                    const groupIndices = indexGroups.get(split.materialIndex)!;
                    for (const index of split.indices) {
                        groupIndices.push(index + offsetBase);
                    }
                }
            }
            if (node.leaves) {
                node.leaves.forEach(traverse);
            }
        };

        traverse(rootNode);

        const indices: number[] = [];
        indexGroups.forEach((groupIndices, materialIndex) => {
            const batch = { materialIndex, indexOffset: indices.length, indexCount: groupIndices.length };
            indices.push(...groupIndices);
            this.drawCalls.push(batch);
        });

        return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices), colors: new Float32Array(colors), uvs: new Float32Array(uvs) };
    }
}

function decomposeBoneTransform(transform: ReadonlyMat4): { scale: vec3, rotation: vec3, translation: vec3 } {
    const scale = vec3.create();
    const rotation = vec3.create();
    const translation = vec3.create();
    mat4.getScaling(scale, transform);
    calcEulerAngleRotationFromSRTMatrix(rotation, transform);
    mat4.getTranslation(translation, transform);
    return { scale, rotation, translation };
}

class MeshRenderer {
    private drawCalls: DrawCall[] = [];
    private gfxInputLayout: GfxInputLayout;
    private gfxSampler: GfxSampler;
    private gfxProgram: GfxProgram;
    private indexBufferDescriptor: GfxIndexBufferDescriptor;
    private vertexBufferDescriptors: GfxVertexBufferDescriptor[] = [];
    private localTransformMatrices: mat4[] = [];
    private frames: CasperFrame[] = [];
    private inverseTransforms: mat4[] = [];
    private materials: CasperMaterial[] = [];
    private animationTracks: CasperAnimationTrack[] = [];
    private currentTime: number = 0;

    constructor(cache: GfxRenderCache, public name: string, private textures: Map<string, CasperTexture>, mesh: CasperMesh, private instances: CasperObjectInstance[], private ska?: CasperSKA) {
        const { vertices, indices, uvs, colors, joints, weights } = this.buildBuffersAndDrawCalls(mesh);
        this.materials = mesh.materials ? mesh.materials : [];
        const validDrawCalls = this.drawCalls.filter(dc => this.materials[dc.materialIndex].type === CapserMaterialType.COLOR ||
            (this.materials[dc.materialIndex].type === CapserMaterialType.TEXTURE && this.textures.get(this.materials[dc.materialIndex].name) !== undefined));
        if (this.drawCalls.length !== validDrawCalls.length) {
            console.warn(this.name, "has invalid texture materials",
                this.drawCalls.filter(dc => this.materials[dc.materialIndex].type === CapserMaterialType.TEXTURE &&
                this.textures.get(this.materials[dc.materialIndex].name) === undefined),
                this.materials);
        }
        this.drawCalls = validDrawCalls;
        this.indexBufferDescriptor = { buffer: createBufferFromData(cache.device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indices.buffer), byteOffset: 0 };
        this.vertexBufferDescriptors = [
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, vertices.buffer), byteOffset: 0 },
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, colors.buffer), byteOffset: 0 },
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, uvs.buffer), byteOffset: 0 }
        ];

        const vertexAttributeDescriptors = [
            { location: Shader.a_Position, bufferIndex: Shader.a_Position, format: GfxFormat.F32_RGB, bufferByteOffset: 0 },
            { location: Shader.a_Color, bufferIndex: Shader.a_Color, format: GfxFormat.F32_RGB, bufferByteOffset: 0 },
            { location: Shader.a_UV, bufferIndex: Shader.a_UV, format: GfxFormat.F32_RG, bufferByteOffset: 0 }
        ];
        const inVertexBufferDescriptors = [
            { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex },
            { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex },
            { byteStride: 8, frequency: GfxVertexBufferFrequency.PerVertex }
        ];

        if (mesh.skinningData) {
            this.vertexBufferDescriptors.push({ buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, joints!.buffer), byteOffset: 0 });
            this.vertexBufferDescriptors.push({ buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, weights!.buffer), byteOffset: 0 });
            vertexAttributeDescriptors.push({ location: Shader.a_Joint, bufferIndex: Shader.a_Joint, format: GfxFormat.U8_RGBA, bufferByteOffset: 0 });
            vertexAttributeDescriptors.push({ location: Shader.a_Weight, bufferIndex: Shader.a_Weight, format: GfxFormat.F32_RGBA, bufferByteOffset: 0 });
            inVertexBufferDescriptors.push({ byteStride: 4, frequency: GfxVertexBufferFrequency.PerVertex });
            inVertexBufferDescriptors.push({ byteStride: 16, frequency: GfxVertexBufferFrequency.PerVertex });

            this.frames = mesh.frames.slice(1);
            this.localTransformMatrices = Array(this.frames.length);
            this.inverseTransforms = [...mesh.skinningData.inverseTransforms];
            for (let i = 0; i < this.frames.length; i++) {
                this.frames[i].parentIndex -= 1;
                this.localTransformMatrices[i] = mat4.create();
                //this.inverseTransforms[i] = mat4.create();
                mat4.translate(this.localTransformMatrices[i], this.localTransformMatrices[i], this.frames[i].pos);
                // expand rotation 3x3 into 4x4, then apply to srt (rather than decomposing into srt)
                const rot = mat4.fromValues(
                    this.frames[i].rot[0], this.frames[i].rot[1], this.frames[i].rot[2], 0,
                    this.frames[i].rot[3], this.frames[i].rot[4], this.frames[i].rot[5], 0,
                    this.frames[i].rot[6], this.frames[i].rot[7], this.frames[i].rot[8], 0,
                    0, 0, 0, 1
                );
                mat4.mul(this.localTransformMatrices[i], this.localTransformMatrices[i], rot);
                if (this.frames[i].parentIndex >= 0) {
                    mat4.mul(this.localTransformMatrices[i], this.localTransformMatrices[this.frames[i].parentIndex], this.localTransformMatrices[i]);
                }
                //mat4.invert(this.inverseTransforms[i], this.localTransformMatrices[i]);
            }

            if (ska) {
                // node/frame/bone order is implicit, based on RW manual, vol 2, section 15.3
                // it's essentially a linked list of keyframes per bone, determined by offsets
                this.animationTracks = Array(this.frames.length);
                for (let i = 0; i < this.frames.length; i++) {
                    const track: CasperAnimationTrack = { keyframes: [ska.keyframes[i]] };
                    let hasNext = true;
                    let keyframe = ska.keyframes[i];
                    while (hasNext) {
                        const nextIndex = ska.keyframes.findIndex(kf => kf.previousOffset === keyframe.offset);
                        if (nextIndex > -1) {
                            keyframe = ska.keyframes[nextIndex];
                            track.keyframes.push(keyframe);
                        } else {
                            hasNext = false;
                        }
                    }
                    this.animationTracks[i] = track;
                }
            }
        }
        
        this.gfxInputLayout = cache.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors: inVertexBufferDescriptors, indexBufferFormat: GfxFormat.U32_R });
        this.gfxSampler = cache.createSampler({
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Nearest,
            wrapS: GfxWrapMode.Repeat,
            wrapT: GfxWrapMode.Repeat
        });
        this.gfxProgram = cache.createProgram(new Shader(mesh.skinningData ? this.frames.length : 0));

        const bs = mesh.boundingSphere!;
        for (const instance of this.instances) {
            instance.shiftMatrix = computeShiftMatrix(instance);
            const bbox = new AABB(bs.x - bs.r, bs.y - bs.r, bs.z - bs.r, bs.x + bs.r, bs.y + bs.r, bs.z + bs.r);
            bbox.transform(bbox, instance.shiftMatrix);
            instance.bbox = bbox;
        }
    }

    public prepareToRender(device: GfxDevice, renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput) {
        const renderInst = renderHelper.renderInstManager.pushTemplate();

        renderInst.setVertexInput(this.gfxInputLayout, this.vertexBufferDescriptors, this.indexBufferDescriptor);
        renderInst.setGfxProgram(this.gfxProgram);

        // if (this.ska) {
        //     this.currentTime += viewerInput.deltaTime;
        //     if (this.currentTime > this.ska.totalDuration) {
        //         this.currentTime %= this.ska.totalDuration;
        //     }
        //     this.computeBoneMatrices();
        // }
        
        for (let i = 0; i < this.instances.length; i++) {
            const instance = this.instances[i];
            const template = renderHelper.renderInstManager.pushTemplate();

            let offset = template.allocateUniformBuffer(Shader.ub_InstanceParams, 12 + (12 * this.frames.length));
            const uniformBuffer = template.mapUniformBufferF32(Shader.ub_InstanceParams);
            // u_View (12)
            mat4.mul(SCRATCH_INSTANCE, SCRATCH_VIEW, instance.shiftMatrix);
            offset += fillMatrix4x3(uniformBuffer, offset, SCRATCH_INSTANCE);
            // u_BoneSRT (12 * boneCount)
            for (let i = 0; i < this.frames.length; i++) {
                mat4.mul(SCRATCH_BONE, this.localTransformMatrices[i], this.inverseTransforms[i]);
                offset += fillMatrix4x3(uniformBuffer, offset, SCRATCH_BONE);
            }

            for (const drawCall of this.drawCalls) {
                const material = this.materials[drawCall.materialIndex];

                const renderInst = renderHelper.renderInstManager.newRenderInst();
                let offset2 = renderInst.allocateUniformBuffer(Shader.ub_DrawParams, 5);
                const uniformBuffer2 = renderInst.mapUniformBufferF32(Shader.ub_DrawParams);
                // u_MaterialColor (4)
                offset2 += fillVec4v(uniformBuffer2, offset2, material.color);
                // u_HasTexture (1)
                uniformBuffer2[offset2++] = material.type === CapserMaterialType.TEXTURE ? 1.0 : 0.0;

                if (material.type === CapserMaterialType.TEXTURE) {
                    const texture = this.textures.get(material.name)!;
                    const megaState = renderInst.getMegaStateFlags();
                    if (texture.hasAlpha) {
                        setAttachmentStateSimple(megaState, {
                            blendMode: GfxBlendMode.Add,
                            blendSrcFactor: GfxBlendFactor.SrcAlpha,
                            blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha
                        });
                    }
                    renderInst.setMegaStateFlags(megaState);
                    renderInst.setSamplerBindingsFromTextureMappings([{ gfxTexture: texture.gfxTexture, gfxSampler: this.gfxSampler }]);
                }
                renderInst.setDrawCount(drawCall.indexCount, drawCall.indexOffset);
                renderHelper.renderInstManager.submitRenderInst(renderInst);
            }
            if (this.localTransformMatrices.length > 0 && this.instances.indexOf(instance) === 0) {
                const ctx = getDebugOverlayCanvas2D();
                for (let i = 0; i < this.localTransformMatrices.length; i++) {
                    vec3.set(scratchVec3a, 0, 0, 0);
                    mat4.mul(SCRATCH_BONE, instance.shiftMatrix, this.frames[i].parentIndex >= 0 ? this.localTransformMatrices[this.frames[i].parentIndex] : Mat4Identity);
                    vec3.transformMat4(scratchVec3a, scratchVec3a, SCRATCH_BONE);
                    vec3.set(scratchVec3b, 0, 0, 0);
                    mat4.mul(SCRATCH_BONE, instance.shiftMatrix, this.localTransformMatrices[i]);
                    vec3.transformMat4(scratchVec3b, scratchVec3b, SCRATCH_BONE);
                    drawWorldSpaceLine(ctx, viewerInput.camera.clipFromWorldMatrix, scratchVec3a, scratchVec3b);
                    drawWorldSpaceText(ctx, viewerInput.camera.clipFromWorldMatrix, scratchVec3b, `${i}`, 0, White);
                }
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

    private computeBoneMatrices() {
        for (let i = 0; i < this.frames.length; i++) {
            const { current, next, t } = this.getKeyframePair(this.animationTracks[i]);
            quat.slerp(SCRATCH_QUAT, current.rot, next.rot, t);
            vec3.lerp(SCRATCH_POS, current.pos, next.pos, t);
            mat4.fromRotationTranslation(this.localTransformMatrices[i], SCRATCH_QUAT, SCRATCH_POS);
            if (this.frames[i].parentIndex >= 0) {
                mat4.mul(this.localTransformMatrices[i], this.localTransformMatrices[this.frames[i].parentIndex], this.localTransformMatrices[i]);
            }
        }
    }

    private getKeyframePair(track: CasperAnimationTrack): { current: CasperKeyframe, next: CasperKeyframe, t: number } {
        let current, next;
        if (track.keyframes.length === 2) {
            current = track.keyframes[0];
            next = track.keyframes[1];
        } else if (track.keyframes.length > 2) {
            let nextIndex = track.keyframes.findIndex(kf => kf.time > this.currentTime);
            if (nextIndex === -1) {
                nextIndex = track.keyframes.length - 1;
            }
            current = track.keyframes[nextIndex - 1];
            next = track.keyframes[nextIndex];
        } else {
            throw new Error("Animation track must have at least 2 keyframes!");
        }
        const delta = next.time - current.time;
        const t = delta === 0 ? 0 : (this.currentTime - current.time) / delta;
        return { current, next, t };
    }

    private buildBuffersAndDrawCalls(mesh: CasperMesh): MeshBufferData {
        const vertices: number[] = [];
        const colors: number[] = [];
        const indexGroups = new Map<number, number[]>();
        if (mesh.vertices.length > 0 && mesh.materials) {
            vertices.push(...mesh.vertices);
            colors.push(...mesh.colors.map(c => c / 255));
            for (const split of mesh.indexSplits) {
                const material = mesh.materials[split.materialIndex];
                if (material === undefined) {
                    continue;
                }
                if (!indexGroups.has(split.materialIndex)) {
                    indexGroups.set(split.materialIndex, []);
                }
                const groupIndices = indexGroups.get(split.materialIndex)!;
                for (const i of split.indices) {
                    groupIndices.push(i);
                }
            }
        }

        const indices: number[] = [];
        indexGroups.forEach((groupIndices, materialIndex) => {
            const drawCall = { materialIndex, indexOffset: indices.length, indexCount: groupIndices.length };
            indices.push(...groupIndices);
            this.drawCalls.push(drawCall);
        });

        let joints;
        let weights;
        if (mesh.skinningData) {
            joints = [];
            for (const j of mesh.skinningData!.indices) {
                joints.push(...j);
            }
            weights = [];
            for (const w of mesh.skinningData!.weights) {
                weights.push(...w);
            }
            joints = new Uint8Array(joints);
            weights = new Float32Array(weights);
        }

        return {
            vertices: new Float32Array(vertices),
            indices: new Uint32Array(indices),
            colors: new Float32Array(colors),
            uvs: new Float32Array(mesh.uvs),
            joints,
            weights
        };
    }   
}

function computeShiftMatrix(obj?: CasperObjectInstance): mat4 {
    const srt = mat4.create();
    if (obj) {
        computeModelMatrixSRT(srt,
            obj.scale.x * WORLD_SCALE, obj.scale.y * WORLD_SCALE, obj.scale.z * WORLD_SCALE,
            0, obj.rotation.z * MathConstants.DEG_TO_RAD, 0,
            obj.position.x * WORLD_SCALE, obj.position.z * WORLD_SCALE, -obj.position.y * WORLD_SCALE
        );
    } else {
        computeModelMatrixSRT(srt, WORLD_SCALE, WORLD_SCALE, WORLD_SCALE, 0, 0, 0, 0, 0, 0);
    }
    return srt;
}
