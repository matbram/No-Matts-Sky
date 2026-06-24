// ─────────────────────────────────────────────────────────────────────────────
// Mesher worker — runs the generation core OFF the main thread (Step 1).
//
// Chunk generation is NOT in the frame budget (slice spec §7); it happens here,
// and only the finished mesh buffers cross back — by TRANSFER, not copy (master
// plan §8.2). This file is the only place that bridges /core to the DOM Worker
// API; /core itself never imports a worker or Three.js (workers/README.md).
// ─────────────────────────────────────────────────────────────────────────────

import { meshChunk, type MeshJob, type ChunkMesh } from '../core/chunk.ts';

interface IncomingJob extends MeshJob {
  id: number;
}
interface MeshResult {
  id: number;
  mesh: ChunkMesh;
}

// The worker global, typed minimally so we get the (message, transfer[]) overload
// of postMessage without pulling the whole WebWorker lib (which collides with DOM).
interface WorkerScope {
  onmessage: ((e: MessageEvent<IncomingJob>) => void) | null;
  postMessage(message: MeshResult, transfer: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (e: MessageEvent<IncomingJob>): void => {
  const job = e.data;
  const mesh = meshChunk(job.req, job.recipe, job.radius, undefined, undefined, job.skirtDepth ?? 0);
  ctx.postMessage({ id: job.id, mesh }, [
    mesh.positions.buffer,
    mesh.normals.buffer,
    mesh.indices.buffer,
  ]);
};
