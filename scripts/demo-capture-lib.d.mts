export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Frame {
  at: number;
  file: string;
}

export interface Mark {
  name: string;
  at: number;
  boxes: Record<string, Box>;
}

export interface Click {
  at: number;
  x: number;
  y: number;
}

export interface Manifest {
  version: 1;
  viewport: { width: number; height: number };
  scale: number;
  frames: Frame[];
  marks: Mark[];
  clicks: Click[];
}

export function toBox(
  box: Box | null | undefined,
  name: string,
  viewport: { width: number; height: number }
): Box;
export function unionBox(boxes: Box[]): Box;
export function clickPoint(box: Box): { x: number; y: number };
export function frameAt(frames: Frame[], at: number): Frame;
export function manifestProblems(manifest: Manifest): string[];
export function reviewFilter(boxes: Record<string, Box>, scale: number): string;
