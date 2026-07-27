import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase.js";
import { SceneGfx, ViewerRenderInput } from "../viewer.js";
import { GfxDevice } from "../gfx/platform/GfxPlatform.js";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper.js";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph.js";
import { GfxRenderInstList } from "../gfx/render/GfxRenderInstManager.js";
import { Texture as ViewerTexture } from "../viewer.js";
import { FakeTextureHolder, TextureHolder } from "../TextureHolder.js";
import { makeBackbufferDescSimple, opaqueBlackFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers.js";
import { HerosTailEDBFile, HerosTailParser } from "./bin.js";
import { HerosTailRenderer } from "./render.js";
import { Panel, LayerPanel, LAYER_ICON } from "../ui.js";
import { decodeHerosTailTexture, HerosTailTexture, HerosTailTextureFormat } from "./texture.js";

class Renderer implements SceneGfx {
    private renderHelper: GfxRenderHelper;
    private renderInstListMain = new GfxRenderInstList();
    public textureHolder: TextureHolder;
    private renderer: HerosTailRenderer;
    private clearColor: number[];
    private textures: HerosTailTexture[];

    constructor(device: GfxDevice, edb: HerosTailEDBFile) {
        this.renderHelper = new GfxRenderHelper(device);
        this.renderer = new HerosTailRenderer(this.renderHelper.renderCache, edb);
        this.clearColor = [0, 0, 0];

        this.textures = Array(edb.textures.length);
        for (let i = 0; i < edb.textures.length; i++) {
            const t = edb.textures[i];
            const rgba = decodeHerosTailTexture(t);
            this.textures[i] = new HerosTailTexture(device, i, t.width, t.height, rgba, t.format, t.scroll);
        }
        const viewerTextures: ViewerTexture[] = Array(this.textures.length);
        for (let i = 0; i < this.textures.length; i++) {
            viewerTextures[i] = {
                gfxTexture: this.textures[i].gfxTexture,
                extraInfo: new Map([["Format", `${HerosTailTextureFormat[this.textures[i].format]}`]])
            };
        }
        this.textureHolder = new FakeTextureHolder(viewerTextures);
    }

    protected prepareToRender(device: GfxDevice, viewerInput: ViewerRenderInput): void {
        this.renderHelper.renderInstManager.setCurrentList(this.renderInstListMain);
        this.renderer.prepareToRender(device, this.renderHelper, viewerInput);
        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: ViewerRenderInput): void {
        const builder = this.renderHelper.renderGraph.newGraphBuilder();
        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, opaqueBlackFullClearRenderPassDescriptor);
        mainColorDesc.clearColor = { r: this.clearColor[0], g: this.clearColor[1], b: this.clearColor[2], a: 1 };
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

    public createPanels(): Panel[] {
        const layersPanel = new LayerPanel();
        layersPanel.setLayers([...this.renderer.entities]);
        layersPanel.setTitle(LAYER_ICON, "Ref Entities");

        return [layersPanel];
    }

    public destroy(device: GfxDevice): void {
        this.renderer.destroy(device);
        for (const t of this.textures) {
            device.destroyTexture(t.gfxTexture);
        }
        this.renderHelper.destroy();
    }
}

const pathBase = "SpyroAHT";
class Scene implements SceneDesc {
    constructor(public id: string, public name: string) {

    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
        const ebdFile = await context.dataFetcher.fetchData(`${pathBase}/${this.id}.edb`);
        const edb = new HerosTailParser(ebdFile).parse();
        // console.log(edb);
        return new Renderer(device, edb);
    }
}

/*
TODO

Fix mips for CLUT_64 textures
Confirm alpha value for ARGB_1555 textures
Animated textures (txa and scrolling)
Geometry is mirrored?
Some ref entities can be duplicates
Add PS2 texture decoding to common
 */

const id = "SpyroAHT";
const name = "Spyro: A Hero's Tail";
const sceneDescs = [
    "Dragon Kingdom",
    new Scene("titles", "Title Screen"),
    new Scene("realm1a", "Realm 1A"),
    new Scene("realm1b", "Realm 1B"),
    new Scene("realm1c", "Realm 1C"),
    new Scene("realm1z", "Realm 1Z"),
    new Scene("mr1_blk", "mr1_blk"),
    new Scene("mr1_sgt", "mr1_sgt"),
    new Scene("mr1_spx", "mr1_spx"),
    new Scene("mr1_spy", "mr1_spy"),
    "Lost Cities",
    new Scene("realm2a", "Realm 2A"),
    new Scene("realm2b", "Realm 2B"),
    new Scene("realm2c", "Realm 2C"),
    new Scene("realm2z", "Realm 2Z"),
    new Scene("mr2_blk", "mr2_blk"),
    new Scene("mr2_sgt", "mr2_sgt"),
    new Scene("mr2_spx", "mr2_spx"),
    new Scene("mr2_spy", "mr2_spy"),
    "Icy Wilderness",
    new Scene("realm3a", "Realm 3A"),
    new Scene("realm3b", "Realm 3B"),
    new Scene("realm3c", "Realm 3C"),
    new Scene("realm3z", "Realm 3Z"),
    new Scene("mr3_blk", "mr3_blk"),
    new Scene("mr3_sgt", "mr3_sgt"),
    new Scene("mr3_spx", "mr3_spx"),
    new Scene("mr3_spy", "mr3_spy"),
    "Volcanic Isles",
    new Scene("realm4a", "Realm 4A"),
    new Scene("realm4b", "Realm 4B"),
    new Scene("realm4c", "Realm 4C"),
    new Scene("realm4d", "Realm 4D"),
    new Scene("realm4e", "Realm 4E"),
    new Scene("realm4z", "Realm 4Z"),
    new Scene("mr4_blk", "mr4_blk"),
    new Scene("mr4_sgt", "mr4_sgt"),
    new Scene("mr4_spx", "mr4_spx"),
    new Scene("mr4_spy", "mr4_spy"),
    "Test Maps",
    new Scene("hogwarts", "Hogwarts"),
    new Scene("test_ab", "Test AB"),
    new Scene("test_bch", "Test BCH"),
    new Scene("test_dp", "Test DP"),
    new Scene("test_HN", "Test HN"),
    new Scene("test_jp", "Test JP"),
    new Scene("test_js", "Test JS"),
    new Scene("test_ka", "Test KA"),
    new Scene("test_md", "Test MD"),
    new Scene("test_mf", "Test MF"),
    new Scene("test_mt", "Test MT"),
    new Scene("test_nb", "Test NB"),
    new Scene("test_nb2", "Test NB2"),
    new Scene("test_pb", "Test PB"),
    new Scene("test_sc", "Test SC"),
    new Scene("test_sg", "Test SG"),
    new Scene("test_sj", "Test SJ"),
    new Scene("test_sj2", "Test SJ2"),
    new Scene("test_tl", "Test TL")
];

export const sceneGroup: SceneGroup = { id: id, name: name, sceneDescs: sceneDescs };
