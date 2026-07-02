declare module "heic2any" {
  const heic2any: (opts: {
    blob: Blob;
    toType?: string;
    quality?: number;
    multiple?: boolean;
  }) => Promise<Blob | Blob[]>;
  export default heic2any;
}
