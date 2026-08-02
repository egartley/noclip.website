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
import { Panel, LayerPanel, LAYER_ICON, COOL_BLUE_COLOR, RENDER_HACKS_ICON, Checkbox } from "../ui.js";
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

        this.renderer = new HerosTailRenderer(this.renderHelper.renderCache, edb, this.textures);
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
        layersPanel.setLayers([...this.renderer.zones]);
        layersPanel.setTitle(LAYER_ICON, "Map Zones");

        const renderOptions = new Panel();
        renderOptions.customHeaderBackgroundColor = COOL_BLUE_COLOR;
        renderOptions.setTitle(RENDER_HACKS_ICON, "Render Hacks");
        const zoneCull = new Checkbox("Apply Zone Culling", this.renderer.doZoneCulling);
        zoneCull.onchanged = () => {
            this.renderer.doZoneCulling = zoneCull.checked
        };
        renderOptions.contents.appendChild(zoneCull.elem);

        return [layersPanel, renderOptions];
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
        device.checkForLeaks();
        const ebdFile = await context.dataFetcher.fetchData(`${pathBase}/${this.id}.edb`);
        const edb = new HerosTailParser(ebdFile).parse();
        return new Renderer(device, edb);
    }
}

/*
TODO

Fix texture mips
Confirm alpha value for ARGB_1555 textures
Animated textures frames
Some ref entities can be duplicates (handle with map zones?)
Add PS2 texture decoding/unswizzling to common
Properly handle split entities rather than merging together
Better way to pass around textures?
Troubleshoot rare occurence of buffer leak
 */

const id = "SpyroAHT";
const name = "Spyro: A Hero's Tail";
const sceneDescs = [
    "Dragon Kingdom",
    new Scene("titles", "Title Screen"),
    new Scene("realm1a", "Dragon Village"),
    new Scene("realm1b", "Crocovile Swamp"),
    new Scene("realm1c", "Dragonfly Falls"),
    new Scene("realm1z", "Gnasty's Cave"),
    new Scene("mr1_sgt", "Island Speedway (Sgt. Byrd)"),
    new Scene("mr1_blk", "Minigame (Blink)"),
    new Scene("mr1_spx", "Minigame (Sparx)"),
    new Scene("mr1_spy", "Minigame (Spyro)"),
    new Scene("r1linkab", "Interstitial (Village/Swamp)"),
    new Scene("r1linkac", "Interstitial (Village/Falls)"),
    "Lost Cities",
    new Scene("realm2a", "Coastal Remains"),
    new Scene("realm2b", "Sunken Ruins"),
    new Scene("realm2c", "Cloudy Domain"),
    new Scene("realm2z", "Watery Tomb"),
    new Scene("mr2_sgt", "Cloudy Speedway (Sgt. Byrd)"),
    new Scene("mr2_blk", "Minigame (Blink)"),
    new Scene("mr2_spx", "Minigame (Sparx)"),
    new Scene("mr2_spy", "Minigame (Spyro)"),
    new Scene("r2linkab", "Interstitial (Remains/Ruins)"),
    new Scene("r2linkac", "Interstitial (Remains/Domain)"),
    "Icy Wilderness",
    new Scene("realm3a", "Frostbite Village"),
    new Scene("realm3b", "Gloomy Glacier"),
    new Scene("realm3c", "Ice Citadel"),
    new Scene("realm3z", "Red's Chamber"),
    new Scene("mr3_sgt", "Iceberg Aerobatics (Sgt. Byrd)"),
    new Scene("mr3_blk", "Minigame (Blink)"),
    new Scene("mr3_spx", "Minigame (Sparx)"),
    new Scene("mr3_spy", "Minigame (Spyro)"),
    "Volcanic Isles",
    new Scene("realm4a", "Stormy Beach"),
    new Scene("realm4b", "Molten Mount"),
    new Scene("realm4c", "Magma Falls"),
    new Scene("realm4d", "Dark Mine"),
    new Scene("realm4e", "Red's Laboratory"),
    new Scene("realm4z", "Red's Lair"),
    new Scene("mr4_sgt", "Lava Palaver (Sgt. Byrd)"),
    new Scene("mr4_blk", "Minigame (Blink)"),
    new Scene("mr4_spx", "Minigame (Sparx)"),
    new Scene("mr4_spy", "Minigame (Spyro)"),
    new Scene("r4linkbc", "Interstitial (Mount/Falls)"),
    new Scene("r4linkcd", "Interstitial (Falls/Mine)"),
    new Scene("r4linkde", "Interstitial (Mine/Laboratory)"),
    "Unused Maps",
    new Scene("hogwarts", "Hogwarts"),
    new Scene("maptest", "Map Test"),
    new Scene("model", "Model Viewer"),
    new Scene("playroom", "Playroom"),
    new Scene("r1linkbc", "R1LinkBC"),
    new Scene("shop", "Shop"),
    new Scene("startup", "Startup"),
    new Scene("test_ab", "Test AB"),
    new Scene("test_bch", "Test Beach"),
    new Scene("testbed", "Test Bed"),
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

export const sceneGroup: SceneGroup = { id, name, sceneDescs };
