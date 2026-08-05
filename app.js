(function startApp() {
  "use strict";

  const Scheduler = window.StudyScheduler;
  const folderStorage = window.AprioriFolderStorage.createFolderStorage();
  const STORAGE_KEY = "study-ticket-queue:v1";
  const STATE_VERSION = 3;
  const MODULE_CATALOG_URL = "https://raw.githubusercontent.com/Drakxard/InSceeen/main/modules/index.json";
  const MODULE_RAW_BASE_URL = "https://raw.githubusercontent.com/Drakxard/InSceeen/main/";
  const DRAG_THRESHOLD = 64;
  const CLICK_THRESHOLD = 6;
  const HOLD_DELAY = 150;
  const HOLD_LIFT = 8;
  const ANIMATION_MS = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 270;
  const PALETTE = [
    "#13a8e0",
    "#b5eb16",
    "#bf835f",
    "#c5bee1",
    "#ffca1a",
  ];
  const LEGACY_PALETTE = [
    "#20a6d7",
    "#b6eb20",
    "#c3845e",
    "#c7c0e4",
    "#ffc928",
    "#ef8fa1",
    "#71c9b3",
    "#f2a95d",
  ];

  const elements = {
    queue: document.querySelector("#queue"),
    subjectDock: document.querySelector("#subjectDock"),
    subjectDockList: document.querySelector("#subjectDockList"),
    addDialog: document.querySelector("#addDialog"),
    addForm: document.querySelector("#addForm"),
    newSubjectName: document.querySelector("#newSubjectName"),
    addError: document.querySelector("#addError"),
    detailDialog: document.querySelector("#detailDialog"),
    detailForm: document.querySelector("#detailForm"),
    detailId: document.querySelector("#detailId"),
    detailName: document.querySelector("#detailName"),
    assignedModule: document.querySelector("#assignedModule"),
    assignedModuleName: document.querySelector("#assignedModuleName"),
    removeModuleButton: document.querySelector("#removeModuleButton"),
    weightCycleButton: document.querySelector("#weightCycleButton"),
    evaluationList: document.querySelector("#evaluationList"),
    addEvaluationButton: document.querySelector("#addEvaluationButton"),
    detailColor: document.querySelector("#detailColor"),
    detailAppearances: document.querySelector("#detailAppearances"),
    detailNextTurn: document.querySelector("#detailNextTurn"),
    colorButton: document.querySelector("#colorButton"),
    colorPicker: document.querySelector("#colorPicker"),
    colorHue: document.querySelector("#colorHue"),
    colorSaturation: document.querySelector("#colorSaturation"),
    colorLightness: document.querySelector("#colorLightness"),
    colorHex: document.querySelector("#colorHex"),
    colorInputError: document.querySelector("#colorInputError"),
    detailError: document.querySelector("#detailError"),
    moduleDialog: document.querySelector("#moduleDialog"),
    moduleSearch: document.querySelector("#moduleSearch"),
    moduleResults: document.querySelector("#moduleResults"),
    moduleError: document.querySelector("#moduleError"),
    settingsDialog: document.querySelector("#settingsDialog"),
    settingsForm: document.querySelector("#settingsForm"),
    cycleSize: document.querySelector("#cycleSize"),
    urgencyK: document.querySelector("#urgencyK"),
    settingsError: document.querySelector("#settingsError"),
    cancelSettings: document.querySelector("#cancelSettings"),
    deleteButton: document.querySelector("#deleteButton"),
    storageDialog: document.querySelector("#storageDialog"),
    storageMessage: document.querySelector("#storageMessage"),
    storageError: document.querySelector("#storageError"),
    storagePrimaryButton: document.querySelector("#storagePrimaryButton"),
    storageSecondaryButton: document.querySelector("#storageSecondaryButton"),
  };

  let state = loadState();
  let storageReady = false;
  let storageGateMode = "select";
  let drag = null;
  let isAnimating = false;
  let suppressClick = false;
  let dockDraggedId = null;
  let suppressDockClick = false;
  let dayRefreshTimer = null;
  let moduleCatalog = null;
  let moduleSearchSubjectId = null;

  bindEvents();
  bootstrapStorage();

  function emptyState() {
    return {
      version: STATE_VERSION,
      subjects: [],
      ring: [],
      weightSignature: "",
      dockSplitIndex: 0,
      settings: { ...Scheduler.DEFAULT_SETTINGS },
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyState();
      return normalizeState(JSON.parse(raw));
    } catch {
      return emptyState();
    }
  }

  function normalizeState(saved) {
    if (!saved || ![1, 2, STATE_VERSION].includes(saved.version) || !Array.isArray(saved.subjects)) {
      return emptyState();
    }

    try {
      const ids = new Set();
      const subjects = saved.subjects
        .map(normalizeSubject)
        .filter((subject) => {
          if (!subject || ids.has(subject.id)) return false;
          ids.add(subject.id);
          return true;
        });
      const validIds = new Set(subjects.map((subject) => subject.id));
      const ring = Array.isArray(saved.ring)
        ? saved.ring.filter((id) => typeof id === "string" && validIds.has(id))
        : [];

      const normalizedState = {
        version: STATE_VERSION,
        subjects,
        ring,
        weightSignature: typeof saved.weightSignature === "string" ? saved.weightSignature : "",
        dockSplitIndex: Number.isInteger(saved.dockSplitIndex)
          ? Math.max(0, Math.min(saved.dockSplitIndex, subjects.length))
          : Math.min(5, subjects.length),
        settings: Scheduler.normalizeSettings(saved.settings),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizedState));
      return normalizedState;
    } catch {
      return emptyState();
    }
  }

  async function bootstrapStorage() {
    const result = await folderStorage.initialize(state);
    await applyStorageResult(result);
  }

  async function applyStorageResult(result) {
    if (!result || result.status === "cancelled") return;
    if (result.status !== "ready") {
      storageReady = false;
      showStorageGate(result);
      return;
    }

    state = normalizeState(result.state);
    storageReady = true;
    document.body.classList.remove("storage-blocked");
    if (elements.storageDialog.open) elements.storageDialog.close();
    ensureFreshRing();
    render();
    saveState();
    scheduleDayRefresh();
  }

  function showStorageGate(result) {
    document.body.classList.add("storage-blocked");
    elements.storageError.textContent = "";
    elements.storagePrimaryButton.hidden = false;
    elements.storageSecondaryButton.hidden = true;

    if (result.status === "needs-selection") {
      storageGateMode = "select";
      elements.storageMessage.textContent = "Elegí una carpeta para guardar la cola.";
      elements.storagePrimaryButton.textContent = "Elegir carpeta";
    } else if (result.status === "needs-permission") {
      storageGateMode = "authorize";
      const folder = result.directoryName ? ` “${result.directoryName}”` : "";
      elements.storageMessage.textContent = `La carpeta${folder} necesita acceso.`;
      elements.storagePrimaryButton.textContent = "Dar acceso";
      elements.storageSecondaryButton.hidden = false;
    } else if (result.status === "invalid-file") {
      storageGateMode = "authorize";
      elements.storageMessage.textContent = "No se pudo leer apriori.json.";
      elements.storageError.textContent = "El archivo no será reemplazado. Corregilo y reintentá, o elegí otra carpeta.";
      elements.storagePrimaryButton.textContent = "Reintentar";
      elements.storageSecondaryButton.hidden = false;
    } else if (result.status === "unsupported") {
      storageGateMode = "unsupported";
      elements.storageMessage.textContent = "Este navegador no permite guardar directamente en una carpeta.";
      elements.storageError.textContent = "Abrí la app con una versión reciente de Edge o Chrome.";
      elements.storagePrimaryButton.hidden = true;
    } else {
      storageGateMode = result.directoryName ? "authorize" : "retry";
      elements.storageMessage.textContent = "No se pudo acceder a la carpeta.";
      elements.storageError.textContent = result.message || "Reintentá el acceso o elegí otra carpeta.";
      elements.storagePrimaryButton.textContent = "Reintentar";
      elements.storageSecondaryButton.hidden = !result.directoryName;
    }

    setStorageBusy(false);
    if (!elements.storageDialog.open) elements.storageDialog.showModal();
  }

  function setStorageBusy(busy) {
    elements.storagePrimaryButton.disabled = busy;
    elements.storageSecondaryButton.disabled = busy;
  }

  async function runStorageAction(action) {
    setStorageBusy(true);
    elements.storageError.textContent = "";
    let result;
    if (action === "select") result = await folderStorage.selectDirectory(state);
    else if (action === "retry") result = await folderStorage.initialize(state);
    else result = await folderStorage.authorize(state);
    setStorageBusy(false);
    await applyStorageResult(result);
  }

  function normalizeSubject(subject, index) {
    if (!subject || typeof subject !== "object") return null;
    const name = normalizeName(subject.name);
    if (!name) return null;

    const createdAt = new Date(subject.createdAt);
    return {
      id: typeof subject.id === "string" && subject.id ? subject.id : createId(),
      name,
      active: subject.active !== false,
      baseWeight: Math.max(1, Math.min(100, Number(subject.baseWeight) || 1)),
      evaluations: normalizeEvaluations(subject.evaluations, subject.examDate),
      createdAt: Number.isNaN(createdAt.getTime()) ? new Date().toISOString() : createdAt.toISOString(),
      color: normalizeColor(subject.color, index),
      module: normalizeModule(subject.module),
    };
  }

  function normalizeModule(module) {
    if (!module || typeof module !== "object") return null;
    const id = typeof module.id === "string" ? module.id.trim() : "";
    const nombre = normalizeName(module.nombre);
    const entry = typeof module.entry === "string" ? module.entry.trim() : "";
    return id && nombre && entry ? { id, nombre, entry } : null;
  }

  function normalizeEvaluations(evaluations, legacyExamDate = null) {
    const source = Array.isArray(evaluations)
      ? evaluations
      : Scheduler.parseLocalDate(legacyExamDate)
        ? [{ id: createId(), name: "Examen", date: legacyExamDate }]
        : [];
    const ids = new Set();
    return source.map((evaluation) => {
      if (!Scheduler.parseLocalDate(evaluation?.date)) return null;
      let id = typeof evaluation.id === "string" && evaluation.id ? evaluation.id : createId();
      if (ids.has(id)) id = createId();
      ids.add(id);
      return { id, name: normalizeName(evaluation.name).slice(0, 60), date: evaluation.date };
    }).filter(Boolean);
  }

  function normalizeColor(color, index) {
    const normalized = typeof color === "string" ? color.toLowerCase() : "";
    if (/^#[0-9a-f]{6}$/.test(normalized)) {
      const legacyIndex = LEGACY_PALETTE.findIndex((item) => item.toLowerCase() === normalized);
      return legacyIndex >= 0 ? PALETTE[legacyIndex % PALETTE.length] : normalized;
    }
    const currentIndex = PALETTE.findIndex((item) => item.toLowerCase() === normalized);
    if (currentIndex >= 0) return PALETTE[currentIndex];
    return PALETTE[index % PALETTE.length];
  }

  function saveState() {
    if (!storageReady) return;
    folderStorage.save(state).catch((error) => {
      if (!storageReady) return;
      storageReady = false;
      showStorageGate({
        status: "storage-error",
        directoryName: folderStorage.directoryName,
        message: error?.message || "No se pudo escribir apriori.json.",
      });
    });
  }

  function uniqueOrder(ids) {
    return ids.filter((id, index) => ids.indexOf(id) === index);
  }

  function ringMatchesWeights(ring, subjects) {
    const schedule = Scheduler.calculateSchedule(subjects, state.settings);
    const desired = new Map(schedule.allocations.filter((item) => item.tickets > 0).map((item) => [item.id, item.tickets]));
    const actual = new Map();
    for (const id of ring) actual.set(id, (actual.get(id) || 0) + 1);
    if (actual.size !== desired.size) return false;
    return Array.from(desired).every(([id, count]) => actual.get(id) === count);
  }

  function ensureFreshRing(force = false) {
    const signature = Scheduler.weightSignature(state.subjects, state.settings);
    const shouldRebuild =
      force ||
      signature !== state.weightSignature ||
      !ringMatchesWeights(state.ring, state.subjects);

    if (!shouldRebuild) return false;

    const preferredHead = state.ring[0] || state.subjects[0]?.id || null;
    state.ring = Scheduler.buildRing(state.subjects, new Date(), {
      settings: state.settings,
      preferredHead,
      preferredOrder: uniqueOrder(state.ring),
    });
    state.weightSignature = signature;
    saveState();
    return true;
  }

  function rebuildRing() {
    state.weightSignature = "";
    ensureFreshRing(true);
  }

  function render() {
    ensureFreshRing();
    elements.queue.replaceChildren();
    renderSubjectDock();
    if (elements.detailDialog.open) renderDetailMetrics();

    if (!state.ring.length) return;

    const subjectMap = new Map(state.subjects.map((subject) => [subject.id, subject]));

    for (let index = 0; index < 5; index += 1) {
      const id = state.ring[index % state.ring.length];
      const subject = subjectMap.get(id);
      if (!subject) continue;

      const card = document.createElement("button");
      card.type = "button";
      card.className = "queue-card";
      card.dataset.position = String(index);
      card.dataset.subjectId = subject.id;
      card.style.setProperty("--card-color", subject.color);
      card.setAttribute(
        "aria-label",
        `${subject.name}, posición ${index + 1} de 5`,
      );

      const label = document.createElement("span");
      label.className = "card-label";
      label.textContent = Scheduler.acronym(subject.name);
      card.append(label);

      elements.queue.append(card);
    }
  }

  function currentSchedule() {
    return Scheduler.calculateSchedule(state.subjects, state.settings, new Date(), {
      preferredHead: state.ring[0] || null,
      preferredOrder: uniqueOrder(state.ring),
    });
  }

  function renderMode() {
    const labels = { regular: "Regular", alert: "Alerta", critical: "Crítico" };
    const mode = currentSchedule().mode;
    elements.modeBadge.textContent = labels[mode];
    elements.modeBadge.dataset.mode = mode;
  }

  function renderSubjectDock() {
    elements.subjectDockList.replaceChildren();
    if (state.subjects.length === 0) document.body.classList.remove("dock-visible");
    for (const [index, subject] of state.subjects.entries()) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "subject-dock-card";
      if (!subject.active) card.classList.add("is-inactive");
      if (index === state.dockSplitIndex) card.classList.add("starts-right-group");
      card.draggable = true;
      card.dataset.subjectId = subject.id;
      card.dataset.dockSide = index < state.dockSplitIndex ? "left" : "right";
      card.style.setProperty("--card-color", subject.color);
      card.textContent = Scheduler.acronym(subject.name);
      card.setAttribute("aria-label", `Ver detalles de ${subject.name}`);
      elements.subjectDockList.append(card);
    }
  }

  function handleDockProximity(event) {
    if (!storageReady || state.subjects.length === 0) return;
    if (window.innerHeight - event.clientY <= 90) showSubjectDock();
    else if (!elements.subjectDock.matches(":hover")) hideSubjectDock();
  }

  function showSubjectDock() {
    if (storageReady && state.subjects.length > 0) document.body.classList.add("dock-visible");
  }

  function hideSubjectDock() {
    if (!elements.subjectDock.matches(":hover") && !elements.subjectDock.matches(":focus-within")) {
      document.body.classList.remove("dock-visible");
    }
  }

  function handleDockClick(event) {
    const card = event.target.closest(".subject-dock-card[data-subject-id]");
    if (!card || suppressDockClick) return;
    openDetails(card.dataset.subjectId);
  }

  function handleDockDragStart(event) {
    const card = event.target.closest(".subject-dock-card[data-subject-id]");
    if (!card) return;
    dockDraggedId = card.dataset.subjectId;
    suppressDockClick = true;
    card.classList.add("is-reordering");
    event.dataTransfer?.setData("text/plain", dockDraggedId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function handleDockDragOver(event) {
    if (!dockDraggedId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  function handleDockDrop(event) {
    if (!dockDraggedId) return;
    event.preventDefault();

    const sourceIndex = state.subjects.findIndex((subject) => subject.id === dockDraggedId);
    if (sourceIndex < 0) return;

    let splitIndex = Math.max(0, Math.min(state.dockSplitIndex, state.subjects.length));
    const sourceWasLeft = sourceIndex < splitIndex;
    const target = event.target.closest(".subject-dock-card[data-subject-id]");
    const targetId = target?.dataset.subjectId === dockDraggedId
      ? null
      : target?.dataset.subjectId;
    const placeAfter = target
      ? event.clientX >= target.getBoundingClientRect().left + target.offsetWidth / 2
      : false;
    const [moved] = state.subjects.splice(sourceIndex, 1);
    if (sourceWasLeft) splitIndex -= 1;

    let insertionIndex;
    let destinationIsLeft;
    const targetIndex = targetId
      ? state.subjects.findIndex((subject) => subject.id === targetId)
      : -1;
    if (targetIndex >= 0) {
      destinationIsLeft = targetIndex < splitIndex;
      insertionIndex = targetIndex + (placeAfter ? 1 : 0);
    } else {
      const bounds = elements.subjectDockList.getBoundingClientRect();
      destinationIsLeft = event.clientX < bounds.left + bounds.width / 2;
      insertionIndex = destinationIsLeft ? splitIndex : state.subjects.length;
    }

    state.subjects.splice(insertionIndex, 0, moved);
    if (destinationIsLeft) splitIndex += 1;
    state.dockSplitIndex = splitIndex;
    saveState();
    renderSubjectDock();
    finishDockDrag();
  }

  function handleDockDragEnd() {
    finishDockDrag();
  }

  function finishDockDrag() {
    dockDraggedId = null;
    elements.subjectDockList.querySelector(".is-reordering")?.classList.remove("is-reordering");
    window.setTimeout(() => {
      suppressDockClick = false;
    }, 0);
  }

  function bindEvents() {
    elements.storagePrimaryButton.addEventListener("click", () => runStorageAction(storageGateMode));
    elements.storageSecondaryButton.addEventListener("click", () => runStorageAction("select"));
    elements.storageDialog.addEventListener("cancel", (event) => event.preventDefault());
    elements.addForm.addEventListener("submit", addSubject);
    elements.newSubjectName.addEventListener("keydown", handleAddKeydown);
    elements.detailForm.addEventListener("submit", saveSubjectDetails);
    elements.detailName.addEventListener("blur", saveSubjectDetails);
    elements.detailName.addEventListener("keydown", handleDetailNameKeydown);
    elements.deleteButton.addEventListener("click", deleteSelectedSubject);
    elements.removeModuleButton.addEventListener("click", removeAssignedModule);
    elements.weightCycleButton.addEventListener("click", cycleSubjectWeight);
    elements.addEvaluationButton.addEventListener("click", addEvaluation);
    elements.evaluationList.addEventListener("change", saveEvaluations);
    elements.evaluationList.addEventListener("click", handleEvaluationAction);
    elements.settingsForm.addEventListener("submit", saveSettings);
    elements.cancelSettings.addEventListener("click", () => elements.settingsDialog.close());
    elements.detailColor.addEventListener("change", commitColorPickerValue);
    elements.colorButton.addEventListener("click", toggleColorPicker);
    elements.colorPicker.addEventListener("input", handleColorPickerInput);
    elements.colorHex.addEventListener("change", handleColorHexChange);
    elements.queue.addEventListener("click", handleCardClick);
    elements.moduleSearch.addEventListener("input", renderModuleResults);
    elements.moduleResults.addEventListener("click", useModule);
    elements.queue.addEventListener("pointerdown", handlePointerDown);
    elements.queue.addEventListener("pointermove", handlePointerMove);
    elements.queue.addEventListener("pointerup", handlePointerUp);
    elements.queue.addEventListener("pointercancel", cancelDrag);
    elements.queue.addEventListener("keydown", handleQueueKeydown);
    elements.subjectDockList.addEventListener("click", handleDockClick);
    elements.subjectDockList.addEventListener("dragstart", handleDockDragStart);
    elements.subjectDockList.addEventListener("dragover", handleDockDragOver);
    elements.subjectDockList.addEventListener("drop", handleDockDrop);
    elements.subjectDockList.addEventListener("dragend", handleDockDragEnd);
    elements.subjectDock.addEventListener("pointerenter", showSubjectDock);
    elements.subjectDock.addEventListener("pointerleave", hideSubjectDock);
    document.addEventListener("pointermove", handleDockProximity);
    document.addEventListener("pointerleave", hideSubjectDock);
    document.addEventListener("pointerdown", closeColorPickerOnOutsidePress);
    document.addEventListener("keydown", handleGlobalKeydown);
    document.addEventListener("visibilitychange", refreshAfterVisibilityChange);

    elements.addDialog.addEventListener("click", closeOnBackdrop);
    elements.detailDialog.addEventListener("click", closeOnBackdrop);
    elements.moduleDialog.addEventListener("click", closeOnBackdrop);
    elements.settingsDialog.addEventListener("click", closeOnBackdrop);
    elements.addDialog.addEventListener("close", () => {
      elements.addError.textContent = "";
      elements.addForm.reset();
    });
    elements.detailDialog.addEventListener("close", () => {
      closeColorPicker();
      elements.detailError.textContent = "";
    });
    elements.moduleDialog.addEventListener("close", () => {
      moduleSearchSubjectId = null;
      elements.moduleSearch.value = "";
      elements.moduleResults.replaceChildren();
      elements.moduleError.textContent = "";
    });
  }

  function closeOnBackdrop(event) {
    if (event.target === event.currentTarget) event.currentTarget.close();
  }

  function openAddDialog() {
    if (elements.addDialog.open || elements.detailDialog.open) return;
    elements.addError.textContent = "";
    elements.addDialog.showModal();
    requestAnimationFrame(() => elements.newSubjectName.focus());
  }

  function handleAddKeydown(event) {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    elements.addForm.requestSubmit();
  }

  function normalizeName(name) {
    return String(name || "").trim().replace(/\s+/g, " ");
  }

  function isDuplicateName(name, ignoredId = null) {
    const target = name.toLocaleLowerCase("es");
    return state.subjects.some(
      (subject) =>
        subject.id !== ignoredId && subject.name.toLocaleLowerCase("es") === target,
    );
  }

  function addSubject(event) {
    event.preventDefault();
    const name = normalizeName(elements.newSubjectName.value);
    if (!name) {
      elements.addError.textContent = "Escribí un nombre para continuar.";
      elements.newSubjectName.focus();
      return;
    }
    if (isDuplicateName(name)) {
      elements.addError.textContent = "Esa materia ya está en la cola.";
      elements.newSubjectName.select();
      return;
    }

    const subject = {
      id: createId(),
      name,
      createdAt: new Date().toISOString(),
      color: nextColor(),
      active: true,
      baseWeight: 1,
      evaluations: [],
      module: null,
    };
    const priorHead = state.ring[0] || null;
    const extendLeftGroup =
      state.subjects.length < 5 && state.dockSplitIndex === state.subjects.length;
    state.subjects.push(subject);
    if (extendLeftGroup) state.dockSplitIndex += 1;
    state.ring.push(subject.id);
    state.weightSignature = Scheduler.weightSignature(state.subjects, state.settings);

    if (!ringMatchesWeights(state.ring, state.subjects)) {
      state.ring = Scheduler.buildRing(state.subjects, new Date(), {
        preferredHead: priorHead,
        preferredOrder: uniqueOrder(state.ring),
      });
    }

    // A newly created base ticket should visibly enter at the bottom while the old head stays first.
    if (priorHead && state.ring[0] === priorHead) {
      const newIndex = state.ring.indexOf(subject.id);
      if (newIndex >= 0 && newIndex !== state.ring.length - 1) {
        state.ring.splice(newIndex, 1);
        state.ring.push(subject.id);
      }
    }

    saveState();
    elements.addDialog.close();
    render();
  }

  function createId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `subject-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function nextColor() {
    const usage = new Map(PALETTE.map((color) => [color, 0]));
    state.subjects.forEach((subject) => usage.set(subject.color, (usage.get(subject.color) || 0) + 1));
    return PALETTE.slice().sort((left, right) => usage.get(left) - usage.get(right))[0];
  }

  function subjectById(id) {
    return state.subjects.find((subject) => subject.id === id) || null;
  }

  function handleCardClick(event) {
    const card = event.target.closest(".queue-card[data-subject-id]");
    if (!card || suppressClick || isAnimating) return;
    const subject = subjectById(card.dataset.subjectId);
    if (!subject) return;
    if (subject.module) openAssignedModule(subject);
    else openModuleSearch(subject.id);
  }

  async function openModuleSearch(subjectId) {
    if (elements.moduleDialog.open || elements.detailDialog.open) return;
    moduleSearchSubjectId = subjectId;
    elements.moduleError.textContent = "";
    elements.moduleResults.replaceChildren();
    elements.moduleDialog.showModal();
    requestAnimationFrame(() => elements.moduleSearch.focus());
    try {
      await loadModuleCatalog();
      renderModuleResults();
    } catch (error) {
      elements.moduleError.textContent = error.message || "No se pudo cargar el catálogo de módulos.";
    }
  }

  async function loadModuleCatalog() {
    if (moduleCatalog) return moduleCatalog;
    const response = await fetch(MODULE_CATALOG_URL);
    if (!response.ok) throw new Error("No se pudo cargar el catálogo de módulos.");
    const payload = await response.json();
    if (!Array.isArray(payload?.modules)) throw new Error("El catálogo de módulos no es válido.");
    moduleCatalog = payload.modules.map(normalizeModule).filter(Boolean);
    return moduleCatalog;
  }

  function renderModuleResults() {
    elements.moduleResults.replaceChildren();
    const query = normalizeName(elements.moduleSearch.value).toLocaleLowerCase("es");
    if (!query || !moduleCatalog) return;
    const matches = moduleCatalog.filter((module) => module.nombre.toLocaleLowerCase("es").includes(query));
    for (const module of matches) {
      const row = document.createElement("div");
      row.className = "module-result";
      const name = document.createElement("span");
      name.textContent = module.nombre;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Usar";
      button.dataset.moduleId = module.id;
      row.append(name, button);
      elements.moduleResults.append(row);
    }
  }

  async function useModule(event) {
    const button = event.target.closest("button[data-module-id]");
    if (!button || !moduleSearchSubjectId) return;
    const subject = subjectById(moduleSearchSubjectId);
    const module = moduleCatalog?.find((item) => item.id === button.dataset.moduleId);
    if (!subject || !module) return;
    // Se crea durante el click para que el navegador no bloquee la pestaña
    // mientras termina la descarga.
    const moduleWindow = window.open("", "_blank");
    if (moduleWindow) moduleWindow.opener = null;
    const row = button.closest(".module-result");
    button.disabled = true;
    button.textContent = "...";
    row?.classList.add("is-downloading");
    row?.style.setProperty("--download-color", subject.color);
    elements.moduleError.textContent = "";
    try {
      const entry = module.entry.replace(/^\/+/, "");
      const response = await fetch(new URL(entry, MODULE_RAW_BASE_URL));
      if (!response.ok) throw new Error("No se pudo descargar el módulo.");
      const html = await response.text();
      await folderStorage.saveModule(module.id, html);
      subject.module = module;
      await folderStorage.save(state);
      openModuleHtml(html, moduleWindow);
      // La pestaña del módulo ya está al frente, por lo que el diálogo no llega
      // a mostrarse cerrándose durante la navegación.
      elements.moduleDialog.close();
    } catch (error) {
      moduleWindow?.close();
      if (subject.module?.id === module.id) subject.module = null;
      row?.classList.remove("is-downloading");
      elements.moduleError.textContent = error.message || "No se pudo descargar el módulo.";
      button.textContent = "Usar";
      button.disabled = false;
    }
  }

  async function openAssignedModule(subject) {
    try {
      const html = await folderStorage.readModule(subject.module.id);
      openModuleHtml(html);
    } catch {
      openModuleSearch(subject.id);
      elements.moduleError.textContent = "No se encontró la copia descargada. Volvé a elegir el módulo.";
    }
  }

  function openModuleHtml(html, targetWindow = null) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    if (targetWindow && !targetWindow.closed) targetWindow.location.replace(url);
    else window.location.assign(url);
  }

  function renderAssignedModule(subject) {
    const module = subject.module;
    elements.assignedModule.hidden = !module;
    elements.assignedModuleName.textContent = module?.nombre || "";
  }

  function removeAssignedModule() {
    const subject = subjectById(elements.detailId.value);
    if (!subject?.module) return;
    subject.module = null;
    saveState();
    renderAssignedModule(subject);
  }

  function openDetails(id) {
    const subject = subjectById(id);
    if (!subject || elements.detailDialog.open) return;
    elements.detailId.value = subject.id;
    elements.detailName.value = subject.name;
    renderAssignedModule(subject);
    renderWeightCycle(subject);
    renderEvaluations(subject);
    elements.detailColor.value = subject.color;
    updateColorButton(subject.color);
    renderDetailMetrics(subject);
    elements.detailError.textContent = "";
    elements.detailDialog.showModal();
  }

  function renderDetailMetrics(selectedSubject = null) {
    const subject = selectedSubject || subjectById(elements.detailId.value);
    if (!subject) {
      elements.detailAppearances.textContent = "—";
      elements.detailNextTurn.textContent = "—";
      return;
    }

    const appearances = state.ring.reduce(
      (total, id) => total + (id === subject.id ? 1 : 0),
      0,
    );
    const distance = Scheduler.nextOccurrenceDistance(state.ring, subject.id);
    elements.detailAppearances.textContent = `${appearances} ${
      appearances === 1 ? "aparición" : "apariciones"
    }`;
    elements.detailNextTurn.textContent = Number.isInteger(distance)
      ? `${distance} ${distance === 1 ? "turno" : "turnos"}`
      : "—";
  }

  function renderScheduleMetrics(subject) {
    const schedule = currentSchedule();
    const allocation = schedule.allocations.find((item) => item.id === subject.id);
    const labels = { regular: "Regular", alert: "Alerta", critical: "Crítico" };
    elements.detailMode.textContent = `Modo: ${labels[schedule.mode]}`;
    elements.detailWeight.textContent = allocation
      ? `Peso: ${allocation.baseWeight} → ${allocation.finalWeight.toFixed(2)}`
      : "Materia inactiva";
    elements.detailReason.textContent = allocation?.reason || "No participa de la planificación";
  }

  function renderWeightCycle(subject) {
    elements.weightCycleButton.textContent = `× ${subject.baseWeight}`;
  }

  function cycleSubjectWeight() {
    const subject = subjectById(elements.detailId.value);
    if (!subject) return;
    subject.baseWeight = subject.baseWeight >= 3 ? 1 : subject.baseWeight + 1;
    renderWeightCycle(subject);
    rebuildRing();
    render();
  }

  function renderEvaluations(subject) {
    elements.evaluationList.replaceChildren();
    for (const evaluation of subject.evaluations) {
      const row = document.createElement("div");
      row.className = "evaluation-row";
      row.dataset.evaluationId = evaluation.id;
      row.innerHTML = '<input class="evaluation-name" type="text" maxlength="60" aria-label="Nombre"><input class="evaluation-date" type="date" required aria-label="Fecha"><button class="remove-evaluation" type="button" aria-label="Eliminar">×</button>';
      row.querySelector(".evaluation-name").value = evaluation.name;
      row.querySelector(".evaluation-date").value = evaluation.date;
      elements.evaluationList.append(row);
    }
  }

  function addEvaluation() {
    const subject = subjectById(elements.detailId.value);
    if (!subject) return;
    const date = new Date();
    date.setDate(date.getDate() + 14);
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    subject.evaluations.push({ id: createId(), name: "", date: value });
    rebuildRing();
    renderEvaluations(subject);
    elements.evaluationList.lastElementChild?.querySelector(".evaluation-name")?.focus();
  }

  function handleEvaluationAction(event) {
    const row = event.target.closest(".evaluation-row");
    if (!row || !event.target.closest(".remove-evaluation")) return;
    const subject = subjectById(elements.detailId.value);
    if (!subject) return;
    subject.evaluations = subject.evaluations.filter((item) => item.id !== row.dataset.evaluationId);
    rebuildRing();
    renderEvaluations(subject);
    render();
  }

  function saveEvaluations() {
    const subject = subjectById(elements.detailId.value);
    if (!subject) return;
    const evaluations = [...elements.evaluationList.querySelectorAll(".evaluation-row")].map((row) => ({
      id: row.dataset.evaluationId,
      name: normalizeName(row.querySelector(".evaluation-name").value).slice(0, 60),
      date: row.querySelector(".evaluation-date").value,
    }));
    if (evaluations.some((item) => !Scheduler.parseLocalDate(item.date))) {
      elements.detailError.textContent = "Cada evaluación necesita una fecha válida.";
      return;
    }
    subject.evaluations = evaluations;
    rebuildRing();
    render();
  }

  function openSettings() {
    elements.cycleSize.value = String(state.settings.cycleSize);
    elements.urgencyK.value = String(state.settings.urgencyK);
    elements.settingsError.textContent = "";
    elements.settingsDialog.showModal();
  }

  function saveSettings(event) {
    event.preventDefault();
    const cycleSize = Number(elements.cycleSize.value);
    const urgencyK = Number(elements.urgencyK.value);
    if (!Number.isInteger(cycleSize) || cycleSize < 1 || cycleSize > 100 || !Number.isFinite(urgencyK) || urgencyK < 0 || urgencyK > 100) {
      elements.settingsError.textContent = "Usá 1–100 turnos y una agresividad entre 0 y 100.";
      return;
    }
    state.settings = { cycleSize, urgencyK };
    rebuildRing();
    elements.settingsDialog.close();
    render();
  }

  function toggleColorPicker() {
    if (elements.colorPicker.hidden) openColorPicker();
    else closeColorPicker();
  }

  function openColorPicker() {
    syncColorPicker(elements.detailColor.value);
    elements.colorPicker.hidden = false;
    elements.colorButton.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => elements.colorHue.focus());
  }

  function closeColorPicker(commit = true) {
    if (elements.colorPicker.hidden) return;
    if (commit) commitColorPickerValue();
    elements.colorPicker.hidden = true;
    elements.colorButton.setAttribute("aria-expanded", "false");
  }

  function closeColorPickerOnOutsidePress(event) {
    if (
      elements.colorPicker.hidden ||
      elements.colorPicker.contains(event.target) ||
      elements.colorButton.contains(event.target)
    ) {
      return;
    }
    closeColorPicker();
  }

  function handleColorPickerInput(event) {
    if (event.target === elements.colorHex) {
      const value = parseColorInput(elements.colorHex.value);
      if (!value) return;
      elements.detailColor.value = value;
      updateColorButton(value);
      syncColorSliders(value);
      setColorInputValidity(true);
      return;
    }

    if (
      event.target !== elements.colorHue &&
      event.target !== elements.colorSaturation &&
      event.target !== elements.colorLightness
    ) {
      return;
    }

    const color = hslToHex(
      Number(elements.colorHue.value),
      Number(elements.colorSaturation.value),
      Number(elements.colorLightness.value),
    );
    elements.detailColor.value = color;
    elements.colorHex.value = color.toUpperCase();
    setColorInputValidity(true);
    updateColorButton(color);
    updateColorSliderBackgrounds();
  }

  function handleColorHexChange() {
    const value = parseColorInput(elements.colorHex.value);
    if (!value) {
      setColorInputValidity(false);
      return;
    }
    elements.detailColor.value = value;
    elements.colorHex.value = value.toUpperCase();
    setColorInputValidity(true);
    updateColorButton(value);
    syncColorSliders(value);
    commitColorPickerValue();
  }

  function commitColorPickerValue() {
    const subject = subjectById(elements.detailId.value);
    const color = parseColorInput(elements.detailColor.value);
    if (!subject || !color || subject.color === color) return;
    subject.color = color;
    saveState();
    render();
  }

  function syncColorPicker(color) {
    const normalized = parseColorInput(color) || PALETTE[0];
    elements.detailColor.value = normalized;
    elements.colorHex.value = normalized.toUpperCase();
    setColorInputValidity(true);
    updateColorButton(normalized);
    syncColorSliders(normalized);
  }

  function syncColorSliders(color) {
    const { hue, saturation, lightness } = hexToHsl(color);
    elements.colorHue.value = String(Math.round(hue));
    elements.colorSaturation.value = String(Math.round(saturation));
    elements.colorLightness.value = String(Math.round(lightness));
    updateColorSliderBackgrounds();
  }

  function updateColorButton(color) {
    elements.colorButton.style.setProperty("--selected-color", color);
  }

  function updateColorSliderBackgrounds() {
    elements.colorPicker.style.setProperty("--picker-hue", elements.colorHue.value);
    elements.colorPicker.style.setProperty(
      "--picker-saturation",
      `${elements.colorSaturation.value}%`,
    );
  }

  function setColorInputValidity(valid) {
    elements.colorHex.setAttribute("aria-invalid", valid ? "false" : "true");
    elements.colorInputError.textContent = valid
      ? ""
      : "Usá #RRGGBB o R, G, B.";
  }

  function parseColorInput(value) {
    const normalized = String(value || "").trim();
    if (normalized.startsWith("#")) {
      if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized.toLowerCase();
      if (/^#[0-9a-f]{3}$/i.test(normalized)) {
        return `#${normalized
          .slice(1)
          .split("")
          .map((digit) => digit.repeat(2))
          .join("")}`.toLowerCase();
      }
      return null;
    }

    if (!normalized.includes(",")) return null;
    const channels = normalized.split(",").map((channel) => channel.trim());
    if (
      channels.length !== 3 ||
      channels.some((channel) => !/^\d{1,3}$/.test(channel) || Number(channel) > 255)
    ) {
      return null;
    }
    return `#${channels
      .map((channel) => Number(channel).toString(16).padStart(2, "0"))
      .join("")}`;
  }

  function hexToHsl(color) {
    const red = parseInt(color.slice(1, 3), 16) / 255;
    const green = parseInt(color.slice(3, 5), 16) / 255;
    const blue = parseInt(color.slice(5, 7), 16) / 255;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const lightness = (maximum + minimum) / 2;
    const delta = maximum - minimum;
    if (delta === 0) return { hue: 0, saturation: 0, lightness: lightness * 100 };

    const saturation = delta / (1 - Math.abs(2 * lightness - 1));
    let hue;
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
    if (hue < 0) hue += 360;
    return { hue, saturation: saturation * 100, lightness: lightness * 100 };
  }

  function hslToHex(hue, saturation, lightness) {
    const normalizedSaturation = saturation / 100;
    const normalizedLightness = lightness / 100;
    const chroma = (1 - Math.abs(2 * normalizedLightness - 1)) * normalizedSaturation;
    const section = hue / 60;
    const intermediate = chroma * (1 - Math.abs((section % 2) - 1));
    let red = 0;
    let green = 0;
    let blue = 0;
    if (section < 1) [red, green] = [chroma, intermediate];
    else if (section < 2) [red, green] = [intermediate, chroma];
    else if (section < 3) [green, blue] = [chroma, intermediate];
    else if (section < 4) [green, blue] = [intermediate, chroma];
    else if (section < 5) [red, blue] = [intermediate, chroma];
    else [red, blue] = [chroma, intermediate];
    const match = normalizedLightness - chroma / 2;
    return `#${[red, green, blue]
      .map((component) => Math.round((component + match) * 255).toString(16).padStart(2, "0"))
      .join("")}`;
  }

  function handleDetailNameKeydown(event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (saveSubjectDetails()) elements.detailName.blur();
  }

  function saveSubjectDetails(event) {
    event?.preventDefault();
    const subject = subjectById(elements.detailId.value);
    if (!subject) {
      elements.detailDialog.close();
      return false;
    }

    const name = normalizeName(elements.detailName.value);
    if (!name) {
      elements.detailError.textContent = "El nombre no puede quedar vacío.";
      elements.detailName.focus();
      return false;
    }
    if (isDuplicateName(name, subject.id)) {
      elements.detailError.textContent = "Ya existe otra materia con ese nombre.";
      elements.detailName.select();
      return false;
    }

    const nextColor = normalizeColor(elements.detailColor.value, 0);
    const scheduleChanged = false;
    subject.name = name;
    subject.color = nextColor;
    elements.detailError.textContent = "";
    if (scheduleChanged) rebuildRing();
    else saveState();
    render();
    return true;
  }

  function deleteSelectedSubject() {
    const subject = subjectById(elements.detailId.value);
    if (!subject) return;
    if (!window.confirm(`¿Eliminar “${subject.name}” de la cola?`)) return;

    const subjectIndex = state.subjects.findIndex((item) => item.id === subject.id);
    if (subjectIndex >= 0 && subjectIndex < state.dockSplitIndex) {
      state.dockSplitIndex -= 1;
    }
    state.subjects = state.subjects.filter((item) => item.id !== subject.id);
    state.ring = state.ring.filter((id) => id !== subject.id);
    rebuildRing();
    elements.detailDialog.close();
    render();
  }

  function handlePointerDown(event) {
    const card = event.target.closest('.queue-card[data-position="0"]');
    if (!card || event.button !== 0 || isAnimating) return;
    drag = {
      pointerId: event.pointerId,
      card,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      deltaX: 0,
      deltaY: 0,
      moved: false,
      held: false,
      samples: [{ x: event.clientX, y: event.clientY, time: performance.now() }],
      holdTimer: window.setTimeout(() => activateHold(event.pointerId), HOLD_DELAY),
    };
    card.setPointerCapture(event.pointerId);
  }

  function activateHold(pointerId) {
    if (!drag || drag.pointerId !== pointerId || drag.held) return;
    drag.held = true;
    suppressClick = true;
    drag.card.classList.add("is-held");
  }

  function handlePointerMove(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const rawDeltaY = event.clientY - drag.startY;
    drag.currentX = event.clientX;
    drag.currentY = event.clientY;
    drag.deltaX = deltaX;
    drag.deltaY = rawDeltaY;
    recordPointerSample(drag, event.clientX, event.clientY);
    if (!drag.moved && Math.hypot(deltaX, rawDeltaY) > CLICK_THRESHOLD) {
      drag.moved = true;
      activateHold(event.pointerId);
      drag.card.classList.add("is-dragging");
    }
    if (!drag.moved) return;

    const progress = Math.min(1, Math.hypot(drag.deltaX, drag.deltaY) / DRAG_THRESHOLD);
    const tilt = Math.max(-3, Math.min(3, deltaX / 45));
    drag.card.style.transform = `translate(${drag.deltaX}px, ${drag.deltaY - HOLD_LIFT}px) rotate(${tilt}deg) scale(1.012)`;
    drag.card.style.opacity = String(1 - progress * 0.12);
  }

  function recordPointerSample(activeDrag, x, y) {
    const now = performance.now();
    activeDrag.samples.push({ x, y, time: now });
    activeDrag.samples = activeDrag.samples.filter((sample) => now - sample.time <= 120);
  }

  function releaseVelocity(activeDrag, x, y) {
    recordPointerSample(activeDrag, x, y);
    const latest = activeDrag.samples.at(-1);
    const earliest = activeDrag.samples.find((sample) => latest.time - sample.time >= 24) || activeDrag.samples[0];
    const elapsed = Math.max(16, latest.time - earliest.time);
    return {
      x: (latest.x - earliest.x) / elapsed,
      y: (latest.y - earliest.y) / elapsed,
    };
  }

  function handlePointerUp(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const currentDrag = drag;
    drag = null;
    window.clearTimeout(currentDrag.holdTimer);
    currentDrag.deltaX = event.clientX - currentDrag.startX;
    currentDrag.deltaY = event.clientY - currentDrag.startY;
    const velocity = releaseVelocity(currentDrag, event.clientX, event.clientY);

    if (currentDrag.card.hasPointerCapture(event.pointerId)) {
      currentDrag.card.releasePointerCapture(event.pointerId);
    }
    currentDrag.card.classList.remove("is-dragging", "is-held");

    const upwardThrow = currentDrag.deltaY <= -DRAG_THRESHOLD || velocity.y <= -0.45;
    const sidewaysThrow =
      Math.abs(currentDrag.deltaX) >= 24 && Math.abs(velocity.x) >= 0.65 && velocity.y <= 0.2;

    if (currentDrag.moved && (upwardThrow || sidewaysThrow)) {
      flingQueue(currentDrag, velocity);
    } else if (currentDrag.moved || currentDrag.held) {
      returnCard(
        currentDrag.card,
        currentDrag.deltaX,
        currentDrag.deltaY - HOLD_LIFT,
        Math.max(-3, Math.min(3, currentDrag.deltaX / 45)),
      );
    }

    window.setTimeout(() => {
      suppressClick = false;
    }, 0);
  }

  function cancelDrag(event) {
    if (!drag || (event.pointerId !== undefined && drag.pointerId !== event.pointerId)) return;
    const currentDrag = drag;
    drag = null;
    window.clearTimeout(currentDrag.holdTimer);
    currentDrag.card.classList.remove("is-dragging", "is-held");
    returnCard(
      currentDrag.card,
      currentDrag.deltaX,
      currentDrag.deltaY - (currentDrag.held ? HOLD_LIFT : 0),
      Math.max(-3, Math.min(3, currentDrag.deltaX / 45)),
    );
    window.setTimeout(() => {
      suppressClick = false;
    }, 0);
  }

  function returnCard(card, fromX, fromY, rotation = 0) {
    card.style.removeProperty("transform");
    card.style.removeProperty("opacity");
    card.style.setProperty("--return-x", `${fromX}px`);
    card.style.setProperty("--return-y", `${fromY}px`);
    card.style.setProperty("--return-rotation", `${rotation}deg`);
    card.classList.add("is-returning");
    window.setTimeout(() => card.classList.remove("is-returning"), 290);
  }

  function flingQueue(activeDrag, velocity) {
    if (isAnimating || state.ring.length === 0) return;
    isAnimating = true;
    if (ANIMATION_MS === 0) {
      completeAdvance();
      return;
    }

    const card = activeDrag.card;
    const speed = Math.hypot(velocity.x, velocity.y);
    let directionX = speed > 0.18 ? velocity.x / speed : activeDrag.deltaX;
    let directionY = speed > 0.18 ? velocity.y / speed : activeDrag.deltaY;
    const directionLength = Math.hypot(directionX, directionY) || 1;
    directionX /= directionLength;
    directionY /= directionLength;
    const travel = Math.max(window.innerWidth, window.innerHeight) * 1.35;
    const duration = Math.round(Math.max(280, Math.min(480, 440 - speed * 90)));
    const startX = activeDrag.deltaX;
    const startY = activeDrag.deltaY - HOLD_LIFT;
    const endX = startX + directionX * travel;
    const endY = startY + directionY * travel + 36;
    const initialRotation = Math.max(-3, Math.min(3, activeDrag.deltaX / 45));
    const rotationDirection = Math.sign(velocity.x || activeDrag.deltaX || 1);

    elements.queue.classList.add("is-flinging");
    const animation = card.animate(
      [
        {
          transform: `translate(${startX}px, ${startY}px) rotate(${initialRotation}deg) scale(1.012)`,
          opacity: 0.88,
        },
        {
          transform: `translate(${startX + directionX * travel * 0.58}px, ${startY + directionY * travel * 0.58 + 10}px) rotate(${initialRotation + rotationDirection * 7}deg) scale(1.012)`,
          opacity: 0.72,
          offset: 0.58,
        },
        {
          transform: `translate(${endX}px, ${endY}px) rotate(${initialRotation + rotationDirection * 14}deg) scale(1.012)`,
          opacity: 0,
        },
      ],
      {
        duration,
        easing: "cubic-bezier(0.16, 0.72, 0.25, 1)",
        fill: "forwards",
      },
    );

    animation.addEventListener("finish", completeAdvance, { once: true });
    animation.addEventListener("cancel", completeAdvance, { once: true });
  }

  function completeAdvance() {
    if (!isAnimating) return;
    if (state.ring.length) state.ring.push(state.ring.shift());
    saveState();
    elements.queue.classList.remove("is-advancing", "is-flinging");
    isAnimating = false;
    render();
    elements.queue.querySelector('.queue-card[data-position="0"]')?.focus({ preventScroll: true });
  }

  function advanceQueue() {
    if (isAnimating || state.ring.length === 0) return;
    isAnimating = true;
    const headCard = elements.queue.querySelector('.queue-card[data-position="0"]');
    headCard?.style.removeProperty("transform");
    headCard?.style.removeProperty("opacity");
    elements.queue.classList.add("is-advancing");

    window.setTimeout(() => {
      completeAdvance();
    }, ANIMATION_MS);
  }

  function handleQueueKeydown(event) {
    const card = event.target.closest('.queue-card[data-position="0"]');
    if (!card || event.key !== "ArrowUp") return;
    event.preventDefault();
    advanceQueue();
  }

  function handleGlobalKeydown(event) {
    if (!storageReady) return;
    if (event.key === "Escape" && !elements.colorPicker.hidden) {
      event.preventDefault();
      event.stopPropagation();
      closeColorPicker();
      elements.colorButton.focus();
      return;
    }
    if (event.key === "|" && !elements.addDialog.open && !elements.detailDialog.open && !elements.settingsDialog.open) {
      event.preventDefault();
      openSettings();
      return;
    }
    if (event.key !== "+" || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    const isTyping =
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement ||
      target?.isContentEditable;
    if (isTyping || elements.addDialog.open || elements.detailDialog.open) return;
    event.preventDefault();
    openAddDialog();
  }

  function refreshAfterVisibilityChange() {
    if (document.visibilityState !== "visible") return;
    if (!storageReady) {
      folderStorage.initialize(state).then(applyStorageResult);
      return;
    }
    if (ensureFreshRing()) render();
    scheduleDayRefresh();
  }

  function scheduleDayRefresh() {
    window.clearTimeout(dayRefreshTimer);
    const now = new Date();
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 50);
    dayRefreshTimer = window.setTimeout(() => {
      ensureFreshRing(true);
      render();
      scheduleDayRefresh();
    }, nextDay.getTime() - now.getTime());
  }

})();
