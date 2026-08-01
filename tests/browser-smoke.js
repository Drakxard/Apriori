const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const port = 9500 + Math.floor(Math.random() * 400);
const webPort = 9350;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "apriori-minimal-"));
const screenshotPath = path.join(os.tmpdir(), "apriori-minimal-preview.png");
const projectRoot = path.resolve(__dirname, "..");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};
const server = http.createServer((request, response) => {
  const relativePath = request.url === "/" ? "index.html" : request.url.slice(1).split("?")[0];
  const filePath = path.resolve(projectRoot, relativePath);
  if (!filePath.startsWith(projectRoot) || !fs.existsSync(filePath)) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("Content-Type", contentTypes[path.extname(filePath)] || "application/octet-stream");
  fs.createReadStream(filePath).pipe(response);
});
let browser = null;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(webPort, "127.0.0.1", resolve);
  });
  const pageUrl = `http://127.0.0.1:${webPort}/index.html`;
  browser = spawn(
    edge,
    [
      "--headless=new",
      "--disable-gpu",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=542,600",
      pageUrl,
    ],
    { stdio: "ignore", windowsHide: true },
  );
  let page;
  for (let attempt = 0; attempt < 50 && !page; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = targets.find((target) => target.type === "page" && target.url === pageUrl);
    } catch {}
    if (!page) await delay(100);
  }
  if (!page) throw new Error("No se encontró la página");

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!pending.has(message.id)) return;
    const task = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error.message));
    else task.resolve(message.result);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description || response.exceptionDetails.text,
      );
    }
    return response.result.value;
  };

  let pageInfo;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    pageInfo = await evaluate("({ url: location.href, origin: location.origin, secure: isSecureContext, title: document.title })");
    if (pageInfo.url === pageUrl) break;
    await delay(50);
  }
  try {
    await evaluate("localStorage.clear(); true");
  } catch (error) {
    throw new Error(`No se pudo preparar el origen de prueba ${JSON.stringify(pageInfo)}: ${error.message}`);
  }
  await evaluate("location.reload(); true").catch(() => undefined);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const initialized = await evaluate("document.querySelector('#storageDialog').open");
    if (initialized) break;
    await delay(50);
  }

  const initialGate = await evaluate(`({
    blocked: document.body.classList.contains('storage-blocked'),
    dialogOpen: document.querySelector('#storageDialog').open,
    message: document.querySelector('#storageMessage').textContent,
    primary: document.querySelector('#storagePrimaryButton').textContent.trim()
  })`);
  if (!initialGate.blocked || !initialGate.dialogOpen || initialGate.primary !== "Elegir carpeta") {
    throw new Error(`No apareció la selección inicial: ${JSON.stringify(initialGate)}`);
  }

  const opfsCapabilities = await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    return {
      values: typeof root.values,
      entries: typeof root.entries,
      queryPermission: typeof root.queryPermission
    };
  })()`);
  await evaluate(`(() => {
    window.showDirectoryPicker = async () => navigator.storage.getDirectory();
    document.querySelector('#storagePrimaryButton').click();
  })()`);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ready = await evaluate("!document.body.classList.contains('storage-blocked')");
    if (ready) break;
    await delay(50);
  }
  const gateAfterSelection = await evaluate(`({
    blocked: document.body.classList.contains('storage-blocked'),
    dialogOpen: document.querySelector('#storageDialog').open,
    message: document.querySelector('#storageMessage').textContent,
    error: document.querySelector('#storageError').textContent
  })`);
  if (gateAfterSelection.blocked) {
    throw new Error(`La selección de prueba no se completó: ${JSON.stringify({ gateAfterSelection, opfsCapabilities })}`);
  }
  const folderConnected = await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('apriori.json');
    const documentValue = JSON.parse(await (await handle.getFile()).text());
    return {
      ready: !document.body.classList.contains('storage-blocked'),
      dialogOpen: document.querySelector('#storageDialog').open,
      format: documentValue.format,
      version: documentValue.version
    };
  })()`);
  if (
    !folderConnected.ready ||
    folderConnected.dialogOpen ||
    folderConnected.format !== "apriori.study-queue" ||
    folderConnected.version !== 1
  ) {
    throw new Error(`No se conectó la carpeta: ${JSON.stringify(folderConnected)}`);
  }

  const empty = await evaluate(`({
    cards: document.querySelectorAll('.queue-card').length,
    addButton: Boolean(document.querySelector('#addButton')),
    headers: document.querySelectorAll('header, h1, .queue-heading, .queue-help, .keyboard-tip').length,
    background: getComputedStyle(document.body).backgroundColor
  })`);
  if (
    empty.cards !== 0 ||
    empty.addButton ||
    empty.headers !== 0 ||
    empty.background !== "rgb(255, 255, 255)"
  ) {
    throw new Error(`El estado vacío no es minimalista: ${JSON.stringify(empty)}`);
  }

  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "+",
    code: "NumpadAdd",
    windowsVirtualKeyCode: 107,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "+",
    code: "NumpadAdd",
    windowsVirtualKeyCode: 107,
  });
  await delay(60);
  const addOpened = await evaluate(
    "document.querySelector('#addDialog').open && document.activeElement.id === 'newSubjectName'",
  );
  if (!addOpened) throw new Error("La tecla + no abrió y enfocó el alta");

  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await delay(40);
  if (await evaluate("document.querySelector('#addDialog').open")) {
    throw new Error("Escape no canceló el alta");
  }

  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }))");
  await send("Input.insertText", { text: "Estructuras Organizacionales" });
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await delay(80);
  const firstAdded = await evaluate(
    "!document.querySelector('#addDialog').open && document.querySelectorAll('.queue-card').length === 5",
  );
  if (!firstAdded) throw new Error("Enter no agregó la primera materia");

  const duplicateRejected = await evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    document.querySelector('#newSubjectName').value = 'estructuras organizacionales';
    document.querySelector('#addForm').requestSubmit();
    const rejected = document.querySelector('#addDialog').open && Boolean(document.querySelector('#addError').textContent);
    document.querySelector('#addDialog').close();
    return rejected;
  })()`);
  if (!duplicateRejected) throw new Error("No se rechazó el nombre duplicado");

  await evaluate(`(() => {
    const add = (name) => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
      document.querySelector('#newSubjectName').value = name;
      document.querySelector('#addForm').requestSubmit();
    };
    add('Lógica Binaria');
    add('Programación 3');
    add('Álgebra 2');
    add('Ingeniería de Gestión');
  })()`);

  const visual = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.queue-card')];
    const style = getComputedStyle(cards[0]);
    return {
      count: cards.length,
      labels: cards.map((card) => card.textContent.trim()),
      colors: cards.map((card) => getComputedStyle(card).backgroundColor),
      width: style.width,
      height: style.height,
      border: style.borderTopWidth + ' ' + style.borderTopStyle + ' ' + style.borderTopColor,
      radius: style.borderRadius,
      shadow: style.boxShadow,
      fontSize: getComputedStyle(cards[0].querySelector('.card-label')).fontSize,
      gap: getComputedStyle(document.querySelector('#queue')).gap,
      badges: document.querySelectorAll('.ticket-badge').length
    };
  })()`);
  const expectedLabels = ["EO", "LB", "P3", "A2", "IG"];
  const expectedColors = [
    "rgb(19, 168, 224)",
    "rgb(181, 235, 22)",
    "rgb(191, 131, 95)",
    "rgb(197, 190, 225)",
    "rgb(255, 202, 26)",
  ];
  if (
    visual.count !== 5 ||
    JSON.stringify(visual.labels) !== JSON.stringify(expectedLabels) ||
    JSON.stringify(visual.colors) !== JSON.stringify(expectedColors) ||
    visual.width !== "336px" ||
    visual.height !== "88px" ||
    visual.border !== "4px solid rgb(0, 0, 0)" ||
    visual.radius !== "0px" ||
    visual.shadow !== "none" ||
    visual.fontSize !== "40px" ||
    visual.gap !== "6px" ||
    visual.badges !== 0
  ) {
    throw new Error(`La composición no coincide: ${JSON.stringify(visual)}`);
  }

  await send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 700,
    deviceScaleFactor: 1,
    mobile: true,
  });
  const mobile = await evaluate(`(() => {
    const card = document.querySelector('.queue-card');
    return {
      width: getComputedStyle(card).width,
      height: getComputedStyle(card).height,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
  if (mobile.width !== "328px" || mobile.height !== "84px" || mobile.overflow) {
    throw new Error(`La composición móvil no coincide: ${JSON.stringify(mobile)}`);
  }
  await send("Emulation.clearDeviceMetricsOverride");

  const dock = await evaluate(`(async () => {
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      clientX: innerWidth / 2,
      clientY: innerHeight - 2
    }));
    const cards = [...document.querySelectorAll('.subject-dock-card')];
    const ids = cards.map((card) => card.dataset.subjectId);
    cards[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
    cards[4].dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: cards[4].getBoundingClientRect().right
    }));
    cards[1].dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reorderedCards = [...document.querySelectorAll('.subject-dock-card')];
    const reorderedIds = reorderedCards.map((card) => card.dataset.subjectId);
    reorderedCards.at(-1).click();
    const persistedIds = JSON.parse(localStorage.getItem('study-ticket-queue:v1')).subjects
      .map((subject) => subject.id);
    return {
      visible: document.body.classList.contains('dock-visible'),
      count: cards.length,
      unique: new Set(ids).size,
      reordered: reorderedIds.at(-1) === ids[1],
      persisted: JSON.stringify(reorderedIds) === JSON.stringify(persistedIds),
      detailOpen: document.querySelector('#detailDialog').open,
      selectedId: document.querySelector('#detailId').value,
      clickedId: ids[1]
    };
  })()`);
  if (
    !dock.visible ||
    dock.count !== 5 ||
    dock.unique !== 5 ||
    !dock.reordered ||
    !dock.persisted ||
    !dock.detailOpen ||
    dock.selectedId !== dock.clickedId
  ) {
    throw new Error(`Falló la bandeja inferior: ${JSON.stringify(dock)}`);
  }
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });

  await evaluate(`(() => {
    const add = (name) => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
      document.querySelector('#newSubjectName').value = name;
      document.querySelector('#addForm').requestSubmit();
    };
    add('Cálculo 3');
    add('Planificación Estratégica');
    add('Física 1');
  })()`);
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const dockGroups = await evaluate(`(() => {
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      clientX: innerWidth / 2,
      clientY: innerHeight - 2
    }));
    const cards = [...document.querySelectorAll('.subject-dock-card')];
    const bounds = cards.map((card) => card.getBoundingClientRect());
    return {
      labels: cards.map((card) => card.textContent.trim()),
      leftGap: bounds[5].left - bounds[4].right,
      leftEdge: bounds[0].left,
      rightEdge: innerWidth - bounds.at(-1).right,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`);
  if (
    JSON.stringify(dockGroups.labels.slice(5)) !== JSON.stringify(["C3", "PE", "F1"]) ||
    dockGroups.leftGap < 100 ||
    dockGroups.leftEdge !== 12 ||
    dockGroups.rightEdge !== 12 ||
    dockGroups.overflow
  ) {
    throw new Error(`La bandeja no se separó en dos grupos: ${JSON.stringify(dockGroups)}`);
  }
  await send("Emulation.clearDeviceMetricsOverride");

  const detail = await evaluate(`(() => {
    document.querySelector('.queue-card[data-position="0"]').click();
    const input = document.querySelector('#detailName');
    input.value = 'Estructuras y Organizaciones';
    input.dispatchEvent(new Event('blur'));
    const day = document.querySelector('#detailClassDay');
    day.value = '3';
    day.dispatchEvent(new Event('change', { bubbles: true }));
    const date = document.querySelector('#detailExamDate');
    date.value = '2026-08-15';
    date.dispatchEvent(new Event('change', { bubbles: true }));
    const color = document.querySelector('#detailColor');
    color.value = '#e45b9d';
    color.dispatchEvent(new Event('change', { bubbles: true }));
    const saved = JSON.parse(localStorage.getItem('study-ticket-queue:v1')).subjects[0];
    const panelStyle = getComputedStyle(document.querySelector('#detailDialog'));
    return {
      open: document.querySelector('#detailDialog').open,
      name: saved.name,
      classDay: saved.classDay,
      examDate: saved.examDate,
      color: saved.color,
      colorControl: {
        width: getComputedStyle(color).width,
        height: getComputedStyle(color).height,
        border: getComputedStyle(color).borderTopWidth,
        radius: getComputedStyle(color).borderRadius
      },
      border: panelStyle.borderTopWidth,
      radius: panelStyle.borderRadius,
      shadow: panelStyle.boxShadow
    };
  })()`);
  if (
    !detail.open ||
    detail.name !== "Estructuras y Organizaciones" ||
    detail.classDay !== 3 ||
    detail.examDate !== "2026-08-15" ||
    detail.color !== "#e45b9d" ||
    detail.colorControl.width !== "42px" ||
    detail.colorControl.height !== "42px" ||
    detail.colorControl.border !== "4px" ||
    detail.colorControl.radius !== "0px" ||
    detail.border !== "4px" ||
    detail.radius !== "0px" ||
    detail.shadow !== "none"
  ) {
    throw new Error(`Falló el detalle autosave: ${JSON.stringify(detail)}`);
  }
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await delay(40);
  if (await evaluate("document.querySelector('#detailDialog').open")) {
    throw new Error("Escape no cerró el detalle");
  }

  const before = await evaluate(
    "JSON.parse(localStorage.getItem('study-ticket-queue:v1')).ring",
  );
  const rect = await evaluate(`(() => {
    const value = document.querySelector('.queue-card[data-position="0"]').getBoundingClientRect();
    return { x: value.x + value.width / 2, y: value.y + value.height / 2 };
  })()`);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  await delay(180);
  const held = await evaluate(`(() => {
    const card = document.querySelector('.queue-card[data-position="0"]');
    const style = getComputedStyle(card);
    return {
      active: card.classList.contains('is-held'),
      transform: style.transform,
      shadow: style.boxShadow
    };
  })()`);
  if (!held.active || held.transform === "none" || held.shadow === "none") {
    throw new Error(`La tarjeta no entró en estado sostenido: ${JSON.stringify(held)}`);
  }
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  await delay(300);
  const afterHold = await evaluate(`({
    ring: JSON.parse(localStorage.getItem('study-ticket-queue:v1')).ring,
    detailOpen: document.querySelector('#detailDialog').open,
    held: document.querySelector('.queue-card[data-position="0"]').classList.contains('is-held')
  })`);
  if (
    JSON.stringify(afterHold.ring) !== JSON.stringify(before) ||
    afterHold.detailOpen ||
    afterHold.held
  ) {
    throw new Error(`Soltar una tarjeta sostenida alteró el estado: ${JSON.stringify(afterHold)}`);
  }

  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: rect.x,
    y: rect.y - 30,
    button: "left",
    buttons: 1,
  });
  await delay(180);
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y - 30,
    button: "left",
    clickCount: 1,
  });
  await delay(300);
  const afterCancelledDrag = await evaluate(
    "JSON.parse(localStorage.getItem('study-ticket-queue:v1')).ring",
  );
  if (JSON.stringify(afterCancelledDrag) !== JSON.stringify(before)) {
    throw new Error("Un arrastre corto modificó la cola");
  }

  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: rect.x + 95,
    y: rect.y - 75,
    button: "left",
    buttons: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x + 95,
    y: rect.y - 75,
    button: "left",
    clickCount: 1,
  });
  await delay(60);
  const trajectory = await evaluate(`(() => {
    const card = document.querySelector('.queue-card[data-position="0"]');
    const matrix = new DOMMatrix(getComputedStyle(card).transform);
    return {
      flinging: document.querySelector('#queue').classList.contains('is-flinging'),
      x: matrix.m41,
      y: matrix.m42,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      verticalOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    };
  })()`);
  if (
    !trajectory.flinging ||
    trajectory.x <= 95 ||
    trajectory.y >= -75 ||
    trajectory.horizontalOverflow ||
    trajectory.verticalOverflow ||
    trajectory.scrollX !== 0 ||
    trajectory.scrollY !== 0
  ) {
    throw new Error(`La tarjeta no siguió la trayectoria diagonal: ${JSON.stringify(trajectory)}`);
  }
  await delay(450);
  const after = await evaluate(
    "JSON.parse(localStorage.getItem('study-ticket-queue:v1')).ring",
  );
  if (after.at(-1) !== before[0] || after[0] !== before[1]) {
    throw new Error("El arrastre no rotó la cola");
  }

  const capture = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  fs.writeFileSync(screenshotPath, Buffer.from(capture.data, "base64"));

  await delay(120);
  const folderBeforeReload = await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('apriori.json');
    return JSON.parse(await (await handle.getFile()).text()).state;
  })()`);
  await evaluate(`(() => {
    localStorage.setItem('study-ticket-queue:v1', JSON.stringify({
      version: 1,
      subjects: [],
      ring: [],
      weightSignature: ''
    }));
    location.reload();
  })()`);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ready = await evaluate("!document.body.classList.contains('storage-blocked')");
    if (ready) break;
    await delay(50);
  }
  const reopened = await evaluate(`(() => {
    const mirror = JSON.parse(localStorage.getItem('study-ticket-queue:v1'));
    return {
      blocked: document.body.classList.contains('storage-blocked'),
      storageDialogOpen: document.querySelector('#storageDialog').open,
      cards: document.querySelectorAll('.queue-card').length,
      subjects: mirror.subjects.length,
      ring: mirror.ring
    };
  })()`);
  if (
    reopened.blocked ||
    reopened.storageDialogOpen ||
    reopened.cards !== 5 ||
    reopened.subjects !== folderBeforeReload.subjects.length ||
    JSON.stringify(reopened.ring) !== JSON.stringify(folderBeforeReload.ring)
  ) {
    throw new Error(`No se reutilizó la carpeta al reabrir: ${JSON.stringify(reopened)}`);
  }

  console.log("Smoke test minimalista: OK");
  console.log(
    JSON.stringify(
      {
        initialGate,
        folderConnected,
        empty,
        duplicateRejected,
        visual,
        mobile,
        detail,
        holdLiftedCard: true,
        cancelledDragPreservedOrder: true,
        dragRotated: true,
        trajectory,
        folderReopenedWithoutPrompt: true,
        screenshotPath,
      },
      null,
      2,
    ),
  );
  socket.close();
}

main()
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  })
  .finally(() => {
    browser?.kill();
    server.close();
  });
