declare module "unzipper" {
  export type Entry = {
    path: string;
    type: "File" | "Directory";
    uncompressedSize: number;
    buffer(): Promise<Buffer>;
  };
  export const Open: {
    file(path: string): Promise<{ files: Entry[] }>;
  };
}
