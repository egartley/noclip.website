import CRC32 from 'crc-32';
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
import { GeometryChunk, GeomFile } from "./bin_geom.js";
import { buildTextures, PXTFile, Texture } from "./bin_pxt.js";
import { ChunkType, getChunksByType, getChunksById, MRBBundle, ObjectShapeChunk, Shape2Chunk, TextureGroupChunk, TextureChunk, ClusterShapeChunk } from "./bin_mrb.js";

export class SpyroETDRenderer implements SceneGfx {
    public textureHolder: TextureHolder;
    private renderHelper: GfxRenderHelper;
    private renderInstListMain = new GfxRenderInstList();
    private levelRenderer: LevelRenderer;

    constructor(device: GfxDevice, chunks: GeometryChunk[], textures: Texture[]) {
        const viewerTextures: ViewerTexture[] = [];
        for (let i = 0; i < textures.length; i++) {
            viewerTextures.push(convertToViewerTexture(`texture_${i}`, textures[i]));
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
    constructor(public id: string, public name: string) { }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
        const mapping = MRB_GEOM_MAP.get(this.id)!;
        const mrbFile = await context.dataFetcher.fetchData(`${pathBase}/${this.id}/${mapping[0]}`);
        const mrb = new MRBBundle(mrbFile.createDataView());
        const geomFile = await context.dataFetcher.fetchData(`${pathBase}/${this.id}/${mapping[1]}`);
        const geom = new GeomFile(geomFile.createDataView());
        const pxtFile = await context.dataFetcher.fetchData(`${pathBase}/${this.id}/bundle.pxt`);
        const pxt = new PXTFile(pxtFile.createDataView());

        const objectShapes = getChunksByType(mrb, ChunkType.ObjectShape, ChunkType.Shape2, ChunkType.ClusterShape);
        const validChunks: GeometryChunk[] = [];
        const textureGroupIds = [];
        for (const s of objectShapes) {
            const shape = s as ObjectShapeChunk | Shape2Chunk | ClusterShapeChunk;
            textureGroupIds.push(shape.textureGroupId);
            for (let i = 0; i < geom.chunks.length; i++) {
                const chunk = geom.chunks[i];
                if (shape.geomOffset === chunk.offset) {
                    for (let j = 0; j < shape.geomChunkCount; j++) {
                        let chunk = geom.chunks[i + j];
                        const ti = SHAPE_TEXTURES.get(this.id)!.get(shape.name);
                        chunk.textureIndex = ti ? ti : -1;
                        validChunks.push(chunk);
                    }
                    break;
                }
            }
        }
        // const textureGroups = getChunksById(mrb, ...textureGroupIds);
        // const textureChunks = [];
        // for (const g of textureGroups) {
        //     const group = g as TextureGroupChunk;
        //     textureChunks.push(...getChunksById(mrb, ...group.textureIds));
        // }
        const textures = buildTextures(device, pxt);
        return new SpyroETDRenderer(device, validChunks, textures);
    }
}

function convertToViewerTexture(name: string, texture: Texture): ViewerTexture {
    const canvas = convertToCanvas(ArrayBufferSlice.fromView(texture.rgba), texture.width, texture.height);
    canvas.title = name;
    const extraInfo = new Map<string, string>();
    extraInfo.set("Bit Depth", texture.bitDepth.toString());
    return { name, surfaces: [canvas], extraInfo };
}

const MRB_GEOM_MAP: Map<string, string[]> = new Map<string, string[]>([[
    "T_1_DD", ["267DFF0F.mrb", "51C32784.geom"]
]]);

const SHAPE_TEXTURES: Map<string, Map<string, number>> = new Map<string, Map<string, number>>([[
    "T_1_DD", new Map<string, number>([
        ["pCubeShape1", 1],
        ["cloud9Shape", 2],
        ["cloud8Shape", 2],
        ["cloud11Shape", 2],
        ["cloud10Shape", 2],
        ["cloud7Shape", 2],
        ["cloudShape", 2],
        ["cloud6Shape", 2],
        ["cloud5Shape", 2],
        ["cloud4Shape", 2],
        ["cloud3Shape", 2],
        ["cloud2Shape", 2],
        ["l_eyeShape", 5],
        ["r_eyeShape", 5],
        ["body_objShape", 9],
        ["face_objShape", 9],
        ["l_b_fingersShape", 9],
        ["r_b_fingersShape", 9],
        ["l_f_fingersShape", 9],
        ["r_f_fingersShape", 9],
        ["l_hornShape", 9],
        ["r_hornShape", 9],
        ["finShape", 9],
        ["tail_tipShape", 9],
        ["polySurfaceShape27509", 11],
        ["polySurfaceShape27540", 11],
        ["polySurfaceShape27509", 11],
        ["wing_objShape", 13],
        ["enviro_globeShape", 30],
        ["sun_raysShape", 31]
    ])
]]);

const id = "SpyroETD";
const name = "Spyro: Enter the Dragonfly";
const sceneDescs = [
    new SpyroETDScene("T_1_DD", "Transition (Dragonfly Dojo)")
];

export const sceneGroup: SceneGroup = { id, name, sceneDescs };
