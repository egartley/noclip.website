import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { fillMatrix4x4 } from "../gfx/helpers/UniformBufferHelpers";
import { GfxDevice, GfxBufferUsage, GfxBufferFrequencyHint, GfxFormat, GfxVertexBufferFrequency, GfxBindingLayoutDescriptor } from "../gfx/platform/GfxPlatform";
import { GfxBuffer, GfxInputLayout, GfxProgram } from "../gfx/platform/GfxPlatformImpl";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { DeviceProgram } from "../Program";
import { ViewerRenderInput } from "../viewer";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers";
import { GeometryChunk } from "./bin_geom";
import { Texture } from "./bin_pxt";

export class LevelProgram extends DeviceProgram {
    public static ub_SceneParams = 0;

    public override both = `
precision highp float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Clip;
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
    gl_Position = UnpackMatrix(u_Clip) * vec4(a_Position, 1.0);
}
#endif

#ifdef FRAG
void main() {
    gl_FragColor = v_Color;
}
#endif
    `;

    constructor() {
        super();
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 1, numSamplers: 0 }];

export class LevelRenderer {
    private vertexBuffer: GfxBuffer;
    private colorBuffer: GfxBuffer;
    private uvBuffer: GfxBuffer;
    private indexBuffer: GfxBuffer;
    private inputLayout: GfxInputLayout;
    private indexCount: number;
    private gfxProgram: GfxProgram;

    constructor(cache: GfxRenderCache, chunks: GeometryChunk[], private textures: Texture[]) {
        const vertices: number[] = [];
        const colors: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];
        for (const chunk of chunks) {
            const indexStart = vertices.length / 3;
            for (let i = 0; i < chunk.vertices.length; i += 3) {
                const x = chunk.vertices[i];
                const y = chunk.vertices[i + 1];
                const z = chunk.vertices[i + 2];
                if (x === 0 && y === 0 && z === 0) {
                    continue;
                }
                vertices.push(x, y, z);
                colors.push(chunk.colors[i] / 255, chunk.colors[i + 1] / 255, chunk.colors[i + 2] / 255, 1.0);
            }
            for (let i = 0; i < chunk.uvs.length; i += 2) {
                const u = chunk.uvs[i];
                const v = chunk.uvs[i + 1];
                if (u === 0 && v === 0) {
                    continue;
                }
                uvs.push(u, v);
            }

            let currentStripOffset = 0;
            for (const rawLength of chunk.stripLengths) {
                if (rawLength === 0) {
                    break;
                }
                const length = rawLength / 3;
                for (let i = 0; i < length - 2; i++) {
                    const idx1 = indexStart + currentStripOffset + i;
                    const idx2 = indexStart + currentStripOffset + i + 1;
                    const idx3 = indexStart + currentStripOffset + i + 2;
                    if (i % 2 === 0) {
                        indices.push(idx1, idx2, idx3);
                    } else {
                        indices.push(idx1, idx3, idx2);
                    }
                }
                currentStripOffset += length;
            }
        }
        this.vertexBuffer = createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(vertices).buffer);
        this.colorBuffer = createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(colors).buffer);
        this.uvBuffer = createBufferFromData(cache.device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(uvs).buffer);
        this.indexBuffer = createBufferFromData(cache.device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, new Uint32Array(indices).buffer);

        this.indexCount = indices.length;
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
        this.gfxProgram = cache.createProgram(new LevelProgram());
    }

    public prepareToRender(device: GfxDevice, renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput) {
        const renderInstManager = renderHelper.renderInstManager;
        const template = renderInstManager.pushTemplate();
        template.setGfxProgram(this.gfxProgram);
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
        
        const renderInst = renderInstManager.newRenderInst();
        renderInst.setDrawCount(this.indexCount);
        renderInstManager.submitRenderInst(renderInst);
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
}
