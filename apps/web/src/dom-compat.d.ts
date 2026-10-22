// The DOM lib types SubtleCrypto.digest for ArrayBuffer-backed views only, while the workspace
// packages (domain/catalogue seed) pass Uint8Array<ArrayBufferLike>. Adding an overload makes both
// compile in this package's program, which needs the DOM lib for client components.
interface SubtleCrypto {
  digest(
    algorithm: AlgorithmIdentifier,
    data: ArrayBufferView<ArrayBufferLike> | ArrayBufferLike,
  ): Promise<ArrayBuffer>;
}
