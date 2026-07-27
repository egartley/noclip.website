import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary";
import { fillMatrix4x4 } from "../gfx/helpers/UniformBufferHelpers";
import { GfxDevice, GfxBufferUsage, GfxBufferFrequencyHint, GfxFormat, GfxVertexBufferFrequency, GfxBindingLayoutDescriptor, GfxIndexBufferDescriptor, GfxVertexBufferDescriptor } from "../gfx/platform/GfxPlatform";
import { GfxInputLayout, GfxProgram } from "../gfx/platform/GfxPlatformImpl";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { DeviceProgram } from "../Program";
import { ViewerRenderInput } from "../viewer";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers";
import { HerosTailEDBFile, HerosTailEntity, HerosTailEntityType, HerosTailMeshEntity, HerosTailSplitEntity } from "./bin";

class Shader extends DeviceProgram {
    public static ub_SceneParams = 0;

    public override both = `
precision highp float;

${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_ViewProj;
};

varying vec4 v_Color;
varying vec2 v_UV;

#ifdef VERT
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec4 a_Color;
layout(location = 2) in vec2 a_UV;

void main() {
    v_Color = a_Color;
    v_UV = a_UV;
    gl_Position = UnpackMatrix(u_ViewProj) * vec4(a_Position, 1.0);
}
#endif

#ifdef FRAG
void main() {
    gl_FragColor = v_Color;
}
#endif
    `;
}

const WORLD_SCALE = 200.0;
const TRISTRIP_RESTART = 0x5000;
const BINDING_LAYOUTS: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 1, numSamplers: 1 }];

function processTristrips(entity: HerosTailMeshEntity, indexOffset: number): { indices: number[], colors: number[], uvs: number[] } {
    const indices = [];
    const colors = Array(entity.vertexCount * 4);
    const uvs = Array(entity.vertexCount * 2);
    for (const ts of entity.tristrips) {
        const substrips: number[][] = [];
        let substrip: number[] = [];
        for (let i = 0; i < ts.indices.length; i++) {
            const vertexIndex = ts.indices[i] & 0x0FFF;
            const flag = ts.indices[i] & 0xF000;
            if (flag === TRISTRIP_RESTART && substrip.length > 0) {
                substrips.push(substrip);
                substrip = [];
            }
            substrip.push(vertexIndex);
            colors[vertexIndex * 4] = ts.colors[i * 4];
            colors[(vertexIndex * 4) + 1] = ts.colors[(i * 4) + 1];
            colors[(vertexIndex * 4) + 2] = ts.colors[(i * 4) + 2];
            colors[(vertexIndex * 4) + 3] = ts.colors[(i * 4) + 3];
            uvs[vertexIndex * 2] = ts.uvs[i * 2];
            uvs[(vertexIndex * 2) + 1] = ts.uvs[(i * 2) + 1];
        }
        if (substrip.length > 0) {
            substrips.push(substrip);
        }
        for (const strip of substrips) {
            for (let i = 0; i < strip.length - 2; i++) {
                const a = indexOffset + strip[i];
                const b = indexOffset + strip[i + 1];
                const c = indexOffset + strip[i + 2];
                if (a === b || b === c || a === c) {
                    continue;
                }
                if (i % 2 === 0) {
                    indices.push(a, b, c);
                } else {
                    indices.push(a, c, b);
                }
            }
        }
    }
    return { indices, colors, uvs };
}

export class HerosTailRenderer {
    public entities: EntityRenderer[];
    private gfxProgram: GfxProgram;
    private inputLayout: GfxInputLayout;

    constructor(cache: GfxRenderCache, edb: HerosTailEDBFile) {
        this.gfxProgram = cache.createProgram(new Shader());

        this.entities = [];
        for (let i = 0; i < edb.refEntities.length; i++) {
            const entity = edb.refEntities[i];
            if (entity.type === HerosTailEntityType.SPLIT || entity.type === HerosTailEntityType.MESH) {
                const er = new EntityRenderer(cache, `ref_${i}`, entity);
                if (er.drawCount > 0) {
                    this.entities.push(er);
                }
            }
        }

        this.inputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                { location: 0, bufferIndex: 0, format: GfxFormat.F32_RGB, bufferByteOffset: 0 },
                { location: 1, bufferIndex: 1, format: GfxFormat.F32_RGBA, bufferByteOffset: 0 },
                { location: 2, bufferIndex: 2, format: GfxFormat.F32_RG, bufferByteOffset: 0 }
            ],
            vertexBufferDescriptors: [
                { byteStride: 12, frequency: GfxVertexBufferFrequency.PerVertex },
                { byteStride: 16, frequency: GfxVertexBufferFrequency.PerVertex },
                { byteStride: 8, frequency: GfxVertexBufferFrequency.PerVertex }
            ],
            indexBufferFormat: GfxFormat.U32_R
        });
    }

    public prepareToRender(device: GfxDevice, renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput) {
        const template = renderHelper.renderInstManager.pushTemplate();
        template.setGfxProgram(this.gfxProgram);
        template.setBindingLayouts(BINDING_LAYOUTS);
        template.setUniformBuffer(renderHelper.uniformBuffer);

        let offs = template.allocateUniformBuffer(Shader.ub_SceneParams, 16);
        const d = template.mapUniformBufferF32(Shader.ub_SceneParams);
        // u_ViewProj (16)
        offs += fillMatrix4x4(d, offs, viewerInput.camera.clipFromWorldMatrix);

        for (const e of this.entities) {
            if (e.visible) {
                e.prepareToRender(device, renderHelper, viewerInput, this.inputLayout);
            }
        }

        renderHelper.renderInstManager.popTemplate();
    }

    public destroy(device: GfxDevice) {
        for (const e of this.entities) {
            e.destroy(device);
        }
    }
}

class EntityRenderer {
    public drawCount: number;
    public visible: boolean = true;
    private indexBufferDescriptor: GfxIndexBufferDescriptor;
    private vertexBufferDescriptors: GfxVertexBufferDescriptor[];

    constructor(cache: GfxRenderCache, public name: string, entity: HerosTailEntity) {
        const device = cache.device;

        let vertices: number[] = [];
        let colors: number[] = [];
        let uvs: number[] = [];
        let indices: number[] = [];
        switch (entity.type) {
            case HerosTailEntityType.MESH:
                {
                    const e = entity as HerosTailMeshEntity;
                    vertices = e.positions;
                    const { indices: i, colors: c, uvs: u } = processTristrips(e, 0);
                    indices = i;
                    colors = c;
                    uvs = u;
                }
                break;
            case HerosTailEntityType.SPLIT:
                {
                    const e = entity as HerosTailSplitEntity;
                    let offset = 0;
                    const addMeshEntity = (ee: HerosTailMeshEntity) => {
                        const { indices: i, colors: c, uvs: u } = processTristrips(ee, offset);
                        offset += ee.vertexCount;
                        vertices.push(...ee.positions);
                        indices.push(...i);
                        colors.push(...c);
                        uvs.push(...u);
                    }
                    const process = (e: HerosTailEntity) => {
                        if (e.type === HerosTailEntityType.SPLIT) {
                            const ee = e as HerosTailSplitEntity;
                            for (const se of ee.subEntities) {
                                process(se);
                            }
                        } else if (e.type === HerosTailEntityType.MESH) {
                            addMeshEntity(e as HerosTailMeshEntity);
                        }
                    }
                    for (const subEntity of e.subEntities) {
                        process(subEntity);
                    }
                }
                break;
        }

        this.drawCount = indices.length;

        this.vertexBufferDescriptors = [
            { buffer: createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(vertices.map(v => v * WORLD_SCALE)).buffer), byteOffset: 0 },
            { buffer: createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(colors.map(c => c / 255)).buffer), byteOffset: 0 },
            { buffer: createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, new Float32Array(uvs).buffer), byteOffset: 0 }
        ];
        this.indexBufferDescriptor = { buffer: createBufferFromData(cache.device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, new Uint32Array(indices).buffer), byteOffset: 0 };
    }

    public setVisible(v: boolean): void {
        this.visible = v;
    }

    public prepareToRender(device: GfxDevice, renderHelper: GfxRenderHelper, viewerInput: ViewerRenderInput, inputLayout: GfxInputLayout) {
        const renderInst = renderHelper.renderInstManager.newRenderInst();
        renderInst.setVertexInput(inputLayout, this.vertexBufferDescriptors, this.indexBufferDescriptor);
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
