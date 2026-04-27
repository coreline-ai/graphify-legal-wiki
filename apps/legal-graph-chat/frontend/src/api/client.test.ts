import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorMessageFromPayload,
  disposeGraphBinaryWorker,
  getFullGraph3dWithWorker,
  getFullGraphEdgeTileBinaryWithPersistentWorker,
  getFullGraphEdgeTileBinaryWithWorker,
  getFullGraphNodesBinaryWithWorker,
} from './client';
import { decodeGraphNodesBinary } from './graphBinaryWorker';
import type { EdgeTileResponse, GraphBinaryWorkerStats, GraphPayloadDTO } from './types';

afterEach(() => {
  disposeGraphBinaryWorker();
  vi.unstubAllGlobals();
});

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function f32(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function i32(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return bytes;
}

function lengthPrefixedUtf8(values: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts = values.flatMap((value) => {
    const encoded = encoder.encode(value);
    return [u32(encoded.byteLength), encoded];
  });
  return concatBytes(parts);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.byteLength;
  });
  return out;
}

function arrayBufferFrom(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function buildGf3nFixture(): ArrayBuffer {
  const ids = lengthPrefixedUtf8(['a', 'b']);
  const header = {
    format: 'graphify.full3d.nodes.binary.v1',
    graph: 'precedent-kr',
    edge_mode: 'hidden',
    layout_mode: 'spherical',
    node_count: 2,
    arrays: {
      positions: { type: 'float32', components: 3, count: 2 },
      sizes: { type: 'float32', components: 1, count: 2 },
      degrees: { type: 'uint32', components: 1, count: 2 },
      communities: { type: 'int32', components: 1, count: 2 },
      flags: { type: 'uint8', components: 1, count: 2 },
      ids: { encoding: 'length-prefixed-utf8', count: 2, byte_length: ids.byteLength },
    },
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  return arrayBufferFrom(concatBytes([
    new Uint8Array([0x47, 0x46, 0x33, 0x4e, 0x01]),
    u32(headerBytes.byteLength),
    headerBytes,
    f32([1, 2, 3, 4, 5, 6]),
    f32([7, 8]),
    u32(10),
    u32(11),
    i32([3, 4]),
    new Uint8Array([3, 0]),
    ids,
  ]));
}

describe('apiErrorMessageFromPayload', () => {
  it('formats FastAPI validation detail arrays without [object Object]', () => {
    const message = apiErrorMessageFromPayload(
      {
        detail: [
          {
            type: 'string_too_short',
            loc: ['body', 'question'],
            msg: 'String should have at least 1 character',
            input: '',
          },
        ],
      },
      'Unprocessable Entity',
    );

    expect(message).toBe('body.question: String should have at least 1 character');
    expect(message).not.toContain('[object Object]');
  });

  it('falls back to JSON for arbitrary object errors', () => {
    const message = apiErrorMessageFromPayload(
      { detail: { code: 'GRAPH_BAD_PARAM', value: { graph: 'bad' } } },
      'Bad Request',
    );

    expect(message).toContain('GRAPH_BAD_PARAM');
    expect(message).not.toContain('[object Object]');
  });

  it('falls back to normal JSON fetch when Worker is unavailable', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ nodes: [{ id: 'a', label: 'A' }], edges: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('Worker', undefined);
    vi.stubGlobal('fetch', fetchMock);

    const payload = await getFullGraph3dWithWorker({ edge_mode: 'hidden' }, undefined, 'legalize-kr');
    const calledUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);

    expect(payload.nodes).toHaveLength(1);
    expect(payload.nodes[0].id).toBe('a');
    expect(calledUrl).toContain('/graph/full-3d');
    expect(calledUrl).toContain('graph=legalize-kr');
  });

  it('falls back to JSON full graph nodes when persistent binary Worker is unavailable', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ nodes: [{ id: 'a', label: 'A' }], edges: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('Worker', undefined);
    vi.stubGlobal('fetch', fetchMock);

    const payload = await getFullGraphNodesBinaryWithWorker({ node_limit: 1 }, undefined, 'precedent-kr');
    const calledUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);

    expect(payload.nodes).toHaveLength(1);
    expect(calledUrl).toContain('/graph/full-3d');
    expect(calledUrl).not.toContain('/nodes/binary');
    expect(calledUrl).toContain('edge_mode=hidden');
    expect(calledUrl).toContain('graph=precedent-kr');
  });

  it('falls back to JSON edge tiles when binary Worker is unavailable', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          graph: 'precedent-kr',
          edge_mode: 'all',
          tile: 0,
          tile_size: 2,
          returned_edges: 1,
          total_edges: 3,
          has_more: true,
          edges: [{ source: 'a', target: 'b', metadata: { lod_layer: 'context' } }],
          warnings: [],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('Worker', undefined);
    vi.stubGlobal('fetch', fetchMock);

    const payload = await getFullGraphEdgeTileBinaryWithWorker({ edge_mode: 'all', tile: 0, tile_size: 2 }, ['a', 'b'], undefined, 'precedent-kr');
    const calledUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);

    expect(payload.edges).toHaveLength(1);
    expect(payload.edges[0].source).toBe('a');
    expect(calledUrl).toContain('/graph/full-3d/edge-tile');
    expect(calledUrl).toContain('graph=precedent-kr');
  });

  it('falls back to JSON edge tiles when persistent binary Worker is unavailable', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          graph: 'precedent-kr',
          edge_mode: 'all',
          tile: 0,
          tile_size: 2,
          returned_edges: 1,
          total_edges: 3,
          has_more: true,
          edges: [{ source: 'a', target: 'b', metadata: { lod_layer: 'context' } }],
          warnings: [],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('Worker', undefined);
    vi.stubGlobal('fetch', fetchMock);

    const payload = await getFullGraphEdgeTileBinaryWithPersistentWorker({ edge_mode: 'all', tile: 0, tile_size: 2 }, undefined, 'precedent-kr');
    const calledUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);

    expect(payload.edges).toHaveLength(1);
    expect(calledUrl).toContain('/graph/full-3d/edge-tile');
    expect(calledUrl).not.toContain('/binary');
    expect(calledUrl).toContain('graph=precedent-kr');
  });

  it('posts persistent worker messages without resending nodeIds for edge tiles', async () => {
    const nodePayload: GraphPayloadDTO = { nodes: [{ id: 'a', label: 'a' }], edges: [], edge_mode: 'hidden' };
    const tilePayload: EdgeTileResponse = {
      graph: 'precedent-kr',
      edge_mode: 'all',
      tile: 1,
      tile_size: 10,
      returned_edges: 1,
      total_edges: 1,
      has_more: false,
      edges: [{ source: 'a', target: 'b' }],
      warnings: [],
    };
    const stats: GraphBinaryWorkerStats = {
      initialized: true,
      graph: 'precedent-kr',
      node_count: 1,
      payload_bytes: 100,
      edge_tile_count: 1,
    };
    const instances: Array<{ messages: unknown[]; onmessage: ((event: MessageEvent<unknown>) => void) | null; terminate: () => void }> = [];

    class FakeWorker {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      messages: unknown[] = [];

      constructor() {
        instances.push(this);
      }

      postMessage(message: { id: string; type: string }) {
        this.messages.push(message);
        if (message.type === 'INIT_GRAPH_NODES_BINARY') {
          this.onmessage?.({
            data: { id: message.id, type: 'INIT_GRAPH_NODES_BINARY_RESULT', ok: true, payload: nodePayload, stats },
          } as MessageEvent<unknown>);
        }
        if (message.type === 'LOAD_EDGE_TILE_BINARY') {
          this.onmessage?.({
            data: { id: message.id, type: 'LOAD_EDGE_TILE_BINARY_RESULT', ok: true, payload: tilePayload, stats },
          } as MessageEvent<unknown>);
        }
      }

      terminate() {}
    }

    vi.stubGlobal('Worker', FakeWorker);

    await expect(getFullGraphNodesBinaryWithWorker({ node_limit: 2 }, undefined, 'precedent-kr')).resolves.toBe(nodePayload);
    await expect(
      getFullGraphEdgeTileBinaryWithPersistentWorker(
        { edge_mode: 'all', confirm_all_edges: true, tile: 1, tile_size: 10 },
        undefined,
        'precedent-kr',
      ),
    ).resolves.toBe(tilePayload);

    expect(instances).toHaveLength(1);
    expect(instances[0].messages[0]).toMatchObject({
      type: 'INIT_GRAPH_NODES_BINARY',
      path: '/graph/full-3d/nodes/binary',
      params: expect.objectContaining({ graph: 'precedent-kr', edge_mode: 'hidden', node_limit: 2 }),
    });
    expect(instances[0].messages[1]).toMatchObject({
      type: 'LOAD_EDGE_TILE_BINARY',
      path: '/graph/full-3d/edge-tile/binary',
      params: expect.objectContaining({ graph: 'precedent-kr', tile: 1, tile_size: 10 }),
    });
    expect(instances[0].messages[1]).not.toHaveProperty('nodeIds');
  });
});

describe('decodeGraphNodesBinary', () => {
  it('decodes GF3N node payloads into graph nodes and persistent stats', () => {
    const decoded = decodeGraphNodesBinary(buildGf3nFixture(), { graph: 'precedent-kr' });

    expect(decoded.payload.nodes).toHaveLength(2);
    expect(decoded.payload.nodes[0]).toMatchObject({
      id: 'a',
      x: 1,
      y: 2,
      z: 3,
      size: 7,
      degree: 10,
      community: 3,
      is_hub: true,
    });
    expect(decoded.state.nodeIndex.get('b')).toBe(1);
    expect(decoded.stats).toMatchObject({
      initialized: true,
      graph: 'precedent-kr',
      node_count: 2,
      payload_bytes: buildGf3nFixture().byteLength,
    });
  });
});
