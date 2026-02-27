import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { GfxDevice, GfxBindingLayoutDescriptor } from "../gfx/platform/GfxPlatform";
import { GfxBuffer, GfxInputLayout } from "../gfx/platform/GfxPlatformImpl";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { DeviceProgram } from "../Program";
import { ViewerRenderInput } from "../viewer";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";

export class LevelProgram extends DeviceProgram {
    public static ub_SceneParams = 0;

    public override both = `
precision highp float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_ProjectionView;
};

varying vec3 v_Pos;

#ifdef VERT
layout(location = 0) in vec3 a_Position;

void main() {
    v_Pos = a_Position;
    gl_Position = UnpackMatrix(u_ProjectionView) * vec4(a_Position, 1.0);
}
#endif

#ifdef FRAG
void main() {
    // gl_FragColor = vec4(abs(v_UV.x), abs(v_UV.y), 0.0, 1.0);
    vec3 normal = normalize(cross(dFdx(v_Pos), dFdy(v_Pos)));
    gl_FragColor = vec4(max((normal * 0.5 + 0.5) * 0.8, vec3(0.2)), 1.0);
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
    private indexBuffer: GfxBuffer;
    private inputLayout: GfxInputLayout;

    constructor(cache: GfxRenderCache) {
        // const device = cache.device;
        // this.vertexBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(vertices).buffer);
        // this.indexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, new Uint32Array(indices).buffer);

        // this.inputLayout = cache.createInputLayout({
        //     vertexAttributeDescriptors: [
        //         { location: 0, bufferIndex: 0, format: GfxFormat.F32_RGB, bufferByteOffset: 0 } // a_Position
        //     ],
        //     vertexBufferDescriptors: [
        //         { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex } // pos
        //     ],
        //     indexBufferFormat: GfxFormat.U32_R,
        // });
    }

    public prepareToRender(device: GfxDevice, renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput) {
        // const renderInstManager = renderHelper.renderInstManager;
        // const template = renderInstManager.pushTemplate();
        // const program = renderHelper.renderCache.createProgram(new LevelProgram());
        // template.setGfxProgram(program);
        // template.setBindingLayouts(bindingLayouts);
        // template.setUniformBuffer(renderHelper.uniformBuffer);
        // template.setVertexInput(this.inputLayout,
        //     [
        //         { buffer: this.vertexBuffer, byteOffset: 0 }
        //     ],
        //     { buffer: this.indexBuffer, byteOffset: 0 },
        // );

        // let offset = template.allocateUniformBuffer(LevelProgram.ub_SceneParams, 16);
        // const buffer = template.mapUniformBufferF32(LevelProgram.ub_SceneParams);
        // offset += fillMatrix4x4(buffer, offset, viewerInput.camera.clipFromWorldMatrix);

        // this.submitBatches(this.batches, renderInstManager, renderHelper);
        // renderInstManager.popTemplate();
    }

    public destroy(device: GfxDevice) {
        device.destroyBuffer(this.vertexBuffer);
        device.destroyBuffer(this.indexBuffer);
        // for (const t of this.textures) {
        //     device.destroyTexture(t.gfxTexture);
        // }
    }
}
