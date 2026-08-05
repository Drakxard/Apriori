(function exposeFolderStorage(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AprioriFolderStorage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi(root) {
  "use strict";

  const FILE_NAME = "apriori.json";
  const FILE_FORMAT = "apriori.study-queue";
  const FILE_VERSION = 1;
  const MODULE_DIRECTORY_NAME = "modulos";
  const MIRROR_KEY = "study-ticket-queue:v1";
  const SYNC_KEY = "study-ticket-folder-sync:v1";
  const HANDLE_KEY = "data-directory";
  const DB_NAME = "apriori-folder-storage";
  const STORE_NAME = "handles";

  class InvalidDataError extends Error {
    constructor(message) {
      super(message);
      this.name = "InvalidDataError";
    }
  }

  function createIndexedDbHandleStore(indexedDB = root?.indexedDB) {
    let databasePromise = null;

    function openDatabase() {
      if (!indexedDB) return Promise.reject(new Error("IndexedDB no está disponible"));
      if (databasePromise) return databasePromise;

      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.addEventListener("upgradeneeded", () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME);
          }
        });
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
        request.addEventListener("blocked", () => reject(new Error("IndexedDB está bloqueado")));
      });
      return databasePromise;
    }

    async function run(mode, operation) {
      const database = await openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = operation(transaction.objectStore(STORE_NAME));
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
        transaction.addEventListener("abort", () => reject(transaction.error));
      });
    }

    return {
      get: (key) => run("readonly", (store) => store.get(key)),
      put: (key, value) => run("readwrite", (store) => store.put(value, key)),
      delete: (key) => run("readwrite", (store) => store.delete(key)),
    };
  }

  function createFolderStorage(options = {}) {
    const browser = options.browser || root;
    const localStorage = options.localStorage || browser?.localStorage;
    const handleStore = options.handleStore || createIndexedDbHandleStore(options.indexedDB || browser?.indexedDB);
    const pickDirectory =
      options.pickDirectory ||
      (typeof browser?.showDirectoryPicker === "function"
        ? (pickerOptions) => browser.showDirectoryPicker(pickerOptions)
        : null);
    const now = options.now || (() => new Date());

    let directoryHandle = null;
    let ready = false;
    let writeChain = Promise.resolve();
    let revision = 0;

    function readMeta() {
      try {
        const value = JSON.parse(localStorage?.getItem(SYNC_KEY) || "null");
        return value && typeof value === "object"
          ? value
          : { linked: false, dirty: false, directoryName: null };
      } catch {
        return { linked: false, dirty: false, directoryName: null };
      }
    }

    function writeMeta(changes) {
      const value = { ...readMeta(), ...changes };
      localStorage?.setItem(SYNC_KEY, JSON.stringify(value));
      return value;
    }

    function readMirror(fallbackState) {
      try {
        const value = JSON.parse(localStorage?.getItem(MIRROR_KEY) || "null");
        return value && typeof value === "object" ? value : clone(fallbackState);
      } catch {
        return clone(fallbackState);
      }
    }

    function writeMirror(state) {
      localStorage?.setItem(MIRROR_KEY, JSON.stringify(state));
    }

    function clone(value) {
      return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    async function permissionState(handle) {
      if (typeof handle?.queryPermission !== "function") return "granted";
      try {
        return await handle.queryPermission({ mode: "readwrite" });
      } catch {
        return "unknown";
      }
    }

    async function requestPermission(handle) {
      const current = await permissionState(handle);
      if (current === "granted") return current;
      if (typeof handle?.requestPermission !== "function") return current;
      try {
        return await handle.requestPermission({ mode: "readwrite" });
      } catch {
        return current;
      }
    }

    async function canAccessWithoutPrompt(handle) {
      if (
        typeof handle?.isSameEntry !== "function" ||
        typeof browser?.navigator?.storage?.getDirectory !== "function"
      ) {
        return false;
      }
      try {
        const privateRoot = await browser.navigator.storage.getDirectory();
        return await handle.isSameEntry(privateRoot);
      } catch {
        return false;
      }
    }

    function envelope(state) {
      return {
        format: FILE_FORMAT,
        version: FILE_VERSION,
        savedAt: now().toISOString(),
        state: clone(state),
      };
    }

    function parseDocument(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new InvalidDataError(`${FILE_NAME} no contiene JSON válido`);
      }
      if (
        !parsed ||
        parsed.format !== FILE_FORMAT ||
        parsed.version !== FILE_VERSION ||
        !parsed.state ||
        typeof parsed.state !== "object" ||
        ![1, 2, 3].includes(parsed.state.version) ||
        !Array.isArray(parsed.state.subjects) ||
        !Array.isArray(parsed.state.ring)
      ) {
        throw new InvalidDataError(`${FILE_NAME} no tiene un formato compatible`);
      }
      return clone(parsed.state);
    }

    async function readDocument(handle) {
      const fileHandle = await handle.getFileHandle(FILE_NAME);
      const file = await fileHandle.getFile();
      return parseDocument(await file.text());
    }

    async function writeDocument(handle, state) {
      const fileHandle = await handle.getFileHandle(FILE_NAME, { create: true });
      const writable = await fileHandle.createWritable();
      try {
        await writable.write(`${JSON.stringify(envelope(state), null, 2)}\n`);
        await writable.close();
      } catch (error) {
        try {
          await writable.abort();
        } catch {}
        throw error;
      }
    }

    function resultForError(error, handle = directoryHandle) {
      if (error instanceof InvalidDataError) {
        return {
          status: "invalid-file",
          directoryName: handle?.name || null,
          message: error.message,
          error,
        };
      }
      if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
        return {
          status: "needs-permission",
          directoryName: handle?.name || null,
          error,
        };
      }
      return {
        status: "storage-error",
        directoryName: handle?.name || null,
        message: error?.message || "No se pudo acceder a la carpeta",
        error,
      };
    }

    async function connect(handle, fallbackState, linkedToSameDirectory) {
      directoryHandle = handle;
      const meta = readMeta();
      try {
        if (linkedToSameDirectory && meta.linked && meta.dirty) {
          const pendingState = readMirror(fallbackState);
          await writeDocument(handle, pendingState);
          writeMeta({ linked: true, dirty: false, directoryName: handle.name || null });
          ready = true;
          return { status: "ready", state: pendingState, source: "pending-mirror" };
        }

        let folderState;
        try {
          folderState = await readDocument(handle);
        } catch (error) {
          if (error?.name !== "NotFoundError") throw error;
          folderState = readMirror(fallbackState);
          await writeDocument(handle, folderState);
        }

        writeMirror(folderState);
        writeMeta({ linked: true, dirty: false, directoryName: handle.name || null });
        ready = true;
        return { status: "ready", state: folderState, source: "folder" };
      } catch (error) {
        ready = false;
        return resultForError(error, handle);
      }
    }

    async function initialize(fallbackState) {
      if (!pickDirectory || !handleStore || !localStorage) {
        return { status: "unsupported" };
      }
      try {
        directoryHandle = await handleStore.get(HANDLE_KEY);
        if (!directoryHandle) return { status: "needs-selection" };
        const permission = await permissionState(directoryHandle);
        if (permission !== "granted" && !(await canAccessWithoutPrompt(directoryHandle))) {
          return {
            status: "needs-permission",
            directoryName: directoryHandle.name || null,
            permission,
          };
        }
        return connect(directoryHandle, fallbackState, true);
      } catch (error) {
        ready = false;
        return resultForError(error);
      }
    }

    async function selectDirectory(fallbackState) {
      if (!pickDirectory) return { status: "unsupported" };
      try {
        const previousHandle = directoryHandle;
        const selectedHandle = await pickDirectory({ id: "apriori-data", mode: "readwrite" });
        let sameDirectory = false;
        if (previousHandle && typeof selectedHandle.isSameEntry === "function") {
          try {
            sameDirectory = await selectedHandle.isSameEntry(previousHandle);
          } catch {}
        }
        directoryHandle = selectedHandle;
        const permission = await requestPermission(selectedHandle);
        if (permission !== "granted" && !(await canAccessWithoutPrompt(selectedHandle))) {
          return {
            status: "needs-permission",
            directoryName: selectedHandle.name || null,
            permission,
          };
        }
        await handleStore.put(HANDLE_KEY, selectedHandle);
        return connect(selectedHandle, fallbackState, sameDirectory);
      } catch (error) {
        if (error?.name === "AbortError") return { status: "cancelled" };
        ready = false;
        return resultForError(error);
      }
    }

    async function authorize(fallbackState) {
      if (!directoryHandle) return { status: "needs-selection" };
      try {
        const permission = await requestPermission(directoryHandle);
        if (permission !== "granted" && !(await canAccessWithoutPrompt(directoryHandle))) {
          return {
            status: "needs-permission",
            directoryName: directoryHandle.name || null,
            permission,
          };
        }
        return connect(directoryHandle, fallbackState, true);
      } catch (error) {
        ready = false;
        return resultForError(error);
      }
    }

    function save(state) {
      const snapshot = clone(state);
      let saveRevision;
      try {
        writeMirror(snapshot);
        saveRevision = ++revision;
        writeMeta({
          linked: true,
          dirty: true,
          directoryName: directoryHandle?.name || null,
        });
      } catch (error) {
        return Promise.reject(error);
      }

      if (!ready || !directoryHandle) {
        return Promise.reject(new DOMException("La carpeta no está disponible", "NotAllowedError"));
      }

      const operation = writeChain
        .catch(() => undefined)
        .then(() => writeDocument(directoryHandle, snapshot))
        .then(() => {
          if (saveRevision === revision) writeMeta({ dirty: false });
        })
        .catch((error) => {
          ready = false;
          throw error;
        });
      writeChain = operation;
      return operation;
    }

    function moduleFileName(moduleId) {
      const id = String(moduleId || "");
      if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(id)) {
        throw new TypeError("El identificador del módulo no es válido");
      }
      return `apriori-module-${id}.html`;
    }

    async function modulesDirectory(create = true) {
      return directoryHandle.getDirectoryHandle(MODULE_DIRECTORY_NAME, { create });
    }

    function saveModule(moduleId, html) {
      if (!ready || !directoryHandle) {
        return Promise.reject(new DOMException("La carpeta no está disponible", "NotAllowedError"));
      }
      if (typeof html !== "string" || !html.trim()) {
        return Promise.reject(new TypeError("El módulo descargado está vacío"));
      }
      const operation = writeChain
        .catch(() => undefined)
        .then(async () => {
          const moduleDirectory = await modulesDirectory();
          const fileHandle = await moduleDirectory.getFileHandle(moduleFileName(moduleId), { create: true });
          const writable = await fileHandle.createWritable();
          try {
            await writable.write(html);
            await writable.close();
          } catch (error) {
            try { await writable.abort(); } catch {}
            throw error;
          }
        })
        .catch((error) => {
          ready = false;
          throw error;
        });
      writeChain = operation;
      return operation;
    }

    async function readModule(moduleId) {
      if (!ready || !directoryHandle) {
        throw new DOMException("La carpeta no está disponible", "NotAllowedError");
      }
      const fileName = moduleFileName(moduleId);
      try {
        const moduleDirectory = await modulesDirectory(false);
        const fileHandle = await moduleDirectory.getFileHandle(fileName);
        return (await fileHandle.getFile()).text();
      } catch (error) {
        // Permite abrir las copias creadas por versiones anteriores, que estaban
        // en la carpeta elegida directamente.
        if (error?.name !== "NotFoundError") throw error;
        const legacyFileHandle = await directoryHandle.getFileHandle(fileName);
        return (await legacyFileHandle.getFile()).text();
      }
    }

    return {
      initialize,
      selectDirectory,
      authorize,
      save,
      saveModule,
      readModule,
      get directoryName() {
        return directoryHandle?.name || null;
      },
      get isReady() {
        return ready;
      },
    };
  }

  return {
    DB_NAME,
    FILE_FORMAT,
    FILE_NAME,
    FILE_VERSION,
    MODULE_DIRECTORY_NAME,
    HANDLE_KEY,
    MIRROR_KEY,
    STORE_NAME,
    SYNC_KEY,
    InvalidDataError,
    createFolderStorage,
    createIndexedDbHandleStore,
  };
});
