import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { fillMatrix4x4 } from "../gfx/helpers/UniformBufferHelpers";
import { GfxDevice, GfxBufferUsage, GfxBufferFrequencyHint, GfxFormat, GfxVertexBufferFrequency, GfxBindingLayoutDescriptor } from "../gfx/platform/GfxPlatform";
import { GfxBuffer, GfxInputLayout } from "../gfx/platform/GfxPlatformImpl";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { DeviceProgram } from "../Program";
import { ViewerRenderInput } from "../viewer";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers";
import { GeomFile } from "./bin_geom";

export class LevelProgram extends DeviceProgram {
    public static ub_SceneParams = 0;

    public override both = `
precision highp float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_ProjectionView;
};

varying vec3 v_Pos;
varying vec3 v_Color;

#ifdef VERT
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec3 a_Color;

void main() {
    v_Pos = a_Position;
    v_Color = a_Color;
    gl_Position = UnpackMatrix(u_ProjectionView) * vec4(a_Position, 1.0);
}
#endif

#ifdef FRAG
void main() {
    gl_FragColor = vec4(v_Color, 1.0);
    // vec3 normal = normalize(cross(dFdx(v_Pos), dFdy(v_Pos)));
    // gl_FragColor = vec4(max((normal * 0.5 + 0.5) * 0.8, vec3(0.2)), 1.0);
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
    private indexBuffer: GfxBuffer;
    private indexCount: number;
    private inputLayout: GfxInputLayout;

    constructor(cache: GfxRenderCache, geos: GeomFile[]) {
        const device = cache.device;
        const vertices: number[] = [];
        const colors: number[] = [];
        const indices: number[] = [];
        for (const geo of geos) {
            for (const chunk of geo.chunks) {
                let pushedVertices = 0;
                const indexStart = vertices.length / 3;
                for (let i = 0; i < chunk.vertices.length; i += 3) {
                    const x = chunk.vertices[i];
                    const y = chunk.vertices[i + 1];
                    const z = chunk.vertices[i + 2];
                    if (x === 0 && y === 0 && z === 0) {
                        continue;
                    }
                    vertices.push(x, y, z);
                    colors.push(chunk.colors[i] / 255, chunk.colors[i + 1] / 255, chunk.colors[i + 2] / 255);
                    pushedVertices++;
                }

                let currentStripOffset = 0;
                for (const rawLength of chunk.stripLengths) {
                    if (rawLength === 0) {
                        break;
                    }
                    const length = rawLength / 3;
                    let flip = false;
                    for (let i = 0; i < length - 2; i++) {
                        const idx1 = indexStart + currentStripOffset + i;
                        const idx2 = indexStart + currentStripOffset + i + 1;
                        const idx3 = indexStart + currentStripOffset + i + 2;
                        if (!flip) {
                            indices.push(idx1, idx2, idx3);
                        } else {
                            indices.push(idx1, idx3, idx2);
                        }
                        flip = !flip;
                    }
                    currentStripOffset += length;
                }
            }
        }
        this.vertexBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(vertices).buffer);
        this.colorBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(colors).buffer);
        this.indexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, new Uint32Array(indices).buffer);

        this.indexCount = indices.length;
        this.inputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                { location: 0, bufferIndex: 0, format: GfxFormat.F32_RGB, bufferByteOffset: 0 }, // a_Position
                { location: 1, bufferIndex: 1, format: GfxFormat.F32_RGB, bufferByteOffset: 0 } // a_Color
            ],
            vertexBufferDescriptors: [
                { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex }, // pos
                { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex } // color
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

        let offset = template.allocateUniformBuffer(LevelProgram.ub_SceneParams, 16);
        const buffer = template.mapUniformBufferF32(LevelProgram.ub_SceneParams);
        offset += fillMatrix4x4(buffer, offset, viewerInput.camera.clipFromWorldMatrix);
        template.setVertexInput(this.inputLayout,
            [
                { buffer: this.vertexBuffer, byteOffset: 0 },
                { buffer: this.colorBuffer, byteOffset: 0 }
            ],
            { buffer: this.indexBuffer, byteOffset: 0 },
        );

        const renderInst = renderInstManager.newRenderInst();
        renderInst.setDrawCount(this.indexCount);
        renderInstManager.submitRenderInst(renderInst);
        renderInstManager.popTemplate();
    }

    public destroy(device: GfxDevice) {
        device.destroyBuffer(this.vertexBuffer);
        device.destroyBuffer(this.colorBuffer);
        device.destroyBuffer(this.indexBuffer);
    }
}
