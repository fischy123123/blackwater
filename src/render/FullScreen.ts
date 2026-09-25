import * as THREE from 'three';

/** A single oversized triangle covering the viewport. */
export class FullScreenQuad {
  private static geo: THREE.BufferGeometry | null = null;
  private static cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  mesh: THREE.Mesh;
  constructor(material?: THREE.Material) {
    if (!FullScreenQuad.geo) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
      FullScreenQuad.geo = g;
    }
    this.mesh = new THREE.Mesh(FullScreenQuad.geo, material);
    this.mesh.frustumCulled = false;
  }
  get material() {
    return this.mesh.material as THREE.Material;
  }
  set material(m: THREE.Material) {
    this.mesh.material = m;
  }
  render(renderer: THREE.WebGLRenderer) {
    renderer.render(this.mesh, FullScreenQuad.cam);
  }
}

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export function fsMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, defines?: Record<string, string | number>) {
  return new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader,
    uniforms,
    defines: defines ?? {},
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
}
