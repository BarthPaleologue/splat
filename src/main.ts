import { cameras } from './data/cameras';
import { getProjectionMatrix, getViewMatrix, multiply4, invert4, rotate4, translate4 } from './utils/matrix';
import { vertexShaderSource, fragmentShaderSource, createShader, createProgram } from './shaders/shaders';
import type { Camera, Matrix4, WorkerMessage, WorkerResponse } from './types';

console.log('🎯 Gaussian Splat Viewer - TypeScript version starting...');

// State variables
let camera: Camera = cameras[0]!;
const defaultViewMatrix: Matrix4 = [
  0.47, 0.04, 0.88, 0, -0.11, 0.99, 0.02, 0, -0.88, -0.11, 0.47, 0, 0.07,
  0.03, 6.55, 1,
];
let viewMatrix: Matrix4 = defaultViewMatrix;
let projectionMatrix: Matrix4;
let vertexCount = 0;

// Input handling
let activeKeys: string[] = [];
let currentCameraIndex = 0;
let carousel = true;
let jumpDelta = 0;
let startX = 0;
let startY = 0;
let down = 0;
let altX = 0;
let altY = 0;

// Performance tracking
let lastFrame = 0;
let avgFps = 0;
let start = 0;

// Gamepad state
let leftGamepadTrigger = false;
let rightGamepadTrigger = false;

// Worker and WebGL state
let worker: Worker;
let gl: WebGL2RenderingContext;
let program: WebGLProgram;
let texture: WebGLTexture;
let indexBuffer: WebGLBuffer;

// Uniform locations
let u_projection: WebGLUniformLocation;
let u_viewport: WebGLUniformLocation;
let u_focal: WebGLUniformLocation;
let u_view: WebGLUniformLocation;
let u_textureLocation: WebGLUniformLocation;

// Attribute locations
let a_position: number;
let a_index: number;

async function initializeWorker(): Promise<void> {
  // Create worker using Vite's worker import
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    if (e.data.buffer) {
      const splatData = new Uint8Array(e.data.buffer);
      if (e.data.save) {
        const blob = new Blob([splatData.buffer], {
          type: "application/octet-stream",
        });
        const link = document.createElement("a");
        link.download = "model.splat";
        link.href = URL.createObjectURL(blob);
        document.body.appendChild(link);
        link.click();
      }
    } else if (e.data.texdata) {
      const { texdata, texwidth, texheight } = e.data;
      if (texwidth && texheight) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA32UI,
          texwidth,
          texheight,
          0,
          gl.RGBA_INTEGER,
          gl.UNSIGNED_INT,
          texdata,
        );
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
      }
    } else if (e.data.depthIndex) {
      const { depthIndex } = e.data;
      gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, depthIndex, gl.DYNAMIC_DRAW);
      vertexCount = e.data.vertexCount!;
    }
  };
}

function initializeWebGL(): void {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  if (!canvas) throw new Error("Canvas not found");

  const context = canvas.getContext("webgl2", { antialias: false });
  if (!context) throw new Error("WebGL2 not supported");
  
  gl = context;

  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  program = createProgram(gl, vertexShader, fragmentShader);
  gl.useProgram(program);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(
    gl.ONE_MINUS_DST_ALPHA,
    gl.ONE,
    gl.ONE_MINUS_DST_ALPHA,
    gl.ONE,
  );
  gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);

  // Get uniform locations
  u_projection = gl.getUniformLocation(program, "projection")!;
  u_viewport = gl.getUniformLocation(program, "viewport")!;
  u_focal = gl.getUniformLocation(program, "focal")!;
  u_view = gl.getUniformLocation(program, "view")!;

  // Setup triangle vertices for quad rendering
  const triangleVertices = new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]);
  const vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, triangleVertices, gl.STATIC_DRAW);
  
  a_position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(a_position);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);

  // Setup texture
  texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  u_textureLocation = gl.getUniformLocation(program, "u_texture")!;
  gl.uniform1i(u_textureLocation, 0);

  // Setup index buffer
  indexBuffer = gl.createBuffer()!;
  a_index = gl.getAttribLocation(program, "index");
  gl.enableVertexAttribArray(a_index);
  gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
  gl.vertexAttribIPointer(a_index, 1, gl.INT, 0, 0);
  gl.vertexAttribDivisor(a_index, 1);
}

function resize(): void {
  gl.uniform2fv(u_focal, new Float32Array([camera.fx, camera.fy]));

  projectionMatrix = getProjectionMatrix(
    camera.fx,
    camera.fy,
    window.innerWidth,
    window.innerHeight,
  );

  gl.uniform2fv(u_viewport, new Float32Array([window.innerWidth, window.innerHeight]));

  const downsample = 1 / devicePixelRatio;
  gl.canvas.width = Math.round(window.innerWidth / downsample);
  gl.canvas.height = Math.round(window.innerHeight / downsample);
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

  gl.uniformMatrix4fv(u_projection, false, projectionMatrix);
}

function setupEventListeners(): void {
  window.addEventListener("resize", resize);

  // Keyboard events
  window.addEventListener("keydown", (e) => {
    carousel = false;
    if (!activeKeys.includes(e.code)) activeKeys.push(e.code);
    
    if (/\d/.test(e.key)) {
      currentCameraIndex = parseInt(e.key);
      camera = cameras[currentCameraIndex]!;
      viewMatrix = getViewMatrix(camera);
    }
    
    if (["-", "_"].includes(e.key)) {
      currentCameraIndex = (currentCameraIndex + cameras.length - 1) % cameras.length;
      viewMatrix = getViewMatrix(cameras[currentCameraIndex]!);
    }
    
    if (["+", "="].includes(e.key)) {
      currentCameraIndex = (currentCameraIndex + 1) % cameras.length;
      viewMatrix = getViewMatrix(cameras[currentCameraIndex]!);
    }
    
    const camidElement = document.getElementById("camid");
    if (camidElement) camidElement.innerText = "cam " + currentCameraIndex;
    
    if (e.code === "KeyV") {
      location.hash = "#" + JSON.stringify(
        viewMatrix.map((k) => Math.round(k * 100) / 100),
      );
      if (camidElement) camidElement.innerText = "";
    } else if (e.code === "KeyP") {
      carousel = true;
      if (camidElement) camidElement.innerText = "";
    }
  });

  window.addEventListener("keyup", (e) => {
    activeKeys = activeKeys.filter((k) => k !== e.code);
  });

  window.addEventListener("blur", () => {
    activeKeys = [];
  });

  // Mouse wheel events
  window.addEventListener("wheel", (e) => {
    carousel = false;
    e.preventDefault();
    
    const lineHeight = 10;
    const scale = e.deltaMode === 1 ? lineHeight : e.deltaMode === 2 ? window.innerHeight : 1;
    let inv = invert4(viewMatrix);
    
    if (!inv) return;
    
    if (e.shiftKey) {
      inv = translate4(
        inv,
        (e.deltaX * scale) / window.innerWidth,
        (e.deltaY * scale) / window.innerHeight,
        0,
      );
    } else if (e.ctrlKey || e.metaKey) {
      inv = translate4(
        inv,
        0,
        0,
        (-10 * (e.deltaY * scale)) / window.innerHeight,
      );
    } else {
      const d = 4;
      inv = translate4(inv, 0, 0, d);
      inv = rotate4(inv, -(e.deltaX * scale) / window.innerWidth, 0, 1, 0);
      inv = rotate4(inv, (e.deltaY * scale) / window.innerHeight, 1, 0, 0);
      inv = translate4(inv, 0, 0, -d);
    }

    viewMatrix = invert4(inv)!;
  }, { passive: false });

  // Mouse events
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  
  canvas.addEventListener("mousedown", (e) => {
    carousel = false;
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    down = e.ctrlKey || e.metaKey ? 2 : 1;
  });

  canvas.addEventListener("contextmenu", (e) => {
    carousel = false;
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    down = 2;
  });

  canvas.addEventListener("mousemove", (e) => {
    e.preventDefault();
    if (down === 1) {
      let inv = invert4(viewMatrix);
      if (!inv) return;
      
      const dx = (5 * (e.clientX - startX)) / window.innerWidth;
      const dy = (5 * (e.clientY - startY)) / window.innerHeight;
      const d = 4;

      inv = translate4(inv, 0, 0, d);
      inv = rotate4(inv, dx, 0, 1, 0);
      inv = rotate4(inv, -dy, 1, 0, 0);
      inv = translate4(inv, 0, 0, -d);
      viewMatrix = invert4(inv)!;

      startX = e.clientX;
      startY = e.clientY;
    } else if (down === 2) {
      let inv = invert4(viewMatrix);
      if (!inv) return;
      
      inv = translate4(
        inv,
        (-10 * (e.clientX - startX)) / window.innerWidth,
        0,
        (10 * (e.clientY - startY)) / window.innerHeight,
      );
      viewMatrix = invert4(inv)!;

      startX = e.clientX;
      startY = e.clientY;
    }
  });

  canvas.addEventListener("mouseup", (e) => {
    e.preventDefault();
    down = 0;
    startX = 0;
    startY = 0;
  });

  // Touch events
  canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    if (e.touches.length === 1) {
      carousel = false;
      startX = e.touches[0]!.clientX;
      startY = e.touches[0]!.clientY;
      down = 1;
    } else if (e.touches.length === 2) {
      carousel = false;
      startX = e.touches[0]!.clientX;
      altX = e.touches[1]!.clientX;
      startY = e.touches[0]!.clientY;
      altY = e.touches[1]!.clientY;
      down = 1;
    }
  }, { passive: false });

  canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (e.touches.length === 1 && down) {
      let inv = invert4(viewMatrix);
      if (!inv) return;
      
      const dx = (4 * (e.touches[0]!.clientX - startX)) / window.innerWidth;
      const dy = (4 * (e.touches[0]!.clientY - startY)) / window.innerHeight;

      const d = 4;
      inv = translate4(inv, 0, 0, d);
      inv = rotate4(inv, dx, 0, 1, 0);
      inv = rotate4(inv, -dy, 1, 0, 0);
      inv = translate4(inv, 0, 0, -d);

      viewMatrix = invert4(inv)!;

      startX = e.touches[0]!.clientX;
      startY = e.touches[0]!.clientY;
    } else if (e.touches.length === 2) {
      const dtheta =
        Math.atan2(startY - altY, startX - altX) -
        Math.atan2(
          e.touches[0]!.clientY - e.touches[1]!.clientY,
          e.touches[0]!.clientX - e.touches[1]!.clientX,
        );
      const dscale =
        Math.hypot(startX - altX, startY - altY) /
        Math.hypot(
          e.touches[0]!.clientX - e.touches[1]!.clientX,
          e.touches[0]!.clientY - e.touches[1]!.clientY,
        );
      const dx =
        (e.touches[0]!.clientX + e.touches[1]!.clientX - (startX + altX)) / 2;
      const dy =
        (e.touches[0]!.clientY + e.touches[1]!.clientY - (startY + altY)) / 2;
      
      let inv = invert4(viewMatrix);
      if (!inv) return;
      
      inv = rotate4(inv, dtheta, 0, 0, 1);
      inv = translate4(inv, -dx / window.innerWidth, -dy / window.innerHeight, 0);
      inv = translate4(inv, 0, 0, 3 * (1 - dscale));

      viewMatrix = invert4(inv)!;

      startX = e.touches[0]!.clientX;
      altX = e.touches[1]!.clientX;
      startY = e.touches[0]!.clientY;
      altY = e.touches[1]!.clientY;
    }
  }, { passive: false });

  canvas.addEventListener("touchend", (e) => {
    e.preventDefault();
    down = 0;
    startX = 0;
    startY = 0;
  }, { passive: false });

  // Hash change for camera loading
  window.addEventListener("hashchange", () => {
    try {
      viewMatrix = JSON.parse(decodeURIComponent(location.hash.slice(1))) as Matrix4;
      carousel = false;
    } catch (err) {
      // Ignore invalid hash
    }
  });

  // Drag and drop events
  const preventDefault = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  
  document.addEventListener("dragenter", preventDefault);
  document.addEventListener("dragover", preventDefault);
  document.addEventListener("dragleave", preventDefault);
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = (e as DragEvent).dataTransfer?.files;
    if (files && files[0]) {
      selectFile(files[0]);
    }
  });

  // Gamepad events
  window.addEventListener("gamepadconnected", (e) => {
    const gamepadEvent = e as GamepadEvent;
    const gp = navigator.getGamepads()[gamepadEvent.gamepad.index];
    console.log(
      `Gamepad connected at index ${gp?.index}: ${gp?.id}. It has ${gp?.buttons.length} buttons and ${gp?.axes.length} axes.`,
    );
  });
  
  window.addEventListener("gamepaddisconnected", () => {
    console.log("Gamepad disconnected");
  });
}

function selectFile(file: File): void {
  const fr = new FileReader();
  if (/\.json$/i.test(file.name)) {
    fr.onload = () => {
      const result = fr.result as string;
      const loadedCameras = JSON.parse(result) as Camera[];
      // Update cameras array (you might want to handle this differently)
      cameras.splice(0, cameras.length, ...loadedCameras);
      viewMatrix = getViewMatrix(cameras[0]!);
      projectionMatrix = getProjectionMatrix(
        camera.fx / devicePixelRatio,
        camera.fy / devicePixelRatio,
        gl.canvas.width,
        gl.canvas.height,
      );
      gl.uniformMatrix4fv(u_projection, false, projectionMatrix);
      console.log("Loaded Cameras");
    };
    fr.readAsText(file);
  } else {
    fr.onload = () => {
      const buffer = fr.result as ArrayBuffer;
      const splatData = new Uint8Array(buffer);
      console.log("Loaded", Math.floor(splatData.length / 32));

      const isPly = (data: Uint8Array) =>
        data[0] === 112 && data[1] === 108 && data[2] === 121 && data[3] === 10;

      if (isPly(splatData)) {
        worker.postMessage({ ply: buffer, save: true } satisfies WorkerMessage);
      } else {
        worker.postMessage({
          buffer,
          vertexCount: Math.floor(splatData.length / 32),
        } satisfies WorkerMessage);
      }
    };
    fr.readAsArrayBuffer(file);
  }
}

function handleInput(): void {
  let inv = invert4(viewMatrix);
  if (!inv) return;
  
  const shiftKey =
    activeKeys.includes("Shift") ||
    activeKeys.includes("ShiftLeft") ||
    activeKeys.includes("ShiftRight");

  if (activeKeys.includes("ArrowUp")) {
    if (shiftKey) {
      inv = translate4(inv, 0, -0.03, 0);
    } else {
      inv = translate4(inv, 0, 0, 0.1);
    }
  }
  if (activeKeys.includes("ArrowDown")) {
    if (shiftKey) {
      inv = translate4(inv, 0, 0.03, 0);
    } else {
      inv = translate4(inv, 0, 0, -0.1);
    }
  }
  if (activeKeys.includes("ArrowLeft")) inv = translate4(inv, -0.03, 0, 0);
  if (activeKeys.includes("ArrowRight")) inv = translate4(inv, 0.03, 0, 0);
  if (activeKeys.includes("KeyA")) inv = rotate4(inv, -0.01, 0, 1, 0);
  if (activeKeys.includes("KeyD")) inv = rotate4(inv, 0.01, 0, 1, 0);
  if (activeKeys.includes("KeyQ")) inv = rotate4(inv, 0.01, 0, 0, 1);
  if (activeKeys.includes("KeyE")) inv = rotate4(inv, -0.01, 0, 0, 1);
  if (activeKeys.includes("KeyW")) inv = rotate4(inv, 0.005, 1, 0, 0);
  if (activeKeys.includes("KeyS")) inv = rotate4(inv, -0.005, 1, 0, 0);

  // Gamepad handling
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  let isJumping = activeKeys.includes("Space");
  
  for (const gamepad of gamepads) {
    if (!gamepad) continue;

    const axisThreshold = 0.1;
    const moveSpeed = 0.06;
    const rotateSpeed = 0.02;

    if (Math.abs(gamepad.axes[0]!) > axisThreshold) {
      inv = translate4(inv, moveSpeed * gamepad.axes[0]!, 0, 0);
      carousel = false;
    }
    if (Math.abs(gamepad.axes[1]!) > axisThreshold) {
      inv = translate4(inv, 0, 0, -moveSpeed * gamepad.axes[1]!);
      carousel = false;
    }
    if (gamepad.buttons[12]!.pressed || gamepad.buttons[13]!.pressed) {
      inv = translate4(
        inv,
        0,
        -moveSpeed *
          (Number(gamepad.buttons[12]!.pressed) - Number(gamepad.buttons[13]!.pressed)),
        0,
      );
      carousel = false;
    }

    if (gamepad.buttons[14]!.pressed || gamepad.buttons[15]!.pressed) {
      inv = translate4(
        inv,
        -moveSpeed *
          (Number(gamepad.buttons[14]!.pressed) - Number(gamepad.buttons[15]!.pressed)),
        0,
        0,
      );
      carousel = false;
    }

    if (Math.abs(gamepad.axes[2]!) > axisThreshold) {
      inv = rotate4(inv, rotateSpeed * gamepad.axes[2]!, 0, 1, 0);
      carousel = false;
    }
    if (Math.abs(gamepad.axes[3]!) > axisThreshold) {
      inv = rotate4(inv, -rotateSpeed * gamepad.axes[3]!, 1, 0, 0);
      carousel = false;
    }

    const tiltAxis = gamepad.buttons[6]!.value - gamepad.buttons[7]!.value;
    if (Math.abs(tiltAxis) > axisThreshold) {
      inv = rotate4(inv, rotateSpeed * tiltAxis, 0, 0, 1);
      carousel = false;
    }
    
    if (gamepad.buttons[4]!.pressed && !leftGamepadTrigger) {
      camera = cameras[(cameras.indexOf(camera) + 1) % cameras.length]!;
      inv = invert4(getViewMatrix(camera))!;
      carousel = false;
    }
    if (gamepad.buttons[5]!.pressed && !rightGamepadTrigger) {
      camera = cameras[(cameras.indexOf(camera) + cameras.length - 1) % cameras.length]!;
      inv = invert4(getViewMatrix(camera))!;
      carousel = false;
    }
    
    leftGamepadTrigger = gamepad.buttons[4]!.pressed;
    rightGamepadTrigger = gamepad.buttons[5]!.pressed;
    
    if (gamepad.buttons[0]!.pressed) {
      isJumping = true;
      carousel = false;
    }
    if (gamepad.buttons[3]!.pressed) {
      carousel = true;
    }
  }

  // IJKL orbital controls
  if (["KeyJ", "KeyK", "KeyL", "KeyI"].some((k) => activeKeys.includes(k))) {
    const d = 4;
    inv = translate4(inv, 0, 0, d);
    inv = rotate4(
      inv,
      activeKeys.includes("KeyJ") ? -0.05 : activeKeys.includes("KeyL") ? 0.05 : 0,
      0,
      1,
      0,
    );
    inv = rotate4(
      inv,
      activeKeys.includes("KeyI") ? 0.05 : activeKeys.includes("KeyK") ? -0.05 : 0,
      1,
      0,
      0,
    );
    inv = translate4(inv, 0, 0, -d);
  }

  viewMatrix = invert4(inv)!;

  // Handle jumping
  if (isJumping) {
    jumpDelta = Math.min(1, jumpDelta + 0.05);
  } else {
    jumpDelta = Math.max(0, jumpDelta - 0.05);
  }
}

function animate(now: number): void {
  handleInput();

  // Carousel mode
  if (carousel) {
    let inv = invert4(defaultViewMatrix);
    if (inv) {
      const t = Math.sin((Date.now() - start) / 5000);
      inv = translate4(inv, 2.5 * t, 0, 6 * (1 - Math.cos(t)));
      inv = rotate4(inv, -0.6 * t, 0, 1, 0);
      viewMatrix = invert4(inv)!;
    }
  }

  // Apply jumping effect
  let inv2 = invert4(viewMatrix);
  if (inv2) {
    inv2 = translate4(inv2, 0, -jumpDelta, 0);
    inv2 = rotate4(inv2, -0.1 * jumpDelta, 1, 0, 0);
    const actualViewMatrix = invert4(inv2)!;

    const viewProj = multiply4(projectionMatrix, actualViewMatrix);
    worker.postMessage({ view: viewProj } satisfies WorkerMessage);

    const currentFps = 1000 / (now - lastFrame) || 0;
    avgFps = avgFps * 0.9 + currentFps * 0.1;

    if (vertexCount > 0) {
      const spinnerElement = document.getElementById("spinner");
      if (spinnerElement) spinnerElement.style.display = "none";
      
      gl.uniformMatrix4fv(u_view, false, actualViewMatrix);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, vertexCount);
    } else {
      gl.clear(gl.COLOR_BUFFER_BIT);
      const spinnerElement = document.getElementById("spinner");
      if (spinnerElement) spinnerElement.style.display = "";
      start = Date.now() + 2000;
    }

    // Update progress bar
    const rowLength = 32; // bytes per vertex
    const progress = (100 * vertexCount) / (vertexCount * rowLength / rowLength); // This needs to be fixed with actual data size
    const progressElement = document.getElementById("progress") as HTMLElement;
    if (progressElement) {
      if (progress < 100) {
        progressElement.style.width = progress + "%";
      } else {
        progressElement.style.display = "none";
      }
    }

    const fpsElement = document.getElementById("fps");
    if (fpsElement) fpsElement.innerText = Math.round(avgFps) + " fps";
    
    const camidElement = document.getElementById("camid");
    if (camidElement && isNaN(currentCameraIndex)) {
      camidElement.innerText = "";
    }
  }

  lastFrame = now;
  requestAnimationFrame(animate);
}

async function loadSplatData(): Promise<void> {
  const params = new URLSearchParams(location.search);
  
  try {
    const hashData = decodeURIComponent(location.hash.slice(1));
    if (hashData) {
      viewMatrix = JSON.parse(hashData) as Matrix4;
      carousel = false;
    }
  } catch (err) {
    // Use default view matrix
  }

  const url = new URL(
    params.get("url") || "train.splat",
    "https://huggingface.co/cakewalk/splat-data/resolve/main/",
  );

  const req = await fetch(url, {
    mode: "cors",
    credentials: "omit",
  });

  console.log(req);
  if (req.status !== 200) {
    throw new Error(req.status + " Unable to load " + req.url);
  }

  const rowLength = 3 * 4 + 3 * 4 + 4 + 4;
  const reader = req.body!.getReader();
  const contentLength = parseInt(req.headers.get("content-length") || "0");
  let splatData = new Uint8Array(contentLength);

  let bytesRead = 0;
  let lastVertexCount = -1;
  let stopLoading = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done || stopLoading) break;

    splatData.set(value, bytesRead);
    bytesRead += value.length;

    if (vertexCount > lastVertexCount) {
      const isPly = (data: Uint8Array) =>
        data[0] === 112 && data[1] === 108 && data[2] === 121 && data[3] === 10;
        
      if (!isPly(splatData)) {
        worker.postMessage({
          buffer: splatData.buffer,
          vertexCount: Math.floor(bytesRead / rowLength),
        } satisfies WorkerMessage);
      }
      lastVertexCount = vertexCount;
    }
  }
  
  if (!stopLoading) {
    const isPly = (data: Uint8Array) =>
      data[0] === 112 && data[1] === 108 && data[2] === 121 && data[3] === 10;
      
    if (isPly(splatData)) {
      worker.postMessage({ ply: splatData.buffer, save: false } satisfies WorkerMessage);
    } else {
      worker.postMessage({
        buffer: splatData.buffer,
        vertexCount: Math.floor(bytesRead / rowLength),
      } satisfies WorkerMessage);
    }
  }
}

async function main(): Promise<void> {
  try {
    await initializeWorker();
    initializeWebGL();
    setupEventListeners();
    resize();
    await loadSplatData();
    requestAnimationFrame(animate);
  } catch (err) {
    const spinnerElement = document.getElementById("spinner");
    if (spinnerElement) spinnerElement.style.display = "none";
    
    const messageElement = document.getElementById("message");
    if (messageElement) messageElement.innerText = (err as Error).toString();
    
    console.error(err);
  }
}

main();
