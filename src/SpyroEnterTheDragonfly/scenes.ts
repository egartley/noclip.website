import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase.js";
import { SceneGfx, ViewerRenderInput } from "../viewer.js";
import { GfxDevice } from "../gfx/platform/GfxPlatform.js";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper.js";
import { LevelRenderer } from "./render.js"
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph.js";
import { GfxRenderInstList } from "../gfx/render/GfxRenderInstManager.js";
import { makeBackbufferDescSimple, opaqueBlackFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers.js";
import { Texture as ViewerTexture } from "../viewer.js";
import ArrayBufferSlice from "../ArrayBufferSlice.js";
import { convertToCanvas } from "../gfx/helpers/TextureConversionHelpers.js";
import { FakeTextureHolder, TextureHolder } from "../TextureHolder.js";
import { GeomFile } from "./bin_geom.js";
import { buildTextures, PXTFile, Texture } from "./bin_pxt.js";
import { MRBBundle, MRBFile } from "./bin_mrb.js";

export class SpyroETDRenderer implements SceneGfx {
    public textureHolder: TextureHolder;
    private renderHelper: GfxRenderHelper;
    private renderInstListMain = new GfxRenderInstList();
    private levelRenderer: LevelRenderer;

    constructor(device: GfxDevice, geos: GeomFile[], textures: Texture[]) {
        const viewerTextures: ViewerTexture[] = [];
        for (let i = 0; i < textures.length; i++) {
            viewerTextures.push(convertToViewerTexture(`texture_${i}`, textures[i]));
        }
        this.textureHolder = new FakeTextureHolder(viewerTextures);
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
                const geo = new GeomFile(file.createDataView());
                geos.push(geo);
            }
        }
        const pxtFile = await context.dataFetcher.fetchData(`${pathBase}/T_1_DD/bundle.pxt`);
        const pxt = new PXTFile(pxtFile.createDataView());
        const mrbFile = await context.dataFetcher.fetchData(`${pathBase}/T_1_DD/bundle.mrb`);
        const mrb = new MRBBundle(mrbFile.createDataView());
        const textures = buildTextures(pxt);
        return new SpyroETDRenderer(device, geos, textures);
    }
}

function convertToViewerTexture(name: string, texture: Texture): ViewerTexture {
    const canvas = convertToCanvas(ArrayBufferSlice.fromView(texture.rgba), texture.width, texture.height);
    canvas.title = name;
    const extraInfo = new Map<string, string>();
    extraInfo.set("Bit Depth", texture.bitDepth.toString());
    return { name, surfaces: [canvas], extraInfo };
}

const GEOMS = ["L_1_DD/552369DA.geom", "L_1_DD/5099EFC2.geom", "L_1_DD/D99EE769.geom", "L_1_DD/E9F4D33D.geom", "L_1_DD/8DDAE922.geom",
    "L_1_DD/D72304FD.geom", "L_1_DD/95446F7E.geom", "L_1_DD/70168DFD.geom", "L_1_DD/9A82F879.geom", "L_1_DD/88EBE657.geom",
    "L_1_DD/4F8E7812.geom", "T_1_DD/51C32784.geom", "T_1_DD/9BBF9989.geom", "THE_HUB/4EB71428.geom", "THE_HUB/81925A09.geom",
    "THE_HUB/D3437F3D.geom", "THE_HUB/B350CDDC.geom", "THE_HUB/E53864AA.geom", "THE_HUB/377E599B.geom", "THE_HUB/52E69795.geom",
    "THE_HUB/E9A19DF4.geom", "T_0_ATLS/D8436FD9.geom", "T_0_ATLS/919A78DB.geom", "T_0_HUB/6949CAD0.geom", "T_0_HUB/919A78DB.geom",
    "T_2_CCC/863244B5.geom", "T_2_CCC/5A986E73.geom", "L_2_CC/EB96D1D9.geom", "L_2_CC/F6C8620B.geom", "L_2_CC/3DBBE0F5.geom",
    "L_2_CC/5A3A4DA1.geom", "L_2_CC/B7D739DA.geom", "L_3_LI/1527BFFD.geom", "L_3_LI/0621944F.geom", "L_3_LI/69B502A6.geom",
    "L_3_LI/F2A3B9C4.geom", "L_3_LI/E350D741.geom", "L_3_LI/99253B77.geom", "T_3_LI/CCB1DAF3.geom", "T_3_LI/F427E765.geom", "C_1_INT1/C17DAFFF.geom",
    "C_1_INT1/791CF82C.geom", "C_2_INT2/B2D436D8.geom", "C_2_INT2/A6DE9BDF.geom", "C_3_MIDG/7EF16F14.geom", "C_3_MIDG/F7197213.geom",
    "C_4_BOS1/9150A5D0.geom", "C_4_BOS1/E541BB4A.geom", "C_5_BOS2/72ED7362.geom", "C_5_BOS2/3247CE3E.geom", "CREDITS1/5CE245E0.geom",
    "CREDITS1/12941A31.geom", "CREDITS2/0FB70C66.geom", "CREDITS2/12941A31.geom", "DEMO1/66DF417B.geom", "DEMO2/AE958AE8.geom",
    "DEMO3/A9137D69.geom", "DEMO4/2855A6EB.geom"
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
    "Cutscenes",
    new SpyroETDScene([40], "INT1 1"),
    new SpyroETDScene([41], "INT1 2"),
    new SpyroETDScene([42], "INT2 1"),
    new SpyroETDScene([43], "INT2 2"),
    new SpyroETDScene([44], "MIDG 1"),
    new SpyroETDScene([45], "MIDG 2"),
    new SpyroETDScene([46], "BOS1 1"),
    new SpyroETDScene([47], "BOS1 2"),
    new SpyroETDScene([48], "BOS2 1"),
    new SpyroETDScene([49], "BOS2 2"),
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
    "Transition 3 (Luau Island)",
    new SpyroETDScene([38], "T3LI 1"),
    new SpyroETDScene([39], "T3LI 2"),
    "Demo Levels",
    new SpyroETDScene([54], "Demo 1"),
    new SpyroETDScene([55], "Demo 2"),
    new SpyroETDScene([56], "Demo 3"),
    new SpyroETDScene([57], "Demo 4"),
    "Credits",
    new SpyroETDScene([50], "Credits1 1"),
    new SpyroETDScene([51], "Credits1 2"),
    new SpyroETDScene([52], "Credits2 1"),
    new SpyroETDScene([53], "Credits2 2"),
];

export const sceneGroup: SceneGroup = { id, name, sceneDescs };
