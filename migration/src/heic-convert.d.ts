declare module "heic-convert" {
  export default function convert(opts: { buffer: Buffer; format: "JPEG" | "PNG"; quality?: number }): Promise<ArrayBuffer>;
}
declare module "bmp-js" {
  export function decode(buf: Buffer): { width: number; height: number; data: Buffer };
}
