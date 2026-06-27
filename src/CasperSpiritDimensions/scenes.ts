import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase.js";
import { SceneGfx, ViewerRenderInput } from "../viewer.js";
import { GfxCullMode, GfxDevice } from "../gfx/platform/GfxPlatform.js";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper.js";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph.js";
import { GfxRenderInstList } from "../gfx/render/GfxRenderInstManager.js";
import { makeBackbufferDescSimple, opaqueBlackFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers.js";
import { CasperMesh, CasperObjectDefinition, CasperRWParser, CasperTexture, CasperObjectInstance, CapserLevel, CasperSKA } from "./bin.js";
import { CasperLevelRenderer } from "./render.js";
import { Checkbox, COOL_BLUE_COLOR, LayerPanel, Panel, RENDER_HACKS_ICON } from "../ui.js";
import { DataFetcher } from "../DataFetcher.js";
import { Texture as ViewerTexture } from "../viewer.js";
import { FakeTextureHolder, TextureHolder } from "../TextureHolder.js";
import { CameraController } from "../Camera.js";
import * as rw from 'librw';

const CLEAR_COLORS: number[][] = [
    [34, 35, 45], [91, 123, 68], [34, 35, 45], [11, 16, 29],
    [90, 79, 54], [5, 5, 5],     [5, 5, 5],    [5, 5, 5],
    [5, 5, 5],    [5, 5, 5],     [5, 5, 5],    [77, 50, 52],
    [12, 12, 39], [5, 5, 5],     [7, 10, 21],  [7, 19, 34]
];

class Renderer implements SceneGfx {
    public textureHolder: TextureHolder;
    private renderHelper: GfxRenderHelper;
    private renderInstListMain = new GfxRenderInstList();
    private levelRenderer: CasperLevelRenderer;
    private clearColor: number[];

    constructor(device: GfxDevice, level: CapserLevel, textures: Map<string, CasperTexture>, objMeshes: Map<string, CasperMesh>, objInstances: CasperObjectInstance[], skas: Map<string, CasperSKA>) {
        const viewerTextures: ViewerTexture[] = [];
        for (const texture of textures.values()) {
            viewerTextures.push({
                gfxTexture: texture.gfxTexture,
                extraInfo: new Map<string, string>([["Has Alpha", `${texture.hasAlpha}`], ["Bit Depth", `${texture.bitDepth}`]])
            });
        }

        this.textureHolder = new FakeTextureHolder(viewerTextures);
        this.renderHelper = new GfxRenderHelper(device);
        this.levelRenderer = new CasperLevelRenderer(this.renderHelper.renderCache, level, textures, objMeshes, objInstances, skas);

        this.clearColor = CLEAR_COLORS[level.number - 1];
        this.clearColor[0] /= 255;
        this.clearColor[1] /= 255;
        this.clearColor[2] /= 255;
    }

    protected prepareToRender(device: GfxDevice, viewerInput: ViewerRenderInput): void {
        this.renderHelper.renderInstManager.setCurrentList(this.renderInstListMain);
        this.levelRenderer.prepareToRender(device, this.renderHelper, viewerInput);
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
        layersPanel.setLayers(this.levelRenderer.meshLayers);

        const optionsPanel = new Panel();
        optionsPanel.customHeaderBackgroundColor = COOL_BLUE_COLOR;
        optionsPanel.setTitle(RENDER_HACKS_ICON, "Render Hacks");
        const toggleBackFaceCull = new Checkbox("Enable back-face culling", this.levelRenderer.cullMode == GfxCullMode.Back);
        toggleBackFaceCull.onchanged = () => {
            this.levelRenderer.cullMode = toggleBackFaceCull.checked ? GfxCullMode.Back : GfxCullMode.None
        };
        optionsPanel.contents.appendChild(toggleBackFaceCull.elem);
        const toggleTextures = new Checkbox("Enable materials", true);
        toggleTextures.onchanged = () => {
            this.levelRenderer.showTextures = toggleTextures.checked
        };
        optionsPanel.contents.appendChild(toggleTextures.elem);
        const toggleObjects = new Checkbox("Show objects", true);
        toggleObjects.onchanged = () => {
            this.levelRenderer.showObjects = toggleObjects.checked
        };
        optionsPanel.contents.appendChild(toggleObjects.elem);

        return [layersPanel, optionsPanel];
    }

    public adjustCameraController(c: CameraController) {
        c.setSceneMoveSpeedMult(8 / 60);
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy();
        this.textureHolder.destroy(device);
        this.levelRenderer.destroy(device);
    }
}

/*
Game uses the RenderWare engine. Some files have their extensions changed (such as .TXD to .DIC) and contain custom structs.
The RW Analyze tool can be used to read most of the files if you remove the extension filter in the file picker

TODO

Figure out X and Z for rotations (inconsistent across different objects)
    Example the grate and gems in snowy town
Figure out lava in dragon's cave
Figure out why some objects with meshes in TOM don't render
    Example the cannon in the amusement park
Figure out how some objects/texture without alpha names are set to be transparent
    Example casper himself or kibosh
Level objects
    Add different kinds, fix the ones currently ignored
Remove hardcoded clear colors and read from actual data (might be from fog color)
Combine level and mesh renderers' common code

Nice to have

NPC/enemy pathing
*/

const DFF_SKA_MAPPING: Map<string, string> = new Map([
    // ["lucky_chicken", "CKNPECK1"],
    // ["casper", "IDLE01"],
    //["wendy", "IDLE"]
]);

const pathBase = "CasperSD";
class Level implements SceneDesc {
    public id: string;
    private levelNumber: number;

    constructor(private bspPath: string, public name: string) {
        // game is annoyingly inconsistent with level numbers like "02" vs "2"
        this.id = bspPath.split("/")[1].split(".")[0];
        this.levelNumber = Number(this.id.split("LEVEL")[1]);
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
        const bsp = await context.dataFetcher.fetchData(`${pathBase}/MODELS/${this.bspPath}`);
        const dic = await context.dataFetcher.fetchData(`${pathBase}/MODELS/LEVEL${this.levelNumber}.DIC`);
        const tom = await context.dataFetcher.fetchData(`${pathBase}/SCRIPTC/${this.id}/M${this.id}.TOM`);
        const obd = await context.dataFetcher.fetchData(`${pathBase}/SCRIPTC/CASPER.OBD`);

        const level = new CasperRWParser(bsp).parseBSP(this.id, this.levelNumber);

        const objDefs = new CasperRWParser(obd).parseOBD();
        const instances = new CasperRWParser(tom).parseTOM();
        const objMeshes = await buildDFFMeshes(context.dataFetcher, level, objDefs, instances);
        const meshMaterials = [];
        for (const mesh of objMeshes.values()) {
            if (mesh.materials) {
                meshMaterials.push(...mesh.materials);
            }
        }

        const textures = new CasperRWParser(dic).parseDIC(device, [...level.materials, ...meshMaterials]);

        const skas: Map<string, CasperSKA> = new Map();
        for (const [dffName, skaName] of DFF_SKA_MAPPING) {
            if (objMeshes.has(dffName)) {
                const path = objDefs.find(d => d.names.includes(dffName))!.dffPath.replace(/\/[^\/]*$/, "");
                const ska = await context.dataFetcher.fetchData(`${pathBase}/${path}/${skaName}.SKA`);
                skas.set(dffName, new CasperRWParser(ska).parseSKA());
            }
        }

        return new Renderer(device, level, textures, objMeshes, instances, skas);
    }
}

/**
 * Call this _before_ parsing textures so meshes' materials aren't ignored
 */
async function buildDFFMeshes(dataFetcher: DataFetcher, level: CapserLevel, objDefs: CasperObjectDefinition[], objInstances: CasperObjectInstance[]): Promise<Map<string, CasperMesh>> {
    const meshes = new Map<string, CasperMesh>();
    for (const instance of objInstances) {
        // don't build the same mesh more than once
        if (meshes.has(instance.name)) {
            continue;
        }
        let path = "";
        for (const def of objDefs) {
            if (def.names.includes(instance.name)) {
                path = def.dffPath;
                break;
            }
        }
        if (path === "") {
            // console.log("Skipping OBJ by no DFF", instance.name);
            continue;
        }
        const dff = await dataFetcher.fetchData(`${pathBase}/${path}`);
        const mesh = new CasperRWParser(dff).parseDFF();
        // console.log(instance.name, path);
        if (mesh.vertices.length === 0) {
            // console.log("Skipping OBJ by no vertices", instance.name);
            continue;
        }
        meshes.set(instance.name, mesh);
    }
    return meshes;
}

// level names are from the game's manual (other than "Hub", the dimension with just the house doesn't have an official name)
const id = "CasperSD";
const name = "Casper: Spirit Dimensions";
const sceneDescs = [
    "Hub",
    new Level("HOUSE/LEVEL16.BSP", "Casper's House"),
    "The Medieval World",
    new Level("MEDIEVAL/LEVEL01.BSP", "Knight's Home"),
    new Level("MEDIEVAL/LEVEL02.BSP", "Thieves' Woods"),
    new Level("MEDIEVAL/LEVEL03.BSP", "Wizard's Tower"),
    new Level("MEDIEVAL/LEVEL04.BSP", "Snowy Town"),
    new Level("MEDIEVAL/LEVEL05.BSP", "Dragon's Cave"),
    "Spirit Amusement Park",
    new Level("CARNIVAL/LEVEL06.BSP", "Vlad's Amusement Park"),
    new Level("CARNIVAL/LEVEL08.BSP", "Fun House"),
    new Level("CARNIVAL/LEVEL11.BSP", "Big Top"),
    "Kibosh's Factory",
    new Level("FACTORY/LEVEL12.BSP", "Monster Maker"),
    new Level("FACTORY/LEVEL13.BSP", "Refinery"),
    new Level("FACTORY/LEVEL14.BSP", "Doctor Deranged"),
    "The Spirit World",
    new Level("SPIRIT/LEVEL07.BSP", "Ghost Ship"),
    new Level("SPIRIT/LEVEL10.BSP", "Kibosh's Castle"),
    new Level("SPIRIT/LEVEL09.BSP", "Kibosh's Castle Interior"),
    new Level("SPIRIT/LEVEL15.BSP", "Kibosh's Lair")
];

export const sceneGroup: SceneGroup = { id, name, sceneDescs };
