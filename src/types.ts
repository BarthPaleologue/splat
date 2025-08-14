export interface Camera {
  id: number;
  img_name: string;
  width: number;
  height: number;
  position: [number, number, number];
  rotation: [[number, number, number], [number, number, number], [number, number, number]];
  fy: number;
  fx: number;
}

export type Matrix4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
];

export type Vector3 = [number, number, number];

export interface WorkerMessage {
  ply?: ArrayBuffer;
  buffer?: ArrayBuffer;
  vertexCount?: number;
  view?: Matrix4;
  save?: boolean;
}

export interface WorkerResponse {
  buffer?: ArrayBuffer;
  save?: boolean;
  texdata?: Uint32Array;
  texwidth?: number;
  texheight?: number;
  depthIndex?: Uint32Array;
  viewProj?: Matrix4;
  vertexCount?: number;
}

export interface SplatData {
  position: Vector3;
  scale: Vector3;
  color: [number, number, number, number];
  rotation: [number, number, number, number];
}
