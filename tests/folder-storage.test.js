const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FILE_FORMAT,
  FILE_NAME,
  MIRROR_KEY,
  SYNC_KEY,
  createFolderStorage,
} = require("../folder-storage.js");

class MemoryLocalStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }
  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

function createHandleStore(initialHandle = null) {
  let handle = initialHandle;
  return {
    async get() {
      return handle;
    },
    async put(_key, value) {
      handle = value;
    },
    async delete() {
      handle = null;
    },
  };
}

function notFoundError() {
  return new DOMException("No existe", "NotFoundError");
}

function createDirectory(options = {}) {
  const files = new Map(Object.entries(options.files || {}));
  const directories = new Map();
  const writes = [];
  const handle = {
    name: options.name || "Estudio",
    permission: options.permission || "granted",
    files,
    writes,
    async queryPermission() {
      return this.permission;
    },
    async requestPermission() {
      if (this.permission === "prompt") this.permission = options.requestResult || "granted";
      return this.permission;
    },
    async isSameEntry(other) {
      return other === this;
    },
    async getFileHandle(name, settings = {}) {
      if (!files.has(name) && !settings.create) throw notFoundError();
      if (!files.has(name)) files.set(name, "");
      return {
        async getFile() {
          return { text: async () => files.get(name) };
        },
        async createWritable() {
          let pending = files.get(name);
          return {
            async write(value) {
              if (options.writeError) throw options.writeError;
              pending = String(value);
              if (options.writeDelay) await new Promise((resolve) => setTimeout(resolve, options.writeDelay));
            },
            async close() {
              files.set(name, pending);
              writes.push(pending);
            },
            async abort() {},
          };
        },
      };
    },
    async getDirectoryHandle(name, settings = {}) {
      if (!directories.has(name) && !settings.create) throw notFoundError();
      if (!directories.has(name)) directories.set(name, createDirectory({ name }));
      return directories.get(name);
    },
  };
  handle.directories = directories;
  return handle;
}

function state(name = "Álgebra") {
  return {
    version: 1,
    subjects: [{ id: name, name }],
    ring: [name],
    weightSignature: "",
  };
}

function documentFor(value) {
  return JSON.stringify({
    format: FILE_FORMAT,
    version: 1,
    savedAt: "2026-07-31T00:00:00.000Z",
    state: value,
  });
}

function makeStorage({ directory, local, store, pickDirectory } = {}) {
  return createFolderStorage({
    localStorage: local || new MemoryLocalStorage(),
    handleStore: store || createHandleStore(directory),
    pickDirectory: pickDirectory || (directory ? async () => directory : null),
    now: () => new Date("2026-07-31T12:00:00.000Z"),
  });
}

test("solicita selección cuando todavía no existe un handle", async () => {
  const storage = makeStorage({ store: createHandleStore(), pickDirectory: async () => null });
  assert.equal((await storage.initialize(state())).status, "needs-selection");
});

test("crea apriori.json migrando el espejo cuando la carpeta está vacía", async () => {
  const fallback = state("Lógica");
  const local = new MemoryLocalStorage({ [MIRROR_KEY]: JSON.stringify(fallback) });
  const directory = createDirectory();
  const storage = makeStorage({ directory, local, store: createHandleStore() });
  const result = await storage.selectDirectory(state("Otra"));
  assert.equal(result.status, "ready");
  assert.deepEqual(result.state, fallback);
  assert.deepEqual(JSON.parse(directory.files.get(FILE_NAME)).state, fallback);
});

test("el archivo existente prevalece sobre el espejo del navegador", async () => {
  const folderState = state("Probabilidad");
  const localState = state("Local");
  const directory = createDirectory({ files: { [FILE_NAME]: documentFor(folderState) } });
  const local = new MemoryLocalStorage({ [MIRROR_KEY]: JSON.stringify(localState) });
  const storage = makeStorage({ directory, local, store: createHandleStore() });
  const result = await storage.selectDirectory(localState);
  assert.deepEqual(result.state, folderState);
  assert.deepEqual(JSON.parse(local.getItem(MIRROR_KEY)), folderState);
});

test("acepta el estado v2 del planificador genérico", async () => {
  const value = {
    version: 2,
    settings: { cycleSize: 20, urgencyK: 14 },
    subjects: [{ id: "A", name: "Genérica", active: true, baseWeight: 1, classDays: [1, 3], evaluations: [] }],
    ring: Array(20).fill("A"),
    weightSignature: "",
  };
  const directory = createDirectory({ files: { [FILE_NAME]: documentFor(value) } });
  const result = await makeStorage({ directory }).initialize(state());
  assert.equal(result.status, "ready");
  assert.deepEqual(result.state, value);
});

test("reutiliza automáticamente un handle con permiso concedido", async () => {
  const folderState = state("Datos");
  const directory = createDirectory({ files: { [FILE_NAME]: documentFor(folderState) } });
  const storage = makeStorage({ directory });
  const result = await storage.initialize(state());
  assert.equal(result.status, "ready");
  assert.deepEqual(result.state, folderState);
});

test("sólo solicita permiso cuando el handle guardado devuelve prompt", async () => {
  const directory = createDirectory({ permission: "prompt", requestResult: "granted" });
  const storage = makeStorage({ directory });
  const initial = await storage.initialize(state());
  assert.equal(initial.status, "needs-permission");
  const authorized = await storage.authorize(state());
  assert.equal(authorized.status, "ready");
  assert.equal(directory.permission, "granted");
});

test("recupera primero un espejo dirty de una carpeta ya vinculada", async () => {
  const folderState = state("Anterior");
  const pendingState = state("Pendiente");
  const directory = createDirectory({ files: { [FILE_NAME]: documentFor(folderState) } });
  const local = new MemoryLocalStorage({
    [MIRROR_KEY]: JSON.stringify(pendingState),
    [SYNC_KEY]: JSON.stringify({ linked: true, dirty: true, directoryName: directory.name }),
  });
  const storage = makeStorage({ directory, local });
  const result = await storage.initialize(state());
  assert.equal(result.source, "pending-mirror");
  assert.deepEqual(result.state, pendingState);
  assert.deepEqual(JSON.parse(directory.files.get(FILE_NAME)).state, pendingState);
  assert.equal(JSON.parse(local.getItem(SYNC_KEY)).dirty, false);
});

test("un JSON inválido bloquea sin sobrescribir el archivo", async () => {
  const original = "{esto no es json";
  const directory = createDirectory({ files: { [FILE_NAME]: original } });
  const storage = makeStorage({ directory });
  const result = await storage.initialize(state());
  assert.equal(result.status, "invalid-file");
  assert.equal(directory.files.get(FILE_NAME), original);
});

test("un documento con state incompatible tampoco se sobrescribe", async () => {
  const original = JSON.stringify({
    format: FILE_FORMAT,
    version: 1,
    savedAt: "2026-07-31T00:00:00.000Z",
    state: { version: 1, subjects: "incorrecto", ring: [] },
  });
  const directory = createDirectory({ files: { [FILE_NAME]: original } });
  const storage = makeStorage({ directory });
  assert.equal((await storage.initialize(state())).status, "invalid-file");
  assert.equal(directory.files.get(FILE_NAME), original);
});

test("mantiene bloqueada una carpeta cuyo permiso fue denegado", async () => {
  const directory = createDirectory({ permission: "denied" });
  const storage = makeStorage({ directory });
  assert.equal((await storage.initialize(state())).status, "needs-permission");
  assert.equal((await storage.authorize(state())).status, "needs-permission");
});

test("informa si el handle apunta a una carpeta que ya no está disponible", async () => {
  const directory = createDirectory();
  directory.getFileHandle = async () => {
    throw notFoundError();
  };
  const storage = makeStorage({ directory });
  assert.equal((await storage.initialize(state())).status, "storage-error");
});

test("cancelar el selector no altera la vinculación", async () => {
  const cancelled = new DOMException("Cancelado", "AbortError");
  const storage = makeStorage({
    store: createHandleStore(),
    pickDirectory: async () => {
      throw cancelled;
    },
  });
  assert.equal((await storage.selectDirectory(state())).status, "cancelled");
  assert.equal((await storage.initialize(state())).status, "needs-selection");
});

test("informa cuando el navegador no ofrece selector de carpetas", async () => {
  const storage = createFolderStorage({
    localStorage: new MemoryLocalStorage(),
    handleStore: createHandleStore(),
    pickDirectory: null,
    browser: {},
  });
  assert.equal((await storage.initialize(state())).status, "unsupported");
});

test("serializa escrituras y conserva el estado más reciente", async () => {
  const directory = createDirectory({ writeDelay: 10 });
  const storage = makeStorage({ directory });
  assert.equal((await storage.initialize(state("Inicial"))).status, "ready");
  const first = storage.save(state("Primera"));
  const second = storage.save(state("Segunda"));
  await Promise.all([first, second]);
  assert.deepEqual(JSON.parse(directory.files.get(FILE_NAME)).state, state("Segunda"));
  assert.equal(directory.writes.length, 3);
});

test("mantiene dirty cuando una escritura falla", async () => {
  const error = new DOMException("Sin permiso", "NotAllowedError");
  const directory = createDirectory();
  const local = new MemoryLocalStorage();
  const storage = makeStorage({ directory, local });
  assert.equal((await storage.initialize(state())).status, "ready");
  directory.getFileHandle = async () => {
    throw error;
  };
  await assert.rejects(storage.save(state("Cambio")), { name: "NotAllowedError" });
  assert.equal(JSON.parse(local.getItem(SYNC_KEY)).dirty, true);
  assert.deepEqual(JSON.parse(local.getItem(MIRROR_KEY)), state("Cambio"));
});

test("guarda y recupera la copia HTML de un módulo", async () => {
  const directory = createDirectory();
  const storage = makeStorage({ directory });
  assert.equal((await storage.initialize(state())).status, "ready");
  await storage.saveModule("ingles-vocabulario", "<!doctype html><title>Inglés</title>");
  assert.equal(
    await storage.readModule("ingles-vocabulario"),
    "<!doctype html><title>Inglés</title>",
  );
  await assert.rejects(storage.saveModule("../inseguro", "x"), TypeError);
});

test("guarda los modulos en una subcarpeta y actualiza la copia del mismo id", async () => {
  const directory = createDirectory();
  const storage = makeStorage({ directory });
  await storage.initialize(state());

  await storage.saveModule("ingles-vocabulario", "primera copia");
  await storage.saveModule("ingles-vocabulario", "copia actualizada");

  const modules = directory.directories.get("modulos");
  assert.ok(modules);
  assert.equal(directory.files.has("apriori-module-ingles-vocabulario.html"), false);
  assert.equal(modules.files.get("apriori-module-ingles-vocabulario.html"), "copia actualizada");
  assert.equal(await storage.readModule("ingles-vocabulario"), "copia actualizada");
});

test("recupera modulos guardados previamente en la carpeta raiz", async () => {
  const directory = createDirectory({
    files: { "apriori-module-ingles-vocabulario.html": "copia anterior" },
  });
  const storage = makeStorage({ directory });
  await storage.initialize(state());

  assert.equal(await storage.readModule("ingles-vocabulario"), "copia anterior");
});
