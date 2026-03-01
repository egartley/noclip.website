import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase.js";
import { SceneGfx, ViewerRenderInput } from "../viewer.js";
import { GfxDevice } from "../gfx/platform/GfxPlatform.js";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper.js";
import { LevelRenderer } from "./render.js"
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph.js";
import { GfxRenderInstList } from "../gfx/render/GfxRenderInstManager.js";
import { makeBackbufferDescSimple, opaqueBlackFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers.js";
import { Texture as ViewerTexture } from "../viewer.js";
import { convertToCanvas } from "../gfx/helpers/TextureConversionHelpers.js";
import { FakeTextureHolder, TextureHolder } from "../TextureHolder.js";
import { ChunkType, DBLFile, GeometryChunk, getChunksByType } from "./bin.js";
import { buildTextures, Texture } from "./bin_texture.js";
import ArrayBufferSlice from "../ArrayBufferSlice.js";

export class WilburRenderer implements SceneGfx {
    public textureHolder: TextureHolder;
    private renderHelper: GfxRenderHelper;
    private renderInstListMain = new GfxRenderInstList();
    private levelRenderer: LevelRenderer;

    constructor(device: GfxDevice, dbl: DBLFile) {
        const viewerTextures: ViewerTexture[] = [];
        const textures = buildTextures(device, dbl);
        for (let i = 0; i < textures.length; i++) {
            viewerTextures.push(convertToViewerTexture(textures[i].name, textures[i]));
        }
        this.textureHolder = new FakeTextureHolder(viewerTextures);
        this.renderHelper = new GfxRenderHelper(device);
        this.levelRenderer = new LevelRenderer(this.renderHelper.renderCache, textures, getChunksByType(dbl, ChunkType.Geometry) as GeometryChunk[]);
    }

    protected prepareToRender(device: GfxDevice, viewerInput: ViewerRenderInput): void {
        this.renderHelper.renderInstManager.setCurrentList(this.renderInstListMain);
        this.levelRenderer.prepareToRender(device, this.renderHelper, viewerInput);
        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: ViewerRenderInput): void {
        const builder = this.renderHelper.renderGraph.newGraphBuilder();
        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, opaqueBlackFullClearRenderPassDescriptor);
        // mainColorDesc.clearColor = {r: this.clearColor[0] / 255, g: this.clearColor[1] / 255, b: this.clearColor[2] / 255, a: 1};
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, opaqueBlackFullClearRenderPassDescriptor);
        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                this.renderInstListMain.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);
        this.prepareToRender(device, viewerInput);
        this.renderHelper.renderGraph.execute(builder);
        this.renderInstListMain.reset();
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy();
        this.levelRenderer.destroy(device);
        this.textureHolder.destroy(device);
    }
}

const pathBase = "MeetTheRobinsons";
class WilburScene implements SceneDesc {
    public id: string;

    constructor(n: number, public name: string) {
        this.id = n.toString();
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
        const file = await context.dataFetcher.fetchData(`${pathBase}/OBJECTS/PICKUP_MEAT.DBL`);
        const dblFile = new DBLFile(file.createDataView());
        return new WilburRenderer(device, dblFile);
    }
}

function convertToViewerTexture(name: string, texture: Texture): ViewerTexture {
    const canvas = convertToCanvas(ArrayBufferSlice.fromView(texture.rgba), texture.width, texture.height);
    canvas.title = name;
    return { name, surfaces: [canvas] };
}

const id = "Wilbur";
const name = "Meet the Robinsons";
const sceneDescs = [
    new WilburScene(1, "Test")
];

export const sceneGroup: SceneGroup = { id, name, sceneDescs };