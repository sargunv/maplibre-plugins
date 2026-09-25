// Test support: a WebGL2 stand-in for rendering the layers without a GPU. It
// records every call, counts the buffers and vertex arrays alive, and answers
// the queries the layers make (shaders compile, programs link, uniforms
// exist). Each GL constant is a distinct number.

export interface GLCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

export interface FakeGL {
  readonly gl: WebGL2RenderingContext;
  /** Every method call, in order. */
  readonly calls: GLCall[];
  /** Buffers and vertex arrays created and not yet deleted. */
  live(): number;
}

export function fakeGL(width = 800, height = 600): FakeGL {
  const calls: GLCall[] = [];
  const constants = new Map<string, number>();
  let live = 0;
  const create = () => {
    live++;
    return {};
  };
  const remove = (object: unknown) => {
    if (object) live--;
  };
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    isContextLost: () => false,
    getParameter: () => null,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: (_program, name) => ({ name }),
    createBuffer: create,
    createVertexArray: create,
    deleteBuffer: remove,
    deleteVertexArray: remove,
    createShader: () => ({}),
    createProgram: () => ({}),
  };
  const gl = new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== "string") return undefined;
        if (name === "drawingBufferWidth") return width;
        if (name === "drawingBufferHeight") return height;
        if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
          if (!constants.has(name)) constants.set(name, constants.size + 1);
          return constants.get(name);
        }
        return (...args: unknown[]) => {
          calls.push({ name, args });
          return methods[name]?.(...args);
        };
      },
    },
  ) as WebGL2RenderingContext;
  return { gl, calls, live: () => live };
}
