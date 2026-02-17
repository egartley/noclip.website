import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase.js";
import { SceneGfx, ViewerRenderInput } from "../viewer.js";
import { GfxDevice } from "../gfx/platform/GfxPlatform.js";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper.js";
import { LevelRenderer } from "./render.js"
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph.js";
import { GfxRenderInstList } from "../gfx/render/GfxRenderInstManager.js";
import { makeBackbufferDescSimple, opaqueBlackFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers.js";
import { GeometryFile, MRB } from "./bin.js";

export class SpyroETDRenderer implements SceneGfx {
    private renderHelper: GfxRenderHelper;
    private renderInstListMain = new GfxRenderInstList();
    private levelRenderer: LevelRenderer;

    constructor(device: GfxDevice, geos: GeometryFile[]) {
        this.renderHelper = new GfxRenderHelper(device);
        this.levelRenderer = new LevelRenderer(this.renderHelper.renderCache, geos);
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
    }
}

const pathBase = "SpyroETD";
class SpyroETDScene implements SceneDesc {
    public id: string;

    constructor(id: number, public geomIndices: number[], public name: string) {
        this.id = id.toString();
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
        const geos = [];
        for (let i = 0; i < GEOMS.length; i++) {
            if (this.geomIndices.includes(i)) {
                const file = await context.dataFetcher.fetchData(`${pathBase}/${GEOMS[i]}`);
                const geo = new GeometryFile(file.createDataView());
                geos.push(geo);
            }
        }
        // const test = await context.dataFetcher.fetchData(`${pathBase}/L_1_DD/448_67E2B89A.MRB`);
        // const mrb = new MRB(test.createDataView());
        return new SpyroETDRenderer(device, geos);
    }
}

const GEOMS = ["L_1_DD/363_552369DA.GEOM", "L_1_DD/341_5099EFC2.GEOM", "L_1_DD/1000_D99EE769.GEOM", "L_1_DD/1086_E9F4D33D.GEOM", "L_1_DD/644_8DDAE922.GEOM",
    "L_1_DD/983_D72304FD.GEOM", "L_1_DD/679_95446F7E.GEOM", "L_1_DD/488_70168DFD.GEOM", "L_1_DD/703_9A82F879.GEOM", "L_1_DD/624_88EBE657.GEOM",
    "L_1_DD/335_4F8E7812.GEOM", "T_1_DD/19_51C32784.GEOM"
];

const id = "SpyroETD";
const name = "Spyro: Enter the Dragonfly";
const sceneDescs = [
    "Dragonfly Dojo",
    new SpyroETDScene(0, [0], "DD 0"),
    new SpyroETDScene(1, [1], "DD 1"),
    new SpyroETDScene(2, [2], "DD 2"),
    new SpyroETDScene(3, [3], "DD 3"),
    new SpyroETDScene(4, [4], "DD 4"),
    new SpyroETDScene(5, [5], "DD 5"),
    new SpyroETDScene(6, [6], "DD 6"),
    new SpyroETDScene(7, [7], "DD 7"),
    new SpyroETDScene(8, [8], "DD 8"),
    new SpyroETDScene(9, [9], "DD 9"),
    new SpyroETDScene(10, [10], "DD 10"),
    new SpyroETDScene(30, [0, 3, 9], "DD 0+3+9"),
    new SpyroETDScene(31, [2, 4], "DD 2+4"),
    new SpyroETDScene(32, [5, 6], "DD 5+6"),
    "Transition - Dragonfly Dojo",
    new SpyroETDScene(50, [11], "T 1 DD"),
];

export const sceneGroup: SceneGroup = { id, name, sceneDescs };
