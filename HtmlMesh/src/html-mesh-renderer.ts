import { Scene } from "@babylonjs/core/scene";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { HtmlMesh } from "./html-mesh";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { RenderingGroup } from "@babylonjs/core/Rendering/renderingGroup";

import { babylonUnitsToPixels, getCanvasRectAsync } from "./util";
import { Logger, Observer } from "@babylonjs/core";

const _positionUpdateFailMessage =
    "Failed to update html mesh renderer position due to failure to get canvas rect.  HtmlMesh instances may not render correctly";

/**
 * A function that compares two submeshes and returns a number indicating which
 * should be rendered first.
 */
type RenderOrderFunction = (subMeshA: SubMesh, subMeshB: SubMesh) => number;

type RenderLayerElements = {
    container: HTMLElement;
    domElement: HTMLElement;
    cameraElement: HTMLElement;
};

// Returns a function that ensures that HtmlMeshes are rendered before all other meshes.
// Note this will only be applied to group 0.
// If neither mesh is an HtmlMesh, then the default render order is used
// This prevents HtmlMeshes from appearing in front of other meshes when they are behind them
const renderOrderFunc = (
    defaultRenderOrder: RenderOrderFunction
): RenderOrderFunction => {
    return (subMeshA: SubMesh, subMeshB: SubMesh) => {
        const meshA = subMeshA.getMesh();
        const meshB = subMeshB.getMesh();

        // Use property check instead of instanceof since it is less expensive and
        // this will be called many times per frame
        const meshAIsHtmlMesh = (meshA as any)["isHtmlMesh"];
        const meshBIsHtmlMesh = (meshB as any)["isHtmlMesh"];
        if (meshAIsHtmlMesh) {
            return meshBIsHtmlMesh
                ? meshA.absolutePosition.z <= meshB.absolutePosition.z
                    ? 1
                    : -1
                : -1;
        } else {
            return meshBIsHtmlMesh ? 1 : defaultRenderOrder(subMeshA, subMeshB);
        }
    };
};

/**
 * An instance of this is required to render HtmlMeshes in the scene.
 * if using HtmlMeshes, you must not set render order for group 0 using
 * scene.setRenderingOrder.  You must instead pass the compare functions
 * to the HtmlMeshRenderer constructor.  If you do not, then your render
 * order will be overwritten if the HtmlMeshRenderer is created after and
 * the HtmlMeshes will not render correctly (they will appear in front of
 * meshes that are actually in front of them) if the HtmlMeshRenderer is
 * created before.
 */
export class HtmlMeshRenderer {
    _maskRootNode?: TransformNode;
    _containerId?: string;
    _inSceneElements?: RenderLayerElements | null;
    _overlayElements?: RenderLayerElements | null;

    _cache = {
        cameraData: { fov: 0, position: new Vector3(), style: "" },
        htmlMeshData: new WeakMap<object, { style: string }>(),
    };
    _width = 0;
    _height = 0;
    _widthHalf = 0;
    _heightHalf = 0;

    _cameraViewMatrix?: Matrix;
    _projectionMatrix?: Matrix;
    _cameraWorldMatrix?: Matrix;
    _viewport?: Viewport;

    // Create some refs to avoid creating new objects every frame
    _temp = {
        scaleTransform: new Vector3(),
        rotationTransform: new Quaternion(),
        positionTransform: new Vector3(),
        objectMatrix: Matrix.Identity(),
        cameraWorldMatrix: Matrix.Identity(),
        cameraRotationMatrix: Matrix.Identity(),
        cameraWorldMatrixAsArray: new Array(16),
    };

    // Keep track of DPR so we can resize if DPR changes
    // Otherwise the DOM content will scale, but the mesh won't
    _lastDevicePixelRatio = window.devicePixelRatio;

    // Keep track of camera matrix changes so we only update the
    // DOM element styles when necessary
    _cameraMatrixUpdated = true;

    // Keep track of position changes so we only update the DOM element
    // styles when necessary
    _previousCanvasDocumentPosition = {
        top: 0,
        left: 0,
    };

    private _renderObserver: Observer<Scene> | null = null;

    /**
     * Contruct an instance of HtmlMeshRenderer
     * @param {Scene} scene
     * @param options object containing the following optional properties:
     * @param {string} options.containerId an optional id of the parent element for the elements that will be rendered as `HtmlMesh` instances.
     * @param {RenderOrderFunction} options.defaultOpaqueRenderOrder an optional render order function that conforms to the interface of the `opaqueSortCompareFn` as described in the documentation for [`Scene.setRenderingOrder`](https://doc.babylonjs.com/typedoc/classes/BABYLON.Scene#setRenderingOrder) to be used as the opaque sort compare for meshes that are not an instanceof `HtmlMesh` for group 0.
     * @param {RenderOrderFunction} options.defaultAlphaTestRenderOrder an optional render order function that conforms to the interface of the `alphaTestSortCompareFn` as described in the documentation for [`Scene.setRenderingOrder`](https://doc.babylonjs.com/typedoc/classes/BABYLON.Scene#setRenderingOrder) to be used as the alpha test sort compare for meshes that are not an instanceof `HtmlMesh` for group 0.
     * @param {RenderOrderFunction} options.defaultTransparentRenderOrder an optional render order function that conforms to the interface of the `transparentCompareFn` as described in the documentation for [`Scene.setRenderingOrder`](https://doc.babylonjs.com/typedoc/classes/BABYLON.Scene#setRenderingOrder) to be used as the transparent sort compare for meshes that are not an instanceof `HtmlMesh` for group 0.
     * @returns
     */
    constructor(
        scene: Scene,
        {
            parentContainerId = null,
            _containerId = "css-container",
            enableOverlayRender = true,
            defaultOpaqueRenderOrder = RenderingGroup.PainterSortCompare,
            defaultAlphaTestRenderOrder = RenderingGroup.PainterSortCompare,
            defaultTransparentRenderOrder = RenderingGroup.defaultTransparentSortCompare,
        }: {
            parentContainerId?: string | null;
            _containerId?: string;
            defaultOpaqueRenderOrder?: RenderOrderFunction;
            defaultAlphaTestRenderOrder?: RenderOrderFunction;
            defaultTransparentRenderOrder?: RenderOrderFunction;
            enableOverlayRender?: boolean;
        } = {}
    ) {
        // Requires a browser to work.  Only init if we are in a browser
        if (typeof document === "undefined") {
            return;
        }
        this._containerId = _containerId;
        this.init(
            scene,
            parentContainerId,
            enableOverlayRender,
            defaultOpaqueRenderOrder,
            defaultAlphaTestRenderOrder,
            defaultTransparentRenderOrder
        );
    }

    public dispose() {
        if (this._renderObserver) {
            this._renderObserver.remove();
            this._renderObserver = null;
        }

        this._overlayElements?.container.remove();
        this._overlayElements = null;

        this._inSceneElements?.container.remove();
        this._inSceneElements = null;
    }

    protected init(
        scene: Scene,
        parentContainerId: string | null,
        enableOverlayRender: boolean,
        defaultOpaqueRenderOrder: RenderOrderFunction,
        defaultAlphaTestRenderOrder: RenderOrderFunction,
        defaultTransparentRenderOrder: RenderOrderFunction
    ): void {
        // Requires a browser to work.  Only init if we are in a browser
        if (typeof document === "undefined") {
            return;
        }

        // Create the DOM containers
        let parentContainer = parentContainerId
            ? document.getElementById(parentContainerId)
            : document.body;

        if (!parentContainer) {
            parentContainer = document.body;
        }

        // if the container already exists, then remove it
        const inSceneContainerId = `${this._containerId}_in_scene`;
        this._inSceneElements =
            this.createRenderLayerElements(inSceneContainerId);

        parentContainer.insertBefore(
            this._inSceneElements.container,
            parentContainer.firstChild
        );

        if (enableOverlayRender) {
            const overlayContainerId = `${this._containerId}_overlay`;
            this._overlayElements =
                this.createRenderLayerElements(overlayContainerId);
            const zIndex =
                +(scene.getEngine().getRenderingCanvas()!.style.zIndex ?? "0") +
                1;
            this._overlayElements.container.style.zIndex = `${zIndex}`;
            this._overlayElements.container.style.pointerEvents = "none";
            parentContainer.insertBefore(
                this._overlayElements.container,
                parentContainer.firstChild
            );
        }

        // Set the size and resize behavior
        this.setSize(
            scene.getEngine().getRenderWidth(),
            scene.getEngine().getRenderHeight()
        );

        const engine = scene.getEngine();
        const onResize = () => {
            engine.resize();
            this.setSize(
                scene.getEngine().getRenderWidth(),
                scene.getEngine().getRenderHeight()
            );
        };
        const boundOnResize = onResize.bind(this);

        // If the browser is IE11, then we need to use the resize event
        if ("ResizeObserver" in window) {
            const canvas = engine.getRenderingCanvas();
            // Resize if the canvas size changes
            const resizeObserver = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    if (entry.target === canvas) {
                        boundOnResize();
                    }
                }
            });

            resizeObserver.observe(canvas!);
        } else {
            (window as Window).addEventListener("resize", boundOnResize);
        }

        const boundCameraMatrixChanged = this.onCameraMatrixChanged.bind(this);

        const observeCamera = () => {
            const camera = scene.activeCamera;
            if (camera) {
                camera.onProjectionMatrixChangedObservable.add(
                    boundCameraMatrixChanged
                );
                camera.onViewMatrixChangedObservable.add(
                    boundCameraMatrixChanged
                );
            }
        };

        if (scene.activeCamera) {
            observeCamera();
        } else {
            scene.onActiveCameraChanged.add(observeCamera);
        }

        // We need to make sure that HtmlMeshes are rendered before all other meshes
        // so that they don't appear in front of meshes that are actually in front of them
        // Updating the render order isn't ideal, but it is the only way to acheive this
        // The implication is that an app using the HtmlMeshRendered must set the scene render order
        // via the HtmlMeshRendered constructor
        const opaqueRenderOrder = renderOrderFunc(defaultOpaqueRenderOrder);
        const alphaTestRenderOrder = renderOrderFunc(
            defaultAlphaTestRenderOrder
        );
        const transparentRenderOrder = renderOrderFunc(
            defaultTransparentRenderOrder
        );
        scene.setRenderingOrder(
            0,
            opaqueRenderOrder,
            alphaTestRenderOrder,
            transparentRenderOrder
        );

        this._renderObserver = scene.onAfterRenderObservable.add(() => {
            this.render(scene, scene.activeCamera as Camera);
        });
    }

    private createRenderLayerElements(
        containerId: string
    ): RenderLayerElements {
        const existingContainer = document.getElementById(containerId);
        if (existingContainer) {
            existingContainer.remove();
        }
        const container = document.createElement("div");
        container.id = containerId;
        container.style.position = "absolute";
        container.style.width = "100%";
        container.style.height = "100%";
        container.style.zIndex = "-1";

        const domElement = document.createElement("div");
        domElement.style.overflow = "hidden";

        const cameraElement = document.createElement("div");

        cameraElement.style.webkitTransformStyle = "preserve-3d";
        cameraElement.style.transformStyle = "preserve-3d";

        cameraElement.style.pointerEvents = "none";

        domElement.appendChild(cameraElement);
        container.appendChild(domElement);
        return {
            container,
            domElement,
            cameraElement,
        };
    }

    protected getSize(): { width: number; height: number } {
        return {
            width: this._width,
            height: this._height,
        };
    }

    protected setSize(width: number, height: number): void {
        this._width = width;
        this._height = height;
        this._widthHalf = this._width / 2;
        this._heightHalf = this._height / 2;

        const domElements = [
            this._inSceneElements!.domElement,
            this._overlayElements!.domElement,
            this._inSceneElements!.cameraElement,
            this._overlayElements!.cameraElement,
        ];
        domElements.forEach((dom) => {
            if (dom) {
                dom.style.width = `${width}px`;
                dom.style.height = `${height}px`;
            }
        });
    }

    // prettier-ignore
    protected getCameraCSSMatrix(matrix: Matrix): string {
        const elements = matrix.m;
        return `matrix3d(${
            this.epsilon( elements[0] )
        },${
            this.epsilon( - elements[1] )
        },${
            this.epsilon( elements[2] )
        },${
            this.epsilon( elements[3] )
        },${
            this.epsilon( elements[4] )
        },${
            this.epsilon( - elements[5] )
        },${
            this.epsilon( elements[6] )
        },${
            this.epsilon( elements[7] )
        },${
            this.epsilon( elements[8] )
        },${
            this.epsilon( - elements[9] )
        },${
            this.epsilon( elements[10] )
        },${
            this.epsilon( elements[11] )
        },${
            this.epsilon( elements[12] )
        },${
            this.epsilon( - elements[13] )
        },${
            this.epsilon( elements[14] )
        },${
            this.epsilon( elements[15] )
        })`;
    }

    // Convert a Babylon world matrix to a CSS matrix
    // This also handles conversion from BJS left handed coords
    // to CSS right handed coords
    // prettier-ignore
    protected getHtmlContentCSSMatrix(matrix: Matrix): string {
        const elements = matrix.m;
        const matrix3d = `matrix3d(${
            this.epsilon( elements[0] )
        },${
            this.epsilon( elements[1] )
        },${
            this.epsilon( - elements[2] )
        },${
            this.epsilon( elements[3] )
        },${
            this.epsilon( - elements[4] )
        },${
            this.epsilon( - elements[5] )
        },${
            this.epsilon( elements[6] )
        },${
            this.epsilon( - elements[7] )
        },${
            this.epsilon( - elements[8] )
        },${
            this.epsilon( - elements[9] )
        },${
            this.epsilon( elements[10] )
        },${
            this.epsilon( elements[11] )
        },${
            this.epsilon( elements[12] )
        },${
            this.epsilon( elements[13] )
        },${
            this.epsilon( elements[14] )
        },${
            this.epsilon( elements[15] )
        })`;
        return matrix3d;
    }

    protected getTransformationMatrix(htmlMesh: HtmlMesh): Matrix {
        // Get the camera world matrix
        // Make sure the camera world matrix is up to date
        if (!this._cameraWorldMatrix) {
            this._cameraWorldMatrix = htmlMesh
                .getScene()
                .activeCamera?.getWorldMatrix();
        }
        if (!this._cameraWorldMatrix) {
            return Matrix.Identity();
        }

        const objectWorldMatrix = htmlMesh.getWorldMatrix();

        // Scale the object matrix by the base scale factor for the mesh
        // which is the ratio of the mesh width/height to the renderer
        // width/height divided by the babylon units to pixels ratio
        let widthScaleFactor = 1;
        let heightScaleFactor = 1;
        if (htmlMesh.sourceWidth && htmlMesh.sourceHeight) {
            widthScaleFactor =
                htmlMesh.width! / (htmlMesh.sourceWidth / babylonUnitsToPixels);
            heightScaleFactor =
                htmlMesh.height! /
                (htmlMesh.sourceHeight / babylonUnitsToPixels);
        }

        // Apply the scale to the object's world matrix.  Note we aren't scaling
        // the object, just getting a matrix as though it were scaled, so we can
        // scale the content
        const scaleTransform = this._temp.scaleTransform;
        const rotationTransform = this._temp.rotationTransform;
        const positionTransform = this._temp.positionTransform;
        const scaledAndTranslatedObjectMatrix = this._temp.objectMatrix;

        objectWorldMatrix.decompose(
            scaleTransform,
            rotationTransform,
            positionTransform
        );
        scaleTransform.x *= widthScaleFactor;
        scaleTransform.y *= heightScaleFactor;

        Matrix.ComposeToRef(
            scaleTransform,
            rotationTransform,
            positionTransform,
            scaledAndTranslatedObjectMatrix
        );

        // Adjust translation values to be from camera vs world origin
        // Note that we are also adjusting these values to be pixels vs Babylon units
        const position = htmlMesh.getAbsolutePosition();
        scaledAndTranslatedObjectMatrix.setRowFromFloats(
            3,
            (-this._cameraWorldMatrix.m[12] + position.x) *
                babylonUnitsToPixels,
            (-this._cameraWorldMatrix.m[13] + position.y) *
                babylonUnitsToPixels,
            (this._cameraWorldMatrix.m[14] - position.z) * babylonUnitsToPixels,
            this._cameraWorldMatrix.m[15] * 0.00001 * babylonUnitsToPixels
        );

        // Adjust other values to be pixels vs Babylon units
        scaledAndTranslatedObjectMatrix.multiplyAtIndex(
            3,
            babylonUnitsToPixels
        );
        scaledAndTranslatedObjectMatrix.multiplyAtIndex(
            7,
            babylonUnitsToPixels
        );
        scaledAndTranslatedObjectMatrix.multiplyAtIndex(
            11,
            babylonUnitsToPixels
        );

        return scaledAndTranslatedObjectMatrix;
    }

    protected renderHtmlMesh(htmlMesh: HtmlMesh) {
        if (!htmlMesh.element) {
            // nothing to render, so bail
            return;
        }

        // We need to ensure html mesh data is initialized before
        // computing the base scale factor
        let htmlMeshData = this._cache.htmlMeshData.get(htmlMesh);
        if (!htmlMeshData) {
            htmlMeshData = { style: "" };
            this._cache.htmlMeshData.set(htmlMesh, htmlMeshData);
        }

        const cameraElement = htmlMesh._isCanvasOverlay
            ? this._overlayElements?.cameraElement
            : this._inSceneElements?.cameraElement;

        if (htmlMesh.element.parentNode !== cameraElement) {
            cameraElement!.appendChild(htmlMesh.element);
        }

        // If the htmlMesh content has changed, update the base scale factor
        if (htmlMesh.requiresUpdate) {
            this.updateBaseScaleFactor(htmlMesh);
        }

        // Get the transformation matrix for the html mesh
        const scaledAndTranslatedObjectMatrix =
            this.getTransformationMatrix(htmlMesh);

        const style = `translate(-50%, -50%) ${this.getHtmlContentCSSMatrix(
            scaledAndTranslatedObjectMatrix
        )}`;

        if (htmlMeshData.style !== style) {
            htmlMesh.element.style.webkitTransform = style;
            htmlMesh.element.style.transform = style;
        }

        htmlMesh.markAsUpdated();
    }

    protected render = (scene: Scene, camera: Camera) => {
        let needsUpdate = false;

        // Update the container position and size if necessary
        this.updateContainerPositionIfNeeded(scene);

        // Check for a camera change
        if (this._cameraMatrixUpdated) {
            this._cameraMatrixUpdated = false;
            needsUpdate = true;
        }

        // If the camera position has changed, then we also need to update
        if (
            camera.position.x !== this._cache.cameraData.position.x ||
            camera.position.y !== this._cache.cameraData.position.y ||
            camera.position.z !== this._cache.cameraData.position.z
        ) {
            this._cache.cameraData.position.copyFrom(camera.position);
            needsUpdate = true;
        }

        // Check for a dpr change
        if (window.devicePixelRatio !== this._lastDevicePixelRatio) {
            this._lastDevicePixelRatio = window.devicePixelRatio;
            Logger.Log("In render - dpr changed: ", this._lastDevicePixelRatio);
            needsUpdate = true;
        }

        // Check if any meshes need to be updated
        const meshesNeedingUpdate = scene.meshes.filter(
            (mesh) =>
                (mesh as any)["isHtmlMesh"] &&
                (needsUpdate || (mesh as HtmlMesh).requiresUpdate)
        );
        needsUpdate = needsUpdate || meshesNeedingUpdate.length > 0;

        if (!needsUpdate) {
            return;
        }

        // Get a projection matrix for the camera
        const projectionMatrix = camera.getProjectionMatrix();
        const fov = projectionMatrix.m[5] * this._heightHalf;

        if (this._cache.cameraData.fov !== fov) {
            if (camera.mode == Camera.PERSPECTIVE_CAMERA) {
                [
                    this._overlayElements?.domElement,
                    this._inSceneElements?.domElement,
                ].forEach((el) => {
                    if (el) {
                        el.style.webkitPerspective = fov + "px";
                        el.style.perspective = fov + "px";
                    }
                });
            } else {
                [
                    this._overlayElements?.domElement,
                    this._inSceneElements?.domElement,
                ].forEach((el) => {
                    if (el) {
                        el.style.webkitPerspective = "";
                        el.style.perspective = "";
                    }
                });
            }
            this._cache.cameraData.fov = fov;
        }

        // Get the CSS matrix for the camera (which will include any camera rotation)
        if (camera.parent === null) {
            camera.computeWorldMatrix();
        }

        const cameraMatrixWorld = this._temp.cameraWorldMatrix;
        cameraMatrixWorld.copyFrom(camera.getWorldMatrix());
        const cameraRotationMatrix = this._temp.cameraRotationMatrix;
        cameraMatrixWorld
            .getRotationMatrix()
            .transposeToRef(cameraRotationMatrix);

        const cameraMatrixWorldAsArray = this._temp.cameraWorldMatrixAsArray;
        cameraMatrixWorld.copyToArray(cameraMatrixWorldAsArray);

        cameraMatrixWorldAsArray[1] = cameraRotationMatrix.m[1];
        cameraMatrixWorldAsArray[2] = -cameraRotationMatrix.m[2];
        cameraMatrixWorldAsArray[4] = -cameraRotationMatrix.m[4];
        cameraMatrixWorldAsArray[6] = -cameraRotationMatrix.m[6];
        cameraMatrixWorldAsArray[8] = -cameraRotationMatrix.m[8];
        cameraMatrixWorldAsArray[9] = -cameraRotationMatrix.m[9];

        Matrix.FromArrayToRef(cameraMatrixWorldAsArray, 0, cameraMatrixWorld);

        const cameraCSSMatrix =
            // "translateZ(" +
            // fov +
            // "px)" +
            this.getCameraCSSMatrix(cameraMatrixWorld);
        const style = cameraCSSMatrix; //+
        // "translate(" +
        // this._widthHalf +
        // "px," +
        // this._heightHalf +
        // "px)";

        if (this._cache.cameraData.style !== style) {
            [
                this._inSceneElements?.cameraElement,
                this._overlayElements?.cameraElement,
            ].forEach((el) => {
                if (el) {
                    el.style.webkitTransform = style;
                    el.style.transform = style;
                }
            });
            this._cache.cameraData.style = style;
        }

        // _Render objects if necessary
        meshesNeedingUpdate.forEach((mesh) => {
            this.renderHtmlMesh(mesh as HtmlMesh);
        });
    };

    protected updateBaseScaleFactor(htmlMesh: HtmlMesh) {
        // Get screen width and height
        let screenWidth = this._width;
        let screenHeight = this._height;

        // Calculate aspect ratios
        const htmlMeshAspectRatio =
            (htmlMesh.width || 1) / (htmlMesh.height || 1);
        const screenAspectRatio = screenWidth / screenHeight;

        // Adjust screen dimensions based on aspect ratios
        if (htmlMeshAspectRatio > screenAspectRatio) {
            // If the HTML mesh is wider relative to its height than the screen, adjust the screen width
            screenWidth = screenHeight * htmlMeshAspectRatio;
        } else {
            // If the HTML mesh is taller relative to its width than the screen, adjust the screen height
            screenHeight = screenWidth / htmlMeshAspectRatio;
        }

        // Set content to fill screen so we get max resolution when it is shrunk to fit the mesh
        htmlMesh.setContentSizePx(screenWidth, screenHeight);
    }

    protected async updateContainerPositionIfNeeded(scene: Scene) {
        // Determine if the canvas has moved on the screen
        const canvasRect = await getCanvasRectAsync(scene);

        // canvas rect may be null if layout not complete
        if (!canvasRect) {
            Logger.Warn(_positionUpdateFailMessage);
            return;
        }
        const scrollTop = window.scrollY;
        const scrollLeft = window.scrollX;
        const canvasDocumentTop = canvasRect.top + scrollTop;
        const canvasDocumentLeft = canvasRect.left + scrollLeft;

        if (
            this._previousCanvasDocumentPosition.top !== canvasDocumentTop ||
            this._previousCanvasDocumentPosition.left !== canvasDocumentLeft
        ) {
            this._previousCanvasDocumentPosition.top = canvasDocumentTop;
            this._previousCanvasDocumentPosition.left = canvasDocumentLeft;

            [
                this._inSceneElements?.container,
                this._overlayElements?.container,
            ].forEach((container) => {
                if (!container) {
                    return;
                }
                // set the top and left of the css container to match the canvas
                const containerParent = container.offsetParent as HTMLElement;
                const parentRect = containerParent.getBoundingClientRect();
                const parentDocumentTop = parentRect.top + scrollTop;
                const parentDocumentLeft = parentRect.left + scrollLeft;

                const ancestorMarginsAndPadding =
                    this.getAncestorMarginsAndPadding(containerParent);

                // Add the body margin
                const bodyStyle = window.getComputedStyle(document.body);
                const bodyMarginTop = parseInt(bodyStyle.marginTop, 10);
                const bodyMarginLeft = parseInt(bodyStyle.marginLeft, 10);

                container.style.top = `${
                    canvasDocumentTop -
                    parentDocumentTop -
                    ancestorMarginsAndPadding.marginTop +
                    ancestorMarginsAndPadding.paddingTop +
                    bodyMarginTop
                }px`;
                container.style.left = `${
                    canvasDocumentLeft -
                    parentDocumentLeft -
                    ancestorMarginsAndPadding.marginLeft +
                    ancestorMarginsAndPadding.paddingLeft +
                    bodyMarginLeft
                }px`;
            });
        }
    }

    protected onCameraMatrixChanged = (camera: Camera) => {
        this._cameraViewMatrix = camera.getViewMatrix();
        this._projectionMatrix = camera.getProjectionMatrix();
        this._cameraWorldMatrix = camera.getWorldMatrix();
        this._viewport = camera.viewport;
        this._cameraMatrixUpdated = true;
    };

    private epsilon(value: number) {
        return Math.abs(value) < 1e-10 ? 0 : value;
    }

    // Get total margins and padding for an element, excluding the body and document margins
    private getAncestorMarginsAndPadding(element: HTMLElement) {
        let marginTop = 0;
        let marginLeft = 0;
        let paddingTop = 0;
        let paddingLeft = 0;

        while (
            element &&
            element !== document.body &&
            element !== document.documentElement
        ) {
            const style = window.getComputedStyle(element);
            marginTop += parseInt(style.marginTop, 10);
            marginLeft += parseInt(style.marginLeft, 10);
            paddingTop += parseInt(style.paddingTop, 10);
            paddingLeft += parseInt(style.paddingLeft, 10);
            element = element.offsetParent as HTMLElement;
        }

        return { marginTop, marginLeft, paddingTop, paddingLeft };
    }
}
