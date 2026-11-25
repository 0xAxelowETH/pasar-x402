// Minimal typings for the parts of opentype.js 2.x that build-brand.ts uses.
declare module "opentype.js" {
  export type PathCommand = {
    type: "M" | "L" | "Q" | "C" | "Z";
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  };
  export interface Path {
    commands: PathCommand[];
  }
  export interface Font {
    getAdvanceWidth(text: string, fontSize: number): number;
    getPath(text: string, x: number, y: number, fontSize: number): Path;
  }
  const opentype: { parse(buffer: ArrayBuffer): Font };
  export default opentype;
}
