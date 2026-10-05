import { ACESFilmicToneMapping, PCFShadowMap, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';

/** Share of the device pixels to render with the pixel look on. The CSS upscale keeps pixels sharp. */
const PIXEL_SCALE = 0.5;

export interface View {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  backend: 'WebGPU' | 'WebGL2';
  togglePixels(): void;
}

/** WebGPU where available, WebGL2 otherwise: one renderer, one material system (TSL/nodes). */
export async function createView(canvas: HTMLCanvasElement): Promise<View> {
  const renderer = new WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  const camera = new PerspectiveCamera(65, 1, 0.1, 1000);
  let pixels = true;

  const resize = () => {
    const ratio = pixels ? PIXEL_SCALE : Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(ratio);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  return {
    renderer,
    scene,
    camera,
    backend,
    togglePixels() {
      pixels = !pixels;
      resize();
    },
  };
}
