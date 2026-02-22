import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { fillMatrix4x4 } from "../gfx/helpers/UniformBufferHelpers";
import { GfxDevice, GfxBufferUsage, GfxBufferFrequencyHint, GfxFormat, GfxVertexBufferFrequency, GfxBindingLayoutDescriptor, GfxTexFilterMode, GfxMipFilterMode, GfxWrapMode, GfxCullMode } from "../gfx/platform/GfxPlatform";
import { GfxBuffer, GfxInputLayout } from "../gfx/platform/GfxPlatformImpl";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { DeviceProgram } from "../Program";
import { ViewerRenderInput } from "../viewer";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers";
import { GeometryChunk } from "./bin_geom";
import { GfxRenderInstManager } from "../gfx/render/GfxRenderInstManager";
import { Texture } from "./bin_pxt";

interface MeshBatch {
    textureIndex: number;
    indexOffset: number;
    indexCount: number;
}

interface LevelBuffer {
    vertices: Float32Array;
    indices: Uint32Array;
    colors: Float32Array;
    uvs: Float32Array;
}

export class LevelProgram extends DeviceProgram {
    public static ub_SceneParams = 0;

    public override both = `
precision highp float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_ProjectionView;
};

uniform sampler2D u_Texture;

varying vec3 v_Pos;
varying vec4 v_Color;
varying vec2 v_UV;

#ifdef VERT
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec4 a_Color;
layout(location = 2) in vec2 a_UV;

void main() {
    v_Pos = a_Position;
    v_Color = a_Color;
    v_UV = a_UV;
    gl_Position = UnpackMatrix(u_ProjectionView) * vec4(a_Position, 1.0);
}
#endif

#ifdef FRAG
void main() {
    // gl_FragColor = vec4(abs(v_UV.x), abs(v_UV.y), 0.0, 1.0);
    // gl_FragColor = v_Color;
    // vec3 normal = normalize(cross(dFdx(v_Pos), dFdy(v_Pos)));
    // gl_FragColor = vec4(max((normal * 0.5 + 0.5) * 0.8, vec3(0.2)), 1.0);
    vec4 texColor = texture(SAMPLER_2D(u_Texture), v_UV);
    gl_FragColor = texColor;
}
#endif
    `;

    constructor() {
        super();
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 1, numSamplers: 1 }];

export class LevelRenderer {
    private vertexBuffer: GfxBuffer;
    private colorBuffer: GfxBuffer;
    private uvBuffer: GfxBuffer;
    private indexBuffer: GfxBuffer;
    private inputLayout: GfxInputLayout;
    private batches: MeshBatch[] = [];

    constructor(cache: GfxRenderCache, chunks: GeometryChunk[], private textures: Texture[]) {
        const device = cache.device;
        const { vertices, indices, uvs, colors } = this.buildBuffers(chunks);
        // for (const chunk of chunks) {
        //     let pushedVertices = 0;
        //     const indexStart = vertices.length / 3;
        //     for (let i = 0; i < chunk.vertices.length; i += 3) {
        //         const x = chunk.vertices[i];
        //         const y = chunk.vertices[i + 1];
        //         const z = chunk.vertices[i + 2];
        //         if (x === 0 && y === 0 && z === 0) {
        //             continue;
        //         }
        //         vertices.push(x, y, z);
        //         colors.push(chunk.colors[i] / 255, chunk.colors[i + 1] / 255, chunk.colors[i + 2] / 255);
        //         pushedVertices++;
        //     }
        //     for (let i = 0; i < chunk.uvs.length; i += 2) {
        //         const u = chunk.uvs[i];
        //         const v = chunk.uvs[i + 1];
        //         if (u === 0 && v === 0) {
        //             continue;
        //         }
        //         uvs.push(u, v);
        //     }

        //     let currentStripOffset = 0;
        //     for (const rawLength of chunk.stripLengths) {
        //         if (rawLength === 0) {
        //             break;
        //         }
        //         const length = rawLength / 3;
        //         let flip = false;
        //         for (let i = 0; i < length - 2; i++) {
        //             const idx1 = indexStart + currentStripOffset + i;
        //             const idx2 = indexStart + currentStripOffset + i + 1;
        //             const idx3 = indexStart + currentStripOffset + i + 2;
        //             if (!flip) {
        //                 indices.push(idx1, idx2, idx3);
        //             } else {
        //                 indices.push(idx1, idx3, idx2);
        //             }
        //             flip = !flip;
        //         }
        //         currentStripOffset += length;
        //     }
        // }
        this.vertexBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(vertices).buffer);
        this.colorBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(colors).buffer);
        this.uvBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(uvs).buffer);
        this.indexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, new Uint32Array(indices).buffer);

        this.inputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                { location: 0, bufferIndex: 0, format: GfxFormat.F32_RGB, bufferByteOffset: 0 }, // a_Position
                { location: 1, bufferIndex: 1, format: GfxFormat.F32_RGBA, bufferByteOffset: 0 }, // a_Color
                { location: 2, bufferIndex: 2, format: GfxFormat.F32_RG, bufferByteOffset: 0 } // a_UV
            ],
            vertexBufferDescriptors: [
                { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex }, // pos
                { byteStride: 16, frequency: GfxVertexBufferFrequency.PerVertex }, // color
                { byteStride: 8, frequency: GfxVertexBufferFrequency.PerVertex } // uv
            ],
            indexBufferFormat: GfxFormat.U32_R,
        });
    }

    public prepareToRender(device: GfxDevice, renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput) {
        const renderInstManager = renderHelper.renderInstManager;
        const template = renderInstManager.pushTemplate();
        const program = renderHelper.renderCache.createProgram(new LevelProgram());
        template.setGfxProgram(program);
        template.setBindingLayouts(bindingLayouts);
        template.setUniformBuffer(renderHelper.uniformBuffer);
        template.setVertexInput(this.inputLayout,
            [
                { buffer: this.vertexBuffer, byteOffset: 0 },
                { buffer: this.colorBuffer, byteOffset: 0 },
                { buffer: this.uvBuffer, byteOffset: 0 }
            ],
            { buffer: this.indexBuffer, byteOffset: 0 },
        );

        let offset = template.allocateUniformBuffer(LevelProgram.ub_SceneParams, 16);
        const buffer = template.mapUniformBufferF32(LevelProgram.ub_SceneParams);
        offset += fillMatrix4x4(buffer, offset, viewerInput.camera.clipFromWorldMatrix);
        
        this.submitBatches(this.batches, renderInstManager, renderHelper);
        renderInstManager.popTemplate();
    }

    public destroy(device: GfxDevice) {
        device.destroyBuffer(this.vertexBuffer);
        device.destroyBuffer(this.colorBuffer);
        device.destroyBuffer(this.uvBuffer);
        device.destroyBuffer(this.indexBuffer);
        for (const t of this.textures) {
            device.destroyTexture(t.gfxTexture);
        }
    }

    private submitBatches(batches: MeshBatch[], renderInstManager: GfxRenderInstManager, renderHelper: GfxRenderHelper) {
        for (const batch of batches) {
            const texture = this.textures[batch.textureIndex];
            if (!texture) {
                continue;
            }
            const sampler = renderHelper.renderCache.createSampler({
                minFilter: GfxTexFilterMode.Bilinear,
                magFilter: GfxTexFilterMode.Bilinear,
                mipFilter: GfxMipFilterMode.Nearest,
                wrapS: GfxWrapMode.Repeat,
                wrapT: GfxWrapMode.Repeat
            });
            const renderInst = renderInstManager.newRenderInst();
            renderInst.setSamplerBindingsFromTextureMappings([{
                gfxTexture: texture.gfxTexture,
                gfxSampler: sampler,
                lateBinding: null
            }]);
            renderInst.setDrawCount(batch.indexCount, batch.indexOffset);
            renderInstManager.submitRenderInst(renderInst);
        }
    }

    private buildBuffers(chunks: GeometryChunk[]): LevelBuffer {
        let vertexOffset = 0;
        const vertices: number[] = [];
        const colors: number[] = [];
        const uvs: number[] = [];
        const indexGroups = new Map<number, number[]>();
        this.batches = [];
    
        for (const chunk of chunks) {
            if (chunk.textureIndex < 0) {
                continue;
            }
            const vBase = vertexOffset;
            for (let i = 0; i < chunk.vertices.length; i += 3) {
                const x = chunk.vertices[i];
                const y = chunk.vertices[i + 1];
                const z = chunk.vertices[i + 2];
                if (x === 0 && y === 0 && z === 0) {
                    continue;
                }
                vertices.push(x, y, z);
                vertexOffset++;
            }
            for (let i = 0; i < 4 * (vertexOffset - vBase); i += 4) {
                const r = chunk.colors[i];
                const g = chunk.colors[i + 1];
                const b = chunk.colors[i + 2];
                const a = chunk.colors[i + 3];
                if (r === 255 && g === 255 && b === 255 && a === 255) {
                    continue;
                }
                colors.push(r / 255, g / 255, b / 255, a / 255);
            }
            for (let i = 0; i < chunk.uvs.length; i += 2) {
                const u = chunk.uvs[i];
                const v = chunk.uvs[i + 1];
                if (u === 0 && v === 0) {
                    continue;
                }
                uvs.push(u, v);
            }

            if (!indexGroups.has(chunk.textureIndex)) {
                indexGroups.set(chunk.textureIndex, []);
            }
            const groupIndices = indexGroups.get(chunk.textureIndex)!;
            let currentStripOffset = 0;
            for (const stripLength of chunk.stripLengths) {
                if (stripLength === 0) {
                    break;
                }
                const length = stripLength / 3;
                let flip = false;
                for (let i = 0; i < length - 2; i++) {
                    const idx1 = vBase + currentStripOffset + i;
                    const idx2 = vBase + currentStripOffset + i + 1;
                    const idx3 = vBase + currentStripOffset + i + 2;
                    if (!flip) {
                        groupIndices.push(idx1, idx2, idx3);
                    } else {
                        groupIndices.push(idx1, idx3, idx2);
                    }
                    flip = !flip;
                }
                currentStripOffset += length;
            }
        }

        const indices: number[] = [];
        indexGroups.forEach((groupIndices, textureIndex) => {
            this.batches.push({
                textureIndex, indexOffset: indices.length,
                indexCount: groupIndices.length
            });
            indices.push(...groupIndices);
        });

        return { 
            vertices: new Float32Array(vertices), 
            indices: new Uint32Array(indices), 
            colors: new Float32Array(colors), 
            uvs: new Float32Array(uvs) 
        };
    }
}

