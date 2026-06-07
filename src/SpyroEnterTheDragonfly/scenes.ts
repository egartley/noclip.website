import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase.js";
import { SceneGfx, ViewerRenderInput } from "../viewer.js";
import { GfxDevice } from "../gfx/platform/GfxPlatform.js";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper.js";
import { LevelRenderer } from "./render.js"
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph.js";
import { GfxRenderInstList } from "../gfx/render/GfxRenderInstManager.js";
import { makeBackbufferDescSimple, opaqueBlackFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers.js";
import { Texture as ViewerTexture } from "../viewer.js";
import { FakeTextureHolder, TextureHolder } from "../TextureHolder.js";
import { GeometryChunk, GeomFile } from "./bin_geom.js";
import { buildTextures, PXTFile, Texture } from "./bin_pxt.js";
import { MRBBundle } from "./bin_mrb.js";

class Renderer implements SceneGfx {
    public textureHolder: TextureHolder;
    private renderHelper: GfxRenderHelper;
    private renderInstListMain = new GfxRenderInstList();
    private levelRenderer: LevelRenderer;

    constructor(device: GfxDevice, chunks: GeometryChunk[], textures: Texture[]) {
        const viewerTextures: ViewerTexture[] = [];
        for (let i = 0; i < textures.length; i++) {
            device.setResourceName(textures[i].gfxTexture, `texture_${i}`);
            viewerTextures.push(convertToViewerTexture(textures[i]));
        }
        this.textureHolder = new FakeTextureHolder(viewerTextures);
        this.renderHelper = new GfxRenderHelper(device);
        this.levelRenderer = new LevelRenderer(this.renderHelper.renderCache, chunks, textures);
    }

    protected prepareToRender(device: GfxDevice, viewerInput: ViewerRenderInput): void {
        this.renderHelper.renderInstManager.setCurrentList(this.renderInstListMain);
        this.levelRenderer.prepareToRender(device, this.renderHelper, viewerInput);
        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: ViewerRenderInput): void {
        const builder = this.renderHelper.renderGraph.newGraphBuilder();
        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, opaqueBlackFullClearRenderPassDescriptor);
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
        builder.execute();
        this.renderInstListMain.reset();
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy();
        this.levelRenderer.destroy(device);
    }
}

const pathBase = "SpyroETD";
class Scene implements SceneDesc {
    constructor(public id: string, public name: string) { }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
        const mapping = MRB_GEOM_MAP.get(this.id)!;
        const mrbFile = await context.dataFetcher.fetchData(`${pathBase}/${this.id}/${mapping[0]}`);
        const mrb = new MRBBundle(mrbFile.createDataView());
        const geomFile = await context.dataFetcher.fetchData(`${pathBase}/${this.id}/${mapping[1]}`);
        const geom = new GeomFile(geomFile.createDataView());
        const pxtFile = await context.dataFetcher.fetchData(`${pathBase}/${this.id}/bundle.pxt`);
        const pxt = new PXTFile(pxtFile.createDataView());
        const textures = buildTextures(device, pxt);

        return new Renderer(device, [...geom.chunks], textures);
    }
}

function convertToViewerTexture(texture: Texture): ViewerTexture {
    const extraInfo = new Map<string, string>();
    extraInfo.set("Bit Depth", texture.bitDepth.toString());
    return { gfxTexture: texture.gfxTexture, extraInfo };
}

const MRB_GEOM_MAP: Map<string, string[]> = new Map<string, string[]>([[
    "T_1_DD", ["267DFF0F.mrb", "51C32784.geom"]
]]);

const id = "SpyroETD";
const name = "Spyro: Enter the Dragonfly";
const sceneDescs = [
    new Scene("T_1_DD", "Transition (Dragonfly Dojo)")
];

export const sceneGroup: SceneGroup = { id, name, sceneDescs };
