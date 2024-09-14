import DefaultVideo from "./weather.mp4";

import { useEffect, useRef } from "react";

// https://jameshfisher.com/2020/08/11/production-ready-green-screen-in-the-browser/

const fragmentShaderRaw = `
precision mediump float;

uniform sampler2D tex;
uniform float texWidth;
uniform float texHeight;

uniform vec3 keyColor;
uniform float similarity;
uniform float smoothness;
uniform float spill;

// From https://github.com/libretro/glsl-shaders/blob/master/nnedi3/shaders/rgb-to-yuv.glsl
vec2 RGBtoUV(vec3 rgb) {
  return vec2(
    rgb.r * -0.169 + rgb.g * -0.331 + rgb.b *  0.5    + 0.5,
    rgb.r *  0.5   + rgb.g * -0.419 + rgb.b * -0.081  + 0.5
  );
}

vec4 ProcessChromaKey(vec2 texCoord) {
  vec4 rgba = texture2D(tex, texCoord);
  float chromaDist = distance(RGBtoUV(texture2D(tex, texCoord).rgb), RGBtoUV(keyColor));

  float baseMask = chromaDist - similarity;
  float fullMask = pow(clamp(baseMask / smoothness, 0., 1.), 1.5);
  rgba.a = fullMask;

  float spillVal = pow(clamp(baseMask / spill, 0., 1.), 1.5);
  float desat = clamp(rgba.r * 0.2126 + rgba.g * 0.7152 + rgba.b * 0.0722, 0., 1.);
  rgba.rgb = mix(vec3(desat, desat, desat), rgba.rgb, spillVal);

  return rgba;
}

void main(void) {
  vec2 texCoord = vec2(gl_FragCoord.x/texWidth, 1.0 - (gl_FragCoord.y/texHeight));
  gl_FragColor = ProcessChromaKey(texCoord);
}
`;

function init(gl: WebGLRenderingContext) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  if (!vs) throw new Error("Could not create VERTEX_SHADER");
  gl.shaderSource(
    vs,
    "attribute vec2 c; void main(void) { gl_Position=vec4(c, 0.0, 1.0); }"
  );
  gl.compileShader(vs);

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  if (!fs) throw new Error("Could not create FRAGMENT_SHADER");
  gl.shaderSource(fs, fragmentShaderRaw);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(fs));
  }

  const prog = gl.createProgram();
  if (!prog) throw new Error("Could not create WebGL Program");

  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, 1, -1, -1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
  );

  const coordLoc = gl.getAttribLocation(prog, "c");
  gl.vertexAttribPointer(coordLoc, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(coordLoc);

  gl.activeTexture(gl.TEXTURE0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  return prog;
}

function hexColorToRGBPct(sharpLeadingHex: string) {
  const noSharp = sharpLeadingHex.match(/^#([0-9a-f]{6})$/i)?.[1];
  return [
    parseInt(noSharp ? noSharp.substring(0, 2) : "0", 16) / 255,
    parseInt(noSharp ? noSharp.substring(2, 4) : "0", 16) / 255,
    parseInt(noSharp ? noSharp.substring(4, 6) : "0", 16) / 255,
  ] as const;
}

type WGL = {
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  stopped: boolean;
  useRequestVideoFrameCallback: boolean;
  requestVideoFrameCallbackIsAvailable: boolean;
  start: () => void;
  stop: () => void;
};

type LiveTweakableParams = {
  keycolor: readonly [number, number, number];
  similarity: number;
  smoothness: number;
  spill: number;
};

function startProcessing(
  sourceVideoEl: HTMLVideoElement,
  displayCanvasEl: HTMLCanvasElement,
  wgl: WGL,
  getConfig: () => LiveTweakableParams
) {
  const { gl, prog } = wgl;

  const texLoc = gl.getUniformLocation(prog, "tex");
  const texWidthLoc = gl.getUniformLocation(prog, "texWidth");
  const texHeightLoc = gl.getUniformLocation(prog, "texHeight");
  const keyColorLoc = gl.getUniformLocation(prog, "keyColor");
  const similarityLoc = gl.getUniformLocation(prog, "similarity");
  const smoothnessLoc = gl.getUniformLocation(prog, "smoothness");
  const spillLoc = gl.getUniformLocation(prog, "spill");

  function processFrame() {
    if (wgl.stopped) return;
    if (sourceVideoEl.videoWidth !== displayCanvasEl.width) {
      displayCanvasEl.width = sourceVideoEl.videoWidth;
      displayCanvasEl.height = sourceVideoEl.videoHeight;
      gl.viewport(0, 0, sourceVideoEl.videoWidth, sourceVideoEl.videoHeight);
    }

    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGB,
      gl.RGB,
      gl.UNSIGNED_BYTE,
      sourceVideoEl
    );
    gl.uniform1i(texLoc, 0);
    gl.uniform1f(texWidthLoc, sourceVideoEl.videoWidth);
    gl.uniform1f(texHeightLoc, sourceVideoEl.videoHeight);

    const config = getConfig();
    gl.uniform3f(
      keyColorLoc,
      config.keycolor[0],
      config.keycolor[1],
      config.keycolor[2]
    );
    gl.uniform1f(similarityLoc, config.similarity);
    gl.uniform1f(smoothnessLoc, config.smoothness);
    gl.uniform1f(spillLoc, config.spill);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

    if (wgl.stopped) return;
    if (
      wgl.useRequestVideoFrameCallback &&
      wgl.requestVideoFrameCallbackIsAvailable
    ) {
      (sourceVideoEl as any).requestVideoFrameCallback(processFrame);
    } else {
      setTimeout(() => {
        requestAnimationFrame(processFrame);
      }, 1000 / 24);
    }
  }

  processFrame();
}

export function ProdReadyChromaDemo() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wglRef = useRef<WGL | null>(null);

  useEffect(() => {
    console.log("cvs", canvasRef, "vid", videoRef);
    if (!canvasRef.current || !videoRef.current) return;

    const gl = canvasRef.current.getContext("webgl", {
      premultipliedAlpha: false,
    });

    if (!gl) throw new Error("Could not initialize webgl");

    const prog = init(gl);
    const wgl: WGL = {
      gl,
      prog,
      stopped: true,
      useRequestVideoFrameCallback: true,
      requestVideoFrameCallbackIsAvailable:
        "requestVideoFrameCallback" in videoRef.current,
      start: () => {
        if (!canvasRef.current || !videoRef.current) return;
        console.log("starting");
        wgl.stopped = false;

        const getConfig = () => {
          const defaultValues = {
            keycolor: "#11ff05",
            similarity: 0.4,
            smoothness: 0.08,
            spill: 0.1,
          };
          return {
            ...defaultValues,
            keycolor: hexColorToRGBPct(defaultValues.keycolor),
          };
        };

        startProcessing(videoRef.current, canvasRef.current, wgl, getConfig);
      },
      stop: () => {
        console.log("stopping");
        wgl.stopped = true;
      },
    };

    wglRef.current = wgl;

    wgl.start();

    return () => {
      wgl.stop();
      wgl.gl.deleteProgram(wgl.prog);
    };
  }, []);

  const sizeStyle = {
    width: "50%",
  };

  // TODO: test if a smaller video dimension uses less CPU/GPU?

  return (
    <div
      style={{
        backgroundPosition: "right",
        backgroundSize: "contain",
        backgroundRepeat: "no-repeat",
        backgroundImage: `url(https://i.imgur.com/VWEpMQ1.jpeg)`,
      }}
    >
      <video
        ref={videoRef}
        crossOrigin="anonymous"
        controls
        loop
        src={DefaultVideo}
        style={{ ...sizeStyle, display: "inline" }}
        // src={RemoteLPGameVideo001}
      />
      <canvas ref={canvasRef} style={sizeStyle} />
    </div>
  );
}
