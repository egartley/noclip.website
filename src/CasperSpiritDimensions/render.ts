import { mat4, vec3 } from "gl-matrix";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { fillMatrix4x4 } from "../gfx/helpers/UniformBufferHelpers";
import { GfxBindingLayoutDescriptor, GfxBlendFactor, GfxBlendMode, GfxBuffer, GfxBufferFrequencyHint, GfxBufferUsage, GfxCullMode, GfxDevice, GfxFormat, GfxIndexBufferDescriptor, GfxInputLayout, GfxMipFilterMode, GfxProgram, GfxSampler, GfxTexFilterMode, GfxVertexBufferDescriptor, GfxVertexBufferFrequency, GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { DeviceProgram } from "../Program";
import { ViewerRenderInput } from "../viewer";
import { CasperMesh, CasperTexture, CasperObjectInstance, CapserLevel, CasperBSPNode, CasperBone } from "./bin";
import { GfxRenderInstManager } from "../gfx/render/GfxRenderInstManager";
import { computeModelMatrixSRT, MathConstants } from "../MathHelpers";
import { AABB } from "../Geometry";
import { Layer } from "../ui";
import { computeViewMatrix } from "../Camera";
import { drawWorldSpaceLine, getDebugOverlayCanvas2D } from "../DebugJunk";

interface DrawCall {
    textureName: string;
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
    Mat4x4 u_View;
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
    gl_Position = UnpackMatrix(u_Projection) * UnpackMatrix(u_View) * vec4(a_Position, 1.0);
}
#endif

#ifdef FRAG
void main() {
    if (u_ShowTextures > 0.1) {
        vec4 color = texture(SAMPLER_2D(u_Texture), v_UV);
        if (color.a < 0.1) {
            discard;
        }
        vec3 ambient = vec3(0.075); // close approx to PS2 appearance
        color *= vec4(clamp(v_Color + ambient, 0.0, 1.0), 1.0);
        gl_FragColor = color;
    } else {
        gl_FragColor = vec4(v_Color, 1.0);
    }
}
#endif
    `;
    }
}

const BINDING_LAYOUTS: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 2, numSamplers: 1 }];
const WORLD_SCALE = 300; // raw XYZ are extremely small
const BACK_CULL_LEVELS = [5, 8, 9, 11, 12, 14]; // levels that are mostly interior
const SCRATCH_VIEW = mat4.create();
const SCRATCH_INSTANCE = mat4.create();
const scratchVec3a = vec3.create();
const scratchVec3b = vec3.create();

export class CasperLevelRenderer {
    private indexBufferDescriptor: GfxIndexBufferDescriptor;
    private vertexBufferDescriptors: GfxVertexBufferDescriptor[] = [];
    private drawCalls: DrawCall[] = [];
    private sortKeys: Map<string, number> = new Map();
    private objectRenderers: MeshRenderer[] = [];
    private gfxInputLayout: GfxInputLayout;
    private gfxProgram: GfxProgram;
    private gfxSampler: GfxSampler;
    public showTextures: boolean = true;
    public showObjects: boolean = true;
    public cullMode: GfxCullMode = GfxCullMode.None;
    public meshLayers: Layer[] = [];

    constructor(cache: GfxRenderCache, private level: CapserLevel, private textures: Map<string, CasperTexture>, meshes: Map<string, CasperMesh>, objInstances: CasperObjectInstance[]) {
        if (BACK_CULL_LEVELS.includes(this.level.number)) {
            this.cullMode = GfxCullMode.Back;
        }

        const { vertices, indices, uvs, colors } = this.buildBuffersAndDrawCalls();
        this.indexBufferDescriptor = { buffer: createBufferFromData(cache.device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indices.buffer), byteOffset: 0 };
        this.vertexBufferDescriptors = [
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, vertices.buffer), byteOffset: 0 },
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, colors.buffer), byteOffset: 0 },
            { buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, uvs.buffer), byteOffset: 0 },
        ];
        this.meshLayers.push({ name: this.level.name, visible: true, setVisible(v: boolean) { this.visible = v } });

        for (const [name, mesh] of meshes.entries()) {
            const meshTextures = new Map<string, CasperTexture>();
            for (const t of mesh.materials!) {
                meshTextures.set(t, this.textures.get(t)!);
            }
            this.objectRenderers.push(new MeshRenderer(cache, name, meshTextures, mesh, objInstances.filter(i => i.name === name)));
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
        if (this.meshLayers.find(m => m.name === this.level.name)!.visible) {
            const renderInst = renderHelper.renderInstManager.pushTemplate();

            let offset2 = template.allocateUniformBuffer(Shader.ub_InstanceParams, 16);
            const uniformBuffer2 = template.mapUniformBufferF32(Shader.ub_InstanceParams);
            // u_View (16)
            offset2 += fillMatrix4x4(uniformBuffer2, offset2, SCRATCH_VIEW);

            renderInst.setVertexInput(this.gfxInputLayout, this.vertexBufferDescriptors, this.indexBufferDescriptor);
            renderInst.setGfxProgram(this.gfxProgram);
            for (const drawCall of this.drawCalls) {
                const texture = this.textures.get(drawCall.textureName);
                if (!texture) {
                    // console.warn(batch.textureName);
                    continue;
                }
                const renderInst = renderHelper.renderInstManager.newRenderInst();
                const megaState = renderInst.getMegaStateFlags();
                megaState.cullMode = this.cullMode;
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
                renderInst.setDrawCount(drawCall.indexCount, drawCall.indexOffset);
                renderHelper.renderInstManager.submitRenderInst(renderInst);
            }

            renderHelper.renderInstManager.popTemplate();
        }

        for (const or of this.objectRenderers) {
            if (this.meshLayers.find(m => m.name === or.name)!.visible) {
                or.prepareToRender(device, renderHelper, viewerInput);
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

    private buildBuffersAndDrawCalls(): MeshBufferData {
        let vertexOffset = 0;
        const vertices: number[] = [];
        const colors: number[] = [];
        const uvs: number[] = [];
        const indexGroups = new Map<string, number[]>();
        const traverse = (node: CasperBSPNode) => {
            if (node.mesh && node.mesh.vertices.length > 0) {
                const offsetBase = vertexOffset;
                vertices.push(...node.mesh.vertices.map(p => p * WORLD_SCALE));
                colors.push(...node.mesh.colors.map(c => c / 255));
                uvs.push(...node.mesh.uvs);
                vertexOffset += node.mesh.vertices.length / 3;
                for (const split of node.mesh.indexSplits) {
                    const textureName = this.level.materials[split.materialIndex];
                    if (textureName === undefined || textureName.length === 0) {
                        continue;
                    }
                    if (!indexGroups.has(textureName)) {
                        indexGroups.set(textureName, []);
                    }
                    const groupIndices = indexGroups.get(textureName)!;
                    for (const index of split.indices) {
                        groupIndices.push(index + offsetBase);
                    }
                }
            }
            if (node.leaves) {
                node.leaves.forEach(traverse);
            }
        };

        traverse(this.level.root);

        const indices: number[] = [];
        indexGroups.forEach((groupIndices, textureName) => {
            const batch = { textureName, indexOffset: indices.length, indexCount: groupIndices.length };
            indices.push(...groupIndices);
            this.drawCalls.push(batch);
        });

        return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices), colors: new Float32Array(colors), uvs: new Float32Array(uvs) };
    }
}

class MeshRenderer {
    private drawCalls: DrawCall[] = [];
    private gfxInputLayout: GfxInputLayout;
    private gfxSampler: GfxSampler;
    private gfxProgram: GfxProgram;
    private indexBufferDescriptor: GfxIndexBufferDescriptor;
    private vertexBufferDescriptors: GfxVertexBufferDescriptor[] = [];
    private boneMatrices: mat4[] = [];
    private bones: CasperBone[] = [];

    constructor(cache: GfxRenderCache, public name: string, private textures: Map<string, CasperTexture>, mesh: CasperMesh, private instances: CasperObjectInstance[]) {
        const { vertices, indices, uvs, colors, joints, weights } = this.buildBuffersAndDrawCalls(mesh);
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

        if (mesh.skeletonData) {
            this.vertexBufferDescriptors.push({ buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, joints!.buffer), byteOffset: 0 });
            this.vertexBufferDescriptors.push({ buffer: createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, weights!.buffer), byteOffset: 0 });
            vertexAttributeDescriptors.push({ location: Shader.a_Joint, bufferIndex: Shader.a_Joint, format: GfxFormat.U8_RGBA, bufferByteOffset: 0 });
            vertexAttributeDescriptors.push({ location: Shader.a_Weight, bufferIndex: Shader.a_Weight, format: GfxFormat.F32_RGBA, bufferByteOffset: 0 });
            inVertexBufferDescriptors.push({ byteStride: 4, frequency: GfxVertexBufferFrequency.PerVertex });
            inVertexBufferDescriptors.push({ byteStride: 16, frequency: GfxVertexBufferFrequency.PerVertex });
            this.boneMatrices = Array(mesh.bones.length);
            for (let i = 0; i < mesh.bones.length; i++) {
                const bone = mesh.bones[i];
                this.boneMatrices[i] = mat4.create();
                const pbm = bone.parentIndex < 0xFFFFFFFF ? this.boneMatrices[bone.parentIndex] : this.computeShiftMatrix(instances[0]);
                mat4.mul(this.boneMatrices[i], pbm, this.boneMatrices[i]);
            }
            this.bones = mesh.bones;
        }
        
        this.gfxInputLayout = cache.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors: inVertexBufferDescriptors, indexBufferFormat: GfxFormat.U32_R });
        this.gfxSampler = cache.createSampler({
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Nearest,
            wrapS: GfxWrapMode.Repeat,
            wrapT: GfxWrapMode.Repeat
        });
        this.gfxProgram = cache.createProgram(new Shader(mesh.skeletonData ? mesh.bones.length : 0));

        const bs = mesh.boundingSphere!;
        bs.x *= WORLD_SCALE;
        bs.y *= WORLD_SCALE;
        bs.z *= WORLD_SCALE;
        bs.r *= WORLD_SCALE;
        for (const instance of this.instances) {
            instance.shiftMatrix = this.computeShiftMatrix(instance);
            const bbox = new AABB(bs.x - bs.r, bs.y - bs.r, bs.z - bs.r, bs.x + bs.r, bs.y + bs.r, bs.z + bs.r);
            bbox.transform(bbox, instance.shiftMatrix);
            instance.bbox = bbox;
        }
    }

    public prepareToRender(device: GfxDevice, renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput) {
        const renderInst = renderHelper.renderInstManager.pushTemplate();

        renderInst.setVertexInput(this.gfxInputLayout, this.vertexBufferDescriptors, this.indexBufferDescriptor);
        renderInst.setGfxProgram(this.gfxProgram);
        for (let i = 0; i < this.instances.length; i++) {
            const instance = this.instances[i];
            const template = renderHelper.renderInstManager.pushTemplate();

            let offset = template.allocateUniformBuffer(Shader.ub_InstanceParams, 16);
            const uniformBuffer = template.mapUniformBufferF32(Shader.ub_InstanceParams);
            // u_View (16)
            mat4.mul(SCRATCH_INSTANCE, SCRATCH_VIEW, instance.shiftMatrix);
            offset += fillMatrix4x4(uniformBuffer, offset, SCRATCH_INSTANCE);

            for (const drawCall of this.drawCalls) {
                const texture = this.textures.get(drawCall.textureName);
                if (!texture) {
                    // console.warn(batch.textureName);
                    continue;
                }
                const renderInst = renderHelper.renderInstManager.newRenderInst();
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
                renderInst.setDrawCount(drawCall.indexCount, drawCall.indexOffset);
                renderHelper.renderInstManager.submitRenderInst(renderInst);
            }
            if (this.boneMatrices.length > 0 && i === 0) {
                const ctx = getDebugOverlayCanvas2D();
                for (let i = 1; i < this.boneMatrices.length; i++) {
                    vec3.set(scratchVec3a, 0, 0, 0);
                    vec3.transformMat4(scratchVec3a, scratchVec3a, this.boneMatrices[this.bones[i].parentIndex]);
                    vec3.set(scratchVec3b, 0, 0, 0);
                    vec3.transformMat4(scratchVec3b, scratchVec3b, this.boneMatrices[i]);
                    drawWorldSpaceLine(ctx, viewerInput.camera.clipFromWorldMatrix, scratchVec3a, scratchVec3b);
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

    private buildBuffersAndDrawCalls(mesh: CasperMesh): MeshBufferData {
        const vertices: number[] = [];
        const colors: number[] = [];
        const indexGroups = new Map<string, number[]>();
        if (mesh.vertices.length > 0 && mesh.materials) {
            vertices.push(...mesh.vertices.map(p => p * WORLD_SCALE));
            colors.push(...mesh.colors.map(c => c / 255));
            for (const split of mesh.indexSplits) {
                const textureName = mesh.materials[split.materialIndex];
                if (textureName === undefined || textureName.length === 0) {
                    continue;
                }
                if (!indexGroups.has(textureName)) {
                    indexGroups.set(textureName, []);
                }
                const groupIndices = indexGroups.get(textureName)!;
                for (const i of split.indices) {
                    groupIndices.push(i);
                }
            }
        }

        const indices: number[] = [];
        indexGroups.forEach((groupIndices, textureName) => {
            const drawCall = { textureName, indexOffset: indices.length, indexCount: groupIndices.length };
            indices.push(...groupIndices);
            this.drawCalls.push(drawCall);
        });

        let joints;
        let weights;
        if (mesh.skeletonData) {
            joints = [];
            for (const j of mesh.skeletonData!.indices) {
                joints.push(...j);
            }
            weights = [];
            for (const w of mesh.skeletonData!.weights) {
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

    private computeShiftMatrix(obj: CasperObjectInstance): mat4 {
        const srt = mat4.create();
        computeModelMatrixSRT(srt,
            obj.scale.x, obj.scale.y, obj.scale.z,
            0, obj.rotation.z * MathConstants.DEG_TO_RAD, 0,
            obj.position.x * WORLD_SCALE, obj.position.z * WORLD_SCALE, -obj.position.y * WORLD_SCALE
        );
        return srt;
    }
}
