import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase.js";
import { SceneGfx, ViewerRenderInput } from "../viewer.js";
import { GfxDevice } from "../gfx/platform/GfxPlatform.js";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper.js";
import { LevelRenderer } from "./render.js"
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph.js";
import { GfxRenderInstList } from "../gfx/render/GfxRenderInstManager.js";
import { makeBackbufferDescSimple, opaqueBlackFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers.js";
import { GeometryFile } from "./bin.js";

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

    constructor(public geomIndices: number[], public name: string, customId?: string) {
        if (customId) {
            this.id = customId;
        } else {
            this.id = "";
            for (const i of geomIndices) {
                this.id += i.toString() + "_";
            }
            this.id = this.id.substring(0, this.id.length - 1);
        }
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
        return new SpyroETDRenderer(device, geos);
    }
}

const GEOMS = ["L_1_DD/363_552369DA.GEOM", "L_1_DD/341_5099EFC2.GEOM", "L_1_DD/1000_D99EE769.GEOM", "L_1_DD/1086_E9F4D33D.GEOM", "L_1_DD/644_8DDAE922.GEOM",
    "L_1_DD/983_D72304FD.GEOM", "L_1_DD/679_95446F7E.GEOM", "L_1_DD/488_70168DFD.GEOM", "L_1_DD/703_9A82F879.GEOM", "L_1_DD/624_88EBE657.GEOM",
    "L_1_DD/335_4F8E7812.GEOM", "T_1_DD/19_51C32784.GEOM", "T_1_DD/33_9BBF9989.GEOM", "THE_HUB/461_4EB71428.GEOM", "THE_HUB/782_81925A09.GEOM",
    "THE_HUB/1280_D3437F3D.GEOM", "THE_HUB/1087_B350CDDC.GEOM", "THE_HUB/1399_E53864AA.GEOM", "THE_HUB/336_377E599B.GEOM", "THE_HUB/490_52E69795.GEOM",
    "THE_HUB/1429_E9A19DF4.GEOM", "T_0_ATLS/41_D8436FD9.GEOM", "T_0_ATLS/29_919A78DB.GEOM", "T_0_HUB/15_6949CAD0.GEOM", "T_0_HUB/26_919A78DB.GEOM",
    "T_2_CCC/27_863244B5.GEOM", "T_2_CCC/16_5A986E73.GEOM", "L_2_CC/1115_EB96D1D9.GEOM", "L_2_CC/1159_F6C8620B.GEOM", "L_2_CC/286_3DBBE0F5.GEOM",
    "L_2_CC/420_5A3A4DA1.GEOM", "L_2_CC/853_B7D739DA.GEOM", "L_3_LI/99_1527BFFD.GEOM", "L_3_LI/34_0621944F.GEOM", "L_3_LI/512_69B502A6.GEOM",
    "L_3_LI/1187_F2A3B9C4.GEOM", "L_3_LI/1107_E350D741.GEOM", "L_3_LI/733_99253B77.GEOM"
];

const id = "SpyroETD";
const name = "Spyro: Enter the Dragonfly";
const sceneDescs = [
    "Levels",
    new SpyroETDScene([14, 15, 16, 17, 18, 19, 20], "The Hub", "1000"),
    new SpyroETDScene([2, 4, 1, 8], "Dragonfly Dojo", "999"),
    new SpyroETDScene([0, 3, 5, 6, 7, 9], "Dragonfly Dojo 2", "998"),
    new SpyroETDScene([28, 29, 30, 31], "Crop Circle Country", "997"),
    new SpyroETDScene([33, 34, 35, 36, 37], "Luau Island", "996"),
    "Transition 0 (Atlas)",
    new SpyroETDScene([21], "T0A 1"),
    new SpyroETDScene([22], "T0A 2"),
    "Transition 0 (Hub)",
    new SpyroETDScene([23], "T0H 1"),
    new SpyroETDScene([24], "T0H 2"),
    "Transition 1 (Dragonfly Dojo)",
    new SpyroETDScene([11], "T1DD 1"),
    new SpyroETDScene([12], "T1DD 2"),
    "Transition 2 (Crop Circle Country)",
    new SpyroETDScene([25], "T2CCC 1"),
    new SpyroETDScene([26], "T2CCC 2"),
];

export const sceneGroup: SceneGroup = { id, name, sceneDescs };
